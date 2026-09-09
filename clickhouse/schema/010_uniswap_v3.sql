-- Concentrated-liquidity (Uniswap v3) pools on Hydration's EVM, and the Gamma
-- Strategies vaults that manage positions in them. Everything here is an
-- MV-fed projection of price_data.raw_evm_logs keyed on the log's natural
-- identity (block_height, event_index), so a re-ingested raw range replaces its
-- rows instead of adding to them.
--
-- Why decode in SQL rather than at ingest: the raw decoder (src/raw/evmLogs.ts)
-- keys events by their ABI name, and the pool's `Mint`/`Burn` share names with
-- the aToken events that atoken_scaled_deltas_mv selects by name alone — decoding
-- them at ingest would feed pool positions into money-market balances. Reading
-- topics/data here keeps the raw table untouched and works for rows ingested
-- before this file existed (the rollout backfills with INSERT … SELECT).
--
-- Discovery is by topic, never by address: a pool is whatever any factory
-- announces with PoolCreated(token0,token1,fee,tickSpacing,pool), a vault whatever
-- a Gamma factory announces with HypervisorCreated(token0,token1,fee,hypervisor,
-- index), so a second fee tier, pair, or deployment appears without a code
-- change. Shapes pinned against the first deployment (2026-09-08, runtime 443):
--
--   PoolCreated  topics[2]=token0 topics[3]=token1 topics[4]=fee  data: tickSpacing, pool
--   Swap         topics[2]=sender topics[3]=recipient  data: amount0(int256) amount1(int256)
--                sqrtPriceX96 liquidity tick(int24) — a positive amount is paid INTO the pool
--   Mint         topics[2]=owner topics[3]=tickLower topics[4]=tickUpper  data: sender amount amount0 amount1
--   Burn         topics[2]=owner topics[3]=tickLower topics[4]=tickUpper  data: amount amount0 amount1
--   Collect      topics[2]=owner topics[3]=tickLower topics[4]=tickUpper  data: recipient amount0 amount1
--   Initialize   data: sqrtPriceX96 tick
--   Flash        topics[2]=sender topics[3]=recipient  data: amount0 amount1 paid0 paid1
--   CollectProtocol topics[2]=sender topics[3]=recipient  data: amount0 amount1
--   SetFeeProtocol  data: feeProtocol0Old feeProtocol1Old feeProtocol0New feeProtocol1New
--   NonfungiblePositionManager IncreaseLiquidity/DecreaseLiquidity topics[2]=tokenId  data: liquidity amount0 amount1
--   NonfungiblePositionManager Collect topics[2]=tokenId  data: recipient amount0 amount1
--   ERC-721 Transfer (4 topics, empty data) topics[2]=from topics[3]=to topics[4]=tokenId
--   Gamma Deposit/Withdraw topics[2]=sender topics[3]=to  data: shares amount0 amount1
--   Gamma Rebalance data: tick totalAmount0 totalAmount1 feeAmount0 feeAmount1 totalSupply
--   Gamma ZeroBurn  data: fee(divisor) fees0 fees1;  SetFee data: newFee
--   Gamma share ERC-20 Transfer (3 topics) on a known vault: data = value
--
-- Every ABI word is read with substring(data, 3 + 64*i, 64) → reverse(unhex(…))
-- → reinterpretAs(U)Int256; an address is the low 20 bytes of its word. A
-- topic array is 1-indexed in ClickHouse, so topics[2] is the first indexed arg.
-- Ticks are int24 and stored as Int32; every amount keeps 256 bits because an
-- 18-decimal token passes 2^64 routinely.

