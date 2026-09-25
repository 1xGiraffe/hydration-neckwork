import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BorrowTab } from '../src/components/positions/BorrowTab'
import { HF_CAP, borrowCards, marketInterest, marketSeries, netApy, parseHealthFactor, reserveBorrowPct, reserveInterest, reserveSupplyPct } from '../src/components/positions/borrowMath'
import { MM_DIP, mockMoneyMarketHistory, mockMoneyMarketYields } from './fixtures/positionsMock'
import type { MmReserve, MoneyMarketPosition, ReserveYield } from '../src/types'

const HDX = { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null }
const FOX = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'

const reserve = (o: Partial<MmReserve>): MmReserve => ({ assetId: 5, symbol: 'DOT', decimals: 10, supplied: '0', debt: '0', suppliedUsd: null, debtUsd: null, collateral: false, ...o })
const ry = (o: Partial<ReserveYield>): ReserveYield => ({ supplyApyPct: 0, borrowApyPct: 0, supplyIncentives: [], borrowIncentives: [], ...o })

function position(o: Partial<MoneyMarketPosition> = {}): MoneyMarketPosition {
  return {
    marketKey: 'core', market: 'Money Market', role: 'primary', defiSimSupported: true, blockHeight: 1, timestamp: '2026-09-25 00:00:00',
    totalCollateralBase: '3000000000000', totalDebtBase: '1000000000000', availableBorrowsBase: '0', liquidationThreshold: '7800', ltv: '6500',
    healthFactor: '1800000000000000000',
    reserves: [reserve({ assetId: 43, symbol: 'PRIME', decimals: 6, supplied: '30000000000', suppliedUsd: 30_000, collateral: true }), reserve({ assetId: 1000, symbol: 'HOLLAR', decimals: 18, debt: '1', debtUsd: 10_000 })],
    ...o,
  }
}

describe('reserve rates', () => {
  it('adds supply incentives and nets borrow incentives off the cost', () => {
    expect(reserveSupplyPct(ry({ supplyApyPct: 4, supplyIncentives: [{ rewardAsset: HDX, aprPct: 1.5 }] }))).toBeCloseTo(5.5)
    expect(reserveBorrowPct(ry({ borrowApyPct: 7, borrowIncentives: [{ rewardAsset: HDX, aprPct: 1 }] }))).toBeCloseTo(6)
  })
  it('is unknown when any term is unknown', () => {
    expect(reserveSupplyPct(ry({ supplyApyPct: 4, supplyIncentives: [{ rewardAsset: HDX, aprPct: null }] }))).toBeNull()
    expect(reserveBorrowPct(ry({ borrowApyPct: null }))).toBeNull()
    expect(reserveSupplyPct(undefined)).toBeNull()
  })
})

