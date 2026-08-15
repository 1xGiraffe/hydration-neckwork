// Per-account borrow-interest attribution for account_revenue — the borrow
// streams' account-grain truth (spec: docs/superpowers/specs/
// 2026-08-14-revenue-dashboard-design.md).
//
// The core is Aave's own bookkeeping identity. A holder's debt balance is
// scaled × index / RAY, and every balance-changing event's principal flow is
// scaled_delta × index_at_event (the exact formulas the atoken_scaled_deltas
// MV applies — see db/atokenDeltas.ts). Interest accrued over a window
// [start, end) is therefore
//
//   interest = (scaled_end × idx1 − scaled_start × idx0) / RAY − Σ principal
//
// which needs no per-hour walk, and summed over holders telescopes to the
// reserve-level series (Σ scaled × Δindex) — the algebraic identity the
// conservation validation pins. USD is then split pro-rata over these planck
// weights against the stream's OWN revenue_events total (hollar_borrow's
// hourly rows; each MintedToTreasury's valued amount), cumulative-floor exact
// with the remainder on account = '' — so per-account USD sums equal the
// stream totals to the last 1e-12 USD by construction, whatever the weights.
//
// Known bounded imperfection, documented rather than hidden: the asset-10
// (USDT) debt token has a genuine pre-anchor log gap (~9.9% of its pre-B0
// total; every other debt token reconstructs to ≤0.01%), so pre-B0 windows
// skew that reserve's SHARES slightly. Conservation is unaffected.

/** Aave's RAY as the Int256 SQL literal (string form — never a float). */
const RAY_INT_SQL = "toInt256(toUInt256('1000000000000000000000000000'))"

/**
 * Per-account interest accrued on a reserve's variable debt over
 * [{start:DateTime}, {end:DateTime}), as (account, interest) rows — account in
 * the ETH-mapped substrate form every attribution surface uses, interest in
 * reserve planck, clamped at zero (integer-division dust can round a hair
 * negative). {reserve:String} is the lowercased reserve address.
 *
 * Sources, all replay-safe:
 *  * openings — the B0 anchor (only when the window starts after the anchor;
 *    earlier windows reconstruct from deltas alone, the measured-fidelity
 *    recipe) plus cumulative pre-window deltas from
 *    atoken_scaled_deltas_by_contract FINAL (ReplacingMergeTree — FINAL or the
 *    replayed range double-counts);
 *  * window deltas — same table, same FINAL;
 *  * principal flows — the raw Mint/Burn args (value/balanceIncrease exactly
 *    as db/atokenDeltas.ts consumes them: Mint.value includes balanceIncrease,
 *    Burn.value excludes it), deduplicated on the event identity;
 *  * indices — money_market_reserve_indices at the window bounds, argMax on
 *    (block, event, ingested_at), the reserveIndicesNow convention.
 */
