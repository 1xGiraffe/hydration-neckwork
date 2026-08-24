// The canonical per-stream protocol-revenue definitions — the single source of
// truth behind price_data.revenue_events / price_data.account_revenue (filled
// by the derivations jobs), the explorer's live tail, and the public fees API.
//
// Each eventful stream builds ONE SELECT producing the unified revenue_events
// row shape (REVENUE_EVENT_COLUMNS) for the anchored window
// ({anchor:DateTime}, {hours:UInt32}) — the same window convention the public
// pool surfaces use — optionally narrowed by an extra predicate (the
// derivations job injects its month-partition bound and closed-hour cut
// through it). The hollar_borrow stream is not eventful: interest accrues by
// index growth, so hollarBorrowHourlyRows() computes exact hourly accrual rows
// in TypeScript (BigInt, no float on the money path) for the job to insert.
//
// The stream semantics were pinned against the incumbent in
// api/src/public/services/feesCharts.ts and moved here verbatim where they
// already existed; the two network-fee extractions are new and their traps are
// spelled out inline (and pinned by api/tests/revenueStreams.test.ts):
//   * TransactionFeePaid.actualFee INCLUDES the tip (verified 3898/3898 joined
//     rows) and is ALWAYS denominated in HDX whatever currency the payer was
//     actually charged in (verified per fee currency) — so it prices off the
//     single HDX series and must never have the tip added again.
//   * FeeProcessor.* is TRADE-fee plumbing (3x the row volume) and
//     Treasury.Deposit events are dust sweeps; neither is a network fee, and
//     deriving substrate fees from treasury deposits generally is wrong
//     because Omnipool fee legs land there in the same extrinsics.
//   * EVM gas has no fee event at all: it is the treasury deposit inside the
//     EVM extrinsic — WETH (asset 20) via Tokens.Deposited for
//     Ethereum.transact, HDX via Balances.Deposit for EVM.call /
//     Dispatcher.dispatch_evm_call — and those extrinsics carry
//     actualFee = 0, so the two arms cannot double count.

import type { ClickHouseClient } from '../db/client.ts'
import {
  DECIMAL_STRINGS,
  OMNIPOOL_ACCOUNT,
  amountUnitSql,
  priceAliasSql,
  priceSourceSql,
  scaledUsd,
} from './valuation.ts'

export const REVENUE_STREAMS = [
  'omnipool_asset_fee',
  'omnipool_protocol_fee',
  'liquidation_penalty',
  'pepl_liquidation_profit',
  'asset_reserve',
  'hollar_borrow',
  'hsm_revenue',
  'network_fee',
] as const
export type RevenueStream = (typeof REVENUE_STREAMS)[number]
export type EventfulRevenueStream = Exclude<RevenueStream, 'hollar_borrow'>

/** The revenue_events column list every builder emits, in table order. */
export const REVENUE_EVENT_COLUMNS = [
  'stream', 'block_height', 'block_timestamp', 'event_index', 'leg_index',
  'dest', 'account', 'asset_id', 'amount', 'amount_usd',
] as const

/**
 * Which revenue_events rows are PROTOCOL revenue. Both omnipool fees are split per
 * recipient: the pool-account share stays in the pool and belongs to LPs ('lp'), a
 * legacy pre-2025-01-25 asset-fee leg carries no destination at all ('unknown'), and
 * the routed-out ('protocol') and historically burned ('burned') legs are the
 * protocol's.
 *
 * 'lp' is excluded for the PROTOCOL fee too, not just the asset fee. Since 2026-03 the
 * burned/treasury split stopped and every protocol-fee leg is paid to the Omnipool
 * account, so counting the stream in full booked $14.5k of one 30-day window — 21% of
 * reported protocol revenue — that the protocol never received; one swap read $12,588
 * against $181 actually earned.
 *
 * 'pol' is the exception: HDX's Omnipool liquidity is protocol-provided, so a fee
 * retained in the HDX position IS the protocol's. A hub-denominated protocol fee does
 * not name the position it accrued to, so the derivation resolves it from the sold
 * asset and marks the row rather than leaving that to this predicate.
 *
 * Every other stream is protocol revenue in full. account_revenue, the
 * explorer dashboard and the account/tag totals all filter through this exact
 * predicate — the public fees API is the one reader that also serves the
 * lp/burned/unknown legs, through its own destination matrix.
 */
export const PROTOCOL_REVENUE_PREDICATE_SQL
  = "(stream != 'omnipool_asset_fee' OR dest IN ('protocol', 'burned', 'pol')) AND dest != 'lp'"

/** The Substrate Treasury pallet account (modlpy/trsry), pubkey hex. */
export const TREASURY_ACCOUNT = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'

