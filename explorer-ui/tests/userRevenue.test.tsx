import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Revenue, RevenueRivers } from '../src/pages/Revenue'
import { requestRiverFullscreen, riverModeAfterChange } from '../src/hooks/useRiverFullscreen'
import { NAV_CONFIG } from '../src/components/navConfig'
import { RevenueUsers } from '../src/pages/RevenueUsers'
import { UserRevenueTab } from '../src/components/UserRevenueTab'
import { ProfileStats, profileTabs } from '../src/components/AccountSections'
import { AccountRow } from '../src/components/AccountsTable'
import { activityCountKey } from '../src/utils/directoryActivity'
import { createRateScheduler } from '../src/hooks/useUserRevenueFlowStream'
import { USER_REVENUE_STREAM_COLOR } from '../src/components/revenueColors'
import { userRevenueCauseLabel, userRevenueViaLabel } from '../src/components/userRevenueLabels'
import type { RevenueDashboard, TopAccountRow, UserRevenueBreakdown, UserRevenueDashboard, UserRevenueSummary } from '../src/types'

const DAY = 86_400
const T0 = Math.floor(Date.parse('2026-09-06T00:00:00Z') / 1000)
const ACC = { accountId: `0x${'cd'.repeat(32)}`, address: '7Earner111111111111111111111111111111111111111', emoji: '🦊', tag: null, profile: null }
const ASSET = { assetId: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10 }

const summary = (over: Partial<UserRevenueSummary> = {}): UserRevenueSummary => ({
  totals: { day: 3_174.88, week: 94_155.92, month: 200_456.83, allTime: 22_658_571.18 },
  publishedThrough: '2026-10-04T04:00:00.000Z',
  firstHour: '2022-03-12T12:00:00.000Z',
  complete: true,
  unpricedCells: 12,
  unmeasured: [{ id: 'apyusd-accrual', label: 'apyUSD token accrual', reason: 'its on-chain peg never moved' }],
  ...over,
})

const dashboard = (): UserRevenueDashboard => ({
  ...summary(),
  range: '30d',
  bucketSeconds: DAY,
  accountPublishedThrough: '2026-10-04T03:00:00.000Z',
  fromDay: '2026-09-05',
  history: {
    series: [
      { stream: 'lp_fee_omnipool', points: [{ t: T0, usd: 320, earned: 320, paid: 0 }, { t: T0 + DAY, usd: 340, earned: 340, paid: 0 }] },
      { stream: 'mm_borrow_interest', points: [{ t: T0, usd: -1_600, earned: 0, paid: -1_600 }, { t: T0 + DAY, usd: -1_700, earned: 0, paid: -1_700 }] },
      // A signed stream: supply interest earned by lenders, passed NEGATIVE to a wrapper's borrowers, in the same bucket.
      { stream: 'mm_supply_interest', points: [{ t: T0, usd: 6, earned: 10, paid: -4 }] },
    ],
  },
  breakdown: [
    { stream: 'lp_fee_omnipool', label: 'Omnipool LP fees', sign: 'earned', revisable: false, toggle: false, coverage: 'from 2023-08-04', earned: 9_637, paid: 0, net: 9_637, unpriced: 0 },
    { stream: 'farm_rewards', label: 'Liquidity-mining rewards', sign: 'both', revisable: true, toggle: false, coverage: 'chain start', earned: 40_795, paid: 0, net: 40_795, unpriced: 3 },
    { stream: 'mm_borrow_interest', label: 'Borrow interest', sign: 'paid', revisable: false, toggle: false, coverage: 'B0', earned: 0, paid: -49_465, net: -49_465, unpriced: 0 },
    { stream: 'referral_commissions', label: 'Referrer commissions', sign: 'earned', revisable: false, toggle: true, coverage: 'at claim', earned: 1_018, paid: 0, net: 1_018, unpriced: 0 },
  ],
  notUser: [
    { holderClass: 'unattributed', net: 22_480, causes: [{ via: 'omnipool-hub-channel', net: 22_480 }] },
  ],
  topEarners: [{ account: ACC, usd: 23_809.32 }],
  topPayers: [],
})

function withClient(seed: (c: QueryClient) => void, node: React.ReactNode): string {
  const client = new QueryClient()
  seed(client)
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}
const text = (html: string) => html.replace(/<[^>]+>/g, '')

