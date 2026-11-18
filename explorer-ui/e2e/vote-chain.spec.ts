import type { Page } from '@playwright/test'
import { DedotClient, WsProvider } from 'dedot'
import { decodeAddress, u8aToHex } from 'dedot/utils'
import { expect, test } from './fixtures/test'

// The voting flows against the real chain, opt-in (VOTE_CHAIN_E2E=1): it needs our
// RPC and the live explorer api, and it names real accounts that hold HDX and the
// proxies between them. Each flow runs the real composer — fee quote and dry-run on
// chain — up to the wallet, whose stub records the request and REJECTS it, so nothing
// is ever signed; a socket guard also refuses any submission. The recorded call is
// then decoded and dry-run (DryRunApi) as its signer, and must succeed with the
// events the flow promises. Referendum numbers and accounts move with the chain:
// update them when these referenda close.

const RUN = process.env.VOTE_CHAIN_E2E === '1'
const LIVE_API = process.env.VOTE_CHAIN_API ?? 'https://hydration-explorer.neckwork.net/api'
const RPC = 'wss://hydration-rpc.neckwork.net'
const REF = Number(process.env.VOTE_CHAIN_REF ?? 450)
const REF2 = Number(process.env.VOTE_CHAIN_REF2 ?? 448)
const DIRECT = '15U8rqSKTZuNz1doFgiaiCzeRTbEpxmHGAPQi1nRc6oamXQV'        // holds ~1k HDX, has not voted
const DELEGATE = '16PFL7Hdo3NYtKqe8QLhaPbVrEENieaBy4qJHZfcMBcDAuJL'      // Governance proxy of DIRECT
const REVOTER = '14uNE9ySATs4YmdgfRpKhBiFPmMgKCnfc7C5nR1YanPcdoyY'       // votes on REF; 55 finished votes; GIGAHDX
const EVM_PERMIT = '0xfe5563cd4a9528a472584ef49ed66faf4d484856'           // fee currency HDX → permit

test.skip(!RUN, 'chain-backed; set VOTE_CHAIN_E2E=1')
test.describe.configure({ mode: 'serial', timeout: 120_000 })
// Reads proxied to the live api may still be in flight when a flow ends.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

interface Recorded { kind: string; payload?: { address: string; method: string }; params?: unknown[] }

async function setup(page: Page, cfg: { substrate?: string; evm?: string }) {
  // The live api, not the fixtures: proxy every /api read to it.
  await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
    const u = new URL(route.request().url())
    // The live-feed stream never ends; the flows do not need it.
    if (u.pathname.endsWith('/explorer/live')) return route.abort()
    const res = await route.fetch({ url: `${LIVE_API}${u.pathname.replace(/^\/api/, '')}${u.search}` })
    await route.fulfill({ response: res })
  })
  const blocked: string[] = []
  await page.routeWebSocket(/hydration-rpc\.neckwork\.net/, ws => {
    const server = ws.connectToServer()
    ws.onMessage(m => {
      const s = String(m)
      if (/author_submit|transaction_v1_broadcast|transactionWatch_v1_submitAndWatch/.test(s)) { blocked.push(s); return }
      server.send(m)
    })
    server.onMessage(m => ws.send(m))
  })
  await page.addInitScript(([substrate, evm]) => {
    const w = window as unknown as { __signRequests: unknown[]; injectedWeb3: unknown }
    w.__signRequests = []
    if (substrate) {
      w.injectedWeb3 = { talisman: { enable: async () => ({
        accounts: { get: async () => [{ address: substrate, name: 'Test', type: 'sr25519' }] },
        signer: { signPayload: async (payload: unknown) => { w.__signRequests.push({ kind: 'signPayload', payload }); throw new Error('Cancelled') } },
      }) } }
    }
    if (evm) {
      const provider = { async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [evm]
        // Starts on Ethereum mainnet: the permit must switch it to Hydration first.
        if (method === 'eth_chainId') return '0x1'
        if (method.startsWith('wallet_')) { w.__signRequests.push({ kind: method, params }); return null }
        if (method === 'eth_signTypedData_v4' || method === 'eth_sendTransaction') { w.__signRequests.push({ kind: method, params }); throw Object.assign(new Error('User rejected the request.'), { code: 4001 }) }
        throw new Error(`unsupported ${method}`)
      } }
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { rdns: 'net.neckwork.test-evm', name: 'Test EVM Wallet', icon: '' }, provider } }))
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
    }
  }, [cfg.substrate ?? '', cfg.evm ?? ''] as [string, string])
  return blocked
}