/**
 * The swapper the legs MV stamps when the actor is unknown (a literal 0x2a2a…
 * placeholder, matched exactly — 0x2a2afcf3… is a real account). Revenue from
 * such a leg is real; its payer is not, so it lands unattributed.
 */
export const PLACEHOLDER_SWAPPER = '0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a'

/** Pallet-account prefix (`modl…`) — the protocol's own operational accounts. */
export const MODL_ACCOUNT_PREFIX = '0x6d6f646c'

/**
 * A payer only when it is an actual USER. The protocol's own actors — pallet
 * accounts (`modl…`: treasury buyback/fee-conversion swaps, the liquidation
 * pallet selling seized collateral, referral/OTC-settlement bots) and the
 * runtime EVM executor — pay their fees with protocol money, so attributing
 * that to them would list the protocol among its own customers (measured:
 * ~1% of attributed revenue). Their rows keep their VALUE (dashboard totals
 * and conservation are untouched); only the payer blanks to the explicit
 * unattributed bucket, exactly like the placeholder swapper. Sibling/para
 * sovereign accounts stay attributed: another chain trading here IS a user.
 */
export function attributablePayerSql(expr: string): string {
  return `if(startsWith(${expr}, '${MODL_ACCOUNT_PREFIX}')
             OR ${expr} IN ('${PLACEHOLDER_SWAPPER}', '${HSM_EXECUTOR_ACCOUNTS[0]}'), '', ${expr})`
}

/** The Aave collector — see the feesCharts.ts note; the liquidation cut and MintedToTreasury land here. */
export const AAVE_COLLECTOR = '0xe52567ff06acd6cbe7ba94dc777a3126e180b6d9'

/** The Omnipool's hub asset (H2O); its fee legs are the protocol fee, never an asset fee. */
const HUB_ASSET_ID = 1

/**
 * The one Omnipool position whose liquidity is protocol-provided, so fees retained in
 * it are the protocol's rather than the LPs'. Measured ~97-99% protocol-owned; treated
 * as wholly so, which is the standing convention for HDX.
 */
const POL_ASSET_ID = 0

/** HOLLAR's registry id and the reserve address it is listed under. */
export const HOLLAR_ASSET_ID = 222
export const HOLLAR_RESERVE_ADDRESS = '0x531a654d1696ed52e7275a8cede955e82620f99a'

/** Aave's RAY as a SQL literal — always the string form, never a float. */
export const RAY_SQL = "toUInt256('1000000000000000000000000000')"
const RAY = 10n ** 27n

/** HSM executor accounts and the buyback-fee era switch (see feesCharts.ts for the provenance). */
export const HSM_EXECUTOR_ACCOUNTS = [
  '0x45544800000000000000000000000000000000000000090a0000000000000000',
  '0x6d6f646c70792f68736d6f640000000000000000000000000000000000000000',
] as const
const HSM_PEG_COLLATERALS = [1002, 1003] as const
const HOLLAR_UNIT_RAW = '1000000000000000000'
export const HSM_BUYBACK_FEE_CUT_BLOCK = 9_336_534
export function hsmBuybackFee(block: number): { num: bigint; den: bigint } {
  return block < HSM_BUYBACK_FEE_CUT_BLOCK
    ? { num: 100_000n, den: 900_000n }
    : { num: 100n, den: 999_900n }
}
function feeRatioLiteral(fee: { num: bigint; den: bigint }): string {
  const scaled = (fee.num * 10n ** 12n) / fee.den
  return `0.${scaled.toString().padStart(12, '0')}`
}

/**
 * A money-market reserve address as a registry asset id (deterministic EVM
 * alias, low four bytes; HOLLAR's facilitator contract is the one exception).
 */
export function reserveAssetIdSql(expr: string): string {
  return `if(startsWith(${expr}, '0x0000000000000000000000000000000100'),
             reinterpretAsUInt32(reverse(unhex(right(${expr}, 8)))),
             transform(${expr}, ['${HOLLAR_RESERVE_ADDRESS}'], [toUInt32(${HOLLAR_ASSET_ID})], toUInt32(0)))`
}

/** An H160 (with 0x) as the runtime's ETH-mapped substrate account form. */
function ethMappedAccountSql(h160Expr: string): string {
  return `concat('0x45544800', substring(lower(${h160Expr}), 3), '0000000000000000')`
}

/** The anchored source window every builder binds ({anchor}, {hours}). */
const WINDOW = `block_timestamp > {anchor:DateTime} - INTERVAL {hours:UInt32} HOUR
      AND block_timestamp <= {anchor:DateTime}`