export function accountBorrowInterestSql(): string {
  return `-- rev:borrow-weights
WITH vdebts AS (
  SELECT DISTINCT lower(vdebt) AS contract, lower(pool_proxy) AS pool
  FROM price_data.atoken_reserve_map FINAL
  WHERE vdebt != '' AND lower(asset_address) = {reserve:String}
),
b0 AS (SELECT max(anchor_block) AS b FROM price_data.atoken_scaled_anchor),
b0ts AS (
  SELECT max(block_timestamp) AS ts FROM price_data.blocks
  WHERE block_height <= (SELECT b FROM b0)
),
anchor_applies AS (SELECT (SELECT ts FROM b0ts) < {start:DateTime} AS ok),
idx AS (
  SELECT m.contract AS contract,
         argMaxIf(i.variable_borrow_index, (i.block_height, i.event_index, i.ingested_at), i.block_timestamp <= {start:DateTime}) AS idx0,
         argMax(i.variable_borrow_index, (i.block_height, i.event_index, i.ingested_at)) AS idx1
  FROM price_data.money_market_reserve_indices i
  INNER JOIN vdebts m ON m.pool = i.pool_address
  WHERE i.reserve_address = {reserve:String} AND i.block_timestamp <= {end:DateTime}
  GROUP BY m.contract
),
opening AS (
  SELECT contract, holder, sum(scaled) AS scaled
  FROM (
    SELECT contract_address AS contract, holder, toInt256(sum(scaled_delta)) AS scaled
    FROM price_data.atoken_scaled_deltas_by_contract FINAL
    WHERE contract_address IN (SELECT contract FROM vdebts)
      AND block_timestamp < {start:DateTime}
      AND (NOT (SELECT ok FROM anchor_applies) OR block_height > (SELECT b FROM b0))
    GROUP BY contract, holder
    UNION ALL
    SELECT lower(contract_address) AS contract, lower(holder) AS holder, toInt256(scaled_balance) AS scaled
    FROM price_data.atoken_scaled_anchor FINAL
    WHERE lower(contract_address) IN (SELECT contract FROM vdebts) AND holder != ''
      AND (SELECT ok FROM anchor_applies)
  )
  GROUP BY contract, holder
),
window_deltas AS (
  SELECT contract_address AS contract, holder, toInt256(sum(scaled_delta)) AS scaled
  FROM price_data.atoken_scaled_deltas_by_contract FINAL
  WHERE contract_address IN (SELECT contract FROM vdebts)
    AND block_timestamp >= {start:DateTime} AND block_timestamp < {end:DateTime}
  GROUP BY contract, holder
),
flows AS (
  SELECT contract,
         lower(JSONExtractString(args, if(en = 'Mint', 'onBehalfOf', 'from'))) AS holder,
         sum(if(en = 'Mint',
                toInt256(toUInt256OrZero(JSONExtractString(args, 'value'))) - toInt256(toUInt256OrZero(JSONExtractString(args, 'balanceIncrease'))),
                -(toInt256(toUInt256OrZero(JSONExtractString(args, 'value'))) + toInt256(toUInt256OrZero(JSONExtractString(args, 'balanceIncrease')))))) AS principal
  FROM (
    SELECT lower(contract_address) AS contract, block_height, event_index,
           any(event_name) AS en, argMax(decoded_args_json, ingested_at) AS args
    FROM price_data.raw_evm_logs
    WHERE event_name IN ('Mint', 'Burn')
      AND lower(contract_address) IN (SELECT contract FROM vdebts)
      AND block_timestamp >= {start:DateTime} AND block_timestamp < {end:DateTime}
    GROUP BY contract, block_height, event_index
  )
  GROUP BY contract, holder
),
per_holder AS (
  SELECT contract, holder, sum(s0) AS s0, sum(dw) AS dw, sum(pr) AS pr
  FROM (
    SELECT contract, holder, scaled AS s0, toInt256(0) AS dw, toInt256(0) AS pr FROM opening
    UNION ALL
    SELECT contract, holder, toInt256(0) AS s0, scaled AS dw, toInt256(0) AS pr FROM window_deltas
    UNION ALL
    SELECT contract, holder, toInt256(0) AS s0, toInt256(0) AS dw, principal AS pr FROM flows
  )
  GROUP BY contract, holder
)
-- Protocol-internal holders (pallet accounts acting through their truncated
-- H160, and the runtime executor) blank to the unattributed bucket, matching
-- attributablePayerSql in revenueStreams.ts: their weight still participates,
-- so conservation holds while no protocol actor lists among its own payers.
SELECT if(startsWith(holder, '0x6d6f646c') OR holder = '0x000000000000000000000000000000000000090a',
          '', concat('0x45544800', substring(holder, 3), '0000000000000000')) AS account,
       toString(sum(greatest(
         intDiv((p.s0 + p.dw) * toInt256(i.idx1) - p.s0 * toInt256(i.idx0), ${RAY_INT_SQL}) - p.pr,
         toInt256(0)))) AS interest
FROM per_holder p
INNER JOIN idx i ON i.contract = p.contract
GROUP BY holder
HAVING sum(greatest(
         intDiv((p.s0 + p.dw) * toInt256(i.idx1) - p.s0 * toInt256(i.idx0), ${RAY_INT_SQL}) - p.pr,
         toInt256(0))) > 0
ORDER BY account`
}

/**
 * Every MintedToTreasury at or below {end:DateTime}, deduplicated, with the
 * previous mint's timestamp on the same reserve (epoch for a reserve's first
 * mint, so its attribution window reaches back to the reserve's beginning).
 * The caller keeps the mints of the month it is rebuilding; the lookback rows
 * exist so that month's first mint knows its window start.
 */
export function assetReserveMintsSql(): string {
  return `-- rev:reserve-mints
SELECT reserve, block_height, event_index, toString(mint_ts) AS mint_ts, toString(prev_ts) AS prev_ts
FROM (
  SELECT reserve, block_height, event_index, mint_ts,
         lagInFrame(mint_ts, 1, toDateTime(0)) OVER (PARTITION BY reserve ORDER BY block_height, event_index
                                                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS prev_ts
  FROM (
    SELECT lower(any(ifNull(reserve_address, ''))) AS reserve, block_height, event_index,
           min(block_timestamp) AS mint_ts
    FROM price_data.raw_money_market_reserves
    WHERE event_name = 'MintedToTreasury' AND block_timestamp <= {end:DateTime}
    GROUP BY block_height, event_index
  )
)
ORDER BY block_height, event_index`
}

/**
 * Splits `total` (1e-12 USD) over `weights` exactly: cumulative floors, so the
 * shares sum to `total` to the last unit, with any weightless remainder (or
 * the whole total, when no weights exist) attributed to '' — never scaled
 * onto known payers and never dropped.
 */
export function distributeUsd1e12(
  total: bigint,
  weights: ReadonlyArray<{ account: string; weight: bigint }>,
): Map<string, bigint> {
  const out = new Map<string, bigint>()
  const add = (account: string, value: bigint): void => {
    if (value <= 0n) return
    out.set(account, (out.get(account) ?? 0n) + value)
  }
  if (total <= 0n) return out
  const positive = weights.filter(w => w.weight > 0n)
  const weightSum = positive.reduce((a, w) => a + w.weight, 0n)
  if (weightSum <= 0n) {
    add('', total)
    return out
  }
  let cumulative = 0n
  let assigned = 0n
  for (const { account, weight } of positive) {
    const before = (total * cumulative) / weightSum
    cumulative += weight
    const after = (total * cumulative) / weightSum
    add(account, after - before)
    assigned += after - before
  }
  // Cumulative floors always land exactly on total; anything else is a bug.
  if (assigned !== total) add('', total - assigned)
  return out
}
