import { expect, test } from './fixtures/test'

// The contracts directory (Chain → Contracts): registry rows with honest
// creation labels, the shared sort affordances (headers on desktop, a native
// select on phones), and row navigation to the contract's account page.

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('lists registry contracts with creation evidence and navigates to the account page', async ({ page }) => {
    await page.goto('/contracts')
    await expect(page.locator('.page-title')).toContainText('Contracts')
    const rows = page.locator('.contracts-tbl tbody tr')
    await expect(rows).toHaveCount(4)
    // Factory child is labelled "first seen", never "created"; destroyed stays listed.
    await expect(page.locator('.contracts-tbl')).toContainText('first seen')
    await expect(page.locator('.contracts-tbl .badge', { hasText: 'destroyed' })).toBeVisible()
    // Sorting by txs drives the server sort via the query string.
    await page.locator('.th-sort', { hasText: 'Txs' }).click()
    await expect(page).toHaveURL(/sort=txs/)
    // Row click (not on the pill link) opens the contract's account page.
    await page.locator('.contracts-tbl tbody tr').first().click({ position: { x: 600, y: 10 } })
    await expect(page).toHaveURL(/\/account\/0x/)
  })

  test('the Chain nav group reaches the directory', async ({ page }) => {
    await page.goto('/blocks')
    await page.locator('.nav-group', { hasText: 'Chain' }).first().hover()
    await page.getByRole('link', { name: 'Contracts' }).first().click()
    await expect(page).toHaveURL(/\/contracts$/)
  })
})

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('offers the sorts as a native select and keeps the layout unbroken', async ({ page }) => {
    await page.goto('/contracts')
    const select = page.locator('.mobile-sort select')
    await expect(select).toBeVisible()
    await select.selectOption('txs')
    await expect(page).toHaveURL(/sort=txs/)
    // No horizontal page overflow at 390px (the table scrolls inside its panel).
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })

  // Every card line ends its value at the card's right edge. The desktop column
  // caps must not leak in and stop a cell short of it.
  test('right-aligns each card line to the same edge', async ({ page }) => {
    await page.goto('/contracts')
    const edges = await page.locator('.contracts-tbl tbody tr').first().evaluate(row => {
      const right = (label: string) => Math.round(row.querySelector(`td[data-label="${label}"]`)!.getBoundingClientRect().right)
      return { created: right('Created'), deployer: right('Deployer'), lastActive: right('Last active') }
    })
    expect(edges.created).toBe(edges.lastActive)
    expect(edges.deployer).toBe(edges.lastActive)
  })
})
