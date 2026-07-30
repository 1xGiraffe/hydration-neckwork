import { expect, test, type Page } from '@playwright/test'

// Chart keys, the global typeahead and each dialog's own handler all listen on
// document/window, so an open dialog has to own the keyboard: a keypress must not
// reach the chart behind it, and must not stack a second dialog on top of it.
const assets = [
  { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, isStablecoin: false, parachainId: null },
  { assetId: 10, symbol: 'USDT', name: 'Tether', decimals: 6, isStablecoin: true, parachainId: 1000 },
]

const marketStats = [
  { assetId: 0, symbol: 'HDX', price: 0.0123, change1h: 0, change24h: 0, change7d: 0, sparkline: [0.0121, 0.0123], volumeUsd24h: 123_456 },
  { assetId: 10, symbol: 'USDT', price: 1, change1h: 0, change24h: 0, change7d: 0, sparkline: [1, 1], volumeUsd24h: 1_000_000 },
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

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

async function openDrawer(page: Page) {
  await page.getByRole('button', { name: /open markets and favorites/i }).click()
  const drawer = page.locator('.mobile-drawer-panel')
  await expect(drawer).toBeVisible()
  return drawer
}

test.describe('an open dialog owns the keyboard', () => {
  test('the typeahead does not open the picker over the drawer', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'desktop', 'the markets drawer is the mobile layout')
    await mockApi(page)
    await page.goto('/')
    const drawer = await openDrawer(page)

    await page.keyboard.press('d')
    // The picker would mount asynchronously, so give it the chance to appear —
    // asserting immediately passes whether or not the bug is present.
    await page.waitForTimeout(600)

    await expect(page.locator('.picker-modal')).toHaveCount(0)
    await expect(drawer).toBeVisible()
  })

  test('the picker shortcut is ignored while the drawer is open', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'desktop', 'the markets drawer is the mobile layout')
    await mockApi(page)
    await page.goto('/')
    const drawer = await openDrawer(page)

    await page.keyboard.press('/')
    await page.waitForTimeout(600)

    await expect(page.locator('.picker-modal')).toHaveCount(0)
    await expect(drawer).toBeVisible()
  })

  test('escape still closes the drawer itself', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'desktop', 'the markets drawer is the mobile layout')
    await mockApi(page)
    await page.goto('/')
    const drawer = await openDrawer(page)

    await page.keyboard.press('Escape')

    await expect(drawer).toHaveCount(0)
  })
})