describe('/revenue overview', () => {
  const protocol = { totals: { day: 512.34, week: 3_804.5, month: 16_420.11, allTime: 431_207.9 }, history: { range: '30d', bucketSeconds: DAY, series: [] }, breakdown: [], topAccounts: [], asOf: '2026-10-04T05:12:00.000Z' } as RevenueDashboard
  it('shows two rivers, each with 24H/7D/30D/All time, their freshness in the footnote, and never a combined total', () => {
    const html = withClient(c => {
      c.setQueryData(['user-revenue-summary'], summary())
      c.setQueryData(['revenue-dashboard', '30d'], protocol)
    }, <Revenue />)
    expect(html.match(/rev-river/g)?.length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('User Revenue')
    expect(html).toContain('Protocol Revenue')
    for (const k of ['24H', '7D', '30D', 'All time']) expect(html.split(`>${k}<`).length - 1).toBe(2)
    expect(html).toContain('$3.17k')
    expect(html).toContain('$22.7M')
    expect(html).toContain('$431k')
    expect(text(html)).toContain('User Revenue covers completed hours through 04:00 UTC 2026-10-04')
    expect(html).not.toContain('rev-asof')
    expect(html).toContain('href="/revenue/users"')
    expect(html).toContain('href="/revenue/protocol"')
    // Not additive: no figure equals the sum of the two all-time totals.
    expect(text(html)).not.toContain('$23.1M')
    expect(text(html)).toContain('not additive')
  })

  it('renders a window that is not fully published as a dash, never $0', () => {
    const html = withClient(c => c.setQueryData(['user-revenue-summary'], summary({ totals: { day: 10, week: null, month: null, allTime: null }, complete: false })), <Revenue />)
    expect(html).toContain('Not every hour of this window is published yet')
    expect(html).not.toContain('>$0<')
  })
})

describe('/revenue full screen', () => {
  const protocol = { totals: { day: 512.34, week: 3_804.5, month: 16_420.11, allTime: 431_207.9 }, history: { range: '30d', bucketSeconds: DAY, series: [] }, breakdown: [], topAccounts: [], asOf: '2026-10-04T05:12:00.000Z' } as RevenueDashboard
  const rivers = (mode: 'off' | 'native' | 'css') => withClient(() => {}, <RevenueRivers user={summary()} protocol={protocol} mode={mode} onToggleFullscreen={() => {}} />)

  it('puts a full-screen button on BOTH rivers', () => {
    const html = rivers('off')
    expect(html.split('aria-label="Watch both rivers full screen"').length - 1).toBe(2)
    expect(html).not.toContain('rev-duo-fs')
  })

  it('opens one view holding both rivers, each labelled and with its counter, never summed', () => {
    for (const mode of ['native', 'css'] as const) {
      const html = rivers(mode)
      expect(html).toContain('rev-duo rev-duo-fs')
      expect(html.includes('rev-duo-pseudo')).toBe(mode === 'css')
      // Both rivers, both in full-screen dress, and ONE exit control for the one view (the top river's).
      expect(html).toContain('ur-river')
      expect(html.match(/class="rev-river[^"]*rev-fullscreen/g)?.length).toBe(2)
      expect(html.split('aria-label="Exit full screen"').length - 1).toBe(1)
      expect(html.indexOf('aria-label="Exit full screen"')).toBeLessThan(html.indexOf('Protocol Revenue streams'))
      expect(html.match(/class="rev-counter[ "]/g)?.length).toBe(2)
      // User Revenue above Protocol Revenue, each band named by its overlaid label.
      const labels = [...html.matchAll(/class="rev-band-label"[^>]*>([^<]+)</g)].map(m => m[1])
      expect(labels).toEqual(['User Revenue', 'Protocol Revenue'])
      expect(html.indexOf('ur-river')).toBeLessThan(html.indexOf('Protocol Revenue streams'))
      expect(text(html)).not.toContain('$23.1M')
    }
  })

  it('uses element fullscreen where granted and the CSS layer where it is absent or refused', async () => {
    expect(await requestRiverFullscreen({ requestFullscreen: () => Promise.resolve() })).toBe('native')
    expect(await requestRiverFullscreen({ requestFullscreen: () => Promise.reject(new Error('denied')) })).toBe('css')
    expect(await requestRiverFullscreen({})).toBe('css')
  })

  it('leaves full screen when the browser does (Esc), and a fullscreenchange never ends the CSS layer', () => {
    expect(riverModeAfterChange('off', true)).toBe('native')
    expect(riverModeAfterChange('native', false)).toBe('off')
    expect(riverModeAfterChange('css', false)).toBe('css')
    expect(riverModeAfterChange('off', false)).toBe('off')
  })
})

