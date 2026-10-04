import { expect, test, type Page } from '@playwright/test'

// Stablecoin-quoted pairs (PRIMEUSDT, PRIMEUSDC) are offered only while the API
// reports the 'route' pair price source; under 'usd-ratio' the picker is the one
// it always was. Their URLs open in either mode.

const asset = (assetId: number, symbol: string, name: string, usd = false) => ({
  assetId, symbol, name, decimals: 6, isStablecoin: usd, isUsdPegged: usd, parachainId: null,
})
const assets = [
  asset(0, 'HDX', 'Hydration'),
  asset(10, 'USDT', 'Tether', true),
  asset(22, 'USDC', 'USDC', true),
  asset(43, 'PRIME', 'Prime'),
]
const stat = (assetId: number, symbol: string, price: number) => ({
  assetId, symbol, price, change1h: 0, change24h: 0.01, change7d: 0.02, sparkline: [price, price], volumeUsd24h: 1_000,
})
const marketStats = [stat(0, 'HDX', 0.0123), stat(10, 'USDT', 1), stat(22, 'USDC', 1), stat(43, 'PRIME', 1.06)]

async function mockApi(page: Page, priceSource: 'route' | 'usd-ratio' | null) {
  const candleRequests: string[] = []
  await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^\/api/, '')
    if (path === '/candles/price-source' && priceSource == null) {
      await route.fulfill({ status: 404, body: 'not found' })
      return
    }
    if (path === '/candles') candleRequests.push(url.search)
    const body = path === '/assets' ? assets
      : path === '/market-stats' ? marketStats
        : path === '/indexer' ? { blockHeight: 1, lagSeconds: 0 }
          : path === '/candles/price-source' ? { priceSource }
            : []
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  return candleRequests
}

async function searchPicker(page: Page, query: string) {
  await page.getByRole('button', { name: /select trading pair/i }).click()
  const dialog = page.getByRole('dialog', { name: 'Select trading pair' })
  await dialog.getByRole('combobox').fill(query)
  return dialog
}

for (const source of ['usd-ratio', null] as const) {
  test(`offers no stablecoin-quoted pairs under ${source ?? 'a missing price source'}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one layout is enough')
    await mockApi(page, source)
    await page.goto('/')
    const dialog = await searchPicker(page, 'PRIME')
    await expect(dialog.locator('.picker-sym').first()).toHaveText('PRIME')
    await expect(dialog.locator('.picker-sym', { hasText: /^PRIMEUSD[TC]$/ })).toHaveCount(0)
  })
}

test('offers PRIMEUSDT and PRIMEUSDC under the route price source', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one layout is enough')
  const candleRequests = await mockApi(page, 'route')
  await page.goto('/')
  const dialog = await searchPicker(page, 'PRIME')
  await expect(dialog.locator('.picker-sym').first()).toHaveText('PRIME')
  await expect(dialog.locator('.picker-sym', { hasText: /^PRIMEUSDT$/ })).toHaveCount(1)
  await expect(dialog.locator('.picker-sym', { hasText: /^PRIMEUSDC$/ })).toHaveCount(1)

  await dialog.getByRole('option').filter({ has: page.locator('.picker-sym', { hasText: /^PRIMEUSDC$/ }) }).click()
  await expect(page).toHaveURL(/\/43-22\/1h\?quote=asset$/)
  await expect(page.locator('.chart-head-pair .name')).toHaveText('PRIMEUSDC')
  await expect.poll(() => candleRequests.some(q => q.includes('baseId=43') && q.includes('quoteId=22') && q.includes('quoteAsset=1'))).toBe(true)
})

test('opens a stablecoin-quoted URL in either mode and keeps the USD pair apart', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one layout is enough')
  await mockApi(page, 'usd-ratio')
  await page.goto('/43-10/1h?quote=asset')
  await expect(page.locator('.chart-head-pair .name')).toHaveText('PRIMEUSDT')
  await expect(page).toHaveURL(/\/43-10\/1h\?quote=asset$/)

  await page.goto('/43-10/1h')
  await expect(page.locator('.chart-head-pair .name')).toHaveText('PRIME')
})