describe('netApy', () => {
  const reserves = [
    reserve({ assetId: 43, supplied: '1', suppliedUsd: 30_000 }),
    reserve({ assetId: 1000, debt: '1', debtUsd: 10_000 }),
  ]
  it('weights each side by USD over net and splits the parts', () => {
    const r = netApy(reserves, { 43: ry({ supplyApyPct: 4, supplyIncentives: [{ rewardAsset: HDX, aprPct: 2 }] }), 1000: ry({ borrowApyPct: 8, borrowIncentives: [{ rewardAsset: HDX, aprPct: 1 }] }) })
    // (30k × 6% − 10k × (8% − 1%)) / 20k = (1800 − 700) / 20k = 5.5%
    expect(r.netPct).toBeCloseTo(5.5)
    expect(r.supplyBasePct).toBeCloseTo(6)
    expect(r.supplyIncentivePct).toBeCloseTo(3)
    expect(r.borrowBasePct).toBeCloseTo(-4)
    expect(r.borrowIncentivePct).toBeCloseTo(0.5)
    expect(r.supplyBasePct + r.supplyIncentivePct + r.borrowBasePct + r.borrowIncentivePct).toBeCloseTo(r.netPct!)
  })
  it('propagates an unknown rate, a missing yield, an unpriced side, or a non-positive net as null', () => {
    const ok = { 43: ry({ supplyApyPct: 4 }), 1000: ry({ borrowApyPct: 8 }) }
    expect(netApy(reserves, { ...ok, 1000: ry({ borrowApyPct: null }) }).netPct).toBeNull()
    expect(netApy(reserves, { 43: ok[43] }).netPct).toBeNull()
    expect(netApy(reserves, undefined).netPct).toBeNull()
    expect(netApy([reserves[0], reserve({ assetId: 1000, debt: '1', debtUsd: null })], ok).netPct).toBeNull()
    expect(netApy([reserve({ assetId: 43, supplied: '1', suppliedUsd: 5_000 }), reserves[1]], ok).netPct).toBeNull()
    expect(netApy([], ok).netPct).toBeNull()
  })
  // The Hydration UI's total supply APY: a supplied yield-bearing token (vDOT
  // inside GDOT's pool, say) adds its own accrual to the reserve's rate.
  it('counts the supplied token\'s own yield from the supply composition', () => {
    const supply = { totalAprPct: 9, farms: [], components: [
      { kind: 'mm-supply' as const, aprPct: 4 },
      { kind: 'token-yield' as const, aprPct: 3, asset: HDX },
      { kind: 'mm-incentive' as const, aprPct: 2, asset: HDX },
    ] }
    const y = { 43: ry({ supplyApyPct: 4, supplyIncentives: [{ rewardAsset: HDX, aprPct: 2 }], supply }), 1000: ry({ borrowApyPct: 8 }) }
    expect(reserveSupplyPct(y[43])).toBe(9)
    const r = netApy(reserves, y)
    // (30k × 9% − 10k × 8%) / 20k = 9.5%, of which token yield 30k × 3% / 20k = 4.5%
    expect(r.netPct).toBeCloseTo(9.5)
    expect(r.supplyAccrualPct).toBeCloseTo(4.5)
    expect(r.supplyIncentivePct).toBeCloseTo(3)
    expect(netApy(reserves, { ...y, 43: ry({ ...y[43], supply: { ...supply, totalAprPct: null } }) }).netPct).toBeNull()
  })
  it('ignores reserves the position does not hold', () => {
    const r = netApy([...reserves, reserve({ assetId: 99 })], { 43: ry({ supplyApyPct: 4 }), 1000: ry({ borrowApyPct: 8 }) })
    expect(r.netPct).toBeCloseTo((1200 - 800) / 20_000 * 100)
  })
})

describe('parseHealthFactor', () => {
  it('reads 1e18 fixed point', () => {
    expect(parseHealthFactor('1420000000000000000')).toEqual({ value: 1.42, capped: false })
  })
  it('caps and marks huge, infinite and debt-free values', () => {
    expect(parseHealthFactor('115792089237316195423570985008687907853269984665640564039457584007913129639935')).toEqual({ value: HF_CAP, capped: true })
    expect(parseHealthFactor('inf')).toEqual({ value: HF_CAP, capped: true })
    expect(parseHealthFactor('1000000000000000000', '0')).toEqual({ value: HF_CAP, capped: true })
  })
  it('is null when unknown', () => {
    expect(parseHealthFactor('unknown').value).toBeNull()
    expect(parseHealthFactor('garbage').value).toBeNull()
    expect(parseHealthFactor(null).value).toBeNull()
  })
})

describe('cumulative interest', () => {
  it('reads the grid-end totals of a market and of a (closed) reserve', () => {
    const h = mockMoneyMarketHistory()
    const core = h.markets[0]
    expect(marketInterest(core)).toEqual({ earnedUsd: core.interestEarnedUsd, paidUsd: core.interestPaidUsd, incomplete: false, unpriced: 0 })
    expect(marketInterest(undefined)).toBeNull()
    const usdt = core.reserves.find(r => r.asset.symbol === 'USDT')!
    // Closed at bucket 30: its last point predates the grid end, the totals do not.
    expect(usdt.points[usdt.points.length - 1].i).toBeLessThan(h.dates.length - 1)
    expect(reserveInterest(usdt)?.earnedUsd).toBe(usdt.interest.interestEarnedUsd)
    expect(reserveInterest(usdt)?.earnedUsd).toBeGreaterThan(usdt.points[usdt.points.length - 1].interestEarnedUsd!)
    expect(reserveInterest(undefined)).toBeNull()
  })
})

