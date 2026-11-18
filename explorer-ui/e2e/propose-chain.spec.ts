import type { Page } from '@playwright/test'
import { DedotClient, WsProvider } from 'dedot'
import { decodeAddress, u8aToHex } from 'dedot/utils'
import { expect, test } from './fixtures/test'

// The proposal wizard against the real chain, opt-in (VOTE_CHAIN_E2E=1): the live api
// for reads, our RPC for the call, its preimage and the dry-run. Each flow builds a
// call, walks to Sign, and the wallet stub records the request and REJECTS it — a
// socket guard also refuses any submission — so nothing is ever submitted. The
// recorded extrinsic is then dry-run as its signer and must store the preimage (when
// new), submit the referendum on the expected track and, when chosen, place its
// decision deposit. PROPOSER must hold enough free HDX for the deposits; the
// referendum number moves with the chain.

const RUN = process.env.VOTE_CHAIN_E2E === '1'
const LIVE_API = process.env.VOTE_CHAIN_API ?? 'https://hydration-explorer.neckwork.net/api'
const RPC = 'wss://hydration-rpc.neckwork.net'
const PROPOSER = process.env.PROPOSE_CHAIN_PROPOSER ?? '1nPfZkk7aTf1frJ91hvZSRBvCwUn8Naq4fu9qg9B8pZGxVF' // ~1M free HDX, pays fees in HDX
const BENEFICIARY = '15U8rqSKTZuNz1doFgiaiCzeRTbEpxmHGAPQi1nRc6oamXQV'
const STORED = '0x83e892ce7481986830f8b0ead67944e7fe0de6854a8aa9fa61be233a1ba20cb0' // a preimage the chain stores (1,159 bytes)

test.skip(!RUN, 'chain-backed; set VOTE_CHAIN_E2E=1')
test.describe.configure({ mode: 'serial', timeout: 180_000 })
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

async function setup(page: Page) {
  await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
    const u = new URL(route.request().url())
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
  await page.addInitScript(addr => {
    const w = window as unknown as { __signRequests: unknown[]; injectedWeb3: unknown }
    w.__signRequests = []
    w.injectedWeb3 = { talisman: { enable: async () => ({
      accounts: { get: async () => [{ address: addr, name: 'Proposer', type: 'sr25519' }] },
      signer: { signPayload: async (payload: unknown) => { w.__signRequests.push(payload); throw new Error('Cancelled') } },
    }) } }
  }, PROPOSER)
  return blocked
}

async function walk(page: Page, fill: () => Promise<void>, opts: { hold?: boolean } = {}): Promise<{ address: string; method: string }> {
  await page.goto('/governance/propose')
  await page.getByLabel('Title').fill('Chain-backed test (never submitted)')
  await page.locator('.pp-step-body textarea').first().fill('Nothing is submitted.')
  await page.getByRole('button', { name: 'Next: the call' }).click()
  await fill()
  await expect(page.locator('.pp-preview')).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Next: the preimage' }).click()
  await page.getByRole('button', { name: 'Next: the track' }).click()
  await page.getByRole('button', { name: 'Next: review and submit' }).click()
  await page.getByRole('button', { name: 'Connect a wallet' }).click()
  await page.locator('.wallet-tile', { hasText: 'Talisman' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  const sign = page.locator('.vote-sign')
  await expect(sign).toBeEnabled({ timeout: 90_000 })
  await expect(page.locator('.vote-review-ok').last()).toContainText('Checked on chain')
  if (opts.hold) {
    // The governance clock refetches every minute and the head moves on: the call, its
    // preimage hash and the mounted signer must all stay exactly as they were.
    const before = await page.locator('.vote-callhex').first().getAttribute('data-callhex')
    await page.evaluate(() => { (document.querySelector('.pp-sign') as HTMLElement).dataset.mark = 'kept' })
    await page.waitForTimeout(70_000)
    expect(await page.evaluate(() => (document.querySelector('.pp-sign') as HTMLElement | null)?.dataset.mark)).toBe('kept')
    expect(await page.locator('.vote-callhex').first().getAttribute('data-callhex')).toBe(before)
    await expect(page.locator('.pp-steps [aria-current="step"]')).toContainText('Submit')
  }
  await sign.click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __signRequests: unknown[] }).__signRequests.length), { timeout: 30_000 }).toBeGreaterThan(0)
  await expect(page.locator('.vote-stage.failed')).toContainText(/declined|cancelled/)
  return (await page.evaluate(() => (window as unknown as { __signRequests: { address: string; method: string }[] }).__signRequests)).at(-1)!
}

