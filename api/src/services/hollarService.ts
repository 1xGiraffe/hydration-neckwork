import type { ClickHouseClient } from '../db/client.ts'
import { cachedSwr } from './cache.ts'
import { ensurePrices, getAtokenSuppliedDailyHistory, getMoneyMarketReserves, mmMarkets, type AssetRef, type PriceInfo } from './explorerService.ts'
import { assetDescriptor } from './explorerAssets.ts'
import { parsePoolAssetIds } from './stableswapSnapshot.ts'
import { alignMonthly, carryForward } from './hdxService.ts'

// HOLLAR (asset 222) dashboard — peg, HSM (HOLLAR Stability Module) state and
// stableswap-pool liquidity. CH-only: no substrate RPC. HSM collateral params
// come from events; pool reserves from the block-snapshot payload; and the
// HSM's aToken holdings from the same anchor+event-forward reconstruction the
// account pages use — aTokens rebase in EVM contract storage and never appear
// in the event-folded balance tables.

let client: ClickHouseClient
export function initHollarService(c: ClickHouseClient): void { client = c }

const HOLLAR_ASSET_ID = 222
// modl + "py/hsmod" — the HSM pallet's holding account for approved collaterals.
const HSM_ACCOUNT = '0x6d6f646c70792f68736d6f640000000000000000000000000000000000000000'
// modl + "omnipool" — the Omnipool pallet account.
const OMNIPOOL_ACCOUNT = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'
const PEG_WINDOW_DAYS = 30
const CHART_WINDOW_DAYS = 60

const asset = (id: number): AssetRef => assetDescriptor(id)

function safeJsonObj(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? v as Record<string, unknown> : {}
  } catch { return {} }
}

function usdOf(prices: Map<number, PriceInfo>, assetId: number, raw: string, decimals: number): number | null {
  const p = prices.get(assetId)
  if (!p) return null
  const amt = Number(raw) / 10 ** decimals
  return Number.isFinite(amt) ? amt * p.price : null
}

// Emit a continuous `n`-day axis (today inclusive), same idiom as the explorer's
// other daily charts — sparse days (arb/trade quiet periods) render as zero
// rather than compressing the timeline.
function fillDays<T>(n: number, make: (date: string) => T): T[] {
  const day = 86_400_000
  const today = Math.floor(Date.now() / day) * day
  return Array.from({ length: n }, (_, i) => make(new Date(today - (n - 1 - i) * day).toISOString().slice(0, 10)))
}

// pure helpers (unit-tested)

// HSM.ArbitrageExecuted `arbitrage` byte → direction:
// 1 = HollarOut (pool short of HOLLAR → HSM mints/sells HOLLAR into the
// pool), 2 = HollarIn (pool oversupplied → HSM buys HOLLAR back and burns).
export function arbDirectionFromRaw(raw: number): 'in' | 'out' | null {
  if (raw === 1) return 'out'
  if (raw === 2) return 'in'
  return null
}

export interface RawHsmCollateralEvent { block: number; name: string; args: Record<string, unknown> }
export interface FoldedHsmCollateral {
  assetId: number
  poolId: number | null
  purchaseFeePermill: number
  maxBuyPriceCoefficientRaw: string
  buyBackFeePermill: number
  buybackRatePerbill: number
  maxInHoldingRaw: string | null
}

// Option<T> as serialized by the indexer: `{ __kind: 'Some', value }` | `{ __kind: 'None' }`.
function optionValue(opt: unknown): string | null {
  if (opt && typeof opt === 'object' && '__kind' in (opt as Record<string, unknown>)) {
    const o = opt as { __kind?: string; value?: unknown }
    return o.__kind === 'Some' && o.value != null ? String(o.value) : null
  }
  return null
}

// Folds HSM.CollateralAdded + HSM.CollateralUpdated + HSM.CollateralRemoved
// (ordered ascending by
// block/event index) into each collateral's CURRENT parameters. CollateralUpdated
// only carries the fields that were touched by that call (Option<T> per field —
// an absent key means "unchanged"); maxInHolding is Option<Option<Balance>>, so
// an explicit `{__kind:'None'}` clears a previously-set cap.
//
// CollateralRemoved deletes the entry outright: a delisted collateral is not a
// collateral with different parameters, and the HSM will neither buy nor sell
// it. Deleting (rather than flagging) is also what makes a later re-add start
// from defaults instead of inheriting the retired parameters. The event name is
// the only possible discriminator here — CollateralRemoved carries just
// `assetId`, which is byte-identical to a no-op CollateralUpdated.
//
// buyBackFee is Permill (1e6 denom) and buybackRate is Perbill (1e9 denom).
// Folding every update chronologically yields the current values even when an
// older event assigned the two fields differently. This is covered by
// hollarService.test.ts.
// At values 100 and 100000 respectively, both rates are 0.01%.
export function foldHsmCollateralParams(events: RawHsmCollateralEvent[]): Map<number, FoldedHsmCollateral> {
  const byAsset = new Map<number, FoldedHsmCollateral>()
  for (const e of events) {
    const a = e.args
    const assetId = Number(a.assetId)
    if (!Number.isFinite(assetId)) continue
    if (e.name === 'HSM.CollateralRemoved') { byAsset.delete(assetId); continue }
    const prev = byAsset.get(assetId)
    byAsset.set(assetId, {
      assetId,
      poolId: typeof a.poolId === 'number' ? a.poolId : prev?.poolId ?? null,
      purchaseFeePermill: typeof a.purchaseFee === 'number' ? a.purchaseFee : prev?.purchaseFeePermill ?? 0,
      maxBuyPriceCoefficientRaw: typeof a.maxBuyPriceCoefficient === 'string' ? a.maxBuyPriceCoefficient : prev?.maxBuyPriceCoefficientRaw ?? '0',
      buyBackFeePermill: typeof a.buyBackFee === 'number' ? a.buyBackFee : prev?.buyBackFeePermill ?? 0,
      buybackRatePerbill: typeof a.buybackRate === 'number' ? a.buybackRate : prev?.buybackRatePerbill ?? 0,
      maxInHoldingRaw: 'maxInHolding' in a ? optionValue(a.maxInHolding) : (prev?.maxInHoldingRaw ?? null),
    })
  }
  return byAsset
}