describe('marketSeries', () => {
  it('starts at the market\'s first point, nulls reserve amounts before the floor and keeps the HF there', () => {
    const h = mockMoneyMarketHistory()
    const s = marketSeries(h, h.markets[0])
    const first = h.markets[0].points[0].i
    expect(s.dates[0]).toBe(h.dates[first])
    expect(s.supplied[0]).toBeNull()
    expect(s.hf[0]).not.toBeNull()
    expect(s.supplied[s.supplied.length - 1]).toBeGreaterThan(0)
    expect(Math.min(...s.hf.filter((v): v is number => v != null))).toBeLessThan(1.5)
  })
  it('charts the lowest health factor in each bucket, not the close', () => {
    const h = mockMoneyMarketHistory()
    const m = h.markets[0]
    const s = marketSeries(h, m)
    // Bucket 38 (38 % 7 === 3) dipped sharply below its close.
    const p = m.points.find(x => x.i === 38)!
    const k = s.dates.indexOf(h.dates[38])
    const close = Number(p.observation!.healthFactor) / 1e18
    expect(s.hf[k]).toBeCloseTo(Number(p.observation!.lowestHealthFactor) / 1e18, 9)
    expect(s.hf[k]).toBeCloseTo(close - MM_DIP, 6)
  })
  it('draws the market\'s own collateral and debt before the floor only, never blended', () => {
    const h = mockMoneyMarketHistory()
    const m = h.markets[0]
    const s = marketSeries(h, m)
    const floor = s.supplied.findIndex(v => v != null)
    expect(floor).toBeGreaterThan(0)
    const o = m.points[0].observation!
    expect(s.collateralChain[0]).toBeCloseTo(Number(o.totalCollateralBase) / 1e8, 6)
    expect(s.debtChain[0]).toBeCloseTo(Number(o.totalDebtBase) / 1e8, 6)
    // Exactly complementary: the chain lines exist where the reserve lines are unknown.
    s.supplied.forEach((v, k) => {
      expect(v == null).toBe(s.collateralChain[k] != null)
      expect(s.borrowed[k] == null).toBe(s.debtChain[k] != null)
    })
  })
  it('reads an absent bucket after the floor as an empty position', () => {
    const h = mockMoneyMarketHistory()
    const m = { ...h.markets[0], points: h.markets[0].points.filter(p => p.i !== 20) }
    const s = marketSeries(h, m)
    const k = s.dates.indexOf(h.dates[20])
    expect(s.supplied[k]).toBe(0)
    expect(s.hf[k]).toBeNull()
    expect(s.collateralChain[k]).toBeNull()
  })
})

describe('borrowCards', () => {
  it('uses the current markets, primary first', () => {
    const cards = borrowCards([position({ marketKey: 'gigahdx', market: 'GIGAHDX', role: 'supplemental' }), position()], mockMoneyMarketHistory(FOX))
    expect(cards.map(c => c.marketKey)).toEqual(['core', 'gigahdx'])
    expect(cards.every(c => c.current)).toBe(true)
  })
  it('derives closed cards from history when no current market remains', () => {
    const cards = borrowCards([], mockMoneyMarketHistory(FOX))
    expect(cards.map(c => [c.marketKey, c.current])).toEqual([['core', null], ['gigahdx', null]])
    expect(cards[1].stakingBacked).toBe(true)
    expect(borrowCards([], undefined)).toEqual([])
  })
})

