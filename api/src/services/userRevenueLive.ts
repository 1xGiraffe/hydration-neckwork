// The user river's LIVE half: what users earn, per block, before the hourly
// fold has booked it.
//
// User Revenue itself is booked per CLOSED hour (userRevenueRead.ts); the river
// on /revenue streams ahead of it in two modes:
//
//   live — every earning stream with a per-block source:
//     * EVENTS, read from a one-hour raw tail like the protocol river's
//       (revenueStreams.ts revenueTailRows): every venue's retained trade-fee
//       legs (Omnipool, stableswap, XYK, Uniswap v3 — the v3 leg net of the
//       pool's protocol fee in force at the swap), the GIGAHDX pot's HDX
//       inflows, and referrer commissions at their claim. Each pot event's
//       holder-side amount is multiplied by the USER share of its pot —
//       user ÷ (user + protocol + unattributed) of the stream's facts in the
//       newest folded hour that booked that pot, carried forward
//       (userRevenueShares). A pot with no known share yet is skipped, never
//       assumed to be all users': protocol-owned liquidity and treasury
//       holdings are not User Revenue. A referral claim names its earner, so
//       the earner is classed directly (holderClassOf, the fold's rule): a user
//       streams the whole claim, any other class nothing.
//     * RATES, for interest that accrues every block with no event of its own:
//       lending interest and lending incentives drip at their user accrual in
//       the newest folded hour that booked any money-market fact — the fold
//       books every accruing pot every hour, so a pot absent from that hour has
//       stopped accruing and stops dripping (measured, not modelled).
//   mean — the REVISABLE streams (userRevenueStreams.ts `revisable`: token
//       accrual and its catch-up, farm rewards, GIGAHDX voting) and legacy
//       staking stream their mean over the trailing 24 folded hours: the
//       revisable ones because their newest hours are not decided yet, legacy
//       staking because the pot's HDX inflows run well below the gross accrual
//       the fold books (AccumulatedRpsUpdated), so its inflows would under-report.
//
// PAGING. Items page by (block, event, leg) — the FIRST page-size items after the
// cursor, the cursor moving to the last one returned, so a dense stretch is
// served over several pulls rather than dropped. The cursor keeps TWO positions:
// one for the sources written as their block is ingested, one for the Uniswap v3
// legs, which the uniswap_v3_legs derivation writes minutes later. A v3 leg
// streams only once every resolvable v3 Swap at or below its block has its fee
// leg written (userFlowV3ReadySql), so a late v3 leg is still ahead of the v3
// position when it lands and streams exactly once.
//
// Earnings only: costs users pay (borrow interest, exit fees, forfeits) never
// stream, and no item or drip is negative.
//
// What the live events leave out, deliberately: the add/remove fees a
// stableswap or Omnipool exit leaves in the pool (an inflow the fold books, but
// read from remove events rather than fee legs) — they reach the books in the
// hourly fold, not the river.

import { OMNIPOOL_ACCOUNT, amountUnitSql, priceAliasSql, priceSourceSql, scaledUsd } from './valuation.ts'
import {
  V3_FEE_PROTOCOL_CTE,
  V3_FEE_PROTOCOL_SIDES_SQL,
  V3_POOLS_CTE,
  V3_TOKEN_ASSETS_CTE,
  v3EventAtKeySql,
  v3FeeSideSql,
  v3TokenAssetSql,
} from './revenueStreams.ts'
import { priceSeriesFillSql } from './userRevenueFold.ts'
import { HUB_FEE_TO_HDX_SUBPOOL_BLOCK } from './userRevenueLp.ts'
import { GIGAHDX_POT } from './userRevenueMm.ts'
import { USER_REVENUE_STREAMS, holderClassOf, type HolderSets } from './userRevenueStreams.ts'

