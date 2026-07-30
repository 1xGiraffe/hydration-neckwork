import { expect, test } from './fixtures/test'

// The `mono` utility applies GeistMono consistently to placeholders and values.
test('every table placeholder dash renders in the monospace font', async ({ page }) => {
  for (const path of ['/accounts', '/assets']) {
    await page.goto(path)
    await expect(page.locator('.tbl tbody tr').first()).toBeVisible()
    const offenders = await page.evaluate(() => {
      const bad: string[] = []
      document.querySelectorAll('.tbl tbody td').forEach(td => {
        if (td.textContent?.trim() !== '—') return
        const el = td.querySelector('span') ?? td
        if (!getComputedStyle(el).fontFamily.includes('GeistMono'))
          bad.push(td.getAttribute('data-label') ?? 'td')
      })
      return [...new Set(bad)]
    })
    expect(offenders, `sans-serif dashes on ${path}`).toEqual([])
  }
})

test('activity flow amounts use the monospace font like table value columns', async ({ page }) => {
  await page.goto('/activity')
  const amount = page.locator('.trade-leg .mono').first()
  await expect(amount).toBeVisible()
  const family = await amount.evaluate(el => getComputedStyle(el).fontFamily)
  expect(family).toContain('GeistMono')
})
