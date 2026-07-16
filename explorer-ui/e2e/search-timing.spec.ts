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
