import { expect, test } from './fixtures/test'
import { compactAmount } from '../src/components/ui'
import { mockSync } from '../tests/fixtures/mockApi'
import type { AccountsPage } from '../src/types'

// A directory activity total is either exact or a FLOOR: a structural pot's feed runs
// deeper than the counter could reach, so its number means "at least this many" and is
// rendered with a trailing '+'. Two rules follow, and this spec pins both:
//
//   1. the '+' appears on exactly the partial totals, so the column never passes a floor
//      off as exact;
//   2. a floor ranks BELOW every exact total whatever the two numbers are — "at least
//      50,000" is not more than "exactly 2,143", so ordering it above one would assert
//      something the count never established.
//
// The fixture makes the floor the largest number in the column on purpose, so dropping
// the completeness term from the ordering moves this row from last to first.

const page0 = mockSync<AccountsPage>('/explorer/accounts?limit=50&offset=0&sort=activity')!
const cellText = (r: AccountsPage['rows'][number]): string =>
  compactAmount(r.activityCount!) + (r.activityCountComplete === false ? '+' : '')

const floors = page0.rows.filter(r => r.activityCountComplete === false)
const exact = page0.rows.filter(r => r.activityCountComplete === true)

// Pinned counts, because the coverage below is only real while the fixture keeps
// producing both kinds of total: with no partial row the '+' assertions match nothing
// and the ordering rule is vacuous, which is exactly how this went uncovered before.
test('the fixture states both completeness values, with the floor the largest number', () => {
  expect(floors).toHaveLength(1)
  expect(exact).toHaveLength(5)
  expect(page0.rows).toHaveLength(6)
  expect(floors[0].activityCount).toBe(Math.max(...page0.rows.map(r => r.activityCount ?? 0)))
})

test('a floor renders a trailing plus and every exact total renders none', async ({ page }) => {
  await page.goto('/accounts?sort=activity')

  const cells = page.locator('.accounts-tbl tbody tr td[data-label="Activity"]')
  await expect(cells).toHaveCount(page0.rows.length)

  const marked = page.locator('.accounts-tbl tbody tr td[data-label="Activity"]', { hasText: /\+$/ })
  await expect(marked).toHaveCount(floors.length)
  await expect(marked).toHaveText([cellText(floors[0])])
  // The bare number stays inside the mono span; only the marker is appended outside it,
  // so the floor still reads on the shared rough scale.
  await expect(marked.locator('span.mono')).toHaveText(compactAmount(floors[0].activityCount!))
})

test('the floor sorts after every exact total despite holding the largest count', async ({ page }) => {
  await page.goto('/accounts?sort=activity')

  const cells = page.locator('.accounts-tbl tbody tr td[data-label="Activity"]')
  await expect(cells).toHaveText(page0.rows.map(cellText))

  const texts = await cells.allTextContents()
  expect(texts).toHaveLength(6)
  // The one marked total is last, and the exact ones above it descend.
  expect(texts.filter(t => t.endsWith('+'))).toEqual(['50k+'])
  expect(texts).toEqual(['2.14k', '2.1k', '100', '100', '100', '50k+'])
})

test('the floor keeps its marker in the 390px card layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await page.goto('/accounts?sort=activity')

  const marked = page.locator('.accounts-tbl tbody tr td[data-label="Activity"]', { hasText: /\+$/ })
  await expect(marked).toHaveCount(1)
  await expect(marked).toHaveText([cellText(floors[0])])
  // The marker must not be what overflows the narrow card.
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('.accounts-tbl')
    return el ? el.scrollWidth - el.clientWidth : -1
  })
  expect(overflow).toBeLessThanOrEqual(0)
})
