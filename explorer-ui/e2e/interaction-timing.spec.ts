import { expect, test } from './fixtures/test'

test('free-form filters commit once after typing settles', async ({ page }) => {
  await page.goto('/extrinsics')
  await page.getByRole('button', { name: /Filters/ }).click()
  const input = page.getByPlaceholder('Call name')
  const historyBefore = await page.evaluate(() => history.length)

  await input.pressSequentially('tran', { delay: 50 })
  await expect(page).not.toHaveURL(/call=/)
  await expect(page).toHaveURL(/call=tran/)
  expect(await page.evaluate(() => history.length)).toBe(historyBefore + 1)
})

test('hover previews wait for deliberate pointer dwell', async ({ page }) => {
  await page.goto('/activity')
  const account = page.locator('tbody .addr-pill').first()
  await expect(account).toBeVisible()

  await account.hover()
  expect(await page.locator('.hovercard').count()).toBe(0)
  await expect(page.locator('.hovercard')).toBeVisible()
})