describe('<BorrowTab>', () => {
  function render(areas: Parameters<typeof BorrowTab>[0]['areas'], seed: Record<string, unknown>, showOwner = false) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(['explorer-yields'], { asOf: '', feeWindow: '30d', omnipool: {}, stableswap: {}, xyk: {}, uniswapV3: {}, moneyMarket: mockMoneyMarketYields() })
    for (const [addr, data] of Object.entries(seed)) qc.setQueryData(['money-market-history', addr], data)
    return renderToStaticMarkup(<QueryClientProvider client={qc}><BorrowTab areas={areas} showOwner={showOwner} /></QueryClientProvider>)
  }

  it('renders one card per market, DefiSim on the primary only, and with several cards every one collapsed', () => {
    const html = render([{ address: FOX, markets: [position(), position({ marketKey: 'gigahdx', market: 'GIGAHDX', role: 'supplemental', defiSimSupported: false, stakingBacked: true })], defisimAddress: '0xabc' }], { [FOX]: mockMoneyMarketHistory(FOX) })
    expect(html.match(/data-market-key="core"/g)).toHaveLength(1)
    expect(html.match(/data-market-key="gigahdx"/g)).toHaveLength(1)
    expect(html.match(/Open in DefiSim/g)).toHaveLength(1)
    expect(html).toContain('defisim.neckwork.net/?address=0xabc')
    // Collapsed: the summary (HF, LTV bar, KPIs) stays; no reserves table, no charts.
    expect(html.match(/class="bw-rule"[^>]*aria-expanded="false"/g)).toHaveLength(2)
    expect(html).not.toMatch(/class="bw-rule[^"]*"[^>]*aria-expanded="true"/)
    expect(html).not.toContain('data-chart="')
    expect(html).not.toContain('bw-tbl')
    expect(html.match(/class="bw-risk"/g)).toHaveLength(2)
    expect(html.match(/class="bw-hf"/g)).toHaveLength(2)
    expect(html).toContain('Interest earned')
    expect(html).toContain('Show details &amp; history')
    // The collapsed rule names what is inside: reserve count and the history span.
    expect(html).toContain('2 reserves · since ' + mockMoneyMarketHistory(FOX).dates[4].slice(0, 10))
    expect(html).toContain('/67/icon')
  })

  it('opens a lone card with its details and history, closed reserves behind a toggle', () => {
    const html = render([{ address: FOX, markets: [position()] }], { [FOX]: mockMoneyMarketHistory(FOX) })
    expect(html.match(/class="bw-rule"[^>]*aria-expanded="true"/g)).toHaveLength(1)
    expect(html.match(/data-chart="/g)).toHaveLength(2)
    expect(html).toContain('Hide details &amp; history')
    // Only current reserves are rows; the ones this position no longer holds (DOT,
    // and USDT, closed mid-window) wait behind the toggle.
    expect(html).toContain('>PRIME<')
    expect(html).not.toContain('>USDT<')
    expect(html).not.toContain('>DOT<')
    expect(html).toMatch(/class="bw-rule bw-rule-sub"[^>]*aria-expanded="false"/)
    expect(html).toContain('Show 2 closed reserves<')
    // Lowest HF subtitle and the pre-floor chain series with its note.
    expect(html).toContain('lowest in each bucket')
    expect(html).toContain('data-series="colChain"')
    expect(html).toContain('data-series="debtChain"')
    expect(html).toContain('stroke-dasharray="5 4"')
    expect(html).toContain('getUserAccountData')
  })

  it('renders history-only markets as closed cards, collapsed when there are several', () => {
    const html = render([{ address: FOX, markets: [] }], { [FOX]: mockMoneyMarketHistory(FOX) })
    expect(html.match(/bw-closed-badge/g)).toHaveLength(2)
    expect(html).not.toContain('Open in DefiSim')
    expect(html.match(/class="bw-rule"[^>]*aria-expanded="false"/g)).toHaveLength(2)
    expect(html).toContain('4 past reserves')
  })

  it('opens a lone history-only card, with every (closed) reserve behind the toggle', () => {
    const html = render([{ address: '0xdef', markets: [] }], { '0xdef': mockMoneyMarketHistory('0xdef') })
    expect(html.match(/bw-closed-badge/g)).toHaveLength(1)
    expect(html.match(/data-chart="/g)).toHaveLength(2)
    expect(html).not.toContain('bw-tbl')
    expect(html).toContain('Show 4 closed reserves')
  })

  it('names each member on a tag, draws no chart while every card is collapsed, and loads the KPI summary', () => {
    const acc = (address: string) => ({ accountId: address, address, emoji: '🦊', tag: null })
    const html = render([
      { address: FOX, account: acc(FOX), markets: [position()] },
      { address: '0xdef', account: acc('0xdef'), markets: [position()] },
    ], {}, true)
    expect(html.match(/data-market-key="core"/g)).toHaveLength(2)
    expect(html).toContain('data-address="0xdef"')
    expect(html).not.toContain('data-chart="')
    // The KPI row's history-backed figures are loading, never a dash that reads as "none".
    expect(html).toContain('<span class="k">Interest earned</span><span class="v"><span class="muted">…</span>')
  })
})