async function openComposer(page: Page, index: number, tile: string) {
  await page.goto(`/referendum/opengov/${index}`)
  await page.locator('.gov-vote-btn:visible').first().click()
  // A wallet connected earlier in the test is remembered and comes back by itself.
  const connect = page.getByRole('button', { name: 'Connect a wallet' })
  const dirs = page.locator('.vote-composer .vote-dirs')
  await expect(connect.or(dirs).first()).toBeVisible({ timeout: 20_000 })
  if (await connect.isVisible()) {
    await connect.click()
    await page.locator('.wallet-tile', { hasText: tile }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
  }
}

async function signAndRecord(page: Page): Promise<Recorded> {
  const sign = page.locator('.vote-sign')
  await expect(sign).toBeEnabled({ timeout: 60_000 })
  await expect(page.locator('.vote-review-ok')).toContainText('Checked on chain')
  await sign.click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __signRequests: unknown[] }).__signRequests.length), { timeout: 30_000 }).toBeGreaterThan(0)
  await expect(page.locator('.vote-stage.failed')).toContainText(/declined|cancelled/)
  return (await page.evaluate(() => (window as unknown as { __signRequests: Recorded[] }).__signRequests)).at(-1)!
}

async function dryRun(origin: string, callHex: string) {
  const c = await DedotClient.new(new WsProvider(RPC))
  try {
    const id = origin.startsWith('0x') && origin.length === 66 ? origin : u8aToHex(decodeAddress(origin))
    const call = c.registry.findCodec(c.metadata.latest.extrinsic.callTypeId).tryDecode(callHex)
    const r = await c.call.dryRunApi.dryRunCall({ type: 'System', value: { type: 'Signed', value: id } } as never, call as never, 5) as unknown as {
      value: { executionResult: { isOk: boolean }; emittedEvents: { pallet: string; palletEvent: { name: string; data?: { result?: { isOk: boolean } } } }[] }
    }
    const events = r.value.emittedEvents.map(e => `${e.pallet}.${e.palletEvent.name}`)
    const proxyOk = r.value.emittedEvents.find(e => e.pallet === 'Proxy')?.palletEvent.data?.result?.isOk ?? null
    return { ok: r.value.executionResult.isOk, events, proxyOk, call: JSON.stringify(call, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) }
  } finally { await c.disconnect() }
}

test('a direct vote with "Almost full" signs exactly one ConvictionVoting.vote that dry-runs', async ({ page }) => {
  const blocked = await setup(page, { substrate: DIRECT })
  await openComposer(page, REF, 'Talisman')
  await page.getByRole('radio', { name: /Aye/ }).click()
  await page.locator('.vote-more > summary').click()
  await page.getByRole('button', { name: /^All but/ }).click()
  const rec = await signAndRecord(page)
  const r = await dryRun(rec.payload!.address, rec.payload!.method)
  expect(r.call).toContain('"name":"Vote"')
  expect(r.call).toContain(`"pollIndex":${REF}`)
  expect(r.ok).toBe(true)
  expect(r.events).toContain('ConvictionVoting.Voted')
  expect(blocked).toEqual([])
})

test('a proxy vote wraps the vote in proxy.proxy(real, Governance) and the inner call succeeds', async ({ page }) => {
  await setup(page, { substrate: DELEGATE })
  await openComposer(page, REF, 'Talisman')
  await page.locator('.voter-current').click()
  await page.locator('.voter-option', { hasText: '15U8' }).first().click()
  await page.getByRole('radio', { name: /Abstain/ }).click()
  await page.locator('#vote-amount').fill('100')
  const rec = await signAndRecord(page)
  const r = await dryRun(rec.payload!.address, rec.payload!.method)
  expect(r.call).toContain('"name":"Proxy"')
  expect(r.call).toContain('"forceProxyType":"Governance"')
  expect(r.call).toContain('SplitAbstain')
  expect(r.proxyOk).toBe(true)
  expect(r.events).toContain('ConvictionVoting.Voted')
})

test('the cart signs several votes in one utility.batchAll, through the proxy', async ({ page }) => {
  await setup(page, { substrate: DELEGATE })
  await openComposer(page, REF, 'Talisman')
  await page.getByRole('radio', { name: /Nay/ }).click()
  await page.getByRole('button', { name: 'Add to cart' }).click()
  await page.keyboard.press('Escape')
  await openComposer(page, REF2, 'Talisman')
  await page.getByRole('radio', { name: /Aye/ }).click()
  await page.getByRole('button', { name: 'Add to cart' }).click()
  await page.getByRole('button', { name: 'Open cart' }).click()
  await page.locator('.voter-current').click()
  await page.locator('.voter-option', { hasText: '15U8' }).first().click()
  await page.getByRole('radio', { name: 'Other' }).click()
  await page.getByLabel('Amount in HDX').fill('250')
  const rec = await signAndRecord(page)
  const r = await dryRun(rec.payload!.address, rec.payload!.method)
  expect(r.call).toContain('"name":"BatchAll"')
  expect(r.proxyOk).toBe(true)
  expect(r.events.filter(e => e === 'ConvictionVoting.Voted')).toHaveLength(2)
})

test('"Same as now" re-votes with the standing amount and conviction', async ({ page }) => {
  await setup(page, { substrate: REVOTER })
  await openComposer(page, REF, 'Talisman')
  await expect(page.locator('.voter-current')).toContainText('voted')
  await page.getByRole('radio', { name: 'Same as now' }).click()
  const rec = await signAndRecord(page)
  const r = await dryRun(rec.payload!.address, rec.payload!.method)
  expect(r.ok).toBe(true)
  expect(r.events).toContain('ConvictionVoting.Voted')
})

