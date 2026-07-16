import { expect, test } from './fixtures/test'

// Every pagination must offer quick first/last jumps. Finite lists know their
// total (« ‹ 1…N › » + Go-to); account/tag activity tabs derive it from the
// tab-count badges — but only while unfiltered, since the counts describe the
// unfiltered feed. Fixture counts: extrinsics 1451 → 59 pages, events 26787 →
// 1072 pages, activity 2143 → 86 pages (PAGE = 25).
const ACCOUNT = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'

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

test('account events pager exposes its full page count', async ({ page }) => {
  await page.goto(`/account/${ACCOUNT}?view=activity&atab=events`)
  const pager = page.locator('.pager')
  await pager.getByRole('button', { name: 'Last page' }).click()
  await expect(pager.locator('.info')).toHaveText('Page 1,072 of 1,072')
})

test('filtering an account list drops the last-page jump (counts are unfiltered)', async ({ page }) => {
  await page.goto(`/account/${ACCOUNT}?view=activity&atab=extrinsics&call=transfer`)
  const pager = page.locator('.pager')
  await expect(pager.locator('.info')).toHaveText('Page 1')
  await expect(pager.getByRole('button', { name: 'Last page' })).toHaveCount(0)
})

test('account activity shows the full feed (no smol filter) with an exact last page', async ({ page }) => {
  await page.goto(`/account/${ACCOUNT}?view=activity`)
  const pager = page.locator('.pager')
  // Account Activity has no smol toggle — the unfiltered total applies directly.
  await expect(page.getByTitle(/click to show|click to hide/)).toHaveCount(0)
  await expect(pager.locator('.info')).toHaveText('Page 1 of 86')
  // an explicit "$ from" filter switches to the value-aware count (1600 rows ≥ $10)
  await page.getByRole('button', { name: /Filters/ }).click()
  await page.getByPlaceholder('$ from').fill('10')
  await expect(pager.locator('.info')).toHaveText('Page 1 of 64')
  await pager.getByRole('button', { name: 'Last page' }).click()
  await expect(pager.locator('.info')).toHaveText('Page 64 of 64')
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
