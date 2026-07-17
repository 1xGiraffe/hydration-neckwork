import { expect, test } from './fixtures/test'

const ACCOUNT = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'

test('account detail activity tabs expose the same filters as the global lists', async ({ page }) => {
  await page.goto(`/account/${ACCOUNT}?view=activity`)

  await expect(page.getByRole('button', { name: /^Activity/ }).first()).toHaveClass(/active/)
  await page.getByRole('button', { name: 'Trade' }).click()
  await page.getByRole('button', { name: /Filters/ }).click()

  await expect(page.locator('.filters select')).toContainText('DCA')
  await expect(page.getByPlaceholder('All tokens')).toBeVisible()
  await expect(page.locator('.filters input[type="date"]')).toHaveCount(2)

  await page.locator('.filters select').selectOption('dca')
  await page.getByPlaceholder('$ from').fill('100')
  await expect(page).toHaveURL(/type=trade/)
  await expect(page).toHaveURL(/action=dca/)
  await expect(page).toHaveURL(/min=100/)

  await page.getByRole('button', { name: /Extrinsics/ }).click()
  await expect(page.locator('.filter-toggle .fb')).toHaveCount(0)
  await page.getByRole('button', { name: /Filters/ }).click()
  await expect(page.getByPlaceholder('Call name')).toBeVisible()
  await expect(page.locator('.filters select')).toContainText('Failed')
  await expect(page.locator('.filters input[type="date"]')).toHaveCount(2)
  await page.getByPlaceholder('Call name').fill('transfer')
  await page.locator('.filters select').selectOption('failed')
  await expect(page).toHaveURL(/atab=extrinsics/)
  await expect(page).toHaveURL(/call=transfer/)
  await expect(page).toHaveURL(/result=failed/)

  await page.getByRole('button', { name: /Events/ }).click()
  await expect(page.locator('.filter-toggle .fb')).toHaveCount(0)
  await page.getByRole('button', { name: /Filters/ }).click()
  await expect(page.getByPlaceholder('Event name')).toBeVisible()
  await expect(page.locator('.filters input[type="date"]')).toHaveCount(2)
  await page.getByPlaceholder('Event name').fill('transfer')
  await expect(page).toHaveURL(/atab=events/)
  await expect(page).toHaveURL(/event=transfer/)
})

test('tag detail activity tabs expose and send the account-level filters', async ({ page }) => {
  const requests: string[] = []
  page.on('request', request => {
    if (request.url().includes('/api/explorer/tag/kraken/')) requests.push(request.url())
  })
  await page.goto('/tag/kraken?view=activity')

  await page.getByRole('button', { name: 'Trade' }).click()
  await page.getByRole('button', { name: /Filters/ }).click()
  await expect(page.locator('.filters select')).toContainText('DCA')
  await expect(page.getByPlaceholder('All tokens')).toBeVisible()
  await expect(page.locator('.filters input[type="date"]')).toHaveCount(2)
  await page.locator('.filters select').selectOption('dca')
  await page.getByPlaceholder('All tokens').fill('USDC')
  await page.getByPlaceholder('All tokens').press('Enter')
  await page.getByPlaceholder('$ from').fill('100')
  await expect.poll(() => requests.some(url => url.includes('/activity?') && url.includes('action=dca') && url.includes('token=') && url.includes('min=100'))).toBe(true)

  await page.getByRole('button', { name: /Extrinsics/ }).click()
  await page.getByRole('button', { name: /Filters/ }).click()
  await page.getByPlaceholder('Call name').fill('transfer')
  await page.locator('.filters select').selectOption('failed')
  await expect.poll(() => requests.some(url => url.includes('/extrinsics?') && url.includes('call=transfer') && url.includes('result=failed'))).toBe(true)

  await page.getByRole('button', { name: /Events/ }).click()
  await page.getByRole('button', { name: /Filters/ }).click()
  await page.getByPlaceholder('Event name').fill('transfer')
  await expect.poll(() => requests.some(url => url.includes('/events?') && url.includes('event=transfer'))).toBe(true)
})

// The treemap selects the focused asset + its balance history, deep-linked via
// ?asset=<assetId>.
test('balance history selection is shareable via the asset query param', async ({ page }) => {
  const ACCOUNT = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'
  await page.goto(`/account/${ACCOUNT}?view=balances`)
  const tiles = page.locator('.tm-tile:not(.tm-other)')
  await expect(tiles.first()).toBeVisible()
  expect(await tiles.count()).toBeGreaterThan(1)

  // The largest holding is focused by default, with a clean URL.
  await expect(tiles.first()).toHaveClass(/active/)
  await expect(page).not.toHaveURL(/asset=/)

  // clicking a tile locks it — writes the param and focuses that asset
  const second = tiles.nth(1)
  const symbol = (await second.getAttribute('aria-label'))!.split(' — ')[0]
  await second.click()
  await expect(page).toHaveURL(new RegExp(`asset=\\d+`))
  await expect(second).toHaveClass(/active/)
  await expect(page.locator('.tm-detail-sym')).toHaveText(symbol)

  // deep link restores the same selection
  const url = page.url()
  await page.goto(url)
  await expect(page.locator('.tm-detail-sym')).toHaveText(symbol)
  await expect(tiles.nth(1)).toHaveClass(/active/)

  // clicking the locked tile again unlocks it → the deep-link parameter clears.
  await tiles.nth(1).click()
  await expect(page).not.toHaveURL(/asset=/)
})
