import { expect, test } from './fixtures/test'
import { MOCK_MEMPOOL_HASH } from '../tests/fixtures/mockApi'

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

test('the activity feed dims unfinalized rows and keeps them non-navigable', async ({ page }) => {
  await page.goto('/activity')
  const pendingRow = page.locator('table.tbl tbody tr.unfinalized').first()
  await expect(pendingRow).toBeVisible()
  // No detail page exists until the finalized classifier runs.
  await expect(pendingRow).not.toHaveClass(/clickable/)
  await expect(pendingRow).not.toHaveAttribute('data-activity', /.+/)
})

// The smol toggle round-trips through the URL: toggling writes ?smol=…, and a
// deep link with it set overrides the visitor's stored preference.
test('the smol toggle is URL-addressable', async ({ page }) => {
  await page.goto('/activity')
  const toggle = page.locator('.smol-toggle')
  await expect(toggle).toHaveClass(/hiding/)   // hidden by default

  await toggle.click()
  await expect(page).toHaveURL(/[?&]smol=show/)
  await expect(toggle).not.toHaveClass(/hiding/)

  // Hiding is the default, so toggling back just removes the param.
  await toggle.click()
  await expect(page).not.toHaveURL(/smol=/)
  await expect(toggle).toHaveClass(/hiding/)

  // Deep link wins over the (now 'hide') stored preference.
  await page.goto('/activity?smol=show')
  await expect(toggle).not.toHaveClass(/hiding/)
  // And it rides along when switching category chips.
  await page.locator('.activity-chip', { hasText: 'Transfer' }).click()
  await expect(page).toHaveURL(/smol=show/)
})

// Mempool (transaction-pool) rows: dry-run projections of transactions no
// block holds yet — the opposite treatment of unfinalized: highlighted, not
// dimmed, marked by the pulsing pool chip, addressed by hash alone.

test('the activity feed leads with a highlighted mempool row', async ({ page }) => {
  await page.goto('/activity')
  const poolRow = page.locator('table.tbl tbody tr.mempool').first()
  await expect(poolRow).toBeVisible()
  await expect(poolRow.locator('.pool-chip')).toBeVisible()
  // A projection has no detail page target — non-navigable like unfinalized...
  await expect(poolRow).not.toHaveClass(/clickable/)
  await expect(poolRow).not.toHaveAttribute('data-activity', /.+/)
  // ...but it stands OUT rather than receding: not the dimmed treatment.
  await expect(poolRow).not.toHaveClass(/unfinalized/)
  // The left edge runs the in-memory pixel march for as long as the row lives,
  // rather than the one-shot line a newly arrived finalized row fades out.
  const edgeAnimation = await poolRow.locator('td').first().evaluate(el => getComputedStyle(el).animationName)
  expect(edgeAnimation).toContain('poolBits')
})

test('a pool row states how long it has waited, not how long ago it happened', async ({ page }) => {
  await page.goto('/activity')
  const poolRow = page.locator('table.tbl tbody tr.mempool').first()
  await expect(poolRow.locator('td[data-label="Time"]')).toContainText(/waiting \d/)
  // Its neighbours, which have a block time, keep the "ago" phrasing — the two
  // clocks measure different things and must not look like the same one.
  await expect(page.locator('table.tbl tbody tr:not(.mempool) td[data-label="Time"]').first()).toContainText('ago')
})

test('the extrinsics feed lists the pool transaction by hash', async ({ page }) => {
  await page.goto('/extrinsics')
  const poolRow = page.locator('table.tbl tbody tr.mempool').first()
  await expect(poolRow).toBeVisible()
  // No block to link — the pool chip stands where the block number would be,
  // and the id link carries the hash (the only identity the transaction has).
  await expect(poolRow.locator('td[data-label="Block"] .pool-chip')).toBeVisible()
  await expect(poolRow.locator('td[data-label="Extrinsic"] a')).toHaveAttribute('href', new RegExp(MOCK_MEMPOOL_HASH))
})

test('the events feed lists the projected events of a pool transaction', async ({ page }) => {
  await page.goto('/events')
  const poolRow = page.locator('table.tbl tbody tr.mempool').first()
  await expect(poolRow).toBeVisible()
  await expect(poolRow.locator('td[data-label="Block"] .pool-chip')).toBeVisible()
  // A projected event has no event page of its own — it belongs to the pool
  // transaction, which its Extrinsic cell links to by hash.
  await expect(poolRow.locator('td[data-label="ID"] a')).toHaveCount(0)
  await expect(poolRow.locator('td[data-label="Extrinsic"] a')).toHaveAttribute('href', new RegExp(MOCK_MEMPOOL_HASH))
})

test('a pool transaction detail page shows the projection state and keeps its hash URL', async ({ page }) => {
  await page.goto(`/extrinsic/${MOCK_MEMPOOL_HASH}`)
  await expect(page.locator('.detail-card .pool-chip')).toBeVisible()
  await expect(page.locator('.detail-card')).toContainText('not yet in a block')
  // The result is a projection, not an outcome: a dashed badge saying what
  // WOULD happen, never the plain tick a settled extrinsic wears.
  await expect(page.locator('.detail-card .badge.projected')).toContainText('Would succeed')
  await expect(page.locator('.detail-card .badge.ok:not(.projected)')).toHaveCount(0)
  // The 0-0 placeholders are not an address: no canonical-id redirect.
  await expect(page).toHaveURL(new RegExp(MOCK_MEMPOOL_HASH))
  await expect(page.locator('.tabs button', { hasText: 'Projected events' })).toBeVisible()
})
