import { expect, test } from './fixtures/test'

// Conviction is what turns an amount into voting power, so it has to be legible
// wherever a vote is: in the list at any width, and on the vote's own page.
// It was always rendered — as the runtime's own enum (`Locked6x`, and `None`
// for the no-lock vote), unlabelled — which reads as neither a conviction nor,
// for `None`, as a value at all, and was reported as not being shown.

test('the vote list states conviction as a multiplier', async ({ page }) => {
  await page.goto('/activity?tab=vote&smol=show')
  const cells = page.locator('table.tbl tbody tr td[data-label="Activity"]')
  await expect(cells.first()).toBeVisible()

  await expect(page.locator('.conviction-tag').first()).toHaveText(/^\d+(\.\d+)?x$/)
  // The runtime's spelling never reaches a reader, and the no-lock vote shows
  // the 0.1x it actually carries rather than the word None.
  await expect(page.locator('table.tbl tbody')).not.toContainText('Locked')
  await expect(page.locator('.conviction-tag', { hasText: '0.1x' }).first()).toBeVisible()
})

test('conviction survives the mobile layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/activity?tab=vote&smol=show')
  const tag = page.locator('.conviction-tag').first()
  await expect(tag).toBeVisible()
  // Visible means on screen, not merely in the DOM: the card layout stacks the
  // activity cell, and a tag pushed outside its own cell would read as absent.
  const cell = page.locator('table.tbl tbody tr td[data-label="Activity"]').first()
  const [t, c] = [await tag.boundingBox(), await cell.boundingBox()]
  expect(t!.width).toBeGreaterThan(0)
  expect(t!.right ?? t!.x + t!.width).toBeLessThanOrEqual(c!.x + c!.width + 1)
})

test('a vote detail page carries the conviction in its own labelled row', async ({ page }) => {
  await page.goto('/activity?tab=vote&smol=show')
  // Open the row by its own target rather than clicking it: a vote row carries
  // a link to the referendum, and clicking the row body would follow that.
  const target = await page.locator('table.tbl tbody tr[data-activity]').first().getAttribute('data-activity')
  await page.goto('/' + target)
  await expect(page).toHaveURL(/\/vote\//)

  // A subtitle is scenery; the labelled rows are where a reader looks for a fact.
  const card = page.locator('.detail-card')
  await expect(card).toContainText('Vote')
  await expect(card.locator('.conviction-tag')).toHaveText(/^\d+(\.\d+)?x$/)
  await expect(card.locator('.pill-badge', { hasText: /^(AYE|NAY)$/ })).toBeVisible()
})
