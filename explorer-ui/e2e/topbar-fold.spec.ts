import { expect, test } from './fixtures/test'

// Mid-width displays: the nav items squeeze the topbar search to its minimum.
// In that window the Assets and Revenue menus fold into one "Assets" dropdown so
// the search keeps a usable width. HDX and HOLLAR are never top-level links: they
// head the Assets menu at every width, the folded one and the drawer included.

test.describe('squeezed (1000px)', () => {
  test.use({ viewport: { width: 1000, height: 800 } })

  test('the asset sections fold under one dropdown and the search stays usable', async ({ page }) => {
    await page.goto('/activity')
    await expect(page.locator('.nav .nav-fold-group .nav-trigger')).toBeVisible()
    for (const label of ['Liquidity', 'HDX', 'HOLLAR']) {
      await expect(page.locator('.nav > a.nav-link', { hasText: label })).toHaveCount(0)
    }
    // the Revenue group yields to the fold too
    await expect(page.locator('.nav .nav-unfold-group', { hasText: 'Revenue' })).toBeHidden()

    await page.locator('.nav-fold-group .nav-trigger').hover()
    const menu = page.locator('.nav-fold-group .nav-menu')
    await expect(menu.locator('a').nth(0)).toHaveText('HDX')
    await expect(menu.locator('a').nth(1)).toHaveText('HOLLAR')
    for (const label of ['Liquidity', 'Volume', 'Oracles', 'Revenue', 'User Revenue', 'Protocol Revenue', 'Charts']) {
      await expect(menu.getByRole('link', { name: label, exact: label !== 'Charts' })).toBeVisible()
    }
    // the trigger IS the Assets link — no redundant "Assets" menu entry
    await expect(menu.getByRole('link', { name: 'Assets', exact: true })).toHaveCount(0)

    const search = (await page.locator('.topbar-search .search').boundingBox())!
    expect(search.width, 'search must keep usable width').toBeGreaterThan(170)
  })
})

for (const width of [1280, 1440, 1920]) {
  test.describe(`wide (${width}px)`, () => {
    test.use({ viewport: { width, height: 900 } })

    test('HDX and HOLLAR head the Assets menu, and Assets is lit on their pages', async ({ page }) => {
      await page.goto('/hdx')
      await expect(page.locator('.nav > a.nav-link', { hasText: /^(HDX|HOLLAR)$/ })).toHaveCount(0)
      const group = page.locator('.nav .nav-unfold-group', { hasText: 'Assets' })
      const trigger = group.locator('.nav-trigger')
      await expect(trigger).toHaveClass(/active/)
      await trigger.hover()
      const menu = group.locator('.nav-menu')
      await expect(menu.locator('a').nth(0)).toHaveText('HDX')
      await expect(menu.locator('a').nth(1)).toHaveText('HOLLAR')
      await expect(menu.getByRole('link', { name: 'HDX', exact: true })).toHaveClass(/active/)
      const search = (await page.locator('.topbar-search .search').boundingBox())!
      expect(search.width, 'the search takes the room the two links left').toBeGreaterThan(width >= 1440 ? 240 : 170)
    })
  })
}

test.describe('desktop (1440px)', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('the fold group is hidden', async ({ page }) => {
    await page.goto('/activity')
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

  test('Governance is the trigger itself: no Overview entry in its menu', async ({ page }) => {
    await page.goto('/governance')
    const group = page.locator('.nav .nav-wunfold-group', { hasText: 'Governance' })
    const trigger = group.locator('.nav-trigger')
    await expect(trigger).toHaveAttribute('href', '/governance')
    await expect(trigger).toHaveClass(/active/)
    await trigger.hover()
    const links = group.locator('.nav-menu a')
    await expect(links).toHaveCount(3)
    await expect(links).toContainText(['Referenda', 'Discussions', 'My governance'])
  })
})

test.describe('phone (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the drawer lists HDX and HOLLAR right after Assets', async ({ page }) => {
    await page.goto('/activity')
    await page.locator('.nav-burger').click()
    const labels = (await page.locator('.drawer-sec', { hasText: 'Explore' }).locator('a').allInnerTexts()).map(t => t.trim())
    const at = labels.indexOf('Assets')
    expect(labels.slice(at, at + 3)).toEqual(['Assets', 'HDX', 'HOLLAR'])
  })

  test('the drawer names the governance hub "Governance", not "Overview"', async ({ page }) => {
    await page.goto('/governance')
    await page.locator('.nav-burger').click()
    const links = page.locator('.drawer-sec', { has: page.locator('.sec-lbl', { hasText: /^Governance$/ }) }).locator('a')
    await expect(links).toHaveCount(4)
    await expect(links).toContainText(['Governance', 'Referenda', 'Discussions', 'My governance'])
    await expect(links.first()).toHaveAttribute('href', '/governance')
    await expect(links.first()).toHaveClass(/active/)
  })
})