describe('Revenue nav menu', () => {
  it('the trigger reaches the overview and lights for all three pages; the menu lists the two breakdowns', () => {
    const { REVENUE_GROUP, ASSETS_FOLD_GROUP, DRAWER_LINKS, NAV_ENTRIES } = NAV_CONFIG
    expect(REVENUE_GROUP.label).toBe('Revenue')
    expect(REVENUE_GROUP.items[0].to).toBe('/revenue')
    expect(REVENUE_GROUP.items.flatMap(i => i.match).sort()).toEqual(['revenue', 'revenueProtocol', 'revenueUsers'])
    expect(REVENUE_GROUP.menuItems!.map(i => [i.label, i.to])).toEqual([['User Revenue', '/revenue/users'], ['Protocol Revenue', '/revenue/protocol']])
    // Each entry marks only its own page.
    for (const i of REVENUE_GROUP.items) expect(i.match).toHaveLength(1)
    // A group, not a direct link, and it yields to the mid-width fold like Assets.
    expect(NAV_ENTRIES.some(e => e.kind === 'link' && e.item.label === 'Revenue')).toBe(false)
    expect(NAV_ENTRIES.find(e => e.kind === 'group' && e.group === REVENUE_GROUP)).toMatchObject({ fold: 'hidden' })
    for (const list of [ASSETS_FOLD_GROUP.menuItems!, DRAWER_LINKS]) {
      const labels = list.map(i => i.label)
      expect(labels.slice(labels.indexOf('Revenue'), labels.indexOf('Revenue') + 3)).toEqual(['Revenue', 'User Revenue', 'Protocol Revenue'])
    }
  })
})

