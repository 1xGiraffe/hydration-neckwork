import type { Page } from '@playwright/test'
import { expect, test, E2E_ADDRESS, E2E_EVM_ADDRESS, E2E_EVM_TX_HASH } from './fixtures/test'
import { VERIFIED_CONTRACT_ADDRESS } from '../tests/fixtures/mockApi'

// The contract tab's Write sub-tab over the EVM-wallet path: a wallet
// connection of its own (never the login session), continuous estimates gating
// the Write button, and the CallPermit an EVM wallet signs instead of sending a
// transaction. The wallet is the `evmWallet` EIP-6963 fixture; the HTTP RPC
// (estimate, permit nonce, block timestamp) is mocked at the network layer so
// the real codec encodes every byte.
//
// Where these specs stop: dispatching the signed permit is a Substrate
// extrinsic over WSS, and mocking a node well enough to accept one is not worth
// a megabyte metadata fixture (the same line the substrate spec draws). So the
// socket is closed deliberately and the assertions cover everything up to and
// including the signed payload, plus the failure the closed socket produces.

const WORD = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
// Error(string) "not allowed": selector + offset + length + left-aligned bytes.
const NOT_ALLOWED_REVERT = '0x08c379a0' + WORD('20') + WORD('b') + '6e6f7420616c6c6f776564'.padEnd(64, '0')

// The first 20 bytes of E2E_ADDRESS's AccountId32 — what EnsureAddressTruncated
// maps a substrate signer to (pinned by tests/substrate-write.test.ts).
const E2E_DERIVED_SOURCE = '0xba896f978f18d179207937a73758022ff6b405bc'

// The permit nonce the CallPermit precompile reports, and the chain clock the
// deadline is built from — both fixed so the signed payload is exact.
const PERMIT_NONCE = 7
const BLOCK_TIMESTAMP = 1_780_000_000

async function mockEvmRpc(page: Page, estimateCalls?: { from?: string; data?: string }[]) {
  let receiptPolls = 0
  // No WSS in a browser test: closing it keeps the fee-asset lookup and the
  // permit dispatch off the real chain, so nothing here depends on the network.
  await page.routeWebSocket('wss://hydration-rpc.neckwork.net/**', ws => ws.close())
  await page.route('https://hydration-rpc.neckwork.net/**', async route => {
    const body = route.request().postDataJSON() as { method: string; params?: [{ data?: string; from?: string; to?: string }, ...unknown[]] }
    const respond = (result: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) })
    if (body.method === 'eth_getCode') return respond('0x6080604052' + 'ab'.repeat(64))
    if (body.method === 'eth_getBlockByNumber') return respond({ timestamp: `0x${BLOCK_TIMESTAMP.toString(16)}` })
    // nonces(address) on the CallPermit precompile — the permit nonce, which is
    // not the account nonce.
    if (body.method === 'eth_call' && body.params?.[0]?.data?.startsWith('0x7ecebe00')) {
      return respond(`0x${PERMIT_NONCE.toString(16).padStart(64, '0')}`)
    }
    if (body.method === 'eth_estimateGas') {
      estimateCalls?.push({ from: body.params?.[0]?.from, data: body.params?.[0]?.data })
      const selector = body.params?.[0]?.data?.slice(0, 10)
      if (selector === '0xa9059cbb') return respond('0x8fd0')          // transfer(address,uint256)
      // deposit() reverts for this caller — the disabled-Write path.
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: NOT_ALLOWED_REVERT } }) })
    }
    if (body.method === 'eth_gasPrice') return respond('0x3b9aca00')
    if (body.method === 'eth_getTransactionReceipt') {
      if (++receiptPolls < 2) return respond(null)
      return respond({ status: '0x1', blockNumber: '0x4cb2f', transactionHash: E2E_EVM_TX_HASH })
    }
    return respond(null)
  })
}

