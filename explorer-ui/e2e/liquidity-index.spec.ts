import { expect, test } from './fixtures/test'

// /liquidity ranks every venue by what it holds. A pool is a mixture, so each
// row draws its own composition — that is the page's reason to exist over a
// column of numbers — and most pools hold nothing, so the tail folds behind one
// line rather than burying the twenty that matter.

test('lists every pool that holds something, largest first', async ({ page }) => {
  await page.goto('/liquidity')
  const rows = page.locator('table.liq-tbl tbody tr')
  await expect(rows.first()).toBeVisible()

  const tvls = await rows.locator('td[data-label="TVL"]').allInnerTexts()
  const nums = tvls.map(t => {
    const m = /\$([\d.]+)([kM]?)/.exec(t.trim())
    return m ? Number(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'k' ? 1e3 : 1) : 0
  })
  expect(nums.length).toBeGreaterThan(1)
  for (let i = 1; i < nums.length; i++) expect(nums[i]).toBeLessThanOrEqual(nums[i - 1])
})

test('each row draws the pool it is, not just what it is worth', async ({ page }) => {
  await page.goto('/liquidity')
  const first = page.locator('table.liq-tbl tbody tr').first()

  // A composition of more than one asset is more than one segment, and the
  // segments are described for a reader who cannot see them.
  const bar = first.locator('.comp-bar')
  await expect(bar).toBeVisible()
  expect(await bar.locator('.comp-seg').count()).toBeGreaterThan(1)
  await expect(bar).toHaveAttribute('aria-label', /%/)
})

test('the long tail is named and unfolds in place', async ({ page }) => {
  await page.goto('/liquidity')
  const rows = page.locator('table.liq-tbl tbody tr')
  await expect(rows.first()).toBeVisible()      // count the loaded table, not the skeleton
  const before = await rows.count()
  const dust = page.locator('.liq-dust')

  // It says what is folded rather than simply hiding it.
  await expect(dust).toContainText(/\d+ pools hold/)
  await dust.getByRole('button', { name: 'show them' }).click()
  expect(await page.locator('table.liq-tbl tbody tr').count()).toBeGreaterThan(before)
  await dust.getByRole('button', { name: 'hide them' }).click()
  expect(await page.locator('table.liq-tbl tbody tr').count()).toBe(before)
})

test('a row opens the pool it names', async ({ page }) => {
  await page.goto('/liquidity')
  await page.locator('table.liq-tbl tbody tr', { hasText: 'Omnipool' }).first().click()
  await expect(page).toHaveURL(/\/omnipool$/)
})

test('reaches /liquidity from the nav, and the nav says where you are', async ({ page }) => {
  await page.goto('/assets')
  await page.getByRole('navigation').getByRole('link', { name: 'Liquidity' }).click()
  await expect(page).toHaveURL(/\/liquidity$/)
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Liquidity' })).toHaveClass(/on|active/)
})

test('no horizontal overflow at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/liquidity')
  await expect(page.locator('table.liq-tbl tbody tr').first()).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