describe('/revenue/users', () => {
  const render = () => withClient(c => c.setQueryData(['user-revenue-dashboard', '30d'], dashboard()), <RevenueUsers />)
  it('states earned, paid and net per stream, the user total, and what no user holds', () => {
    const html = render()
    expect(html).toContain('<h1 class="page-title">User Revenue</h1>')
    for (const label of ['data-label="Earned"', 'data-label="Paid"', 'data-label="Net"', 'data-label="Stream"']) expect(html).toContain(label)
    expect(html).toContain('Omnipool LP fees')
    expect(html).toContain('-$49.5k')
    expect(html).toContain('revisable')
    expect(html).toContain('3 unpriced')
    // Total net: 9,637 + 40,795 − 49,465 + 1,018 = 1,985.
    expect(html).toContain('$1.99k')
    expect(html).toContain('Not User Revenue')
    expect(html).toContain('Omnipool hub channel')
    expect(html).toContain('Unmeasured')
    expect(html).toContain('apyUSD token accrual')
    expect(html).toContain('/account/7Earner111111111111111111111111111111111111111')
    // Referrer commissions are always counted; no toggle, and no net-payer list.
    expect(html).not.toContain('With referrals')
    expect(html).not.toContain('Net payers')
    expect(html.indexOf('Top earners')).toBeLessThan(html.indexOf('Not User Revenue'))
  })
  it('charts what a signed stream earned, never its netted bucket, and no cost', async () => {
    const { earnedColumns } = await import('../src/components/userRevenueColumns')
    const d = dashboard()
    const income = earnedColumns(d, '30d', new Set(['lp_fee_omnipool', 'mm_borrow_interest', 'mm_supply_interest']))
    const seg = (t: number, stream: string) => income.find(c => c.key === String(t))?.segments.find(x => x.key === stream)?.value
    expect(seg(T0, 'mm_supply_interest')).toBe(10)
    expect(seg(T0, 'lp_fee_omnipool')).toBe(320)
    expect(seg(T0, 'mm_borrow_interest')).toBeUndefined()
  })
  it('charts only Earned; Paid stays a breakdown column', () => {
    const html = render()
    const titles = [...html.matchAll(/class="sec-title"[^>]*>([^<]+)</g)].map(m => m[1])
    expect(titles).toContain('Earned')
    expect(titles).not.toContain('Paid')
    expect(html).not.toContain('No costs published')
    expect(html).toContain('<th class="num">Paid</th>')
    expect(html).toContain('data-label="Paid"')
  })
  it('shows HOLLAR interest as its own cost line in HOLLAR\'s colour, beside the rest of borrow interest', () => {
    const d = dashboard()
    const hollar = { stream: 'mm_borrow_interest_hollar', label: 'HOLLAR interest', sign: 'paid' as const, revisable: false, toggle: false, coverage: 'B0', earned: 0, paid: -45_000, net: -45_000, unpriced: 0 }
    const withHollar: UserRevenueDashboard = {
      ...d,
      history: { series: [...d.history.series, { stream: 'mm_borrow_interest_hollar', points: [{ t: T0, usd: -900, earned: 0, paid: -900 }] }] },
      breakdown: d.breakdown.flatMap(b => (b.stream === 'mm_borrow_interest' ? [hollar, { ...b, paid: -4_465, net: -4_465 }] : [b])),
    }
    const html = withClient(c => c.setQueryData(['user-revenue-dashboard', '30d'], withHollar), <RevenueUsers />)
    // Named as Protocol Revenue names the same interest, and the other assets' slice alike.
    expect(html).toContain('>HOLLAR interest<')
    expect(html).not.toContain('HOLLAR interest paid')
    expect(html).toContain('>Borrow interest<')
    expect(html).toContain(`background:${USER_REVENUE_STREAM_COLOR.mm_borrow_interest_hollar}`)
    expect(USER_REVENUE_STREAM_COLOR.mm_borrow_interest_hollar).toBe('var(--rv-hollar)')
    // The page total is unchanged by the split: 9,637 + 40,795 − 45,000 − 4,465 + 1,018 = 1,985.
    expect(html).toContain('$1.99k')
    // The breakdown lists HOLLAR interest before the borrow gold, as the api orders it.
    expect(html.indexOf('>HOLLAR interest<')).toBeLessThan(html.indexOf('>Borrow interest<'))
  })
  it('states the cut once, on the headline, and keeps the section subtitles short', () => {
    const html = render()
    expect(html).toContain('closed hours through 04:00 UTC 2026-10-04')
    expect(html).not.toContain('last 30 days, through')
  })
  it('says when nothing is published instead of drawing zeros', () => {
    const html = withClient(c => c.setQueryData(['user-revenue-dashboard', '30d'], { ...dashboard(), history: { series: [] }, breakdown: [], notUser: [], topEarners: [] }), <RevenueUsers />)
    expect(html).toContain('No User Revenue published in this range yet.')
  })
})

