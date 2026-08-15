import { expect, test } from './fixtures/test'

// Mid-width displays: the nav items squeeze the topbar search to its minimum.
// In that window Assets/Liquidity/HDX/HOLLAR fold into one "Assets" dropdown so
// the search keeps a usable width — Liquidity joined the fold when it joined the
// nav, which is what the mechanism is for. Desktop and the mobile drawer are
// unchanged.

test.describe('squeezed (1000px)', () => {
  test.use({ viewport: { width: 1000, height: 800 } })

  test('the asset sections fold under one dropdown and the search stays usable', async ({ page }) => {
    await page.goto('/activity')
    await expect(page.locator('.nav .nav-fold-group .nav-trigger')).toBeVisible()
    for (const label of ['Liquidity', 'HDX', 'HOLLAR', 'Revenue']) {
      await expect(page.locator('.nav > a.nav-link', { hasText: label })).toBeHidden()
    }

    await page.locator('.nav-fold-group .nav-trigger').hover()
    const menu = page.locator('.nav-fold-group .nav-menu')
    for (const label of ['Liquidity', 'HDX', 'HOLLAR', 'Revenue']) {
      await expect(menu.locator('a', { hasText: label })).toBeVisible()
    }
    // the trigger IS the Assets link — no redundant "Assets" menu entry
    await expect(menu.locator('a')).toHaveCount(4)

    const search = (await page.locator('.topbar-search .search').boundingBox())!
    expect(search.width, 'search must keep usable width').toBeGreaterThan(170)
  })
})

test.describe('desktop (1440px)', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('direct links stay, the fold group is hidden', async ({ page }) => {
    await page.goto('/activity')
    await expect(page.locator('.nav > a.nav-link', { hasText: 'HDX' })).toBeVisible()
    await expect(page.locator('.nav > a.nav-link', { hasText: 'HOLLAR' })).toBeVisible()
    await expect(page.locator('.nav .nav-fold-group')).toBeHidden()
  })
})
