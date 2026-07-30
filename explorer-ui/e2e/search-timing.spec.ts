import { expect, test } from './fixtures/test'

test('search keeps the newest response when older work finishes last', async ({ page }) => {
  const requested: string[] = []
  let olderRequestCompleted = false
  await page.route('**/api/explorer/search?*', async route => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? ''
    requested.push(q)
    if (q === 'a') await new Promise(resolve => setTimeout(resolve, 650))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ type: 'block', value: q === 'a' ? '111' : '222', label: q === 'a' ? 'OLD' : 'NEW' }]),
    })
    if (q === 'a') olderRequestCompleted = true
  })
  await page.goto('/')
  const input = page.getByLabel('Search explorer')

  await input.fill('a')
  await expect.poll(() => requested.includes('a')).toBe(true)
  await input.fill('ab')

  await expect(page.locator('.sr-item')).toContainText('NEW')
  await expect.poll(() => olderRequestCompleted).toBe(true)
  await expect(page.locator('.sr-item')).not.toContainText('OLD')
})

// Within the keystroke debounce the dropdown still holds the previous query's hits.
// Enter (or a click) then opens a result for text the user has already replaced —
// typing "5" then "0" and pressing Enter went to block 5 instead of searching "50".
test('enter searches the current text, not the previous query', async ({ page }) => {
  const requested: string[] = []
  await page.route('**/api/explorer/search?*', async route => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? ''
    requested.push(q)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ type: 'block', value: q, label: `Block ${q}` }]),
    })
  })
  await page.goto('/')
  const input = page.getByLabel('Search explorer')

  await input.fill('5')
  await expect(page.locator('.sr-item')).toContainText('Block 5')

  // Replace the text and press Enter before the debounce fires.
  await input.fill('50')
  await expect(page.locator('.sr-item')).toHaveCount(0)
  await input.press('Enter')

  await expect(page).toHaveURL(/\/block\/50$/)
  expect(requested).toContain('50')
})
