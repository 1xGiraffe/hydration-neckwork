import { expect, test, type Page } from '@playwright/test'

const assets = [
  {
    assetId: 0,
    symbol: 'HDX',
    name: 'Hydration',
    decimals: 12,
    isStablecoin: false,
    parachainId: null,
  },
  {
    assetId: 10,
    symbol: 'USDT',
    name: 'Tether',
    decimals: 6,
    isStablecoin: true,
    parachainId: 1000,
  },
]

const marketStats = [
  {
    assetId: 0,
    symbol: 'HDX',
    price: 0.0123,
    change1h: 0.01,
    change24h: 0.0234,
    change7d: -0.0456,
    sparkline: [0.0118, 0.0121, 0.0119, 0.0123],
    volumeUsd24h: 123_456,
  },
  {
    assetId: 10,
    symbol: 'USDT',
    price: 1,
    change1h: 0,
    change24h: 0,
    change7d: 0,
    sparkline: [1, 1],
    volumeUsd24h: 1_000_000,
  },
]

async function mockApi(page: Page) {
  await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const body = path === '/assets'
      ? assets
      : path === '/market-stats'
        ? marketStats
        : path === '/indexer'
          ? {
              blockHeight: 1,
              blockTimestamp: '2026-07-11 12:00:00',
              lagSeconds: 0,
              chainBlockHeight: 1,
              blocksBehindHead: 0,
              rawFinalizedRangeCount: 1,
              rawFinalizedFromBlock: 1,
              rawFinalizedToBlock: 1,
            }
          : []

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}

test('keeps compact market rows on narrow phones', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'mobile layout')
  await mockApi(page)
  await page.goto('/')
  await page.getByRole('button', { name: /select trading pair/i }).click()

  const dialog = page.getByRole('dialog', { name: 'Select trading pair' })
  const row = dialog.getByRole('option', { name: /HDX.*Hydration/ })

  await expect(row).toBeVisible()
  await expect(row.locator('.picker-sym')).toBeVisible()
  await expect(row.locator('.picker-sym')).toHaveText('HDX')
  await expect(row.locator('.picker-hint')).toHaveText('Hydration')
  await expect(row.locator('.picker-num')).toHaveText('$0.0123')
  await expect(row.locator('.picker-chg').nth(1)).toHaveText('+2.34%')
  await expect(row.locator('.picker-spark svg')).toBeVisible()
  await expect(row.locator('.col-1h')).toBeHidden()
  await expect(row.locator('.col-7d')).toBeHidden()

  const rowBox = await row.boundingBox()
  expect(rowBox).not.toBeNull()
  expect(rowBox!.height).toBeLessThanOrEqual(60)

  const visibleCells = [
    row.locator('.picker-asset'),
    row.locator('.picker-num'),
    row.locator('.picker-chg').nth(1),
    row.locator('.picker-spark'),
  ]
  const boxes = await Promise.all(visibleCells.map(cell => cell.boundingBox()))
  expect(boxes.every(Boolean)).toBe(true)
  for (let index = 1; index < boxes.length; index += 1) {
    expect(boxes[index]!.x).toBeGreaterThanOrEqual(boxes[index - 1]!.x + boxes[index - 1]!.width - 0.5)
  }
  const symbolBox = await row.locator('.picker-sym').boundingBox()
  expect(symbolBox).not.toBeNull()
  expect(symbolBox!.x + symbolBox!.width).toBeLessThanOrEqual(boxes[1]!.x)
  expect(boxes.at(-1)!.x + boxes.at(-1)!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
})

test('shows the complete market row on desktop', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop layout')
  await mockApi(page)
  await page.goto('/')
  await page.getByRole('button', { name: /select trading pair/i }).click()

  const dialog = page.getByRole('dialog', { name: 'Select trading pair' })
  const row = dialog.getByRole('option', { name: /HDX.*Hydration/ })

  await expect(row).toBeVisible()
  await expect(row.locator('.col-1h')).toBeVisible()
  await expect(row.locator('.col-1h')).toHaveText('+1.00%')
  await expect(row.locator('.col-7d')).toBeVisible()
  await expect(row.locator('.col-7d')).toHaveText('-4.56%')
  await expect(row.locator('.picker-spark svg')).toBeVisible()
})