/** The same window, table-qualified — a join makes bare `block_timestamp` ambiguous. */
const windowOn = (alias: string): string =>
  `${alias}.block_timestamp > {anchor:DateTime} - INTERVAL {hours:UInt32} HOUR
      AND ${alias}.block_timestamp <= {anchor:DateTime}`

/**
 * The shared tail: value each row at the last 1h candle CLOSED before it (the
 * event-time rule), through the same alias/decimal helpers every public pool
 * surface prices with. An unpriced row keeps amount_usd = 0 — explicit
 * incompleteness rather than a guessed price.
 */
function valuedTailSql(stream: EventfulRevenueStream): string {
  return `SELECT '${stream}' AS stream,
       r.block_height AS block_height,
       r.block_time AS block_timestamp,
       r.event_index AS event_index,
       toUInt16(r.leg_index) AS leg_index,
       r.dest AS dest,
       r.account AS account,
       toUInt32(r.asset_id) AS asset_id,
       toString(r.amount) AS amount,
       if(p.close > 0,
          divideDecimal(multiplyDecimal(toDecimal256(r.amount, 0), toDecimal256(p.close, 12), 12), ${amountUnitSql('r.asset_id')}, 12),
          toDecimal256(0, 12)) AS amount_usd
FROM rows r
ASOF LEFT JOIN ${priceSourceSql()} p
  ON p.asset_id = ${priceAliasSql('r.asset_id')} AND p.price_time <= r.block_time`
}

// ---------------------------------------------------------------------------
// Per-stream builders
// ---------------------------------------------------------------------------

function omnipoolFeeRowsSql(stream: 'omnipool_asset_fee' | 'omnipool_protocol_fee', extra: string): string {
  const hub = stream === 'omnipool_protocol_fee' ? `asset_id = ${HUB_ASSET_ID}` : `asset_id != ${HUB_ASSET_ID}`
  // FINAL rather than GROUP BY + argMax: the table's ORDER BY is the leg
  // identity, so FINAL is the same deduplication in sorted-merge form (the
  // measured feesCharts choice), and it leaves the source columns readable in
  // WHERE — an argMax alias named like its column would shadow the WHERE
  // reference and ClickHouse rejects the aggregate there.
  // Which position a retained fee accrued to. An asset fee is charged in the asset
  // itself, so its own asset_id names the position; a protocol fee is charged in the
  // hub asset, so the position is the asset that was SOLD — known only from the
  // sibling 'in' leg of the same swap event. HDX's Omnipool liquidity is
  // protocol-provided, so a fee retained there is the protocol's, not the LPs'.
  const soldJoin = stream === 'omnipool_protocol_fee'
    ? `LEFT JOIN (
    SELECT block_height, event_index, anyIf(asset_id, leg_kind = 'in') AS sold_asset
    FROM price_data.pool_swap_legs FINAL
    WHERE venue = 'omnipool' AND ${WINDOW} AND (${extra})
    GROUP BY block_height, event_index
  ) AS s ON s.block_height = f.block_height AND s.event_index = f.event_index`
    : ''
  const retainedInHdx = stream === 'omnipool_protocol_fee'
    ? `s.sold_asset = ${POL_ASSET_ID}`
    : `f.asset_id = ${POL_ASSET_ID}`
  return `-- rev:${stream}
WITH rows AS (
  SELECT f.block_height AS block_height, f.event_index AS event_index, f.leg_index AS leg_index,
         f.block_timestamp AS block_time,
         multiIf(f.fee_dest = 'burned', 'burned',
                 f.fee_recipient = '${OMNIPOOL_ACCOUNT}' AND ${retainedInHdx}, 'pol',
                 f.fee_recipient = '${OMNIPOOL_ACCOUNT}', 'lp',
                 f.fee_recipient != '', 'protocol',
                 'unknown') AS dest,
         ${attributablePayerSql('f.swapper')} AS account,
         f.asset_id AS asset_id, f.amount AS amount
  FROM price_data.pool_swap_legs AS f FINAL
  ${soldJoin}
  WHERE f.venue = 'omnipool' AND f.leg_kind = 'fee' AND f.${hub}
    AND ${windowOn('f')}
    AND (${extra})
)
${valuedTailSql(stream)}`
}

/**
 * The protocol's cut of every liquidation bonus: the aToken BalanceTransfer
 * into AAVE_COLLECTOR inside the liquidation's block (see feesCharts.ts for
 * why the transfer, not an estimate), un-scaled by the event's own index.
 *
 * Attribution: the transfer does not name the borrower, so it is matched to
 * the same block's LiquidationCall(s) on the SAME RESERVE (the transfer's
 * aToken is the collateral's aToken) and split pro-rata by
 * liquidatedCollateralAmount when a cascade block carries several. The split
 * is the exact-partition form — cumulative floor differences — so the shares
 * sum to the transferred amount to the planck. A transfer with no matching
 * call keeps its full amount unattributed rather than being dropped, or the
 * stream total would no longer conserve.
 */
