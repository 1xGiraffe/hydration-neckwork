-- Juicer (galacticcouncil/money-market `juicer-vault`): the leveraged PRIME-loop
-- strategy vaults. Every log the explorer reads from the launch deployment's
-- contracts — the jETH CollateralVault, the shared SubLoop, the Harvester, the
-- vault's JuicerMainDebt ledger, the JuicerFeeController and the JuicerDiscount —
-- for exactly the topics api/src/services/juicer.ts decodes (JUICER_TOPIC; the
-- contract set is JUICER_CONTRACTS there, pinned equal to this WHERE by
-- api/tests/juicerSchema.test.ts). The vault's own ERC-20 Transfer logs stay with
-- the shared ERC-20 machinery (erc20_transfer_deltas, erc20_party_transfers), and
-- the yield accounting's per-event `Allocated()` heartbeat and the execution
-- controller's lane bookkeeping are not read, so they are not copied.
--
-- Narrow and replay-safe like 017's tables: keyed on the raw row's own
-- (block_height, event_index) under ReplacingMergeTree(ingested_at), so a replayed
-- raw range collapses onto the same rows. `party` is the account the log names as
-- its user — a deposit's user, a withdrawal request's owner, a claim's receiver, a
-- surplus claim's owner — as a lowercase H160, '' for the strategy's own logs.
-- Topics are 1-indexed: topics[1] is topic0, topics[2] the first indexed argument.
-- An upgrading database gets the history from raw through the DATA_UPGRADES entry
-- (api/src/db/schemaBootstrap.ts) whose SELECT/WHERE is this MV's verbatim.
CREATE TABLE IF NOT EXISTS price_data.juicer_logs (`block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `contract_address` LowCardinality(String), `topic0` LowCardinality(String), `topics` Array(String), `data` String, `party` String, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (block_height, event_index) SETTINGS index_granularity = 1024;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.juicer_logs_mv TO price_data.juicer_logs (`block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `contract_address` String, `topic0` String, `topics` Array(String), `data` String, `party` String, `ingested_at` DateTime) AS SELECT block_height, event_index, extrinsic_index, block_timestamp, lower(raw_evm_logs.contract_address) AS contract_address, ifNull(raw_evm_logs.topic0, '') AS topic0, topics, data, multiIf(ifNull(raw_evm_logs.topic0, '') = '0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca' AND length(topics) >= 2, lower(concat('0x', substring(topics[2], 27, 40))), ifNull(raw_evm_logs.topic0, '') IN ('0x1d3135f7e52d949fd35b86ab673aeb906bdee851ec045f9539dc9a33fbfbe482', '0x4ec90e965519d92681267467f775ada5bd214aa92c0dc93d90a5e880ce9ed026', '0x060c1a8b7e19e0e6e3deffe56fd2fef99a7d5a4bc2234061734f110cf5b6367c') AND length(topics) >= 3, lower(concat('0x', substring(topics[3], 27, 40))), '') AS party, ingested_at FROM price_data.raw_evm_logs WHERE raw_evm_logs.topic0 IN ('0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca', '0x1d3135f7e52d949fd35b86ab673aeb906bdee851ec045f9539dc9a33fbfbe482', '0x6dc83b2b4249c95db32c0425ee1720f24b33553482a672c27cfae3f9cd26b5df', '0xb1c0c2e07488f4aa1df44007c536731d967f82433a7b84165277d42539b2fd7f', '0xfd1a04eeaf1025d8607aac73d41599dd887b57e743c0098da99e2670506bd748', '0x4ec90e965519d92681267467f775ada5bd214aa92c0dc93d90a5e880ce9ed026', '0x8e55ccfc9778ff8eba1646d765cf1982537ce0f9257054a17b48aad745250183', '0xc257294ad49c215e1a248c91a86bc2612b4781d9677285cc9c14498f485ef122', '0x5e8d4127e6ec0b1c7d569e172d279634cb4c958854a86b9097b4cc784e294291', '0x29a87c0fb05270894205d39dc3d391b0225438e392b727f99abdc8dc0a751f21', '0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258', '0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa', '0xfb5f43e3eb2833d020c71477c280fe339de3c2770691e1a67d65cd12eb6ea72d', '0x907affd07d507e1612862c5a5ff36f1a853b28f5e735b8bdb3bb7fac1d39bd2c', '0xb290e765bc36448563c8c8a8bdf512550cd18c6b4d7e3f3c472794e12fe86f80', '0xb57536a0e253526e84274d61a4649afa0fc49e044b9235aa18974e30444db5ae', '0xed1f3e12429ce88e77b14ddf9c2eb89f0b9e1e0faa7e33a95d0ce1bbc90a1c2f', '0xdc6b42828e03ea0b28a942f3c814c84c608207f3e38f9a69ead06acc75adcaef', '0x74526d6729c142a6e5df37263dd611255125ebfbe40b3bdcc7a884f6e643d365', '0xedbd60129f57789cfab63ebccda712fe907f483793e4facb02d0244d729907a0', '0xe79fd7d860df2c45b8a610c7420edf6bcec13675af36b9d2523378b1a83c279c', '0x40f0544b1c1f4fec29c2ffa81737598ecaa047e4e993011387699ed956bfa4eb', '0x060c1a8b7e19e0e6e3deffe56fd2fef99a7d5a4bc2234061734f110cf5b6367c', '0xb52b99b9e83551fcbd069b559cc3e823e2a1a3bad8ece46561ea77524394c850', '0xa34080a97c7bd5a0cc1fe33cb5d3332d55c380e90902d1b4453e96537a3d1006', '0x58b283ab2bf97081e73797c76c83642af1e9e330a6b0173dd0e638bd84fc5995', '0xef307ecc2880448842675e7d171caa0bcc3474fd35bb18cad19f4ff36e00d0d1', '0x4f8a50ec1fe3d316970fdadd1f94e0b822f92d31e2bac3c9dc2c6c287de07107', '0x23e5bc5f063963f9e7b37609ce9794ed733f8df8c8122736a34380f2f4039a75', '0x98e3263d243be6fa54f64665eb035d2af14f3873f13b350f25d26184c6036035', '0x345b03f5c035388db76a0f8edb9be72736d2c47998b185aee8ee8b4d9d5a882b') AND lower(raw_evm_logs.contract_address) IN ('0x98db179d65b8abc53946bd89b3433a4fd3bfb60c', '0x2df1d70f413b5edd16bb794791117948a7436a45', '0x91454e38b5ec11f3e9d6c23ca631e0f65388daf9', '0x4b1f2fc264986a7d792af4c4fc1c878cb98f1518', '0x9e9e273df28b4f54a4b7227517fe56d7ffa24843', '0x6a00bd956908bccdbac3523f862740ae9de38550');