test('an EVM wallet signs a CallPermit to the dispatch precompile carrying the vote', async ({ page }) => {
  await setup(page, { evm: EVM_PERMIT })
  await openComposer(page, REF, 'Test EVM Wallet')
  await page.getByRole('radio', { name: /Aye/ }).click()
  await page.locator('#vote-amount').fill('10')
  const rec = await signAndRecord(page)
  expect(rec.kind).toBe('eth_signTypedData_v4')
  const kinds = (await page.evaluate(() => (window as unknown as { __signRequests: { kind: string }[] }).__signRequests)).map(r => r.kind)
  expect(kinds.indexOf('wallet_switchEthereumChain')).toBeGreaterThanOrEqual(0)
  expect(kinds.indexOf('wallet_switchEthereumChain')).toBeLessThan(kinds.indexOf('eth_signTypedData_v4'))
  const typed = JSON.parse(rec.params![1] as string)
  expect(typed.domain).toEqual({ name: 'Call Permit Precompile', version: '1', chainId: 222222, verifyingContract: '0x000000000000000000000000000000000000080a' })
  expect(typed.message.to).toBe('0x0000000000000000000000000000000000000401')
  const mapped = `0x45544800${EVM_PERMIT.slice(2)}0000000000000000`
  const r = await dryRun(mapped, typed.message.data)
  expect(r.ok).toBe(true)
  expect(r.events).toContain('ConvictionVoting.Voted')
})

test('Unlock & clean up removes the expired finished votes by default, and merges still-locked ones only when asked', async ({ page }) => {
  await setup(page, { substrate: REVOTER })
  await page.goto(`/account/${REVOTER}?view=governance`)
  await page.locator('.gov-lock-actions .gov-btn').first().click({ timeout: 60_000 })
  const connect = page.getByRole('button', { name: 'Connect a wallet' })
  await connect.click()
  await page.locator('.wallet-tile', { hasText: 'Talisman' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('.unlock-summary')).toBeVisible({ timeout: 60_000 })
  const rec = await signAndRecord(page)
  const r = await dryRun(rec.payload!.address, rec.payload!.method)
  expect(r.ok).toBe(true)
  expect(r.call).toContain('"name":"Unlock"')
  expect(r.events).toContain('ConvictionVoting.VoteUnlocked')
  // Opting in to the still-locked ones shows the merged lock before anything is signed.
  const more = page.locator('.unlock-more > summary')
  if (await more.count()) {
    await more.click()
    await page.locator('.unlock-more input[type=checkbox]').first().check()
    await expect(page.locator('.vote-warn', { hasText: 'Removing the ticked ones leaves' })).toBeVisible()
  }
})

test('a Governance proxy cleans up without the GIGAHDX claim it is not allowed to make', async ({ page }) => {
  const GOV_DELEGATE = '13dxxbqUHL7YJPyFnyo9pPuACoiZZtifHMUr1sSZ6RkXcbRU'   // Governance proxy of GIGA_REAL
  const GIGA_REAL = '152sgKxozAY9zVv3mzKEHFXBaW5G4zt6hxAy6jwKG2D6JZXZ'      // GIGAHDX staker with finished votes
  await setup(page, { substrate: GOV_DELEGATE })
  await page.goto(`/account/${GIGA_REAL}?view=governance`)
  await page.locator('.gov-lock-actions .gov-btn').first().click({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Connect a wallet' }).click()
  await page.locator('.wallet-tile', { hasText: 'Talisman' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('.unlock-summary')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.vote-composer')).toContainText('A Governance proxy cannot claim')
  await expect(page.locator('.unlock-claim')).toHaveCount(0)
  const rec = await signAndRecord(page)
  const r = await dryRun(rec.payload!.address, rec.payload!.method)
  expect(r.call).toContain('"forceProxyType":"Governance"')
  expect(r.call).not.toContain('claim_rewards')
  expect(r.proxyOk).toBe(true)
})

test('editing the "Almost full" reserve keeps the field and recomputes the amount', async ({ page }) => {
  await setup(page, { substrate: DIRECT })
  await openComposer(page, REF, 'Talisman')
  await page.getByRole('radio', { name: /Aye/ }).click()
  await page.locator('.vote-more > summary').click()
  await page.getByRole('button', { name: /^All but/ }).click()
  const before = await page.locator('#vote-amount').inputValue()
  const reserve = page.locator('#vote-reserve')
  await reserve.fill('')
  await reserve.pressSequentially('25.5')
  await expect(reserve).toHaveValue('25.5')
  await expect(page.locator('#vote-amount')).not.toHaveValue(before)
  // The amount drops by the new reserve less the suggested one (a few HDX).
  const diff = Number(before) - Number(await page.locator('#vote-amount').inputValue())
  expect(diff).toBeGreaterThan(18)
  expect(diff).toBeLessThan(25.5)
})