function liquidationPenaltyRowsSql(extra: string): string {
  return `-- rev:liquidation_penalty
WITH liq_calls AS (
  SELECT block_height, event_index,
         argMax(lower(JSONExtractString(decoded_args_json, 'collateralAsset')), ingested_at) AS reserve,
         argMax(ifNull(account_id, ''), ingested_at) AS account,
         argMax(toUInt256OrZero(JSONExtractString(decoded_args_json, 'liquidatedCollateralAmount')), ingested_at) AS weight
  FROM price_data.raw_money_market_events
  WHERE event_name = 'LiquidationCall'
    AND ${WINDOW}
    AND (${extra})
  GROUP BY block_height, event_index
),
fee_transfers AS (
  SELECT t.block_height AS block_height, t.event_index AS event_index, t.block_time AS block_time,
         ${reserveAssetIdSql('m.asset_address')} AS asset_id,
         lower(m.asset_address) AS reserve,
         intDiv(toUInt256OrZero(JSONExtractString(t.args, 'value')) * toUInt256OrZero(JSONExtractString(t.args, 'index')),
                ${RAY_SQL}) AS amount
  FROM (
    SELECT block_height, event_index, min(block_timestamp) AS block_time,
           argMax(lower(contract_address), ingested_at) AS atoken,
           argMax(decoded_args_json, ingested_at) AS args
    FROM price_data.raw_evm_logs
    WHERE event_name = 'BalanceTransfer'
      AND ${WINDOW}
      AND (${extra})
      AND block_height IN (SELECT DISTINCT block_height FROM liq_calls)
      AND lower(JSONExtractString(decoded_args_json, 'to')) = '${AAVE_COLLECTOR}'
    GROUP BY block_height, event_index
  ) t
  INNER JOIN (
    SELECT lower(atoken) AS atoken, any(asset_address) AS asset_address
    FROM price_data.atoken_reserve_map GROUP BY atoken
  ) m ON m.atoken = t.atoken
),
matched AS (
  SELECT t.block_height AS block_height, t.event_index AS event_index, t.block_time AS block_time,
         t.asset_id AS asset_id, c.account AS account, c.weight AS weight, t.amount AS full_amount,
         sum(c.weight) OVER (PARTITION BY t.block_height, t.event_index) AS wsum,
         sum(c.weight) OVER (PARTITION BY t.block_height, t.event_index ORDER BY c.event_index
                             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS wcum,
         toUInt16(row_number() OVER (PARTITION BY t.block_height, t.event_index ORDER BY c.event_index) - 1) AS leg_index
  FROM fee_transfers t
  INNER JOIN liq_calls c ON c.block_height = t.block_height AND c.reserve = t.reserve
),
split AS (
  SELECT block_height, block_time, event_index, leg_index, account, asset_id,
         if(wsum = toUInt256(0),
            if(leg_index = 0, full_amount, toUInt256(0)),
            toUInt256(toInt256(intDiv(full_amount * wcum, wsum)) - toInt256(intDiv(full_amount * (wcum - weight), wsum)))) AS amount
  FROM matched
),
rows AS (
  SELECT block_height, block_time, event_index, leg_index, '' AS dest,
         ${attributablePayerSql('account')} AS account, asset_id, amount
  FROM split
  WHERE amount > toUInt256(0)
  UNION ALL
  SELECT t.block_height AS block_height, t.block_time AS block_time, t.event_index AS event_index,
         toUInt16(0) AS leg_index, '' AS dest, '' AS account, t.asset_id AS asset_id, t.amount AS amount
  FROM fee_transfers t
  LEFT ANTI JOIN liq_calls c ON c.block_height = t.block_height AND c.reserve = t.reserve
)
${valuedTailSql('liquidation_penalty')}`
}

/** The protocol liquidator's booked profit, attributed to the liquidated user. */
function peplProfitRowsSql(extra: string): string {
  return `-- rev:pepl_liquidation_profit
WITH liquidated AS (
  SELECT block_height, event_index, min(block_timestamp) AS block_time,
         argMax(args_json, ingested_at) AS args
  FROM price_data.raw_events
  WHERE event_name = 'Liquidation.Liquidated'
    AND ${WINDOW}
    AND (${extra})
    AND block_height IN (
      SELECT block_height FROM price_data.liquidation_extrinsics
      WHERE block_timestamp > {anchor:DateTime} - INTERVAL {hours:UInt32} HOUR
        AND block_timestamp <= {anchor:DateTime}
    )
  GROUP BY block_height, event_index
),
rows AS (
  SELECT block_height, block_time, event_index, toUInt16(0) AS leg_index, '' AS dest,
         ${attributablePayerSql(ethMappedAccountSql("JSONExtractString(args, 'user')"))} AS account,
         toUInt32(JSONExtractUInt(args, 'debtAsset')) AS asset_id,
         JSONExtractString(args, 'profit') AS amount
  FROM liquidated
)
${valuedTailSql('pepl_liquidation_profit')}`
}