async function connectTestWallet(page: Page) {
  await page.locator('.write-bar button', { hasText: 'Connect wallet' }).click()
  await page.locator('.wallet-tile', { hasText: 'Test Wallet' }).click()
  await expect(page.locator('.write-bar')).toContainText('You are writing to')
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('connects its own wallet and signs the exact CallPermit instead of sending a transaction', async ({ page, evmWallet }) => {
    void evmWallet
    await mockEvmRpc(page)
    await page.goto(`/account/${VERIFIED_CONTRACT_ADDRESS}?view=contract&contract=write`)

    // Only state-changing functions are listed.
    await expect(page.locator('.fn-head', { hasText: 'transfer(address, uint256)' })).toBeVisible()
    await expect(page.locator('.fn-head', { hasText: 'deposit()' })).toBeVisible()
    await expect(page.getByText('balanceOf')).toHaveCount(0)

    await connectTestWallet(page)
    await expect(page.locator('.write-bar button', { hasText: 'Disconnect' })).toBeVisible()

    // The estimate gates Write: disabled until the arguments produce one.
    await page.locator('.fn-head', { hasText: 'transfer(address, uint256)' }).click()
    const row = page.locator('.fn-row', { hasText: 'transfer(address, uint256)' })
    const writeBtn = row.locator('button', { hasText: /^Write$/ })
    await expect(writeBtn).toBeDisabled()
    await row.locator('input').nth(0).fill(E2E_EVM_ADDRESS)
    await row.locator('input').nth(1).fill('1000')
    // The row shows no cost at all, by decision: gas units are not a cost, and
    // the fee cannot be quoted before signing. An enabled Write is the estimate
    // landing. Both strings are asserted absent so neither creeps back.
    await expect(writeBtn).toBeEnabled()
    await expect(row).not.toContainText('Estimated gas')
    await expect(row).not.toContainText('Fee charged in')

    const expectedData = '0xa9059cbb' + E2E_EVM_ADDRESS.slice(2).padStart(64, '0') + (1000).toString(16).padStart(64, '0')
    await writeBtn.click()

    // The wallet signs a CallPermit — that payload is what this spec pins. The
    // dispatch then waits on the closed socket until runPermitWrite's own
    // timeout, which is unit-tested rather than waited out here.
    await expect(row).toContainText('Confirm in your wallet')

    const calls = await page.evaluate(() => (window as unknown as { __evmWalletCalls: { method: string; params?: unknown[] }[] }).__evmWalletCalls)
    const methods = calls.map(c => c.method)
    // The whole point of this path: nothing is ever sent as a transaction, so
    // the wallet never gets to gate the write on its WETH balance — and no chain
    // add/switch is needed to sign typed data.
    expect(methods).not.toContain('eth_sendTransaction')
    expect(methods).not.toContain('wallet_addEthereumChain')
    expect(methods).not.toContain('wallet_switchEthereumChain')

    const signed = calls.find(c => c.method === 'eth_signTypedData_v4')!
    expect(signed.params?.[0]).toBe(E2E_EVM_ADDRESS)
    const payload = JSON.parse(signed.params?.[1] as string)
    expect(payload.primaryType).toBe('CallPermit')
    expect(payload.domain).toEqual({
      name: 'Call Permit Precompile',
      version: '1',
      chainId: 222222,
      verifyingContract: '0x000000000000000000000000000000000000080a',
    })
    expect(payload.message).toEqual({
      from: E2E_EVM_ADDRESS,
      to: VERIFIED_CONTRACT_ADDRESS,
      value: '0',
      data: expectedData,
      gaslimit: 46_020,                                  // 36,816 estimate + 25%
      nonce: String(PERMIT_NONCE),                       // from the precompile, not the account
      deadline: String(BLOCK_TIMESTAMP + 3600),          // chain clock, not the browser's
    })

    // The hard isolation requirement: connecting and writing never touched
    // the login session; the wallet is remembered per-tab only.
    const storage = await page.evaluate(() => ({
      session: localStorage.getItem('explorer-session'),
      localKeys: Object.keys(localStorage).filter(k => k.includes('wallet') || k.includes('session')),
      remembered: sessionStorage.getItem('contract-write-wallet'),
    }))
    expect(storage.session).toBeNull()
    expect(storage.localKeys).toEqual([])
    expect(JSON.parse(storage.remembered!)).toEqual({ kind: 'evm', key: 'net.neckwork.test-wallet', address: E2E_EVM_ADDRESS, walletName: 'Test Wallet' })
  })

  test('a reverting estimate disables Write with the decoded reason; payable shows the WETH value field', async ({ page, evmWallet }) => {
    void evmWallet
    await mockEvmRpc(page)
    await page.goto(`/account/${VERIFIED_CONTRACT_ADDRESS}?view=contract&contract=write`)
    await connectTestWallet(page)
    await page.locator('.fn-head', { hasText: 'deposit()' }).click()
    const row = page.locator('.fn-row', { hasText: 'deposit()' })
    await expect(row.locator('.field label', { hasText: 'value' })).toContainText('WETH')
    await expect(row.locator('.dialog-error')).toContainText('Write would revert: not allowed')
    await expect(row.locator('button', { hasText: /^Write$/ })).toBeDisabled()
  })

  test('a substrate wallet connects, derives its truncated H160 source, and estimates as it', async ({ page, injectedWallet }) => {
    void injectedWallet
    const estimateCalls: { from?: string; data?: string }[] = []
    await mockEvmRpc(page, estimateCalls)
    await page.goto(`/account/${VERIFIED_CONTRACT_ADDRESS}?view=contract&contract=write`)

    await page.locator('.write-bar button', { hasText: 'Connect wallet' }).click()
    // The substrate group reuses the login dialog's tiles, shortlist first —
    // polkadot-js (the injected fixture) sits behind the same "Other wallets"
    // toggle. One account → auto-picked; the dedot chunk loads here to derive
    // the source.
    await page.locator('button.wallet-toggle', { hasText: 'Other wallets' }).click()
    await page.locator('.wallet-tile', { hasText: 'Polkadot{.js}' }).click()
    await expect(page.locator('.write-bar')).toContainText('You are writing to')
    await expect(page.locator('.write-bar')).toContainText('via Polkadot{.js}')

    // The estimate runs as the DERIVED H160, not the SS58 — exactly what the
    // runtime will execute the write as.
    await page.locator('.fn-head', { hasText: 'transfer(address, uint256)' }).click()
    const row = page.locator('.fn-row', { hasText: 'transfer(address, uint256)' })
    await row.locator('input').nth(0).fill(E2E_EVM_ADDRESS)
    await row.locator('input').nth(1).fill('1000')
    // An enabled Write is the estimate landing — the row shows no cost figure.
    await expect(row.locator('button', { hasText: /^Write$/ })).toBeEnabled()
    expect(estimateCalls.some(c => c.from === E2E_DERIVED_SOURCE)).toBe(true)

    // Connection-only: no login session appeared, the descriptor is per-tab.
    const storage = await page.evaluate(() => ({
      session: localStorage.getItem('explorer-session'),
      remembered: sessionStorage.getItem('contract-write-wallet'),
    }))
    expect(storage.session).toBeNull()
    expect(JSON.parse(storage.remembered!)).toEqual({ kind: 'substrate', key: 'polkadot-js', address: E2E_ADDRESS, walletName: 'Polkadot{.js}' })
  })

  test('silently reconnects the remembered wallet after a reload', async ({ page, evmWallet }) => {
    void evmWallet
    await mockEvmRpc(page)
    await page.goto(`/account/${VERIFIED_CONTRACT_ADDRESS}?view=contract&contract=write`)
    await connectTestWallet(page)
    await page.reload()
    await expect(page.locator('.write-bar')).toContainText('You are writing to')
    await expect(page.locator('.write-bar button', { hasText: 'Disconnect' })).toBeVisible()
  })

  // Argument history is keyed by signature and field, saved when Write is
  // pressed (whatever becomes of the transaction) and forgettable per value.
  test('remembers each field\'s last values per signature, offers them on another contract, and forgets one on demand', async ({ page, evmWallet }) => {
    void evmWallet
    await mockEvmRpc(page)
    await page.goto(`/account/${VERIFIED_CONTRACT_ADDRESS}?view=contract&contract=write`)
    await connectTestWallet(page)
    await page.locator('.fn-head', { hasText: 'transfer(address, uint256)' }).click()
    const row = page.locator('.fn-row', { hasText: 'transfer(address, uint256)' })
    const to = row.locator('input').nth(0)
    const amount = row.locator('input').nth(1)

    // First write: signed then dispatched into the closed socket. The values are
    // recorded regardless.
    await to.fill(E2E_EVM_ADDRESS)
    await amount.fill('1000')
    await row.locator('button', { hasText: /^Write$/ }).click()
    await expect(row).toContainText('Confirm in your wallet')

    // Second write from the same field: the first value is offered, and only in
    // its own field — the amount box never offers an address. Each popover is
    // scoped to its own field, and a field whose exact value is already typed
    // offers nothing, so both boxes are cleared first.
    // The suggestion wrapper must not shrink the box: the shared input reset has
    // no width of its own, so a wrapper without one collapses it to a few
    // characters.
    const fieldWidth = (await row.locator('.field').nth(0).boundingBox())!.width
    expect((await to.boundingBox())!.width).toBeGreaterThan(fieldWidth - 2)

    const toPop = row.locator('.field').nth(0).locator('.recent-pop')
    const amountPop = row.locator('.field').nth(1).locator('.recent-pop')
    await to.fill('')
    await amount.fill('')
    await to.click()
    await expect(toPop.locator('.recent-opt')).toHaveCount(1)
    await expect(toPop).toContainText(E2E_EVM_ADDRESS)
    await amount.click()
    await expect(amountPop).toContainText('1000')
    await expect(amountPop).not.toContainText(E2E_EVM_ADDRESS)

    // Picking a suggestion fills the field.
    await to.click()
    await toPop.locator('.recent-opt', { hasText: E2E_EVM_ADDRESS }).click()
    await expect(to).toHaveValue(E2E_EVM_ADDRESS)

    // Keyed by signature, not contract: the same call on a different address
    // offers the same value.
    await page.goto('/account/0x8c5e657ca8879ada34555130f3be255ae47558b5?view=contract&contract=write')
    await page.goto(`/account/${VERIFIED_CONTRACT_ADDRESS}?view=contract&contract=write`)
    await page.locator('.fn-head', { hasText: 'transfer(address, uint256)' }).click()
    await row.locator('input').nth(0).click()
    await expect(row.locator('.field').nth(0).locator('.recent-pop')).toContainText(E2E_EVM_ADDRESS)

    // The last argument's popover must not cover the Write button: it would
    // otherwise swallow the press and refill the field instead of writing. Both
    // arguments are filled so Write is enabled, and the amount is a prefix of the
    // remembered value so its popover still has something to show.
    await row.locator('input').nth(0).fill(E2E_EVM_ADDRESS)
    await row.locator('input').nth(1).fill('10')
    await row.locator('input').nth(1).click()
    await expect(amountPop).toBeVisible()
    const hit = await row.evaluate(el => {
      const pop = el.querySelector('.recent-pop')!.getBoundingClientRect()
      const button = el.querySelector('.fn-actions button') as HTMLElement
      const b = button.getBoundingClientRect()
      const over = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) as HTMLElement
      return { overlap: Math.max(0, Math.min(pop.bottom, b.bottom) - Math.max(pop.top, b.top)), hits: over?.tagName }
    })
    expect(hit.overlap).toBe(0)
    expect(hit.hits).toBe('BUTTON')

    // And the press really starts a write rather than picking a suggestion.
    await row.locator('.fn-actions button').click()
    await expect(row).toContainText('Confirm in your wallet')

    // Forgetting removes it for good — the popover has nothing left to offer.
    // The box is cleared first: a field already holding the exact value is
    // offered nothing, so there would be no × to click.
    await to.fill('')
    await to.click()
    await expect(toPop).toBeVisible()
    await toPop.locator('.recent-opt', { hasText: E2E_EVM_ADDRESS }).locator('button').click()
    await expect(toPop).toHaveCount(0)
    await page.reload()
    await page.locator('.fn-head', { hasText: 'transfer(address, uint256)' }).click()
    await row.locator('input').nth(0).click()
    await expect(row.locator('.field').nth(0).locator('.recent-pop')).toHaveCount(0)
  })
})

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('write stays usable at 390px with no horizontal overflow', async ({ page, evmWallet }) => {
    void evmWallet
    await mockEvmRpc(page)
    await page.goto(`/account/${VERIFIED_CONTRACT_ADDRESS}?view=contract&contract=write`)
    await connectTestWallet(page)
    await page.locator('.fn-head', { hasText: 'deposit()' }).click()
    await expect(page.locator('.fn-row', { hasText: 'deposit()' }).locator('.dialog-error')).toContainText('not allowed')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