describe('User Revenue tab and stat', () => {
  const breakdown: UserRevenueBreakdown = {
    range: 'all', grain: 'month', fromDay: null, complete: true, asOf: '2026-10-04T04:11:57.000Z',
    totals: { earned: 285, paid: -70, net: 215, unpriced: 0 },
    streams: [
      { stream: 'lp_fee_omnipool', label: 'Omnipool LP fees', revisable: false, toggle: false, earned: 285, paid: 0, net: 285, unpriced: 0,
        items: [{ pot: 'omnipool:5', potLabel: 'Omnipool · DOT', via: '', asset: ASSET, earned: 280, paid: 0, net: 280, unpriced: 0 },
          { pot: 'omnipool:5', potLabel: 'Omnipool · DOT', via: 'atoken:1001>omnipool', asset: ASSET, earned: 5, paid: 0, net: 5, unpriced: 0 }],
        otherCount: 0, otherNet: 0 },
      { stream: 'lp_exit_fee', label: 'LP exit and imbalance fees paid', revisable: false, toggle: false, earned: 0, paid: -70, net: -70, unpriced: 0, items: [], otherCount: 0, otherNet: 0 },
    ],
    points: [{ t: T0, earned: 285, paid: -70, net: 215, streams: [{ stream: 'lp_fee_omnipool', net: 285 }, { stream: 'lp_exit_fee', net: -70 }] }],
    otherClasses: [],
  }
  it('opens each stream into its pots, assets and custody path', () => {
    const html = withClient(c => c.setQueryData(['account-user-revenue', ACC.address, 'all'], breakdown), <UserRevenueTab scope={{ kind: 'account', address: ACC.address }} />)
    expect(html).toContain('Omnipool · DOT')
    expect(html).toContain('via aToken #1001 › Omnipool')
    expect(html).toContain('-$70.00')
    expect(html).toContain('$215')
  })
  it('renames the protocol stat and shows User Revenue (signed) only once published', () => {
    const html = renderToStaticMarkup(<ProfileStats revenueUsd={12.4} userRevenueUsd={-5.5} valueUsd={500} />)
    expect(html).toContain('Protocol Revenue')
    expect(html).not.toContain('Protocol Revenue generated')
    // The short forms carry the long form and its one-line meaning on hover.
    expect(html).toMatch(/title="Protocol Revenue — [^"]+">P\. Revenue</)
    expect(html).toMatch(/title="User Revenue — [^"]+">U\. Revenue</)
    expect(html).toContain('User Revenue')
    expect(html).toContain('-$5.50')
    const unpublished = renderToStaticMarkup(<ProfileStats revenueUsd={12.4} userRevenueUsd={null} valueUsd={500} />)
    expect(unpublished).not.toContain('User Revenue')
    const tabs = profileTabs(0, { orders: 0, liquidity: 0, borrow: 0 }, undefined, undefined, undefined, undefined, undefined, 1, 2)
    expect(tabs.map(t => t.key)).toContain('user-revenue')
    expect(profileTabs(0, { orders: 0, liquidity: 0, borrow: 0 }, undefined, undefined, undefined, undefined, undefined, 1, null).map(t => t.key)).not.toContain('user-revenue')
  })
  it('a published $0 shows as $0 on the detail page too (the directory\'s rule), a negative in red', () => {
    const zero = renderToStaticMarkup(<ProfileStats revenueUsd={12.4} userRevenueUsd={0} valueUsd={500} />)
    expect(zero).toContain('User Revenue')
    expect(zero).toMatch(/>\$0(\.00)?</)
    expect(profileTabs(0, { orders: 0, liquidity: 0, borrow: 0 }, undefined, undefined, undefined, undefined, undefined, 1, 0).map(t => t.key)).toContain('user-revenue')
    expect(renderToStaticMarkup(<ProfileStats userRevenueUsd={-5.5} valueUsd={500} />)).toContain('class="amt ur-neg"')
  })
  it('directory rows: a dash for unpublished, $0 for a published zero, signed values', () => {
    const row = (v: number | null, extra: Partial<TopAccountRow> = {}): string => renderToStaticMarkup(<table><tbody><AccountRow r={{ account: ACC, tag: null, portfolioUsd: 1, lastBlock: 1, healthFactor: null, identity: null, suppliedUsd: null, borrowedUsd: null, simAccount: null, userRevenueUsd: v, ...extra } as unknown as TopAccountRow} /></tbody></table>)
    expect(row(null)).toMatch(/data-label="User Revenue"[^>]*>\s*<span[^>]*title="User Revenue not yet published[^"]*">—/)
    expect(row(0)).toContain('>$0<')
    expect(row(0, { holderClass: 'user' })).toContain('>$0<')
    expect(row(-12)).toContain('-$12.00')
    // A row User Revenue does not describe is never a user's $0.
    for (const holderClass of ['protocol', 'unattributed'] as const) {
      const html = row(0, { holderClass })
      expect(html).not.toContain('>$0<')
      expect(html).toMatch(/title="Not a user account[^"]*">—/)
      expect(html).toMatch(/data-label="User Revenue" class="[^"]*cell-empty/)
    }
    // User Revenue is the first metric after the row's value.
    const cells = [...row(5).matchAll(/data-label="([^"]+)"/g)].map(m => m[1])
    expect(cells.slice(0, 3)).toEqual(['Account', 'Value', 'User Revenue'])
    expect(cells[cells.length - 1]).toBe('Activity')
  })
  it('directory rows: an on-demand activity total fills a row the sweep has not counted', () => {
    const base = { account: ACC, tag: null, portfolioUsd: 1, lastBlock: 1, suppliedUsd: null, borrowedUsd: null } as unknown as TopAccountRow
    const html = (props: Partial<Parameters<typeof AccountRow>[0]>) => renderToStaticMarkup(<table><tbody><AccountRow r={base} {...props} /></tbody></table>)
    expect(html({ lazyActivity: { total: 4_870, complete: true } })).toMatch(/data-label="Activity"[^>]*>.*4\.87k/)
    expect(html({ lazyActivity: { total: 40, complete: false } })).toMatch(/>40<\/span><\/span>\+<\/td>/)
    expect(html({ activityPending: true })).toContain('activity-counting')
    // A failed count, or one polling gave up on, says so and offers a retry — never "…" forever.
    expect(html({ activityUnavailable: true })).toContain('activity-retry')
    expect(html({ activityUnavailable: true })).not.toContain('activity-counting')
    expect(html({ activityUnavailable: true, lazyActivity: { total: 3, complete: true } })).not.toContain('activity-retry')
    expect(html({ lazyActivity: null })).toMatch(/data-label="Activity" class="[^"]*cell-empty/)
    // The swept total wins when there is one.
    expect(renderToStaticMarkup(<table><tbody><AccountRow r={{ ...base, activityCount: 7 }} lazyActivity={{ total: 9, complete: true }} /></tbody></table>)).toMatch(/>7</)
  })
  it('activity count keys: system tag rows by tag, members and accounts by account, viewer groups never', () => {
    const acc = { account: ACC, tag: null } as unknown as TopAccountRow
    const tag = { account: null, tag: { tagId: 'treasury', name: 'Treasury', color: '', icon: '', memberCount: 7 } } as unknown as TopAccountRow
    const own = { account: null, tag: { tagId: 'x', name: 'Mine', color: '', icon: '', memberCount: 2, userTagId: 'x' } } as unknown as TopAccountRow
    expect(activityCountKey(acc)).toBe(ACC.accountId)
    expect(activityCountKey(tag)).toBe('treasury')
    expect(activityCountKey(own)).toBeNull()
    expect(activityCountKey({ ...acc, tag: tag.tag }, true)).toBe(ACC.accountId)
  })
})