/** The reserve-factor share of borrow interest, as Aave mints it to the treasury. */
function assetReserveRowsSql(extra: string): string {
  return `-- rev:asset_reserve
WITH minted AS (
  SELECT block_height, event_index, min(block_timestamp) AS block_time,
         argMax(ifNull(reserve_address, ''), ingested_at) AS reserve,
         argMax(metrics_json, ingested_at) AS metrics
  FROM price_data.raw_money_market_reserves
  WHERE event_name = 'MintedToTreasury'
    AND ${WINDOW}
    AND (${extra})
  GROUP BY block_height, event_index
),
rows AS (
  SELECT block_height, block_time, event_index, toUInt16(0) AS leg_index, '' AS dest, '' AS account,
         ${reserveAssetIdSql('reserve')} AS asset_id,
         JSONExtractString(metrics, 'amountMinted') AS amount
  FROM minted
)
${valuedTailSql('asset_reserve')}`
}

/**
 * HSM revenue — stablepool arbitrage profit plus buyback fees, per fill. The
 * semantics (peg-parity valuation, the ArbitrageExecuted semi-join as the
 * scope guard against the protocol liquidator sharing the executor account,
 * the buyback-fee era switch) are feesCharts.ts's, verbatim. Here each fill
 * becomes a revenue_events row: a buyback fill is attributed to the swapper
 * who sold HOLLAR and carries the retained collateral fee as its raw amount;
 * an arbitrage fill is the protocol trading with itself, so it stays
 * unattributed and carries no raw amount (its value exists only in USD).
 */
function hsmRevenueRowsSql(extra: string): string {
  const executors = HSM_EXECUTOR_ACCOUNTS.map(a => `'${a}'`).join(', ')
  const pegs = HSM_PEG_COLLATERALS.join(', ')
  const feeOld = hsmBuybackFee(0)
  const feeNew = hsmBuybackFee(HSM_BUYBACK_FEE_CUT_BLOCK)
  return `-- rev:hsm_revenue
WITH arb AS (
  SELECT DISTINCT block_height, JSONExtractString(args_json, 'hollarAmount') AS hollar_amount
  FROM price_data.raw_events
  WHERE event_name = 'HSM.ArbitrageExecuted'
    AND ${WINDOW}
    AND (${extra})
),
hsm_legs AS (
  SELECT venue, block_height, event_index, leg_kind, asset_id, amount, swapper,
         block_timestamp AS block_time
  FROM price_data.pool_swap_legs FINAL
  WHERE ((venue = 'stableswap' AND swapper IN (${executors})) OR venue = 'hsm')
    AND leg_kind IN ('in', 'out')
    AND ${WINDOW}
    AND (${extra})
),
fills AS (
  SELECT venue, block_height, event_index, min(block_time) AS block_time,
         any(swapper) AS swapper,
         anyIf(amount, asset_id = ${HOLLAR_ASSET_ID}) AS hollar_amount,
         maxIf(leg_kind = 'out', asset_id = ${HOLLAR_ASSET_ID}) AS hollar_is_out,
         anyIf(asset_id, asset_id != ${HOLLAR_ASSET_ID}) AS collateral_asset,
         anyIf(amount, asset_id != ${HOLLAR_ASSET_ID}) AS collateral_amount
  FROM hsm_legs
  GROUP BY venue, block_height, event_index
  HAVING countIf(asset_id = ${HOLLAR_ASSET_ID}) = 1 AND countIf(asset_id != ${HOLLAR_ASSET_ID}) = 1
    AND (venue = 'hsm' OR (block_height, hollar_amount) IN (SELECT block_height, hollar_amount FROM arb))
),
valued AS (
  SELECT f.venue AS venue, f.block_height AS block_height, f.event_index AS event_index,
         f.block_time AS block_time, f.swapper AS swapper,
         f.hollar_is_out AS hollar_is_out,
         f.collateral_asset AS collateral_asset,
         f.collateral_amount AS collateral_amount,
         f.collateral_asset IN (${pegs}) AS peg,
         divideDecimal(toDecimal256(f.hollar_amount, 0), toDecimal256('${HOLLAR_UNIT_RAW}', 0), 12) AS hollar_usd,
         divideDecimal(multiplyDecimal(toDecimal256(f.collateral_amount, 0),
                                       if(peg, toDecimal256(1, 12), toDecimal256(p.close, 12)), 12),
                       ${amountUnitSql('f.collateral_asset')}, 12) AS collateral_usd
  FROM fills f
  ASOF LEFT JOIN ${priceSourceSql()} p
    ON p.asset_id = ${priceAliasSql('f.collateral_asset')} AND p.price_time <= f.block_time
  WHERE peg OR p.close > 0
),
priced AS (
  SELECT block_height, event_index, block_time,
         if(venue = 'hsm' AND NOT hollar_is_out, ${attributablePayerSql('swapper')}, '') AS account,
         if(venue = 'hsm', collateral_asset, toUInt32(${HOLLAR_ASSET_ID})) AS asset_id,
         if(venue = 'hsm',
            toString(if(block_height < ${HSM_BUYBACK_FEE_CUT_BLOCK},
                        intDiv(toUInt256OrZero(collateral_amount) * ${feeOld.num}, ${feeOld.den}),
                        intDiv(toUInt256OrZero(collateral_amount) * ${feeNew.num}, ${feeNew.den}))),
            '0') AS amount,
         if(venue = 'hsm',
            if(hollar_is_out, toDecimal256(0, 12),
               multiplyDecimal(collateral_usd,
                               toDecimal256(if(block_height < ${HSM_BUYBACK_FEE_CUT_BLOCK},
                                               '${feeRatioLiteral(feeOld)}',
                                               '${feeRatioLiteral(feeNew)}'), 12), 12)),
            if(hollar_is_out, hollar_usd - collateral_usd, collateral_usd - hollar_usd)) AS usd
  FROM valued
)
SELECT 'hsm_revenue' AS stream,
       block_height AS block_height,
       block_time AS block_timestamp,
       event_index AS event_index,
       toUInt16(0) AS leg_index,
       '' AS dest,
       account AS account,
       asset_id AS asset_id,
       amount AS amount,
       usd AS amount_usd
FROM priced
WHERE usd > 0`
}

