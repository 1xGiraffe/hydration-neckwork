// The concentrated-liquidity (Uniswap v3) arm of /v1/accounts/{address}/liquidity,
// stated in SQL over price_data.uniswap_v3_events (clickhouse/schema/010_uniswap_v3.sql).
//
// The substrate arm reads the liquidity_activity_by_account projection, one row
// per pallet event. A v3 position is not one event: it is opened through the
// NonfungiblePositionManager or a Gamma vault, and each of those Mints into the
// pool, so the pool's own Mint/Burn/Collect are plumbing whenever a known manager
// or vault owns the position. This arm restates the act rules of the explorer's
// classifier (api/src/services/uniswapV3Service.ts, classifyV3Events — the data
// tree may not import it) so both surfaces name the same acts:
//
//   manager IncreaseLiquidity  → Add      (owner = the position NFT's holder at that
//   manager DecreaseLiquidity  → Remove    moment; pool and tick range from the pool
//   manager Collect            → CollectFees: what the collect paid BEYOND the
//                                principal a DecreaseLiquidity in the SAME
//                                extrinsic booked; a collect that only settled
//                                principal is that decrease's plumbing and is not
//                                an act. (A collect made in a later transaction
//                                than its decrease therefore reports the whole
//                                payout — the classifier's rule, kept identical.)
//   vault Deposit / Withdraw   → Add / Remove for the beneficiary (`to`, else the
//                                sender); `shares` is the vault share amount.
//   pool Mint / Burn / Collect → Add / Remove / CollectFees only when the owner is
//                                no announced manager or vault; burn(0) pokes and
//                                a collect that paid nothing beyond the same
//                                extrinsic's burns are never acts.
//
// A vault Rebalance is the operator's act, names no account, and has no row here.
// Tokens resolve to registry assets through assets.evm_address or the
// `0x…01 + id` asset precompile; an act in a pool whose token neither names, or a
// manager act whose pool row cannot be read, is omitted rather than published with
// an invented asset id.
//
// The account is matched by its EVM identity (H160): the manager's ERC-721
// Transfers, the vault's Deposit/Withdraw and the pool's `owner` all carry H160s.

const ZERO_H160 = '0x0000000000000000000000000000000000000000'

// `{h160:String}` is the only bound parameter; the caller binds it.
export const V3_LIQUIDITY_H160_PARAM = 'h160'

function precompileAssetSql(tokenExpr: string): string {
  const hex = `replaceRegexpOne(lower(${tokenExpr}), '^0x', '')`
  return `if(length(${hex}) = 40 AND substring(${hex}, 1, 32) = '00000000000000000000000000000001', toInt64(reinterpretAsUInt32(reverse(unhex(substring(${hex}, 33, 8))))), toInt64(-1))`
}

const TOKEN_ASSETS = `SELECT lower(evm_address) AS addr, any(asset_id) AS asset_id FROM price_data.assets WHERE evm_address != '' GROUP BY addr`

// The act columns every branch emits, in this order (the UNION ALL below is positional).
const ACT_COLUMNS = 'block_height, event_index, extrinsic_index, block_timestamp, event_name, action, pool_addr, token_id_s, tick_lower, tick_upper, vault, shares, a0, a1'

/**
 * The CTE chain ending in `v3_acts`: one row per act of the account, with the
 * pool's tokens resolved to asset ids. Columns of v3_acts:
 *   block_height, event_index, extrinsic_index, block_timestamp, event_name, action,
 *   pool_addr, token_id_s, tick_lower, tick_upper, vault, shares, asset0, asset1,
 *   amount0_s, amount1_s
 */
