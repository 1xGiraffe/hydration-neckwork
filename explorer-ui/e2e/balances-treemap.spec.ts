import { expect, test } from './fixtures/test'

// Balances render as a value-weighted treemap (BalancesTreemap) on the account
// detail page, replacing the old table. Tiles are sized by USD value, the biggest
// holding is the biggest tile, and hovering/tapping a tile previews its full
// breakdown in the docked detail card.
const FOX = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'

async function area(el: import('@playwright/test').Locator): Promise<number> {
  const b = (await el.boundingBox())!
  return b.width * b.height
}

test.describe('balances treemap — desktop', () => {
  test('sizes tiles by value, biggest holding biggest, with value + share on the face', async ({ page }) => {
    await page.goto(`/account/${FOX}?view=balances`)
    const map = page.locator('.tm')
    await expect(map).toBeVisible()

    const tiles = page.locator('.tm-tile')
    const count = await tiles.count()
    expect(count).toBeGreaterThanOrEqual(2)

    // Balances arrive sorted desc by value, so the first tile is the largest area.
    const first = await area(tiles.first())
    for (let i = 1; i < count; i++) {
      expect(first, `tile 0 should be >= tile ${i}`).toBeGreaterThanOrEqual(await area(tiles.nth(i)) - 1)
    }

    // The biggest tile shows value ($) and share (%) directly on its face.
    const faceText = (await tiles.first().innerText()).replace(/\s+/g, ' ')
    expect(faceText).toMatch(/\$/)
    expect(faceText).toMatch(/%/)

    // No horizontal overflow.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)

    // No tile may spill past the map container — a tiny tile must clip, not balloon.
    const spill = await page.evaluate(() => {
      const box = document.querySelector('.tm')!.getBoundingClientRect()
      return [...document.querySelectorAll('.tm-tile')].reduce((max, t) => {
        const r = t.getBoundingClientRect()
        return Math.max(max, r.right - box.right, r.bottom - box.bottom, box.left - r.left, box.top - r.top)
      }, 0)
    })
    expect(spill, 'tiles must stay within the treemap container').toBeLessThanOrEqual(1)
  })

  test('hovering a tile reveals its free / reserved / price in the detail card', async ({ page }) => {
    await page.goto(`/account/${FOX}?view=balances`)
    const tiles = page.locator('.tm-tile')
    await expect(tiles.first()).toBeVisible()

    // The detail card carries the full breakdown the tile face omits.
    const detail = page.locator('.tm-detail')
    await expect(detail).toContainText('Free')
    await expect(detail).toContainText('Reserved')
    await expect(detail).toContainText('Price')

    // Hovering a different asset tile retargets the card to that asset.
    const target = page.locator('.tm-tile:not(.tm-other)').nth(1)
    const sym = (await target.getAttribute('aria-label'))!.split(' — ')[0]
    await target.hover()
    await expect(page.locator('.tm-detail-sym')).toHaveText(sym)
  })
})

test.describe('balances treemap — mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('no horizontal overflow and tapping a tile opens its detail with a working asset link', async ({ page }) => {
    await page.goto(`/account/${FOX}?view=balances`)
    const tiles = page.locator('.tm-tile')
    await expect(tiles.first()).toBeVisible()

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, 'treemap must not widen the page at 390px').toBeLessThanOrEqual(0)

    // Tap an asset tile → the detail card targets it and exposes free/reserved.
    const target = page.locator('.tm-tile:not(.tm-other)').nth(1)
    const sym = (await target.getAttribute('aria-label'))!.split(' — ')[0]
    await target.click()
    const detail = page.locator('.tm-detail')
    await expect(page.locator('.tm-detail-sym')).toHaveText(sym)
    await expect(detail).toContainText('Free')
    await expect(detail).toContainText('Reserved')

    // The "View asset" link navigates to that asset's page.
    const link = page.locator('.tm-detail-link')
    await expect(link).toBeVisible()
    await link.click()
    await page.waitForURL(/\/asset\/\d+/)
  })
})
