import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { downsampleDaily, isHdxLpPosition, type LpPosition } from '../src/services/explorerService.ts'
import { showsExHdxValue } from '../src/services/tagService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

const fn = (name: string) => {
  const at = explorerService.indexOf(`async function ${name}(`)
  expect(at, name).toBeGreaterThan(-1)
  return explorerService.slice(at, explorerService.indexOf('\n}\n', at))
}

const assetRef = (assetId: number) => ({
  assetId, iconAssetId: assetId, symbol: `A${assetId}`, name: null, decimals: 12,
  parachainId: null, origin: null,
})
const lp = (assetId: number, assetB?: number): LpPosition => ({
  positionId: `p${assetId}`, asset: assetRef(assetId), amount: '1', shares: '1', valueUsd: 100,
  venue: assetB == null ? 'Omnipool' : 'XYK',
  ...(assetB == null ? {} : { assetB: assetRef(assetB), amountB: '1' }),
})

// The Treasury holds ~2/3 of its value in HDX, so its plain value curve mostly
// reports the HDX price. The ex-HDX reading is the diversified-reserve view beside
// it — and it is only honest if the exclusion reaches HDX everywhere it enters the
// portfolio, which is three separate places, not one.
describe('the ex-HDX exclusion covers every path HDX takes into the portfolio', () => {
  // The trap this whole feature can fall into: subtracting the HDX wallet balance
  // and calling it done. HDX also arrives as an Omnipool position (the Treasury's
  // is ~$1.2M) and as an XYK pool leg, so a wallet-only exclusion would leave the
  // "ex-HDX" line still riding the HDX price — wrong in a way nothing would show.
  it('excludes HDX from the Omnipool principal, not just the wallet balance', () => {
    const body = fn('getAccountHistory')
    // The wallet leg.
    expect(body).toContain('if (exHdx) portfolioExHdx[b] += portfolioCombined[b] * (lastPx || 0)')
    // The Omnipool leg, dropped with its hub half — that leg is part of the excluded
    // position's withdraw value, not H2O the account holds separately.
    expect(body).toContain('if (leg.assetId !== HDX_ASSET_ID) portfolioExHdx[b] += withdrawValue')
    // The XYK leg: a share is a claim on both reserves, so an HDX-paired pool leaves
    // the curve whole rather than contributing its other half.
    expect(body).toContain('if (st.assetA !== HDX_ASSET_ID && st.assetB !== HDX_ASSET_ID) portfolioExHdx[b] += nav')
  })

  // Pinned by count so a NEW value source added to the total curve cannot quietly
  // skip the second one: every `portfolio[b] +=` site must have made a decision
  // about `portfolioExHdx[b]`. Four sites — balances, XYK NAV, the money-market
  // fold, Omnipool principal.
  it('feeds both curves from every value source', () => {
    const body = fn('getAccountHistory')
    const total = [...body.matchAll(/\bportfolio\[b\] \+=/g)]
    const exHdx = [...body.matchAll(/\bportfolioExHdx\[b\] \+=/g)]
    expect(total).toHaveLength(4)
    expect(exHdx).toHaveLength(4)
  })

  // The exclusion is HDX and HDX LP only. Netting the same money-market debt off
  // both is what makes the two headline figures comparable at all — an ex-HDX
  // figure that skipped the debt would read as a larger reserve than exists.
  it('applies the identical money-market fold to both curves', () => {
    const body = fn('getAccountHistory')
    expect(body).toContain('portfolio[b] += mmNet[b]; portfolioExHdx[b] += mmNet[b]')
  })
})

describe('isHdxLpPosition', () => {
  // Omnipool names one asset (plus an implicit hub leg); XYK names two, and HDX in
  // either slot makes the position an HDX LP.
  it('matches HDX in either leg', () => {
    expect(isHdxLpPosition(lp(0))).toBe(true)
    expect(isHdxLpPosition(lp(5, 0))).toBe(true)
    expect(isHdxLpPosition(lp(0, 5))).toBe(true)
  })

  it('leaves every other position in', () => {
    expect(isHdxLpPosition(lp(5))).toBe(false)
    expect(isHdxLpPosition(lp(5, 22))).toBe(false)
    // Asset 1 is H2O, which stays in: it is earned hub value the Treasury spends on
    // buybacks, not HDX it holds.
    expect(isHdxLpPosition(lp(1))).toBe(false)
  })
})

