import type { Page } from '@playwright/test'
import { expect, test, E2E_ADDRESS, E2E_EVM_ADDRESS, E2E_EVM_TX_HASH } from './fixtures/test'
import { VERIFIED_CONTRACT_ADDRESS } from '../tests/fixtures/mockApi'

// The contract tab's Write sub-tab over the EVM-wallet path: a wallet
// connection of its own (never the login session), continuous gas estimates
// gating the Write button, chain add/switch with the exact §7.5 parameters,
// and the submitted → in-block → success lifecycle. The wallet is the
// `evmWallet` EIP-6963 fixture; the HTTP RPC (estimate, gas price, receipt)
// is mocked at the network layer so the real codec encodes every byte.

const WORD = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
// Error(string) "not allowed": selector + offset + length + left-aligned bytes.
const NOT_ALLOWED_REVERT = '0x08c379a0' + WORD('20') + WORD('b') + '6e6f7420616c6c6f776564'.padEnd(64, '0')

// The first 20 bytes of E2E_ADDRESS's AccountId32 — what EnsureAddressTruncated
// maps a substrate signer to (pinned by tests/substrate-write.test.ts).
const E2E_DERIVED_SOURCE = '0xba896f978f18d179207937a73758022ff6b405bc'

async function mockEvmRpc(page: Page, estimateCalls?: { from?: string; data?: string }[]) {
  let receiptPolls = 0
  await page.route('https://hydration-rpc.neckwork.net/**', async route => {
    const body = route.request().postDataJSON() as { method: string; params?: [{ data?: string; from?: string }, ...unknown[]] }
    const respond = (result: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) })
    if (body.method === 'eth_getCode') return respond('0x6080604052' + 'ab'.repeat(64))
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

  test('connects its own wallet and completes a write with the exact chain params', async ({ page, evmWallet }) => {
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
    await expect(row).toContainText('Estimated gas')
    await expect(row).toContainText('36,816')
    await expect(writeBtn).toBeEnabled()

    // Write: chain switch (4902) → add with the §7.5 params → switch → send.
    await writeBtn.click()
    await expect(row.locator('.badge.ok', { hasText: 'Success' })).toBeVisible()
    await expect(row.locator('a', { hasText: '314,159' })).toHaveAttribute('href', '/block/314159')

    const calls = await page.evaluate(() => (window as unknown as { __evmWalletCalls: { method: string; params?: unknown[] }[] }).__evmWalletCalls)
    const methods = calls.map(c => c.method)
    expect(methods.filter(m => m === 'wallet_addEthereumChain')).toHaveLength(1)
    expect(methods.indexOf('wallet_addEthereumChain')).toBeGreaterThan(methods.indexOf('wallet_switchEthereumChain'))
    const add = calls.find(c => c.method === 'wallet_addEthereumChain')!
    expect(add.params).toEqual([{
      chainId: '0x3640e',
      chainName: 'Hydration',
      nativeCurrency: { name: 'WETH', symbol: 'WETH', decimals: 18 },
      rpcUrls: ['https://hydration-rpc.neckwork.net'],
      blockExplorerUrls: ['http://127.0.0.1:5197'],
    }])
    const send = calls.find(c => c.method === 'eth_sendTransaction')!
    expect(send.params).toEqual([{
      from: E2E_EVM_ADDRESS,
      to: VERIFIED_CONTRACT_ADDRESS,
      data: '0xa9059cbb' + E2E_EVM_ADDRESS.slice(2).padStart(64, '0') + (1000).toString(16).padStart(64, '0'),
    }])

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
    await expect(row).toContainText('Estimated gas')
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
