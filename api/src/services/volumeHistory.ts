import type { ClickHouseClient } from '../db/client.ts'
import { blockClock, heightAtOrBefore } from './blockClock.ts'
import { cached, cachedSwr } from './cache.ts'
import { serveChartWindow, type ChartGrid, type ChartWindowRequest, type ChartWindowResponse } from './chartWindow.ts'
import { allExplorerAssets, displayAssetId, displayDescriptor, H2O_ASSET_ID, idsDisplayedAs, UNDERLYING_TO_ATOKEN_ID } from './explorerAssets.ts'
import { accountRef, type AccountRef, type AssetRef } from './explorerService.ts'
import { keySeconds } from './historyGrain.ts'
import { moverAccountFilterSql } from './hdxService.ts'
import { iso } from './isoTimestamp.ts'
import { getAssetLiquidity, getOmnipoolDetail, getPoolDetail, getPoolsIndex, getUniswapV3PoolHistory, selectCompositionSeries, type PoolListEntry, type PoolListResponse } from './poolService.ts'
import { xykPoolMeta } from './poolVolumes.ts'
import { stableswapYield } from './poolYield.ts'
import { tradingVolumeAsOfBlock } from './accountVolumeHistory.ts'
import { HOLLAR_ASSET_ID } from './revenueStreams.ts'
import { economicModuleAccounts, SYSTEM_TAG_IDS, allTags } from './tagService.ts'
import { ASSET_VOLUME_HOURLY_TABLE, POOL_VOLUME_HOURLY_TABLE, ROUTED_VOLUME_HOURLY_TABLE } from './volumeHourly.ts'

// Trading volume on the explorer: the asset page, the pool pages, the pools and
// assets lists, and the /volume dashboard. Every figure is read from the three
// hourly read models (clickhouse/schema/006_public.sql, built by the derivations
// service — services/volumeHourly.ts states their rules), never from raw legs at
// request time, and each surface states exactly one of three definitions:
//
//  * ROUTED volume (platform): every trade once, netted across its route, aToken
//    wraps excluded — routed_volume_hourly, the definition of public
//    /v1/stats/platform totalRoutedUsd and the DefiLlama day series.
//  * VENUE / POOL volume: every fill once in the pool it executed in, valued by
//    its out side (in side when that is unpriced), the Omnipool counted once per
//    user swap — pool_volume_hourly, what /v1/pools/*/volumes answers. A trade
//    routed through two pools counts in both, so venue volumes sum to MORE than
//    routed volume; every surface showing both says so.
//  * ASSET volume: the value of the asset's own legs (sold plus bought) per venue
//    — asset_volume_hourly. A fill A → B adds to A and to B. The Omnipool hub H2O
//    has no rows (its legs are the venue's plumbing).
//
// Fees are never volume: LP fees and protocol fees ride beside it (the yield
// endpoints' split). Venue `aave` (aToken mint/redeem) is in none of the models.
//
// Every window ends at the CUT — the first hour the models have not published
// (their newest hour + 1 h; the derivations service folds each hour on the first
// cycle after it closes and is priced, so the cut trails the chain by the hour in
// progress plus at most one cycle). Rolling windows are [cut − N h, cut) and the previous period the N hours
// before; responses state the cut as `asOf`. The models are closed-hour sources, so
// caches key on the cut (the window) with plain TTLs, never on the live head.
//
// Volume/TVL is a window's volume over the MEAN pooled value across the same
// window, from the entity's own daily TVL series (the one its TVL chart draws):
// the mean of its last N daily points before the cut (7, 30 and 365 for the 7d,
// 30d and 12-month windows). 24h volume/TVL divides by the CURRENT TVL instead — a day's mean is the standing value to within the
// day's drift, and it is what lets the pools list state it for ~300 pools without
// reading each pool's history; a pool page reads the same figure the list shows.
// It is a ratio for the window, never annualised. A pool chart's per-bucket
// volume/TVL divides each bucket's volume by the TVL at that bucket's end.
//
// "TVL N ago" on the pool pages is a point of the same daily series: the daily
// close (a day's last sampled state) whose end lies nearest the instant N before
// the cut, never after the cut — dated, so the page can say which close it is.

let client: ClickHouseClient
export function initVolumeHistory(c: ClickHouseClient): void { client = c }

/** The venues the models hold, in a fixed order (the explorer UI orders its own stacks and legends by VENUE_ORDER, volumeColors.ts). */
export const VOLUME_VENUES = ['omnipool', 'stableswap', 'xyk', 'uniswapv3', 'otc', 'hsm', 'lbp'] as const
export type VolumeVenue = typeof VOLUME_VENUES[number]

export const VOLUME_RANGES = ['30d', '1y', 'all'] as const
export type VolumeRange = typeof VOLUME_RANGES[number]

const DAY = 86_400
const WINDOWS = { d1: 24, d7: 168, d30: 720, d365: 8_760 } as const
type WindowKey = keyof typeof WINDOWS

/** The default (unzoomed) chart's bar budget and its finest step: whole days. */
const DEFAULT_BARS = 120
/** The platform chart's fixed step per range tab: days for a month, Monday weeks for a year, fortnights for the era. */
const RANGE_STEP_SEC: Record<VolumeRange, number> = { '30d': DAY, '1y': 7 * DAY, all: 14 * DAY }
const RANGE_SPAN_SEC: Record<VolumeRange, number | null> = { '30d': 30 * DAY, '1y': 365 * DAY, all: null }

// ── shared shapes ─────────────────────────────────────────────────────────────

export interface WindowStat {
  volumeUsd: number
  /** The same span immediately before. */
  prevUsd: number
  /** (volume − prev) / prev × 100; null when the previous period traded nothing. */
  changePct: number | null
}
export interface VolumeKpis { d1: WindowStat; d7: WindowStat; d30: WindowStat; d365: WindowStat }

export function changePct(now: number, prev: number): number | null {
  return prev > 0 ? ((now - prev) / prev) * 100 : null
}

function stat(now: number, prev: number): WindowStat {
  return { volumeUsd: now, prevUsd: prev, changePct: changePct(now, prev) }
}

/** Window sums as returned by the SQL below: d1/p1, d7/p7, d30/p30, d365/p365 (current and previous span). */
export interface WindowSums { d1: number; p1: number; d7: number; p7: number; d30: number; p30: number; d365: number; p365: number }
export const ZERO_SUMS: WindowSums = { d1: 0, p1: 0, d7: 0, p7: 0, d30: 0, p30: 0, d365: 0, p365: 0 }

export function kpisOf(s: WindowSums): VolumeKpis {
  return { d1: stat(s.d1, s.p1), d7: stat(s.d7, s.p7), d30: stat(s.d30, s.p30), d365: stat(s.d365, s.p365) }
}

function addSums(a: WindowSums, b: WindowSums): WindowSums {
  return {
    d1: a.d1 + b.d1, p1: a.p1 + b.p1, d7: a.d7 + b.d7, p7: a.p7 + b.p7,
    d30: a.d30 + b.d30, p30: a.p30 + b.p30, d365: a.d365 + b.d365, p365: a.p365 + b.p365,
  }
}

/**
 * The eight window sums of `column` over hourly rows, as SQL aggregates: the
 * current span [cut − N h, cut) and the previous one [cut − 2N h, cut − N h) for
 * each window. Reads `{cut:DateTime}`; the caller bounds the scan to the two years
 * below the cut (LOOKBACK — the hourly models are small, a few hundred thousand
 * rows per year).
 */
export function windowSumsSql(column: string): string {
  return Object.entries(WINDOWS).map(([key, hours]) => {
    const prev = key.replace('d', 'p')
    return `toString(sumIf(${column}, hour >= {cut:DateTime} - INTERVAL ${hours} HOUR)) AS ${key},
       toString(sumIf(${column}, hour >= {cut:DateTime} - INTERVAL ${hours * 2} HOUR AND hour < {cut:DateTime} - INTERVAL ${hours} HOUR)) AS ${prev}`
  }).join(',\n       ')
}