export function uniswapV3LiquidityCtesSql(): string {
  return `v3_managers AS (
  SELECT DISTINCT contract_address FROM price_data.uniswap_v3_events WHERE kind = 'manager' AND event_name = 'IncreaseLiquidity'
),
v3_vaults AS (
  SELECT vault_address, token0 AS v_token0, token1 AS v_token1, fee AS v_fee FROM price_data.uniswap_v3_vaults FINAL
),
v3_pools AS (
  SELECT p.pool_address AS pool_addr, p.token0 AS p_token0, p.token1 AS p_token1, p.fee AS p_fee,
         if(t0.asset_id > 0, toInt64(t0.asset_id), ${precompileAssetSql('p.token0')}) AS asset0,
         if(t1.asset_id > 0, toInt64(t1.asset_id), ${precompileAssetSql('p.token1')}) AS asset1
  FROM price_data.uniswap_v3_pools AS p FINAL
  LEFT JOIN (${TOKEN_ASSETS}) AS t0 ON t0.addr = lower(p.token0)
  LEFT JOIN (${TOKEN_ASSETS}) AS t1 ON t1.addr = lower(p.token1)
  WHERE asset0 >= 0 AND asset1 >= 0
),
v3_my_tokens AS (
  SELECT DISTINCT contract_address AS manager, token_id
  FROM price_data.uniswap_v3_events
  WHERE kind = 'manager' AND event_name = 'Transfer' AND counterparty = {${V3_LIQUIDITY_H160_PARAM}:String}
),
v3_token_holders AS (
  SELECT contract_address AS manager, token_id, counterparty AS holder,
         toUInt64(block_height) * 4294967296 + event_index AS pos
  FROM price_data.uniswap_v3_events FINAL
  WHERE kind = 'manager' AND event_name = 'Transfer'
    AND (contract_address, token_id) IN (SELECT manager, token_id FROM v3_my_tokens)
),
v3_mgr_rows AS (
  SELECT block_height, event_index, extrinsic_index, ifNull(extrinsic_index, 4294967295) AS ext, block_timestamp,
         contract_address AS manager, event_name AS mgr_event, token_id, liquidity, amount0, amount1,
         toUInt64(block_height) * 4294967296 + event_index AS pos,
         multiIf(event_name = 'IncreaseLiquidity', 'Mint', event_name = 'DecreaseLiquidity', 'Burn', 'Collect') AS pool_event
  FROM price_data.uniswap_v3_events FINAL
  WHERE kind = 'manager' AND event_name IN ('IncreaseLiquidity', 'DecreaseLiquidity', 'Collect')
    AND contract_address IN (SELECT contract_address FROM v3_managers)
    AND (contract_address, token_id) IN (SELECT manager, token_id FROM v3_my_tokens)
),
v3_mgr_owned AS (
  SELECT r.block_height AS block_height, r.event_index AS event_index, r.extrinsic_index AS extrinsic_index, r.ext AS ext,
         r.block_timestamp AS block_timestamp, r.manager AS manager, r.mgr_event AS mgr_event, r.token_id AS token_id,
         r.liquidity AS liquidity, r.amount0 AS amount0, r.amount1 AS amount1, r.pool_event AS pool_event
  FROM v3_mgr_rows AS r
  ASOF INNER JOIN v3_token_holders AS h ON h.manager = r.manager AND h.token_id = r.token_id AND h.pos <= r.pos
  WHERE h.holder = {${V3_LIQUIDITY_H160_PARAM}:String}
),
v3_mgr_pool_rows AS (
  SELECT block_height, ifNull(extrinsic_index, 4294967295) AS ext, event_index AS pool_event_index,
         contract_address AS pool_addr, owner AS manager, event_name AS pool_event, tick_lower AS t_lower, tick_upper AS t_upper
  FROM price_data.uniswap_v3_events FINAL
  WHERE kind = 'pool' AND event_name IN ('Mint', 'Burn', 'Collect')
    AND owner IN (SELECT contract_address FROM v3_managers)
    AND (block_height, ifNull(extrinsic_index, 4294967295)) IN (SELECT block_height, ext FROM v3_mgr_owned)
),
v3_mgr_ranged AS (
  SELECT m.block_height AS block_height, m.event_index AS event_index, m.extrinsic_index AS extrinsic_index, m.ext AS ext,
         m.block_timestamp AS block_timestamp, m.manager AS manager, m.mgr_event AS mgr_event, m.token_id AS token_id,
         m.amount0 AS amount0, m.amount1 AS amount1,
         argMaxIf(p.pool_addr, p.pool_event_index, p.pool_event_index < m.event_index) AS pool_addr,
         argMaxIf(p.t_lower, p.pool_event_index, p.pool_event_index < m.event_index) AS t_lower,
         argMaxIf(p.t_upper, p.pool_event_index, p.pool_event_index < m.event_index) AS t_upper
  FROM v3_mgr_owned AS m
  LEFT JOIN v3_mgr_pool_rows AS p
    ON p.block_height = m.block_height AND p.ext = m.ext AND p.manager = m.manager AND p.pool_event = m.pool_event
  GROUP BY m.block_height, m.event_index, m.extrinsic_index, m.ext, m.block_timestamp, m.manager, m.mgr_event, m.token_id, m.amount0, m.amount1
),
v3_mgr_decreased AS (
  SELECT block_height, ext, manager, token_id, sum(amount0) AS dec0, sum(amount1) AS dec1
  FROM v3_mgr_owned WHERE mgr_event = 'DecreaseLiquidity'
  GROUP BY block_height, ext, manager, token_id
),
v3_mgr_acts AS (
  SELECT r.block_height AS block_height, r.event_index AS event_index, r.extrinsic_index AS extrinsic_index, r.block_timestamp AS block_timestamp,
         concat('UniswapV3PositionManager.', r.mgr_event) AS event_name,
         multiIf(r.mgr_event = 'IncreaseLiquidity', 'Add', r.mgr_event = 'DecreaseLiquidity', 'Remove', 'CollectFees') AS action,
         r.pool_addr AS pool_addr, toString(r.token_id) AS token_id_s,
         if(r.pool_addr = '', NULL, r.t_lower) AS tick_lower, if(r.pool_addr = '', NULL, r.t_upper) AS tick_upper,
         '' AS vault, '' AS shares,
         if(r.mgr_event = 'Collect', greatest(r.amount0 - d.dec0, toInt256(0)), r.amount0) AS a0,
         if(r.mgr_event = 'Collect', greatest(r.amount1 - d.dec1, toInt256(0)), r.amount1) AS a1
  FROM v3_mgr_ranged AS r
  LEFT JOIN v3_mgr_decreased AS d ON d.block_height = r.block_height AND d.ext = r.ext AND d.manager = r.manager AND d.token_id = r.token_id
  WHERE r.mgr_event != 'Collect' OR a0 > 0 OR a1 > 0
),
v3_vault_acts AS (
  SELECT v.block_height AS block_height, v.event_index AS event_index, v.extrinsic_index AS extrinsic_index, v.block_timestamp AS block_timestamp,
         concat('UniswapV3Vault.', v.event_name) AS event_name,
         if(v.event_name = 'Deposit', 'Add', 'Remove') AS action,
         pl.pool_addr AS pool_addr, '' AS token_id_s,
         CAST(NULL, 'Nullable(Int32)') AS tick_lower, CAST(NULL, 'Nullable(Int32)') AS tick_upper,
         v.contract_address AS vault, toString(v.liquidity) AS shares,
         v.amount0 AS a0, v.amount1 AS a1
  FROM price_data.uniswap_v3_events AS v FINAL
  INNER JOIN v3_vaults AS vv ON vv.vault_address = v.contract_address
  INNER JOIN v3_pools AS pl ON pl.p_token0 = vv.v_token0 AND pl.p_token1 = vv.v_token1 AND pl.p_fee = vv.v_fee
  WHERE v.kind = 'vault' AND v.event_name IN ('Deposit', 'Withdraw')
    AND if(v.counterparty != '' AND v.counterparty != '${ZERO_H160}', v.counterparty, v.actor) = {${V3_LIQUIDITY_H160_PARAM}:String}
),
v3_direct_rows AS (
  SELECT block_height, event_index, extrinsic_index, ifNull(extrinsic_index, 4294967295) AS ext, block_timestamp,
         contract_address AS pool_addr, event_name AS pool_event, tick_lower AS t_lower, tick_upper AS t_upper, liquidity, amount0, amount1
  FROM price_data.uniswap_v3_events FINAL
  WHERE kind = 'pool' AND event_name IN ('Mint', 'Burn', 'Collect') AND owner = {${V3_LIQUIDITY_H160_PARAM}:String}
    AND owner NOT IN (SELECT contract_address FROM v3_managers)
    AND owner NOT IN (SELECT vault_address FROM v3_vaults)
    AND NOT (event_name = 'Burn' AND liquidity = 0)
),
v3_direct_burned AS (
  SELECT block_height, ext, pool_addr, t_lower, t_upper, sum(amount0) AS b0, sum(amount1) AS b1
  FROM v3_direct_rows WHERE pool_event = 'Burn'
  GROUP BY block_height, ext, pool_addr, t_lower, t_upper
),
v3_direct_acts AS (
  SELECT r.block_height AS block_height, r.event_index AS event_index, r.extrinsic_index AS extrinsic_index, r.block_timestamp AS block_timestamp,
         concat('UniswapV3Pool.', r.pool_event) AS event_name,
         multiIf(r.pool_event = 'Mint', 'Add', r.pool_event = 'Burn', 'Remove', 'CollectFees') AS action,
         r.pool_addr AS pool_addr, '' AS token_id_s, toNullable(r.t_lower) AS tick_lower, toNullable(r.t_upper) AS tick_upper,
         '' AS vault, '' AS shares,
         if(r.pool_event = 'Collect', greatest(r.amount0 - b.b0, toInt256(0)), r.amount0) AS a0,
         if(r.pool_event = 'Collect', greatest(r.amount1 - b.b1, toInt256(0)), r.amount1) AS a1
  FROM v3_direct_rows AS r
  LEFT JOIN v3_direct_burned AS b
    ON b.block_height = r.block_height AND b.ext = r.ext AND b.pool_addr = r.pool_addr AND b.t_lower = r.t_lower AND b.t_upper = r.t_upper
  WHERE r.pool_event != 'Collect' OR a0 > 0 OR a1 > 0
),
v3_acts AS (
  SELECT a.block_height AS block_height, a.event_index AS event_index, a.extrinsic_index AS extrinsic_index, a.block_timestamp AS block_timestamp,
         a.event_name AS event_name, a.action AS action, a.pool_addr AS pool_addr, a.token_id_s AS token_id_s,
         a.tick_lower AS tick_lower, a.tick_upper AS tick_upper, a.vault AS vault, a.shares AS shares,
         toUInt32(pl.asset0) AS asset0, toUInt32(pl.asset1) AS asset1,
         toString(greatest(a.a0, toInt256(0))) AS amount0_s, toString(greatest(a.a1, toInt256(0))) AS amount1_s
  FROM (
    SELECT ${ACT_COLUMNS} FROM v3_mgr_acts
    UNION ALL SELECT ${ACT_COLUMNS} FROM v3_vault_acts
    UNION ALL SELECT ${ACT_COLUMNS} FROM v3_direct_acts
  ) AS a
  INNER JOIN v3_pools AS pl ON pl.pool_addr = a.pool_addr
)`
}

