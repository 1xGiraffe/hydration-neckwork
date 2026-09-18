-- Where a PolkadotXcm call says it is going.
--
-- Hydration sets `XcmEventEmitter = ()`, so a send the xcm EXECUTOR dispatches leaves
-- only `XcmpQueue.XcmpMessageSent` — a bare hash — and its activity row has to read
-- the destination from the extrinsic's own call args (xcmDestinationFromCallArgs in
-- api/src/services/explorerService.ts). Reading those from raw_extrinsics costs ~2 GiB
-- per feed page to return ~1 MiB: `call_args_json` is the widest column in the table
-- (478 GiB uncompressed over 35M rows), a feed's claimed blocks are scattered across
-- the whole height range, and every claimed block drags in a whole 8192-row granule
-- of it. A tighter predicate cannot help — a `(block, extrinsic)` tuple filter never
-- prunes a granule the block list already claimed (measured 1.80 → 1.81 GiB).
--
-- This is the narrow source that read wants: one row per top-level PolkadotXcm
-- extrinsic (47k of the 35M), block-keyed like raw_extrinsics, holding ONLY the
-- top-level args the decoder reads — `dest`, `beneficiary`, `customXcmOnDest` — as raw
-- JSON slices. Decoding stays in TypeScript, in the one function every surface calls:
-- the beneficiary is the DepositAsset of the DEEPEST nested hop, skipping
-- SetAppendix/SetErrorHandler, a recursive walk SQL could only restate as a second
-- implementation that drifts. The api rebuilds `{dest, beneficiary, customXcmOnDest}`
-- from the slices (xcmCallDestinationArgs) and decodes exactly as it would the full
-- args; api/tests/xcmExecutedDestination.test.ts pins that the two agree and that the
-- slice set is the key set the decoder reads.
--
-- Only calls naming a `dest` are kept: without one the decoder answers null for every
-- caller, so `PolkadotXcm.execute` (an inline program, no dest) and `claim_assets`
-- contribute nothing and are not stored. A PolkadotXcm call wrapped in
-- `Utility.batch_all` or `Proxy.proxy` is not a top-level PolkadotXcm extrinsic and is
-- absent here as it is from raw_extrinsics' call_name.
--
-- Replacement key is (block_height, extrinsic_index) — the extrinsic's own identity
-- and raw_extrinsics' sort key — so a replayed range replaces rather than doubles.
CREATE TABLE IF NOT EXISTS price_data.xcm_call_destinations (
  `block_height` UInt32,
  `extrinsic_index` UInt32,
  `block_timestamp` DateTime,
  `call_name` LowCardinality(String),
  `dest_json` String,
  `beneficiary_json` String,
  `custom_xcm_on_dest_json` String,
  `ingested_at` DateTime
) ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, extrinsic_index)
SETTINGS index_granularity = 1024;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.xcm_call_destinations_mv
TO price_data.xcm_call_destinations AS
SELECT block_height, extrinsic_index, block_timestamp, call_name,
       JSONExtractRaw(call_args_json, 'dest') AS dest_json,
       JSONExtractRaw(call_args_json, 'beneficiary') AS beneficiary_json,
       JSONExtractRaw(call_args_json, 'customXcmOnDest') AS custom_xcm_on_dest_json,
       ingested_at
FROM price_data.raw_extrinsics
WHERE startsWith(call_name, 'PolkadotXcm.') AND JSONHas(call_args_json, 'dest');