/**
 * Network fees — the two arms described in the module header. Both arms carry
 * a positive-amount guard: ~5% of TransactionFeePaid rows are paysFee-No zeros
 * and a zero deposit is nothing.
 */
function networkFeeRowsSql(extra: string): string {
  return `-- rev:network_fee
WITH fee_events AS (
  SELECT block_height, event_index, min(block_timestamp) AS block_time,
         argMax(args_json, ingested_at) AS args
  FROM price_data.raw_events
  WHERE event_name = 'TransactionPayment.TransactionFeePaid'
    AND ${WINDOW}
    AND (${extra})
  GROUP BY block_height, event_index
),
evm_extrinsics AS (
  SELECT block_height, extrinsic_index AS ext_index, call_name AS cname,
         ifNull(signer, '') AS csigner
  FROM price_data.raw_extrinsics FINAL
  WHERE call_name IN ('Ethereum.transact', 'EVM.call', 'Dispatcher.dispatch_evm_call')
    AND ${WINDOW}
    AND (${extra})
),
eth_executed AS (
  SELECT block_height, assumeNotNull(extrinsic_index) AS ext_index,
         argMax(args_json, ingested_at) AS args
  FROM price_data.raw_events
  WHERE event_name = 'Ethereum.Executed' AND extrinsic_index IS NOT NULL
    AND ${WINDOW}
    AND (${extra})
  GROUP BY block_height, ext_index
),
gas_deposits AS (
  SELECT block_height, event_index, assumeNotNull(extrinsic_index) AS ext_index,
         event_name, min(block_timestamp) AS block_time,
         argMax(args_json, ingested_at) AS args
  FROM price_data.raw_events
  WHERE event_name IN ('Tokens.Deposited', 'Balances.Deposit')
    AND extrinsic_index IS NOT NULL
    AND JSONExtractString(args_json, 'who') = '${TREASURY_ACCOUNT}'
    AND ${WINDOW}
    AND (${extra})
  GROUP BY block_height, event_index, ext_index, event_name
),
rows AS (
  SELECT block_height, block_time, event_index, toUInt16(0) AS leg_index, '' AS dest,
         ${attributablePayerSql("JSONExtractString(args, 'who')")} AS account,
         toUInt32(0) AS asset_id,
         JSONExtractString(args, 'actualFee') AS amount
  FROM fee_events
  WHERE JSONExtractString(args, 'actualFee') != '0'
  UNION ALL
  SELECT d.block_height AS block_height, d.block_time AS block_time, d.event_index AS event_index,
         toUInt16(0) AS leg_index, '' AS dest,
         ${attributablePayerSql(`if(x.cname = 'Ethereum.transact',
            if(e.args != '', ${ethMappedAccountSql("JSONExtractString(e.args, 'from')")}, ''),
            x.csigner)`)} AS account,
         if(d.event_name = 'Tokens.Deposited', toUInt32(20), toUInt32(0)) AS asset_id,
         JSONExtractString(d.args, 'amount') AS amount
  FROM gas_deposits d
  INNER JOIN evm_extrinsics x ON x.block_height = d.block_height AND x.ext_index = d.ext_index
  LEFT JOIN eth_executed e ON e.block_height = d.block_height AND e.ext_index = d.ext_index
  WHERE (d.event_name = 'Tokens.Deposited') = (x.cname = 'Ethereum.transact')
    AND (d.event_name != 'Tokens.Deposited' OR JSONExtractInt(d.args, 'currencyId') = 20)
    AND JSONExtractString(d.args, 'amount') != '0'
)
${valuedTailSql('network_fee')}`
}

