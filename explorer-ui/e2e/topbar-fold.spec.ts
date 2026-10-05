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
    for (const label of ['Liquidity', 'HDX', 'HOLLAR']) {
      await expect(page.locator('.nav > a.nav-link', { hasText: label })).toBeHidden()
    }
    // the Revenue group yields to the fold too
    await expect(page.locator('.nav .nav-unfold-group', { hasText: 'Revenue' })).toBeHidden()

    await page.locator('.nav-fold-group .nav-trigger').hover()
    const menu = page.locator('.nav-fold-group .nav-menu')
    for (const label of ['Liquidity', 'Volume', 'Oracles', 'HDX', 'HOLLAR', 'Revenue', 'User Revenue', 'Protocol Revenue', 'Charts']) {
      await expect(menu.getByRole('link', { name: label, exact: label !== 'Charts' })).toBeVisible()
    }
    // the trigger IS the Assets link — no redundant "Assets" menu entry
    await expect(menu.locator('a')).toHaveCount(9)

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

  test('Revenue is a menu: the trigger reaches the overview, the menu the two breakdowns', async ({ page }) => {
    await page.goto('/revenue/users')
    const group = page.locator('.nav .nav-unfold-group', { hasText: 'Revenue' })
    const trigger = group.locator('.nav-trigger')
    await expect(trigger).toHaveAttribute('href', '/revenue')
    await expect(trigger).toHaveClass(/active/)
    await trigger.hover()
    const menu = group.locator('.nav-menu')
    await expect(menu.locator('a')).toHaveText(['User Revenue', 'Protocol Revenue'])
    await expect(menu.getByRole('link', { name: 'User Revenue' })).toHaveClass(/active/)
    await expect(menu.getByRole('link', { name: 'Protocol Revenue' })).not.toHaveClass(/active/)
    await menu.getByRole('link', { name: 'Protocol Revenue' }).click()
    await expect(page).toHaveURL(/\/revenue\/protocol$/)
    await expect(trigger).toHaveClass(/active/)
  })
})