export type LiquidityAction = 'Add' | 'Remove' | 'CollectFees' | 'Claim' | 'Create' | 'Destroy'
export const LIQUIDITY_ACTIONS: readonly LiquidityAction[] = ['Add', 'Remove', 'CollectFees', 'Claim', 'Create', 'Destroy']

/**
 * The act behind a substrate liquidity event name. The v3 arm carries its action
 * as a column (its act is not one event); this is the same vocabulary applied to
 * the pallet events, so a consumer can read one field for every venue.
 */
export function substrateLiquidityAction(eventName: string): LiquidityAction | null {
  switch (eventName) {
    case 'Omnipool.LiquidityAdded':
    case 'Omnipool.PositionCreated':
    case 'Stableswap.LiquidityAdded':
    case 'XYK.LiquidityAdded':
      return 'Add'
    case 'Omnipool.LiquidityRemoved':
    case 'Stableswap.LiquidityRemoved':
    case 'XYK.LiquidityRemoved':
      return 'Remove'
    case 'OmnipoolLiquidityMining.RewardClaimed':
    case 'XYKLiquidityMining.RewardClaimed':
      return 'Claim'
    case 'XYK.PoolCreated':
      return 'Create'
    case 'XYK.PoolDestroyed':
      return 'Destroy'
    default:
      return null
  }
}