/**
 * The full SELECT for one eventful stream over the anchored window, in the
 * unified revenue_events row shape. `extraPredicate` reaches EVERY source read
 * (the derivations job injects the month-partition bound and the closed-hour
 * cut through it; readers of the live tail pass nothing).
 */
export function buildRevenueEventRowsSql(stream: EventfulRevenueStream, extraPredicate = '1'): string {
  switch (stream) {
    case 'omnipool_asset_fee':
    case 'omnipool_protocol_fee':
      return omnipoolFeeRowsSql(stream, extraPredicate)
    case 'liquidation_penalty':
      return liquidationPenaltyRowsSql(extraPredicate)
    case 'pepl_liquidation_profit':
      return peplProfitRowsSql(extraPredicate)
    case 'asset_reserve':
      return assetReserveRowsSql(extraPredicate)
    case 'hsm_revenue':
      return hsmRevenueRowsSql(extraPredicate)
    case 'network_fee':
      return networkFeeRowsSql(extraPredicate)
  }
}

// ---------------------------------------------------------------------------
// hollar_borrow — hourly accrual rows (TypeScript, exact index identity)
// ---------------------------------------------------------------------------

export interface HollarHourlyRow {
  /** Epoch seconds of the accrual hour (the hour whose index movement is booked). */
  hour: number
  poolAddress: string
  reserveAddress: string
  /** Interest accrued in HOLLAR planck (18 decimals). */
  amountPlanck: bigint
  /** The same interest in 1e-12 USD, valued at the candle closed by `hour`. */
  usd1e12: bigint
  /**
   * How many hours this row's accrual actually spans — the gap back to the
   * previous index observation for the same pool, at least 1.
   *
   * The view emits a row only for an hour the reserve was touched, so a quiet
   * market's index delta covers every untouched hour before it. The AMOUNT is
   * correct either way (the index carries all of it, which is why booking sums
   * to the closed form), but a consumer reading the amount as a RATE must
   * divide by this or a multi-day lump reads as one hour of interest.
   */
  hoursCovered: number
  /**
   * Scaled debt observed AT `hour`, i.e. after the accrual. Zero means the
   * pool's debt was fully repaid, so there is nothing left accruing and a rate
   * carried forward from this row would be inventing flow.
   */
  debtScaledAfter: bigint
}

/** Per-bucket HOLLAR debt/index — see feesCharts.ts for the view's contract. */
function hollarDebtSql(fromSeconds: number, toSeconds: number): string {
  const ch = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')
  return `-- rev:hollar-debt
SELECT toString(bucket_start) AS bucket, pool_address,
       toString(debt_scaled) AS debt_scaled, toString(variable_borrow_index) AS borrow_index
FROM price_data.money_market_reserve_state_history(
  bucket_seconds = 3600,
  start_time = '${ch(fromSeconds)}',
  end_time = '${ch(toSeconds)}')
WHERE reserve_address = {reserve:String}
ORDER BY pool_address, bucket_start`
}

/** HOLLAR's price per hour, keyed by the hour the candle became usable. */
function hollarPriceSql(): string {
  return `-- rev:hollar-price
SELECT toString(interval_start + INTERVAL 1 HOUR) AS bucket, toString(argMaxMerge(close_state)) AS close
FROM price_data.ohlc_1h
WHERE asset_id = ${HOLLAR_ASSET_ID}
  AND interval_start > {anchor:DateTime} - INTERVAL {hours:UInt32} HOUR - INTERVAL 30 DAY
  AND interval_start <= {anchor:DateTime}
GROUP BY interval_start
ORDER BY interval_start`
}

