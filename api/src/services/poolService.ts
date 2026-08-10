import type { ClickHouseClient } from '../db/client.ts'
import { cachedSwr } from './cache.ts'
import { accountRef, ensurePrices, type AccountRef, type AssetRef, type PriceInfo } from './explorerService.ts'
import { assetDescriptor, priceAssetId } from './explorerAssets.ts'
import { stableswapPoolAccount } from './tagService.ts'
import { hasDriftingPegs, parseStableswapPools, pegPrice, type StableswapPoolSnapshot } from './stableswapSnapshot.ts'

// Liquidity-pool read models: the asset Liquidity tab, the stableswap/XYK pool
// detail pages and the Omnipool page. Current state comes from the latest
// raw_block_snapshots row (one cached read shared by all three surfaces, so an
// asset card and the pool page it links to can never disagree); history comes
// from the MV-backed state-history tables on the shared 600-block grid
// (omnipool_pool_state_history, stableswap_pool_state_history,
// xyk_pool_reserve_history), bucketed daily. Bucketed USD uses only day candles
// fully closed by the bucket boundary, so history series end at yesterday —
// current values live in the current-state sections. Pool TVL is null unless
// every leg is priced; peg multipliers scale the internal trading curve and are
// displayed, never applied to USD.

let client: ClickHouseClient
export function initPoolService(c: ClickHouseClient): void { client = c }

const LRNA_ASSET_ID = 1
const OMNIPOOL_ACCOUNT = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'
// XYK trade fee is a runtime constant: Permill 0.3% (3/1000).
const XYK_FEE_PERMILL = 3000

const asset = (id: number): AssetRef => assetDescriptor(id)

function priceOf(prices: Map<number, PriceInfo>, assetId: number): number | null {
  const direct = prices.get(assetId)?.price
  if (direct != null) return direct
  const aliased = prices.get(priceAssetId(assetId))?.price
  return aliased ?? null
}

function usdOf(prices: Map<number, PriceInfo>, assetId: number, raw: bigint): number | null {
  const px = priceOf(prices, assetId)
  if (px == null) return null
  const amt = Number(raw) / 10 ** asset(assetId).decimals
  return Number.isFinite(amt) ? amt * px : null
}

// response shapes

export interface PoolCompositionEntry { asset: AssetRef; amount: string; usd: number | null; sharePct: number | null }
export interface AssetLiquiditySource {
  kind: 'omnipool' | 'stableswap' | 'xyk'
  poolId: number | null
  name: string
  tvlUsd: number | null
  assetAmount: string
  assetUsd: number | null
  assetSharePct: number | null
  // Per-asset reserves of the pool. Empty for the Omnipool source — its full
  // 40-asset composition lives on /explorer/omnipool, the card renders the
  // asset-vs-rest split from assetSharePct instead.
  composition: PoolCompositionEntry[]
  hasPegs: boolean
}
export interface FormerLiquiditySource {
  kind: 'omnipool' | 'stableswap' | 'xyk'
  poolId: number | null
  name: string
  lastActiveBlock: number | null
  lastActiveAt: string | null
}
export interface AssetLiquiditySeries { key: string; label: string; amounts: (number | null)[]; usd: (number | null)[] }
export interface AssetLiquidityResponse {
  asset: AssetRef
  totalAmount: string
  totalUsd: number | null
  sources: AssetLiquiditySource[]
  former: FormerLiquiditySource[]
  history: { buckets: string[]; series: AssetLiquiditySeries[] }
}

export interface PegSourceInfo { kind: 'value' | 'oracle' | 'mmOracle'; source?: string; period?: string; oracleAsset?: AssetRef; address?: string }
export interface PoolDetailAsset {
  asset: AssetRef
  amount: string
  usd: number | null
  sharePct: number | null
  peg: { num: string; den: string; price: number } | null
  pegSource: PegSourceInfo | null
}
export interface PoolParamEvent {
  blockHeight: number
  timestamp: string
  kind: 'created' | 'amplification' | 'fee' | 'peg-source' | 'max-peg-update' | 'destroyed'
  summary: string
}
export interface PoolDetailResponse {
  kind: 'stableswap' | 'xyk'
  poolId: number
  name: string
  account: AccountRef
  shareToken: AssetRef
  createdBlock: number | null
  createdAt: string | null
  destroyed: boolean
  tvlUsd: number | null
  totalIssuance: string
  feePermill: number | null
  amplification: { current: number; initial: number; final: number; initialBlock: number; finalBlock: number } | null
  maxPegUpdatePerbill: number | null
  assets: PoolDetailAsset[]
  paramEvents: PoolParamEvent[]
  history: {
    buckets: string[]
    tvlUsd: (number | null)[]
    composition: { asset: AssetRef; amounts: (number | null)[]; usd: (number | null)[] }[]
    pegs: { asset: AssetRef; prices: (number | null)[] }[] | null
    issuance: (number | null)[] | null
  }
}

export interface OmnipoolAssetRow {
  asset: AssetRef
  reserve: string
  reserveUsd: number | null
  hubReserve: string
  weightPct: number | null
  capPct: number | null
  tradable: string[]
}
export interface OmnipoolResponse {
  account: AccountRef
  tvlUsd: number | null
  assetCount: number
  hubReserveTotal: string
  lrnaPrice: number | null
  assets: OmnipoolAssetRow[]
  history: { buckets: string[]; tvlUsd: (number | null)[]; composition: { asset: AssetRef; usd: (number | null)[] }[] }
}

// current state (latest snapshot, shared by all pool surfaces)

export interface OmnipoolAssetSnapshot { assetId: number; reserve: bigint; hub: bigint; shares: bigint; cap: bigint; tradable: number }
export interface XykPoolSnapshot {
  lpAssetId: number | null
  poolAccount: string
  assetA: number
  assetB: number
  reserveA: bigint
  reserveB: bigint
  createdBlock: number | null
}
export interface CurrentPools {
  blockHeight: number
  omnipool: Map<number, OmnipoolAssetSnapshot>
  stableswap: Map<number, StableswapPoolSnapshot>
  xykByLp: Map<number, XykPoolSnapshot>
  xykByAccount: Map<string, XykPoolSnapshot>
}

interface SnapshotOmniAsset { asset_id: number; hub_reserve: string; reserve: string; shares: string; cap?: string; tradable?: number }
interface SnapshotXykPool { pool_account: string; asset_a: number; asset_b: number; reserve_a: string; reserve_b: string }