export interface HsmSwapArgs {
  fillerType?: { __kind?: string } | null
  inputs?: { asset: number; amount: string }[]
  outputs?: { asset: number; amount: string }[]
}
export interface HsmSwapClassification { direction: 'bought' | 'sold'; hollarAmountRaw: string }

// Broadcast.Swapped3 classification for HSM-filled user trades (no dedicated
// HSM pallet event exists for these). HOLLAR (222) on the `inputs` side means
// the user sold HOLLAR to HSM (burn); on `outputs` means the user bought
// HOLLAR from HSM (mint). Non-HSM fillers are ignored.
export function classifyHsmSwap(args: HsmSwapArgs): HsmSwapClassification | null {
  if (args.fillerType?.__kind !== 'HSM') return null
  const sold = args.inputs?.find(i => i.asset === HOLLAR_ASSET_ID)
  if (sold) return { direction: 'sold', hollarAmountRaw: sold.amount }
  const bought = args.outputs?.find(o => o.asset === HOLLAR_ASSET_ID)
  if (bought) return { direction: 'bought', hollarAmountRaw: bought.amount }
  return null
}

// response shape

export interface HollarPegPoint { ts: string; close: number }
export interface HollarCollateral {
  asset: AssetRef
  poolId: number
  holdings: string
  holdingsUsd: number | null
  purchaseFeePct: number
  buyBackFeePct: number
  maxBuyPrice: number
  buybackRatePct: number
  maxInHolding: string | null
  lastArbTs: string | null
  lastArbDirection: 'in' | 'out' | null
}
// One collateral's balance in the HSM, daily since launch (null before the
// reconstruction reaches back — see getAtokenSuppliedDailyHistory).
export interface HollarReserveSeries { asset: AssetRef; values: (number | null)[] }
export interface HollarArbDay { date: string; hollarIn: number; hollarOut: number }
export interface HollarTradeDay { date: string; bought: number; sold: number }
export interface HollarPool {
  poolId: number
  tvlUsd: number | null
  hollar: { amount: number; usd: number | null }
  // One entry per non-HOLLAR asset in the pool — most pools have exactly one
  // partner, but N-asset pools exist (e.g. pool 105 = HOLLAR/USDC/USDT).
  partners: { asset: AssetRef; amount: number; usd: number | null }[]
  hollarSharePct: number | null
}
// Full-era weekly/monthly trend series (HOLLAR launched 2025-09-22). All
// balance-shaped series come from erc20_transfer_deltas — HOLLAR lives almost
// entirely on its ERC-20 side (the substrate Tokens tables see < 0.3% of it),
// and the zero address's running balance is minted supply. Debt is
// reconstructed Aave-style: scaled Borrow/Repay/LiquidationCall amounts × the
// variable borrow index. Nulls mark weeks before a series starts.
export interface HollarTrends {
  weeks: string[]
  composition: { stableswap: number[]; omnipool: number[]; protocol: number[]; bridged: number[]; wallets: number[] }
  holders: (number | null)[]            // accounts holding > 0.01 HOLLAR
  peg: { close: (number | null)[]; low: (number | null)[]; high: (number | null)[] } // weekly USD price band
  debt: (number | null)[]               // HOLLAR borrowed, all markets
  borrowers: (number | null)[]          // accounts with > 0.5 HOLLAR open debt
  revenueCumUsd: (number | null)[]      // cumulative hollar_borrow revenue
  depth: { stableswap: (number | null)[]; omnipool: (number | null)[] } // HOLLAR in pools
  months: string[]
  stableSharePct: (number | null)[]     // HOLLAR share of stable-vs-stable trade volume
  pegStats: { uptime50Pct: number; uptime25Pct: number; maxAbsDevBps: number } | null
  // Borrow-rate step history per market, ordered by market launch (core first).
  rates: { label: string; pct: number; prevPct: number | null; since: string }[]
}

export interface HollarDashboard {
  price: number | null
  change24h: number | null
  pegDeviationBps: number | null
  peg: { hourly: HollarPegPoint[]; within25bpsPct: number | null; maxDevBps: number | null; min30d: number | null; max30d: number | null }
  supply: { total: number; holders: number; inStablepools: number; inOmnipool: number; other: number }
  hsm: {
    totalHoldingsUsd: number
    collaterals: HollarCollateral[]
    reserveHistory: { days: string[]; series: HollarReserveSeries[] }
    arbitrageDaily: HollarArbDay[]
    tradesDaily: HollarTradeDay[]
    lastArb: { ts: string; direction: 'in' | 'out'; asset: AssetRef; hollarAmount: number } | null
  }
  pools: HollarPool[]
  trends: HollarTrends
}

// ClickHouse loaders

async function loadPeg(): Promise<HollarDashboard['peg']> {
  const res = await client.query({
    query: `
      SELECT toString(interval_start) AS ts, toFloat64(argMaxMerge(close_state)) AS close
      FROM price_data.ohlc_1h
      WHERE asset_id = {id:UInt32} AND interval_start >= now() - INTERVAL ${PEG_WINDOW_DAYS} DAY
      GROUP BY interval_start ORDER BY interval_start`,
    query_params: { id: HOLLAR_ASSET_ID },
    format: 'JSONEachRow',
  })
  const hourly = (await res.json<{ ts: string; close: number }>()).map(r => ({ ts: r.ts, close: Number(r.close) }))
  if (!hourly.length) return { hourly, within25bpsPct: null, maxDevBps: null, min30d: null, max30d: null }
  const devs = hourly.map(h => (h.close - 1) * 10000)
  const within25bpsPct = devs.filter(d => Math.abs(d) <= 25).length / devs.length * 100
  const maxDevBps = devs.reduce((worst, d) => (Math.abs(d) > Math.abs(worst) ? d : worst), devs[0])
  const closes = hourly.map(h => h.close)
  return { hourly, within25bpsPct, maxDevBps, min30d: Math.min(...closes), max30d: Math.max(...closes) }
}

