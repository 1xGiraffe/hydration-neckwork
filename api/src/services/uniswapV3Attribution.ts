import { attributablePayerSql, TREASURY_H160 } from './revenueStreams.ts'

// Per-account attribution for the `uniswap_v3_fee` stream.
//
// Every other eventful stream names its payer on the revenue row itself, because
// the fee and the payment are the same event. A v3 protocol fee is not: the pool
// keeps `setFeeProtocol`'s share of every swap fee INSIDE itself (`protocolFees()`
// grows, nothing moves), and a single `CollectProtocol` later hands the whole
// accumulated lump over. A Gamma vault's fee share behaves the same way — its
// positions earn across many swaps and one `Transfer` pays the Treasury.
//
// So the payer of a realization is never the account that triggered it: only the
// factory owner can collect, and attributing the lump to the owner would name the
// protocol as its own customer. The payers are the swappers whose fees accrued it,
// which is what these two queries reconstruct — the same shape `asset_reserve`
// already uses for its inter-mint window (services/borrowAttribution.ts).
//
// The split is exact by construction: `distributeUsd1e12` floors cumulatively and
// puts every remainder — including the whole amount of a realization whose window
// holds no indexed swap — on account '', so the per-account sum always equals the
// stream's own revenue_events total. A window that cannot be attributed degrades
// to unattributed revenue, never to a wrong payer.

/**
 * Every `uniswap_v3_fee` realization in `{partition}`, with the pool it belongs to
 * and the accrual window it closes.
 *
 * `prev_ts` is the previous realization on the same pool and asset, which is
 * routinely in an EARLIER month — so the walk covers every realization and only
 * then narrows to the partition being rebuilt. A first-ever realization opens its
 * window at the epoch, which is correct: the pool cannot have accrued anything
 * before its own first swap.
 */
export function uniswapV3RealizationsSql(): string {
  return `-- rev:v3-realizations
WITH pools AS (
  SELECT pool_address, token0, token1, fee FROM price_data.uniswap_v3_pools FINAL
),
-- A vault names no pool; it is the pool with the same pair and fee tier, which is
-- exactly how the factory keyed both of them.
vault_pools AS (
  SELECT v.vault_address AS vault, p.pool_address AS pool
  FROM price_data.uniswap_v3_vaults AS v FINAL
  INNER JOIN pools AS p ON p.token0 = v.token0 AND p.token1 = v.token1 AND p.fee = v.fee
),
-- The two kinds accrue on different clocks and must never share a window: a vault
-- pays out on each ZeroBurn (roughly hourly), while the pool's own protocol fee
-- accrues from the moment setFeeProtocol turned it on until someone collects. Each
-- vault is its own clock too, since two vaults on one pool pay independently.
sources AS (
  SELECT block_height, event_index, lower(contract_address) AS pool, 'protocol' AS kind
  FROM price_data.uniswap_v3_events FINAL
  WHERE kind = 'pool' AND event_name = 'CollectProtocol'
  UNION ALL
  SELECT l.block_height AS block_height, l.event_index AS event_index, vp.pool AS pool,
         concat('vault:', vp.vault) AS kind
  FROM price_data.raw_evm_logs AS l
  INNER JOIN vault_pools AS vp
    ON vp.vault = lower(JSONExtractString(l.decoded_args_json, 'from'))
  WHERE l.event_name = 'Transfer'
    AND lower(JSONExtractString(l.decoded_args_json, 'to')) = '${TREASURY_H160}'
),
-- When each pool's protocol fee began. Swaps before it paid no protocol fee at
-- all, so the first collect's window opens here rather than at the epoch —
-- otherwise it would be split over payers who never paid into this stream.
protocol_start AS (
  SELECT lower(contract_address) AS pool, min(block_timestamp) AS started
  FROM price_data.uniswap_v3_events FINAL
  WHERE kind = 'pool' AND event_name = 'SetFeeProtocol' AND (aux0 > 0 OR aux1 > 0)
  GROUP BY pool
),
realizations AS (
  SELECT r.block_height AS block_height, r.event_index AS event_index, r.leg_index AS leg_index,
         s.pool AS pool, s.kind AS kind, r.asset_id AS asset_id, r.block_timestamp AS ts,
         toString(r.amount_usd) AS usd, toYYYYMM(r.block_timestamp) AS p
  FROM price_data.revenue_events AS r
  INNER JOIN sources AS s ON s.block_height = r.block_height AND s.event_index = r.event_index
  WHERE r.stream = 'uniswap_v3_fee'
),
-- Per DISTINCT timestamp, not per row: a Gamma rebalance collects both tokens and
-- pays the Treasury twice in the same block, and walking row by row would hand the
-- second payment a window of (prev, this] with prev == this — empty, so its whole
-- amount would degrade to unattributed. Measured before this: 23 of 94
-- realizations, carrying 90% of the stream. Payments that share a timestamp
-- accrued over the same period, so they share its window and each splits its own
-- amount over the same payers.
ts_windows AS (
  SELECT pool, asset_id, kind, ts,
         lagInFrame(ts, 1, toDateTime(0)) OVER (
           PARTITION BY pool, asset_id, kind ORDER BY ts
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS prev_ts
  FROM (SELECT DISTINCT pool, asset_id, kind, ts FROM realizations)
)
SELECT r.block_height AS block_height, r.event_index AS event_index, r.leg_index AS leg_index,
       r.pool AS pool, r.asset_id AS asset_id, r.usd AS usd,
       toString(r.ts) AS ts,
       toString(if(r.kind = 'protocol', greatest(w.prev_ts, ifNull(ps.started, toDateTime(0))), w.prev_ts)) AS prev_ts
FROM realizations AS r
INNER JOIN ts_windows AS w
  ON w.pool = r.pool AND w.asset_id = r.asset_id AND w.kind = r.kind AND w.ts = r.ts
LEFT JOIN protocol_start AS ps ON ps.pool = r.pool
WHERE r.p = {partition:UInt32}
ORDER BY r.block_height, r.event_index, r.leg_index`
}

