import { expect, test } from './fixtures/test'

// Unfinalized (pending-head) rows: present in the live feeds ahead of
// finality, styled subtly (dimmed row, no extra column), honestly badged on
// detail pages. The fixture marks everything above stats.finalizedBlock
// (TIP − 2) as unfinalized.

test('blocks feed dims unfinalized rows and badges them Pending', async ({ page }) => {
  await page.goto('/blocks')
  const rows = page.locator('table.tbl tbody tr')
  await expect(rows.first()).toBeVisible()

  // The two newest blocks are above the finalized boundary.
  await expect(page.locator('table.tbl tbody tr.unfinalized')).toHaveCount(2)
  await expect(rows.nth(0).locator('.badge.pending')).toBeVisible()
  await expect(rows.nth(2).locator('.badge.finalized')).toBeVisible()
  // Subtle by design: no extra column appears for the marker.
  await expect(rows.nth(0).locator('td')).toHaveCount(await rows.nth(2).locator('td').count())
})

test('extrinsics and events feeds dim unfinalized rows', async ({ page }) => {
  await page.goto('/extrinsics')
  await expect(page.locator('table.tbl tbody tr.unfinalized').first()).toBeVisible()

  await page.goto('/events')
  await expect(page.locator('table.tbl tbody tr.unfinalized').first()).toBeVisible()
})

test('an unfinalized extrinsic detail page shows the Pending badge', async ({ page }) => {
  // TIP block extrinsic 0 — above the fixture's finalized boundary. The badge
  // sits in the detail card's Block row (other .badge.pending uses exist in
  // expandable rows below).
  await page.goto('/extrinsic/12848613-0')
  await expect(page.locator('.detail-card .badge.pending', { hasText: /^Pending$/ })).toBeVisible()

  // A deep, finalized extrinsic reads Finalized.
  await page.goto('/extrinsic/12848600-0')
  await expect(page.locator('.detail-card .badge.finalized')).toBeVisible()
})
