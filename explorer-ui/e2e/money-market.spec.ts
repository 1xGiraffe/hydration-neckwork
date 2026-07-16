import { expect, test } from './fixtures/test'

const ACCOUNT = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'
const EVM_ALIAS = '0xf73a2b8c1d4e9a06b5c8f2e1a3d70c9b4e6f18ad'

test('account canonicalization preserves a positions deep link', async ({ page }) => {
  await page.goto(`/account/${EVM_ALIAS}?view=positions`)

  await expect(page).toHaveURL(/\/account\/0xF73a.*\?view=positions$/)
  await expect(page.locator('.mm-market-section[data-market-key="core"]')).toBeVisible()
})

test('dual-market account renders GIGAHDX as a full market card below the primary', async ({ page }) => {
  await page.goto(`/account/${ACCOUNT}?view=positions`)

  const primary = page.locator('.mm-market-section[data-market-key="core"]')
  const giga = page.locator('.mm-market-section[data-market-key="gigahdx"]')
  await expect(primary).toBeVisible()
  await expect(giga).toBeVisible()
  const defiSim = page.getByRole('link', { name: /Open in DefiSim/ })
  await expect(defiSim).toHaveCount(1)
  await expect(defiSim).toHaveAttribute('href', /[?&]address=0x[0-9a-f]{40}$/i)

  const primaryBox = await primary.boundingBox()
  const gigaBox = await giga.boundingBox()
  expect(primaryBox?.y).toBeLessThan(gigaBox?.y ?? 0)

  // Same treatment as the primary: the full summary stats, not a collapsed line.
  await expect(giga.locator('.mm-summary .mm-stat')).not.toHaveCount(0)
  // Heading reads "Money Market — GIGAHDX · supply & borrow" with the asset-67 logo.
  await expect(giga.locator('.mm-title')).toHaveText('Money Market')
  await expect(giga.locator('.mm-title-note').first()).toContainText('GIGAHDX · supply & borrow')
  await expect(giga.locator('.mm-title-note img')).toHaveAttribute('src', /\/67\/icon/)
  await expect(giga).toContainText('HOLLAR')
})

test('activity uses a compact supplemental-market label', async ({ page }) => {
  await page.goto('/activity?tab=mm')
  await expect(page.locator('.mm-activity-market').first()).toHaveText('GIGAHDX')
})

test('tag view keeps supplemental debt contextual and DefiSim on the primary market', async ({ page }) => {
  await page.goto('/tag/kraken')
  await expect(page.locator('.mm-secondary-debt')).toContainText('GIGAHDX debt')

  await page.getByRole('button', { name: /Positions/ }).click()
  await expect(page.locator('.mm-market-section[data-market-key="core"]')).toBeVisible()
  await expect(page.locator('.mm-market-section[data-market-key="gigahdx"]')).toBeVisible()
  await expect(page.getByRole('link', { name: /Open in DefiSim/ })).toHaveCount(1)
})

test('GIGAHDX market card remains usable without horizontal overflow on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/account/${ACCOUNT}?view=positions`)

  const giga = page.locator('.mm-market-section[data-market-key="gigahdx"]')
  await expect(giga).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

test('/hdx shows the GIGAHDX money-market stats', async ({ page }) => {
  await page.goto('/hdx')
  const section = page.locator('.pf-card', { has: page.locator('.hdx-card', { hasText: 'stHDX supplied' }) })
  await expect(page.getByText('GIGAHDX Money Market')).toBeVisible()
  await expect(section.locator('.hdx-card', { hasText: 'stHDX supplied' })).toContainText('48.20M')
  await expect(section.locator('.hdx-card', { hasText: 'HOLLAR borrowed' })).toContainText('187 borrowers')
})

test('/hdx hides cohort thresholds on mobile without widening the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/hdx')

  const cohorts = page.locator('.pf-card', { has: page.locator('.hdx-card', { hasText: 'Whale' }) })
  await expect(cohorts).toBeVisible()
  await expect(cohorts.locator('.cohort-threshold')).toHaveCount(4)
  await expect(cohorts.locator('.cohort-threshold').first()).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

test('/hdx charts stHDX liquidation levels with cumulative tooltip context', async ({ page }) => {
  await page.goto('/hdx')
  const chart = page.locator('.giga-liq-chart')
  await expect(chart).toBeVisible()
  // one bar per non-empty price bucket, plus the current-price marker
  expect(await chart.locator('rect.liq-bar').count()).toBeGreaterThan(8)
  await expect(chart.locator('.liq-now-label')).toContainText('now')

  await chart.locator('rect.liq-hit').nth(5).hover()
  const tip = page.locator('.hdx-tip')
  await expect(tip).toBeVisible()
  await expect(tip).toContainText(/if HDX falls to/)
  await expect(tip).toContainText(/cumulative/i)
})

test('liquidation chart stays inside the viewport on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/hdx')
  await expect(page.locator('.giga-liq-chart')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})
