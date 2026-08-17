import type { ClickHouseClient } from '../../db/client.ts'
import { cachedSwr } from '../../services/cache.ts'
import { allExplorerAssets } from '../../services/explorerAssets.ts'
import { getPoolsIndex } from '../../services/poolService.ts'
import { formatUsd } from './accountBalances.ts'
import { moneyMarketSupply } from './moneyMarketReserves.ts'
import { ensurePoolService, foldedPlatformTvl, tvlComponents } from './platformStats.ts'
import { DECIMAL_STRINGS, WINDOW_HOURS, readAnchor, renderUsd, routedNettedCteSql, scaledUsd } from './poolVolumes.ts'

// GET /hydration-web/v1/stats — the five numbers hydration.net's homepage reads.
//
// This replaces HydraDX-api's `/hydration-web/v1/stats` by a base-URL swap, so the
// five field names, their JSON-number types and the endpoint's path are the
// incumbent's, NOT the /v1 wire conventions (which is why it lives outside /v1).
// The numbers behind them are this indexer's own models, and where a definition
// differs from the incumbent's it is documented on the route.
//
// USD arithmetic runs at the 1e-12 integer scale the rest of the surface uses and
// is converted to a JSON number exactly once, at the wire — the same one-way
// concession /api/v1/fees/charts and /defillama/v1/* make to an inherited contract.

/** Hydration's chain id in Ocelloids' network URN scheme. */
const HYDRATION_URN = 'urn:ocn:polkadot:2034'

/** The window every "_30d" field reports. */
const WINDOW: '30d' = '30d'

export interface WebStats {
  /** Pooled TVL plus the money market's own supplied value, de-duplicated both ways. */
  tvl: number | null
  /** Netted routed trading volume over the rolling 30 days; null while nothing is indexed. */
  vol_30d: number | null
  /** USD value of XCM transfers into and out of Hydration over 30 days, or null when unavailable. */
  xcm_vol_30d: number | null
  assets_count: number
  accounts_count: number
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

/**
 * The netted routed total over a 30-day window, folded IN THE QUERY.
 *
 * `routedTradesUsd` streams one row per trade so the netting rule has a single
 * tested TS definition, and that is why its `RoutedWindow` stops at 24h: a 7-day
 * window already returns 100 580 rows, past the client's 100 000-row cap, and a
 * 30-day one measures 200 301. Widening the window therefore means moving the fold
 * into SQL, which `greatest(side_in, side_out)` does — the same "larger of the two
 * boundary sides" rule `nettedTradeScaled` applies row by row, and pinned against
 * it in tests. Everything before the fold, including the aToken-wrap exclusion, is
 * the shared `routedNettedCteSql`, so this figure and /defillama/v1/volume differ
 * only in their window.
 *
 * Measured: 1.8 s cold for the 30-day window against the leg projection, held for
 * the endpoint's 600 s.
 */
export function buildWebVolumeSql(): string {
  return `-- pub:webstats:volume
WITH ${routedNettedCteSql()}
SELECT toString(sum(greatest(side_in, side_out))) AS total_usd
FROM (
  SELECT trade_key,
         sum(greatest(-net_usd, toDecimal256(0, 12))) AS side_in,
         sum(greatest(net_usd, toDecimal256(0, 12))) AS side_out
  FROM netted
  GROUP BY trade_key
  HAVING min(all_aave) = 0
)
WHERE side_in > 0 OR side_out > 0`
}

/**
 * Distinct accounts that have ever held a balance of any asset.
 *
 * `account_asset_latest_balances` keeps a row per (account, asset) once seen, so
 * this counter only ever grows — which is what a homepage figure must do. Counting
 * only accounts holding something RIGHT NOW is a different, non-monotone number
 * (measured 100 010 against 115 318) and would read as users leaving whenever dust
 * is swept.
 */
const ACCOUNTS_SQL = `-- pub:webstats:accounts
SELECT toString(uniqExact(account_id)) AS accounts
FROM price_data.account_asset_latest_balances`

// ---------------------------------------------------------------------------
// XCM volume (Ocelloids)
// ---------------------------------------------------------------------------

const OCELLOIDS_URL = process.env.EXPLORER_OCELLOIDS_URL?.trim() || 'https://api.ocelloids.net'
const OCELLOIDS_TOKEN = process.env.EXPLORER_OCELLOIDS_TOKEN?.trim()

/** Ocelloids answers in well under a second; a slow hop must not hold the homepage. */
const OCELLOIDS_TIMEOUT_MS = 3000
const XCM_TTL_MS = 600_000
/**
 * How long a last-known XCM figure may cover for a failing query. Three TTLs: long
 * enough that one blip or one Ocelloids restart does not blank the homepage,
 * short enough that a genuinely dead feed becomes an explicit null instead of a
 * number that quietly stopped moving.
 */
const XCM_GRACE_MS = XCM_TTL_MS * 3

let xcmCache: { value: number; at: number } | null = null
let xcmWarnedAt = 0

interface TransfersTotalItem {
  volumeUsd?: { current?: number }
}

/**
 * 30 days of XCM transfer value in USD, from the Ocelloids `xcm` agent — the same
 * source and the same query the incumbent endpoint used, verified against it: this
 * returned $23,748,747.08 while `api.hydradx.io` served $23,722,527.86 minutes
 * earlier, a 0.11% drift over the intervening transfers.
 *
 * Notes a reader needs:
 *  * The timeframe enum has no "30 days"; "1 months" is the 30-day bucket.
 *  * The `network` criterion is bidirectional (`origin = net OR destination = net`),
 *    so this is Hydration's inbound plus outbound, counted once per journey.
 *  * Unpriced transfers are summed as zero upstream, so the figure is a floor.
 *  * An unknown op or a bad criterion returns HTTP 200 with `{"items":[]}` rather
 *    than an error, which is why an item count of exactly one is asserted instead
 *    of trusting the status.
 *
 * Without EXPLORER_OCELLOIDS_TOKEN the field is null. It is never estimated from
 * indexed data: this indexer sees Hydration's side of a journey, not the value of
 * the leg on the other chain.
 */
export async function xcmVolume30d(now: number = Date.now()): Promise<number | null> {
  if (xcmCache && now - xcmCache.at < XCM_TTL_MS) return xcmCache.value
  if (!OCELLOIDS_TOKEN) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), OCELLOIDS_TIMEOUT_MS)
    try {
      const res = await fetch(`${OCELLOIDS_URL}/query/xcm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OCELLOIDS_TOKEN}` },
        body: JSON.stringify({
          args: { op: 'transfers_total', criteria: { timeframe: '1 months', network: HYDRATION_URN } },
        }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json() as { items?: TransfersTotalItem[] }
      const items = body.items ?? []
      if (items.length !== 1) throw new Error(`expected one aggregate row, received ${items.length}`)
      const value = items[0]?.volumeUsd?.current
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('aggregate row carries no volumeUsd.current')
      xcmCache = { value, at: now }
      return value
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    // One line per TTL, not per request: a dead feed must be visible without
    // drowning the log while the grace window covers for it.
    if (now - xcmWarnedAt >= XCM_TTL_MS) {
      xcmWarnedAt = now
      console.warn(`[public-api] Ocelloids xcm transfers_total failed (${(error as Error).message}); `
        + `${xcmCache ? 'serving the last known figure' : 'xcm_vol_30d is null'}`)
    }
    return xcmCache && now - xcmCache.at < XCM_GRACE_MS ? xcmCache.value : null
  }
}