function safeJson(s: string | null | undefined): unknown {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

export async function loadCurrentPools(): Promise<CurrentPools> {
  return cachedSwr('explorer:pools:current', 30_000, 300_000, async () => {
    const [snapRes, regRes] = await Promise.all([
      client.query({
        query: `SELECT block_height,
                       JSONExtractRaw(payload_json, 'omnipool') AS o,
                       JSONExtractRaw(payload_json, 'stableswap') AS ss,
                       JSONExtractRaw(payload_json, 'xyk') AS x
                FROM price_data.raw_block_snapshots
                WHERE block_height = (SELECT max(block_height) FROM price_data.raw_block_snapshots)
                LIMIT 1`,
        format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT lp_asset_id, pool_account, asset_a, asset_b, created_block FROM price_data.xyk_pool_registry FINAL`,
        format: 'JSONEachRow',
      }),
    ])
    const snap = (await snapRes.json<{ block_height: number; o: string; ss: string; x: string }>())[0]
    const registry = await regRes.json<{ lp_asset_id: number; pool_account: string; asset_a: number; asset_b: number; created_block: number }>()

    const omnipool = new Map<number, OmnipoolAssetSnapshot>()
    const omniAssets = (safeJson(snap?.o) as { assets?: SnapshotOmniAsset[] } | null)?.assets ?? []
    for (const a of omniAssets) {
      omnipool.set(a.asset_id, {
        assetId: a.asset_id,
        reserve: BigInt(a.reserve),
        hub: BigInt(a.hub_reserve),
        shares: BigInt(a.shares),
        cap: BigInt(a.cap ?? '0'),
        tradable: Number(a.tradable ?? 0),
      })
    }

    const stableswap = new Map<number, StableswapPoolSnapshot>()
    for (const p of parseStableswapPools(safeJson(snap?.ss))) stableswap.set(p.poolId, p)

    // A pool pair account can be reused across create → destroy → recreate
    // cycles; the live incarnation is the newest registry row for the account.
    const regByAccount = new Map<string, { lp: number; createdBlock: number }>()
    for (const r of registry) {
      const prev = regByAccount.get(r.pool_account)
      if (!prev || r.created_block > prev.createdBlock) regByAccount.set(r.pool_account, { lp: r.lp_asset_id, createdBlock: r.created_block })
    }
    const xykByLp = new Map<number, XykPoolSnapshot>()
    const xykByAccount = new Map<string, XykPoolSnapshot>()
    const xykPools = (safeJson(snap?.x) as { pools?: SnapshotXykPool[] } | null)?.pools ?? []
    for (const p of xykPools) {
      const reg = regByAccount.get(p.pool_account)
      const pool: XykPoolSnapshot = {
        lpAssetId: reg?.lp ?? null,
        poolAccount: p.pool_account,
        assetA: p.asset_a,
        assetB: p.asset_b,
        reserveA: BigInt(p.reserve_a),
        reserveB: BigInt(p.reserve_b),
        createdBlock: reg?.createdBlock ?? null,
      }
      xykByAccount.set(p.pool_account, pool)
      if (pool.lpAssetId != null) xykByLp.set(pool.lpAssetId, pool)
    }

    return { blockHeight: Number(snap?.block_height ?? 0), omnipool, stableswap, xykByLp, xykByAccount }
  })
}

// pure helpers (unit-tested)

// Composition entries valued at current prices. sharePct is a USD share and is
// only computable when every leg is priced — the same all-legs rule as tvlUsd,
// so a bar and its TVL cap can never disagree.
export function buildComposition(prices: Map<number, PriceInfo>, legs: { assetId: number; raw: bigint }[]): { entries: PoolCompositionEntry[]; tvlUsd: number | null } {
  const usd = legs.map(l => usdOf(prices, l.assetId, l.raw))
  const tvlUsd = usd.every(u => u != null) ? (usd as number[]).reduce((s, u) => s + u, 0) : null
  const entries = legs.map((l, i) => ({
    asset: asset(l.assetId),
    amount: l.raw.toString(),
    usd: usd[i],
    sharePct: tvlUsd != null && tvlUsd > 0 ? (usd[i]! / tvlUsd) * 100 : null,
  }))
  return { entries, tvlUsd }
}

// Omnipool Tradability bitflags (pallets/omnipool/src/types.rs).
export function tradableFlags(bits: number): string[] {
  if (!bits) return ['Frozen']
  const out: string[] = []
  if (bits & 1) out.push('Sell')
  if (bits & 2) out.push('Buy')
  if (bits & 4) out.push('Add')
  if (bits & 8) out.push('Remove')
  return out
}

// Continuous daily axis (inclusive), 'YYYY-MM-DD'.
export function dailyGrid(firstDay: string, lastDay: string): string[] {
  const out: string[] = []
  const start = Date.parse(`${firstDay}T00:00:00Z`)
  const end = Date.parse(`${lastDay}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return out
  for (let t = start; t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

// Align sparse day→value points onto the grid, carrying the last value forward
// only between the series' first sample and `lastDay` (default: its last
// sample). Outside that range the series is null — a delisted asset or
// destroyed pool ends at its last real sample instead of forward-filling to
// now, and never gets a fabricated zero.
export function carrySeries(grid: string[], points: Map<string, number>, lastDay?: string): (number | null)[] {
  let first: string | null = null
  let lastPoint: string | null = null
  for (const d of points.keys()) {
    if (first == null || d < first) first = d
    if (lastPoint == null || d > lastPoint) lastPoint = d
  }
  const end = lastDay ?? lastPoint
  const out: (number | null)[] = []
  let current: number | null = null
  for (const d of grid) {
    if (first == null || d < first || (end != null && d > end)) { out.push(null); continue }
    const v = points.get(d)
    if (v != null) current = v
    out.push(current)
  }
  return out
}

// Keep the N series with the largest peak value and fold the rest into one
// 'other' series (per-bucket sum of the folded series, null when none of them
// has a value). Ties break by key so the fold is deterministic.
export function foldTopSeries(series: AssetLiquiditySeries[], topN: number): AssetLiquiditySeries[] {
  if (series.length <= topN) return series
  const peak = (s: AssetLiquiditySeries) => s.amounts.reduce<number>((m, v) => (v != null && v > m ? v : m), 0)
  const ranked = [...series].sort((a, b) => peak(b) - peak(a) || (a.key < b.key ? -1 : 1))
  const top = ranked.slice(0, topN)
  const rest = ranked.slice(topN)
  const n = rest[0]?.amounts.length ?? 0
  const amounts: (number | null)[] = []
  const usd: (number | null)[] = []
  for (let i = 0; i < n; i++) {
    let a: number | null = null
    let u: number | null = null
    for (const s of rest) {
      if (s.amounts[i] != null) a = (a ?? 0) + s.amounts[i]!
      if (s.usd[i] != null) u = (u ?? 0) + s.usd[i]!
    }
    amounts.push(a)
    usd.push(u)
  }
  // Preserve the original (value-ordered) top series order, then Other.
  const keep = new Set(top.map(s => s.key))
  return [...series.filter(s => keep.has(s.key)), { key: 'other', label: 'Other', amounts, usd }]
}

// Peg-source decoding from SQD-decoded Stableswap event args.
const ORACLE_SOURCE_NAMES: Record<string, string> = {
  bifrosto: 'Bifrost',
  omnipool: 'Omnipool',
  stablesw: 'Stableswap',
  hydraxyk: 'XYK',
  gigahdxs: 'GigaHDX',
}
function hexToAscii(hex: string): string {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  let out = ''
  for (let i = 0; i + 1 < h.length; i += 2) {
    const c = parseInt(h.slice(i, i + 2), 16)
    if (c >= 32 && c < 127) out += String.fromCharCode(c)
  }
  return out
}
type RawPegSource =
  | { __kind: 'Value'; value: [string, string] }
  | { __kind: 'Oracle'; value: [string, { __kind: string }, number] }
  | { __kind: 'MMOracle'; value: string }
export function decodePegSource(raw: unknown): PegSourceInfo | null {
  const src = raw as RawPegSource | null | undefined
  if (!src || typeof src !== 'object' || !('__kind' in src)) return null
  if (src.__kind === 'Value') return { kind: 'value' }
  if (src.__kind === 'Oracle') {
    const [sourceHex, period, oracleAssetId] = src.value
    const name = hexToAscii(sourceHex)
    return {
      kind: 'oracle',
      source: ORACLE_SOURCE_NAMES[name] ?? name,
      period: period?.__kind ?? undefined,
      oracleAsset: asset(Number(oracleAssetId)),
    }
  }
  if (src.__kind === 'MMOracle') return { kind: 'mmOracle', source: 'Money market', address: src.value }
  return null
}

const pctOfPermill = (permill: number) => `${(permill / 10_000).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`
const pctOfPerbill = (perbill: number) => `${(perbill / 10_000_000).toLocaleString('en-US', { maximumFractionDigits: 7 })}%`

function pegSourceSummary(info: PegSourceInfo | null): string {
  if (!info) return 'unknown source'
  if (info.kind === 'value') return 'a constant value'
  if (info.kind === 'mmOracle') return `the money-market oracle ${info.address ?? ''}`.trim()
  const parts = [info.source, info.oracleAsset?.symbol, info.period ? `(${info.period})` : null].filter(Boolean)
  return `the ${parts.join(' ')} oracle`
}

interface ParamEventRow { block_height: number; block_timestamp: string; event_name: string; args_json: string }
export function buildParamEvents(rows: ParamEventRow[]): PoolParamEvent[] {
  const out: PoolParamEvent[] = []
  for (const r of rows) {
    const args = (safeJson(r.args_json) ?? {}) as Record<string, unknown>
    const base = { blockHeight: r.block_height, timestamp: r.block_timestamp }
    switch (r.event_name) {
      case 'Stableswap.PoolCreated': {
        const ids = Array.isArray(args.assets) || typeof args.assets === 'string'
          ? parseStableswapAssetsArg(args.assets as string | number[])
          : []
        const syms = ids.map(id => asset(id).symbol).join(', ')
        const peg = args.peg as { source?: unknown[] } | undefined
        out.push({
          ...base,
          kind: 'created',
          summary: `Pool created with ${syms || `${ids.length} assets`} — amplification ${args.amplification}, fee ${pctOfPermill(Number(args.fee ?? 0))}${peg ? ', with price pegs' : ''}`,
        })
        break
      }
      case 'Stableswap.AmplificationChanging':
        out.push({
          ...base,
          kind: 'amplification',
          summary: `Amplification ramping ${args.currentAmplification} → ${args.finalAmplification} over blocks ${args.startBlock}–${args.endBlock}`,
        })
        break
      case 'Stableswap.FeeUpdated':
        out.push({ ...base, kind: 'fee', summary: `Fee set to ${pctOfPermill(Number(args.fee ?? 0))}` })
        break
      case 'Stableswap.PoolPegSourceUpdated': {
        const info = decodePegSource(args.pegSource)
        const sym = asset(Number(args.assetId)).symbol
        out.push({ ...base, kind: 'peg-source', summary: `Peg source for ${sym} set to ${pegSourceSummary(info)}` })
        break
      }
      case 'Stableswap.PoolMaxPegUpdateUpdated':
        out.push({ ...base, kind: 'max-peg-update', summary: `Max peg update set to ${pctOfPerbill(Number(args.maxPegUpdate ?? 0))} per block` })
        break
      case 'Stableswap.PoolDestroyed':
        out.push({ ...base, kind: 'destroyed', summary: 'Pool destroyed' })
        break
    }
  }
  return out.sort((a, b) => b.blockHeight - a.blockHeight)
}
// Event args reuse the snapshot's two `assets` serializations.
function parseStableswapAssetsArg(raw: string | number[]): number[] {
  try {
    if (Array.isArray(raw)) return raw.map(Number)
    if (typeof raw === 'string' && raw.startsWith('0x')) {
      const h = raw.slice(2)
      const out: number[] = []
      for (let i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16))
      return out
    }
  } catch { /* fall through */ }
  return []
}

// The last day whose 1d candle is fully closed (yesterday, UTC).
function lastClosedDay(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
}

// Daily closes for a set of assets (price-alias applied), day → close. The 1d
// candle for day D closes at D+1 00:00 UTC, so it is fully closed for every
// bucket the histories chart (they end at yesterday).
async function dailyCloses(assetIds: number[]): Promise<Map<number, Map<string, number>>> {
  const out = new Map<number, Map<string, number>>()
  if (!assetIds.length) return out
  const aliasByPrice = new Map<number, number[]>()
  for (const id of assetIds) {
    const pid = priceAssetId(id)
    aliasByPrice.set(pid, [...(aliasByPrice.get(pid) ?? []), id])
  }
  const res = await client.query({
    query: `SELECT asset_id, toString(toDate(interval_start)) AS d, toFloat64(argMaxMerge(close_state)) AS close
            FROM price_data.ohlc_1d
            WHERE asset_id IN {ids:Array(UInt32)}
            GROUP BY asset_id, interval_start`,
    query_params: { ids: [...aliasByPrice.keys()] },
    format: 'JSONEachRow',
  })
  for (const r of await res.json<{ asset_id: number; d: string; close: number }>()) {
    if (!(r.close > 0)) continue
    for (const id of aliasByPrice.get(r.asset_id) ?? []) {
      let m = out.get(id)
      if (!m) { m = new Map(); out.set(id, m) }
      m.set(r.d, r.close)
    }
  }
  return out
}

// asset liquidity (the Liquidity tab)

function currentSourcesForAsset(pools: CurrentPools, prices: Map<number, PriceInfo>, assetId: number): AssetLiquiditySource[] {
  const out: AssetLiquiditySource[] = []
  const omniTvl = omnipoolTvl(pools, prices)

  if (assetId === LRNA_ASSET_ID) {
    // LRNA is the Omnipool hub: its pooled form is the total hub reserve.
    let hubTotal = 0n
    for (const a of pools.omnipool.values()) hubTotal += a.hub
    if (hubTotal > 0n) {
      const usd = usdOf(prices, LRNA_ASSET_ID, hubTotal)
      out.push({
        kind: 'omnipool', poolId: null, name: 'Omnipool (hub)', tvlUsd: omniTvl,
        assetAmount: hubTotal.toString(), assetUsd: usd, assetSharePct: null,
        composition: [], hasPegs: false,
      })
    }
  } else {
    const omni = pools.omnipool.get(assetId)
    if (omni) {
      const usd = usdOf(prices, assetId, omni.reserve)
      out.push({
        kind: 'omnipool', poolId: null, name: 'Omnipool', tvlUsd: omniTvl,
        assetAmount: omni.reserve.toString(), assetUsd: usd,
        assetSharePct: usd != null && omniTvl != null && omniTvl > 0 ? (usd / omniTvl) * 100 : null,
        composition: [], hasPegs: false,
      })
    }
  }

  for (const pool of pools.stableswap.values()) {
    const idx = pool.assetIds.indexOf(assetId)
    if (idx === -1) continue
    const { entries, tvlUsd } = buildComposition(prices, pool.assetIds.map((id, i) => ({ assetId: id, raw: pool.reserves[i] })))
    out.push({
      kind: 'stableswap', poolId: pool.poolId, name: asset(pool.poolId).symbol,
      tvlUsd,
      assetAmount: pool.reserves[idx].toString(),
      assetUsd: entries[idx].usd,
      assetSharePct: entries[idx].sharePct,
      composition: entries,
      hasPegs: hasDriftingPegs(pool.pegs),
    })
  }

  for (const pool of pools.xykByAccount.values()) {
    if (pool.assetA !== assetId && pool.assetB !== assetId) continue
    const { entries, tvlUsd } = buildComposition(prices, [
      { assetId: pool.assetA, raw: pool.reserveA },
      { assetId: pool.assetB, raw: pool.reserveB },
    ])
    const idx = pool.assetA === assetId ? 0 : 1
    out.push({
      kind: 'xyk', poolId: pool.lpAssetId, name: xykName(pool.assetA, pool.assetB),
      tvlUsd,
      assetAmount: (idx === 0 ? pool.reserveA : pool.reserveB).toString(),
      assetUsd: entries[idx].usd,
      assetSharePct: entries[idx].sharePct,
      composition: entries,
      hasPegs: false,
    })
  }

  out.sort((a, b) => (b.assetUsd ?? -1) - (a.assetUsd ?? -1))
  // Long tails exist (DOT sits in 100+ dust XYK pools): the card grid renders
  // the top sources with their composition bars, everything below folds into
  // compact rows that keep every value field — the full breakdown stays one
  // click away on the pool page, so nothing is silently dropped.
  for (const s of out.slice(COMPOSITION_CARD_LIMIT)) s.composition = []
  return out
}

// How many sources keep their inline composition (the tab's card grid).
export const COMPOSITION_CARD_LIMIT = 12

function xykName(a: number, b: number): string {
  return `${asset(a).symbol} / ${asset(b).symbol}`
}

function omnipoolTvl(pools: CurrentPools, prices: Map<number, PriceInfo>): number | null {
  let tvl = 0
  for (const a of pools.omnipool.values()) {
    const usd = usdOf(prices, a.assetId, a.reserve)
    if (usd == null) return null
    tvl += usd
  }
  return pools.omnipool.size ? tvl : null
}

export async function countLiquiditySources(assetId: number): Promise<number> {
  const [pools, prices] = await Promise.all([loadCurrentPools(), ensurePrices()])
  return currentSourcesForAsset(pools, prices, assetId).length
}

async function formerSourcesForAsset(pools: CurrentPools, assetId: number): Promise<FormerLiquiditySource[]> {
  const out: FormerLiquiditySource[] = []
  const [omniRes, ssRes, xykRegRes] = await Promise.all([
    pools.omnipool.has(assetId) || assetId === LRNA_ASSET_ID
      ? null
      : client.query({
          query: `SELECT max(block_height) AS b, toString(argMax(block_timestamp, block_height)) AS ts
                  FROM price_data.omnipool_pool_state_history WHERE asset_id = {id:Int32} HAVING count() > 0`,
          query_params: { id: assetId }, format: 'JSONEachRow',
        }),
    client.query({
      query: `SELECT pool_id, max(block_height) AS b, toString(argMax(block_timestamp, block_height)) AS ts
              FROM price_data.stableswap_pool_state_history WHERE has(asset_ids, {id:UInt32}) GROUP BY pool_id`,
      query_params: { id: assetId }, format: 'JSONEachRow',
    }),
    client.query({
      query: `SELECT lp_asset_id, pool_account, asset_a, asset_b FROM price_data.xyk_pool_registry FINAL
              WHERE asset_a = {id:Int32} OR asset_b = {id:Int32}`,
      query_params: { id: assetId }, format: 'JSONEachRow',
    }),
  ])

  if (omniRes) {
    const row = (await omniRes.json<{ b: number; ts: string }>())[0]
    if (row) out.push({ kind: 'omnipool', poolId: null, name: 'Omnipool', lastActiveBlock: Number(row.b), lastActiveAt: row.ts })
  }

  for (const r of await ssRes.json<{ pool_id: number; b: number; ts: string }>()) {
    if (pools.stableswap.has(r.pool_id)) continue
    out.push({ kind: 'stableswap', poolId: r.pool_id, name: asset(r.pool_id).symbol, lastActiveBlock: Number(r.b), lastActiveAt: r.ts })
  }

  const goneXyk = (await xykRegRes.json<{ lp_asset_id: number; pool_account: string; asset_a: number; asset_b: number }>())
    .filter(r => !pools.xykByAccount.has(r.pool_account))
  if (goneXyk.length) {
    const lastRes = await client.query({
      query: `SELECT pool_account, max(block_height) AS b, toString(argMax(block_timestamp, block_height)) AS ts
              FROM price_data.xyk_pool_reserve_history WHERE pool_account IN {accs:Array(String)} GROUP BY pool_account`,
      query_params: { accs: goneXyk.map(r => r.pool_account) }, format: 'JSONEachRow',
    })
    const lastByAccount = new Map<string, { b: number; ts: string }>()
    for (const r of await lastRes.json<{ pool_account: string; b: number; ts: string }>()) lastByAccount.set(r.pool_account, { b: Number(r.b), ts: r.ts })
    // A pair account is reused across incarnations — one former entry per account.
    const seen = new Set<string>()
    for (const r of goneXyk) {
      if (seen.has(r.pool_account)) continue
      seen.add(r.pool_account)
      const last = lastByAccount.get(r.pool_account)
      out.push({
        kind: 'xyk', poolId: r.lp_asset_id, name: xykName(r.asset_a, r.asset_b),
        // Pools that died before snapshot coverage have no sampled history —
        // explicit null, never an invented amount or date.
        lastActiveBlock: last?.b ?? null, lastActiveAt: last?.ts ?? null,
      })
    }
  }

  return out.sort((a, b) => (b.lastActiveBlock ?? -1) - (a.lastActiveBlock ?? -1))
}

async function assetLiquidityHistory(pools: CurrentPools, assetId: number): Promise<AssetLiquidityResponse['history']> {
  const dec = asset(assetId).decimals
  const end = lastClosedDay()

  // Per-day last sample per source. Amounts are parsed from raw strings and
  // display-normalized once, at the edge.
  const seriesPoints: { key: string; label: string; live: boolean; points: Map<string, number> }[] = []

  if (assetId === LRNA_ASSET_ID) {
    const res = await client.query({
      query: `SELECT d, toString(sum(hub)) AS v FROM (
                SELECT asset_id, toString(toDate(block_timestamp)) AS d,
                       argMax(toUInt256OrZero(hub_reserve_raw), block_height) AS hub
                FROM price_data.omnipool_pool_state_history GROUP BY asset_id, d
              ) GROUP BY d ORDER BY d`,
      format: 'JSONEachRow',
    })
    const points = new Map<string, number>()
    for (const r of await res.json<{ d: string; v: string }>()) points.set(r.d, Number(BigInt(r.v)) / 10 ** dec)
    if (points.size) seriesPoints.push({ key: 'omnipool', label: 'Omnipool (hub)', live: true, points })
  } else {
    const res = await client.query({
      query: `SELECT toString(toDate(block_timestamp)) AS d, toString(argMax(toUInt256OrZero(reserve_raw), block_height)) AS v
              FROM price_data.omnipool_pool_state_history WHERE asset_id = {id:Int32} GROUP BY d ORDER BY d`,
      query_params: { id: assetId }, format: 'JSONEachRow',
    })
    const points = new Map<string, number>()
    for (const r of await res.json<{ d: string; v: string }>()) points.set(r.d, Number(BigInt(r.v)) / 10 ** dec)
    if (points.size) seriesPoints.push({ key: 'omnipool', label: 'Omnipool', live: pools.omnipool.has(assetId), points })
  }

  const ssRes = await client.query({
    query: `SELECT pool_id, toString(toDate(block_timestamp)) AS d,
                   argMax(asset_ids, block_height) AS ids, argMax(reserves_raw, block_height) AS rs
            FROM price_data.stableswap_pool_state_history WHERE has(asset_ids, {id:UInt32})
            GROUP BY pool_id, d ORDER BY pool_id, d`,
    query_params: { id: assetId }, format: 'JSONEachRow',
  })
  const ssPoints = new Map<number, Map<string, number>>()
  for (const r of await ssRes.json<{ pool_id: number; d: string; ids: number[]; rs: string[] }>()) {
    const idx = r.ids.indexOf(assetId)
    if (idx === -1 || !r.rs[idx]) continue
    let m = ssPoints.get(r.pool_id)
    if (!m) { m = new Map(); ssPoints.set(r.pool_id, m) }
    m.set(r.d, Number(BigInt(r.rs[idx])) / 10 ** dec)
  }
  for (const [poolId, points] of ssPoints) {
    seriesPoints.push({ key: `ss:${poolId}`, label: asset(poolId).symbol, live: pools.stableswap.has(poolId), points })
  }

  // XYK: every pool (live or destroyed) that ever contained the asset, from the
  // registry; the asset-side reserve is picked per sampled row because the
  // snapshot's pair order is authoritative per row.
  const xykRegRes = await client.query({
    query: `SELECT DISTINCT pool_account FROM price_data.xyk_pool_registry FINAL WHERE asset_a = {id:Int32} OR asset_b = {id:Int32}`,
    query_params: { id: assetId }, format: 'JSONEachRow',
  })
  const xykAccounts = (await xykRegRes.json<{ pool_account: string }>()).map(r => r.pool_account)
  if (xykAccounts.length) {
    const res = await client.query({
      query: `SELECT pool_account, toString(toDate(block_timestamp)) AS d,
                     toString(argMax(if(asset_a = {id:Int32}, toUInt256OrZero(reserve_a_raw), toUInt256OrZero(reserve_b_raw)), block_height)) AS v,
                     argMax(if(asset_a = {id:Int32}, asset_b, asset_a), block_height) AS partner
              FROM price_data.xyk_pool_reserve_history
              WHERE pool_account IN {accs:Array(String)} AND (asset_a = {id:Int32} OR asset_b = {id:Int32})
              GROUP BY pool_account, d ORDER BY pool_account, d`,
      query_params: { id: assetId, accs: xykAccounts }, format: 'JSONEachRow',
    })
    const byAccount = new Map<string, { partner: number; points: Map<string, number> }>()
    for (const r of await res.json<{ pool_account: string; d: string; v: string; partner: number }>()) {
      let e = byAccount.get(r.pool_account)
      if (!e) { e = { partner: r.partner, points: new Map() }; byAccount.set(r.pool_account, e) }
      e.partner = r.partner
      e.points.set(r.d, Number(BigInt(r.v)) / 10 ** dec)
    }
    for (const [account, e] of byAccount) {
      seriesPoints.push({
        key: `xyk:${account.slice(2, 10)}`,
        label: xykName(assetId, e.partner),
        live: pools.xykByAccount.has(account),
        points: e.points,
      })
    }
  }

  if (!seriesPoints.length) return { buckets: [], series: [] }

  let firstDay: string | null = null
  for (const s of seriesPoints) {
    for (const d of s.points.keys()) if (firstDay == null || d < firstDay) firstDay = d
  }
  const buckets = dailyGrid(firstDay!, end)

  const closes = (await dailyCloses([assetId])).get(assetId) ?? new Map<string, number>()
  const series: AssetLiquiditySeries[] = seriesPoints.map(s => {
    const amounts = carrySeries(buckets, s.points, s.live ? end : undefined)
    const usd = amounts.map((a, i) => {
      if (a == null) return null
      const px = closes.get(buckets[i])
      return px != null ? a * px : null
    })
    return { key: s.key, label: s.label, amounts, usd }
  })

  return { buckets, series: foldTopSeries(series, 5) }
}

// ── Every pool, largest first ─────────────────────────────────────────────────
//
// The chain's liquidity is spread across three venues that behave differently —
// the Omnipool's shared reserve, the stableswaps' pegged baskets, and the XYK
// pairs — and nothing until now listed them together. A pool is not a single
// number though: it is a MIXTURE, so each entry carries its own composition and
// the page draws it, which is what tells a 50/50 basket apart from a venue
// holding twenty slivers.
//
// Everything here comes from the snapshot loadCurrentPools already caches, so
// the whole index is one pass over data the asset and pool pages share.
export interface PoolListEntry {
  kind: 'omnipool' | 'stableswap' | 'xyk'
  poolId: number | null            // share/LP asset id; null for the Omnipool
  name: string
  tvlUsd: number | null
  sharePct: number | null          // of all pooled value
  composition: PoolCompositionEntry[]
  hasPegs: boolean
}
export interface PoolListResponse {
  totalTvlUsd: number | null
  pools: PoolListEntry[]
}

export async function getPoolsIndex(): Promise<PoolListResponse> {
  return cachedSwr('explorer:pools:index', 60_000, 300_000, async () => {
    const [pools, prices] = await Promise.all([loadCurrentPools(), ensurePrices()])
    const entries: PoolListEntry[] = []

    const omni = [...pools.omnipool.values()].map(a => ({ assetId: a.assetId, raw: a.reserve }))
    if (omni.length) {
      const { entries: composition, tvlUsd } = buildComposition(prices, omni)
      entries.push({
        kind: 'omnipool', poolId: null, name: 'Omnipool', tvlUsd, sharePct: null,
        // Largest leg first, so the drawn bar reads as a ranking too.
        composition: [...composition].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)),
        hasPegs: false,
      })
    }

    for (const pool of pools.stableswap.values()) {
      const { entries: composition, tvlUsd } = buildComposition(prices,
        pool.assetIds.map((id, i) => ({ assetId: id, raw: pool.reserves[i] })))
      entries.push({
        kind: 'stableswap', poolId: pool.poolId, name: asset(pool.poolId).symbol, tvlUsd, sharePct: null,
        composition, hasPegs: hasDriftingPegs(pool.pegs),
      })
    }

    for (const pool of pools.xykByLp.values()) {
      const { entries: composition, tvlUsd } = buildComposition(prices, [
        { assetId: pool.assetA, raw: pool.reserveA },
        { assetId: pool.assetB, raw: pool.reserveB },
      ])
      entries.push({
        kind: 'xyk', poolId: pool.lpAssetId, name: `${asset(pool.assetA).symbol} / ${asset(pool.assetB).symbol}`,
        tvlUsd, sharePct: null, composition, hasPegs: false,
      })
    }

    return rankPools(entries)
  })
}

// Largest first, and each pool's share of everything pooled. A pool whose legs
// cannot all be priced has no TVL to rank by and sorts last rather than being
// dropped — it still holds tokens, they just have nothing to be worth, and the
// page says so. Kept pure so both rules stay pinned: 278 of the chain's 307
// pools are unpriced, so "drop the unpriced" would quietly delete most of the
// list, and "treat unpriced as zero" would rank them among the empty ones as if
// that were measured.
export function rankPools(entries: PoolListEntry[]): PoolListResponse {
  const pools = [...entries].sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1))
  const totalTvlUsd = pools.reduce((s, e) => s + (e.tvlUsd ?? 0), 0) || null
  for (const e of pools) {
    e.sharePct = totalTvlUsd != null && totalTvlUsd > 0 && e.tvlUsd != null ? (e.tvlUsd / totalTvlUsd) * 100 : null
  }
  return { totalTvlUsd, pools }
}

export async function getAssetLiquidity(assetId: number): Promise<AssetLiquidityResponse> {
  return cachedSwr(`explorer:asset-liquidity:${assetId}`, 60_000, 300_000, async () => {
    const [pools, prices] = await Promise.all([loadCurrentPools(), ensurePrices()])
    const sources = currentSourcesForAsset(pools, prices, assetId)
    const [former, history] = await Promise.all([
      formerSourcesForAsset(pools, assetId),
      assetLiquidityHistory(pools, assetId),
    ])
    let totalAmount = 0n
    for (const s of sources) totalAmount += BigInt(s.assetAmount)
    const totalUsd = usdOf(prices, assetId, totalAmount)
    return { asset: asset(assetId), totalAmount: totalAmount.toString(), totalUsd, sources, former, history }
  })
}

// pool detail (stableswap + XYK, keyed by the share/LP asset id)

async function blockTimestamp(block: number): Promise<string | null> {
  const res = await client.query({
    query: `SELECT toString(block_timestamp) AS ts FROM price_data.blocks WHERE block_height = {b:UInt32} LIMIT 1`,
    query_params: { b: block }, format: 'JSONEachRow',
  })
  return (await res.json<{ ts: string }>())[0]?.ts ?? null
}

interface SsHistoryRow { d: string; ids: number[]; rs: string[]; peg_num: string[]; peg_den: string[]; issuance: string }

async function stableswapDetail(poolId: number, pools: CurrentPools, prices: Map<number, PriceInfo>): Promise<PoolDetailResponse | null> {
  const [paramRes, histRes] = await Promise.all([
    client.query({
      query: `SELECT block_height, toString(block_timestamp) AS block_timestamp, event_name, args_json
              FROM price_data.stableswap_pool_params FINAL WHERE pool_id = {id:UInt32}
              ORDER BY block_height, event_index`,
      query_params: { id: poolId }, format: 'JSONEachRow',
    }),
    client.query({
      query: `SELECT toString(toDate(block_timestamp)) AS d,
                     argMax(asset_ids, block_height) AS ids, argMax(reserves_raw, block_height) AS rs,
                     argMax(peg_num, block_height) AS peg_num, argMax(peg_den, block_height) AS peg_den,
                     argMax(total_issuance_raw, block_height) AS issuance
              FROM price_data.stableswap_pool_state_history WHERE pool_id = {id:UInt32}
              GROUP BY d ORDER BY d`,
      query_params: { id: poolId }, format: 'JSONEachRow',
    }),
  ])
  const paramRows = await paramRes.json<ParamEventRow & { block_timestamp: string }>()
  const histRows = await histRes.json<SsHistoryRow>()
  const current = pools.stableswap.get(poolId)
  if (!paramRows.length && !histRows.length && !current) return null

  const destroyed = !current
  // Last known state: live pools read the snapshot; destroyed pools keep their
  // final sampled composition, deliberately unvalued (stale amounts must not be
  // priced at current prices).
  const lastHist = histRows[histRows.length - 1]
  const assetIds = current?.assetIds ?? lastHist?.ids ?? []
  const reserves = current?.reserves ?? (lastHist?.rs ?? []).map(r => BigInt(r))
  const pegs = current?.pegs ?? (lastHist && lastHist.peg_num.length
    ? lastHist.peg_num.map((n, i) => ({ num: BigInt(n), den: BigInt(lastHist.peg_den[i]) }))
    : null)
  const totalIssuance = current?.totalIssuance ?? BigInt(lastHist?.issuance ?? '0')

  const { entries, tvlUsd } = destroyed
    ? { entries: assetIds.map((id, i) => ({ asset: asset(id), amount: reserves[i].toString(), usd: null, sharePct: null })), tvlUsd: null }
    : buildComposition(prices, assetIds.map((id, i) => ({ assetId: id, raw: reserves[i] })))

  // Effective peg source per asset: creation config, then any later per-asset updates.
  const pegSourceByAsset = new Map<number, PegSourceInfo>()
  let maxPegUpdatePerbill: number | null = null
  for (const r of paramRows) {
    const args = (safeJson(r.args_json) ?? {}) as Record<string, unknown>
    if (r.event_name === 'Stableswap.PoolCreated') {
      const peg = args.peg as { source?: unknown[]; maxPegUpdate?: number } | undefined
      if (peg?.source) {
        const createdIds = parseStableswapAssetsArg(args.assets as string | number[])
        peg.source.forEach((s, i) => {
          const info = decodePegSource(s)
          if (info && createdIds[i] != null) pegSourceByAsset.set(createdIds[i], info)
        })
        maxPegUpdatePerbill = Number(peg.maxPegUpdate ?? 0)
      }
    } else if (r.event_name === 'Stableswap.PoolPegSourceUpdated') {
      const info = decodePegSource(args.pegSource)
      if (info) pegSourceByAsset.set(Number(args.assetId), info)
    } else if (r.event_name === 'Stableswap.PoolMaxPegUpdateUpdated') {
      maxPegUpdatePerbill = Number(args.maxPegUpdate ?? 0)
    }
  }

  const detailAssets: PoolDetailAsset[] = assetIds.map((id, i) => ({
    ...entries[i],
    peg: pegs ? { num: pegs[i].num.toString(), den: pegs[i].den.toString(), price: pegPrice(pegs[i].num, pegs[i].den) } : null,
    pegSource: pegSourceByAsset.get(id) ?? null,
  }))

  const created = paramRows.find(r => r.event_name === 'Stableswap.PoolCreated')
  const shareDec = asset(poolId).decimals

  // History: composition, TVL (all-legs rule per day), drifting pegs, LP issuance.
  const end = lastClosedDay()
  const histAssetIds = [...new Set(histRows.flatMap(r => r.ids))]
  const closes = await dailyCloses(histAssetIds)
  const firstDay = histRows[0]?.d
  const buckets = firstDay ? dailyGrid(firstDay, destroyed ? lastHist.d : end) : []
  const history = buildStableswapHistory(buckets, histRows, histAssetIds, closes, shareDec)

  return {
    kind: 'stableswap',
    poolId,
    name: asset(poolId).symbol,
    account: accountRef(stableswapPoolAccount(poolId)),
    shareToken: asset(poolId),
    createdBlock: created?.block_height ?? null,
    createdAt: created?.block_timestamp ?? null,
    destroyed,
    tvlUsd,
    totalIssuance: totalIssuance.toString(),
    feePermill: current?.feePermill ?? currentFeeFromParams(paramRows),
    amplification: current
      ? { current: current.amplification, initial: current.initialAmplification, final: current.finalAmplification, initialBlock: current.initialBlock, finalBlock: current.finalBlock }
      : null,
    maxPegUpdatePerbill,
    assets: detailAssets,
    paramEvents: buildParamEvents(paramRows),
    history,
  }
}

// Fee for a destroyed pool: the last FeeUpdated, else the creation fee.
function currentFeeFromParams(rows: ParamEventRow[]): number | null {
  let fee: number | null = null
  for (const r of rows) {
    const args = (safeJson(r.args_json) ?? {}) as Record<string, unknown>
    if (r.event_name === 'Stableswap.PoolCreated' && fee == null) fee = Number(args.fee ?? 0)
    if (r.event_name === 'Stableswap.FeeUpdated') fee = Number(args.fee ?? 0)
  }
  return fee
}

function buildStableswapHistory(
  buckets: string[],
  rows: SsHistoryRow[],
  assetIds: number[],
  closes: Map<number, Map<string, number>>,
  shareDec: number,
): PoolDetailResponse['history'] {
  if (!buckets.length) return { buckets: [], tvlUsd: [], composition: [], pegs: null, issuance: null }

  const compPoints = new Map<number, Map<string, number>>()
  const pegPoints = new Map<number, Map<string, number>>()
  const issuancePoints = new Map<string, number>()
  for (const r of rows) {
    r.ids.forEach((id, i) => {
      const dec = assetDescriptor(id).decimals
      if (r.rs[i] != null) {
        let m = compPoints.get(id)
        if (!m) { m = new Map(); compPoints.set(id, m) }
        m.set(r.d, Number(BigInt(r.rs[i])) / 10 ** dec)
      }
      if (r.peg_num.length === r.ids.length && r.peg_num[i] != null) {
        let m = pegPoints.get(id)
        if (!m) { m = new Map(); pegPoints.set(id, m) }
        m.set(r.d, pegPrice(BigInt(r.peg_num[i]), BigInt(r.peg_den[i])))
      }
    })
    issuancePoints.set(r.d, Number(BigInt(r.issuance || '0')) / 10 ** shareDec)
  }

  const composition = assetIds.map(id => {
    const amounts = carrySeries(buckets, compPoints.get(id) ?? new Map())
    const dayCloses = closes.get(id)
    const usd = amounts.map((a, i) => {
      if (a == null) return null
      const px = dayCloses?.get(buckets[i])
      return px != null ? a * px : null
    })
    return { asset: assetDescriptor(id), amounts, usd }
  })

  const tvlUsd = buckets.map((_, i) => {
    let sum = 0
    for (const c of composition) {
      if (c.amounts[i] == null) continue
      if (c.usd[i] == null) return null
      sum += c.usd[i]!
    }
    return composition.some(c => c.amounts[i] != null) ? sum : null
  })

  // Only drifting pegs make a chart — constant 1/1 legs are noise.
  const pegSeries = [...pegPoints.entries()]
    .filter(([, points]) => [...points.values()].some(v => v !== 1))
    .map(([id, points]) => ({ asset: assetDescriptor(id), prices: carrySeries(buckets, points) }))

  return {
    buckets,
    tvlUsd,
    composition,
    pegs: pegSeries.length ? pegSeries : null,
    issuance: carrySeries(buckets, issuancePoints),
  }
}

async function xykDetail(lpAssetId: number, pools: CurrentPools, prices: Map<number, PriceInfo>): Promise<PoolDetailResponse | null> {
  const regRes = await client.query({
    query: `SELECT lp_asset_id, pool_account, asset_a, asset_b, created_block FROM price_data.xyk_pool_registry FINAL WHERE lp_asset_id = {id:Int32} LIMIT 1`,
    query_params: { id: lpAssetId }, format: 'JSONEachRow',
  })
  const reg = (await regRes.json<{ lp_asset_id: number; pool_account: string; asset_a: number; asset_b: number; created_block: number }>())[0]
  if (!reg) return null

  const current = pools.xykByAccount.get(reg.pool_account)
  // The account is shared across incarnations: this lp is only live if it is
  // the incarnation the snapshot maps to.
  const live = current != null && current.lpAssetId === lpAssetId
  const [histRes, sharesRes, createdAt] = await Promise.all([
    client.query({
      query: `SELECT toString(toDate(block_timestamp)) AS d,
                     argMax(asset_a, block_height) AS aa, argMax(asset_b, block_height) AS ab,
                     toString(argMax(toUInt256OrZero(reserve_a_raw), block_height)) AS ra,
                     toString(argMax(toUInt256OrZero(reserve_b_raw), block_height)) AS rb
              FROM price_data.xyk_pool_reserve_history WHERE pool_account = {acc:String}
              GROUP BY d ORDER BY d`,
      query_params: { acc: reg.pool_account }, format: 'JSONEachRow',
    }),
    client.query({
      query: `SELECT toString(argMax(total_shares_raw, block_height)) AS total FROM price_data.xyk_lp_total_shares_history WHERE lp_asset_id = {id:Int32} HAVING count() > 0`,
      query_params: { id: lpAssetId }, format: 'JSONEachRow',
    }),
    blockTimestamp(reg.created_block),
  ])
  const histRows = await histRes.json<{ d: string; aa: number; ab: number; ra: string; rb: string }>()
  const totalShares = (await sharesRes.json<{ total: string }>())[0]?.total ?? '0'

  const legs = live
    ? [{ assetId: current.assetA, raw: current.reserveA }, { assetId: current.assetB, raw: current.reserveB }]
    : [{ assetId: reg.asset_a, raw: 0n }, { assetId: reg.asset_b, raw: 0n }]
  const lastHist = histRows[histRows.length - 1]
  if (!live && lastHist) {
    legs[0] = { assetId: lastHist.aa, raw: BigInt(lastHist.ra) }
    legs[1] = { assetId: lastHist.ab, raw: BigInt(lastHist.rb) }
  }
  const { entries, tvlUsd } = live
    ? buildComposition(prices, legs)
    : { entries: legs.map(l => ({ asset: asset(l.assetId), amount: l.raw.toString(), usd: null, sharePct: null })), tvlUsd: null }

  const end = lastClosedDay()
  const histAssetIds = [...new Set(histRows.flatMap(r => [r.aa, r.ab]))]
  const closes = await dailyCloses(histAssetIds)
  const buckets = histRows.length ? dailyGrid(histRows[0].d, live ? end : lastHist.d) : []

  const compPoints = new Map<number, Map<string, number>>()
  for (const r of histRows) {
    for (const [id, raw] of [[r.aa, r.ra], [r.ab, r.rb]] as [number, string][]) {
      const dec = assetDescriptor(id).decimals
      let m = compPoints.get(id)
      if (!m) { m = new Map(); compPoints.set(id, m) }
      m.set(r.d, Number(BigInt(raw)) / 10 ** dec)
    }
  }
  const composition = histAssetIds.map(id => {
    const amounts = carrySeries(buckets, compPoints.get(id) ?? new Map())
    const dayCloses = closes.get(id)
    const usd = amounts.map((a, i) => {
      if (a == null) return null
      const px = dayCloses?.get(buckets[i])
      return px != null ? a * px : null
    })
    return { asset: assetDescriptor(id), amounts, usd }
  })
  const tvlSeries = buckets.map((_, i) => {
    let sum = 0
    let any = false
    for (const c of composition) {
      if (c.amounts[i] == null) continue
      any = true
      if (c.usd[i] == null) return null
      sum += c.usd[i]!
    }
    return any ? sum : null
  })

  return {
    kind: 'xyk',
    poolId: lpAssetId,
    name: xykName(legs[0].assetId, legs[1].assetId),
    account: accountRef(reg.pool_account),
    shareToken: asset(lpAssetId),
    createdBlock: reg.created_block,
    createdAt,
    destroyed: !live,
    tvlUsd,
    totalIssuance: totalShares,
    feePermill: XYK_FEE_PERMILL,
    amplification: null,
    maxPegUpdatePerbill: null,
    assets: entries.map(e => ({ ...e, peg: null, pegSource: null })),
    paramEvents: [],
    history: { buckets, tvlUsd: tvlSeries, composition, pegs: null, issuance: null },
  }
}

export async function getPoolDetail(poolId: number): Promise<PoolDetailResponse | null> {
  return cachedSwr(`explorer:pool:${poolId}:model`, 30_000, 300_000, async () => {
    const [pools, prices] = await Promise.all([loadCurrentPools(), ensurePrices()])
    // Live or destroyed stableswap pool first (params/history rows survive
    // destruction), otherwise an XYK LP token; ids never collide (XYK share
    // tokens are ≥ 1,000,000).
    const ss = await stableswapDetail(poolId, pools, prices)
    if (ss) return ss
    return xykDetail(poolId, pools, prices)
  })
}

// Omnipool page

// Which assets deserve their own band in a composition-over-time chart, ranked
// by PEAK SHARE of the (priced) pool total per bucket. Share is scale-free, so
// an asset that was a third of the pool years ago (DOT before its delisting)
// and a young asset that is large today both qualify — endpoint or peak-USD
// ranking each erase one era when the composition rotates under a shrinking
// TVL. Selected bands are ordered by total contribution (integral), so
// long-lived assets sit at the bottom of the stack and the rotation reads
// top-down; the rest folds into Other.
// `pin` ids are always selected when present (the Omnipool pins HDX: the
// protocol's own token holds a steady ~10% that never peaks above the era
// leaders, yet is the band readers look for first).
export function selectCompositionSeries(usdByAsset: Map<number, (number | null)[]>, bucketCount: number, topN: number, pin: number[] = []): { ids: number[]; restIds: number[] } {
  const totals = new Array<number>(bucketCount).fill(0)
  for (const series of usdByAsset.values()) {
    for (let i = 0; i < bucketCount; i++) if (series[i] != null) totals[i] += series[i]!
  }
  const peakShare = new Map<number, number>()
  const integral = new Map<number, number>()
  for (const [id, series] of usdByAsset) {
    let peak = 0
    let sum = 0
    for (let i = 0; i < bucketCount; i++) {
      const v = series[i]
      if (v == null) continue
      sum += v
      if (totals[i] > 0 && v / totals[i] > peak) peak = v / totals[i]
    }
    peakShare.set(id, peak)
    integral.set(id, sum)
  }
  const pinned = pin.filter(id => usdByAsset.has(id))
  const ranked = [...usdByAsset.keys()].filter(id => !pinned.includes(id))
    .sort((a, b) => (peakShare.get(b)! - peakShare.get(a)!) || a - b)
  const byRank = ranked.slice(0, Math.max(0, topN - pinned.length))
  const ids = [...pinned, ...byRank].sort((a, b) => (integral.get(b)! - integral.get(a)!) || a - b)
  return { ids, restIds: ranked.slice(Math.max(0, topN - pinned.length)) }
}

export async function getOmnipoolDetail(): Promise<OmnipoolResponse> {
  return cachedSwr('explorer:omnipool:model', 30_000, 300_000, async () => {
    const [pools, prices] = await Promise.all([loadCurrentPools(), ensurePrices()])

    let hubTotal = 0n
    for (const a of pools.omnipool.values()) hubTotal += a.hub
    const rows: OmnipoolAssetRow[] = [...pools.omnipool.values()].map(a => {
      const usd = usdOf(prices, a.assetId, a.reserve)
      return {
        asset: asset(a.assetId),
        reserve: a.reserve.toString(),
        reserveUsd: usd,
        hubReserve: a.hub.toString(),
        weightPct: hubTotal > 0n ? Number((a.hub * 1_000_000n) / hubTotal) / 10_000 : null,
        // Weight cap is a FixedU128 fraction of the pool (1e18 = 100%).
        capPct: a.cap > 0n ? Number(a.cap / 10n ** 12n) / 10_000 : null,
        tradable: tradableFlags(a.tradable),
      }
    }).sort((a, b) => (b.reserveUsd ?? -1) - (a.reserveUsd ?? -1))

    const tvlUsd = omnipoolTvl(pools, prices)

    // History: per-asset daily reserves valued at daily closes; top 8 by
    // current USD + Other. Series terminate at each asset's last sample, so
    // delisted assets end instead of forward-filling stale reserves.
    const histRes = await client.query({
      query: `SELECT asset_id, toString(toDate(block_timestamp)) AS d,
                     toString(argMax(toUInt256OrZero(reserve_raw), block_height)) AS v
              FROM price_data.omnipool_pool_state_history GROUP BY asset_id, d ORDER BY asset_id, d`,
      format: 'JSONEachRow',
    })
    const pointsByAsset = new Map<number, Map<string, number>>()
    for (const r of await histRes.json<{ asset_id: number; d: string; v: string }>()) {
      let m = pointsByAsset.get(r.asset_id)
      if (!m) { m = new Map(); pointsByAsset.set(r.asset_id, m) }
      m.set(r.d, Number(BigInt(r.v)) / 10 ** assetDescriptor(r.asset_id).decimals)
    }

    const end = lastClosedDay()
    let firstDay: string | null = null
    for (const m of pointsByAsset.values()) for (const d of m.keys()) if (firstDay == null || d < firstDay) firstDay = d
    const buckets = firstDay ? dailyGrid(firstDay, end) : []
    const closes = await dailyCloses([...pointsByAsset.keys()])

    const amountsByAsset = new Map<number, (number | null)[]>()
    const usdByAsset = new Map<number, (number | null)[]>()
    for (const [id, points] of pointsByAsset) {
      const amounts = carrySeries(buckets, points, pools.omnipool.has(id) ? end : undefined)
      const dayCloses = closes.get(id)
      amountsByAsset.set(id, amounts)
      usdByAsset.set(id, amounts.map((a, i) => {
        if (a == null) return null
        const px = dayCloses?.get(buckets[i])
        return px != null ? a * px : null
      }))
    }

    const tvlSeries = buckets.map((_, i) => {
      let sum = 0
      let any = false
      for (const [id, usdSeries] of usdByAsset) {
        // Only assets active that day count; an active-but-unpriced asset
        // makes the day's total unknowable rather than silently smaller.
        if (amountsByAsset.get(id)![i] == null) continue
        any = true
        if (usdSeries[i] == null) return null
        sum += usdSeries[i]!
      }
      return any ? sum : null
    })

    const { ids: topIds, restIds } = selectCompositionSeries(usdByAsset, buckets.length, 14, [0])
    const composition = topIds.map(id => ({ asset: assetDescriptor(id), usd: usdByAsset.get(id)! }))
    if (restIds.length) {
      const other: (number | null)[] = buckets.map((_, i) => {
        let sum: number | null = null
        for (const id of restIds) {
          const v = usdByAsset.get(id)![i]
          if (v != null) sum = (sum ?? 0) + v
        }
        return sum
      })
      composition.push({ asset: { ...assetDescriptor(-1), assetId: -1, symbol: 'Other', name: 'Other assets' }, usd: other })
    }

    // The pool predates the earliest daily closes, so the first months of
    // sampled state cannot be valued at all — trim that dead lead-in instead
    // of charting months of empty axis (this chart is USD-only; there is no
    // common amount unit across the pool's assets).
    let firstPriced = 0
    while (firstPriced < buckets.length && composition.every(c => c.usd[firstPriced] == null)) firstPriced++
    const chartBuckets = buckets.slice(firstPriced)
    const chartTvl = tvlSeries.slice(firstPriced)
    const chartComposition = composition.map(c => ({ asset: c.asset, usd: c.usd.slice(firstPriced) }))

    return {
      account: accountRef(OMNIPOOL_ACCOUNT),
      tvlUsd,
      assetCount: pools.omnipool.size,
      hubReserveTotal: hubTotal.toString(),
      lrnaPrice: priceOf(prices, LRNA_ASSET_ID),
      assets: rows,
      history: { buckets: chartBuckets, tvlUsd: chartTvl, composition: chartComposition },
    }
  })
}
