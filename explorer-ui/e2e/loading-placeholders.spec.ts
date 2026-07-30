import { expect, test } from './fixtures/test'
import type { Page } from '@playwright/test'

// A loading placeholder has to occupy the height of the thing that replaces it,
// or the page jumps under the reader when data lands. Two shapes on /blocks used
// to get this wrong: the chart placeholder was 168px against a 309px card, and on
// a phone — where every table row becomes a stacked card of one labelled line per
// column — the table placeholder collapsed to a single ~60px bar against a ~203px
// card. Both are measured here against the real thing in the same page load.

// Hold the API long enough to observe the placeholders, then let the fixture
// answer. The matcher is anchored at the origin root for the same reason as the
// fixture's: a loose `**/api/**` also catches Vite's `/src/api/*` modules.
const holdApi = (page: Page, ms: number) =>
  page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
    await new Promise(resolve => setTimeout(resolve, ms))
    await route.fallback()
  })

const HOLD_MS = 2500

for (const motion of ['no-preference', 'reduce'] as const) {
  test.describe(`phone card placeholder (prefers-reduced-motion: ${motion})`, () => {
    test.use({ viewport: { width: 390, height: 844 }, reducedMotion: motion })

    test('a blocks skeleton row is the size of the card it becomes', async ({ page }) => {
      await holdApi(page, HOLD_MS)
      await page.goto('/blocks')

      const skeleton = page.locator('tbody tr.sk-tr').first()
      await expect(skeleton).toBeVisible()
      // One line per column of the loaded card, as the card itself draws.
      await expect(skeleton.locator('td:not(.col-hide-mobile)')).toHaveCount(6)
      const placeholder = (await skeleton.boundingBox())!.height
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        'no sideways scroll while loading').toBe(0)

      const row = page.locator('tbody tr.clickable').first()
      await expect(row).toBeVisible()
      const loaded = (await row.boundingBox())!.height

      expect(loaded, 'a phone row is a stacked card, not a table line').toBeGreaterThan(150)
      expect(Math.abs(placeholder - loaded), `placeholder ${placeholder} vs card ${loaded}`).toBeLessThan(12)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        'no sideways scroll once loaded').toBe(0)
    })
  })
}

for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]] as const) {
  test.describe(`block-time chart placeholder (${name})`, () => {
    test.use({ viewport })

    test('reserves the chart card height so the table below holds still', async ({ page }) => {
      await holdApi(page, HOLD_MS)
      await page.goto('/blocks')

      // Layout position, not the painted one: page content rises into place on
      // mount with a transform, which moves no layout and shifts nothing.
      const panelTop = () => page.evaluate(() => (document.querySelector('.panel') as HTMLElement).offsetTop)

      await expect(page.locator('.chart-card-skeleton')).toBeVisible()
      const loading = await panelTop()

      // The placeholder is itself a `.pf-card` — it is built out of the loaded
      // card's chrome so its height needs no constant — so wait for the real one.
      await expect(page.locator('.pf-card:not(.chart-card-skeleton)')).toBeVisible()
      // The card's headline is the only GeistMono text on the page, so it is
      // still measuring in the fallback face the instant it appears.
      await page.evaluate(() => document.fonts.ready)
      const loaded = await panelTop()

      expect(Math.abs(loaded - loading), `table panel moved ${loaded - loading}px`).toBeLessThan(2)
    })
  })
}

// The other two standard chart cards. Both used to reserve a pixel constant that
// could only be right at one viewport, because the card's head takes its height
// from its font and wraps its figures below 720px: the account portfolio card
// reserved 260px against a card measuring 328px at 1440 and 378px at 390, and the
// asset price card reserved 336px — right at 1440, 52px short at 390. Both are now
// built out of the loaded card's own chrome, so the heights are compared directly
// here instead of against numbers this test would have to keep in sync.
//
// The placeholder reserves a head of four performance figures, because that is the
// shape live data almost always takes (24H/1W/1M/1Y). It cannot know in advance
// that a series is too short or too spiky for `performancePoints` to offer every
// window — in this fixture the portfolio card resolves to none and the price card
// to three, and at 390px a three-figure row still fits one line where four wrap.
// So the invariant asserted always is that the placeholder is never SHORTER than
// the card, which is the direction that dropped content under the reader; the
// exact match is asserted whenever the loaded head does carry the four it drew.
const ACCOUNT = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'

for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]] as const) {
  test.describe(`chart card placeholders (${name})`, () => {
    test.use({ viewport })

    for (const [what, route] of [['account portfolio', `/account/${ACCOUNT}`], ['asset price', '/asset/5']] as const) {
      test(`the ${what} placeholder is never shorter than the card it becomes`, async ({ page }) => {
        await holdApi(page, HOLD_MS)
        await page.goto(route)

        const placeholder = page.locator('.chart-card-skeleton')
        await expect(placeholder).toBeVisible()
        // Exactly one chart card is reserved on each of these pages, and it is
        // built from the card's chrome rather than given a height.
        await expect(placeholder).toHaveCount(1)
        await expect(placeholder).not.toHaveAttribute('style', /height/)
        const reserved = (await placeholder.boundingBox())!.height
        // Read while it is still mounted; it is gone once the card resolves.
        const drawn = await placeholder.locator('.pf-head .perf').count()

        const card = page.locator('.pf-card:not(.chart-card-skeleton)').first()
        await expect(card).toBeVisible()
        // GeistMono sets the headline, so the card is still measuring in the
        // fallback face the instant it appears.
        await page.evaluate(() => document.fonts.ready)
        const actual = (await card.boundingBox())!.height
        const figures = await card.locator('.pf-head .perf').count()

        expect(reserved, `reserved ${reserved} vs card ${actual}`).toBeGreaterThanOrEqual(actual - 2)
        if (figures === drawn) {
          expect(Math.abs(reserved - actual), `reserved ${reserved} vs card ${actual} with ${figures} figures`).toBeLessThan(2)
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
          'no sideways scroll').toBe(0)
      })
    }
  })
}