/** Streams the river shows as per-block EVENTS (items), each scaled by its pot's user share. */
export const USER_FLOW_EVENT_STREAMS = [
  'lp_fee_omnipool', 'lp_fee_stableswap', 'lp_fee_xyk', 'lp_fee_uniswap_v3',
  'gigahdx_yield', 'referral_commissions',
] as const
/** Streams that accrue every block with no event: dripped at their user accrual in the newest folded money-market hour. */
export const USER_FLOW_RATE_STREAMS = ['mm_supply_interest', 'mm_incentives'] as const
/**
 * Streams dripped at their trailing mean (USER_FLOW_MEAN_HOURS): the revisable
 * ones, and legacy staking, whose pot inflows under-report the gross accrual the
 * fold books.
 */
export const USER_FLOW_MEAN_STREAMS: readonly string[] = [...USER_REVENUE_STREAMS.filter(s => s.revisable).map(s => s.id), 'staking_legacy']
/** The stream whose items page on their own cursor position (written late by the uniswap_v3_legs derivation). */
export const USER_FLOW_V3_STREAM = 'lp_fee_uniswap_v3'
/** Items per page: a denser stretch is served over the next pulls. */
export const USER_FLOW_PAGE_ITEMS = 400
/** A cursorless call seeds the river with the newest minute of the tail. */
export const USER_FLOW_SEED_SECONDS = 60

/** Revisable streams stream their mean over this many folded hours. */
export const USER_FLOW_MEAN_HOURS = 24
/**
 * How far back a pot's share is looked for: the sparsest event pots book a fact
 * only at their events (a referral claim, a staking reward-per-stake update — a
 * few a day), and a lookback shorter than that gap would skip the pot.
 */
export const USER_FLOW_SHARE_LOOKBACK_HOURS = 14 * 24
/** How far back the newest folded money-market hour is looked for (none within it: no lending drip). */
export const USER_FLOW_RATE_LOOKBACK_HOURS = 48
/** The raw event tail's span, the protocol river's: a cursor older than it resumes at its start. */
export const USER_FLOW_TAIL_HOURS = 1

/** A tail row: one earning event's holder-side amount, valued at event time (1e-12 USD decimal string). */
export interface UserFlowTailRow {
  stream: string
  pot: string
  block_height: number
  block_timestamp: string
  event_index: number
  leg_index: number
  /** The earner an event names (a referral claim's referrer), else ''. */
  earner: string
  asset_id: number
  amount_usd: string
}

/** A pot's user share, as the fold booked it in the newest hour holding the pot: user and all-class USD (1e-12). */
export interface UserShare { user: bigint; total: bigint; hour: number }
export const userShareKey = (stream: string, pot: string): string => `${stream}|${pot}`

/** A tail row with its user part (1e-12 USD, > 0). */
export type AttributedRow = UserFlowTailRow & { userUsd1e12: bigint }

/**
 * Each event's user part. An event that names its earner (a referral claim) is
 * the earner's alone: the whole amount when the earner is a `user` under the
 * fold's holder-class rule, nothing otherwise. Any other event is its
 * holder-side value × user ÷ total of its pot's share. A pot with no share, a
 * share whose total is not positive, or a user part that is not positive
 * (protocol-held, or a user side that netted to a cost) streams nothing. A user
 * side above the total (a sign mix inside the hour) is capped at the whole event.
 */
export function attributeUserShares(rows: readonly UserFlowTailRow[], shares: ReadonlyMap<string, UserShare>, holders: HolderSets): AttributedRow[] {
  const out: AttributedRow[] = []
  for (const row of rows) {
    const usd = scaledUsd(row.amount_usd)
    if (usd <= 0n) continue
    if (row.stream === 'referral_commissions') {
      if (holderClassOf(row.earner, holders) === 'user') out.push({ ...row, userUsd1e12: usd })
      continue
    }
    const share = shares.get(userShareKey(row.stream, row.pot))
    if (!share || share.total <= 0n || share.user <= 0n) continue
    const user = share.user > share.total ? share.total : share.user
    const part = (usd * user) / share.total
    if (part > 0n) out.push({ ...row, userUsd1e12: part })
  }
  return out
}

/** A position in the tail: (block, event, leg); an item is after it when its triple is greater. */
export type FlowKey = readonly [block: number, event: number, leg: number]
/** The cursor's two positions: the at-ingest sources, and the late-written Uniswap v3 legs. */
export interface UserFlowCursor { main: FlowKey; v3: FlowKey }

