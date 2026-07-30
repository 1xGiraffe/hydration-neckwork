import { expect, test, type Page } from '@playwright/test'

// On an iOS home-screen PWA the app runs with `viewport-fit=cover` and a
// `black-translucent` status bar, so web content is drawn edge-to-edge *behind*
// the status bar. Top-anchored surfaces must offset their content by the top
// safe-area inset or they end up underneath the clock/battery. Chromium can't
// emulate a real inset, so we drive the `--safe-top` custom property the CSS
// reads and assert the offset propagates to the surfaces that need it.
const INSET = 44

// Override the `--safe-top` variable the CSS reads (an inline style on the root
// beats the stylesheet's `env(...)` fallback) to stand in for the iOS inset.
const simulateInset = (px: number) =>
  document.documentElement.style.setProperty('--safe-top', `${px}px`)

const assets = [
  { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, isStablecoin: false, parachainId: null },
  { assetId: 10, symbol: 'USDT', name: 'Tether', decimals: 6, isStablecoin: true, parachainId: 1000 },
]

async function mockApi(page: Page) {
  await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const body = path === '/assets' ? assets : []
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

test.describe('iOS safe-area top inset', () => {
  test('topbar clears a simulated status bar', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    await page.evaluate(simulateInset, INSET)

    const box = await page.locator('.topbar').boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(INSET - 0.5)
  })

  test('mobile markets drawer clears a simulated status bar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'desktop', 'mobile-only drawer')
    await mockApi(page)
    await page.goto('/')
    await page.evaluate(simulateInset, INSET)

    await page.getByRole('button', { name: /open markets and favorites/i }).click()
    const box = await page.locator('.mobile-drawer-panel .mobile-drawer-close').boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(INSET - 0.5)
  })
})