-- The SubLoop's own loop building, into the same table: its Borrowed and Repaid (the
-- loop's HOLLAR debt) and the ICE intents its entries and exits go out as
-- (IntentSubmitted / IntentSettled) — JUICER_LOOP_TOPICS in juicer.ts. A view of its
-- own so the first view's definition never changes under an existing deployment; its
-- history comes from raw through its own DATA_UPGRADES entry. No user is named.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.juicer_loop_logs_mv TO price_data.juicer_logs (`block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `contract_address` String, `topic0` String, `topics` Array(String), `data` String, `party` String, `ingested_at` DateTime) AS SELECT block_height, event_index, extrinsic_index, block_timestamp, lower(raw_evm_logs.contract_address) AS contract_address, ifNull(raw_evm_logs.topic0, '') AS topic0, topics, data, '' AS party, ingested_at FROM price_data.raw_evm_logs WHERE raw_evm_logs.topic0 IN ('0x14a13f958d7fe38fb8529e8d43353b6d9120f52444e486a4077f68a3fc77dcbf', '0x81472a96709c8315c82af40d41ef624a642ad53864b097e53af675593bb4e035', '0xf47be53a3800f408a772b4ce403212b043ad8c0eff97ec1a583cbc250aa91c89', '0x3a51313280fc2f1e8e1ce3435821f506bc14cf540e387a22d71c54dffc7bc7b3') AND lower(raw_evm_logs.contract_address) IN ('0x2df1d70f413b5edd16bb794791117948a7436a45');

-- The vaults' exchange rate (CollateralVault.exchangeRate, WAD: collateral per share,
-- queued exits excluded) with the assets and supply it divides, as the juicer-state
-- refresher (api/src/services/juicerState.ts) read them at its pinned block. A
-- CURRENT-STATE refresher snapshot (AGENTS.md, Schema and derivations): no event states
-- it, so it is not reproducible from raw, and an empty table refills within one
-- refresher cadence. Every current price map prices the share token by it
-- (services/juicerPrice.ts): rate × the collateral's current price.
CREATE TABLE IF NOT EXISTS price_data.juicer_vault_state (`vault` String, `share_asset_id` UInt32, `collateral_asset_id` UInt32, `block_height` UInt32, `exchange_rate_wad` UInt256, `total_assets` UInt256, `total_supply` UInt256, `computed_at` DateTime DEFAULT now()) ENGINE = ReplacingMergeTree(computed_at) ORDER BY vault SETTINGS index_granularity = 64;
-- The registry assets minted 1:1 over the share (none for jETH today), priced at the
-- share's rate too — the column every strategy rate table carries, so the price loader
-- (services/strategySharePrice.ts) reads them all one way.
ALTER TABLE price_data.juicer_vault_state ADD COLUMN IF NOT EXISTS `wrapper_asset_ids` Array(UInt32) DEFAULT [] AFTER `collateral_asset_id`;