// HOLLAR balances can exist on both the EVM ERC-20 and Substrate Tokens sides, so
// the current ERC-20 snapshot combines with indexed Tokens balances. Each account's
// two pots are folded before it is counted, so a holder with both is one holder —
// the same grouping getAssetHolderCounts uses for the asset directory.
export function hollarSupplySql(): string {
  return `
      SELECT
        toString(sum(bal)) AS total,
        count() AS holders,
        toString(sumIf(bal, account_id = {omnipool:String})) AS omnipool_bal
      FROM (
        SELECT account_id, sum(bal) AS bal FROM (
          SELECT account_id, toUInt256OrZero(argMaxMerge(total_state)) AS bal
          FROM price_data.account_asset_latest_balances WHERE asset_id = {id:String}
          GROUP BY account_id
          UNION ALL
          SELECT account_id, toUInt256OrZero(argMax(total, updated_at)) AS bal
          FROM price_data.erc20_wallet_balances WHERE asset_id = {id:String}
          GROUP BY account_id
        )
        GROUP BY account_id
      )
      WHERE bal > 0`
}

async function loadSupply(): Promise<{ total: number; holders: number; omnipool: number }> {
  const res = await client.query({
    query: hollarSupplySql(),
    query_params: { id: String(HOLLAR_ASSET_ID), omnipool: OMNIPOOL_ACCOUNT },
    format: 'JSONEachRow',
  })
  const row = (await res.json<{ total: string; holders: string; omnipool_bal: string }>())[0]
  return {
    total: Number(row?.total ?? 0) / 1e18,
    holders: Number(row?.holders ?? 0),
    omnipool: Number(row?.omnipool_bal ?? 0) / 1e18,
  }
}

interface HollarStablePool { poolId: number; hollarRaw: bigint; partners: { assetId: number; raw: bigint }[] }
export { parsePoolAssetIds }

// Every stableswap pool containing HOLLAR (110/HUSDC, 111/HUSDT, 112/HUSDS,
// 113/HUSDe, 105/HOLLAR-USDC-USDT today, plus any future pool — discovered
// dynamically from the latest block-snapshot payload rather than a fixed
// list). Pools of any size are supported: every non-HOLLAR asset becomes a
// `partners` entry (most HOLLAR pools pair it with exactly one collateral,
// but pool 105 is a live 3-asset pool holding ~255k HOLLAR against USDC+USDT).
async function loadHollarStablePools(): Promise<HollarStablePool[]> {
  const res = await client.query({
    query: `SELECT JSONExtractRaw(payload_json, 'stableswap') AS ss FROM price_data.raw_block_snapshots
            WHERE block_height = (SELECT max(block_height) FROM price_data.raw_block_snapshots) LIMIT 1`,
    format: 'JSONEachRow',
  })
  const row = (await res.json<{ ss: string }>())[0]
  const pools = (safeJsonObj(row?.ss).pools as { pool_id: number; assets: string | number[]; reserves: string[] }[] | undefined) ?? []
  const out: HollarStablePool[] = []
  for (const p of pools) {
    try {
      const ids = parsePoolAssetIds(p.assets)
      if (!p.reserves || p.reserves.length !== ids.length) continue
      const hollarIdx = ids.indexOf(HOLLAR_ASSET_ID)
      if (hollarIdx === -1) continue
      const partners = ids
        .map((assetId, i) => ({ assetId, raw: BigInt(p.reserves[i]) }))
        .filter((_, i) => i !== hollarIdx)
      out.push({ poolId: p.pool_id, hollarRaw: BigInt(p.reserves[hollarIdx]), partners })
    } catch { /* malformed pool entry — skip */ }
  }
  return out
}

async function loadHsmCollateralEvents(): Promise<RawHsmCollateralEvent[]> {
  const res = await client.query({
    query: `SELECT block_height AS block, event_name AS name, args_json
            FROM price_data.hsm_activity FINAL
            WHERE event_name IN ('HSM.CollateralAdded', 'HSM.CollateralUpdated', 'HSM.CollateralRemoved')
            ORDER BY block_height ASC, event_index ASC`,
    format: 'JSONEachRow',
  })
  return (await res.json<{ block: number; name: string; args_json: string }>()).map(r => ({ block: r.block, name: r.name, args: safeJsonObj(r.args_json) }))
}

// Reconstructed aToken balances win where present, because the event fold is
// blind to aToken movements (EVM-side transfers + rebasing interest); the fold
// covers everything else and is the fallback when the reconstruction has no
// entry (non-aToken collaterals, emptied reserves, missing anchor).
export function mergeHsmHoldings(assetIds: number[], reconstructed: Map<number, bigint>, folded: Map<number, string>): Map<number, string> {
  const m = new Map<number, string>()
  for (const id of assetIds) {
    const rec = reconstructed.get(id)
    m.set(id, rec != null ? rec.toString() : folded.get(id) ?? '0')
  }
  return m
}

async function loadHsmHoldings(assetIds: number[]): Promise<Map<number, string>> {
  if (!assetIds.length) return new Map()
  // The HSM pallet account's EVM alias (address truncation) — its aToken
  // holdings are money-market "supplied" positions in the indexed anchor+delta
  // reconstruction, keyed by the display aToken asset id.
  const hsmH160 = '0x' + HSM_ACCOUNT.slice(2, 42)
  const [reserves, res] = await Promise.all([
    getMoneyMarketReserves(hsmH160),
    client.query({
      query: `SELECT asset_id, toString(toUInt256OrZero(argMaxMerge(total_state))) AS bal
              FROM price_data.account_asset_latest_balances
              WHERE account_id = {hsm:String} AND asset_id IN {ids:Array(String)}
              GROUP BY asset_id`,
      query_params: { hsm: HSM_ACCOUNT, ids: assetIds.map(String) },
      format: 'JSONEachRow',
    }),
  ])
  const reconstructed = new Map<number, bigint>()
  for (const r of reserves) if (r.assetId >= 0 && r.supplied !== '0') reconstructed.set(r.assetId, BigInt(r.supplied))
  const folded = new Map<number, string>()
  for (const r of await res.json<{ asset_id: string; bal: string }>()) folded.set(Number(r.asset_id), r.bal)
  return mergeHsmHoldings(assetIds, reconstructed, folded)
}

