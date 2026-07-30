import { expect, test } from './fixtures/test'

test('extrinsic detail defaults to the Activity tab', async ({ page }) => {
  await page.goto('/extrinsic/12848613-4')

  const tabs = page.locator('.tabs button')
  await expect(tabs.first()).toContainText('Activity')
  await expect(tabs.first()).toHaveClass(/active/)
  await expect(page.locator('table.tbl thead')).toContainText('Activity')
})

test('hash extrinsic URLs canonicalize to the block-index id', async ({ page }) => {
  const hash = `0x${'ab'.repeat(32)}`
  await page.goto(`/extrinsic/${hash}?source=search`)

  await expect(page).toHaveURL('/extrinsic/12848613-4?source=search')
  await expect(page.getByText('Extrinsic ID').locator('..')).toContainText('12848613-4')
})

test('block detail defaults to the Activity tab', async ({ page }) => {
  await page.goto('/block/12848613')

  const tabs = page.locator('.tabs button')
  await expect(tabs.first()).toContainText('Activity')
  await expect(tabs.first()).toHaveClass(/active/)
  await expect(page.locator('table.tbl thead')).toContainText('Activity')
})
