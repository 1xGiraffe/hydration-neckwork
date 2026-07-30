import { expect, test } from './fixtures/test'

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

test.describe('iOS safe-area top inset', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('sticky topbar clears a simulated status bar', async ({ page }) => {
    await page.goto('/activity')
    await page.evaluate(simulateInset, INSET)

    const inner = page.locator('.topbar .topbar-inner')
    const box = await inner.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(INSET - 0.5)
  })

  test('open menu drawer clears a simulated status bar', async ({ page }) => {
    await page.goto('/activity')
    await page.evaluate(simulateInset, INSET)

    await page.locator('.nav-burger').click()
    const head = page.locator('.drawer .drawer-head')
    const box = await head.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(INSET - 0.5)
  })
})
