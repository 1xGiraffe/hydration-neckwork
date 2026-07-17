import { expect, test } from './fixtures/test'

// Balances render as a value-weighted treemap (BalancesTreemap) on the account
// detail page, and the treemap doubles as the selector for the per-asset balance
// history. Tiles are sized by USD value, the biggest holding is the biggest tile,
// each face shows % above value, and clicking a tile focuses that asset — showing
// its value, amount and reserved lock, then its balance-history graph. Rows below
// the map cover assets without a market price and assets held only in the past.
const FOX = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'

async function area(el: import('@playwright/test').Locator): Promise<number> {
  const b = (await el.boundingBox())!
  return b.width * b.height
}

async function top(el: import('@playwright/test').Locator): Promise<number> {
  return (await el.boundingBox())!.y
}

test.describe('balances treemap — desktop', () => {
  test('sizes tiles by value, biggest holding biggest, with % above value on the face', async ({ page }) => {
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

    // The biggest tile shows value ($) and share (%) on its face, % above value.
    const face = tiles.first()
    const faceText = (await face.innerText()).replace(/\s+/g, ' ')
    expect(faceText).toMatch(/\$/)
    expect(faceText).toMatch(/%/)
    expect(await top(face.locator('.tm-pct')), '% sits above value').toBeLessThan(await top(face.locator('.tm-val')))

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

  test('previews on hover, locks on click, and the lock survives hovering elsewhere', async ({ page }) => {
    await page.goto(`/account/${FOX}?view=balances`)
    const tiles = page.locator('.tm-tile:not(.tm-other)')
    await expect(tiles.first()).toBeVisible()

    const detail = page.locator('.tm-detail')
    // The default focus (largest holding) shows only Value + Amount (+ a reserved
    // lock) with its history graph — the old Price / Share / Free / "View asset"
    // are gone.
    await expect(detail).toContainText('Value')
    await expect(detail).toContainText('Amount')
    await expect(detail).not.toContainText('Price')
    await expect(detail).not.toContainText('Share')
    await expect(page.locator('.tm-detail-link')).toHaveCount(0)
    // Mock holdings carry a reserved portion, so the lock icon is present and its
    // tooltip names the reserved amount.
    await expect(detail.locator('.tm-lock')).toBeVisible()
    await expect(detail.locator('.tm-lock')).toHaveAttribute('title', /Reserved/)
    // The focused asset's balance-history graph is docked in the same card.
    await expect(detail.locator('.tm-hist svg')).toBeVisible()

    const sym1 = (await tiles.nth(1).getAttribute('aria-label'))!.split(' — ')[0]
    const sym2 = (await tiles.nth(2).getAttribute('aria-label'))!.split(' — ')[0]

    // Nothing is locked yet, so hovering previews — the detail follows the pointer.
    await tiles.nth(1).hover()
    await expect(page.locator('.tm-detail-sym')).toHaveText(sym1)
    await tiles.nth(2).hover()
    await expect(page.locator('.tm-detail-sym')).toHaveText(sym2)

    // Clicking locks the focus (deep-links via ?asset=)…
    await tiles.nth(1).click()
    await expect(page).toHaveURL(/asset=\d+/)
    await expect(tiles.nth(1)).toHaveClass(/active/)
    await expect(page.locator('.tm-detail-sym')).toHaveText(sym1)

    // …and now hovering a different tile no longer changes the focus.
    await tiles.nth(2).hover()
    await expect(page.locator('.tm-detail-sym')).toHaveText(sym1)

    // Clicking the locked tile again unlocks it (clean URL); hover previews again.
    await tiles.nth(1).click()
    await expect(page).not.toHaveURL(/asset=/)
    await tiles.nth(2).hover()
    await expect(page.locator('.tm-detail-sym')).toHaveText(sym2)
  })

  test('switching assets clears a lingering balance-history tooltip', async ({ page }) => {
    await page.goto(`/account/${FOX}?view=balances`)
    const tiles = page.locator('.tm-tile:not(.tm-other)')
    await expect(page.locator('.tm-hist svg')).toBeVisible()

    // Lock an asset so hovering the chart can't change the previewed asset.
    await tiles.nth(1).click()
    // Hovering the chart shows a crosshair tooltip for the day under the pointer.
    await page.locator('.tm-hist .apx-wrap').hover()
    await expect(page.locator('.apx-tip')).toBeVisible()

    // Selecting another asset must clear that stale tooltip.
    await tiles.nth(2).click()
    await expect(page.locator('.apx-tip')).toHaveCount(0)
  })

  test('lists unpriced and historically held assets as selectable rows', async ({ page }) => {
    await page.goto(`/account/${FOX}?view=balances`)
    await expect(page.locator('.tm')).toBeVisible()

    const rows = page.locator('.tm-unpriced')
    await expect(rows).toContainText('without a market price')
    await expect(rows).toContainText('historically held')

    // Selecting the historically-held asset focuses it: no live amount, but its
    // history graph still renders.
    const past = page.locator('.tm-chip', { hasText: 'PAST' })
    await past.click()
    await expect(page).toHaveURL(/asset=313131/)
    await expect(page.locator('.tm-detail-sym')).toHaveText('PAST')
    await expect(page.locator('.tm-detail-note')).toContainText('Not currently held')
    await expect(page.locator('.tm-detail .tm-hist svg')).toBeVisible()

    // Selecting the unpriced holding shows its amount (no value) and, since it has
    // no indexed history, an explicit note instead of a chart.
    await page.locator('.tm-chip', { hasText: 'MYST' }).click()
    const detail = page.locator('.tm-detail')
    await expect(page.locator('.tm-detail-sym')).toHaveText('MYST')
    await expect(detail).toContainText('Amount')
    await expect(detail).not.toContainText('Value')
    await expect(detail).toContainText('No balance history indexed')
  })

  // The owl folds a long dust tail into an aggregated "Other" tile.
  test('hovering "Other" does not shift the section; it inspects on click', async ({ page }) => {
    const OWL = '1NPoMQbiA6trJKkjB35uk96MeJD4PGWkLQLH7k7hXEkZpiba'
    await page.goto(`/account/${OWL}?view=balances`)
    const other = page.locator('.tm-tile.tm-other')
    await expect(other).toBeVisible()

    const detail = page.locator('.tm-detail')
    // The default focus is an asset with a history graph; record its stable height.
    await expect(detail.locator('.tm-hist svg')).toBeVisible()
    const heightBefore = await detail.evaluate(el => (el as HTMLElement).offsetHeight)

    // Hovering "Other" must NOT swap in the shorter breakdown — no preview, so no
    // height change and no flicker as the pointer crosses the dust tile.
    await other.hover()
    await expect(page.locator('.tm-detail-sym')).not.toHaveText('Other holdings')
    const heightAfter = await detail.evaluate(el => (el as HTMLElement).offsetHeight)
    expect(heightAfter, 'section height stays put while hovering Other').toBe(heightBefore)

    // Clicking "Other" still opens its breakdown of dust assets.
    await other.click()
    await expect(page.locator('.tm-detail-sym')).toHaveText('Other holdings')

    // Selecting a dust asset (no indexed history) keeps the graph slot's height,
    // so the rows below don't jump.
    await detail.locator('.tm-chips-scroll .tm-chip').filter({ hasText: 'DUST' }).first().click()
    await expect(page.locator('.tm-detail-sym')).toHaveText(/^DUST\d+$/)
    await expect(page.locator('.tm-hist')).toContainText('No balance history indexed')
    const histH = await page.locator('.tm-hist').evaluate(el => (el as HTMLElement).offsetHeight)
    expect(histH, 'the history slot holds a stable height').toBe(243)
  })
})

test.describe('balances treemap — mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('no horizontal overflow and tapping a tile focuses it with value, amount and graph', async ({ page }) => {
    await page.goto(`/account/${FOX}?view=balances`)
    const tiles = page.locator('.tm-tile:not(.tm-other)')
    await expect(tiles.first()).toBeVisible()

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, 'treemap must not widen the page at 390px').toBeLessThanOrEqual(0)

    // Tap an asset tile → the detail card focuses it and shows value/amount + graph.
    const target = tiles.nth(1)
    const sym = (await target.getAttribute('aria-label'))!.split(' — ')[0]
    await target.click()
    const detail = page.locator('.tm-detail')
    await expect(page.locator('.tm-detail-sym')).toHaveText(sym)
    await expect(detail).toContainText('Value')
    await expect(detail).toContainText('Amount')
    await expect(detail.locator('.tm-hist svg')).toBeVisible()
  })
})