/**
 * What each account paid in gross swap fees on one pool, in one asset, over one
 * accrual window — the weights the realization is split by.
 *
 * The window is half-open on the left (`>` prev, `<=` this) so two consecutive
 * realizations can never both claim the same swap.
 *
 * `pool_swap_legs` is a ReplacingMergeTree whose months the `uniswap_v3_legs` job
 * republishes whole, so the same leg is present several times over: measured live,
 * 1,440 rows for 614 real fee legs. Deduplicating to the newest row per leg
 * identity BEFORE summing is what keeps a republished swapper from being weighted
 * 2.3x — a `FINAL` here would be correct too, but the explicit fold reads as the
 * deliberate choice it is and stays bounded to the pool's own key prefix.
 */
export function uniswapV3FeePayersSql(): string {
  return `-- rev:v3-fee-payers
-- A pallet account is not a payer: a swap the Router or another pallet filled for
-- itself pays its fee with protocol money, and crediting it would list the
-- protocol among its own customers. The rule is the stream module's own
-- (attributablePayerSql), which covers the native \`modl…\` form as well as the
-- ETH-mapped one plus the placeholder swapper and the HSM executor — a local test
-- for just the mapped form would still have named a native pallet swapper. Such a
-- leg keeps its WEIGHT, because the fee was really paid; only the payer blanks.
SELECT ${attributablePayerSql('payer')} AS account,
       toString(sum(amount)) AS weight
FROM (
  SELECT block_height, event_index, leg_index,
         argMax(swapper, ingested_at) AS payer,
         argMax(toUInt256OrZero(amount), ingested_at) AS amount
  FROM price_data.pool_swap_legs
  WHERE venue = 'uniswapv3'
    AND pool_key = {pool:String}
    AND leg_kind = 'fee'
    AND asset_id = {asset:UInt32}
    AND block_timestamp > {start:DateTime}
    AND block_timestamp <= {end:DateTime}
  GROUP BY block_height, event_index, leg_index
)
WHERE amount > 0
GROUP BY account`
}
