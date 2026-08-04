import { expect, test } from './fixtures/test'
import { blockExtrinsicCount } from '../tests/fixtures/mockApi'

// The extrinsic page needs one fact about its block — whether an index+1 exists —
// and gets it by asking for that sibling, not by pulling the whole block (every
// extrinsic and every event) for a single chevron. The sibling lands in the cache
// the next page reads, so the arrow opens an extrinsic that is already loaded.

const HEIGHT = 12_848_613
const LAST = blockExtrinsicCount(HEIGHT) - 1

test.describe('extrinsic neighbour navigation', () => {
  test('never fetches the block detail, and probes only the next sibling', async ({ page }) => {
    const blockDetail: string[] = []
    const extrinsicDetail: string[] = []
    page.on('request', r => {
      const path = new URL(r.url()).pathname
      if (/^\/api\/explorer\/block\/\d+$/.test(path)) blockDetail.push(path)
      const m = /^\/api\/explorer\/extrinsic-at\/\d+\/(\d+)$/.exec(path)
      if (m) extrinsicDetail.push(m[1])
    })

    await page.goto(`/extrinsic/${HEIGHT}-1`)
    await expect(page.locator('.dl .dd').first()).toHaveText(`${HEIGHT}-1`)
    await expect(page.locator('[aria-label="Next extrinsic"]')).toBeVisible()

    expect(blockDetail).toHaveLength(0)
    // Exactly the extrinsic on screen and the one the arrow points at — no more.
    expect([...new Set(extrinsicDetail)].sort()).toEqual(['1', '2'])
  })

  test('the arrows walk the block and stop at its last extrinsic', async ({ page }) => {
    await page.goto(`/extrinsic/${HEIGHT}-${LAST - 1}`)
    await expect(page.locator('[aria-label="Previous extrinsic"]')).toBeVisible()
    await page.locator('[aria-label="Next extrinsic"]').click()

    await expect(page).toHaveURL(new RegExp(`/extrinsic/${HEIGHT}-${LAST}$`))
    await expect(page.locator('.dl .dd').first()).toHaveText(`${HEIGHT}-${LAST}`)
    // Past the block's last index there is no extrinsic. The arrow stays in place,
    // disabled and saying why, so the pair never shifts mid-walk — both arrows sit
    // at the same coordinates on the first and last extrinsic of the block.
    const next = page.locator('[aria-label="Next extrinsic"]')
    const prev = page.locator('[aria-label="Previous extrinsic"]')
    await expect(next).toBeDisabled()
    await expect(next).toHaveAttribute('title', 'Last extrinsic in this block')
    await expect(prev).toBeEnabled()
    // Horizontal position only: the page's mount transform moves the painted box
    // vertically for a moment, and it is sideways drift — a right-aligned strip
    // resizing as arrows appear and vanish — that this pins.
    const atLast = await next.boundingBox()

    await page.goto(`/extrinsic/${HEIGHT}-0`)
    await expect(page.locator('.dl .dd').first()).toHaveText(`${HEIGHT}-0`)
    await expect(prev).toBeDisabled()
    await expect(prev).toHaveAttribute('title', 'First extrinsic in this block')
    await expect(next).toBeEnabled()
    expect((await next.boundingBox())!.x).toBe(atLast!.x)
  })

  test.describe('mobile', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('the card below holds still while the neighbour resolves', async ({ page }) => {
      // A long extrinsic id fills the title row on a phone, so the arrows wrap onto
      // their own flex line. That line is reserved before either arrow can exist, so
      // the sibling landing must not push the page down (see ExtrinsicDetail).
      await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
        await new Promise(resolve => setTimeout(resolve, 1200))
        await route.fallback()
      })
      await page.goto(`/extrinsic/${HEIGHT}-1`)

      // Layout position, not the painted one: content rises into place on mount with
      // a transform, which moves no layout.
      const cardTop = () => page.evaluate(() => (document.querySelector('.detail-card') as HTMLElement).offsetTop)
      await expect(page.locator('.nav-btns')).toHaveCount(1)
      // Both arrows exist from the first paint, disabled until the extrinsic and
      // its sibling resolve — so the strip's height is settled before either can.
      await expect(page.locator('[aria-label="Next extrinsic"]')).toBeDisabled()
      await page.evaluate(() => document.fonts.ready)
      const loading = await cardTop()

      await expect(page.locator('[aria-label="Next extrinsic"]')).toBeEnabled()
      const loaded = await cardTop()
      expect(Math.abs(loaded - loading), `detail card moved ${loaded - loading}px`).toBeLessThan(2)
    })
  })
})
