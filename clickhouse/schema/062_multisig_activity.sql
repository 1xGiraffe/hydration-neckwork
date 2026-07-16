-- Account-keyed multisig lifecycle events and their sparse decoded calls.
-- Raw ranges may be replayed, so stable source identities and ingested_at
-- versions make both live materialization and resumable backfills idempotent.

CREATE TABLE IF NOT EXISTS price_data.multisig_event_activity
(
    block_height UInt32,
    event_index UInt32,
    extrinsic_index Nullable(UInt32),
    block_timestamp DateTime,
    event_name LowCardinality(String),
    multisig String,
    actor String,
    call_hash String,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (multisig, event_name, block_height, event_index)
SETTINGS index_granularity = 256;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.multisig_event_activity_mv
TO price_data.multisig_event_activity AS
SELECT
    block_height,
    event_index,
    extrinsic_index,
    block_timestamp,
    event_name,
    JSONExtractString(args_json, 'multisig') AS multisig,
    multiIf(
        JSONHas(args_json, 'approving'), JSONExtractString(args_json, 'approving'),
        JSONExtractString(args_json, 'cancelling')
    ) AS actor,
    JSONExtractString(args_json, 'callHash') AS call_hash,
    ingested_at
FROM price_data.raw_events
WHERE event_name IN (
    'Multisig.NewMultisig',
    'Multisig.MultisigApproval',
    'Multisig.MultisigExecuted',
    'Multisig.MultisigCancelled'
);

CREATE TABLE IF NOT EXISTS price_data.multisig_call_activity
(
    block_height UInt32,
    extrinsic_index Nullable(UInt32),
    call_address String,
    block_timestamp DateTime,
    call_name LowCardinality(String),
    args_json String,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, ifNull(extrinsic_index, 4294967295), call_address)
SETTINGS index_granularity = 256;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.multisig_call_activity_mv
TO price_data.multisig_call_activity AS
SELECT
    block_height,
    extrinsic_index,
    call_address,
    block_timestamp,
    call_name,
    args_json,
    ingested_at
FROM price_data.raw_calls
WHERE call_name IN (
    'Multisig.as_multi',
    'Multisig.approve_as_multi',
    'Multisig.as_multi_threshold_1',
    'Multisig.cancel_as_multi'
);

CREATE TABLE IF NOT EXISTS price_data.multisig_activity_backfill
(
    kind LowCardinality(String),
    partition String,
    completed_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY (kind, partition);
