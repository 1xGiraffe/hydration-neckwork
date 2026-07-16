import { expect, test } from './fixtures/test'

// A DCA is a schedule, not a single fill: activity rows link to /dca/<scheduleId>,
// which shows how the schedule was initiated and every execution so far.

test('activity DCA rows navigate to the schedule page', async ({ page }) => {
  await page.goto('/activity?tab=trade')
  const dcaRow = page.locator('tr[data-activity^="dca/"]').first()
  await expect(dcaRow).toBeVisible()
  expect(await dcaRow.getAttribute('data-activity')).toMatch(/^dca\/\d+$/)
  // click the Type cell — the row centre lands on the asset chip's own link
  await dcaRow.locator('td').first().click()
  await expect(page).toHaveURL(/\/dca\/\d+$/)
  await expect(page.getByText('Initiated')).toBeVisible()
})

test('schedule page shows initiation, budget, totals and paged executions', async ({ page }) => {
  await page.goto('/dca/33546')
  await expect(page.locator('.page-title')).toContainText('DCA #33546')
  const card = page.locator('.detail-card').first()
  await expect(card).toContainText('Owner')
  await expect(card).toContainText('every 300 blocks')
  await expect(card).toContainText('132 trades')
  await expect(page.locator('.tbl tbody tr')).toHaveCount(25)
  await expect(page.locator('.pager')).toBeVisible()
})

test('cancelled schedule includes failed attempts in its execution timeline', async ({ page }) => {
  await page.goto('/dca/33573')
  await expect(page.locator('.page-title')).toContainText('cancelled')
  await expect(page.locator('.detail-card').first()).toContainText('2 failed attempts')
  await expect(page.locator('.tbl tbody tr')).toHaveCount(2)
  await expect(page.getByText('DCA failed')).toHaveCount(2)
  await expect(page.getByText('Failed attempt', { exact: true })).toHaveCount(2)
})

test('legacy per-execution DCA links resolve to the schedule page', async ({ page }) => {
  await page.goto('/dca/12848613-4')
  await expect(page).toHaveURL(/\/dca\/33546$/)
  await expect(page.locator('.page-title')).toContainText('DCA #33546')

  await page.goto('/dca/12848613-e77')
  await expect(page).toHaveURL(/\/dca\/33546$/)
})

test('active-DCA rows show the budget and open the schedule page', async ({ page }) => {
  await page.goto('/account/1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr?view=positions')
  const row = page.locator('tr[data-dca-schedule="33546"]')
  await expect(row).toBeVisible()
  await expect(row.locator('[data-label="Budget"]')).toContainText('1.2M')
  // open-ended schedules say so instead of a number
  await expect(page.locator('tr[data-dca-schedule="30104"] [data-label="Budget"]')).toContainText('open-ended')
  // the next-execution block links to the (future) block page with a countdown
  await row.locator('[data-label="Next exec."] a').click()
  await expect(page).toHaveURL(/\/block\/\d+$/)
  await expect(page.getByText('Future block')).toBeVisible()

  await page.goBack()
  await page.locator('tr[data-dca-schedule="33546"] [data-label="Filled"]').click()
  await expect(page).toHaveURL(/\/dca\/33546$/)
  await expect(page.getByText('Initiated')).toBeVisible()
})