const LOOKBACK = `hour >= {cut:DateTime} - INTERVAL ${WINDOWS.d365 * 2} HOUR AND hour < {cut:DateTime}`

const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
function sumsOf(r: Record<string, unknown>, prefix = ''): WindowSums {
  return {
    d1: num(r[`${prefix}d1`]), p1: num(r[`${prefix}p1`]), d7: num(r[`${prefix}d7`]),
    p7: num(r[`${prefix}p7`]), d30: num(r[`${prefix}d30`]), p30: num(r[`${prefix}p30`]),
    d365: num(r[`${prefix}d365`]), p365: num(r[`${prefix}p365`]),
  }
}

// ── the cut ───────────────────────────────────────────────────────────────────

export interface VolumeCut { cut: string; cutSec: number }

/**
 * The first hour none of the three models has published: the lowest of their
 * newest hours, plus one. Each is a partition-metadata max, so the read is cheap.
 * Null on an empty model.
 */
async function volumeCut(): Promise<VolumeCut | null> {
  return cached('explorer:volume:cut', 60_000, async () => {
    const res = await client.query({
      query: `SELECT toString(least(
                (SELECT max(hour) FROM ${POOL_VOLUME_HOURLY_TABLE}),
                (SELECT max(hour) FROM ${ASSET_VOLUME_HOURLY_TABLE}),
                (SELECT max(hour) FROM ${ROUTED_VOLUME_HOURLY_TABLE})) + INTERVAL 1 HOUR) AS cut`,
      format: 'JSONEachRow',
    })
    const cut = (await res.json<{ cut: string }>())[0]?.cut
    if (!cut || cut.startsWith('1970-01-01')) return null
    return { cut, cutSec: keySeconds(cut) }
  })
}

// ── per-pool and per-asset window sums (one tiny read each, per cut) ──────────

export interface PoolWindowSums {
  venue: string
  poolKey: string
  volume: WindowSums
  lpFee: WindowSums
  protocolFee: WindowSums
  fills: WindowSums
}

/** Every pool's window sums, keyed `${venue}:${poolKey}`. */
async function poolWindowSums(cut: VolumeCut): Promise<Map<string, PoolWindowSums>> {
  return cachedSwr(`explorer:volume:pool-windows:${cut.cut}`, 600_000, 3_600_000, async () => {
    const res = await client.query({
      query: `-- explorer:vol:pool-windows
SELECT venue, pool_key,
       ${windowSumsSql('volume_usd')},
       ${windowSumsSql('lp_fee_usd').replace(/ AS ([dp]\d+)/g, ' AS lp_$1')},
       ${windowSumsSql('protocol_fee_usd').replace(/ AS ([dp]\d+)/g, ' AS pf_$1')},
       ${windowSumsSql('fills').replace(/ AS ([dp]\d+)/g, ' AS f_$1')}
FROM ${POOL_VOLUME_HOURLY_TABLE}
WHERE ${LOOKBACK}
GROUP BY venue, pool_key`,
      query_params: { cut: cut.cut },
      format: 'JSONEachRow',
    })
    const out = new Map<string, PoolWindowSums>()
    for (const r of await res.json<Record<string, string>>()) {
      out.set(`${r.venue}:${r.pool_key}`, {
        venue: r.venue, poolKey: r.pool_key,
        volume: sumsOf(r), lpFee: sumsOf(r, 'lp_'), protocolFee: sumsOf(r, 'pf_'), fills: sumsOf(r, 'f_'),
      })
    }
    return out
  })
}

/** All-time totals and first hour per pool — the `.dl` rows' "all time" and a chart's start. */
export interface PoolLifetime { volumeUsd: number; lpFeeUsd: number; protocolFeeUsd: number; fills: number; firstHourSec: number }

async function poolLifetimes(cut: VolumeCut): Promise<Map<string, PoolLifetime>> {
  return cachedSwr(`explorer:volume:pool-life:${cut.cut}`, 600_000, 3_600_000, async () => {
    const res = await client.query({
      query: `-- explorer:vol:pool-life
SELECT venue, pool_key, toString(sum(volume_usd)) AS v, toString(sum(lp_fee_usd)) AS lp, toString(sum(protocol_fee_usd)) AS pf,
       sum(fills) AS f, toUnixTimestamp(min(hour)) AS first
FROM ${POOL_VOLUME_HOURLY_TABLE} WHERE hour < {cut:DateTime}
GROUP BY venue, pool_key`,
      query_params: { cut: cut.cut },
      format: 'JSONEachRow',
    })
    const out = new Map<string, PoolLifetime>()
    for (const r of await res.json<Record<string, string>>()) {
      out.set(`${r.venue}:${r.pool_key}`, { volumeUsd: num(r.v), lpFeeUsd: num(r.lp), protocolFeeUsd: num(r.pf), fills: num(r.f), firstHourSec: num(r.first) })
    }
    return out
  })
}

interface AssetVenueSums { assetId: number; venue: string; volume: WindowSums }

async function assetWindowRows(cut: VolumeCut): Promise<AssetVenueSums[]> {
  return cachedSwr(`explorer:volume:asset-windows:${cut.cut}`, 600_000, 3_600_000, async () => {
    const res = await client.query({
      query: `-- explorer:vol:asset-windows
SELECT asset_id, venue, ${windowSumsSql('volume_usd')}
FROM ${ASSET_VOLUME_HOURLY_TABLE}
WHERE ${LOOKBACK}
GROUP BY asset_id, venue`,
      query_params: { cut: cut.cut },
      format: 'JSONEachRow',
    })
    return (await res.json<Record<string, string>>()).map(r => ({ assetId: num(r.asset_id), venue: r.venue, volume: sumsOf(r) }))
  })
}

// ── the asset fold ────────────────────────────────────────────────────────────

/**
 * The registry ids an asset page's volume counts: the asset itself, every pool
 * share displayed under it (idsDisplayedAs — GDOT's page is also 2-Pool-GDOT's
 * trades), and each one's money-market aToken (UNDERLYING_TO_ATOKEN_ID, the
 * price/display direction — DOT's page is also aDOT's trades, which is how DOT
 * mostly trades in pools: the GDOT pool and the aDOT v3 pool hold aDOT). An aToken
 * is minted 1:1 over its reserve, so a trade of aDOT is a trade of DOT; the aToken's
 * own page keeps its own legs only. No fill holds both ids of a pair (the aave
 * wrap venue is in no model), so summing the ids counts nothing twice. The same
 * rule the v3 activity filter applies to a token (v3AssetAliases).
 */
export function assetVolumeIds(assetId: number): number[] {
  const ids = new Set<number>()
  for (const id of idsDisplayedAs(assetId)) {
    ids.add(id)
    const aToken = UNDERLYING_TO_ATOKEN_ID[id]
    if (aToken != null) ids.add(aToken)
  }
  ids.delete(H2O_ASSET_ID)
  return [...ids]
}

/**
 * The page an id's volume is shown on in a ranking (the inverse of assetVolumeIds):
 * an aToken folds into its reserve's display face, everything else into its own.
 */
export function assetVolumeOwner(id: number): number {
  for (const [underlying, aToken] of Object.entries(UNDERLYING_TO_ATOKEN_ID)) {
    if (aToken === id) return displayAssetId(Number(underlying))
  }
  return displayAssetId(id)
}

// ── chart grids ───────────────────────────────────────────────────────────────

/**
 * A chart request clamped to the published range: no bucket past the cut. The
 * window's own grid then follows the bucketed-history finality rule.
 */