// The HSM's collateral reserves through time. Every approved collateral is held
// as an aToken (the pallet's substrate pots are empty — supplying the collateral
// to the money market is what earns on it), so the whole balance is the aToken
// reconstruction for the pallet account's EVM alias, per day. Includes a delisted
// collateral's history: the series follow what the account HELD, not the current
// collateral list. Largest current holding first, the order the stacked chart
// draws bottom-up.
async function loadHsmReserveHistory(days: string[]): Promise<HollarReserveSeries[]> {
  const hsmH160 = '0x' + HSM_ACCOUNT.slice(2, 42)
  const series = await getAtokenSuppliedDailyHistory(hsmH160, days)
  const last = (values: (number | null)[]): number => {
    for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return values[i]!
    return 0
  }
  return series
    .map(s => ({
      asset: s.asset,
      values: s.values.map(v => (v == null ? null : Number(v) / 10 ** s.asset.decimals)),
    }))
    .sort((a, b) => last(b.values) - last(a.values))
}

interface LastArb { ts: string; direction: 'in' | 'out'; hollarAmount: number }
// True (unbounded) last-arbitrage-per-asset — the 60d chart window can miss a
// collateral that simply hasn't needed rebalancing recently, so this is a
// separate argMax query rather than derived from the bounded daily series.
async function loadLastArbByAsset(): Promise<Map<number, LastArb>> {
  const res = await client.query({
    query: `SELECT JSONExtractInt(args_json, 'assetId') AS asset_id,
              argMax(toString(block_timestamp), block_height) AS ts,
              argMax(JSONExtractInt(args_json, 'arbitrage'), block_height) AS dir,
              argMax(JSONExtractString(args_json, 'hollarAmount'), block_height) AS amt
            FROM price_data.hsm_activity FINAL WHERE event_name = 'HSM.ArbitrageExecuted'
            GROUP BY asset_id`,
    format: 'JSONEachRow',
  })
  const m = new Map<number, LastArb>()
  for (const r of await res.json<{ asset_id: number; ts: string; dir: number; amt: string }>()) {
    const direction = arbDirectionFromRaw(r.dir)
    if (direction) m.set(r.asset_id, { ts: r.ts, direction, hollarAmount: Number(r.amt) / 1e18 })
  }
  return m
}

async function loadArbitrageDaily(): Promise<HollarArbDay[]> {
  const res = await client.query({
    query: `SELECT toString(toDate(block_timestamp)) AS d, JSONExtractInt(args_json, 'arbitrage') AS dir,
              toString(sum(toUInt256OrZero(JSONExtractString(args_json, 'hollarAmount')))) AS raw
            FROM price_data.hsm_activity FINAL
            WHERE event_name = 'HSM.ArbitrageExecuted' AND block_timestamp >= now() - INTERVAL ${CHART_WINDOW_DAYS} DAY
            GROUP BY d, dir`,
    format: 'JSONEachRow',
  })
  const byDay = new Map<string, { hollarIn: number; hollarOut: number }>()
  for (const r of await res.json<{ d: string; dir: number; raw: string }>()) {
    const direction = arbDirectionFromRaw(r.dir)
    if (!direction) continue
    const e = byDay.get(r.d) ?? { hollarIn: 0, hollarOut: 0 }
    if (direction === 'in') e.hollarIn += Number(r.raw) / 1e18
    else e.hollarOut += Number(r.raw) / 1e18
    byDay.set(r.d, e)
  }
  return fillDays(CHART_WINDOW_DAYS, d => ({ date: d, ...(byDay.get(d) ?? { hollarIn: 0, hollarOut: 0 }) }))
}

async function loadTradesDaily(): Promise<HollarTradeDay[]> {
  const res = await client.query({
    query: `SELECT toString(toDate(block_timestamp)) AS d, args_json
            FROM price_data.hsm_activity FINAL
            WHERE event_name = 'Broadcast.Swapped3' AND block_timestamp >= now() - INTERVAL ${CHART_WINDOW_DAYS} DAY
              AND args_json LIKE '%"HSM"%'`,
    format: 'JSONEachRow',
  })
  const byDay = new Map<string, { bought: number; sold: number }>()
  for (const r of await res.json<{ d: string; args_json: string }>()) {
    const cls = classifyHsmSwap(safeJsonObj(r.args_json) as unknown as HsmSwapArgs)
    if (!cls) continue
    const e = byDay.get(r.d) ?? { bought: 0, sold: 0 }
    const amt = Number(cls.hollarAmountRaw) / 1e18
    if (cls.direction === 'bought') e.bought += amt
    else e.sold += amt
    byDay.set(r.d, e)
  }
  return fillDays(CHART_WINDOW_DAYS, d => ({ date: d, ...(byDay.get(d) ?? { bought: 0, sold: 0 }) }))
}

// full-era trends

const HOLLAR_LAUNCH_MONDAY = '2025-09-22' // the genesis mint's week (a Monday)
const HOLLAR_ERC20 = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const ZERO_H160 = '0x0000000000000000000000000000000000000000'
// The stable assets HOLLAR competes with (USDT/USDC/aUSD*/sUSD*/HUSD*
// families, decimals-normalized in-query). LP share tokens are excluded so a
// pool deposit doesn't double-count as volume.
const STABLE_SET = [7, 10, 21, 22, 23, 45, 46, 222, 1002, 1003, 1046, 1110, 1111, 1112, 1113, 1000625, 1000626, 1000745, 1000766, 1000767]

