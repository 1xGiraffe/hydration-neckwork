import { expect, test } from './fixtures/test'
import { mockSync } from '../tests/fixtures/mockApi'

// Every detail-page list pages against an exact row total for the filters it is
// showing, so « ‹ 1…N › » and the Go-to box always name real pages. Fixture lengths:
// activity 137 rows → 6 pages, extrinsics 1451 → 59, events 26787 → 1072 (PAGE = 25).
const ACCOUNT = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'
const PAGE = 25

// Read the fixture's own total for a filter, so these assertions stay pinned to the
// mocked FEED rather than to a number copied out of it.
function fixtureTotal(query: string): number {
  return mockSync<{ total: number }>(`/explorer/address/${ACCOUNT}/list-count?${query}`)!.total
}

test('account activity pages the whole feed and stops on its real last page', async ({ page }) => {
  await page.goto(`/account/${ACCOUNT}?view=activity`)
  const pager = page.locator('.pager')
  const total = fixtureTotal('tab=activity&type=all')
  const pages = Math.ceil(total / PAGE)

  await expect(pager.locator('.info')).toHaveText(`Page 1 of ${pages}`)
  // The Activity tab badge is that same total, so the badge and the pager agree.
  await expect(page.locator('.detail-tabs')).toContainText(String(total))

  await pager.getByRole('button', { name: 'Last page' }).click()
  await expect(pager.locator('.info')).toHaveText(`Page ${pages} of ${pages}`)
  await expect(page).toHaveURL(new RegExp(`apage=${pages - 1}`))
  // The last page holds the remainder and offers nothing after it.
  await expect(page.locator('.panel table.tbl tbody tr')).toHaveCount(total - (pages - 1) * PAGE)
  await expect(pager.getByRole('button', { name: 'Next page' })).toBeDisabled()
  await expect(pager.getByRole('button', { name: `Page ${pages + 1}` })).toHaveCount(0)

  await pager.getByRole('button', { name: 'First page' }).click()
  await expect(pager.locator('.info')).toHaveText(`Page 1 of ${pages}`)
})

test('filtering the activity list re-counts it, and its last page still holds rows', async ({ page }) => {
  await page.goto(`/account/${ACCOUNT}?view=activity`)
  const pager = page.locator('.pager')
  const all = Math.ceil(fixtureTotal('tab=activity&type=all') / PAGE)
  await expect(pager.locator('.info')).toHaveText(`Page 1 of ${all}`)

  const transferPages = Math.ceil(fixtureTotal('tab=activity&type=transfer') / PAGE)
  expect(transferPages, 'the fixture must make this filter change the total').toBeLessThan(all)
  await page.getByRole('button', { name: 'Transfer', exact: true }).click()
  await expect(pager.locator('.info')).toHaveText(`Page 1 of ${transferPages}`)
  await pager.getByRole('button', { name: 'Last page' }).click()
  await expect(pager.locator('.info')).toHaveText(`Page ${transferPages} of ${transferPages}`)
  await expect(page.locator('.panel table.tbl tbody tr').first()).toBeVisible()
})

test('a value filter re-counts the activity list too', async ({ page }) => {
  await page.goto(`/account/${ACCOUNT}?view=activity`)
  const pager = page.locator('.pager')
  const minPages = Math.ceil(fixtureTotal('tab=activity&type=all&min=1000') / PAGE)
  expect(minPages, 'the fixture must make a $-min change the total')
    .toBeLessThan(Math.ceil(fixtureTotal('tab=activity&type=all') / PAGE))

  await page.getByRole('button', { name: /Filters/ }).click()
  await page.getByPlaceholder('$ from').fill('1000')
  await expect(pager.locator('.info')).toHaveText(`Page 1 of ${minPages}`)
  await pager.getByRole('button', { name: 'Last page' }).click()
  await expect(pager.locator('.info')).toHaveText(`Page ${minPages} of ${minPages}`)
})

test('account extrinsics pager jumps straight to the last and first page', async ({ page }) => {
  await page.goto(`/account/${ACCOUNT}?view=activity&atab=extrinsics`)
  const pager = page.locator('.pager')
  await expect(pager.locator('.info')).toHaveText('Page 1 of 59')
  await pager.getByRole('button', { name: 'Last page' }).click()
  await expect(pager.locator('.info')).toHaveText('Page 59 of 59')
  await expect(page).toHaveURL(/apage=58/)
  await pager.getByRole('button', { name: 'First page' }).click()
  await expect(pager.locator('.info')).toHaveText('Page 1 of 59')
})

test('filtering an account list keeps a real last-page jump', async ({ page }) => {
  await page.goto(`/account/${ACCOUNT}?view=activity&atab=extrinsics&call=transfer`)
  const pager = page.locator('.pager')
  // 87 of the fixture's 1451 extrinsics match — the filtered total, not the whole one.
  await expect(pager.locator('.info')).toHaveText('Page 1 of 4')
  await pager.getByRole('button', { name: 'Last page' }).click()
  await expect(pager.locator('.info')).toHaveText('Page 4 of 4')
})

