import { expect, test } from './fixtures/test'
import { compactAmount } from '../src/components/ui'
import { mockSync } from '../tests/fixtures/mockApi'
import type { AccountsPage } from '../src/types'

// The directory's Activity column is a rounded display number, so it reads on the
// explorer-wide rough scale (compactAmount) like every other rounded figure —
// never a locally invented compaction.

const page0 = mockSync<AccountsPage>('/explorer/accounts?limit=50&offset=0&sort=activity')!
const counts = page0.rows.map(r => r.activityCount).filter((n): n is number => n != null)

test('the activity column renders on the shared rough scale', async ({ page }) => {
  await page.goto('/accounts?sort=activity')

  const cells = page.locator('.accounts-tbl tbody tr td[data-label="Activity"]')
  await expect(cells).toHaveCount(page0.rows.length)
  expect(counts).toHaveLength(6)

  await expect(cells).toHaveText(counts.map(n => compactAmount(n)))
  // 2143 reads "2.14k", not the raw "2,143" a hand-rolled compaction fell back to.
  await expect(cells.first()).toHaveText('2.14k')
  await expect(cells.nth(1)).toHaveText('2.1k')
})