function clampToCut(req: ChartWindowRequest, cut: VolumeCut): ChartWindowRequest {
  return { ...req, toSec: Math.min(req.toSec, cut.cutSec - 1) }
}

/** The default view of a whole-history chart: every hour since `startSec`, at least whole days. */
function wholeHistory(startSec: number, cut: VolumeCut): ChartWindowRequest {
  return { fromSec: startSec, toSec: cut.cutSec - 1, points: DEFAULT_BARS }
}

const EMPTY_CHART: ChartWindowResponse = { stepSec: 0, buckets: [], series: {} }

/** One flow series from rows keyed by bucket, aligned to the grid; 0 for a quiet bucket inside the range. */
function alignFlow(keys: string[], rows: Map<string, number>): number[] {
  return keys.map(k => rows.get(k) ?? 0)
}

/** Grid bounds as SQL literals: the rows a grid reads are [fromSec, min(endSec, cut)). */
function gridParams(grid: ChartGrid, cut: VolumeCut): Record<string, number> {
  return { from: grid.fromSec, to: Math.min(grid.endSec, cut.cutSec) }
}
const GRID_RANGE = 'hour >= toDateTime({from:UInt32}) AND hour < toDateTime({to:UInt32})'

/**
 * A state series (TVL) carried onto the grid: each bucket takes the newest point
 * of `series` keyed inside it (the state at the bucket's end), else the standing
 * value from an earlier bucket. Null until the first point.
 */
export function carryStateOnGrid(grid: { keys: string[]; stepSec: number }, points: { key: string; v: number | null }[]): (number | null)[] {
  const sorted = points.filter(p => p.v != null).map(p => ({ sec: keySeconds(p.key), v: p.v as number })).sort((a, b) => a.sec - b.sec)
  const out: (number | null)[] = []
  let j = 0
  let standing: number | null = null
  for (const key of grid.keys) {
    const end = keySeconds(key) + grid.stepSec
    while (j < sorted.length && sorted[j].sec < end) { standing = sorted[j].v; j++ }
    out.push(standing)
  }
  return out
}

/** The mean of the last `n` non-null points keyed before `beforeSec`; null with none. */
export function meanOfLast(points: { key: string; v: number | null }[], n: number, beforeSec: number): number | null {
  const vals = points.filter(p => p.v != null && keySeconds(p.key) < beforeSec).map(p => p.v as number)
  const last = vals.slice(-n)
  return last.length ? last.reduce((s, v) => s + v, 0) / last.length : null
}

export function ratio(volume: number, tvl: number | null | undefined): number | null {
  return tvl != null && tvl > 0 ? volume / tvl : null
}

/**
 * A state series folded to one point per UTC day: each day's newest point, keyed by
 * the day, so a finer-than-daily series reads like the daily ones. Pure.
 */
export function dailyCloses(points: { key: string; v: number | null }[]): { key: string; v: number | null }[] {
  const byDay = new Map<string, { sec: number; v: number | null }>()
  for (const p of points) {
    const sec = keySeconds(p.key)
    const day = new Date(Math.floor(sec / DAY) * DAY * 1000).toISOString().slice(0, 10)
    const cur = byDay.get(day)
    if (!cur || sec >= cur.sec) byDay.set(day, { sec, v: p.v })
  }
  return [...byDay].sort((a, b) => a[0].localeCompare(b[0])).map(([key, x]) => ({ key, v: x.v }))
}

/** A state figure as it stood a while ago: the value and the instant (ISO) of the point it is. */
export interface StateAgo { usd: number | null; at: string | null }

/**
 * The state `agoSec` before the cut from a series of `stepSec` buckets keyed by
 * their start, each holding the state at its end: the point whose END lies nearest
 * the target instant, among those ending at or before the cut. None when the target
 * precedes the series (the pool did not exist yet) or the nearest end is unpriced.
 */
export function stateAgo(points: { key: string; v: number | null }[], stepSec: number, cutSec: number, agoSec: number): StateAgo {
  const target = cutSec - agoSec
  const ends = points.map(p => ({ end: keySeconds(p.key) + stepSec, v: p.v })).filter(p => p.end <= cutSec)
  if (!ends.length || target < ends[0].end - stepSec) return { usd: null, at: null }
  let best = ends[0]
  for (const p of ends) if (Math.abs(p.end - target) < Math.abs(best.end - target)) best = p
  return { usd: best.v, at: best.v == null ? null : new Date(best.end * 1000).toISOString() }
}

const AGO_SEC = { d1: DAY, d7: 7 * DAY, d30: 30 * DAY, d365: 365 * DAY } as const

// ── asset page ────────────────────────────────────────────────────────────────

export interface AssetVolumeResponse {
  assetId: number
  /** The registry ids counted (assetVolumeIds), and the assets they are. */
  assetIds: number[]
  assets: AssetRef[]
  asOf: string | null
  kpis: VolumeKpis
  byVenue: { venue: string; d1: number; d7: number; d30: number; d365: number }[]
  allTimeUsd: number
  /** Volume/TVL for the window: volume ÷ the mean pooled value of the counted ids over it. */
  volumeTvl: {
    d7: number | null; d30: number | null; d365: number | null
    meanTvl7dUsd: number | null; meanTvl30dUsd: number | null; meanTvl365dUsd: number | null
  }
  /** Bars by venue; series keyed by venue. Empty when the asset never traded. */
  chart: ChartWindowResponse
}

async function assetLife(ids: number[], cut: VolumeCut): Promise<{ allUsd: number; firstSec: number | null }> {
  const res = await client.query({
    query: `-- explorer:vol:asset-life
SELECT toString(sum(volume_usd)) AS v, toUnixTimestamp(min(hour)) AS first, count() AS n
FROM ${ASSET_VOLUME_HOURLY_TABLE} WHERE asset_id IN {ids:Array(UInt32)} AND hour < {cut:DateTime}`,
    query_params: { ids, cut: cut.cut },
    format: 'JSONEachRow',
  })
  const r = (await res.json<{ v: string; first: number; n: string }>())[0]
  return { allUsd: num(r?.v), firstSec: r && num(r.n) > 0 ? num(r.first) : null }
}

async function assetChart(ids: number[], grid: ChartGrid, cut: VolumeCut): Promise<Record<string, (number | null)[]>> {
  const res = await client.query({
    query: `-- explorer:vol:asset-chart
SELECT ${grid.grain.keySql('hour')} AS k, venue, toString(sum(volume_usd)) AS v
FROM ${ASSET_VOLUME_HOURLY_TABLE}
WHERE asset_id IN {ids:Array(UInt32)} AND ${GRID_RANGE}
GROUP BY k, venue`,
    query_params: { ids, ...gridParams(grid, cut) },
    format: 'JSONEachRow',
  })
  const byVenue = new Map<string, Map<string, number>>()
  for (const r of await res.json<{ k: string; venue: string; v: string }>()) {
    let m = byVenue.get(r.venue)
    if (!m) { m = new Map(); byVenue.set(r.venue, m) }
    m.set(r.k, num(r.v))
  }
  // Every venue on every grid, so a zoomed window carries the keys the coarse bands name.
  return Object.fromEntries(VOLUME_VENUES.map(v => [v, alignFlow(grid.keys, byVenue.get(v) ?? new Map())]))
}

/** Daily pooled USD of the counted ids, summed per day (the Liquidity tab's own history). */
async function assetDailyTvl(ids: number[]): Promise<{ key: string; v: number | null }[]> {
  const histories = await Promise.all(ids.map(id => getAssetLiquidity(id).then(r => r.history).catch(() => null)))
  const byDay = new Map<string, number>()
  for (const h of histories) {
    if (!h) continue
    h.buckets.forEach((b, i) => {
      let sum: number | null = null
      for (const s of h.series) if (s.usd[i] != null) sum = (sum ?? 0) + (s.usd[i] as number)
      if (sum != null) byDay.set(b, (byDay.get(b) ?? 0) + sum)
    })
  }
  return [...byDay].map(([key, v]) => ({ key, v })).sort((a, b) => a.key.localeCompare(b.key))
}