describe('the two curves stay index-aligned', () => {
  // Both series index the SAME `dates` array, so the daily collapse has to keep one
  // point set. Picking each day's last bucket per series independently would let the
  // two disagree about which instant a point is, and the chart would then draw a gap
  // between values from different moments.
  it('collapses both series on the same kept buckets', () => {
    const dates = [
      '2026-09-01 06:00:00', '2026-09-01 18:00:00',
      '2026-09-02 06:00:00',
      '2026-09-03 06:00:00', '2026-09-03 12:00:00', '2026-09-03 23:00:00',
    ]
    const out = downsampleDaily([10, 11, 20, 30, 31, 32], [1, 2, 3, 4, 5, 6], dates, [100, 101, 200, 300, 301, 302])
    // One point per calendar day, each holding that day's LAST bucket.
    expect(out.dates).toEqual(['2026-09-01 18:00:00', '2026-09-02 06:00:00', '2026-09-03 23:00:00'])
    expect(out.series).toEqual([11, 20, 32])
    expect(out.exHdx).toEqual([2, 3, 6])
    expect(out.blocks).toEqual([101, 200, 302])
    expect(out.exHdx).toHaveLength(out.series.length)
  })

  // The trim runs off the TOTAL curve's first non-zero bucket, so the ex-HDX curve
  // keeps its own leading zeros: an account that held only HDX at first really was
  // worth nothing without it, and cutting those points would shorten one array.
  it('trims the ex-HDX curve at the total curve start', () => {
    const body = fn('getAccountHistory')
    expect(body).toContain('const rawSeriesExHdx = portfolioExHdx.slice(start)')
  })
})

describe('the second reading is shipped only where it means something', () => {
  it('flags the Treasury and nothing else', () => {
    expect(showsExHdxValue('treasury')).toBe(true)
    expect(showsExHdxValue('polkadot-treasury')).toBe(false)
    expect(showsExHdxValue('kraken')).toBe(false)
    expect(showsExHdxValue(null)).toBe(false)
    expect(showsExHdxValue(undefined)).toBe(false)
  })

  // A user list-tag is an arbitrary, live-editable member set. Deriving the flag
  // from `presentation.tagId` inside the shared builder would let a list-tag named
  // `treasury` claim the registry Treasury's second reading, so getTag passes it in.
  it('takes the flag from the registry, never from the presented tag id', () => {
    const build = fn('buildTagDetailForMembers')
    expect(build).toContain('opts.exHdx')
    expect(build).not.toContain('showsExHdxValue')
    expect(explorerService).toContain('exHdx: showsExHdxValue(tagId),')
  })
})

// The same OTC rule the indexer applies has to hold in the two API-side mirrors,
// or the explorer's Trading stat and the data API's fill feed keep reporting a
// resting seller as a buyer. See src/blocks/otcCounterparty.ts for the evidence.
describe('the API-side OTC mirrors resolve the same two sides', () => {
  const accountTradeVolume = readFileSync(new URL('../src/services/accountTradeVolume.ts', import.meta.url), 'utf8')
  const otcSides = readFileSync(new URL('../src/data/services/otcSides.ts', import.meta.url), 'utf8')
  const swapFills = readFileSync(new URL('../src/data/services/swapFills.ts', import.meta.url), 'utf8')

  // account_trade_volume: the netting SQL must pair each OTC Broadcast fill with
  // the pallet fill event at event_index - 1 and book BOTH accounts — the taker
  // with the legs and the maker with them negated.
  it('pairs the fill event and books both sides in the netting SQL', () => {
    expect(accountTradeVolume).toContain("const OTC_FILL_EVENTS = \"'OTC.Filled','OTC.PartiallyFilled'\"")
    // The sibling-event join: the pallet event's index + 1 is the Broadcast's.
    expect(accountTradeVolume).toContain('event_index + 1 AS bc_index')
    expect(accountTradeVolume).toContain('t.bc_index = e.event_index')
    // Principal picks the taker out of {swapper, filler}; the passive side is the other.
    expect(accountTradeVolume).toContain('t.taker = e.swapper, e.swapper')
    expect(accountTradeVolume).toContain('t.taker = e.filler_acct, e.filler_acct')
    expect(accountTradeVolume).toContain('AS passive')
    // The maker's two arms carry the OPPOSITE signs to the principal's.
    expect(accountTradeVolume).toContain('-toDecimal256(${outAmount}, 0)')
    expect(accountTradeVolume).toContain('toDecimal256(${inAmount}, 0)')
    expect([...accountTradeVolume.matchAll(/WHERE passive != ''/g)]).toHaveLength(2)
  })

  // The legs table is MV-fed, and an insert-trigger MV cannot read the sibling
  // event, so the data API resolves the sides on the way out instead. The index
  // must never be built from a head-less cache key, or a just-indexed fill is
  // served from a stale one.
  it('keys the data-API side index on the indexed head', () => {
    expect(otcSides).toContain('liveHeadTag(client)')
    expect(otcSides).toContain('`data:otc-sides:${head}`')
    // A taker that is neither named account leaves a fill out rather than half-resolved.
    expect(otcSides).toContain('WHERE f.taker IN (b.swapper, b.filler_account)')
  })

  it('reports the taker as swapper and the maker as counterparty', () => {
    expect(swapFills).toContain('accountRefOrNull(otcResolved.taker)')
    expect(swapFills).toContain('counterparty: otcResolved ? accountRefOrNull(otcResolved.maker) : null')
    // An account filter matches either side, since the stored swapper is only one
    // of the two and not reliably the one asked about.
    expect(swapFills).toContain('OR (block_height, event_index) IN arrayZip({otcBlocks:Array(UInt32)}')
    // Neither read happens on a page that cannot hold an OTC fill.
    expect(swapFills).toContain("scope.venue == null || scope.venue === 'otc'")
    expect(swapFills).toContain("legs.some(leg => leg.venue === 'otc')")
  })
})
