import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import { ensurePrices, getMoneyMarketReserves, type AssetRef, type PriceInfo } from './explorerService.ts'
import { assetDescriptor } from './explorerAssets.ts'

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

export interface RawHsmCollateralEvent { block: number; args: Record<string, unknown> }
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

// Folds HSM.CollateralAdded + HSM.CollateralUpdated (ordered ascending by
// block/event index) into each collateral's CURRENT parameters. CollateralUpdated
// only carries the fields that were touched by that call (Option<T> per field —
// an absent key means "unchanged"); maxInHolding is Option<Option<Balance>>, so
// an explicit `{__kind:'None'}` clears a previously-set cap.
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
export interface HollarDashboard {
  price: number | null
  change24h: number | null
  pegDeviationBps: number | null
  peg: { hourly: HollarPegPoint[]; within25bpsPct: number | null; maxDevBps: number | null; min30d: number | null; max30d: number | null }
  supply: { total: number; holders: number; inStablepools: number; inOmnipool: number; other: number }
  hsm: {
    totalHoldingsUsd: number
    collaterals: HollarCollateral[]
    arbitrageDaily: HollarArbDay[]
    tradesDaily: HollarTradeDay[]
    lastArb: { ts: string; direction: 'in' | 'out'; asset: AssetRef; hollarAmount: number } | null
  }
  pools: HollarPool[]
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

// HOLLAR balances can exist on both the EVM ERC-20 and Substrate Tokens sides.
// Combine the current ERC-20 snapshot with indexed Tokens balances, matching the
// asset totals and holder-count semantics used by the explorer asset directory.
async function loadSupply(): Promise<{ total: number; holders: number; omnipool: number }> {
  const res = await client.query({
    query: `
      SELECT
        toString(sum(bal)) AS total,
        countIf(bal > 0) AS holders,
        toString(sumIf(bal, account_id = {omnipool:String})) AS omnipool_bal
      FROM (
        SELECT account_id, toUInt256OrZero(argMaxMerge(total_state)) AS bal
        FROM price_data.account_asset_latest_balances WHERE asset_id = {id:String}
        GROUP BY account_id
        UNION ALL
        SELECT account_id, toUInt256OrZero(argMax(total, updated_at)) AS bal
        FROM price_data.erc20_wallet_balances WHERE asset_id = {id:String}
        GROUP BY account_id
      )
      WHERE bal > 0`,
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
// Compact form (hex byte-string, one byte per asset id) is only valid for ids
// ≤ 255 — mirrors parsePoolAssets in explorerService.ts.
export function parsePoolAssetIds(raw: string | number[]): number[] {
  if (Array.isArray(raw)) return raw.map(Number)
  const h = raw.startsWith('0x') ? raw.slice(2) : raw
  const out: number[] = []
  for (let i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16))
  return out
}

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
    query: `SELECT block_height AS block, args_json
            FROM price_data.raw_events
            WHERE event_name IN ('HSM.CollateralAdded', 'HSM.CollateralUpdated')
            ORDER BY block_height ASC, event_index ASC`,
    format: 'JSONEachRow',
  })
  return (await res.json<{ block: number; args_json: string }>()).map(r => ({ block: r.block, args: safeJsonObj(r.args_json) }))
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
            FROM price_data.raw_events WHERE event_name = 'HSM.ArbitrageExecuted'
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
            FROM price_data.raw_events
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
            FROM price_data.raw_events
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

// dashboard payload

export async function getHollarDashboard(): Promise<HollarDashboard> {
  return cached('explorer:hollar-dashboard', 300_000, async () => {
    const [prices, peg, supplyRaw, stablePools, collateralEvents, lastArbByAsset, arbitrageDaily, tradesDaily] = await Promise.all([
      ensurePrices(), loadPeg(), loadSupply(), loadHollarStablePools(), loadHsmCollateralEvents(), loadLastArbByAsset(), loadArbitrageDaily(), loadTradesDaily(),
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
      hsm: { totalHoldingsUsd, collaterals, arbitrageDaily, tradesDaily, lastArb },
      pools,
    }
  })
}