describe('user river scheduler', () => {
  const make = (maxActive = 10) => createRateScheduler({ emitUsd: 0.01, pillUsd: 0.05, maxActive, now: () => 1_000 })
  it('accrues per drip and emits earned particles carrying the whole accumulated amount, never a cost', () => {
    const s = make()
    s.tick([
      { key: 'a', stream: 'lp_fee_omnipool', label: 'A', usdPerBlock: 0.004 },
      { key: 'c', stream: 'mm_supply_interest', label: 'C', usdPerBlock: 0.03 },
      { key: 'b', stream: 'mm_borrow_interest', label: 'B', usdPerBlock: -0.03 },
    ], 3, 0)
    const { due, credit } = s.drain(2_000)
    expect(credit).toBe(0)
    expect(due.map(e => [e.stream, +e.usd.toFixed(3), e.kind])).toEqual(expect.arrayContaining([['lp_fee_omnipool', 0.012, 'mote'], ['mm_supply_interest', 0.09, 'pill']]))
    expect(due.some(e => e.stream === 'mm_borrow_interest')).toBe(false)
    expect(+s.sessionUsd().toFixed(3)).toBe(0.102)
  })
  it('never drops value: past the cap the amount is credited to the counter', () => {
    const s = make(1)
    s.setInFlight(1)
    s.tick([{ key: 'a', stream: 'x', label: 'A', usdPerBlock: 1 }], 1, 0)
    expect(s.drain(2_000)).toEqual({ due: [], credit: 1 })
  })
  it('keeps one colour per user stream', () => {
    const colors = Object.values(USER_REVENUE_STREAM_COLOR)
    expect(new Set(colors).size).toBe(colors.length)
  })
  it('names causes and custody paths', () => {
    expect(userRevenueCauseLabel('')).toContain('own holdings')
    expect(userRevenueViaLabel('stableswap:690>atoken:69')).toBe('stableswap pool #690 › aToken #69')
  })
  it('names an external-rate booking label by its source, never as a custody', () => {
    expect(userRevenueViaLabel('external-rate:hastra-nav')).toBe("issuer's NAV (Hastra, Solana) before Hydration's first rate")
    expect(userRevenueCauseLabel('external-rate:hastra-nav')).toContain('Hastra')
    expect(userRevenueViaLabel('external-rate:other-src>atoken:1043')).toBe("external rate (other src) before Hydration's first rate › aToken #1043")
  })
})