// Monday grid from launch to now, in TS so a fresh database aligns to nulls.
function hollarWeekGrid(): string[] {
  const start = new Date(`${HOLLAR_LAUNCH_MONDAY}T00:00:00Z`).getTime()
  const out: string[] = []
  for (let t = start; t <= Date.now(); t += 7 * 86_400_000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}
// Day grid on the same launch anchor, for the HSM reserve history — a stock that
// moves with every arbitrage, so a weekly close would hide most of its motion.
function hollarDayGrid(): string[] {
  const start = new Date(`${HOLLAR_LAUNCH_MONDAY}T00:00:00Z`).getTime()
  const out: string[] = []
  for (let t = start; t <= Date.now(); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}
function hollarMonthGrid(): string[] {
  const out: string[] = []
  const d = new Date(`${HOLLAR_LAUNCH_MONDAY.slice(0, 7)}-01T00:00:00Z`)
  while (d.getTime() <= Date.now()) { out.push(d.toISOString().slice(0, 10)); d.setUTCMonth(d.getUTCMonth() + 1) }
  return out
}

async function loadHollarTrends(): Promise<HollarTrends> {
  return cachedSwr('explorer:hollar-trends:model', 3_600_000, 48 * 3_600_000, async () => {
    // Supply composition, weekly cumulative per destination class. Tags match
    // on the H160 truncation (first 20 bytes of the substrate account id);
    // modl/sibl prefixes survive the truncation, so bridge sovereigns and
    // pallet pots classify even without a tag row.
    const compositionQuery = client.query({
      query: `
        WITH tags AS (
          SELECT substring(account_id, 1, 42) AS h, any(label_id) AS lbl
          FROM price_data.account_tags FINAL
          WHERE label_id IN ('stableswap-pools','omnipool','money-market','pallet-pots','treasury','liquidity-mining','incentive-pot','contracts','sovereigns','xyk-pools','lbp-pools')
          GROUP BY h)
        SELECT toString(w) AS week,
          round(sum(sumIf(d, cat = 'stableswap')) OVER (ORDER BY w) / 1e18, 0) AS stableswap,
          round(sum(sumIf(d, cat = 'omnipool'))   OVER (ORDER BY w) / 1e18, 0) AS omnipool,
          round(sum(sumIf(d, cat = 'bridged'))    OVER (ORDER BY w) / 1e18, 0) AS bridged,
          round(sum(sumIf(d, cat = 'protocol'))   OVER (ORDER BY w) / 1e18, 0) AS protocol,
          round(sum(sumIf(d, cat = 'wallets'))    OVER (ORDER BY w) / 1e18, 0) AS wallets
        FROM (
          SELECT
            multiIf(t.lbl = 'stableswap-pools', 'stableswap',
                    t.lbl = 'omnipool', 'omnipool',
                    t.lbl = 'sovereigns', 'bridged',
                    t.lbl != '' OR startsWith(b.holder, '0x6d6f646c') OR startsWith(b.holder, '0x7369626c'), 'protocol',
                    'wallets') AS cat,
            toStartOfWeek(b.block_timestamp, 1) AS w, sum(toFloat64(b.balance_delta)) AS d
          FROM price_data.erc20_transfer_deltas b
          LEFT JOIN tags t ON b.holder = t.h
          WHERE b.holder != '${ZERO_H160}' AND b.contract_address = '${HOLLAR_ERC20}'
          GROUP BY cat, w
        ) GROUP BY w ORDER BY week`,
      format: 'JSONEachRow',
    })
    // Holders over 0.01 HOLLAR: per-holder weekly running balance, count the
    // 0/1 threshold-crossing deltas so the weekly count is a running sum.
    const holdersQuery = client.query({
      query: `
        WITH weekly AS (
          SELECT holder, toStartOfWeek(block_timestamp, 1) AS w, sum(toFloat64(balance_delta)) AS d
          FROM price_data.erc20_transfer_deltas
          WHERE holder != '${ZERO_H160}' AND contract_address = '${HOLLAR_ERC20}'
          GROUP BY holder, w),
        states AS (
          SELECT holder, w, sum(d) OVER (PARTITION BY holder ORDER BY w) AS bal FROM weekly),
        flagdelta AS (
          SELECT holder, w,
            if(bal > 1e16, 1, 0)
              - lagInFrame(if(bal > 1e16, 1, 0), 1, 0) OVER (PARTITION BY holder ORDER BY w
                ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS df
          FROM states)
        SELECT toString(w) AS week, toInt64(sum(sum(df)) OVER (ORDER BY w)) AS v
        FROM flagdelta GROUP BY w ORDER BY week`,
      format: 'JSONEachRow',
    })
    // Weekly USD peg band from daily candles.
    const pegQuery = client.query({
      query: `
        SELECT toString(toStartOfWeek(interval_start, 1)) AS week,
          round(toFloat64(argMaxMerge(close_state)), 6) AS close,
          round(toFloat64(minMerge(low_state)), 6) AS low,
          round(toFloat64(maxMerge(high_state)), 6) AS high
        FROM price_data.ohlc_1d WHERE asset_id = {id:UInt32}
        GROUP BY week ORDER BY week`,
      query_params: { id: HOLLAR_ASSET_ID },
      format: 'JSONEachRow',
    })
    const pegStatsQuery = client.query({
      query: `
        SELECT
          round(100 * countIf(abs(c - 1) <= 0.0050) / count(), 1) AS up50,
          round(100 * countIf(abs(c - 1) <= 0.0025) / count(), 1) AS up25,
          round(max(greatest(abs(l - 1), abs(h - 1))) * 10000, 1) AS maxdev
        FROM (
          SELECT toFloat64(argMaxMerge(close_state)) AS c, toFloat64(minMerge(low_state)) AS l, toFloat64(maxMerge(high_state)) AS h
          FROM price_data.ohlc_1d WHERE asset_id = {id:UInt32} GROUP BY interval_start
        )`,
      query_params: { id: HOLLAR_ASSET_ID },
      format: 'JSONEachRow',
    })
    // HOLLAR debt outstanding + open borrowers, weekly as-of. Aave math: each
    // Borrow/Repay/LiquidationCall is divided by the borrow index at its own
    // block (ASOF) into scaled debt; the as-of balance is scaled × the index
    // then. Liquidations must be included or the series drifts high.
    const debtEventsSql = `
      ev AS (
        SELECT pool_address AS pool, lower(JSONExtractString(decoded_args_json, 'user')) AS debtor,
          toUInt64(block_height) * 1000000 + event_index AS k, block_timestamp AS ts,
          multiIf(event_name = 'Borrow',  toFloat64(JSONExtractString(decoded_args_json, 'amount')),
                  event_name = 'Repay', - toFloat64(JSONExtractString(decoded_args_json, 'amount')),
                  - toFloat64(JSONExtractString(decoded_args_json, 'debtToCover'))) / 1e18 AS amt
        FROM price_data.raw_money_market_events
        WHERE (event_name IN ('Borrow', 'Repay') AND asset_address = '${HOLLAR_ERC20}')
           OR (event_name = 'LiquidationCall' AND JSONExtractString(decoded_args_json, 'debtAsset') = '${HOLLAR_ERC20}')
      ),
      idx0 AS (
        SELECT pool_address AS pool, toUInt64(block_height) * 1000000 + event_index AS k, block_timestamp AS ts,
               toFloat64(variable_borrow_index) / 1e27 AS vbi
        FROM price_data.money_market_reserve_indices
        WHERE reserve_address = '${HOLLAR_ERC20}'
      ),
      weeks AS (
        SELECT toDate('${HOLLAR_LAUNCH_MONDAY}') + number * 7 AS wstart,
               toDateTime(toDate('${HOLLAR_LAUNCH_MONDAY}') + number * 7 + 7) AS wend
        FROM numbers(200) WHERE wstart <= today()
      )`
    const debtQuery = client.query({
      query: `
        WITH ${debtEventsSql},
        scaled AS (
          SELECT ev.pool AS pool, ev.ts AS ts, ev.k AS k, ev.amt / if(idx0.vbi < 0.5, 1, idx0.vbi) AS samt
          FROM ev ASOF LEFT JOIN idx0 ON ev.pool = idx0.pool AND ev.k >= idx0.k
        ),
        cum0 AS (SELECT pool, ts, k, sum(samt) OVER (PARTITION BY pool ORDER BY k) AS scum FROM scaled),
        cum AS (SELECT pool, ts, argMax(scum, k) AS scum FROM cum0 GROUP BY pool, ts),
        idx AS (SELECT pool, ts, argMax(vbi, k) AS vbi FROM idx0 GROUP BY pool, ts),
        wp AS (SELECT wstart, wend, pool FROM weeks CROSS JOIN (SELECT DISTINCT pool FROM ev) AS p),
        a AS (SELECT wp.wstart AS wstart, wp.wend AS wend, wp.pool AS pool, cum.scum AS scum
              FROM wp ASOF LEFT JOIN cum ON wp.pool = cum.pool AND wp.wend >= cum.ts),
        b AS (SELECT a.wstart AS wstart, a.pool AS pool, a.scum AS scum, idx.vbi AS vbi
              FROM a ASOF LEFT JOIN idx ON a.pool = idx.pool AND a.wend >= idx.ts)
        SELECT toString(wstart) AS week, round(sum(scum * if(vbi < 0.5, 1, vbi)), 0) AS v
        FROM b GROUP BY wstart ORDER BY week`,
      format: 'JSONEachRow',
    })
    const borrowersQuery = client.query({
      query: `
        WITH ${debtEventsSql},
        scaled AS (
          SELECT ev.pool AS pool, ev.debtor AS debtor, ev.ts AS ts, ev.k AS k,
                 ev.amt / if(idx0.vbi < 0.5, 1, idx0.vbi) AS samt
          FROM ev ASOF LEFT JOIN idx0 ON ev.pool = idx0.pool AND ev.k >= idx0.k
        ),
        cum0 AS (SELECT pool, debtor, ts, k, sum(samt) OVER (PARTITION BY pool, debtor ORDER BY k) AS scum FROM scaled),
        cum AS (SELECT pool, debtor, ts, argMax(scum, k) AS scum FROM cum0 GROUP BY pool, debtor, ts),
        wp AS (SELECT wstart, wend, pool, debtor FROM weeks CROSS JOIN (SELECT DISTINCT pool, debtor FROM ev) AS p),
        a AS (SELECT wp.wstart AS wstart, wp.debtor AS debtor, cum.scum AS scum
              FROM wp ASOF LEFT JOIN cum ON wp.pool = cum.pool AND wp.debtor = cum.debtor AND wp.wend >= cum.ts)
        SELECT toString(wstart) AS week, toInt64(uniqExactIf(debtor, scum > 0.5)) AS v
        FROM a GROUP BY wstart ORDER BY week`,
      format: 'JSONEachRow',
    })
    const revenueQuery = client.query({
      query: `
        SELECT toString(toStartOfWeek(block_timestamp, 1)) AS week,
               round(sum(sum(amount_usd)) OVER (ORDER BY toStartOfWeek(block_timestamp, 1)), 0) AS v
        FROM price_data.revenue_events WHERE stream = 'hollar_borrow'
        GROUP BY toStartOfWeek(block_timestamp, 1) ORDER BY week`,
      format: 'JSONEachRow',
    })
    // HOLLAR sitting in its stableswap pools (discovered by has(asset_ids, 222),
    // never a hardcoded pool list) and in the Omnipool, weekly as-of.
    const depthQuery = client.query({
      query: `
        WITH ss AS (
          SELECT toStartOfWeek(block_timestamp, 1) AS w, pool_id,
            argMax(toFloat64(reserves_raw[indexOf(asset_ids, {id:UInt32})]), block_height) / 1e18 AS r
          FROM price_data.stableswap_pool_state_history
          WHERE has(asset_ids, {id:UInt32})
          GROUP BY w, pool_id),
        om AS (
          SELECT toStartOfWeek(block_timestamp, 1) AS w,
            argMax(toFloat64(reserve_raw), block_height) / 1e18 AS r
          FROM price_data.omnipool_pool_state_history WHERE asset_id = {id:UInt32} GROUP BY w)
        SELECT toString(ssw.w) AS week, round(ssw.r, 0) AS stableswap, round(ifNull(om.r, 0), 0) AS omnipool
        FROM (SELECT w, sum(r) AS r FROM ss GROUP BY w) ssw
        LEFT JOIN om ON om.w = ssw.w
        ORDER BY week`,
      query_params: { id: HOLLAR_ASSET_ID },
      format: 'JSONEachRow',
    })
    // HOLLAR's share of stable-vs-stable trade volume. Legs with an empty
    // op_key (non-routed swaps) get a synthetic per-event key — grouping them
    // together would collapse 23% of legs into one op. Volume counts each op
    // once at max(in, out).
    const shareQuery = client.query({
      query: `
        WITH dec AS (
          SELECT asset_id, decimals FROM price_data.assets
          WHERE asset_id IN (${STABLE_SET.join(',')})
        ),
        ops AS (
          SELECT toStartOfMonth(min(l.block_timestamp)) AS mo, l.asset_id AS aid,
            greatest(sumIf(toFloat64(l.amount), l.leg_kind = 'in'),
                     sumIf(toFloat64(l.amount), l.leg_kind = 'out')) / pow(10, any(d.decimals)) AS vol
          FROM price_data.pool_swap_legs l
          INNER JOIN dec d ON l.asset_id = d.asset_id
          WHERE l.leg_kind IN ('in', 'out')
          GROUP BY if(l.op_key = '', concat('e', toString(l.block_height), ':', toString(l.event_index)), l.op_key), l.asset_id
        )
        SELECT toString(mo) AS m, round(sumIf(vol, aid = {id:UInt32}) / sum(vol) * 100, 1) AS v
        FROM ops WHERE mo >= toDate('${HOLLAR_LAUNCH_MONDAY}') - 30
        GROUP BY mo ORDER BY mo`,
      query_params: { id: HOLLAR_ASSET_ID },
      format: 'JSONEachRow',
    })
    // Borrow-rate steps per market (3 values ever — cards, not a chart).
    const ratesQuery = client.query({
      query: `
        SELECT contract_address AS pool,
          round(toFloat64(JSONExtractString(decoded_args_json, 'variableBorrowRate')) / 1e25, 3) AS pct,
          toString(min(toDate(block_timestamp))) AS since
        FROM price_data.raw_evm_logs
        WHERE event_name = 'ReserveDataUpdated' AND has(assets, '${HOLLAR_ERC20}')
        GROUP BY pool, pct ORDER BY pool, since`,
      format: 'JSONEachRow',
    })

    const [compRes, holdersRes, pegRes, pegStatsRes, debtRes, borrowersRes, revenueRes, depthRes, shareRes, ratesRes] = await Promise.all([
      compositionQuery, holdersQuery, pegQuery, pegStatsQuery, debtQuery, borrowersQuery, revenueQuery, depthQuery, shareQuery, ratesQuery,
    ])

    const weeks = hollarWeekGrid()
    const months = hollarMonthGrid()
    const wv = async (res: { json<T>(): Promise<T[]> }) =>
      (await res.json<{ week: string; v: number }>()).map(r => ({ m: String(r.week), v: Number(r.v) }))
    const compRows = (await compRes.json<{ week: string; stableswap: number; omnipool: number; bridged: number; protocol: number; wallets: number }>())
      .map(r => ({ week: String(r.week), stableswap: Number(r.stableswap), omnipool: Number(r.omnipool), bridged: Number(r.bridged), protocol: Number(r.protocol), wallets: Number(r.wallets) }))
    const pegRows = (await pegRes.json<{ week: string; close: number; low: number; high: number }>())
      .map(r => ({ week: String(r.week), close: Number(r.close), low: Number(r.low), high: Number(r.high) }))
    const depthRows = (await depthRes.json<{ week: string; stableswap: number; omnipool: number }>())
      .map(r => ({ week: String(r.week), stableswap: Number(r.stableswap), omnipool: Number(r.omnipool) }))
    const shareRows = (await shareRes.json<{ m: string; v: number }>()).map(r => ({ m: String(r.m), v: Number(r.v) }))
    const pegStatsRow = (await pegStatsRes.json<{ up50: number; up25: number; maxdev: number }>())[0]
    const ratesRows = (await ratesRes.json<{ pool: string; pct: number; since: string }>())
      .map(r => ({ pool: String(r.pool), pct: Number(r.pct), since: String(r.since) }))

    const compBand = (k: 'stableswap' | 'omnipool' | 'bridged' | 'protocol' | 'wallets') =>
      carryForward(alignMonthly(weeks, compRows.map(r => ({ m: r.week, v: r[k] })))).map(v => v ?? 0)
    // Rate cards, one per market that lists HOLLAR — named and ordered by the
    // configured market set, the same names the money-market pages use, because
    // every isolated market sets its own borrow rate. A pool the deployment does
    // not configure is still shown, under its address, rather than borrowing a
    // neighbour's name. Within a market the last step is current.
    const marketOrder = new Map(mmMarkets().map((m, i) => [m.poolProxy, { label: m.label, order: i }]))
    const marketOf = (pool: string) =>
      marketOrder.get(pool.toLowerCase()) ?? { label: `${pool.slice(0, 8)}…`, order: marketOrder.size }
    const rates = [...new Set(ratesRows.map(r => r.pool))]
      .sort((a, b) => marketOf(a).order - marketOf(b).order || (a < b ? -1 : 1))
      .map(pool => {
        const steps = ratesRows.filter(r => r.pool === pool).sort((a, b) => (a.since < b.since ? -1 : 1))
        const cur = steps[steps.length - 1]
        return {
          label: marketOf(pool).label,
          pct: cur.pct,
          prevPct: steps.length > 1 ? steps[steps.length - 2].pct : null,
          since: cur.since,
        }
      })

    return {
      weeks,
      composition: {
        stableswap: compBand('stableswap'), omnipool: compBand('omnipool'),
        protocol: compBand('protocol'), bridged: compBand('bridged'), wallets: compBand('wallets'),
      },
      holders: carryForward(alignMonthly(weeks, await wv(holdersRes))),
      peg: {
        close: alignMonthly(weeks, pegRows.map(r => ({ m: r.week, v: r.close }))),
        low: alignMonthly(weeks, pegRows.map(r => ({ m: r.week, v: r.low }))),
        high: alignMonthly(weeks, pegRows.map(r => ({ m: r.week, v: r.high }))),
      },
      debt: alignMonthly(weeks, await wv(debtRes)),
      borrowers: alignMonthly(weeks, await wv(borrowersRes)),
      revenueCumUsd: carryForward(alignMonthly(weeks, await wv(revenueRes))),
      depth: {
        stableswap: carryForward(alignMonthly(weeks, depthRows.map(r => ({ m: r.week, v: r.stableswap })))),
        omnipool: carryForward(alignMonthly(weeks, depthRows.map(r => ({ m: r.week, v: r.omnipool })))),
      },
      months,
      stableSharePct: alignMonthly(months, shareRows),
      pegStats: pegStatsRow ? { uptime50Pct: Number(pegStatsRow.up50), uptime25Pct: Number(pegStatsRow.up25), maxAbsDevBps: Number(pegStatsRow.maxdev) } : null,
      rates,
    }
  })
}

// dashboard payload

export async function getHollarDashboard(): Promise<HollarDashboard> {
  return cachedSwr(`explorer:hollar-dashboard:model`, 300_000, 48 * 3_600_000, async () => {
    const reserveDays = hollarDayGrid()
    const [prices, peg, supplyRaw, stablePools, collateralEvents, lastArbByAsset, arbitrageDaily, tradesDaily, trends, reserveSeries] = await Promise.all([
      ensurePrices(), loadPeg(), loadSupply(), loadHollarStablePools(), loadHsmCollateralEvents(), loadLastArbByAsset(), loadArbitrageDaily(), loadTradesDaily(), loadHollarTrends(),
      loadHsmReserveHistory(reserveDays),
    ])
    const px = prices.get(HOLLAR_ASSET_ID)

    const folded = foldHsmCollateralParams(collateralEvents)
    const holdings = await loadHsmHoldings([...folded.keys()])
    const collaterals: HollarCollateral[] = [...folded.values()]
      .map(c => {
        const a = asset(c.assetId)
        const holdRaw = holdings.get(c.assetId) ?? '0'
        const lastArb = lastArbByAsset.get(c.assetId)
        return {
          asset: a,
          poolId: c.poolId ?? 0,
          holdings: holdRaw,
          holdingsUsd: usdOf(prices, c.assetId, holdRaw, a.decimals),
          purchaseFeePct: c.purchaseFeePermill / 1e6 * 100,
          buyBackFeePct: c.buyBackFeePermill / 1e6 * 100,
          maxBuyPrice: Number(c.maxBuyPriceCoefficientRaw) / 1e18,
          buybackRatePct: c.buybackRatePerbill / 1e9 * 100,
          maxInHolding: c.maxInHoldingRaw,
          lastArbTs: lastArb?.ts ?? null,
          lastArbDirection: lastArb?.direction ?? null,
        }
      })
      .sort((x, y) => x.poolId - y.poolId)
    const totalHoldingsUsd = collaterals.reduce((s, c) => s + (c.holdingsUsd ?? 0), 0)

    let lastArb: HollarDashboard['hsm']['lastArb'] = null
    for (const [assetId, v] of lastArbByAsset) {
      if (!lastArb || v.ts > lastArb.ts) lastArb = { ts: v.ts, direction: v.direction, asset: asset(assetId), hollarAmount: v.hollarAmount }
    }

    const inStablepools = stablePools.reduce((s, p) => s + Number(p.hollarRaw) / 1e18, 0)
    // Clamp — the block-snapshot (pool reserves) and the erc20 balance snapshot
    // (omnipool/total) refresh on independent cadences, so a few seconds of
    // timing skew could otherwise show a small negative "other".
    const other = Math.max(0, supplyRaw.total - inStablepools - supplyRaw.omnipool)

    const pools: HollarPool[] = stablePools
      .map(p => {
        const hollarAmount = Number(p.hollarRaw) / 1e18
        const hollarUsd = px ? hollarAmount * px.price : null
        const partners = p.partners.map(pt => {
          const partnerAsset = asset(pt.assetId)
          const partnerAmount = Number(pt.raw) / 10 ** partnerAsset.decimals
          const partnerPrice = prices.get(pt.assetId)?.price ?? null
          const partnerUsd = partnerPrice != null ? partnerAmount * partnerPrice : null
          return { asset: partnerAsset, amount: partnerAmount, usd: partnerUsd }
        })
        // tvlUsd is only set when hollarUsd AND every partner side is priced,
        // so hollarUsd is guaranteed non-null wherever tvlUsd is truthy (and
        // tvlUsd > 0 rules out a division by zero).
        const allPartnersPriced = partners.every(pt => pt.usd != null)
        const partnersUsd = partners.reduce((s, pt) => s + (pt.usd ?? 0), 0)
        const tvlUsd = hollarUsd != null && allPartnersPriced ? hollarUsd + partnersUsd : null
        const hollarSharePct = tvlUsd && hollarUsd != null ? hollarUsd / tvlUsd * 100 : null
        return {
          poolId: p.poolId,
          tvlUsd,
          hollar: { amount: hollarAmount, usd: hollarUsd },
          partners,
          hollarSharePct,
        }
      })
      .sort((x, y) => x.poolId - y.poolId)

    return {
      price: px?.price ?? null,
      change24h: px?.change24h ?? null,
      pegDeviationBps: px ? (px.price - 1) * 10000 : null,
      peg,
      supply: { total: supplyRaw.total, holders: supplyRaw.holders, inStablepools, inOmnipool: supplyRaw.omnipool, other },
      hsm: {
        totalHoldingsUsd, collaterals,
        reserveHistory: { days: reserveDays, series: reserveSeries },
        arbitrageDaily, tradesDaily, lastArb,
      },
      pools,
      trends,
    }
  })
}
