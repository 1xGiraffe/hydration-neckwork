import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { mockSync } from '../tests/fixtures/mockApi'
import type { AddressDetail, TagDetail } from '../src/types'

// The fox holds both the primary market and GIGAHDX in the fixtures.
const FOX = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'
const KRAKEN_EVM = '0xF73a2B8c1D4e9A06b5C8f2E1a3D70c9B4e6F18aD'
// An account with no money-market position at all.
const OWL = '1NPoMQbiA6trJKkjB35uk96MeJD4PGWkLQLH7k7hXEkZpiba'

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)

// Counts history reads per address so a spec can tell a lazy card from an eager one.
function countHistory(page: Page): Map<string, number> {
  const seen = new Map<string, number>()
  page.on('request', r => {
    const m = /\/explorer\/address\/([^/]+)\/money-market-history/.exec(r.url())
    if (m) seen.set(decodeURIComponent(m[1]).toLowerCase(), (seen.get(decodeURIComponent(m[1]).toLowerCase()) ?? 0) + 1)
  })
  return seen
}

// The Kraken tag fixture ships only the tag-wide aggregate; give it the API's
// per-member split (the EVM wallet and the fox), as the real tag detail does.
async function withMemberSplit(page: Page) {
  await page.route(/\/api\/explorer\/tag\/kraken$/, async route => {
    const tag = mockSync<TagDetail>('/explorer/tag/kraken')!
    const evm = mockSync<AddressDetail>(`/explorer/address/${KRAKEN_EVM}`)!
    const fox = mockSync<AddressDetail>(`/explorer/address/${FOX}`)!
    const body: TagDetail = {
      ...tag,
      moneyMarketByAccount: [
        { account: tag.members[0], markets: evm.moneyMarket },
        { account: { accountId: fox.accountId, address: FOX, emoji: '🦊', tag: null }, markets: fox.moneyMarket.filter(m => m.marketKey === 'core') },
      ],
    }
    await route.fulfill({ json: body })
  })
}

// The fox reduced to its primary market alone: the one-card layout.
async function withPrimaryOnly(page: Page) {
  await page.route(new RegExp(`/api/explorer/address/${FOX}$`), async route => {
    const fox = mockSync<AddressDetail>(`/explorer/address/${FOX}`)!
    await route.fulfill({ json: { ...fox, moneyMarket: fox.moneyMarket.filter(m => m.marketKey === 'core') } })
  })
}

const SHOTS = process.env.BORROW_SHOTS ?? 'test-results'