export async function getAssetVolume(assetId: number, win?: ChartWindowRequest): Promise<AssetVolumeResponse | ChartWindowResponse> {
  const cut = await volumeCut()
  const ids = assetVolumeIds(assetId)
  if (!cut) return win ? EMPTY_CHART : emptyAssetVolume(assetId, ids)
  const life = await cachedSwr(`explorer:volume:asset-life:${assetId}:${cut.cut}`, 600_000, 3_600_000, () => assetLife(ids, cut))
  const chartOf = (req: ChartWindowRequest, minStepSec?: number) => life.firstSec == null
    ? Promise.resolve(EMPTY_CHART)
    : serveChartWindow(client, 'volume', `asset:${assetId}:${cut.cut}`, clampToCut(req, cut),
      { startSec: life.firstSec, ...(minStepSec ? { minStepSec } : {}) }, g => assetChart(ids, g, cut))
  if (win) return chartOf(win)
  return cachedSwr(`explorer:volume:asset:${assetId}:${cut.cut}`, 300_000, 3_600_000, async () => {
    const [rows, chart, tvl] = await Promise.all([
      assetWindowRows(cut),
      life.firstSec == null ? Promise.resolve(EMPTY_CHART) : chartOf(wholeHistory(life.firstSec, cut), DAY),
      assetDailyTvl(ids),
    ])
    const idSet = new Set(ids)
    let total = ZERO_SUMS
    const venues = new Map<string, WindowSums>()
    for (const r of rows) {
      if (!idSet.has(r.assetId)) continue
      total = addSums(total, r.volume)
      venues.set(r.venue, addSums(venues.get(r.venue) ?? ZERO_SUMS, r.volume))
    }
    const mean7 = meanOfLast(tvl, 7, cut.cutSec)
    const mean30 = meanOfLast(tvl, 30, cut.cutSec)
    const mean365 = meanOfLast(tvl, 365, cut.cutSec)
    return {
      assetId, assetIds: ids, assets: ids.map(displayDescriptor), asOf: iso(cut.cut),
      kpis: kpisOf(total),
      byVenue: VOLUME_VENUES.filter(v => venues.has(v)).map(v => {
        const s = venues.get(v)!
        return { venue: v, d1: s.d1, d7: s.d7, d30: s.d30, d365: s.d365 }
      }),
      allTimeUsd: life.allUsd,
      volumeTvl: {
        d7: ratio(total.d7, mean7), d30: ratio(total.d30, mean30), d365: ratio(total.d365, mean365),
        meanTvl7dUsd: mean7, meanTvl30dUsd: mean30, meanTvl365dUsd: mean365,
      },
      chart,
    }
  })
}

function emptyAssetVolume(assetId: number, ids: number[]): AssetVolumeResponse {
  return {
    assetId, assetIds: ids, assets: ids.map(displayDescriptor), asOf: null, kpis: kpisOf(ZERO_SUMS), byVenue: [], allTimeUsd: 0,
    volumeTvl: { d7: null, d30: null, d365: null, meanTvl7dUsd: null, meanTvl30dUsd: null, meanTvl365dUsd: null }, chart: EMPTY_CHART,
  }
}

/** 24h asset volume per listed asset (the Assets list column), on the page's fold. */
async function assetVolume24hById(): Promise<{ asOf: string | null; byAsset: Map<number, number> }> {
  const cut = await volumeCut()
  if (!cut) return { asOf: null, byAsset: new Map() }
  return cachedSwr(`explorer:volume:asset-24h:${cut.cut}`, 600_000, 3_600_000, async () => {
    const byId = new Map<number, number>()
    for (const r of await assetWindowRows(cut)) byId.set(r.assetId, (byId.get(r.assetId) ?? 0) + r.volume.d1)
    const byAsset = new Map<number, number>()
    for (const a of allExplorerAssets()) {
      let v = 0
      let any = false
      for (const id of assetVolumeIds(a.assetId)) {
        const x = byId.get(id)
        if (x != null) { v += x; any = true }
      }
      if (any) byAsset.set(a.assetId, v)
    }
    return { asOf: iso(cut.cut), byAsset }
  })
}

/** The Assets list rows with `volume24hUsd` added (additive; null where the asset has no rows in the window). */
export async function withAssetVolume24h<T extends { assetId: number }>(rows: T[]): Promise<(T & { volume24hUsd: number | null })[]> {
  let byAsset = new Map<number, number>()
  try { byAsset = (await assetVolume24hById()).byAsset } catch (err) { console.warn('[volume] asset 24h volume unavailable:', (err as Error).message) }
  // A cross-chain destination (negative sentinel id) and the hub H2O (no asset volume by definition) carry none.
  return rows.map(r => ({ ...r, volume24hUsd: r.assetId >= 0 && assetVolumeIds(r.assetId).length ? (byAsset.get(r.assetId) ?? 0) : null }))
}

// ── pools ─────────────────────────────────────────────────────────────────────

export type VolumePoolKind = 'omnipool' | 'stableswap' | 'xyk' | 'uniswapv3'

export interface PoolVolumeResponse {
  venue: VolumePoolKind
  poolKey: string
  asOf: string | null
  kpis: VolumeKpis
  fees: Record<WindowKey, { lpUsd: number; protocolUsd: number }>
  fills: Record<WindowKey, number>
  allTime: { volumeUsd: number; lpFeeUsd: number; protocolFeeUsd: number; fills: number }
  /**
   * Current TVL (the pools list's), the 7-, 30- and 365-day mean TVL, and
   * volume/TVL for 24h (over the current TVL) and 7d, 30d, 12 months (over the
   * window's mean).
   */
  tvlUsd: number | null
  meanTvl7dUsd: number | null
  meanTvl30dUsd: number | null
  meanTvl365dUsd: number | null
  volumeTvl: Record<WindowKey, number | null>
  /** The TVL 24 h, 7, 30 and 365 days before the cut: the daily close nearest each instant (stateAgo), dated. */
  tvlAgo: Record<WindowKey, StateAgo>
  /** The 7-day fee APR the yield endpoints publish (stableswap only; null elsewhere). */
  feeApr7dPct: number | null
  /**
   * Bars per bucket: `volume`, `lpFees`, `protocolFees`, `fills`, `tvl` (the
   * pool's TVL at the bucket's end) and `volumeTvl` (the bucket's volume over that
   * TVL, a ratio; null without a positive TVL); the Omnipool adds one band per stacked asset
   * (`a:<id>`, plus `other`) — the bucket's volume split by each asset's share of
   * the value bought and sold in it (asset volume, where a swap counts for both of
   * its assets), so the bands sum to the bucket's volume.
   */
  chart: ChartWindowResponse
  /** The Omnipool's stacked assets, in band order. */
  stackAssets?: AssetRef[]
}

interface PoolTarget {
  venue: VolumePoolKind
  poolKey: string
  /** The explorer's id for the pool (share/LP id), null for the Omnipool and v3. */
  poolId: number | null
  /** Daily TVL history and a windowed one for sub-day grids. */
  dailyTvl: () => Promise<{ key: string; v: number | null }[]>
  /** Daily TVL over at least the year before the cut — the window means and the "TVL N ago" figures. */
  recentDailyTvl: (cut: VolumeCut) => Promise<{ key: string; v: number | null }[]>
  windowTvl: (grid: ChartGrid) => Promise<{ key: string; v: number | null }[]>
  currentTvl: () => Promise<number | null>
}

const pointsOf = (h: { buckets: string[]; tvlUsd: (number | null)[] } | null | undefined) =>
  h ? h.buckets.map((key, i) => ({ key, v: h.tvlUsd[i] ?? null })) : []

