import { expect, test } from './fixtures/test'

test('trade detail renders asset chips for route, fees, price, and execution values', async ({ page }) => {
  await page.goto('/swap/12848613-4')

  await expect(page.getByText('Swap 12848613-4')).toBeVisible()
  await expect(page.getByText('(1:1)')).toHaveCount(0)

  const routeTable = page.locator('table.tbl').filter({ hasText: 'Pool fee' })
  const aaveRow = routeTable.locator('tbody tr').filter({ hasText: 'Aave' })
  await expect(aaveRow.locator('[data-label="In"] .asset-chip')).toContainText('USDT')
  await expect(aaveRow.locator('[data-label="Out"] .asset-chip')).toContainText('aUSDT')
  await expect(aaveRow.locator('[data-label="In"]')).toContainText('USDT')
  await expect(aaveRow.locator('[data-label="Out"]')).toContainText('aUSDT')

  const poolFee = routeTable.locator('tbody tr').filter({ hasText: 'Omnipool' }).locator('[data-label="Pool fee"]')
  await expect(poolFee.locator('.asset-chip')).toContainText('DOT')
  await expect(poolFee.locator('.mono')).not.toHaveText('—')

  const details = page.locator('.detail-card').first()
  const detailsValue = (label: string | RegExp) => details.locator('.dt', { hasText: label }).locator('xpath=following-sibling::*[1]')
  const executionPrice = detailsValue('Execution price')
  await expect(executionPrice.locator('.asset-chip')).toHaveCount(2)
  await expect(executionPrice).toContainText('USDT')
  await expect(executionPrice).toContainText('DOT')

  const fee = detailsValue(/^Fee$/)
  await expect(fee.locator('.asset-chip')).toContainText('HDX')
  await expect(fee.locator('.mono')).not.toHaveText('—')

  const execution = page.locator('.detail-card').filter({ hasText: 'Min received (limit)' })
  const executionValue = (label: string | RegExp) => execution.locator('.dt', { hasText: label }).locator('xpath=following-sibling::*[1]')
  await expect(executionValue(/^Min received \(limit\)$/).locator('.asset-chip')).toContainText('DOT')
  await expect(executionValue(/^Received$/).locator('.asset-chip')).toContainText('DOT')

  await aaveRow.locator('[data-label="In"] .asset-chip').hover()
  await expect(page.locator('.hovercard')).toContainText('USDT')
  await expect(page.locator('.hovercard')).toContainText('Tether USD')
})

test('event-backed trade rows hover and navigate to the trade detail page', async ({ page }) => {
  await page.goto('/activity?tab=trade')

  const row = page.locator('tr[data-activity$="-e77"]').first()
  await expect(row).toBeVisible()
  await expect(row).not.toHaveAttribute('data-ext', /.+/)

  const activity = await row.getAttribute('data-activity')
  expect(activity).toMatch(/^swap\/\d+-e77$/)
  const tradeId = activity!.replace(/^swap\//, '')
  await expect(row.locator('td[data-label="Type"]')).toContainText('Swap')
  await expect(page.locator('td[data-label="Type"]', { hasText: 'DCA' }).first()).toBeVisible()

  // Hover the Type badge specifically, not the row's bounding-box center: the
  // Activity column's auto-computed width shifts with whatever else is on the
  // page (e.g. otc rows folded into this same tab), which can otherwise land
  // the row's center on a nested asset-chip and open ITS hovercard instead.
  await row.locator('td[data-label="Type"]').hover()
  await expect(page.locator('.hovercard')).toContainText('Trade')
  await expect(page.locator('.hovercard')).toContainText(tradeId!)
  await expect(page.locator('.hovercard')).toContainText('via Router')

  await row.locator('td[data-label="Type"]').click()
  await expect(page).toHaveURL(new RegExp(`/swap/${tradeId}$`))
  await expect(page.getByText(`Swap ${tradeId}`)).toBeVisible()
  await expect(page.locator('.detail-card').first()).toContainText('Event')
  await expect(page.locator('.detail-card').first()).not.toContainText('Extrinsic')
})