for (const vp of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test.describe(`borrow tab (${vp.name})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } })

    test('several cards all start collapsed, their KPI summary read from one history request', async ({ page }) => {
      const seen = countHistory(page)
      await page.goto(`/account/${FOX}?view=borrow`)
      const core = page.locator('.bw-card[data-market-key="core"]')
      const giga = page.locator('.bw-card[data-market-key="gigahdx"]')
      await expect(core).toBeVisible()
      await expect(giga).toBeVisible()
      // The summary stays: header (HF, DefiSim), LTV bar and KPIs.
      await expect(core.locator('.bw-hf .hf')).toBeVisible()
      await expect(core.getByRole('link', { name: /Open in DefiSim/ })).toBeVisible()
      // (The fixture's GIGAHDX card carries debt, so it draws the LTV bar.)
      await expect(giga.locator('.bw-risk .mm-bar-track')).toBeVisible()
      await expect(core.locator('.bw-kpis .mm-stat', { hasText: 'Net APY' })).toBeVisible()
      for (const card of [core, giga]) {
        await expect(card.locator('.bw-rule').first()).toHaveAttribute('aria-expanded', 'false')
        await expect(card.locator('.bw-tbl')).toHaveCount(0)
        await expect(card.locator('[data-chart]')).toHaveCount(0)
      }
      // Collapsed cards still state their interest: one request per account feeds
      // every card of that account.
      await expect(core.locator('.bw-kpi-earned .v')).toContainText('$')
      const before = seen.get(FOX.toLowerCase()) ?? 0
      expect(before).toBeGreaterThan(0)
      expect(await noOverflow(page)).toBe(true)
      await expect(page.locator('.detail-tabs button.active')).toHaveText(/Borrow/)
      await page.screenshot({ path: `${SHOTS}/ui-borrow2-multi-${vp.name}.png`, fullPage: true })
      // Keyboard: focus the rule and press Enter.
      const rule = core.locator('.bw-rule').first()
      await rule.focus()
      await page.keyboard.press('Enter')
      await expect(rule).toHaveAttribute('aria-expanded', 'true')
      await expect(core.locator('[data-chart="exposure"] svg path')).not.toHaveCount(0)
      await expect(core.locator('[data-chart="hf"]')).toBeVisible()
      // Expanding reuses the summary's read.
      expect(seen.get(FOX.toLowerCase())).toBe(before)
      await expect(giga.locator('[data-chart]')).toHaveCount(0)
      expect(await noOverflow(page)).toBe(true)
    })

    test('a lone card opens with details and history; closed reserves stay behind their toggle', async ({ page }) => {
      await withPrimaryOnly(page)
      await page.goto(`/account/${FOX}?view=borrow`)
      const cards = page.locator('.bw-card')
      await expect(cards).toHaveCount(1)
      const core = cards.first()
      await expect(core.locator('.bw-rule').first()).toHaveAttribute('aria-expanded', 'true')
      await expect(core.locator('[data-chart]')).toHaveCount(2)
      // Lowest HF per bucket, and the chain's own totals drawn dashed before the floor.
      await expect(core.locator('[data-chart="hf"] .bw-chart-sub')).toContainText('lowest in each bucket')
      await expect(core.locator('[data-chart="exposure"] [data-series="colChain"] path')).toHaveAttribute('stroke-dasharray', '5 4')
      await expect(core.locator('[data-chart="exposure"] [data-series="debtChain"] path')).toHaveCount(1)
      await expect(core.locator('[data-chart="exposure"] .bw-chart-note')).toContainText('getUserAccountData')
      // Current reserves only; USDT (closed mid-window) is behind the toggle.
      const rows = core.locator('.bw-tbl tbody tr')
      await expect(rows.filter({ hasText: 'PRIME' })).toHaveCount(1)
      await expect(rows.filter({ hasText: 'USDT' })).toHaveCount(0)
      const closed = core.locator('.bw-rule-sub')
      await expect(closed).toHaveAttribute('aria-expanded', 'false')
      await expect(closed).toContainText(/Show \d+ closed reserves?/)
      expect(await noOverflow(page)).toBe(true)
      await page.screenshot({ path: `${SHOTS}/ui-borrow2-single-${vp.name}.png`, fullPage: true })
      await closed.click()
      await expect(closed).toHaveAttribute('aria-expanded', 'true')
      await expect(closed).toContainText('Hide closed reserves')
      await expect(rows.filter({ hasText: 'USDT' })).toHaveCount(1)
      await expect(rows.filter({ hasText: 'USDT' }).locator('.bw-closed-note')).toBeVisible()
    })

    test('hovering one chart draws a synced line on the other', async ({ page }) => {
      await withPrimaryOnly(page)
      await page.goto(`/account/${FOX}?view=borrow`)
      const core = page.locator('.bw-card').first()
      const exposure = core.locator('[data-chart="exposure"] .hdx-chart-wrap')
      const hf = core.locator('[data-chart="hf"] .hdx-chart-wrap')
      await expect(hf).toBeVisible()
      const box = (await exposure.boundingBox())!
      await exposure.hover({ position: { x: box.width * 0.6, y: box.height / 2 } })
      await expect(hf.locator('line.mlc-sync')).toHaveCount(1)
      await expect(exposure.locator('line.mlc-sync')).toHaveCount(0)
      // No tooltip on the sibling, only on the hovered chart.
      await expect(exposure.locator('.hdx-tip')).toHaveCount(1)
      await expect(hf.locator('.hdx-tip')).toHaveCount(0)
      // Same instant on both: the line sits at the same horizontal fraction.
      const hovered = await exposure.locator('svg > line').last().getAttribute('x1')
      const synced = await hf.locator('line.mlc-sync').getAttribute('x1')
      expect(Math.abs(Number(hovered) - Number(synced))).toBeLessThan(1)
      // And the other way round.
      const hbox = (await hf.boundingBox())!
      await hf.hover({ position: { x: hbox.width * 0.3, y: hbox.height / 2 } })
      await expect(exposure.locator('line.mlc-sync')).toHaveCount(1)
      await expect(hf.locator('line.mlc-sync')).toHaveCount(0)
    })

    test('legacy ?view=positions lands on the Borrow tab', async ({ page }) => {
      await page.goto(`/account/${FOX}?view=positions`)
      await expect(page.locator('.bw-card[data-market-key="core"]')).toBeVisible()
    })

    test('the supply APY hover breaks the rate down', async ({ page }) => {
      await withPrimaryOnly(page)
      await page.goto(`/account/${FOX}?view=borrow`)
      // Let the open card's history land first: its layout shift would scroll, and a scroll closes the card.
      await expect(page.locator('.bw-card[data-market-key="core"] [data-chart="hf"]')).toBeVisible()
      const row = page.locator('.bw-card[data-market-key="core"] .bw-tbl tbody tr', { hasText: 'PRIME' })
      const trigger = row.locator('td[data-label="Supply APY"] .yh-trigger')
      await expect(trigger).toContainText('5.96%')
      // In view first: the card closes on scroll, and focusing an off-screen trigger scrolls.
      await trigger.scrollIntoViewIfNeeded()
      await trigger.focus()
      const card = page.getByRole('tooltip')
      await expect(card).toContainText('Supply APY')
      await expect(card).toContainText('HDX')
      await expect(card).toContainText('1.84%')
      expect(await noOverflow(page)).toBe(true)
    })

    test('tag view lists per-member cards, all collapsed, each member\'s history read once', async ({ page }) => {
      await withMemberSplit(page)
      const seen = countHistory(page)
      await page.goto('/tag/kraken?view=borrow')
      const cards = page.locator('.bw-card')
      await expect(cards).toHaveCount(3)
      await expect(page.locator('.bw-card .bw-head .addr-pill')).toHaveCount(3)
      await expect(page.getByRole('link', { name: /Open in DefiSim/ })).toHaveCount(2)
      const foxCard = page.locator(`.bw-card[data-address="${FOX}"]`)
      await expect(foxCard).toHaveCount(1)
      await expect(page.locator('.bw-card [data-chart]')).toHaveCount(0)
      await expect(page.locator('.bw-card > .bw-body > .bw-rule[aria-expanded="false"]')).toHaveCount(3)
      await expect(foxCard.locator('.bw-kpi-earned .v')).toContainText('$')
      const before = seen.get(FOX.toLowerCase()) ?? 0
      expect(before).toBeGreaterThan(0)
      await foxCard.locator('.bw-rule').first().click()
      await expect(foxCard.locator('[data-chart="exposure"]')).toBeVisible()
      // Expanding reuses the summary's read.
      expect(seen.get(FOX.toLowerCase())).toBe(before)
      expect(await noOverflow(page)).toBe(true)
    })
  })
}

test('an account with only history gets a closed card derived from it', async ({ page }) => {
  await page.route(/\/api\/explorer\/address\/[^/]+\/positions-presence$/, route => route.fulfill({ json: { orderHistory: 0, liquidityHistory: false, moneyMarketHistory: true } }))
  await page.goto(`/account/${OWL}?view=borrow`)
  const card = page.locator('.bw-card[data-market-key="core"]')
  await expect(card).toBeVisible()
  await expect(card.locator('.bw-closed-badge')).toHaveText(/closed/i)
  // The lone card opens; every reserve is a past one, so they all wait behind the toggle.
  await expect(card.locator('[data-chart="exposure"]')).toBeVisible()
  await expect(card.locator('.bw-tbl')).toHaveCount(0)
  await card.locator('.bw-rule-sub').click()
  await expect(card.locator('.bw-tbl thead')).toContainText('Earned / Paid')
})

test('a deep link to Borrow holds while positions-presence loads', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  await page.route(/\/api\/explorer\/address\/[^/]+\/positions-presence$/, async route => {
    await gate
    await route.fulfill({ json: { orderHistory: 0, liquidityHistory: false, moneyMarketHistory: true } })
  })
  await page.goto(`/account/${OWL}?view=borrow`)
  // The Borrow tab is there and active while presence is still unanswered.
  await expect(page.locator('.detail-tabs button.active')).toHaveText('Borrow')
  expect(new URL(page.url()).searchParams.get('view')).toBe('borrow')
  release()
  await expect(page.locator('.bw-card[data-market-key="core"]')).toBeVisible()
})