function indexTvl(index: PoolListResponse, match: (e: PoolListEntry) => boolean): number | null {
  return index.pools.find(match)?.tvlUsd ?? null
}

async function poolTarget(kind: 'omnipool' | 'pool' | 'v3', id: string): Promise<PoolTarget | null> {
  if (kind === 'omnipool') {
    const dailyTvl = async () => pointsOf((await getOmnipoolDetail()).history)
    return {
      venue: 'omnipool', poolKey: 'omnipool', poolId: null,
      dailyTvl, recentDailyTvl: dailyTvl,
      windowTvl: async g => pointsOf((await getOmnipoolDetail(g.grain, { fromSec: g.fromSec, toSec: g.endSec - 1 })).history),
      currentTvl: async () => indexTvl(await getPoolsIndex(), e => e.kind === 'omnipool'),
    }
  }
  if (kind === 'v3') {
    const address = id.toLowerCase()
    return {
      venue: 'uniswapv3', poolKey: address, poolId: null,
      dailyTvl: async () => ((await getUniswapV3PoolHistory(address))?.points ?? []).map(p => ({ key: p.bucket, v: p.tvlUsd })),
      // The pool history's default view is its whole life on the coarsest grain that
      // fits, so the means read a trailing window instead: 400 points over the 366
      // days below the cut is daily or finer (a younger pool's window is shorter),
      // folded to each day's last point — the state at the day's end.
      recentDailyTvl: async cut => dailyCloses(((await getUniswapV3PoolHistory(address, { fromSec: cut.cutSec - 366 * DAY, toSec: cut.cutSec - 1 }, 400))?.points ?? [])
        .map(p => ({ key: p.bucket, v: p.tvlUsd }))),
      windowTvl: async g => ((await getUniswapV3PoolHistory(address, { fromSec: g.fromSec, toSec: g.endSec - 1 }, g.keys.length))?.points ?? []).map(p => ({ key: p.bucket, v: p.tvlUsd })),
      currentTvl: async () => indexTvl(await getPoolsIndex(), e => e.kind === 'uniswapv3' && e.address?.toLowerCase() === address),
    }
  }
  const poolId = Number(id)
  const detail = await getPoolDetail(poolId)
  if (!detail) return null
  return {
    venue: detail.kind,
    // A stableswap pool is keyed by its id, an XYK pair by its pool account.
    poolKey: detail.kind === 'stableswap' ? String(poolId) : detail.account.accountId.toLowerCase(),
    poolId,
    dailyTvl: async () => pointsOf((await getPoolDetail(poolId))?.history),
    recentDailyTvl: async () => pointsOf((await getPoolDetail(poolId))?.history),
    windowTvl: async g => pointsOf((await getPoolDetail(poolId, g.grain, { fromSec: g.fromSec, toSec: g.endSec - 1 }))?.history),
    currentTvl: async () => detail.destroyed ? null : (indexTvl(await getPoolsIndex(), e => e.kind === detail.kind && e.poolId === poolId) ?? detail.tvlUsd),
  }
}

async function poolFlowRows(venue: string, poolKey: string, grid: ChartGrid, cut: VolumeCut): Promise<Record<string, number[]>> {
  const res = await client.query({
    query: `-- explorer:vol:pool-chart
SELECT ${grid.grain.keySql('hour')} AS k, toString(sum(volume_usd)) AS v, toString(sum(lp_fee_usd)) AS lp,
       toString(sum(protocol_fee_usd)) AS pf, sum(fills) AS f
FROM ${POOL_VOLUME_HOURLY_TABLE}
WHERE venue = {venue:String} AND pool_key = {key:String} AND ${GRID_RANGE}
GROUP BY k`,
    query_params: { venue, key: poolKey, ...gridParams(grid, cut) },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ k: string; v: string; lp: string; pf: string; f: string }>()
  const pick = (f: (r: typeof rows[number]) => string) => alignFlow(grid.keys, new Map(rows.map(r => [r.k, num(f(r))])))
  return { volume: pick(r => r.v), lpFees: pick(r => r.lp), protocolFees: pick(r => r.pf), fills: pick(r => r.f) }
}

/**
 * The Omnipool's stacked assets (at most 10, HDX always among them): the six
 * that traded most over the last year — the pool as a reader knows it today —
 * plus the four that held the largest peak monthly share over its whole history,
 * so an era leader since delisted (DOT before its aDOT migration) keeps its band.
 * Ordered by all-time volume, so long-lived assets sit at the bottom of the stack.
 */
async function omnipoolStackIds(cut: VolumeCut): Promise<number[]> {
  return cachedSwr(`explorer:volume:omni-stack:${cut.cut.slice(0, 10)}`, 6 * 3_600_000, 48 * 3_600_000, async () => {
    const res = await client.query({
      query: `-- explorer:vol:omni-stack
SELECT asset_id, toString(toStartOfMonth(hour)) AS m, toString(sum(volume_usd)) AS v,
       toString(sumIf(volume_usd, hour >= {cut:DateTime} - INTERVAL 365 DAY)) AS recent
FROM ${ASSET_VOLUME_HOURLY_TABLE} WHERE venue = 'omnipool' AND hour < {cut:DateTime}
GROUP BY asset_id, m ORDER BY m`,
      query_params: { cut: cut.cut },
      format: 'JSONEachRow',
    })
    const rows = await res.json<{ asset_id: number; m: string; v: string; recent: string }>()
    return pickStackIds(rows.map(r => ({ id: displayAssetId(num(r.asset_id)), month: r.m, usd: num(r.v), recentUsd: num(r.recent) })))
  })
}

/** The stacking rule above over monthly per-asset volume rows. Pure. */
export function pickStackIds(rows: { id: number; month: string; usd: number; recentUsd: number }[], pin: number[] = [0]): number[] {
  const months = [...new Set(rows.map(r => r.month))].sort()
  const mi = new Map(months.map((m, i) => [m, i]))
  const monthly = new Map<number, (number | null)[]>()
  const recent = new Map<number, number>()
  const total = new Map<number, number>()
  for (const r of rows) {
    let s = monthly.get(r.id)
    if (!s) { s = new Array(months.length).fill(null); monthly.set(r.id, s) }
    const i = mi.get(r.month)!
    s[i] = (s[i] ?? 0) + r.usd
    recent.set(r.id, (recent.get(r.id) ?? 0) + r.recentUsd)
    total.set(r.id, (total.get(r.id) ?? 0) + r.usd)
  }
  const byRecent = [...recent].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id)
  const byPeak = selectCompositionSeries(monthly, months.length, 4).ids
  const ids: number[] = []
  for (const id of [...pin.filter(p => monthly.has(p)), ...byRecent.slice(0, 6), ...byPeak]) {
    if (!ids.includes(id) && ids.length < 10) ids.push(id)
  }
  return ids.sort((a, b) => (total.get(b)! - total.get(a)!) || a - b)
}

/**
 * Split each bucket's venue volume across assets by their share of the bucket's
 * asset volume. Pure; `assetRows` maps band key → per-bucket asset volume, the
 * bands sum to `volume` wherever any asset traded, and a bucket with volume but
 * no asset rows keeps it all in `other`.
 */
export function apportionByShare(volume: number[], assetRows: Map<string, number[]>, otherKey = 'other'): Record<string, number[]> {
  const keys = [...assetRows.keys()]
  const out: Record<string, number[]> = Object.fromEntries([...keys, otherKey].map(k => [k, new Array<number>(volume.length).fill(0)]))
  volume.forEach((v, i) => {
    const total = keys.reduce((s, k) => s + (assetRows.get(k)![i] ?? 0), 0)
    if (!(total > 0)) { out[otherKey][i] += v; return }
    for (const k of keys) out[k][i] += v * ((assetRows.get(k)![i] ?? 0) / total)
  })
  return out
}