const MAX_EVENT = 4_294_967_295
const MAX_LEG = 65_535
/** The position just before `block`: every item of the block (event 0 included) is after it. */
export const beforeBlock = (block: number): FlowKey => (block > 0 ? [block - 1, MAX_EVENT, MAX_LEG] : [0, 0, -1])

const KEY = String.raw`(\d{1,10})-(\d{1,10})-(\d{1,5})`
const USER_FLOW_CURSOR_RE = new RegExp(`^u1\\.${KEY}\\.${KEY}$`)

/** The opaque cursor string ("u1.<block>-<event>-<leg>.<block>-<event>-<leg>": at-ingest, then v3). */
export function formatUserFlowCursor(c: UserFlowCursor): string {
  const k = ([b, e, l]: FlowKey): string => `${b}-${Math.max(0, e)}-${Math.max(0, l)}`
  return `u1.${k(c.main)}.${k(c.v3)}`
}

/** The cursor a caller passed; null for none, and for anything else (an older client's plain cursor): it re-seeds. */
export function parseUserFlowCursor(s: string | null | undefined): UserFlowCursor | null {
  const m = s ? USER_FLOW_CURSOR_RE.exec(s) : null
  if (!m) return null
  const n = m.slice(1).map(Number)
  if (n.some(x => !Number.isSafeInteger(x)) || n[1] > MAX_EVENT || n[4] > MAX_EVENT || n[2] > MAX_LEG || n[5] > MAX_LEG) return null
  return { main: [n[0], n[1], n[2]], v3: [n[3], n[4], n[5]] }
}

const afterKey = (row: Pick<UserFlowTailRow, 'block_height' | 'event_index' | 'leg_index'>, [b, e, l]: FlowKey): boolean =>
  row.block_height !== b ? row.block_height > b : row.event_index !== e ? row.event_index > e : row.leg_index > l

const rowTime = (row: Pick<UserFlowTailRow, 'block_timestamp'>): number => Math.floor(Date.parse(`${row.block_timestamp.replace(' ', 'T')}Z`) / 1000)

export interface UserFlowPageInput<R extends UserFlowTailRow> {
  /** The attributed rows (what can stream). */
  rows: readonly R[]
  /** Every tail row's newest block time (unix s), attributed or not: the seed's anchor; null for an empty tail. */
  newestSeconds: number | null
  cursor: UserFlowCursor | null
  head: number
  /** The highest block at or below which every resolvable v3 Swap in the tail has its fee leg written. */
  v3Ready: number
  limit?: number
}

/**
 * One page of items and the next cursor (PURE). Without a cursor the river is
 * seeded from the newest minute of the tail — anchored on the tail's newest row,
 * not on the wall clock, since rows land most of a minute after their block —
 * or, for an empty tail, from just before the head block. Then: each at-ingest
 * row after the main position, and each v3 row after the v3 position at or below
 * `v3Ready`, in (block, event, leg) order, the FIRST `limit` of them; each
 * position moves to the last row of its kind returned, so nothing is skipped and
 * nothing repeats.
 */
export function pageUserFlow<R extends UserFlowTailRow>(input: UserFlowPageInput<R>): { rows: R[]; cursor: UserFlowCursor } {
  let cursor = input.cursor
  if (!cursor) {
    const floor = input.newestSeconds == null ? null : input.newestSeconds - USER_FLOW_SEED_SECONDS
    const first = floor == null ? undefined : input.rows.find(r => rowTime(r) > floor)
    const start = beforeBlock(first ? first.block_height : input.head)
    cursor = { main: start, v3: start }
  }
  const { main, v3 } = cursor
  const eligible = input.rows
    .filter(r => (r.stream === USER_FLOW_V3_STREAM ? r.block_height <= input.v3Ready && afterKey(r, v3) : afterKey(r, main)))
    .sort((a, b) => a.block_height - b.block_height || a.event_index - b.event_index || a.leg_index - b.leg_index || (a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : 0))
  const page = eligible.slice(0, input.limit ?? USER_FLOW_PAGE_ITEMS)
  const lastOf = (v3Kind: boolean): FlowKey | null => {
    for (let i = page.length - 1; i >= 0; i -= 1) {
      const r = page[i]
      if ((r.stream === USER_FLOW_V3_STREAM) === v3Kind) return [r.block_height, r.event_index, r.leg_index]
    }
    return null
  }
  return { rows: page, cursor: { main: lastOf(false) ?? main, v3: lastOf(true) ?? v3 } }
}

