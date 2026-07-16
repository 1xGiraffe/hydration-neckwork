-- Weekly account/asset balance states for the accounts-directory sparkline.
--
-- raw_balance_observations is intentionally retained as the authoritative
-- source. This aggregate only removes the need for each API request to scan and
-- bucket hundreds of millions of raw observations. The ordering tuple makes a
-- replaced observation deterministic, while argMax/uniq/max states make an
-- interrupted partition backfill safe to repeat and safe to overlap with the
-- materialized view.

CREATE TABLE IF NOT EXISTS price_data.account_balance_weekly
(
    account_id String,
    asset_id String,
    week_start Date,
    balance_state AggregateFunction(argMax, String, Tuple(UInt32, UInt32, String, DateTime)),
    activity_state AggregateFunction(uniq, Tuple(UInt32, Nullable(UInt32))),
    last_block_state AggregateFunction(max, UInt32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYear(week_start)
ORDER BY (account_id, asset_id, week_start)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.account_balance_weekly_mv
TO price_data.account_balance_weekly
AS
SELECT
    account_id,
    asset_id,
    toMonday(block_timestamp) AS week_start,
    argMaxState(
        coalesce(total, '0'),
        tuple(
            block_height,
            ifNull(source_event_index, toUInt32(4294967295)),
            observation_id,
            ingested_at
        )
    ) AS balance_state,
    uniqState(tuple(block_height, source_event_index)) AS activity_state,
    maxState(block_height) AS last_block_state
FROM price_data.raw_balance_observations
WHERE account_id != '' AND asset_id != ''
GROUP BY account_id, asset_id, week_start;

-- A marker is written only after a raw monthly partition has been aggregated
-- successfully. The API can therefore resume a long historical backfill without
-- truncating either raw or aggregate data.
CREATE TABLE IF NOT EXISTS price_data.account_balance_weekly_backfill
(
    partition String,
    completed_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY partition;