async function omnipoolStacks(grid: ChartGrid, cut: VolumeCut, volume: number[]): Promise<Record<string, number[]>> {
  const stack = await omnipoolStackIds(cut)
  const res = await client.query({
    query: `-- explorer:vol:omni-assets
SELECT ${grid.grain.keySql('hour')} AS k, asset_id, toString(sum(volume_usd)) AS v
FROM ${ASSET_VOLUME_HOURLY_TABLE}
WHERE venue = 'omnipool' AND ${GRID_RANGE}
GROUP BY k, asset_id`,
    query_params: gridParams(grid, cut),
    format: 'JSONEachRow',
  })
  const index = new Map(grid.keys.map((k, i) => [k, i]))
  const stacked = new Set(stack)
  const rows = new Map<string, number[]>([...stack.map(id => [`a:${id}`, new Array<number>(grid.keys.length).fill(0)] as const), ['rest', new Array<number>(grid.keys.length).fill(0)]])
  for (const r of await res.json<{ k: string; asset_id: number; v: string }>()) {
    const i = index.get(r.k)
    if (i == null) continue
    const id = displayAssetId(num(r.asset_id))
    rows.get(stacked.has(id) ? `a:${id}` : 'rest')![i] += num(r.v)
  }
  const split = apportionByShare(volume, rows, 'unattributed')
  // The un-stacked assets' share and any bucket without asset rows are one "Other" band.
  const other = split.rest.map((v, i) => v + split.unattributed[i])
  delete split.rest
  delete split.unattributed
  return { ...split, other }
}

async function poolChart(t: PoolTarget, grid: ChartGrid, cut: VolumeCut): Promise<Record<string, (number | null)[]>> {
  const [flows, tvlPoints] = await Promise.all([
    poolFlowRows(t.venue, t.poolKey, grid, cut),
    (grid.grain.stepSec < DAY ? t.windowTvl(grid) : t.dailyTvl()).catch(() => []),
  ])
  const tvl = carryStateOnGrid({ keys: grid.keys, stepSec: grid.grain.stepSec }, tvlPoints)
  const volumeTvl = flows.volume.map((v, i) => ratio(v, tvl[i]))
  const series: Record<string, (number | null)[]> = { ...flows, tvl, volumeTvl }
  if (t.venue === 'omnipool') Object.assign(series, await omnipoolStacks(grid, cut, flows.volume))
  return series
}

const EMPTY_FEES = { lpUsd: 0, protocolUsd: 0 }

export async function getPoolVolume(kind: 'omnipool' | 'pool' | 'v3', id: string, win?: ChartWindowRequest): Promise<PoolVolumeResponse | ChartWindowResponse | null> {
  const t = await poolTarget(kind, id)
  if (!t) return null
  const cut = await volumeCut()
  if (!cut) return win ? EMPTY_CHART : null
  const key = `${t.venue}:${t.poolKey}`
  const life = (await poolLifetimes(cut)).get(key)
  const chartOf = (req: ChartWindowRequest, minStepSec?: number) => !life
    ? Promise.resolve(EMPTY_CHART)
    : serveChartWindow(client, 'volume', `pool:${key}:${cut.cut}`, clampToCut(req, cut),
      { startSec: life.firstHourSec, ...(minStepSec ? { minStepSec } : {}) }, g => poolChart(t, g, cut))
  if (win) return chartOf(win)
  return cachedSwr(`explorer:volume:pool:${key}:${cut.cut}`, 300_000, 3_600_000, async () => {
    const [windows, chart, daily, tvlUsd, apr] = await Promise.all([
      poolWindowSums(cut),
      life ? chartOf(wholeHistory(life.firstHourSec, cut), DAY) : Promise.resolve(EMPTY_CHART),
      t.recentDailyTvl(cut).catch(() => []),
      t.currentTvl().catch(() => null),
      t.venue === 'stableswap' ? stableswapYield(client, '7d').catch(() => null) : Promise.resolve(null),
    ])
    const w = windows.get(key)
    const v = w?.volume ?? ZERO_SUMS
    const mean7 = meanOfLast(daily, 7, cut.cutSec)
    const mean30 = meanOfLast(daily, 30, cut.cutSec)
    const mean365 = meanOfLast(daily, 365, cut.cutSec)
    const aprItem = apr?.items.find(i => i.poolId === t.poolKey)
    const fees = (k: WindowKey) => w ? { lpUsd: w.lpFee[k], protocolUsd: w.protocolFee[k] } : EMPTY_FEES
    const fills = (k: WindowKey) => w?.fills[k] ?? 0
    const ago = (k: WindowKey) => stateAgo(daily, DAY, cut.cutSec, AGO_SEC[k])
    const stackAssets = t.venue === 'omnipool' ? (await omnipoolStackIds(cut)).map(displayDescriptor) : undefined
    return {
      venue: t.venue, poolKey: t.poolKey, asOf: iso(cut.cut),
      kpis: kpisOf(v),
      fees: { d1: fees('d1'), d7: fees('d7'), d30: fees('d30'), d365: fees('d365') },
      fills: { d1: fills('d1'), d7: fills('d7'), d30: fills('d30'), d365: fills('d365') },
      allTime: { volumeUsd: life?.volumeUsd ?? 0, lpFeeUsd: life?.lpFeeUsd ?? 0, protocolFeeUsd: life?.protocolFeeUsd ?? 0, fills: life?.fills ?? 0 },
      tvlUsd, meanTvl7dUsd: mean7, meanTvl30dUsd: mean30, meanTvl365dUsd: mean365,
      volumeTvl: { d1: ratio(v.d1, tvlUsd), d7: ratio(v.d7, mean7), d30: ratio(v.d30, mean30), d365: ratio(v.d365, mean365) },
      tvlAgo: { d1: ago('d1'), d7: ago('d7'), d30: ago('d30'), d365: ago('d365') },
      feeApr7dPct: aprItem?.feeAprPerc != null ? Number(aprItem.feeAprPerc) : null,
      chart,
      ...(stackAssets ? { stackAssets } : {}),
    }
  })
}

// ── the pools list ────────────────────────────────────────────────────────────

/** The pool_volume_hourly key a list entry trades under; null for an entry no model keys. */
export function listEntryPoolKey(e: PoolListEntry, xykAccountByLp: Map<number, string>): string | null {
  if (e.kind === 'omnipool') return 'omnipool:omnipool'
  if (e.kind === 'stableswap' && e.poolId != null) return `stableswap:${e.poolId}`
  if (e.kind === 'xyk' && e.poolId != null) {
    const account = xykAccountByLp.get(e.poolId)
    return account ? `xyk:${account}` : null
  }
  if (e.kind === 'uniswapv3' && e.address) return `uniswapv3:${e.address.toLowerCase()}`
  return null
}

async function xykAccountsByLp(): Promise<Map<number, string>> {
  const meta = await xykPoolMeta(client)
  const out = new Map<number, string>()
  for (const [account, m] of meta) if (m.shareTokenId != null) out.set(Number(m.shareTokenId), account.toLowerCase())
  return out
}

export type PoolListEntryWithVolume = PoolListEntry & { volume24hUsd: number | null; volume7dUsd: number | null; volumeTvl24h: number | null }

/**
 * The pools list with each row's venue volume added (additive): 24h and 7d
 * volume, and 24h volume over the row's own current TVL — the same window sums
 * and the same denominator the pool page reads. Null where the model has no key
 * for the row; 0 where it traded nothing.
 */