/** The tail window every arm binds ({anchor}, {hours}). */
const WINDOW = `block_timestamp > {anchor:DateTime} - INTERVAL {hours:UInt32} HOUR
      AND block_timestamp <= {anchor:DateTime}`

/**
 * The raw event tail: one row per earning event in the window, its HOLDER-side
 * amount (the fee a pool kept, the HDX a staking pot received, the commission a
 * referrer claimed) valued at the last 1h candle closed before it — the
 * protocol tail's event-time rule (revenueStreams.ts valuedTailSql). The legs
 * are the fold's own (userRevenueLp.ts feeLegs): a leg the venue's pool kept,
 * keyed to the fold's pot (`omnipool:<asset>`, the hub fee into the HDX
 * sub-pool `omnipool:0`; `stableswap:<pool>`; `xyk:<share asset>`; `v3:<pool>`).
 */
export function userFlowTailSql(): string {
  return `-- rev:user-flow-tail
WITH ${V3_TOKEN_ASSETS_CTE},
${V3_POOLS_CTE},
${V3_FEE_PROTOCOL_CTE},
xyk AS (
  SELECT lower(argMax(pool_account, ingested_at)) AS acct, lp_asset_id AS lp FROM price_data.xyk_pool_registry GROUP BY lp_asset_id
),
legs AS (
  SELECT venue, pool_key, block_height, event_index, leg_index, min(block_timestamp) AS block_time,
         argMax(asset_id, ingested_at) AS leg_asset, argMax(toUInt256OrZero(amount), ingested_at) AS gross,
         lower(argMax(fee_recipient, ingested_at)) AS recipient
  FROM price_data.pool_swap_legs
  WHERE venue IN ('omnipool', 'stableswap', 'xyk', 'uniswapv3') AND leg_kind = 'fee' AND ${WINDOW}
  GROUP BY venue, pool_key, block_height, event_index, leg_index
),
-- A v3 swap's fee less the pool's protocol share in force at the swap (the protocol stream's ASOF rule).
v3_sides AS (
  SELECT l.pool_key AS pool_key, l.block_height AS block_height, l.event_index AS event_index, l.leg_index AS leg_index,
         ${v3EventAtKeySql('l')} AS at_key, ${v3FeeSideSql('l.leg_asset')} AS side
  FROM legs AS l
  INNER JOIN pools AS p ON p.pool_address = lower(l.pool_key)
  LEFT JOIN token_assets AS t1 ON t1.addr = lower(p.token1)
  WHERE l.venue = 'uniswapv3'
),
v3_fp AS (
  SELECT v.pool_key AS pool_key, v.block_height AS block_height, v.event_index AS event_index, v.leg_index AS leg_index, fp.fp AS fp
  FROM v3_sides AS v
  ASOF LEFT JOIN ${V3_FEE_PROTOCOL_SIDES_SQL} AS fp ON fp.pool = lower(v.pool_key) AND fp.side = v.side AND fp.at_key <= v.at_key
),
rows AS (
  SELECT multiIf(l.venue = 'omnipool', 'lp_fee_omnipool', l.venue = 'stableswap', 'lp_fee_stableswap', l.venue = 'xyk', 'lp_fee_xyk', 'lp_fee_uniswap_v3') AS stream,
         multiIf(l.venue = 'omnipool', concat('omnipool:', toString(if(l.leg_asset = 1, 0, l.leg_asset))),
                 l.venue = 'stableswap', concat('stableswap:', l.pool_key),
                 l.venue = 'xyk', concat('xyk:', toString(x.lp)),
                 concat('v3:', lower(l.pool_key))) AS pot,
         l.block_height AS block_height, l.block_time AS block_time, l.event_index AS event_index, toUInt16(l.leg_index) AS leg_index,
         '' AS earner, toUInt32(l.leg_asset) AS row_asset,
         if(l.venue = 'uniswapv3' AND f.fp > 0, toUInt256(l.gross - intDiv(l.gross, f.fp)), l.gross) AS units
  FROM legs AS l
  LEFT JOIN xyk AS x ON x.acct = lower(l.pool_key)
  LEFT JOIN v3_fp AS f ON f.pool_key = l.pool_key AND f.block_height = l.block_height AND f.event_index = l.event_index AND f.leg_index = l.leg_index
  WHERE multiIf(l.venue = 'omnipool', l.recipient = '${OMNIPOOL_ACCOUNT}' AND (l.leg_asset != 1 OR l.block_height >= ${HUB_FEE_TO_HDX_SUBPOOL_BLOCK}),
                -- The fold's rule (userRevenueLp.ts buildStableswap): a leg stays in the pool when it names the pool's own account.
                l.venue = 'stableswap', l.recipient = '' OR has({ssPoolAccounts:Array(String)}, concat(l.pool_key, ':', l.recipient)),
                l.venue = 'xyk', x.lp > 0 AND l.recipient = lower(l.pool_key),
                1)
  UNION ALL
  -- The GIGAHDX pot's HDX inflows: what its holders are owed accrues from them.
  SELECT 'gigahdx_yield' AS stream, 'gigahdx' AS pot,
         block_height, min(block_timestamp) AS block_time, event_index, toUInt16(0) AS leg_index,
         '' AS earner, toUInt32(0) AS row_asset, any(toUInt256OrZero(amount)) AS units
  FROM price_data.account_transfer_activity
  WHERE account = '${GIGAHDX_POT}' AND to_account = account AND asset_id = 0
    AND event_name = 'Balances.Transfer' AND ${WINDOW}
  GROUP BY account, block_height, event_index
  UNION ALL
  -- Referrer commissions at the claim (no per-trade event exists; the fold books them there too).
  SELECT 'referral_commissions' AS stream, 'referrals' AS pot, block_height, min(block_timestamp) AS block_time, event_index,
         toUInt16(0) AS leg_index, lower(JSONExtractString(argMax(args_json, ingested_at), 'who')) AS earner, toUInt32(0) AS row_asset,
         toUInt256OrZero(JSONExtractString(argMax(args_json, ingested_at), 'referrerRewards')) AS units
  FROM price_data.referral_claim_activity
  WHERE event_name = 'Referrals.Claimed' AND ${WINDOW}
  GROUP BY block_height, event_index
)
SELECT r.stream AS stream, r.pot AS pot, r.block_height AS block_height, toString(r.block_time) AS block_timestamp,
       r.event_index AS event_index, r.leg_index AS leg_index, r.earner AS earner, r.row_asset AS asset_id,
       -- The fold's price rule (userRevenueFold.ts HourPricer.closeAt): an asset with a fill series
       -- (PRICE_SERIES_FILL, ETH ← WETH) takes the newer of its own close and the fill's.
       if(pf.close > 0 AND (p.close <= 0 OR pf.price_time > p.price_time), pf.close, p.close) AS px,
       if(px > 0,
          toDecimal256(r.units, 0) * toDecimal256(px, 12) / ${amountUnitSql('r.row_asset')},
          toDecimal256(0, 12)) AS amount_usd
FROM rows AS r
ASOF LEFT JOIN ${priceSourceSql()} AS p
  ON p.asset_id = ${priceAliasSql('r.row_asset')} AND p.price_time <= r.block_time
ASOF LEFT JOIN ${priceSourceSql()} AS pf
  ON pf.asset_id = ${priceSeriesFillSql(priceAliasSql('r.row_asset'))} AND pf.price_time <= r.block_time
WHERE r.units > 0`
}

