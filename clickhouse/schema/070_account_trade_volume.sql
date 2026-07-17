-- Per-account NET trade volume — one row per user-level swap (routed trades
-- collapsed to their net input/output so intermediate routing hops are not
-- double-counted). Replaces trade_volume_by_account ONLY as the per-account
-- volume source (the accounts list sort + account/tag detail); the older table
-- stays authoritative for per-asset candle/marker volume.
--
-- Populated by a bounded backfill (scripts/backfill-account-trade-volume.ts) and
-- an incremental recompute of recent partitions — NOT a per-row MV, because the
-- netting is a per-trade cross-row aggregation. This declaration is intentionally
-- inert (no unbounded INSERT ... SELECT).
--
-- volume_usd = max(net_in_usd, net_out_usd), valued at the block-time ohlc_1h
-- close. net_in/out kept for the conservation check (net_in ~= net_out).

CREATE TABLE IF NOT EXISTS price_data.account_trade_volume
(
    account String,
    block_height UInt32,
    -- Deterministic per-trade anchor within the block so replays replace rather
    -- than duplicate: the operationStack Router id in the Broadcast era, else the
    -- extrinsic index (or the group's min event index) in the earlier eras.
    trade_key UInt64,
    volume_usd Decimal128(12) DEFAULT 0,
    net_in_usd Decimal128(12) DEFAULT 0,
    net_out_usd Decimal128(12) DEFAULT 0,
    trade_count UInt32 DEFAULT 1,
    computed_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY toYYYYMM(toDateTime(block_height * 12))
ORDER BY (account, block_height, trade_key)
SETTINGS index_granularity = 8192;

-- Per-partition completion markers gate the API read: until every active
-- partition is present here, per-account volume falls back to the legacy sum so
-- the number is never silently partial.
CREATE TABLE IF NOT EXISTS price_data.account_trade_volume_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at) ORDER BY partition;