/** Test seam: the module-level XCM memo, which outlives a single request by design. */
export function resetXcmCache(): void {
  xcmCache = null
  xcmWarnedAt = 0
}

// ---------------------------------------------------------------------------
// TVL
// ---------------------------------------------------------------------------

/**
 * The single platform headline: everything pooled, plus what the money market
 * holds that is not already pooled, minus what the pools hold that the money
 * market already counts.
 *
 * The two totals OVERLAP IN BOTH DIRECTIONS, and both folds are removed here.
 * Measured live on 2026-08-13, against $52.1 M of money-market supply and $29.5 M
 * of pooled TVL:
 *
 *  * $13.9 M of the money market is Stableswap SHARE tokens (2-Pool-GDOT,
 *    2-Pool-HUSDT, 3-Pool, …) deposited as collateral. A share token IS a claim on
 *    a pool whose reserves are already in `stableswapUsd`.
 *  * $8.58 M of the POOLS is money-market aTokens — the pools are suppliers too:
 *    pool 690 holds aDOT, 4200 holds aETH, the stablepools hold aUSDT/aUSDC/aEURC/
 *    aSOL, 10055 holds BIL, and the Omnipool holds asset 1001 (aDOT) directly.
 *    Each is also inside `moneyMarketSupplyUsd`.
 *  * $10.9 M of stHDX in the GIGAHDX market is NOT an overlap and stays in: that
 *    HDX is locked in its holder's own wallet and no pool holds it. (It IS excluded
 *    from an account's net worth, where the wallet HDX is counted separately —
 *    a different question.)
 *
 * The conservation equation, its no-remainder argument and the enforced
 * priced-pool invariant live on `foldedPlatformTvl` and `poolShareAssetIds` in
 * platformStats.ts, which owns both folds so that /v1/stats/platform publishes the
 * very components this headline is folded from.
 */
export async function webStats(client: ClickHouseClient): Promise<WebStats> {
  return cachedSwr('pub:webstats', 600_000, 1_800_000, async () => {
    ensurePoolService(client)
    const [index, moneyMarket, volume, accounts, xcm] = await Promise.all([
      getPoolsIndex(),
      moneyMarketSupply(client),
      routedVolume(client),
      accountsCount(client),
      xcmVolume30d(),
    ])

    const folded = foldedPlatformTvl(tvlComponents(index.pools, moneyMarket))
    return {
      tvl: folded == null ? null : Number(formatUsd(folded)),
      vol_30d: volume,
      // Two decimals like its siblings: `tvl` and `vol_30d` are rounded to cents
      // on the way out, and an upstream double printed to fifteen digits next to
      // them would suggest a precision the aggregate does not have.
      xcm_vol_30d: xcm == null ? null : Number(xcm.toFixed(2)),
      assets_count: allExplorerAssets().length,
      accounts_count: accounts,
    }
  })
}

/**
 * Null, not 0, while the leg projection is empty: "no trades indexed" is not "no
 * trades happened", and every sibling volume surface reports the empty model as an
 * absent anchor rather than as a zero window.
 */
async function routedVolume(client: ClickHouseClient): Promise<number | null> {
  const at = await readAnchor(client)
  if (!at) return null
  const res = await client.query({
    query: buildWebVolumeSql(),
    query_params: { anchor: at.anchor, hours: WINDOW_HOURS[WINDOW] },
    format: 'JSONEachRow',
    clickhouse_settings: DECIMAL_STRINGS,
  })
  const [row] = await res.json<{ total_usd: string }>()
  return Number(renderUsd(scaledUsd(row?.total_usd)))
}

async function accountsCount(client: ClickHouseClient): Promise<number> {
  const res = await client.query({ query: ACCOUNTS_SQL, format: 'JSONEachRow' })
  const [row] = await res.json<{ accounts: string }>()
  return Number(row?.accounts ?? 0)
}
