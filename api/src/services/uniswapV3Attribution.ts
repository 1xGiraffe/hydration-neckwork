import { TREASURY_H160 } from './revenueStreams.ts'

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
sources AS (
  SELECT block_height, event_index, lower(contract_address) AS pool
  FROM price_data.uniswap_v3_events FINAL
  WHERE kind = 'pool' AND event_name = 'CollectProtocol'
  UNION ALL
  SELECT l.block_height AS block_height, l.event_index AS event_index, vp.pool AS pool
  FROM price_data.raw_evm_logs AS l
  INNER JOIN vault_pools AS vp
    ON vp.vault = lower(JSONExtractString(l.decoded_args_json, 'from'))
  WHERE l.event_name = 'Transfer'
    AND lower(JSONExtractString(l.decoded_args_json, 'to')) = '${TREASURY_H160}'
),
realizations AS (
  SELECT r.block_height AS block_height, r.event_index AS event_index, r.leg_index AS leg_index,
         s.pool AS pool, r.asset_id AS asset_id, r.block_timestamp AS ts,
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
  SELECT pool, asset_id, ts,
         lagInFrame(ts, 1, toDateTime(0)) OVER (
           PARTITION BY pool, asset_id ORDER BY ts
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS prev_ts
  FROM (SELECT DISTINCT pool, asset_id, ts FROM realizations)
)
SELECT r.block_height AS block_height, r.event_index AS event_index, r.leg_index AS leg_index,
       r.pool AS pool, r.asset_id AS asset_id, r.usd AS usd,
       toString(r.ts) AS ts, toString(w.prev_ts) AS prev_ts
FROM realizations AS r
INNER JOIN ts_windows AS w ON w.pool = r.pool AND w.asset_id = r.asset_id AND w.ts = r.ts
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
-- A pallet account is not a payer. A direct EVM swap has no Broadcast naming its
-- trader and its Swap log routinely names the SwapRouter's own account as the
-- recipient, which arrives here in the ETH-prefixed form 0x45544800 + the H160 —
-- so a pallet shows as 'modl' (6d6f646c) at the start of that payload, byte 11 of
-- the string. Such a leg keeps its weight, because the fee was really paid, and
-- carries no payer, so its share lands on '' rather than on the router.
SELECT if(substring(payer, 11, 8) = '6d6f646c', '', payer) AS account,
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
