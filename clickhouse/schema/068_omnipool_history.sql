-- Historical Omnipool principal read models for the account value-history chart
-- (LP value-history, Phase 1). All replay-safe: MV-backed tables re-emit stable keys
-- on re-ingest (ReplacingMergeTree replaces by ORDER BY key), and the interval table is
-- rewritten by a checkpointed builder keyed on stable valid_from tuples. These stay OFF
-- request paths until price_data.lp_history_model_coverage marks them complete.
--
-- Ownership model (verified against raw_events): an Omnipool position is owned "bare"
-- while its collection-1337 NFT is held by the account, and "farmed" while its
-- collection-2584 deposit NFT is held (the 1337 NFT then sits with the LM pallet). The
-- economic owner is conserved across the bare<->farmed handoff; a position is valued once.

-- 1) Per-position state transitions (created|updated|destroyed) with full state.
--    "State at block B" = the row with the greatest (block_height, event_index) <= B for a
--    bounded set of position_ids. spec_version is resolved via runtime_upgrades(005) at
--    validation time (block_height is sufficient), so it is not stored here.
CREATE TABLE IF NOT EXISTS price_data.omnipool_position_state_events
(
    position_id String,
    block_height UInt32,
    extrinsic_index Nullable(UInt32),
    event_index UInt32,
    event_kind Enum8('created' = 1, 'updated' = 2, 'destroyed' = 3),
    asset_id Int32,
    amount_raw String,
    shares_raw String,
    price_raw String,          -- FixedU128 numerator; denominator = 1e18 (OMNI_FIXED)
    active UInt8,              -- 0 for destroyed, else 1
    block_timestamp DateTime,
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
-- No time partitioning: these projections are read account/position/asset-first, and
-- monthly parts would each be smaller than one index granule, defeating primary-key
-- pruning. A single partition keeps the account-first ORDER BY selective.
PARTITION BY tuple()
ORDER BY (position_id, block_height, event_index)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.omnipool_position_state_events_mv
TO price_data.omnipool_position_state_events AS
SELECT
    JSONExtractString(args_json, 'positionId') AS position_id,
    block_height,
    extrinsic_index,
    event_index,
    CAST(multiIf(event_name = 'Omnipool.PositionCreated', 'created',
                 event_name = 'Omnipool.PositionUpdated', 'updated',
                 'destroyed') AS Enum8('created' = 1, 'updated' = 2, 'destroyed' = 3)) AS event_kind,
    if(event_name = 'Omnipool.PositionDestroyed', toInt32(0), toInt32(JSONExtractInt(args_json, 'asset'))) AS asset_id,
    if(event_name = 'Omnipool.PositionDestroyed', '', JSONExtractString(args_json, 'amount')) AS amount_raw,
    if(event_name = 'Omnipool.PositionDestroyed', '', JSONExtractString(args_json, 'shares')) AS shares_raw,
    if(event_name = 'Omnipool.PositionDestroyed', '', JSONExtractString(args_json, 'price')) AS price_raw,
    if(event_name = 'Omnipool.PositionDestroyed', toUInt8(0), toUInt8(1)) AS active,
    block_timestamp,
    ingested_at
FROM price_data.raw_events
WHERE event_name IN ('Omnipool.PositionCreated', 'Omnipool.PositionUpdated', 'Omnipool.PositionDestroyed');

CREATE TABLE IF NOT EXISTS price_data.omnipool_position_state_events_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at) ORDER BY partition;

-- 2) Compact Omnipool pool state projected out of the snapshot JSON so request paths never
--    parse payload_json. raw_block_snapshots holds ~1 row PER BLOCK, so the projection is
--    SAMPLED to one snapshot per OMNI_POOL_STATE_SAMPLE_BLOCKS (~hourly) — the chart prices at
--    daily-close granularity, so sub-hourly reserve precision is irrelevant, and sampling
--    keeps the table + per-request scan compact (asset-first ORDER BY bounds "state at/before
--    B for the few assets an account touches"). The sample stride is deterministic so the live
--    MV and the historical backfill converge on identical (asset_id, block_height) keys.
CREATE TABLE IF NOT EXISTS price_data.omnipool_pool_state_history
(
    asset_id Int32,
    block_height UInt32,
    block_timestamp DateTime,
    reserve_raw String,
    hub_reserve_raw String,
    shares_raw String,
    protocol_shares_raw String,
    spec_version UInt32,
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY tuple()
ORDER BY (asset_id, block_height)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.omnipool_pool_state_history_mv
TO price_data.omnipool_pool_state_history AS
SELECT
    toInt32(JSONExtractInt(a, 'asset_id')) AS asset_id,
    block_height,
    block_timestamp,
    JSONExtractString(a, 'reserve') AS reserve_raw,
    JSONExtractString(a, 'hub_reserve') AS hub_reserve_raw,
    JSONExtractString(a, 'shares') AS shares_raw,
    JSONExtractString(a, 'protocol_shares') AS protocol_shares_raw,
    spec_version,
    ingested_at
FROM price_data.raw_block_snapshots
ARRAY JOIN JSONExtractArrayRaw(JSONExtractRaw(payload_json, 'omnipool'), 'assets') AS a
WHERE block_height % 600 = 0;   -- OMNI_POOL_STATE_SAMPLE_BLOCKS ≈ hourly

CREATE TABLE IF NOT EXISTS price_data.omnipool_pool_state_history_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at) ORDER BY partition;

-- 3) Account-first economic ownership intervals (written by the checkpointed TS builder
--    api/src/scripts/build-omnipool-owner-intervals.ts). ReplacingMergeTree(run_id) so a
--    re-run replaces rows with identical stable valid_from keys.
CREATE TABLE IF NOT EXISTS price_data.omnipool_position_owner_intervals
(
    account_id String,
    position_id String,
    ownership_kind Enum8('bare' = 1, 'farmed' = 2),
    deposit_id String,                 -- '' when bare
    valid_from_block UInt32,
    valid_from_extrinsic Int64,        -- -1 sentinel = null extrinsic
    valid_from_event UInt32,
    valid_from_ts DateTime,
    valid_to_block UInt32,             -- 0 sentinel = open
    valid_to_extrinsic Int64,
    valid_to_event UInt32,
    source_event_kind LowCardinality(String),
    run_id UInt64,
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(run_id)
PARTITION BY tuple()
ORDER BY (account_id, position_id, valid_from_block, valid_from_event)
SETTINGS index_granularity = 8192;

-- 4) Coverage / checkpoint metadata for every derived LP-history model. The API uses a
--    model only when it is 'complete' for the requested block range; partial coverage is
--    surfaced explicitly, never rendered as zero ownership.
CREATE TABLE IF NOT EXISTS price_data.lp_history_model_coverage
(
    model LowCardinality(String),
    range_start UInt32,
    range_end UInt32,
    source_high_watermark UInt32,
    status Enum8('building' = 1, 'complete' = 2, 'failed' = 3),
    row_count UInt64,
    checksum String,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (model, range_start);