CREATE TABLE IF NOT EXISTS price_data.uniswap_v3_pools (`pool_address` String, `factory` String, `token0` String, `token1` String, `fee` UInt32, `tick_spacing` Int32, `block_height` UInt32, `block_timestamp` DateTime, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY pool_address SETTINGS index_granularity = 64;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.uniswap_v3_pools_mv TO price_data.uniswap_v3_pools (`pool_address` String, `factory` String, `token0` String, `token1` String, `fee` UInt32, `tick_spacing` Int32, `block_height` UInt32, `block_timestamp` DateTime, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `ingested_at` DateTime) AS SELECT lower(concat('0x', substring(data, 3 + 64 + 24, 40))) AS pool_address, lower(contract_address) AS factory, lower(concat('0x', substring(topics[2], 27, 40))) AS token0, lower(concat('0x', substring(topics[3], 27, 40))) AS token1, toUInt32(reinterpretAsUInt256(reverse(unhex(substring(topics[4], 3, 64))))) AS fee, toInt32(reinterpretAsInt256(reverse(unhex(substring(data, 3, 64))))) AS tick_spacing, block_height, block_timestamp, event_index, extrinsic_index, ingested_at FROM price_data.raw_evm_logs WHERE topic0 = '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118' AND length(topics) = 4 AND length(data) >= 130;

-- Gamma vaults (Hypervisors). A vault names its pool only by (token0, token1,
-- fee); the pool address is the uniswap_v3_pools row with the same triple.
CREATE TABLE IF NOT EXISTS price_data.uniswap_v3_vaults (`vault_address` String, `factory` String, `token0` String, `token1` String, `fee` UInt32, `vault_index` UInt64, `block_height` UInt32, `block_timestamp` DateTime, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY vault_address SETTINGS index_granularity = 64;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.uniswap_v3_vaults_mv TO price_data.uniswap_v3_vaults (`vault_address` String, `factory` String, `token0` String, `token1` String, `fee` UInt32, `vault_index` UInt64, `block_height` UInt32, `block_timestamp` DateTime, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `ingested_at` DateTime) AS SELECT lower(concat('0x', substring(data, 3 + 64 * 3 + 24, 40))) AS vault_address, lower(contract_address) AS factory, lower(concat('0x', substring(data, 3 + 24, 40))) AS token0, lower(concat('0x', substring(data, 3 + 64 + 24, 40))) AS token1, toUInt32(reinterpretAsUInt256(reverse(unhex(substring(data, 3 + 64 * 2, 64))))) AS fee, toUInt64(reinterpretAsUInt256(reverse(unhex(substring(data, 3 + 64 * 4, 64))))) AS vault_index, block_height, block_timestamp, event_index, extrinsic_index, ingested_at FROM price_data.raw_evm_logs WHERE topic0 = '0x16682fe0a2ffae99e47dc4431cb60eb5afccc35b1d4a4d0184d4516ed6031bbd' AND length(topics) = 1 AND length(data) >= 322;

-- One row per pool, position-manager or vault event, in one table so a feed
-- page reads the whole venue in one ordered scan. `kind` says which contract
-- class emitted it ('pool' | 'manager' | 'vault'); `event_name` is the ABI name
-- (the manager's and the pool's `Collect` are told apart by `kind`). Column use
-- per event, everything else 0/'':
--   Swap            actor=sender counterparty=recipient amount0 amount1 (signed) sqrt_price_x96 liquidity tick
--   Mint            actor=sender owner tick_lower tick_upper liquidity amount0 amount1
--   Burn            actor=owner  owner tick_lower tick_upper liquidity amount0 amount1
--   Collect (pool)  actor=owner  owner counterparty=recipient tick_lower tick_upper amount0 amount1
--   Initialize      sqrt_price_x96 tick
--   Flash           actor=sender counterparty=recipient amount0 amount1 (borrowed) aux0 aux1 (paid)
--   CollectProtocol actor=sender counterparty=recipient amount0 amount1
--   SetFeeProtocol  aux0=feeProtocol0New aux1=feeProtocol1New
--   IncreaseLiquidity / DecreaseLiquidity  token_id liquidity amount0 amount1
--   Collect (manager)  token_id counterparty=recipient amount0 amount1
--   Transfer (manager, ERC-721)  actor=from counterparty=to token_id
--   Deposit / Withdraw (vault)  actor=sender counterparty=to liquidity=shares amount0 amount1
--   Rebalance (vault)  tick amount0 amount1 (totals) aux0 aux1 (fees earned) liquidity=totalSupply
--   ZeroBurn (vault)   aux0=fee divisor amount0 amount1 (fees collected)
--   SetFee (vault)     aux0=newFee
--   Transfer (vault share, ERC-20)  actor=from counterparty=to liquidity=value
CREATE TABLE IF NOT EXISTS price_data.uniswap_v3_events (`block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `contract_address` String, `kind` LowCardinality(String), `event_name` LowCardinality(String), `actor` String, `counterparty` String, `owner` String, `token_id` UInt256, `tick_lower` Int32, `tick_upper` Int32, `tick` Int32, `liquidity` UInt256, `amount0` Int256, `amount1` Int256, `sqrt_price_x96` UInt256, `aux0` UInt256, `aux1` UInt256, `ingested_at` DateTime, INDEX idx_contract contract_address TYPE bloom_filter(0.01) GRANULARITY 4, INDEX idx_actor actor TYPE bloom_filter(0.01) GRANULARITY 4, INDEX idx_counterparty counterparty TYPE bloom_filter(0.01) GRANULARITY 4, INDEX idx_owner owner TYPE bloom_filter(0.01) GRANULARITY 4) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY toYYYYMM(block_timestamp) ORDER BY (block_height, event_index) SETTINGS index_granularity = 1024;

-- Pool contract events. Swap amounts are int256 and keep their sign; every other
-- amount is unsigned on chain and lands positive.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.uniswap_v3_pool_events_mv TO price_data.uniswap_v3_events (`block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `contract_address` String, `kind` LowCardinality(String), `event_name` LowCardinality(String), `actor` String, `counterparty` String, `owner` String, `token_id` UInt256, `tick_lower` Int32, `tick_upper` Int32, `tick` Int32, `liquidity` UInt256, `amount0` Int256, `amount1` Int256, `sqrt_price_x96` UInt256, `aux0` UInt256, `aux1` UInt256, `ingested_at` DateTime) AS WITH multiIf(topic0 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', 'Swap', topic0 = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde', 'Mint', topic0 = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c', 'Burn', topic0 = '0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0', 'Collect', topic0 = '0x98636036cb66a9c19a37435efc1e90142190214e8abeb821bdba3f2990dd4c95', 'Initialize', topic0 = '0xbdbdb71d7860376ba52b25a5028beea23581364a40522f6bcfb86bb1f2dca633', 'Flash', topic0 = '0x596b573906218d3411850b26a6b437d6c4522fdb43d2d2386263f86d50b8b151', 'CollectProtocol', 'SetFeeProtocol') AS ev, lower(concat('0x', substring(topics[2], 27, 40))) AS t2addr, lower(concat('0x', substring(topics[3], 27, 40))) AS t3addr, toInt32(reinterpretAsInt256(reverse(unhex(substring(topics[3], 3, 64))))) AS t3int, toInt32(reinterpretAsInt256(reverse(unhex(substring(topics[4], 3, 64))))) AS t4int, reinterpretAsInt256(reverse(unhex(substring(data, 3, 64)))) AS w0, reinterpretAsInt256(reverse(unhex(substring(data, 3 + 64, 64)))) AS w1, reinterpretAsInt256(reverse(unhex(substring(data, 3 + 64 * 2, 64)))) AS w2, reinterpretAsInt256(reverse(unhex(substring(data, 3 + 64 * 3, 64)))) AS w3, reinterpretAsInt256(reverse(unhex(substring(data, 3 + 64 * 4, 64)))) AS w4, lower(concat('0x', substring(data, 3 + 24, 40))) AS w0addr SELECT block_height, event_index, extrinsic_index, block_timestamp, lower(contract_address) AS contract_address, 'pool' AS kind, ev AS event_name, multiIf(ev IN ('Swap', 'Flash', 'CollectProtocol'), t2addr, ev = 'Mint', w0addr, ev IN ('Burn', 'Collect'), t2addr, '') AS actor, multiIf(ev IN ('Swap', 'Flash', 'CollectProtocol'), t3addr, ev = 'Collect', w0addr, '') AS counterparty, if(ev IN ('Mint', 'Burn', 'Collect'), t2addr, '') AS owner, toUInt256(0) AS token_id, if(ev IN ('Mint', 'Burn', 'Collect'), t3int, 0) AS tick_lower, if(ev IN ('Mint', 'Burn', 'Collect'), t4int, 0) AS tick_upper, multiIf(ev = 'Swap', toInt32(w4), ev = 'Initialize', toInt32(w1), 0) AS tick, multiIf(ev = 'Swap', toUInt256(w3), ev = 'Mint', toUInt256(w1), ev = 'Burn', toUInt256(w0), toUInt256(0)) AS liquidity, multiIf(ev IN ('Swap', 'Flash', 'CollectProtocol'), w0, ev = 'Mint', w2, ev IN ('Burn', 'Collect'), w1, toInt256(0)) AS amount0, multiIf(ev IN ('Swap', 'Flash', 'CollectProtocol'), w1, ev = 'Mint', w3, ev IN ('Burn', 'Collect'), w2, toInt256(0)) AS amount1, multiIf(ev = 'Swap', toUInt256(w2), ev = 'Initialize', toUInt256(w0), toUInt256(0)) AS sqrt_price_x96, multiIf(ev = 'Flash', toUInt256(w2), ev = 'SetFeeProtocol', toUInt256(w2), toUInt256(0)) AS aux0, multiIf(ev = 'Flash', toUInt256(w3), ev = 'SetFeeProtocol', toUInt256(w3), toUInt256(0)) AS aux1, ingested_at FROM price_data.raw_evm_logs WHERE topic0 IN ('0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde', '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c', '0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0', '0x98636036cb66a9c19a37435efc1e90142190214e8abeb821bdba3f2990dd4c95', '0xbdbdb71d7860376ba52b25a5028beea23581364a40522f6bcfb86bb1f2dca633', '0x596b573906218d3411850b26a6b437d6c4522fdb43d2d2386263f86d50b8b151', '0x973d8d92bb299f4af6ce49b52a8adb85ae46b9f214c4c4fc06ac77401237b133');

-- Position-manager events: the NFT position lifecycle. An ERC-721 Transfer is
-- any 4-topic Transfer with empty data; readers narrow to the contracts that
-- also emitted IncreaseLiquidity, so another NFT collection cannot pose as a
-- position.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.uniswap_v3_manager_events_mv TO price_data.uniswap_v3_events (`block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `contract_address` String, `kind` LowCardinality(String), `event_name` LowCardinality(String), `actor` String, `counterparty` String, `owner` String, `token_id` UInt256, `tick_lower` Int32, `tick_upper` Int32, `tick` Int32, `liquidity` UInt256, `amount0` Int256, `amount1` Int256, `sqrt_price_x96` UInt256, `aux0` UInt256, `aux1` UInt256, `ingested_at` DateTime) AS WITH multiIf(topic0 = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f', 'IncreaseLiquidity', topic0 = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4', 'DecreaseLiquidity', topic0 = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01', 'Collect', 'Transfer') AS ev, reinterpretAsInt256(reverse(unhex(substring(data, 3, 64)))) AS w0, reinterpretAsInt256(reverse(unhex(substring(data, 3 + 64, 64)))) AS w1, reinterpretAsInt256(reverse(unhex(substring(data, 3 + 64 * 2, 64)))) AS w2 SELECT block_height, event_index, extrinsic_index, block_timestamp, lower(contract_address) AS contract_address, 'manager' AS kind, ev AS event_name, if(ev = 'Transfer', lower(concat('0x', substring(topics[2], 27, 40))), '') AS actor, multiIf(ev = 'Transfer', lower(concat('0x', substring(topics[3], 27, 40))), ev = 'Collect', lower(concat('0x', substring(data, 3 + 24, 40))), '') AS counterparty, '' AS owner, if(ev = 'Transfer', reinterpretAsUInt256(reverse(unhex(substring(topics[4], 3, 64)))), reinterpretAsUInt256(reverse(unhex(substring(topics[2], 3, 64))))) AS token_id, 0 AS tick_lower, 0 AS tick_upper, 0 AS tick, if(ev IN ('IncreaseLiquidity', 'DecreaseLiquidity'), toUInt256(w0), toUInt256(0)) AS liquidity, multiIf(ev IN ('IncreaseLiquidity', 'DecreaseLiquidity', 'Collect'), w1, toInt256(0)) AS amount0, multiIf(ev IN ('IncreaseLiquidity', 'DecreaseLiquidity', 'Collect'), w2, toInt256(0)) AS amount1, toUInt256(0) AS sqrt_price_x96, toUInt256(0) AS aux0, toUInt256(0) AS aux1, ingested_at FROM price_data.raw_evm_logs WHERE (topic0 IN ('0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f', '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4', '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01') AND length(topics) = 2) OR (topic0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' AND length(topics) = 4 AND length(data) <= 2);

-- Gamma vault events, from contracts the vault table already knows (the
-- HypervisorCreated log precedes any vault event by construction, and the
-- Deposit/Withdraw signatures are generic enough that an unknown emitter must not
-- pass as a vault). Deposit/Withdraw are the user-facing liquidity acts;
-- Rebalance and ZeroBurn are the operator's management (ZeroBurn fires on every
-- compound, dozens a day, and is plumbing to a feed). A share transfer is the
-- vault's own ERC-20 Transfer.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.uniswap_v3_vault_events_mv TO price_data.uniswap_v3_events (`block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `contract_address` String, `kind` LowCardinality(String), `event_name` LowCardinality(String), `actor` String, `counterparty` String, `owner` String, `token_id` UInt256, `tick_lower` Int32, `tick_upper` Int32, `tick` Int32, `liquidity` UInt256, `amount0` Int256, `amount1` Int256, `sqrt_price_x96` UInt256, `aux0` UInt256, `aux1` UInt256, `ingested_at` DateTime) AS WITH multiIf(topic0 = '0x4e2ca0515ed1aef1395f66b5303bb5d6f1bf9d61a353fa53f73f8ac9973fa9f6', 'Deposit', topic0 = '0xebff2602b3f468259e1e99f613fed6691f3a6526effe6ef3e768ba7ae7a36c4f', 'Withdraw', topic0 = '0xbc4c20ad04f161d631d9ce94d27659391196415aa3c42f6a71c62e905ece782d', 'Rebalance', topic0 = '0x4606b8a47eb284e8e80929101ece6ab5fe8d4f8735acc56bd0c92ca872f2cfe7', 'ZeroBurn', topic0 = '0x91f2ade82ab0e77bb6823899e6daddc07e3da0e3ad998577e7c09c2f38943c43', 'SetFee', 'Transfer') AS ev, reinterpretAsInt256(reverse(unhex(substring(data, 3, 64)))) AS w0, reinterpretAsInt256(reverse(unhex(substring(data, 3 + 64, 64)))) AS w1, reinterpretAsInt256(reverse(unhex(substring(data, 3 + 64 * 2, 64)))) AS w2, reinterpretAsInt256(reverse(unhex(substring(data, 3 + 64 * 3, 64)))) AS w3, reinterpretAsInt256(reverse(unhex(substring(data, 3 + 64 * 4, 64)))) AS w4, reinterpretAsInt256(reverse(unhex(substring(data, 3 + 64 * 5, 64)))) AS w5 SELECT block_height, event_index, extrinsic_index, block_timestamp, lower(contract_address) AS contract_address, 'vault' AS kind, ev AS event_name, if(ev IN ('Deposit', 'Withdraw', 'Transfer'), lower(concat('0x', substring(topics[2], 27, 40))), '') AS actor, if(ev IN ('Deposit', 'Withdraw', 'Transfer'), lower(concat('0x', substring(topics[3], 27, 40))), '') AS counterparty, lower(contract_address) AS owner, toUInt256(0) AS token_id, 0 AS tick_lower, 0 AS tick_upper, if(ev = 'Rebalance', toInt32(w0), 0) AS tick, multiIf(ev IN ('Deposit', 'Withdraw', 'Transfer'), toUInt256(w0), ev = 'Rebalance', toUInt256(w5), toUInt256(0)) AS liquidity, multiIf(ev IN ('Deposit', 'Withdraw'), w1, ev IN ('Rebalance', 'ZeroBurn'), w1, toInt256(0)) AS amount0, multiIf(ev IN ('Deposit', 'Withdraw'), w2, ev IN ('Rebalance', 'ZeroBurn'), w2, toInt256(0)) AS amount1, toUInt256(0) AS sqrt_price_x96, multiIf(ev = 'Rebalance', toUInt256(w3), ev IN ('ZeroBurn', 'SetFee'), toUInt256(w0), toUInt256(0)) AS aux0, if(ev = 'Rebalance', toUInt256(w4), toUInt256(0)) AS aux1, ingested_at FROM price_data.raw_evm_logs WHERE lower(contract_address) IN (SELECT vault_address FROM price_data.uniswap_v3_vaults) AND ((topic0 IN ('0x4e2ca0515ed1aef1395f66b5303bb5d6f1bf9d61a353fa53f73f8ac9973fa9f6', '0xebff2602b3f468259e1e99f613fed6691f3a6526effe6ef3e768ba7ae7a36c4f') AND length(topics) = 3 AND length(data) >= 194) OR (topic0 = '0xbc4c20ad04f161d631d9ce94d27659391196415aa3c42f6a71c62e905ece782d' AND length(data) >= 386) OR (topic0 = '0x4606b8a47eb284e8e80929101ece6ab5fe8d4f8735acc56bd0c92ca872f2cfe7' AND length(data) >= 194) OR (topic0 = '0x91f2ade82ab0e77bb6823899e6daddc07e3da0e3ad998577e7c09c2f38943c43' AND length(topics) = 1) OR (topic0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' AND length(topics) = 3));

-- Daily-activity histogram rows for the venue, into the table the substrate arm
-- (activity_histogram_events_mv, 003) feeds, so the explorer's per-day bars count
-- concentrated-liquidity swaps and LP acts beside every other kind. One row per act:
--   Swap → 'UniswapV3.Swap', identity = the extrinsic (activity_index = extrinsic_index,
--          like the substrate swap names), so a Router-routed hop's log and its
--          Router.Executed row are ONE trade and a direct EVM swap is one too;
--   pool Mint / Burn / Collect not owned by a vault → 'UniswapV3.Mint' / 'UniswapV3.Burn'
--          / 'UniswapV3.Collect'. A manager position's IncreaseLiquidity, DecreaseLiquidity
--          and Collect are each 1:1 with the pool row they cause in the same extrinsic, and
--          only the pool row names the pool, so the pool rows stand for manager-driven
--          and pool-direct positions alike. A burn(0) poke is no act. A collect that only
--          settled a decrease's principal is counted too (the feed drops it; telling the
--          two apart needs the decrease, another row);
--   vault Deposit / Withdraw / Rebalance → 'Gamma.Deposit' / 'Gamma.Withdraw' /
--          'Gamma.Rebalance'; the vault's own pool rows (compounding pokes, re-mints) are
--          its plumbing and excluded above by owner.
-- asset_refs stays EMPTY: only the pool row knows its pool, and its tokens resolve
-- through the registry (assets.evm_address, the precompile rule), a dimension table an
-- insert-time JOIN would read at whatever state it had — a fresh database backfilling
-- raw before the registry tracker wrote it would store empty refs for good. The
-- reader (getDailyActivity) resolves a token filter to pool/vault addresses and joins
-- these rows to uniswap_v3_events at the same (block, event) identity instead.
-- The pool and vault predicates are IN-subqueries on the announcement tables, which
-- precede any pool or vault log by construction (a pool created and minted into in ONE
-- transaction would miss that first mint; no such multicall has been seen).
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.uniswap_v3_histogram_mv TO price_data.activity_histogram_events (`day` Date, `block_height` UInt32, `event_index` UInt32, `activity_index` UInt32, `event_name` LowCardinality(String), `asset_refs` Array(UInt32), `ingested_at` DateTime) AS SELECT toDate(block_timestamp) AS day, block_height, event_index, if(topic0 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', ifNull(extrinsic_index, event_index), event_index) AS activity_index, multiIf(topic0 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', 'UniswapV3.Swap', topic0 = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde', 'UniswapV3.Mint', topic0 = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c', 'UniswapV3.Burn', topic0 = '0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0', 'UniswapV3.Collect', topic0 = '0x4e2ca0515ed1aef1395f66b5303bb5d6f1bf9d61a353fa53f73f8ac9973fa9f6', 'Gamma.Deposit', topic0 = '0xebff2602b3f468259e1e99f613fed6691f3a6526effe6ef3e768ba7ae7a36c4f', 'Gamma.Withdraw', 'Gamma.Rebalance') AS event_name, CAST([], 'Array(UInt32)') AS asset_refs, ingested_at FROM price_data.raw_evm_logs WHERE (topic0 IN ('0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde', '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c', '0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0') AND lower(contract_address) IN (SELECT pool_address FROM price_data.uniswap_v3_pools) AND NOT (topic0 != '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67' AND lower(concat('0x', substring(topics[2], 27, 40))) IN (SELECT vault_address FROM price_data.uniswap_v3_vaults)) AND NOT (topic0 = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c' AND reinterpretAsUInt256(reverse(unhex(substring(data, 3, 64)))) = 0)) OR (lower(contract_address) IN (SELECT vault_address FROM price_data.uniswap_v3_vaults) AND ((topic0 IN ('0x4e2ca0515ed1aef1395f66b5303bb5d6f1bf9d61a353fa53f73f8ac9973fa9f6', '0xebff2602b3f468259e1e99f613fed6691f3a6526effe6ef3e768ba7ae7a36c4f') AND length(topics) = 3 AND length(data) >= 194) OR (topic0 = '0xbc4c20ad04f161d631d9ce94d27659391196415aa3c42f6a71c62e905ece782d' AND length(data) >= 386)));
