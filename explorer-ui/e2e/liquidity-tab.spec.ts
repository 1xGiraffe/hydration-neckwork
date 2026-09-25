import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { mockSync } from '../tests/fixtures/mockApi'
import { withMockLiquidity } from '../tests/fixtures/positionsMock'

// The account/tag Liquidity tab: KPI strip, pools aggregated by pool with their
// positions beneath, the APR composition card, and the LP history sections.
// The base detail fixtures hold no LP rows, so each test splices the Liquidity
// fixture into the detail response (registered after the shared mock, so it wins).

const ACCOUNT = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'
const SHOTS = process.env.LPT_SHOTS

async function withLiquidity(page: Page, kind: 'address' | 'tag', id: string) {
  await page.route(new RegExp(String.raw`/api/explorer/${kind}/${id}(?:\?.*)?$`), async route => {
    const url = new URL(route.request().url())
    const base = mockSync<object>(`${url.pathname.replace(/^\/api/, '')}${url.search}`) ?? {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(withMockLiquidity(base, kind === 'tag')) })
  })
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

for (const vp of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.name === 'mobile' })

    test('the Liquidity tab groups positions by pool and expands/collapses them', async ({ page }) => {
      await withLiquidity(page, 'address', ACCOUNT)
      await page.goto(`/account/${ACCOUNT}?view=liquidity`)
      await expect(page.locator('.tabs button', { hasText: 'Liquidity' }).locator('.cnt')).toHaveText('8')
      await expect(page.locator('.lpt-kpis')).toContainText('LP value')
      await expect(page.locator('.lpt-kpis')).toContainText('of $14.6k')

      const pools = page.locator('tr.lpt-pool')
      await expect(pools).toHaveCount(5)
      await expect(pools.first()).toContainText('DOT')
      // 8 positions ≤ 12: expanded by default.
      await expect(page.locator('tr.lpt-pos')).toHaveCount(8)

      // One pool's caret collapses just that pool, keyboard first.
      const caret = pools.first().locator('.exp-btn')
      await expect(caret).toHaveAttribute('aria-expanded', 'true')
      await caret.focus()
      await page.keyboard.press('Enter')
      await expect(caret).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator('tr.lpt-pos')).toHaveCount(6)
      // The caret did not navigate the row.
      await expect(page).toHaveURL(/\/account\/.*view=liquidity/)

      await page.getByRole('button', { name: 'Expand all' }).click()
      await expect(page.locator('tr.lpt-pos')).toHaveCount(8)
      await page.getByRole('button', { name: 'Collapse all' }).click()
      await expect(page.locator('tr.lpt-pos')).toHaveCount(0)
      await page.getByRole('button', { name: 'Expand all' }).click()

      await expect(page.locator('.sec-title', { hasText: 'Rewards earned' })).toBeVisible()
      await expect(page.locator('.sec-title', { hasText: 'Position history' })).toBeVisible()
      await expect(page.locator('.lpt-hist tbody tr')).toHaveCount(25)
      await noHorizontalOverflow(page)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/ui-liquidity-${vp.name}.png`, fullPage: true })
      if (SHOTS) {
        await page.locator('.lpt-kpis').evaluate(el => el.scrollIntoView({ behavior: 'instant' }))
        await page.screenshot({ path: `${SHOTS}/ui-liquidity-${vp.name}-top.png` })
        await page.locator('.lpt-earned').evaluate(el => el.scrollIntoView({ behavior: 'instant' }))
        await page.screenshot({ path: `${SHOTS}/ui-liquidity-${vp.name}-history.png` })
      }
    })

    test('the APR card opens on hover and on keyboard focus with its components', async ({ page }) => {
      await withLiquidity(page, 'address', ACCOUNT)
      await page.goto(`/account/${ACCOUNT}?view=liquidity`)
      const farmed = page.locator('tr.lpt-pos', { hasText: '#71062' })
      const trigger = farmed.locator('.yh-trigger')
      await expect(trigger).toBeVisible()

      if (vp.name === 'desktop') await trigger.hover()
      else await trigger.tap()
      const card = page.getByRole('tooltip')
      await expect(card).toBeVisible()
      await expect(card).toContainText('Omnipool fee')
      await expect(card).toContainText('Farm rewards')
      await expect(card).toContainText('62.5% loyalty')
      await expect(card).toContainText('Impermanent loss')
      // It stays open (a tap is also a focus and a hover, none of which may shut it).
      await page.waitForTimeout(400)
      await expect(card).toBeVisible()
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/ui-liquidity-${vp.name}-hover.png` })
      // Leaving (pointer out on desktop, a tap elsewhere on a phone) closes it.
      if (vp.name === 'desktop') await page.mouse.move(2, 2)
      else await page.locator('.lpt-kpis').tap()
      await expect(card).toHaveCount(0)

      // The pool-level card on the pool row, by keyboard focus; Escape closes it.
      const poolTrigger = page.locator('tr.lpt-pool').first().locator('.yh-trigger')
      await poolTrigger.focus()
      await expect(page.getByRole('tooltip')).toContainText('full loyalty')
      await expect(page.getByRole('tooltip')).toContainText('Omnipool fee')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('tooltip')).toHaveCount(0)
      await noHorizontalOverflow(page)
    })

    test('a tag names the owner of each NFT position', async ({ page }) => {
      await withLiquidity(page, 'tag', 'kraken')
      await page.goto('/tag/kraken?view=liquidity')
      await expect(page.locator('tr.lpt-pool').first()).toBeVisible()
      await expect(page.locator('tr.lpt-pos', { hasText: '#71061' }).locator('.addr-pill, a').first()).toBeVisible()
      await noHorizontalOverflow(page)
    })
  })
}

test('the pool row navigates to its pool page', async ({ page }) => {
  await withLiquidity(page, 'address', ACCOUNT)
  await page.goto(`/account/${ACCOUNT}?view=liquidity`)
  await page.locator('tr.lpt-pool', { hasText: 'HDX / DOT' }).locator('td[data-label="Positions"]').click()
  await expect(page).toHaveURL(/\/pool\/1000194$/)
})