export async function withPoolVolumes(index: PoolListResponse): Promise<PoolListResponse & { volumeAsOf: string | null; pools: PoolListEntryWithVolume[] }> {
  try {
    const cut = await volumeCut()
    if (!cut) throw new Error('volume models are empty')
    const [windows, xyk] = await Promise.all([poolWindowSums(cut), xykAccountsByLp()])
    return {
      ...index,
      volumeAsOf: iso(cut.cut),
      pools: index.pools.map(e => {
        const key = listEntryPoolKey(e, xyk)
        if (!key) return { ...e, volume24hUsd: null, volume7dUsd: null, volumeTvl24h: null }
        const w = windows.get(key)?.volume ?? ZERO_SUMS
        return { ...e, volume24hUsd: w.d1, volume7dUsd: w.d7, volumeTvl24h: ratio(w.d1, e.tvlUsd) }
      }),
    }
  } catch (err) {
    console.warn('[volume] pool volumes unavailable:', (err as Error).message)
    return { ...index, volumeAsOf: null, pools: index.pools.map(e => ({ ...e, volume24hUsd: null, volume7dUsd: null, volumeTvl24h: null })) }
  }
}

// ── the platform dashboard ────────────────────────────────────────────────────

export interface PlatformTopPool {
  venue: string
  name: string
  /** Where the row links: the share/LP id, a v3 contract, or neither (the Omnipool, HSM). */
  poolId: number | null
  address: string | null
  volume7dUsd: number
  tvlUsd: number | null
  /** 7d volume over the pool's mean daily TVL across the 7 days. */
  volumeTvl7d: number | null
  /**
   * The pool's assets for its icons, as the pools index composes it (largest
   * first): a v3 pool's two tokens, an XYK pair's two sides even when the index
   * no longer lists it, the HOLLAR Stability Module's HOLLAR; empty when unknown.
   */
  assets: AssetRef[]
}
export interface PlatformTopAsset { asset: AssetRef; volume7dUsd: number; sharePct: number }
export interface PlatformTopTrader { account: AccountRef; volume7dUsd: number; trades: number }

export interface PlatformVolumeResponse {
  asOf: string | null
  range: VolumeRange
  /** Routed volume (every trade once) per window, with the previous period. */
  routed: VolumeKpis
  routedTrades: Record<WindowKey, number>
  /** Venue volume (every fill once in its pool) per venue and window. */
  venues: { venue: string; kpis: VolumeKpis }[]
  venueTotal: VolumeKpis
  /** Bars stacked by venue (venue volume) with `routed` per bucket. */
  chart: ChartWindowResponse
  topPools: PlatformTopPool[]
  topAssets: PlatformTopAsset[]
  topTraders: PlatformTopTrader[]
  /** The block range the traders' 7 days cover (account_trade_volume), and that model's newest block. */
  tradersWindow: { fromBlock: number; toBlock: number; asOfBlock: number | null } | null
}

async function routedWindowSums(cut: VolumeCut): Promise<{ volume: WindowSums; trades: WindowSums }> {
  return cachedSwr(`explorer:volume:routed-windows:${cut.cut}`, 600_000, 3_600_000, async () => {
    const res = await client.query({
      query: `-- explorer:vol:routed-windows
SELECT ${windowSumsSql('volume_usd')}, ${windowSumsSql('trades').replace(/ AS ([dp]\d+)/g, ' AS t_$1')}
FROM ${ROUTED_VOLUME_HOURLY_TABLE} WHERE ${LOOKBACK}`,
      query_params: { cut: cut.cut },
      format: 'JSONEachRow',
    })
    const r = (await res.json<Record<string, string>>())[0] ?? {}
    return { volume: sumsOf(r), trades: sumsOf(r, 't_') }
  })
}

async function platformChart(grid: ChartGrid, cut: VolumeCut): Promise<Record<string, (number | null)[]>> {
  const params = gridParams(grid, cut)
  const [venueRes, routedRes] = await Promise.all([
    client.query({
      query: `-- explorer:vol:platform-venues
SELECT ${grid.grain.keySql('hour')} AS k, venue, toString(sum(volume_usd)) AS v
FROM ${POOL_VOLUME_HOURLY_TABLE} WHERE ${GRID_RANGE} GROUP BY k, venue`,
      query_params: params, format: 'JSONEachRow',
    }),
    client.query({
      query: `-- explorer:vol:platform-routed
SELECT ${grid.grain.keySql('hour')} AS k, toString(sum(volume_usd)) AS v, sum(trades) AS t
FROM ${ROUTED_VOLUME_HOURLY_TABLE} WHERE ${GRID_RANGE} GROUP BY k`,
      query_params: params, format: 'JSONEachRow',
    }),
  ])
  const byVenue = new Map<string, Map<string, number>>()
  for (const r of await venueRes.json<{ k: string; venue: string; v: string }>()) {
    let m = byVenue.get(r.venue)
    if (!m) { m = new Map(); byVenue.set(r.venue, m) }
    m.set(r.k, num(r.v))
  }
  const routed = await routedRes.json<{ k: string; v: string; t: string }>()
  return {
    ...Object.fromEntries(VOLUME_VENUES.map(v => [v, alignFlow(grid.keys, byVenue.get(v) ?? new Map())])),
    routed: alignFlow(grid.keys, new Map(routed.map(r => [r.k, num(r.v)]))),
    trades: alignFlow(grid.keys, new Map(routed.map(r => [r.k, num(r.t)]))),
  }
}

/** The platform's first published hour — the 'all' range's start. */
async function platformStartSec(): Promise<number | null> {
  return cached('explorer:volume:platform-start', 3_600_000, async () => {
    const res = await client.query({ query: `SELECT toUnixTimestamp(min(hour)) AS s, count() AS n FROM ${POOL_VOLUME_HOURLY_TABLE}`, format: 'JSONEachRow' })
    const r = (await res.json<{ s: number; n: string }>())[0]
    return r && num(r.n) > 0 ? num(r.s) : null
  })
}

export function rangeRequest(range: VolumeRange, cut: VolumeCut, startSec: number): ChartWindowRequest {
  const span = RANGE_SPAN_SEC[range]
  return { fromSec: span == null ? startSec : Math.max(startSec, cut.cutSec - span), toSec: cut.cutSec - 1, points: 400 }
}

async function platformChartFor(cut: VolumeCut, req: ChartWindowRequest, stepSec?: number): Promise<ChartWindowResponse> {
  const startSec = await platformStartSec()
  if (startSec == null) return EMPTY_CHART
  return serveChartWindow(client, 'volume', `platform:${cut.cut}`, clampToCut(req, cut),
    { startSec, ...(stepSec ? { stepSec } : {}) }, g => platformChart(g, cut))
}

/** The platform chart over a zoom window (the /volume page's refine). */
export async function getPlatformVolumeWindow(req: ChartWindowRequest): Promise<ChartWindowResponse> {
  const cut = await volumeCut()
  return cut ? platformChartFor(cut, req) : EMPTY_CHART
}

const TOP_N = 10

