import { expect, test, type Page } from '@playwright/test'

// The price scale is set from one place: the switch docked into the chart's
// bottom-right corner. What is worth pinning: either label toggles, the
// highlight travels between them, the choice survives a reload and a pair
// change, and the switch fits its corner exactly. The scale itself is drawn
// inside the canvas, so the mode is lightweight-charts' concern, not this
// suite's.
const assets = [
  { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, isStablecoin: false, parachainId: null },
  { assetId: 10, symbol: 'USDT', name: 'Tether', decimals: 6, isStablecoin: true, parachainId: 1000 },
]

// A steep ramp is the shape a log scale exists for. Fixed epoch + arithmetic
// prices keep the candles identical on every run.
const EPOCH = 1_700_000_000
const candles = Array.from({ length: 48 }, (_, i) => {
  const open = 0.5 * 1.2 ** i
  const close = open * 1.05
  return {
    intervalStart: EPOCH + i * 3600,
    open,
    high: Math.max(open, close) * 1.01,
    low: Math.min(open, close) * 0.99,
    close,
    volumeBuy: 1_000 + i,
    volumeSell: 900 + i,
    volumeTotal: 1_900 + 2 * i,
  }
})

const SWITCH = '.sc-segmented button'
const INDICATOR = '.sc-indicator'
const SLIDE_MS = 320

async function openChart(page: Page) {
  await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const body = path === '/assets' ? assets : path === '/candles' ? candles : []
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto('/0-10/1h')
  await expect(page.locator(SWITCH)).toBeVisible()
  // The chart measures and publishes its price-axis width once the series has
  // laid out; the switch's corner is defined relative to it.
  await expect
    .poll(() => page.locator('.chart-area').evaluate(el => el.style.getPropertyValue('--price-axis-w')))
    .toMatch(/^[1-9]\d*px$/)
}

test('either label toggles, and the highlight slides between them', async ({ page }) => {
  await openChart(page)

  const scaleSwitch = page.locator(SWITCH)
  const indicator = page.locator(INDICATOR)
  const lin = page.locator('.sc-cell').first()
  const log = page.locator('.sc-cell').last()

  await expect(scaleSwitch).toHaveAttribute('aria-checked', 'false')
  const atLin = (await indicator.boundingBox())!

  // Clicking the inactive label switches to it and the highlight travels one
  // cell to the right — horizontally only.
  await log.click()
  await expect(scaleSwitch).toHaveAttribute('aria-checked', 'true')
  await page.waitForTimeout(SLIDE_MS)
  const atLog = (await indicator.boundingBox())!
  expect(atLog.x - atLin.x).toBeCloseTo(atLin.width, 0)
  expect(atLog.y).toBeCloseTo(atLin.y, 0)

  // Clicking the *active* label toggles back rather than doing nothing.
  await log.click()
  await expect(scaleSwitch).toHaveAttribute('aria-checked', 'false')
  await page.waitForTimeout(SLIDE_MS)
  expect((await indicator.boundingBox())!.x).toBeCloseTo(atLin.x, 0)

  // The other label behaves the same way.
  await lin.click()
  await expect(scaleSwitch).toHaveAttribute('aria-checked', 'true')
})

test('the chosen scale survives a reload and a pair change', async ({ page }) => {
  await openChart(page)

  await page.locator(SWITCH).click()
  await expect(page.locator(SWITCH)).toHaveAttribute('aria-checked', 'true')

  await page.reload()
  await expect(page.locator(SWITCH)).toHaveAttribute('aria-checked', 'true')

  // The chart remounts per pair, so the new price scale has to be seeded from
  // the preference rather than falling back to linear.
  await page.goto('/10-0/1h')
  await expect(page.locator(SWITCH)).toHaveAttribute('aria-checked', 'true')
})

test('the switch is flush into the corner at the height its neighbour sets', async ({ page }, testInfo) => {
  await openChart(page)

  const area = (await page.locator('.chart-area').boundingBox())!
  const box = (await page.locator(SWITCH).boundingBox())!
  const axisWidth = await page
    .locator('.chart-area')
    .evaluate(el => Number.parseFloat(el.style.getPropertyValue('--price-axis-w')))
  // With a sidebar the switch matches the app's bottom strip so it lines up with
  // the indexer footer; without one it matches the time-axis row it sits in.
  const expectedHeight = testInfo.project.name === 'desktop'
    ? await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--status-strip-h')))
    : await page.locator('.chart-area')
      .evaluate(el => Number.parseFloat(el.style.getPropertyValue('--time-axis-h')))

  // Flush: no gap on the two edges it is fitted to.
  expect(box.x + box.width).toBeCloseTo(area.x + area.width, 0)
  expect(box.y + box.height).toBeCloseTo(area.y + area.height, 0)
  expect(box.height).toBeCloseTo(expectedHeight, 0)
  // Inside the price-axis column, which the chart leaves empty — past it the
  // switch would start covering time-axis labels.
  expect(box.x).toBeGreaterThanOrEqual(area.x + area.width - axisWidth)

  // Rounded on the top-left only; the other three meet the chart's own edges.
  const radii = await page.locator(SWITCH).evaluate(el => {
    const s = getComputedStyle(el)
    return {
      topLeft: s.borderTopLeftRadius,
      topRight: s.borderTopRightRadius,
      bottomRight: s.borderBottomRightRadius,
      bottomLeft: s.borderBottomLeftRadius,
    }
  })
  expect(radii).toEqual({ topLeft: '8px', topRight: '0px', bottomRight: '0px', bottomLeft: '0px' })
})

test('the switch and the sidebar indexer footer line up across the seam', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the sidebar is a drawer on mobile')
  await openChart(page)

  const box = (await page.locator(SWITCH).boundingBox())!
  const indexer = (await page.locator('.sb-indexer').boundingBox())!

  // They are neighbours along the bottom edge: same top edge, same bottom edge.
  expect(box.y).toBeCloseTo(indexer.y, 0)
  expect(box.y + box.height).toBeCloseTo(indexer.y + indexer.height, 0)
})