async function dryRun(origin: string, callHex: string) {
  const c = await DedotClient.new(new WsProvider(RPC))
  try {
    const call = c.registry.findCodec(c.metadata.latest.extrinsic.callTypeId).tryDecode(callHex)
    const r = await c.call.dryRunApi.dryRunCall({ type: 'System', value: { type: 'Signed', value: u8aToHex(decodeAddress(origin)) } } as never, call as never, 5) as unknown as {
      value: { executionResult: { isOk: boolean }; emittedEvents: { pallet: string; palletEvent: { name: string; data?: { track?: number } } }[] }
    }
    const submitted = r.value.emittedEvents.find(e => e.pallet === 'Referenda' && e.palletEvent.name === 'Submitted')
    return { ok: r.value.executionResult.isOk, events: r.value.emittedEvents.map(e => `${e.pallet}.${e.palletEvent.name}`), track: submitted?.palletEvent.data?.track ?? null }
  } finally { await c.disconnect() }
}

test('a 1,000 HDX spend stores its preimage and submits on the Tipper track, in one batch that dry-runs', async ({ page }) => {
  const blocked = await setup(page)
  const rec = await walk(page, async () => {
    await page.getByLabel('Amount').fill('1000')
    await page.getByLabel('Beneficiary').fill(BENEFICIARY)
  })
  const r = await dryRun(rec.address, rec.method)
  expect(r.ok).toBe(true)
  expect(r.events).toEqual(expect.arrayContaining(['Preimage.Noted', 'Referenda.Submitted', 'Utility.BatchCompleted']))
  // The decision deposit is never batched: it is a second signature on the known number.
  expect(r.events).not.toContain('Referenda.DecisionDepositPlaced')
  expect(r.track).toBe(7)
  expect(blocked).toEqual([])
})

test('a spend claimable in 30 days keeps its call and its signer while the head moves on', async ({ page }) => {
  test.setTimeout(240_000)
  const blocked = await setup(page)
  const rec = await walk(page, async () => {
    await page.getByLabel('Amount').fill('2000000')
    await page.getByLabel('Beneficiary').fill(BENEFICIARY)
    await page.getByRole('radio', { name: 'Days from now' }).click()
  }, { hold: true })
  const r = await dryRun(rec.address, rec.method)
  expect(r.ok).toBe(true)
  expect(r.track).toBe(6)
  expect(blocked).toEqual([])
})

test('a track whose origin cannot make the call is refused before the vote', async ({ page }) => {
  await setup(page)
  await page.goto('/governance/propose')
  await page.getByLabel('Title').fill('Chain-backed test (never submitted)')
  await page.locator('.pp-step-body textarea').first().fill('Nothing is submitted.')
  await page.getByRole('button', { name: 'Next: the call' }).click()
  await page.getByLabel('Amount').fill('50001')
  await page.getByLabel('Beneficiary').fill(BENEFICIARY)
  await expect(page.locator('.pp-preview')).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Next: the preimage' }).click()
  await page.getByRole('button', { name: 'Next: the track' }).click()
  // 50,001 HDX is over the Tipper origin's limit: the dry-run as that origin says so.
  await expect(page.locator('.pp-track', { hasText: 'Tipper' })).toBeDisabled({ timeout: 60_000 })
  await expect(page.locator('.pp-track', { hasText: 'Tipper' })).toContainText('Treasury.InsufficientPermission')
  await expect(page.locator('.pp-track.on')).toContainText('Spender')
  await expect(page.locator('.pp-step-body .vote-review-ok')).toContainText('the Spender track may make this call')
})

test('a stored preimage is submitted alone, with no note and no preimage deposit', async ({ page }) => {
  const blocked = await setup(page)
  const rec = await walk(page, async () => {
    await page.getByRole('radio', { name: 'Stored preimage' }).click()
    await page.getByLabel('Preimage hash').fill(STORED)
  })
  const r = await dryRun(rec.address, rec.method)
  expect(r.ok).toBe(true)
  expect(r.events).toContain('Referenda.Submitted')
  expect(r.events).not.toContain('Preimage.Noted')
  expect(blocked).toEqual([])
})
