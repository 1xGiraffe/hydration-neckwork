import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { activeDcaLimit, type ActiveDcaScheduleRow } from '../src/services/explorerService.ts'
import { assetDescriptor, loadExplorerAssets, stopExplorerAssetsRefresh } from '../src/services/explorerAssets.ts'

// A DCA order's price limit, as the list surfaces (account, tag, asset) show it.
//
// The whole point of the column is that ONE number means one thing across a table
// that mixes pallet-DCA schedules with runtime-443 DCA intents, and Buy rows with
// Sell rows. A Sell order floors what it receives; a Buy order caps what it pays.
// Those read as opposite terms, so the risk this pins is that they are quoted on
// opposite axes and a reader compares two rows that do not mean the same thing.
const registryRow = (assetId: number, symbol: string, decimals: number) => ({
  asset_id: assetId, symbol, name: symbol, decimals,
  parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null,
})
const clientWith = (rows: ReturnType<typeof registryRow>[]) => ({
  query: vi.fn(async () => ({ json: async () => rows })),
}) as never

// HDX 12 dp, USDT 6 dp — two different scales, so a limit that ignored decimals
// would be out by 10^6 rather than subtly wrong.
const HDX = 0, USDT = 10
const row = (over: Partial<ActiveDcaScheduleRow> = {}): ActiveDcaScheduleRow => ({
  id: 1, who: '0x' + '11'.repeat(32), sblock: 1, sidx: 0,
  asset_in: HDX, asset_out: USDT, direction: 'Sell',
  amt_per: '60000000000000000', total: '0', period: 100, ...over,
})
const terms = (min: string | null, max: string | null) => ({ minAmountOut: min, maxAmountIn: max, route: null })

describe('activeDcaLimit', () => {
  beforeEach(async () => {
    await loadExplorerAssets(clientWith([registryRow(HDX, 'HDX', 12), registryRow(USDT, 'USDT', 6)]))
  })
  afterEach(() => stopExplorerAssetsRefresh())

  const aIn = () => assetDescriptor(HDX)
  const aOut = () => assetDescriptor(USDT)

  // 60,000 HDX per trade for at least 400 USDT → it pays at most 150 HDX per USDT.
  it('quotes a Sell schedule as a ceiling on the price it pays', () => {
    const limit = activeDcaLimit(row(), aIn(), aOut(), terms('400000000', null))
    // No price map passed, so no market to compare against — null, never a claim.
    expect(limit).toEqual({ price: '150.000000000000', amount: '400000000', asset: 'out', marketRatio: null })
  })

  // Buy fixes the OUTPUT: buy 400 USDT per trade, paying at most 60,000 HDX. The
  // same 150 HDX per USDT — the number a reader can put beside the Sell row above.
  it('quotes a Buy schedule on the same axis, from the cap on what it pays', () => {
    const limit = activeDcaLimit(
      row({ direction: 'Buy', amt_per: '400000000' }), aIn(), aOut(), terms(null, '60000000000000000'),
    )
    expect(limit).toEqual({ price: '150.000000000000', amount: '60000000000000000', asset: 'in', marketRatio: null })
  })

  // An intent carries its floor on its own row; no placement lookup is involved.
  it('reads a DCA intent floor from the order row, not from a schedule bound', () => {
    const limit = activeDcaLimit(row({ intent_id: '77', amount_out: '400000000' }), aIn(), aOut(), undefined)
    expect(limit).toEqual({ price: '150.000000000000', amount: '400000000', asset: 'out', marketRatio: null })
  })

  // A zero bound IS no bound (dcaOrderTerms strips it to null): a floor of nothing
  // rejects nothing, and about a fifth of Sell schedules set one on purpose to rely
  // on slippage against the oracle. Reporting 0 would state a constraint that is
  // not there — and would rank as the tightest limit in the table.
  it('reports no limit rather than a limit of zero when the order set no bound', () => {
    expect(activeDcaLimit(row(), aIn(), aOut(), terms(null, null))).toBeNull()
    expect(activeDcaLimit(row(), aIn(), aOut(), undefined)).toBeNull()
    expect(activeDcaLimit(row({ intent_id: '77', amount_out: '0' }), aIn(), aOut(), undefined)).toBeNull()
  })

  // A Buy row whose cap could not be read is not a Sell row in disguise: its
  // per-trade amount is the OUTPUT, so pairing it with a missing cap must yield
  // nothing rather than a price built from the wrong leg.
  it('reports no limit for a Buy order whose cap is unreadable', () => {
    expect(activeDcaLimit(row({ direction: 'Buy', amt_per: '400000000' }), aIn(), aOut(), terms('400000000', null))).toBeNull()
  })

  // The registry answers an unknown id with a 12-decimal placeholder, which would
  // silently misscale the price (see assetDecimalsOrNull).
  it('reports no limit when an asset is outside the registry', () => {
    const unknown = { ...aOut(), assetId: 987654 }
    expect(activeDcaLimit(row({ asset_out: 987654 }), aIn(), unknown, terms('400000000', null))).toBeNull()
  })

  // The ratio is what lets a surface say whether the stated limit is the constraint
  // the order actually runs under. A ceiling far above market cannot reject a fill.
  it('reports how the limit compares with the market when prices are known', () => {
    const prices = new Map([
      [HDX, { price: 1, change24h: 0 }],
      [USDT, { price: 150, change24h: 0 }],
    ])
    // Market: 150 HDX per USDT, and the order's ceiling is exactly 150 -> on market.
    const onMarket = activeDcaLimit(row(), aIn(), aOut(), terms('400000000', null), prices)
    expect(onMarket?.marketRatio).toBeCloseTo(1, 6)
  })
})