interface DebtRow { bucket: string; pool_address: string; debt_scaled: string; borrow_index: string }
interface PriceRow { bucket: string; close: string }

function bucketSeconds(chDateTime: string): number {
  return Math.floor(Date.parse(`${chDateTime.trim().replace(' ', 'T')}.000Z`) / 1000)
}

/**
 * Exact hourly HOLLAR interest accrual per pool over (startSeconds,
 * endSeconds]: `prevDebt × Δindex / RAY`, per market, valued at the last
 * candle CLOSED by the accrual hour. The price timeline is resolved once,
 * outside the per-pool loop, so one pool's later hours can never leak a
 * future price into another pool's earlier accrual (the bug feesCharts.ts
 * documents). An empty view result answers with an empty array — the view's
 * "no model" contract — never zeros.
 */
export async function hollarBorrowHourlyRows(
  client: ClickHouseClient,
  startSeconds: number,
  endSeconds: number,
): Promise<HollarHourlyRow[]> {
  const HOUR = 3_600
  const first = Math.ceil(startSeconds / HOUR) * HOUR
  if (endSeconds < first) return []
  const ch = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')

  const debtRes = await client.query({
    // One hour of lead-in so the first hour has a predecessor to difference.
    query: hollarDebtSql(first - HOUR, endSeconds),
    query_params: { reserve: HOLLAR_RESERVE_ADDRESS },
    format: 'JSONEachRow',
    clickhouse_settings: DECIMAL_STRINGS,
  })
  const debtRows = await debtRes.json<DebtRow>()
  if (!debtRows.length) return []

  const priceRes = await client.query({
    query: hollarPriceSql(),
    query_params: {
      anchor: ch(endSeconds),
      hours: Math.max(1, Math.ceil((endSeconds - (first - HOUR)) / HOUR)),
    },
    format: 'JSONEachRow',
    clickhouse_settings: DECIMAL_STRINGS,
  })
  const prices = new Map<number, bigint>()
  for (const row of await priceRes.json<PriceRow>()) prices.set(bucketSeconds(row.bucket), scaledUsd(row.close))

  const priceAtHour = new Map<number, bigint>()
  const sortedPrices = [...prices].sort(([a], [b]) => a - b)
  let priceIndex = 0
  let lastPrice = 0n
  for (let t = first - HOUR; t <= endSeconds; t += HOUR) {
    while (priceIndex < sortedPrices.length && sortedPrices[priceIndex][0] <= t) {
      const p = sortedPrices[priceIndex][1]
      if (p > 0n) lastPrice = p
      priceIndex += 1
    }
    priceAtHour.set(t, lastPrice)
  }

  const HOLLAR_UNIT = 10n ** 18n
  const byPool = new Map<string, DebtRow[]>()
  for (const row of debtRows) {
    const list = byPool.get(row.pool_address)
    if (list) list.push(row)
    else byPool.set(row.pool_address, [row])
  }

  const out: HollarHourlyRow[] = []
  for (const [poolAddress, rows] of byPool) {
    const observed = new Map(rows.map(r => [bucketSeconds(r.bucket), r]))
    let prevDebt: bigint | null = null
    let prevIndex: bigint | null = null
    // The hour of the observation `prevIndex` came from — the far end of the
    // span each accrual covers. Tracked alongside prevIndex rather than per
    // iteration so a delta-only hour (index 0) does not shorten the span to a
    // gap the index was never differenced across.
    let prevIndexHour: number | null = null
    for (let t = first - HOUR; t <= endSeconds; t += HOUR) {
      const row = observed.get(t)
      if (!row) continue
      const debt = BigInt(row.debt_scaled)
      const index = BigInt(row.borrow_index)
      if (prevDebt != null && prevIndex != null && prevIndexHour != null && index > prevIndex && t >= first) {
        const planck = (prevDebt * (index - prevIndex)) / RAY
        const usd = (planck * (priceAtHour.get(t) ?? 0n)) / HOLLAR_UNIT
        if (planck > 0n) {
          out.push({
            hour: t, poolAddress, reserveAddress: HOLLAR_RESERVE_ADDRESS,
            amountPlanck: planck, usd1e12: usd,
            hoursCovered: Math.max(1, Math.round((t - prevIndexHour) / HOUR)),
            debtScaledAfter: debt,
          })
        }
      }
      // An index of 0 is a delta-only hour the view could not carry an index
      // into; keep the previous index rather than differencing to zero.
      prevDebt = debt
      if (index > 0n) {
        prevIndex = index
        prevIndexHour = t
      }
    }
  }
  out.sort((a, b) => a.hour - b.hour || (a.poolAddress < b.poolAddress ? -1 : 1))
  return out
}
