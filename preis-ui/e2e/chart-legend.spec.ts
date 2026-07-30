import { expect, test, type Page } from '@playwright/test'

// The O/H/L/C/V legend is a DOM overlay on top of a canvas chart whose price
// axis is drawn *inside* that canvas, at the right edge. On a phone there is no
// room to place the legend beside the axis by guesswork: the axis is as wide as
// its labels, and an 8-decimal price ("0.00740000") needs far more room than
// "$1,961". The chart therefore measures the axis and publishes the width as
// `--price-axis-w`, which the legend reserves as a right gutter — that is what
// lets the legend sit at the very top of the chart instead of being pushed down
// past the labels.
const assets = [
  { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, isStablecoin: false, parachainId: null },
  { assetId: 10, symbol: 'USDT', name: 'Tether', decimals: 6, isStablecoin: true, parachainId: 1000 },
]

// A sub-cent price forces the widest axis labels (8-decimal precision), which is
// the case a fixed gutter gets wrong. Fixed epoch + arithmetic prices keep the
// candles identical on every run.
const EPOCH = 1_700_000_000
const candles = Array.from({ length: 48 }, (_, i) => {
  const open = 0.007 + i * 0.000_002
  const close = open + (i % 2 === 0 ? 0.000_001 : -0.000_001)
  return {
    intervalStart: EPOCH + i * 3600,
    open,
    high: Math.max(open, close) + 0.000_001,
    low: Math.min(open, close) - 0.000_001,
    close,
    volumeBuy: 1_000 + i,
    volumeSell: 900 + i,
    volumeTotal: 1_900 + 2 * i,
  }
})

async function mockApi(page: Page) {
  await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const body = path === '/assets' ? assets : path === '/candles' ? candles : []
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

async function openChart(page: Page) {
  await mockApi(page)
  await page.goto('/0-10/1h')
  await expect(page.locator('.chart-legend')).toBeVisible()
  // The axis width is measured once the series has data and the chart has laid
  // out, so wait for the published value rather than a fixed delay.
  await expect
    .poll(() => page.locator('.chart-area').evaluate(el => el.style.getPropertyValue('--price-axis-w')))
    .toMatch(/^[1-9]\d*px$/)
}

test('the mobile legend sits at the top of the chart, clear of the price axis', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'mobile layout')
  await openChart(page)

  const area = (await page.locator('.chart-area').boundingBox())!
  const legend = (await page.locator('.chart-legend').boundingBox())!
  const axisWidth = await page
    .locator('.chart-area')
    .evaluate(el => Number.parseFloat(el.style.getPropertyValue('--price-axis-w')))

  // Top of the chart, not pushed below the axis labels.
  expect(legend.y - area.y).toBeLessThanOrEqual(16)
  // Ends before the axis the chart reported, so no value is drawn under a label.
  expect(legend.x + legend.width).toBeLessThanOrEqual(area.x + area.width - axisWidth)
})

test('each legend key is dimmed and joined to its value', async ({ page }) => {
  await openChart(page)

  const open = page.locator('.chart-legend > span').first()
  // "O0.007095" — the key reads as a prefix of the number, with no gap.
  await expect(open).toHaveText(/^O[\d,]/)

  const colors = await open.evaluate(el => {
    const key = el.querySelector('.k')!
    return { key: getComputedStyle(key).color, value: getComputedStyle(el).color }
  })
  expect(colors.key).not.toBe(colors.value)
})
