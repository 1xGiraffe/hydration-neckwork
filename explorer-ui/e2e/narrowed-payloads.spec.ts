import { expect, test } from './fixtures/test'

// Two payloads are asked for narrower than the endpoint's full shape, because the
// surface that pays for them does not read the expensive part: the account Overview
// wants the value series without the per-asset balance history (98-99% of that
// response, and only the Balances treemap reads it), and the activity token filter
// wants the asset directory without prices or sparklines (57% of 74 kB, and only the
// Assets page renders them). What must hold is that no surface loses anything —
// each still gets the shape it renders, on its first request.
const FOX = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'

function historyRequests(page: import('@playwright/test').Page): string[] {
  const seen: string[] = []
  page.on('request', request => {
    const url = request.url()
    if (url.includes('/api/explorer/address/') && url.includes('/history')) seen.push(url)
  })
  return seen
}

function assetsRequests(page: import('@playwright/test').Page): string[] {
  const seen: string[] = []
  page.on('request', request => {
    const url = request.url()
    if (/\/api\/explorer\/assets(\?|$)/.test(url)) seen.push(url)
  })
  return seen
}

test.describe('account history — the Overview pays for the series only', () => {
  test('asks for series=1 on the Overview and the full shape once Balances is opened', async ({ page }) => {
    const requests = historyRequests(page)
    await page.goto(`/account/${FOX}`)

    // The Value chart is drawn from the light response, so it must be there.
    await expect(page.locator('.pf-card svg').first()).toBeVisible()
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]).toContain('series=1')

    // Opening Balances needs the per-asset history the light shape left out.
    await page.getByRole('button', { name: /^Balances/ }).click()
    await expect(page.locator('.tm-tile').first()).toBeVisible()
    await expect(page.locator('.tm-detail .tm-hist svg')).toBeVisible()
    await expect.poll(() => requests.length).toBe(2)
    expect(requests[1]).not.toContain('series=1')

    // Back on the Overview the full response is reused — the need latches, so the
    // page never trades a superset it already holds for the light variant.
    await page.getByRole('button', { name: /^Overview/ }).click()
    await expect(page.locator('.pf-card svg').first()).toBeVisible()
    await page.getByRole('button', { name: /^Balances/ }).click()
    await expect(page.locator('.tm-tile').first()).toBeVisible()
    expect(requests).toHaveLength(2)
  })

  test('a ?view=balances landing gets the full shape first, not a light one and a refetch', async ({ page }) => {
    const requests = historyRequests(page)
    await page.goto(`/account/${FOX}?view=balances`)
    await expect(page.locator('.tm-detail .tm-hist svg')).toBeVisible()
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]).not.toContain('series=1')
  })

  test('the Value chart is the same chart on 390px, from the light response', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const requests = historyRequests(page)
    await page.goto(`/account/${FOX}`)
    await expect(page.locator('.pf-card svg').first()).toBeVisible()
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]).toContain('series=1')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})

test.describe('asset directory — filters pay for ids and symbols only', () => {
  test('the activity token filter fetches the projection and offers every token', async ({ page }) => {
    const requests = assetsRequests(page)
    await page.goto('/activity')
    await page.getByRole('button', { name: /Filters/ }).click()
    const combo = page.getByPlaceholder('All tokens')
    await expect(combo).toBeVisible()

    await expect.poll(() => requests.length).toBeGreaterThanOrEqual(1)
    for (const url of requests) expect(url).toContain('fields=filter')

    // The combo's own option list, not a subset: 12 tokens in the fixture directory.
    await combo.click()
    await expect(page.locator('.combo-pop [role="option"]')).toHaveCount(13) // 12 + "All tokens"
    await expect(page.locator('.combo-pop .combo-opt-sym').first()).not.toBeEmpty()
  })

  test('a ?token=<id> deep link names the token instead of showing its id', async ({ page }) => {
    await page.goto('/activity?token=5')
    await page.getByRole('button', { name: /Filters/ }).click()
    // Resolved from the option list, which is why it is fetched with the page rather
    // than when the combo opens.
    await expect(page.getByPlaceholder('All tokens')).toHaveValue('DOT')
  })

  test('the Assets page still gets the full directory it renders', async ({ page }) => {
    const requests = assetsRequests(page)
    await page.goto('/assets')
    await expect(page.locator('.assets-tbl tbody tr').first()).toBeVisible()
    await expect.poll(() => requests.length).toBeGreaterThanOrEqual(1)
    for (const url of requests) expect(url).not.toContain('fields=filter')
    // Prices and the 7-day sparkline are in the full payload only.
    await expect(page.locator('.assets-tbl tbody tr').first()).toContainText('$')
    await expect(page.locator('.assets-tbl tbody tr svg').first()).toBeVisible()
  })
})