async function topPools(cut: VolumeCut): Promise<PlatformTopPool[]> {
  const [windows, index, xykMeta] = await Promise.all([poolWindowSums(cut), getPoolsIndex(), xykPoolMeta(client)])
  // Pools, not order books: OTC orders and the LBP's one-off sales are venues without a pool to rank.
  const ranked = [...windows.values()]
    .filter(w => ['omnipool', 'stableswap', 'xyk', 'uniswapv3', 'hsm'].includes(w.venue) && w.volume.d7 > 0)
    .sort((a, b) => b.volume.d7 - a.volume.d7)
    .slice(0, TOP_N)
  return Promise.all(ranked.map(async w => {
    let name = w.venue === 'hsm' ? 'HOLLAR Stability Module' : w.poolKey
    let poolId: number | null = null
    let address: string | null = null
    let entry: PoolListEntry | undefined
    let fallbackAssets: AssetRef[] = []
    let daily: Promise<{ key: string; v: number | null }[]> = Promise.resolve([])
    if (w.venue === 'omnipool') {
      name = 'Omnipool'
      entry = index.pools.find(e => e.kind === 'omnipool')
      daily = getOmnipoolDetail().then(d => pointsOf(d.history))
    } else if (w.venue === 'stableswap') {
      poolId = Number(w.poolKey)
      entry = index.pools.find(e => e.kind === 'stableswap' && e.poolId === poolId)
      name = entry?.name ?? displayDescriptor(poolId).symbol
      daily = getPoolDetail(poolId).then(d => pointsOf(d?.history))
    } else if (w.venue === 'xyk') {
      const meta = xykMeta.get(w.poolKey)
      poolId = meta?.shareTokenId != null ? Number(meta.shareTokenId) : null
      entry = poolId != null ? index.pools.find(e => e.kind === 'xyk' && e.poolId === poolId) : undefined
      if (meta?.assetA != null && meta.assetB != null) fallbackAssets = [displayDescriptor(Number(meta.assetA)), displayDescriptor(Number(meta.assetB))]
      name = entry?.name ?? (fallbackAssets.length ? `${fallbackAssets[0].symbol} / ${fallbackAssets[1].symbol}` : 'XYK pool')
      if (poolId != null) { const id = poolId; daily = getPoolDetail(id).then(d => pointsOf(d?.history)) }
    } else if (w.venue === 'uniswapv3') {
      address = w.poolKey
      entry = index.pools.find(e => e.kind === 'uniswapv3' && e.address?.toLowerCase() === address)
      name = entry?.name ?? 'Uniswap v3 pool'
      daily = getUniswapV3PoolHistory(address).then(h => (h?.points ?? []).map(p => ({ key: p.bucket, v: p.tvlUsd })))
    }
    if (w.venue === 'hsm') fallbackAssets = [displayDescriptor(HOLLAR_ASSET_ID)]
    const mean7 = meanOfLast(await daily.catch(() => []), 7, cut.cutSec)
    const assets = entry?.composition.length ? entry.composition.map(c => c.asset) : fallbackAssets
    return { venue: w.venue, name, poolId, address, volume7dUsd: w.volume.d7, tvlUsd: entry?.tvlUsd ?? null, volumeTvl7d: ratio(w.volume.d7, mean7), assets }
  }))
}

async function topAssets(cut: VolumeCut): Promise<PlatformTopAsset[]> {
  const byOwner = new Map<number, number>()
  let total = 0
  for (const r of await assetWindowRows(cut)) {
    if (!(r.volume.d7 > 0)) continue
    const owner = assetVolumeOwner(r.assetId)
    byOwner.set(owner, (byOwner.get(owner) ?? 0) + r.volume.d7)
    total += r.volume.d7
  }
  return [...byOwner].sort((a, b) => b[1] - a[1]).slice(0, TOP_N)
    .map(([id, v]) => ({ asset: displayDescriptor(id), volume7dUsd: v, sharePct: total > 0 ? (v / total) * 100 : 0 }))
}

/**
 * Tags whose members are protocol machinery to the top-traders table: SYSTEM_TAG_IDS
 * (left as is — the HDX movers and other surfaces read it) plus the HOLLAR Stability
 * Module and the referrals fee pot.
 */
const TOP_TRADER_PLUMBING_TAG_IDS: ReadonlySet<string> = new Set([...SYSTEM_TAG_IDS, 'hollar-stability-module', 'fee-referrals'])

/**
 * The 7 days' largest traders by their netted trading volume (account_trade_volume,
 * the accounts directory's Trading figure), each account on its own — protocol
 * plumbing left out: module (modl) pallet accounts except the tagged economic ones
 * (the Treasury's DCA program is a real trader), and every member of a plumbing tag
 * (TOP_TRADER_PLUMBING_TAG_IDS: the system tags — pool accounts, pots, sovereigns,
 * money-market contracts — plus the HOLLAR Stability Module and the referrals fee
 * pot, which trade as protocol machinery, not as actors). The exclusion is in the
 * SQL, so the LIMIT fills the table. The ICE pot's routes are already outside the
 * model. The window is block-bounded: the trades in
 * (last block before cut − 7 d, last block before the cut].
 */
async function topTraders(cut: VolumeCut): Promise<{ rows: PlatformTopTrader[]; window: PlatformVolumeResponse['tradersWindow'] }> {
  const clock = await blockClock(client)
  const toBlock = heightAtOrBefore(clock, cut.cutSec - 1)
  const fromBlock = heightAtOrBefore(clock, cut.cutSec - 7 * DAY - 1)
  if (toBlock == null || fromBlock == null) return { rows: [], window: null }
  const tags = allTags()
  const plumbing = new Set(tags.filter(t => TOP_TRADER_PLUMBING_TAG_IDS.has(t.tagId)).flatMap(t => t.members))
  // A plumbing tag's modl member (the HSM's py/hsmod pot) must not ride back in as an economic module.
  const economicModl = economicModuleAccounts(tags).filter(m => !plumbing.has(m))
  const [rows, asOfBlock] = await Promise.all([
    client.query({
      query: `-- explorer:vol:top-traders
SELECT account, sum(tv) AS total, toString(total) AS v, sum(tc) AS c
FROM (
  SELECT account, block_height, trade_key, argMax(volume_usd, computed_at) AS tv, argMax(trade_count, computed_at) AS tc
  FROM price_data.account_trade_volume
  WHERE block_height > {from:UInt32} AND block_height <= {to:UInt32} AND ${moverAccountFilterSql(economicModl)}
    AND account NOT IN {plumbing:Array(String)}
  GROUP BY account, block_height, trade_key
)
GROUP BY account ORDER BY total DESC LIMIT {n:UInt32}`,
      query_params: { from: fromBlock, to: toBlock, plumbing: [...plumbing], n: TOP_N },
      format: 'JSONEachRow',
    }).then(res => res.json<{ account: string; v: string; c: string }>()),
    tradingVolumeAsOfBlock(client, clock.heights.length ? clock.heights[clock.heights.length - 1] : 0),
  ])
  return {
    rows: rows.map(r => ({ account: accountRef(r.account), volume7dUsd: num(r.v), trades: num(r.c) })),
    window: { fromBlock: fromBlock + 1, toBlock, asOfBlock },
  }
}

export async function getPlatformVolume(range: VolumeRange): Promise<PlatformVolumeResponse | null> {
  // Keyed by the cut, like every other volume surface, so they all flip to a new hour together.
  const cut = await volumeCut()
  if (!cut) return null
  return cachedSwr(`explorer:volume:platform:${range}:${cut.cut}`, 300_000, 3_600_000, async () => {
    const startSec = await platformStartSec()
    if (startSec == null) return null
    const [routed, windows, chart, pools, assets, traders] = await Promise.all([
      routedWindowSums(cut),
      poolWindowSums(cut),
      platformChartFor(cut, rangeRequest(range, cut, startSec), RANGE_STEP_SEC[range]),
      topPools(cut),
      topAssets(cut),
      topTraders(cut),
    ])
    const venueSums = new Map<string, WindowSums>()
    for (const w of windows.values()) venueSums.set(w.venue, addSums(venueSums.get(w.venue) ?? ZERO_SUMS, w.volume))
    const venueTotal = [...venueSums.values()].reduce(addSums, ZERO_SUMS)
    return {
      asOf: iso(cut.cut), range,
      routed: kpisOf(routed.volume),
      routedTrades: { d1: routed.trades.d1, d7: routed.trades.d7, d30: routed.trades.d30, d365: routed.trades.d365 },
      venues: VOLUME_VENUES.filter(v => venueSums.has(v)).map(v => ({ venue: v, kpis: kpisOf(venueSums.get(v)!) })),
      venueTotal: kpisOf(venueTotal),
      chart,
      topPools: pools,
      topAssets: assets,
      topTraders: traders.rows,
      tradersWindow: traders.window,
    }
  })
}
