import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { VERIFIED_CONTRACT_ADDRESS, UNVERIFIED_CONTRACT_ADDRESS } from '../tests/fixtures/mockApi'

// The account page's Contract tab: Code (verification card, source viewer, ABI,
// browser-fetched bytecode, verify panel) and Read (view/pure functions over
// browser-side eth_call). The EVM RPC is mocked at the network layer so the
// real codec chunk still encodes/decodes every byte on the wire.

const WORD = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
// ABI-encoded string "GHO": offset, length 3, then the bytes left-aligned.
const SYMBOL_RESULT = '0x' + WORD('20') + WORD('3') + '47484f'.padEnd(64, '0')
const SUPPLY_RESULT = '0x' + WORD((10n ** 24n).toString(16))     // 1,000,000 × 1e18
const BALANCE_RESULT = '0x' + WORD((42n * 10n ** 18n).toString(16))

async function mockEvmRpc(page: Page) {
  await page.route('https://hydration-rpc.neckwork.net/**', async route => {
    const body = route.request().postDataJSON() as { method: string; params?: [{ data?: string }] }
    const respond = (result: string) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) })
    if (body.method === 'eth_getCode') return respond('0x6080604052' + 'ab'.repeat(64))
    if (body.method === 'eth_call') {
      const selector = body.params?.[0]?.data?.slice(0, 10)
      if (selector === '0x95d89b41') return respond(SYMBOL_RESULT)    // symbol()
      if (selector === '0x18160ddd') return respond(SUPPLY_RESULT)    // totalSupply()
      if (selector === '0x70a08231') return respond(BALANCE_RESULT)   // balanceOf(address)
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0x' } }) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }) })
  })
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('verified contract: Code shows the verification card, sources, ABI and bytecode', async ({ page }) => {
    await mockEvmRpc(page)
    await page.goto(`/account/${VERIFIED_CONTRACT_ADDRESS}`)
    // Verified name fills the header name slot; the tab exists only for contracts.
    await expect(page.locator('.acct-head')).toContainText('GhoToken')
    await page.locator('.detail-tabs button', { hasText: 'Contract' }).click()
    await expect(page).toHaveURL(/view=contract/)
    await expect(page.locator('.id-card', { hasText: 'Verification' })).toContainText('v0.8.10+commit.fc410830')
    await expect(page.locator('.id-card', { hasText: 'Verification' })).toContainText('✓ Verified')
    // Source files: the list switches the viewer.
    await expect(page.locator('.src-files button', { hasText: 'src/GhoToken.sol' })).toBeVisible()
    await expect(page.locator('.src-viewer').first()).toContainText('contract GhoToken')
    await page.locator('.src-files button', { hasText: 'src/lib/Math.sol' }).click()
    await expect(page.locator('.src-viewer').first()).toContainText('library Math')
    // ABI (collapsible) and browser-fetched bytecode.
    await page.locator('.abi-details summary').click()
    await expect(page.locator('.abi-details .json')).toContainText('balanceOf')
    await expect(page.locator('.src-viewer').last()).toContainText('0x6080604052')
    // Verified contracts never show the verify panel.
    await expect(page.getByText('forge verify-contract')).toHaveCount(0)
  })

  test('read tab queries the chain through the ABI codec', async ({ page }) => {
    await mockEvmRpc(page)
    await page.goto(`/account/${VERIFIED_CONTRACT_ADDRESS}?view=contract&contract=read`)
    const rows = page.locator('.fn-row')
    await expect(rows).toHaveCount(3)               // balanceOf, totalSupply, symbol — transfer stays off
    await expect(page.getByText('transfer(')).toHaveCount(0)
    // A parameterless function auto-queries on expand; the string result decodes.
    await page.locator('.fn-head', { hasText: 'symbol()' }).click()
    await expect(page.locator('.fn-row', { hasText: 'symbol()' })).toContainText('GHO')
    // totalSupply: a uint256 rendered exactly (grouped), with a compact hint.
    await page.locator('.fn-head', { hasText: 'totalSupply()' }).click()
    await expect(page.locator('.fn-row', { hasText: 'totalSupply()' })).toContainText('1,000,000,000,000,000,000,000,000')
    // A typed input: validation rejects garbage, then a real address queries.
    await page.locator('.fn-head', { hasText: 'balanceOf(address)' }).click()
    const row = page.locator('.fn-row', { hasText: 'balanceOf(address)' })
    await row.locator('input').fill('not-an-address')
    await row.locator('button', { hasText: 'Query' }).click()
    await expect(row.locator('.dialog-error')).toContainText('address')
    await row.locator('input').fill(UNVERIFIED_CONTRACT_ADDRESS)
    await row.locator('button', { hasText: 'Query' }).click()
    await expect(row).toContainText('42,000,000,000,000,000,000')
  })

  test('unverified contract: Code offers the CLI commands and the upload form; Read hints', async ({ page }) => {
    await mockEvmRpc(page)
    await page.goto(`/account/${UNVERIFIED_CONTRACT_ADDRESS}?view=contract`)
    await expect(page.locator('.cli-block').first()).toContainText(`forge verify-contract ${UNVERIFIED_CONTRACT_ADDRESS}`)
    await expect(page.locator('.cli-block').first()).toContainText('--verifier sourcify')
    await expect(page.locator('.upload-zone')).toBeVisible()
    await expect(page.getByPlaceholder('src/MyToken.sol:MyToken')).toBeVisible()
    // Read needs a verified ABI — the hint links back to the verify panel.
    await page.goto(`/account/${UNVERIFIED_CONTRACT_ADDRESS}?view=contract&contract=read`)
    await expect(page.locator('.id-card', { hasText: 'Read' })).toContainText('verified ABI')
  })
})

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('code and read stay usable at 390px with no horizontal overflow', async ({ page }) => {
    await mockEvmRpc(page)
    await page.goto(`/account/${VERIFIED_CONTRACT_ADDRESS}?view=contract`)
    await expect(page.locator('.src-viewer').first()).toContainText('contract GhoToken')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await page.goto(`/account/${VERIFIED_CONTRACT_ADDRESS}?view=contract&contract=read`)
    await page.locator('.fn-head', { hasText: 'symbol()' }).click()
    await expect(page.locator('.fn-row', { hasText: 'symbol()' })).toContainText('GHO')
    const overflowRead = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflowRead).toBeLessThanOrEqual(0)
  })
})