/**
 * The v3 legs' readiness: the oldest Uniswap v3 Swap in the tail window whose
 * pool's tokens both resolve (so the uniswap_v3_legs derivation writes legs for
 * it — its own join) but whose fee leg is not written yet. Every v3 leg below it
 * is final; null when none is pending.
 */
export function userFlowV3ReadySql(): string {
  return `-- rev:user-flow-v3-ready
WITH ${V3_TOKEN_ASSETS_CTE},
${V3_POOLS_CTE}
SELECT minOrNull(s.block_height) AS pending
FROM (
  SELECT block_height, event_index, any(contract_address) AS pool
  FROM price_data.uniswap_v3_events
  WHERE kind = 'pool' AND event_name = 'Swap' AND ${WINDOW}
  GROUP BY block_height, event_index
) AS s
INNER JOIN pools AS p ON p.pool_address = s.pool
LEFT JOIN token_assets AS t0 ON t0.addr = lower(p.token0)
LEFT JOIN token_assets AS t1 ON t1.addr = lower(p.token1)
WHERE ${v3TokenAssetSql('t0.asset_id', 'p.token0')} != 4294967295 AND ${v3TokenAssetSql('t1.asset_id', 'p.token1')} != 4294967295
  AND (s.block_height, s.event_index) NOT IN (
    SELECT block_height, event_index FROM price_data.pool_swap_legs
    WHERE venue = 'uniswapv3' AND leg_kind = 'fee' AND ${WINDOW})`
}

