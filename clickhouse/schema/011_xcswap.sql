-- Cross-chain swaps out of Hydration through NEAR Intents.
--
-- Not a pallet: an EVM contract on Hydration (`IntentEmitter`, a UUPS proxy —
-- galacticcouncil/whm contracts/src/intents/IntentEmitter.sol) plus the Defuse
-- "1Click" solver network off-chain. One order is `placeOrder(assetIn, amountIn,
-- minEthOut, depositAddress, maxRelayFee)`, which:
--
--   1. pulls `assetIn` from the caller,
--   2. dispatches a Router sell assetIn -> WETH (asset 20) through the Substrate
--      dispatch precompile — so the trade is an ordinary Broadcast.Swapped3 whose
--      swapper is the CONTRACT, not the caller,
--   3. takes the NTT delivery price and the Wormhole message fee out of that WETH,
--      trims the rest to 8 decimals (TRIM_UNIT 1e10; the remainder stays as
--      sweepable dust), and settles it over Wormhole NTT to `IntentReceiver` on
--      Ethereum,
--   4. publishes a second Wormhole message carrying (sequence, depositAddress,
--      maxRelayFee) — NTT carries no payload, so the destination travels as its own
--      message, matched on the NTT sequence,
--   5. emits OrderPlaced.
--
-- On Ethereum the receiver skims at most `maxRelayFee` and forwards to the deposit
-- address; NEAR Intents solvers then swap ETH into the destination asset and deliver
-- it. THE DESTINATION IS NOT ON CHAIN: which asset, which recipient and how much
-- arrived live only in the 1Click quote. `deposit_address` is the join key that
-- recovers them (api/src/services/xcswapSettlements.ts), and a row that has not been
-- resolved yet states its on-chain half and says the destination is unknown — never
-- a guessed one.
--
-- Shapes pinned against the live deployment (first order block 13,797,859,
-- 2026-08-25). The emitter's logs are undecoded in raw_evm_logs (no ABI is
-- registered for it), so topics and data are read positionally here, exactly as
-- 010_uniswap_v3.sql does:
--
--   OrderPlaced(uint64 indexed transferSequence, address indexed depositAddress,
--               address indexed caller, uint32 assetIn, uint256 amountIn,
--               uint256 ethOut, uint256 maxRelayFee)
--   topic0 0xf6cb525ed277a5e4c2de1113e9e3214dbb3f31c51061f3151a035982df4cc90f
--   topics[2]=transferSequence topics[3]=depositAddress topics[4]=caller
--   data: assetIn, amountIn, ethOut, maxRelayFee
--
-- Discovery is by (address, topic0) rather than topic alone: OrderPlaced is a
-- generic enough name that another contract could collide with it, and the emitter
-- is a fixed, owner-upgradeable proxy whose address is the deployment's identity.

CREATE TABLE IF NOT EXISTS price_data.xcswap_orders
(
    `block_height` UInt32,
    `event_index` UInt32,
    `extrinsic_index` Nullable(UInt32),
    `block_timestamp` DateTime,
    -- The NTT manager's sequence: the key the Ethereum receiver matches the
    -- settlement and its forwarding instruction on.
    `transfer_sequence` UInt64,
    -- Ethereum address the settlement is forwarded to, net of the relay fee. This
    -- is the 1Click quote's deposit address and the only join key to the
    -- destination leg.
    `deposit_address` String,
    -- Who placed the order, as the H160 the log carries and as the ETH-marker
    -- AccountId32 the substrate side uses for the same account.
    `caller` String,
    `caller_account_id` String,
    `asset_in` UInt32,
    `amount_in` String,
    -- WETH the settlement carries, after both rails' fees and the trim.
    `eth_out` String,
    -- Ceiling a redeemer may claim on Ethereum; committed by the caller.
    `max_relay_fee` String,
    `ingested_at` DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, event_index)
SETTINGS index_granularity = 64;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.xcswap_orders_mv TO price_data.xcswap_orders
(
    `block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32),
    `block_timestamp` DateTime, `transfer_sequence` UInt64, `deposit_address` String,
    `caller` String, `caller_account_id` String, `asset_in` UInt32, `amount_in` String,
    `eth_out` String, `max_relay_fee` String, `ingested_at` DateTime
) AS
WITH
    concat('0x', substring(topics[3], 27)) AS deposit_addr,
    concat('0x', substring(topics[4], 27)) AS caller_addr
SELECT
    block_height,
    event_index,
    extrinsic_index,
    block_timestamp,
    toUInt64(reinterpretAsUInt256(reverse(unhex(substring(topics[2], 3, 64))))) AS transfer_sequence,
    lower(deposit_addr) AS deposit_address,
    lower(caller_addr) AS caller,
    -- The ETH-marker AccountId32 form ('ETH\0' + the H160 + zero padding) the
    -- substrate side stores for an EVM account, so the read path can scope to an
    -- account without re-deriving it per request.
    lower(concat('0x45544800', substring(caller_addr, 3), '0000000000000000')) AS caller_account_id,
    toUInt32(reinterpretAsUInt256(reverse(unhex(substring(data, 3, 64))))) AS asset_in,
    toString(reinterpretAsUInt256(reverse(unhex(substring(data, 3 + 64, 64))))) AS amount_in,
    toString(reinterpretAsUInt256(reverse(unhex(substring(data, 3 + (64 * 2), 64))))) AS eth_out,
    toString(reinterpretAsUInt256(reverse(unhex(substring(data, 3 + (64 * 3), 64))))) AS max_relay_fee,
    ingested_at
FROM price_data.raw_evm_logs
WHERE lower(contract_address) = '0x98f1ebc9dcc8ab7ba54d83c98500e9e313f793f2'
  AND topic0 = '0xf6cb525ed277a5e4c2de1113e9e3214dbb3f31c51061f3151a035982df4cc90f'
  AND length(topics) = 4
  -- '0x' + four 32-byte words = 258 characters; the last word ends exactly there.
  AND length(data) >= 2 + (64 * 4);

-- Caller-first twin, so an account's own cross-chain swaps are a key-range read
-- rather than a scan of every order ever placed. Chained off xcswap_orders so the
-- positional decode above exists once; replay safety rides its replacement key.
CREATE TABLE IF NOT EXISTS price_data.xcswap_orders_by_account
(
    `caller_account_id` String,
    `block_height` UInt32,
    `event_index` UInt32,
    `extrinsic_index` Nullable(UInt32),
    `block_timestamp` DateTime,
    `transfer_sequence` UInt64,
    `deposit_address` String,
    `caller` String,
    `asset_in` UInt32,
    `amount_in` String,
    `eth_out` String,
    `max_relay_fee` String,
    `ingested_at` DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (caller_account_id, block_height, event_index)
SETTINGS index_granularity = 64;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.xcswap_orders_by_account_mv TO price_data.xcswap_orders_by_account
(
    `caller_account_id` String, `block_height` UInt32, `event_index` UInt32,
    `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime,
    `transfer_sequence` UInt64, `deposit_address` String, `caller` String,
    `asset_in` UInt32, `amount_in` String, `eth_out` String, `max_relay_fee` String,
    `ingested_at` DateTime
) AS
SELECT caller_account_id, block_height, event_index, extrinsic_index, block_timestamp,
       transfer_sequence, deposit_address, caller, asset_in, amount_in, eth_out,
       max_relay_fee, ingested_at
FROM price_data.xcswap_orders;
