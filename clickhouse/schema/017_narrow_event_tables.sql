-- Narrow, replay-safe copies of rare raw rows that background loops read every cycle.
-- Each is fed by an MV straight from the raw table and keyed on the raw row's own
-- identity (block_height, event_index) under ReplacingMergeTree(ingested_at), so a
-- replayed raw range collapses onto the same rows. An upgrading database gets each
-- table's history from raw through a DATA_UPGRADES entry (api/src/db/schemaBootstrap.ts)
-- whose SELECT/WHERE is the MV's verbatim.

-- Wormhole NTT logs: the core bridge's LogMessagePublished, the transceivers'
-- ReceivedMessage, the managers' TransferSent / TransferRedeemed /
-- InboundTransferQueued and the peer registrations (PeerUpdated, WormholePeerSet) —
-- every topic api/src/services/wormholeNttService.ts reads (TOPIC in wormholeNtt.ts).
-- The backing monitor re-reads this set every refresh; from raw_evm_logs that was a
-- ~1.9 GiB scan per minute for ~3.4k rows. contract_address is stored lowercased.
CREATE TABLE IF NOT EXISTS price_data.wormhole_ntt_logs (`block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `contract_address` String, `topic0` String, `topics` Array(String), `data` String, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (block_height, event_index) SETTINGS index_granularity = 8192;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.wormhole_ntt_logs_mv TO price_data.wormhole_ntt_logs (`block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `contract_address` String, `topic0` String, `topics` Array(String), `data` String, `ingested_at` DateTime) AS SELECT block_height, event_index, extrinsic_index, block_timestamp, lower(raw_evm_logs.contract_address) AS contract_address, ifNull(raw_evm_logs.topic0, '') AS topic0, topics, data, ingested_at FROM price_data.raw_evm_logs WHERE raw_evm_logs.topic0 IN ('0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2', '0xf6fc529540981400dc64edf649eb5e2e0eb5812a27f8c81bac2c1d317e71a5f0', '0x504e6efe18ab9eed10dc6501a417f5b12a2f7f2b1593aed9b89f9bce3cf29a91', '0xe54e51e42099622516fa3b48e9733581c9dbdcb771cafb093f745a0532a35982', '0x7f63c9251d82a933210c2b6d0b0f116252c3c116788120e64e8e8215df6f3162', '0x1456404e7f41f35c3daac941bb50bad417a66275c3040061b4287d787719599d', '0xa559263ee060c7a2560843b3a064ff0376c9753ae3e2449b595a3b615d326466');

-- Referendum preimage hashes: every event naming a proposal or preimage hash —
-- Referenda.Submitted (proposal.hash, '' for an inline proposal), Preimage.Noted
-- (hash), and Democracy's PreimageNoted / PreimageUsed (proposalHash). The
-- referendum-proposals decoder (src/scripts/decode-referendum-proposals.ts) pairs
-- them each cycle; from raw_events that was a ~1 GiB scan for ~1.9k rows.
CREATE TABLE IF NOT EXISTS price_data.referendum_preimage_events (`block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `event_name` LowCardinality(String), `hash` String, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (block_height, event_index) SETTINGS index_granularity = 8192;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.referendum_preimage_events_mv TO price_data.referendum_preimage_events (`block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `event_name` LowCardinality(String), `hash` String, `ingested_at` DateTime) AS SELECT block_height, event_index, extrinsic_index, event_name, lower(multiIf(raw_events.event_name = 'Preimage.Noted', JSONExtractString(args_json, 'hash'), raw_events.event_name = 'Referenda.Submitted', JSONExtractString(args_json, 'proposal', 'hash'), JSONExtractString(args_json, 'proposalHash'))) AS hash, ingested_at FROM price_data.raw_events WHERE raw_events.event_name IN ('Preimage.Noted', 'Referenda.Submitted', 'Democracy.PreimageNoted', 'Democracy.PreimageUsed');

-- HDX balance hours: per (account, chain-time hour) the newest block that observed
-- the account's HDX (asset 0) balance non-zero, and the newest that observed it
-- zero. A holder's EXIT is the first per-block observation of zero after its last
-- non-zero one; since every observation after the last non-zero block is zero, that
-- is the first hour whose last_zero_block passes the account's max last_nonzero_block
-- (hdxChurnSql, api/src/services/hdxService.ts). Blocks, not timestamps: consecutive
-- blocks can share a timestamp. The full-state sweep's restatements
-- (snapshot_bootstrap) are excluded, so the exit never depends on the sweep's
-- cadence; a reconcile repair (snapshot_reconcile) is a real observation and counts.
-- max is idempotent, so a replayed raw range changes nothing.
CREATE TABLE IF NOT EXISTS price_data.hdx_balance_hours (`account_id` String, `interval_start` DateTime, `last_nonzero_block` SimpleAggregateFunction(max, UInt32), `last_zero_block` SimpleAggregateFunction(max, UInt32)) ENGINE = AggregatingMergeTree ORDER BY (account_id, interval_start) SETTINGS index_granularity = 8192;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.hdx_balance_hours_mv TO price_data.hdx_balance_hours (`account_id` String, `interval_start` DateTime, `last_nonzero_block` UInt32, `last_zero_block` UInt32) AS SELECT account_id, toStartOfHour(block_timestamp) AS interval_start, if(toUInt256OrZero(ifNull(raw_balance_observations.total, '')) > 0, block_height, toUInt32(0)) AS last_nonzero_block, if(toUInt256OrZero(ifNull(raw_balance_observations.total, '')) = 0, block_height, toUInt32(0)) AS last_zero_block FROM price_data.raw_balance_observations WHERE raw_balance_observations.asset_id = '0' AND raw_balance_observations.account_id != '' AND raw_balance_observations.source_kind != 'snapshot_bootstrap' AND isNotNull(toUInt256OrNull(raw_balance_observations.total));