/**
 * Each event pot's user share: user and all-class USD of the stream's facts in
 * the newest folded hour (at or before {h}) that booked the pot with a positive
 * total, within the lookback — the last known share, carried forward.
 */
export function userFlowSharesSql(table: string): string {
  return `-- rev:user-flow-shares
SELECT stream, pot, toUnixTimestamp(hour) AS h, toString(u) AS user_usd, toString(t) AS total_usd FROM (
  SELECT stream, pot, hour, sumIf(amount_usd, holder_class = 'user') AS u, sum(amount_usd) AS t
  FROM ${table}
  WHERE hour > toDateTime({h:UInt32}) - INTERVAL ${USER_FLOW_SHARE_LOOKBACK_HOURS} HOUR AND hour <= toDateTime({h:UInt32})
    AND stream IN {streams:Array(String)} AND NOT startsWith(via, 'unmeasured:')
  GROUP BY stream, pot, hour
  HAVING t > 0)
ORDER BY stream, pot, h DESC
LIMIT 1 BY stream, pot`
}

/**
 * The drips: the mean streams' user USD summed over the trailing
 * USER_FLOW_MEAN_HOURS ('mean', per stream and asset — a token's accrual keyed by
 * the token its pot names, never the asset it is valued in), and the rate
 * streams' user USD per pot in the newest folded hour (within the lookback) that
 * booked any measured money-market fact ('live', per stream, pot and asset). The
 * fold books every accruing money-market pot every hour, so only that hour's pots
 * drip: a pot it did not book — an incentive programme that ended, a reserve its
 * holders left — stops at once rather than carrying its last rate forward.
 */
export function userFlowDripsSql(table: string): string {
  return `-- rev:user-flow
SELECT 'mean' AS mode, stream, if(startsWith(stream, 'token_accrual') AND startsWith(pot, 'token:'), toUInt32OrZero(substring(pot, 7)), asset_id) AS asset_id,
       toString(sum(amount_usd)) AS usd
FROM ${table}
WHERE hour > toDateTime({h:UInt32}) - INTERVAL ${USER_FLOW_MEAN_HOURS} HOUR AND hour <= toDateTime({h:UInt32})
  AND stream IN {mean:Array(String)} AND holder_class = 'user' AND NOT startsWith(via, 'unmeasured:')
GROUP BY stream, asset_id
UNION ALL
SELECT 'live' AS mode, stream, asset_id, toString(sumIf(amount_usd, holder_class = 'user')) AS usd
FROM ${table}
WHERE hour = (
    SELECT max(hour) FROM ${table}
    WHERE hour > toDateTime({h:UInt32}) - INTERVAL ${USER_FLOW_RATE_LOOKBACK_HOURS} HOUR AND hour <= toDateTime({h:UInt32})
      AND startsWith(stream, 'mm_') AND NOT startsWith(via, 'unmeasured:'))
  AND stream IN {rate:Array(String)} AND NOT startsWith(via, 'unmeasured:')
GROUP BY stream, pot, asset_id`
}
