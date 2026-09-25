import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'

// The Orders tab: working orders on top (KPI line, active DCA table), then the
// finished orders paged by the API with the kind and page in the URL.

const FOX = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'
const SHOTS = process.env.ORDERS_SHOTS

const historyRows = (page: Page) => page.locator('tr[data-order-history]')

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

for (const vp of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } })

    test('account Orders tab pages and filters the order history', async ({ page }) => {
      await page.goto(`/account/${FOX}`)
      const tab = page.locator('.detail-tabs button', { hasText: 'Orders' })
      await expect(tab).toBeVisible()
      await tab.click()
      await expect(page).toHaveURL(/view=orders/)

      await expect(page.locator('.ord-kpis')).toContainText('DCA orders')
      await expect(page.locator('tr[data-dca-schedule="33546"]')).toBeVisible()

      await expect(historyRows(page)).toHaveCount(25)
      await expect(page.locator('.ord-history .pager')).toContainText('Page 1 of 2')
      await noHorizontalOverflow(page)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/ui-orders-${vp.name}.png`, fullPage: true })

      await page.locator('.ord-history .pager button[aria-label="Next page"]').click()
      await expect(page).toHaveURL(/opage=1/)
      await expect(historyRows(page)).toHaveCount(15)

      // A kind chip filters and returns to the first page.
      await page.locator('.ord-seg button', { hasText: 'Limit' }).click()
      await expect(page).toHaveURL(/okind=limit/)
      await expect(page).not.toHaveURL(/opage=/)
      await expect(historyRows(page).first()).toHaveAttribute('data-order-history', /^limit\//)
      const limitCount = await historyRows(page).count()
      for (let i = 0; i < limitCount; i++) await expect(historyRows(page).nth(i)).toHaveAttribute('data-order-history', /^limit\//)
      await expect(page.locator('.ord-history .pager')).toHaveCount(0)
      await noHorizontalOverflow(page)

      await page.locator('.ord-seg button', { hasText: 'DCA' }).click()
      await expect(page).toHaveURL(/okind=dca/)
      await expect(historyRows(page)).toHaveCount(25)
      await expect(historyRows(page).first()).not.toHaveAttribute('data-order-history', /^limit\//)
    })

    test('history rows open the schedule or the intent', async ({ page }) => {
      await page.goto(`/account/${FOX}?view=orders`)
      const dca = page.locator('tr[data-order-history="dca/33573"]')
      await expect(dca).toBeVisible()
      await dca.locator('[data-label="Trades"]').click()
      await expect(page).toHaveURL(/\/dca\/33573$/)

      await page.goBack()
      const limit = historyRows(page).filter({ has: page.locator('.ord-kind-limit') }).first()
      await limit.locator('[data-label="Trades"]').click()
      await expect(page).toHaveURL(/\/intent\/\d+$/)

      await page.goBack()
      const migrated = historyRows(page).filter({ hasText: 'migrated' }).first()
      await migrated.locator('[data-label="Status"] a', { hasText: 'intent' }).click()
      await expect(page).toHaveURL(/\/intent\/\d+$/)
    })

    test('tag Orders tab names each order’s owner', async ({ page }) => {
      await page.goto('/tag/kraken?view=orders')
      await expect(historyRows(page)).toHaveCount(25)
      await expect(page.locator('.ord-tbl thead')).toContainText('Owner')
      await noHorizontalOverflow(page)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/ui-orders-tag-${vp.name}.png`, fullPage: true })
    })
  })
}