test('account events pager exposes its full page count', async ({ page }) => {
  await page.goto(`/account/${ACCOUNT}?view=activity&atab=events`)
  const pager = page.locator('.pager')
  await pager.getByRole('button', { name: 'Last page' }).click()
  await expect(pager.locator('.info')).toHaveText('Page 1,072 of 1,072')
})

test('a page past the end names its position instead of claiming "of" a smaller total', async ({ page }) => {
  const pages = Math.ceil(fixtureTotal('tab=activity&type=all') / PAGE)
  await page.goto(`/account/${ACCOUNT}?view=activity&apage=${pages + 14}`)
  const pager = page.locator('.pager')

  await expect(pager.locator('.info')).toHaveText(`Page ${pages + 15} · past the last page (${pages})`)
  // Only pages that exist are offered, and the way back is one click.
  await expect(pager.getByRole('button', { name: `Page ${pages + 1}` })).toHaveCount(0)
  await pager.getByRole('button', { name: 'Last page' }).click()
  await expect(pager.locator('.info')).toHaveText(`Page ${pages} of ${pages}`)
})

// The chain-wide Activity feed. Its pager used to know nothing: no total, no bound,
// and a › arrow that meant "this page came back full", so it offered pages the API
// refuses — the reported /activity?tab=vote&page=490 among them.
test('the global activity feed pages the vote category against its real total', async ({ page }) => {
  const total = mockSync<{ total: number }>('/explorer/activity/count?type=vote')!.total
  const pages = Math.ceil(total / PAGE)
  await page.goto('/activity?tab=vote')
  const pager = page.locator('.pager')

  await expect(pager.locator('.info')).toHaveText(`Page 1 of ${pages.toLocaleString('en-US')}`)
  await pager.getByRole('button', { name: 'Last page' }).click()
  await expect(pager.locator('.info')).toHaveText(`Page ${pages.toLocaleString('en-US')} of ${pages.toLocaleString('en-US')}`)
  await expect(pager.getByRole('button', { name: 'Next page' })).toBeDisabled()
  await expect(pager.getByRole('button', { name: `Page ${pages + 1}` })).toHaveCount(0)
})

test('a deep-linked activity page past the end names its position and offers the way back', async ({ page }) => {
  const total = mockSync<{ total: number }>('/explorer/activity/count?type=vote')!.total
  const pages = Math.ceil(total / PAGE)
  await page.goto('/activity?tab=vote&page=490')
  const pager = page.locator('.pager')

  await expect(pager.locator('.info')).toHaveText(`Page 491 · past the last page (${pages.toLocaleString('en-US')})`)
  await expect(pager.getByRole('button', { name: 'Page 491' })).toHaveCount(0)
  await pager.getByRole('button', { name: 'Last page' }).click()
  await expect(pager.locator('.info')).toHaveText(`Page ${pages.toLocaleString('en-US')} of ${pages.toLocaleString('en-US')}`)
})

test('an uncounted activity category stops at the depth the API serves', async ({ page }) => {
  const { maxOffset } = mockSync<{ maxOffset: number }>('/explorer/activity/count?type=all')!
  const deepest = Math.floor(maxOffset / PAGE)
  await page.goto(`/activity?page=${deepest}`)
  const pager = page.locator('.pager')

  // No "of M": the merged feed cannot be counted, so no page number is claimed. The
  // arrow still stops here — one page further is the offset the route rejects.
  await expect(pager.locator('.info')).toHaveText(`Page ${(deepest + 1).toLocaleString('en-US')} · as deep as this list pages — narrow the date range for older rows`)
  await expect(pager.getByRole('button', { name: 'Next page' })).toBeDisabled()
})

test('tag activity pagers know their totals', async ({ page }) => {
  await page.goto('/tag/kraken?view=activity&atab=events')
  const pager = page.locator('.pager')
  await pager.getByRole('button', { name: 'Last page' }).click()
  await expect(pager.locator('.info')).toHaveText('Page 1,072 of 1,072')
})

test('pager keeps one compact row on mobile at huge page numbers', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 })
  await page.goto(`/account/${ACCOUNT}?view=activity&atab=events&apage=1071`)
  const btns = page.locator('.pager .btns')
  await expect(btns.locator('button.on')).toBeVisible()
  // Phones collapse the page window to the current page so every control stays
  // on one line even for four-digit page numbers.
  const box = await btns.boundingBox()
  expect(box!.height, 'pager controls must not wrap into multiple rows').toBeLessThan(40)
  await expect(btns.locator('button[aria-label="First page"]')).toBeVisible()
  await expect(btns.locator('button[aria-label="Last page"]')).toBeVisible()
  await expect(btns.locator('.pager-jump')).toBeVisible()
})
