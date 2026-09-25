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
// The stream semantics are the ones api/src/public/services/feesCharts.ts
// serves; the two network-fee extractions are unique to this model and their
// traps are spelled out inline (and pinned by api/tests/revenueStreams.test.ts):
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
import { cached } from './cache.ts'
import { chTimestamp } from './clickhouseTime.ts'
// The Omnipool's hub asset (H2O) — its fee legs are the protocol fee, never an
// asset fee — from the module that owns the Omnipool's own math.
import { HUB_ASSET_ID } from './lpMath.ts'
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
  'ice_matched_fee',
  'uniswap_v3_fee',
  'network_fee',
] as const
export type RevenueStream = (typeof REVENUE_STREAMS)[number]
export type EventfulRevenueStream = Exclude<RevenueStream, 'hollar_borrow'>

/** The revenue_events column list every builder emits, in table order. */
export const REVENUE_EVENT_COLUMNS = [
  'stream', 'block_height', 'block_timestamp', 'event_index', 'leg_index',
  'dest', 'account', 'asset_id', 'amount', 'internal_payer', 'amount_usd',
] as const

/**
 * Which revenue_events rows are PROTOCOL revenue. Both omnipool fees are classified per
 * leg by the destination the runtime reported: 'lp' is a share the pool keeps for the
 * LPs who provided that position's liquidity, 'pol' a share the pool keeps in the
 * protocol-provided HDX position, 'protocol' a share routed out of the pool, 'burned' a
 * share destroyed, and 'unknown' a legacy pre-2025-01-25 asset-fee leg the chain
 * recorded no destination for. Everything but 'lp' and 'unknown' is the protocol's.
 *
 * 'protocol' is revenue CAPTURED, not revenue the treasury keeps, and for the asset fee
 * the two are nearly disjoint. The hub fee's routed-out era (blocks 6,975,219 to
 * 11,394,692) did pay the treasury, but a routed-out ASSET fee never has: it goes to the
 * fee processor, which pays GigaHDX 15%, the GigaHDX rewards accumulator 25%, staking 5%
 * and referrals 5% of the whole asset fee (pallet-fee-processor since block 12,848,067;
 * referrals and staking directly before it). Those are token holders, stakers and
 * referrers, so such a leg is the protocol's only in the sense that the LPs did not get
 * it.
 *
 * The hub-denominated PROTOCOL fee is 'pol' or 'burned' and never 'lp', because the
 * runtime credits every non-burned hub fee to the HDX sub-pool's hub reserve whatever
 * pair was traded. The data holds three regimes of it: fully burned before block
 * 6,975,219 (2025-02-16), then half burned and half routed to the treasury, and since
 * block 11,394,695 (2026-02-16) neither — the whole fee is retained in HDX. The ASSET
 * fee is charged in the traded asset and stays in that asset's position, so it is the
 * protocol's only when it was charged in HDX.
 *
 * Every other stream is protocol revenue in full. account_revenue, the
 * explorer dashboard and the account/tag totals all filter through this exact
 * predicate — the public fees API is the one reader that also serves the
 * lp/burned/unknown legs, through its own destination matrix.
 *
 * `internal_payer` is the second half of the rule and applies to every stream: a
 * fee or an interest charge the protocol paid ITSELF is not revenue, however its
 * destination is classed. See INTERNAL_PAYER_TAGS.
 */
export const PROTOCOL_REVENUE_PREDICATE_SQL
  = "(stream != 'omnipool_asset_fee' OR dest IN ('protocol', 'burned', 'pol')) AND dest != 'lp' AND internal_payer = 0"

/**
 * Tags whose members are the protocol's OWN balance sheet. What they pay the
 * protocol moves between two protocol pockets, so it is neither revenue nor
 * anybody's payer ranking: the rows keep their value and are MARKED
 * (`internal_payer = 1`), so the gross flow stays auditable and the public fees
 * API's destination matrix is untouched, while every protocol-revenue surface
 * filters them out through PROTOCOL_REVENUE_PREDICATE_SQL.
 *
 * Measured all-time when this was introduced: $22,726.66 on the treasury (almost
 * all of it HOLLAR borrow interest on its own debt) and $166.06 on the multisig.
 * Every pot tag below was already $0 — pallet accounts blank to the unattributed
 * bucket through attributablePayerSql long before they reach here — and they are
 * listed anyway, so a future attribution that starts naming them cannot quietly
 * book the protocol as its own customer.
 *
 * Three deliberate exclusions:
 *  * `hollar-stability-module` EARNS hsm_revenue (booked with account = '', the
 *    HSM being the source and never the payer). The account that generates a
 *    stream must not appear on a list of accounts whose payments are erased.
 *  * pools, liquidity mining and the money-market contracts are infrastructure
 *    USERS trade through — a fee attributed to a pool account is a user's fee
 *    that lost its payer, and erasing it would delete real revenue.
 *  * `polkadot-treasury`, `moonbeam-treasury`, `kraken`, `polkadot-fellowship`,
 *    `bil-originator` are other parties' money ($77.8k attributed all-time).
 *    Another chain's treasury trading here IS a customer.
 */
export const INTERNAL_PAYER_TAGS = [
  'treasury', 'hydration-multisig', 'pallet-pots', 'staking-pot', 'incentive-pot',
  'gigahdx-pots', 'fee-processor', 'fee-referrals', 'fee-staking-rewards',
] as const

/**
 * Every account id an internal payer can appear under, in both forms: the
 * substrate pubkey the tag holds, and the ETH-mapped form the money-market and
 * liquidation surfaces name it by (`0x45544800` + first 20 bytes + zero padding).
 * The treasury pays as the latter, so a join on the substrate id alone reports
 * zero — which is exactly how this went unnoticed.
 *
 * FINAL because account_tags replaces on (label_id, account_id) and carries a
 * `deleted` flag; the label predicate keeps the key prefix bounded.
 */
export function internalPayerAccountsSql(): string {
  const tags = INTERNAL_PAYER_TAGS.map(t => `'${t}'`).join(', ')
  const members = `FROM price_data.account_tags FINAL WHERE deleted = 0 AND label_id IN (${tags})`
  return `SELECT acct FROM (
    SELECT account_id AS acct ${members}
    UNION ALL
    SELECT concat('0x45544800', substring(account_id, 3, 40), repeat('0', 16)) AS acct
    ${members} AND length(account_id) = 66
  )`
}

/** `internal_payer` for a row whose payer is `expr` (a 32-byte substrate account). */
export function internalPayerFlagSql(expr: string): string {
  return `toUInt8(${expr} IN (${internalPayerAccountsSql()}))`
}

/**
 * The internal payer accounts as a TS set, in both id forms — for the two
 * reserve-level streams, whose share is computed from per-account weights in the
 * derivation rather than marked on a row. Read once per process and held: tag
 * membership is seeded from code and changes only on a deploy, and a stale read
 * here would silently re-admit a payer the predicate excludes.
 */
let internalPayerAccountsCache: Promise<ReadonlySet<string>> | null = null
export async function loadInternalPayerAccounts(client: ClickHouseClient): Promise<ReadonlySet<string>> {
  internalPayerAccountsCache ??= (async () => {
    const res = await client.query({ query: `SELECT acct FROM (${internalPayerAccountsSql()})`, format: 'JSONEachRow' })
    return new Set((await res.json<{ acct: string }>()).map(r => r.acct.toLowerCase()))
  })()
  return internalPayerAccountsCache
}

/** Test seam — drops the cached set so a following load re-reads the tags. */
export function resetInternalPayerAccounts(): void { internalPayerAccountsCache = null }

/**
 * The internal payers as H160s — the first 20 bytes of the tagged account id,
 * which is how the aToken/variable-debt tables name a holder. Every EVM-side
 * surface keys on this form.
 */
export function internalPayerH160sSql(): string {
  const tags = INTERNAL_PAYER_TAGS.map(t => `'${t}'`).join(', ')
  return `SELECT DISTINCT lower(substring(account_id, 1, 42)) AS h160
    FROM price_data.account_tags FINAL
    WHERE deleted = 0 AND label_id IN (${tags}) AND length(account_id) = 66`
}

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
 * The same pallet account seen through the runtime's ETH mapping: a pallet
 * acting over the EVM is recorded as its truncated H160 wrapped back into the
 * `0x45544800` + H160 + zero-padding substrate form, which buries the `modl…`
 * marker eight hex digits in. A surface that attributes ETH-mapped accounts
 * (the money-market payers, the liquidation-profit stream) sees this shape and
 * not the native one.
 */
const MODL_ETH_MAPPED_PREFIX = '0x455448006d6f646c'

/**
 * A payer only when it is an actual USER. The protocol's own actors — pallet
 * accounts (`modl…`: treasury buyback/fee-conversion swaps, the liquidation
 * pallet selling seized collateral, referral/OTC-settlement bots), in either
 * the native or the ETH-mapped account form, and the runtime EVM executor —
 * pay their fees with protocol money, so attributing that to them would list
 * the protocol among its own customers (measured: ~1% of attributed revenue).
 * Their rows keep their VALUE (dashboard totals and conservation are
 * untouched); only the payer blanks to the explicit unattributed bucket,
 * exactly like the placeholder swapper. Sibling/para sovereign accounts stay
 * attributed: another chain trading here IS a user.
 *
 * `expr` is an account in the 32-byte substrate form — apply it to the mapped
 * account (`ethMappedAccountSql`) where the source names an H160.
 */
export function attributablePayerSql(expr: string): string {
  return `if(startsWith(${expr}, '${MODL_ACCOUNT_PREFIX}') OR startsWith(${expr}, '${MODL_ETH_MAPPED_PREFIX}')
             OR ${expr} IN ('${PLACEHOLDER_SWAPPER}', '${HSM_EXECUTOR_ACCOUNTS[0]}'), '', ${expr})`
}

/** The Aave collector — see the feesCharts.ts note; the liquidation cut and MintedToTreasury land here. */
export const AAVE_COLLECTOR = '0xe52567ff06acd6cbe7ba94dc777a3126e180b6d9'

/**
 * The ICE solver's two pallet accounts (`modlice_ice#` / `modlice_fee#`, pubkey
 * hex). Every matched intent settles through the pot; the matched-volume
 * protocol fee is swept from it to the fee account at the end of each solution.
 */
export const ICE_POT_ACCOUNT = '0x6d6f646c6963655f696365230000000000000000000000000000000000000000'
// The Treasury's EVM address: the first 20 bytes of `modlpy/trsry…` — where a Gamma vault
// sends its fee share and where a pool's CollectProtocol would land.
export const TREASURY_H160 = '0x6d6f646c70792f74727372790000000000000000'
export const ICE_FEE_ACCOUNT = '0x6d6f646c6963655f666565230000000000000000000000000000000000000000'


/**
 * The one Omnipool position whose liquidity is protocol-provided, so fees retained in
 * it are the protocol's rather than the LPs'. Measured ~97-99% protocol-owned; treated
 * as wholly so, which is the standing convention for HDX. It is the position the hub
 * protocol fee always lands in, and the only asset whose own asset fee is protocol
 * revenue.
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
export function ethMappedAccountSql(h160Expr: string): string {
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
 *
 * The valuation uses the plain decimal OPERATORS for the reason spelled out at
 * `pricedCteSql` in services/valuation.ts: `Decimal256(0) × Decimal256(12)` is an
 * exact `Decimal256(12)` by scale addition and dividing it by a `Decimal256(0)`
 * keeps that scale and truncates toward zero, so the arithmetic is identical to
 * `divideDecimal(multiplyDecimal(…, 12), …, 12)` while being vectorised instead
 * of per-row. These rows are PERSISTED (`revenue_events`), so the equality was
 * re-proved on this site's own data before the change: 3.33 M rows over seven
 * windows from 2022-12 to the live head, 0 mismatches, identical sums, identical
 * `sum(cityHash64(toString(…)))` and identical `Decimal(76,12)` type. Rows
 * written before and after the change therefore agree to the last digit.
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
       ${internalPayerFlagSql('r.account')} AS internal_payer,
       if(p.close > 0,
          toDecimal256(r.amount, 0) * toDecimal256(p.close, 12) / ${amountUnitSql('r.asset_id')},
          toDecimal256(0, 12)) AS amount_usd
FROM rows r
ASOF LEFT JOIN ${priceSourceSql()} p
  ON p.asset_id = ${priceAliasSql('r.asset_id')} AND p.price_time <= r.block_time`
}

// ---------------------------------------------------------------------------
// Per-stream builders
// ---------------------------------------------------------------------------

/**
 * The owner behind the ICE pot's swaps, per solution extrinsic. The pot pays the pool
 * fees of the routes it runs for the intents it settles, so the payer of those fees
 * is the intent OWNER — exactly one when the solution settled one owner's intents
 * (every solution so far); several owners' fills in one solution cannot split its
 * routes between them and blank to the unattributed bucket, as a pallet payer does.
 * The four events are the ones that settle an intent (the last trade of a DCA is
 * DcaCompleted alone); the owner comes from the order they name.
 */
function iceSolutionOwnerSql(extra: string): string {
  return `SELECT e.block_height AS block_height, e.extrinsic_index AS extrinsic_index,
         if(uniqExact(o.owner) = 1, any(o.owner), '') AS owner
  FROM (
    SELECT intent_id, block_height, assumeNotNull(ie.extrinsic_index) AS extrinsic_index
    FROM price_data.intent_events AS ie FINAL
    WHERE event_name IN ('Intent.IntentResolved', 'Intent.IntentResovedPartially', 'Intent.DcaTradeExecuted', 'Intent.DcaCompleted')
      AND ie.extrinsic_index IS NOT NULL AND ${WINDOW} AND (${extra})
  ) AS e
  INNER JOIN (SELECT intent_id, owner FROM price_data.intent_orders FINAL) AS o ON o.intent_id = e.intent_id
  GROUP BY block_height, extrinsic_index`
}

function omnipoolFeeRowsSql(stream: 'omnipool_asset_fee' | 'omnipool_protocol_fee', extra: string): string {
  const hub = stream === 'omnipool_protocol_fee' ? `asset_id = ${HUB_ASSET_ID}` : `asset_id != ${HUB_ASSET_ID}`
  // FINAL rather than GROUP BY + argMax: the table's ORDER BY is the leg
  // identity, so FINAL is the same deduplication in sorted-merge form (the
  // measured feesCharts choice), and it leaves the source columns readable in
  // WHERE — an argMax alias named like its column would shadow the WHERE
  // reference and ClickHouse rejects the aggregate there.
  // Whose money a leg the pool KEEPS is. The hub protocol fee is credited to the HDX
  // sub-pool's hub reserve whatever pair was traded (the runtime's
  // process_protocol_fee), and HDX's Omnipool liquidity is protocol-provided, so every
  // retained hub leg is the protocol's. An asset fee is charged in the traded asset and
  // stays in that asset's position, so only a fee charged in HDX is the protocol's and
  // the rest belongs to that position's LPs.
  const retained = stream === 'omnipool_protocol_fee'
    ? `'pol'`
    : `if(f.asset_id = ${POL_ASSET_ID}, 'pol', 'lp')`
  return `-- rev:${stream}
WITH rows AS (
  SELECT f.block_height AS block_height, f.event_index AS event_index, f.leg_index AS leg_index,
         f.block_timestamp AS block_time,
         multiIf(f.fee_dest = 'burned', 'burned',
                 f.fee_recipient = '${OMNIPOOL_ACCOUNT}', ${retained},
                 f.fee_recipient != '', 'protocol',
                 'unknown') AS dest,
         if(f.swapper = '${ICE_POT_ACCOUNT}' AND i.owner != '', i.owner, ${attributablePayerSql('f.swapper')}) AS account,
         f.asset_id AS asset_id, f.amount AS amount
  FROM price_data.pool_swap_legs AS f FINAL
  LEFT JOIN (${iceSolutionOwnerSql(extra)}) AS i ON i.block_height = f.block_height AND i.extrinsic_index = f.extrinsic_index
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
    SELECT lower(r.atoken) AS atoken, any(r.asset_address) AS asset_address
    FROM price_data.atoken_reserve_map AS r GROUP BY atoken
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
         -- Stays on divideDecimal: both operands are Decimal256(0), and the plain
         -- operator takes the DIVIDEND's scale, so \`a / b\` would answer at scale 0
         -- and throw away every cent. Only the collateral leg below has a scale-12
         -- dividend and can drop the adaptive-scale call.
         divideDecimal(toDecimal256(f.hollar_amount, 0), toDecimal256('${HOLLAR_UNIT_RAW}', 0), 12) AS hollar_usd,
         toDecimal256(f.collateral_amount, 0) * if(peg, toDecimal256(1, 12), toDecimal256(p.close, 12))
           / ${amountUnitSql('f.collateral_asset')} AS collateral_usd
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
         -- Stays on multiplyDecimal: both factors are already scale 12, so the
         -- plain operator would answer at scale 24 by scale addition — a different
         -- type in the sibling branches of this \`if\`, which ClickHouse refuses,
         -- and twelve more digits than the column the value lands in.
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
       ${internalPayerFlagSql('account')} AS internal_payer,
       usd AS amount_usd
FROM priced
WHERE usd > 0`
}

/**
 * The ICE matched-volume protocol fee. At the end of every `ICE.submit_solution`
 * the runtime sweeps the fee (200 ppm of the intent-to-intent matched volume)
 * from the settlement pot to the fee account as an ordinary Currencies.transfer,
 * so that one `Currencies.Transferred` from pot to fee account IS the stream.
 * The runtime emits a paired `Tokens.Transfer` / `Balances.Transfer` for the
 * same movement; reading either beside it would book the fee twice. The payer
 * is the matched set, not one account, so rows carry no payer and no
 * destination class — protocol revenue in full, like asset_reserve. The amount
 * is a u128 that serialises as a number or a string depending on magnitude,
 * hence the raw-then-unquote read. The zero guard mirrors network_fee's: a
 * solution with no matched volume sweeps nothing.
 */
function iceMatchedFeeRowsSql(extra: string): string {
  return `-- rev:ice_matched_fee
WITH sweeps AS (
  SELECT block_height, event_index, min(block_timestamp) AS block_time,
         argMax(toUInt32(JSONExtractUInt(args_json, 'currencyId')), ingested_at) AS asset_id,
         argMax(toUInt256OrZero(replaceAll(JSONExtractRaw(args_json, 'amount'), '"', '')), ingested_at) AS amount
  FROM price_data.raw_events
  WHERE event_name = 'Currencies.Transferred'
    AND ${WINDOW}
    AND (${extra})
    AND JSONExtractString(args_json, 'from') = '${ICE_POT_ACCOUNT}'
    AND JSONExtractString(args_json, 'to') = '${ICE_FEE_ACCOUNT}'
  GROUP BY block_height, event_index
),
rows AS (
  SELECT block_height, block_time, event_index, toUInt16(0) AS leg_index, '' AS dest, '' AS account,
         asset_id, amount
  FROM sweeps
  WHERE amount > 0
)
${valuedTailSql('ice_matched_fee')}`
}

/**
 * Concentrated-liquidity (Uniswap v3) pool fees the protocol keeps. Two arms:
 *   * the Gamma vault's cut — Hypervisor `_zeroBurn`/`rebalance` send
 *     `fees / fee` (SetFee(255) → 1/255) of the LP fees its positions earned to
 *     `feeRecipient`, which the operator's rebalance calls set to the Treasury's
 *     EVM address — one ERC-20 `Transfer` per token from a vault the
 *     uniswap_v3_vaults projection knows. Realized on arrival, `dest = ''`;
 *   * the pool's protocol fee, booked WHERE IT ACCRUES rather than where it is
 *     swept, under `dest = 'accrued'`.
 *
 * Why accrual. `setFeeProtocol` (referendum 403, block 14,413,914) gives the
 * protocol a quarter of every swap fee on the aDOT/HOLLAR pool. It accumulates
 * inside the pool and `collectProtocol` is `onlyFactoryOwner` — the factory owner
 * is the runtime's AaveManagerAccount, reachable only through root or the
 * EconomicParameters track — so a sweep is a governance act that may never come.
 * Booking the sweep meant the stream reported the Gamma cut alone: $0.62 against
 * 24.37 aDOT + 27.74 HOLLAR (~$53.7) the protocol had already earned, about 1 %.
 * The claim exists the moment the swap happens, so that is when it is revenue —
 * the same rule hollar_borrow follows, where interest is revenue as it accrues and
 * not when a loan is repaid.
 *
 * Which makes `CollectProtocol` NOT revenue: it moves a balance this stream has
 * already recognised, so booking it too would count the same fee twice. Nothing
 * has to be unwound — the pool has never been collected.
 *
 * The accrued amount is the swap's own fee leg times the protocol's share. That
 * fee is already derived once, per swap and per payer, by the uniswap_v3_legs job
 * (`pool_swap_legs`, venue 'uniswapv3', leg_kind 'fee') — its total matched this
 * arithmetic to the unit over every swap since the rate was set — so this reads it
 * rather than recomputing the tier against the raw Swap amounts, and gets the
 * resolved swapper with it. That payer is what lets account_revenue attribute the
 * accrual through its ordinary path instead of spreading a realization no one made.
 *
 * Verified against the pool's own `protocolFees()` at 2026-09-15 14:51:42 — HOLLAR
 * matched to the last digit (13.838021420143113665) and aDOT to 98 planck in
 * 147,668,543,177 (6.6e-10), which is the per-step truncation whole-swap arithmetic
 * cannot see: the pool divides once per tick crossed, and a sum of floors is never
 * above the floor of the sum, so the residual is one-directional and ~1e-9 relative.
 *
 * Swap fees themselves stay with the LPs and are not revenue. The token is an EVM
 * contract: an asset precompile decodes to its id, a deployed ERC-20 (aDOT, HOLLAR)
 * resolves through the registry's `assets.evm_address`; a token neither knows is
 * dropped rather than booked as asset 0 (HDX). No payer: the swapper paid it.
 */
function uniswapV3FeeRowsSql(extra: string): string {
  const token = 'lower(f.token)'
  const hex = `replaceRegexpOne(${token}, '^0x', '')`
  const precompile = `if(length(${hex}) = 40 AND substring(${hex}, 1, 32) = '00000000000000000000000000000001', toUInt32(reinterpretAsUInt32(reverse(unhex(substring(${hex}, 33, 8))))), toUInt32(4294967295))`
  // One ordering key per event so the feeProtocol in force at a swap is an ASOF
  // match on a single column. A block/index pair would need a composite ASOF key,
  // which ClickHouse has no form for, and matching on block alone would apply a
  // rate to swaps that ran before it in the same block.
  const atKey = (alias: string) => `toUInt64(${alias}.block_height) * 100000 + ${alias}.event_index`
  return `-- rev:uniswap_v3_fee
WITH token_assets AS (
  SELECT lower(evm_address) AS addr, any(asset_id) AS asset_id
  FROM price_data.assets WHERE evm_address != '' GROUP BY addr
),
pools AS (
  SELECT pool_address, any(token0) AS token0, any(token1) AS token1, any(fee) AS fee
  FROM price_data.uniswap_v3_pools GROUP BY pool_address
),
vault_fees AS (
  SELECT block_height, event_index, min(block_timestamp) AS block_time,
         argMax(lower(contract_address), ingested_at) AS token,
         argMax(toUInt256OrZero(JSONExtractString(decoded_args_json, 'value')), ingested_at) AS amount
  FROM price_data.raw_evm_logs
  WHERE event_name = 'Transfer'
    AND ${WINDOW}
    AND (${extra})
    AND lower(JSONExtractString(decoded_args_json, 'to')) = '${TREASURY_H160}'
    AND lower(JSONExtractString(decoded_args_json, 'from')) IN (SELECT vault_address FROM price_data.uniswap_v3_vaults FINAL)
  GROUP BY block_height, event_index
),
-- Deliberately NOT windowed: the rate in force at a swap was usually set long
-- before the window the job is recomputing.
fee_protocol AS (
  SELECT lower(contract_address) AS pool, ${atKey('e')} AS at_key,
         toUInt256(aux0) AS fp0, toUInt256(aux1) AS fp1
  FROM price_data.uniswap_v3_events AS e FINAL
  WHERE kind = 'pool' AND event_name = 'SetFeeProtocol'
),
-- The swap's own fee leg: one row per swap, already in the fee asset and already
-- carrying the payer the leg builder resolved.
swap_fees AS (
  SELECT lower(l.pool_key) AS pool, l.block_height AS block_height, l.event_index AS event_index,
         min(l.block_timestamp) AS block_time,
         ${atKey('l')} AS at_key,
         any(l.asset_id) AS fee_asset_id,
         any(l.swapper) AS swapper,
         any(toUInt256OrZero(l.amount)) AS gross_fee
  FROM price_data.pool_swap_legs AS l
  WHERE l.venue = 'uniswapv3' AND l.leg_kind = 'fee'
    AND ${WINDOW}
    AND (${extra})
  GROUP BY pool, l.block_height, l.event_index
),
-- Which of the pool's two tokens the fee was charged in. The pool keeps a separate
-- share per token, so the rate that applies is that side's.
sided_fees AS (
  SELECT f.pool AS pool, f.block_height AS block_height, f.event_index AS event_index,
         f.block_time AS block_time, f.at_key AS at_key, f.fee_asset_id AS fee_asset_id,
         f.swapper AS swapper, f.gross_fee AS gross_fee,
         toUInt8(if(t1.asset_id = f.fee_asset_id, 1, 0)) AS side
  FROM swap_fees AS f
  INNER JOIN pools AS p ON p.pool_address = f.pool
  LEFT JOIN token_assets AS t1 ON t1.addr = lower(p.token1)
),
accrued_fees AS (
  SELECT f.block_height AS block_height, f.event_index AS event_index, f.block_time AS block_time,
         f.fee_asset_id AS fee_asset_id, f.swapper AS swapper,
         intDiv(f.gross_fee, fp.fp) AS amount
  FROM sided_fees AS f
  ASOF INNER JOIN (
    SELECT pool, at_key, toUInt8(0) AS side, fp0 AS fp FROM fee_protocol
    UNION ALL
    SELECT pool, at_key, toUInt8(1) AS side, fp1 AS fp FROM fee_protocol
  ) AS fp ON fp.pool = f.pool AND fp.side = f.side AND fp.at_key <= f.at_key
  WHERE fp.fp > 0
),
fees AS (
  SELECT block_height, event_index, block_time, toUInt16(0) AS leg_index, '' AS dest, '' AS account,
         toUInt32(0) AS fee_asset_id, token, amount FROM vault_fees
  UNION ALL
  SELECT block_height, event_index, block_time, toUInt16(0) AS leg_index, 'accrued' AS dest, swapper AS account,
         fee_asset_id, '' AS token, amount FROM accrued_fees
),
rows AS (
  SELECT f.block_height AS block_height, f.block_time AS block_time, f.event_index AS event_index, f.leg_index AS leg_index,
         f.dest AS dest, f.account AS account,
         if(f.fee_asset_id > 0, f.fee_asset_id, if(t.asset_id > 0, toUInt32(t.asset_id), ${precompile})) AS asset_id,
         f.amount AS amount
  FROM fees f
  LEFT JOIN token_assets t ON t.addr = ${token}
  WHERE f.amount > 0 AND asset_id != 4294967295
)
${valuedTailSql('uniswap_v3_fee')}`
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
    case 'ice_matched_fee':
      return iceMatchedFeeRowsSql(extraPredicate)
    case 'uniswap_v3_fee':
      return uniswapV3FeeRowsSql(extraPredicate)
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
  /** Interest accrued in HOLLAR planck (18 decimals) — the WHOLE market's. */
  amountPlanck: bigint
  /** The same interest in 1e-12 USD, valued at the candle closed by `hour`. */
  usd1e12: bigint
  /**
   * The part of `amountPlanck` that internal payers owed — the protocol's own
   * accounts paying interest to the protocol, which is not revenue. Carved from
   * the same index move by the same identity, so external = amount − internal
   * exactly. Callers that want the MARKET's interest (the fees charts, the drip
   * rate) read the gross fields and ignore these; the revenue books the
   * difference. Clamped to the gross amount: see the internal debt series.
   */
  internalPlanck: bigint
  /** `internalPlanck` in 1e-12 USD, at the same candle as `usd1e12`. */
  internalUsd1e12: bigint
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

/**
 * Per-bucket HOLLAR debt/index.
 *
 * `end_time` reaches to the LAST SECOND of `toSeconds`' hour, not to its start.
 * The view bounds the underlying EVENTS by `block_timestamp <= end_time` and
 * buckets them afterwards, so asking with an hour-aligned end_time returns no
 * bucket for that hour at all unless an event happened to land exactly on the
 * second — the final hour of every window silently absent rather than partial.
 * On the derivations job's month partitions that dropped each month's 23:00
 * accrual: 666.21 HOLLAR over six month-ends, 2025-09 … 2026-07. Callers still
 * filter what they EMIT to `toSeconds`, so widening the read only completes the
 * last bucket; it never books an hour past the window.
 *
 * An EMPTY result is not zero: the view's contract (clickhouse/schema/
 * 007_money_market_history.sql) is that it returns nothing at all when the aToken
 * anchor has not been snapshotted. Callers answer with an empty series, never a
 * zeroed one.
 */
function hollarDebtSql(fromSeconds: number, toSeconds: number): string {
  const ch = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')
  return `-- rev:hollar-debt
SELECT toString(bucket_start) AS bucket, pool_address,
       toString(debt_scaled) AS debt_scaled, toString(variable_borrow_index) AS borrow_index
FROM price_data.money_market_reserve_state_history(
  bucket_seconds = 3600,
  start_time = '${ch(fromSeconds)}',
  end_time = '${ch(toSeconds + 3_599)}')
WHERE reserve_address = {reserve:String}
ORDER BY pool_address, bucket_start`
}

/**
 * Each pool's last observation STRICTLY BEFORE the window — the state the
 * window's first accrual is differenced against.
 *
 * This exists because the view is SPARSE: it emits a row only for an hour the
 * reserve was actually touched, so the observation preceding a window boundary
 * sits 3 to 30 hours back in the measured history, and unboundedly far for a
 * quiet market. A fixed lead-in therefore cannot be right — the one-hour lead-in
 * this replaced silently dropped the first accrual of every window, which on the
 * derivations job's month partitions meant one lost segment per pool per month
 * (13 of them, 2,398.90 HOLLAR / ~$2,394, 2025-09 … 2026-09-17).
 *
 * `start_time` is unbounded rather than guessed, and that is free: the view
 * computes a running total from the aToken anchor over everything up to
 * `end_time` and only applies `start_time` as a final filter, so narrowing it
 * saves no work at all (measured flat: 0.50 s for a 1-day span, 0.45 s for 90).
 * Aggregating here rather than shipping the history keeps the transfer at one
 * row per pool however far back the predecessor lies.
 *
 * `debt_scaled` is taken from the last observation outright, the index from the
 * last observation that CARRIED one: an index of 0 marks a delta-only hour the
 * view could not carry an index into, and differencing against it would book the
 * entire index as one hour's interest.
 */
function hollarSeedSql(beforeSeconds: number): string {
  const ch = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')
  return `-- rev:hollar-seed
SELECT pool_address,
       toString(argMax(debt_scaled, bucket_start)) AS debt_scaled,
       toString(argMaxIf(variable_borrow_index, bucket_start, variable_borrow_index > 0)) AS borrow_index,
       toString(maxIf(bucket_start, variable_borrow_index > 0)) AS index_bucket
FROM price_data.money_market_reserve_state_history(
  bucket_seconds = 3600,
  start_time = '1970-01-01 00:00:00',
  end_time = '${ch(beforeSeconds)}')
WHERE reserve_address = {reserve:String}
GROUP BY pool_address`
}

/**
 * The internal payers' own scaled debt on a reserve, as a RUNNING TOTAL per pool
 * at every hour it changed, up to `end`.
 *
 * This is the reserve series restricted to the protocol's own accounts, so that
 * `internal_scaled × Δindex` carves their interest out of the market's accrual by
 * the same identity rather than by a ratio averaged over a month. Published
 * cumulatively (not as deltas) so a consumer can sample any hour by taking the
 * newest row at or below it.
 *
 * Read from the holder-keyed delta table plus the B0 anchor — the same two
 * sources the balance reconstruction uses — and cheap despite covering all
 * history, because `holder IN (…)` is this table's sort-key prefix and the
 * internal set is a couple of dozen accounts.
 *
 * Not restated on purpose: revenue rows computed before the 2026-09-25 half-up
 * rebuild of atoken_scaled_deltas read these inputs — and the seed above — off by
 * at most 1 scaled unit per changed delta row, i.e. ≤ 1 × Δindex / RAY per row
 * per hour (~1e-18 HOLLAR/hour). The same day's re-capture of the B0 anchor from
 * scaledBalanceOf/scaledTotalSupply moved changed anchor rows by ~6e-9 relative,
 * which shifts the hourly interest by that same relative amount. Both are far
 * below any displayed precision, so persisted rows are left as they are.
 */
function hollarInternalDebtSql(endSeconds: number): string {
  const ch = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')
  return `-- rev:hollar-internal-debt
WITH vdebts AS (
  SELECT DISTINCT lower(vdebt) AS contract, lower(pool_proxy) AS pool
  FROM price_data.atoken_reserve_map FINAL
  WHERE vdebt != '' AND lower(asset_address) = {reserve:String}
),
b0 AS (SELECT max(anchor_block) AS b FROM price_data.atoken_scaled_anchor),
holders AS (${internalPayerH160sSql()}),
observations AS (
  SELECT pool, bucket, sum(delta) AS delta FROM (
    SELECT v.pool AS pool, toStartOfHour(d.block_timestamp) AS bucket, toInt256(sum(d.scaled_delta)) AS delta
    FROM price_data.atoken_scaled_deltas AS d FINAL
    INNER JOIN vdebts AS v ON v.contract = d.contract_address
    WHERE d.holder IN (SELECT h160 FROM holders)
      AND d.block_height > (SELECT b FROM b0)
      AND d.block_timestamp <= '${ch(endSeconds)}'
    GROUP BY pool, bucket
    UNION ALL
    -- The anchor is the opening balance, before every delta the window can see.
    SELECT v.pool AS pool, toDateTime(0) AS bucket, toInt256(sum(a.scaled_balance)) AS delta
    FROM price_data.atoken_scaled_anchor AS a FINAL
    INNER JOIN vdebts AS v ON v.contract = lower(a.contract_address)
    WHERE lower(a.holder) IN (SELECT h160 FROM holders)
    GROUP BY pool
  )
  GROUP BY pool, bucket
)
SELECT pool AS pool_address, toString(bucket) AS bucket,
       toString(sum(delta) OVER (PARTITION BY pool ORDER BY bucket ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS scaled
FROM observations
ORDER BY pool_address, bucket`
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
interface SeedRow { pool_address: string; debt_scaled: string; borrow_index: string; index_bucket: string }
interface PriceRow { bucket: string; close: string }

function bucketSeconds(chDateTime: string): number {
  return Math.floor(Date.parse(`${chDateTime.trim().replace(' ', 'T')}.000Z`) / 1000)
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b)

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
    query: hollarDebtSql(first, endSeconds),
    query_params: { reserve: HOLLAR_RESERVE_ADDRESS },
    format: 'JSONEachRow',
    clickhouse_settings: DECIMAL_STRINGS,
  })
  const debtRows = await debtRes.json<DebtRow>()
  if (!debtRows.length) return []

  // Only once there is something to book: each pool's state as of the last
  // observation before the window, so the first one inside it differences
  // against real state rather than against nothing. See hollarSeedSql.
  const seedRes = await client.query({
    query: hollarSeedSql(first - 1),
    query_params: { reserve: HOLLAR_RESERVE_ADDRESS },
    format: 'JSONEachRow',
    clickhouse_settings: DECIMAL_STRINGS,
  })
  const seeds = new Map<string, SeedRow>()
  for (const row of await seedRes.json<SeedRow>()) seeds.set(row.pool_address, row)

  // The protocol's own scaled debt on this reserve, over all history up to the
  // window's end: one step function per pool, sampled at the same observation
  // each accrual is differenced from.
  const internalRes = await client.query({
    query: hollarInternalDebtSql(endSeconds),
    query_params: { reserve: HOLLAR_RESERVE_ADDRESS },
    format: 'JSONEachRow',
    clickhouse_settings: DECIMAL_STRINGS,
  })
  const internalByPool = new Map<string, { t: number; scaled: bigint }[]>()
  for (const row of await internalRes.json<{ pool_address: string; bucket: string; scaled: string }>()) {
    const list = internalByPool.get(row.pool_address) ?? []
    list.push({ t: bucketSeconds(row.bucket), scaled: BigInt(row.scaled) })
    internalByPool.set(row.pool_address, list)
  }
  for (const list of internalByPool.values()) list.sort((a, b) => a.t - b.t)
  const internalDebtAt = (pool: string, at: number): bigint => {
    const list = internalByPool.get(pool)
    if (!list?.length) return 0n
    let value = 0n
    for (const point of list) {
      if (point.t > at) break
      value = point.scaled
    }
    return value > 0n ? value : 0n
  }

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
  for (let t = first; t <= endSeconds; t += HOUR) {
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
    // Walk the observations themselves, in time order. Stepping hour by hour
    // would be identical (every hour without a row is skipped) but would cost a
    // tick per hour back to the seed, which is unbounded.
    const observed = rows
      .map(r => ({ t: bucketSeconds(r.bucket), row: r }))
      .sort((a, b) => a.t - b.t)
    const seed = seeds.get(poolAddress)
    const seedIndex = seed ? BigInt(seed.borrow_index) : 0n
    let prevDebt: bigint | null = seed ? BigInt(seed.debt_scaled) : null
    let prevIndex: bigint | null = seedIndex > 0n ? seedIndex : null
    // The hour of the observation `prevIndex` came from — the far end of the
    // span each accrual covers. Tracked alongside prevIndex rather than per
    // iteration so a delta-only hour (index 0) does not shorten the span to a
    // gap the index was never differenced across.
    let prevIndexHour: number | null = seedIndex > 0n ? bucketSeconds(seed!.index_bucket) : null
    // The hour prevDebt was observed at — where the internal series is sampled,
    // so both halves of the accrual describe the same moment's debt.
    let prevObsHour: number | null = seed ? first - HOUR : null
    for (const { t, row } of observed) {
      if (t < first || t > endSeconds) continue
      const debt = BigInt(row.debt_scaled)
      const index = BigInt(row.borrow_index)
      if (prevDebt != null && prevIndex != null && prevIndexHour != null && index > prevIndex) {
        const planck = (prevDebt * (index - prevIndex)) / RAY
        const usd = (planck * (priceAtHour.get(t) ?? 0n)) / HOLLAR_UNIT
        // Same index move, internal holders' debt: their part of this accrual.
        // Clamped at the gross amount — a reconstruction gap must not book a
        // negative external amount.
        const internalDebt = internalDebtAt(poolAddress, prevObsHour ?? t)
        const internalPlanck = planck > 0n
          ? min(planck, (internalDebt * (index - prevIndex)) / RAY)
          : 0n
        if (planck > 0n) {
          out.push({
            hour: t, poolAddress, reserveAddress: HOLLAR_RESERVE_ADDRESS,
            amountPlanck: planck, usd1e12: usd,
            internalPlanck,
            internalUsd1e12: (internalPlanck * (priceAtHour.get(t) ?? 0n)) / HOLLAR_UNIT,
            hoursCovered: Math.max(1, Math.round((t - prevIndexHour) / HOUR)),
            debtScaledAfter: debt,
          })
        }
      }
      prevObsHour = t
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

// ---------------------------------------------------------------------------
// Protocol revenue totals — cold table + raw tail, the one composition
// ---------------------------------------------------------------------------
//
// The explorer's /revenue dashboard and the public /v1/stats/platform headline
// state the SAME protocol revenue totals, so the composition lives here once:
//
//   cold — revenue_events, capped at each stream's own high-water mark;
//   tail — the same builders over raw for everything past that mark.
//
// The marks are read ONCE and threaded into both arms as literals, so a
// REPLACE PARTITION landing between the two reads cannot make them overlap on
// an hour or straddle a gap. hollar_borrow accrues per hour and has no eventful
// raw form: its figures end at the last booked hour (up to ~2h behind now).

const EVENTFUL_STREAMS: readonly EventfulRevenueStream[]
  = REVENUE_STREAMS.filter((s): s is EventfulRevenueStream => s !== 'hollar_borrow')

/**
 * The TS twin of PROTOCOL_REVENUE_PREDICATE_SQL, for the raw tail — kept in step
 * by tests/protocolRevenueTwin.test.ts, which evaluates both over every combination.
 */
export function isProtocolRevenue(stream: string, dest: string, internalPayer = 0): boolean {
  if (internalPayer !== 0) return false
  if (dest === 'lp') return false
  return stream !== 'omnipool_asset_fee' || dest === 'protocol' || dest === 'burned' || dest === 'pol'
}

const CH_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const EPOCH_TS = '1970-01-01 00:00:00'

/**
 * Each stream's cold high-water mark (max block_timestamp in revenue_events). A
 * stream the job has not materialized yet has no entry, which hands its whole
 * window to the raw arm.
 */
export async function revenueColdMarks(client: ClickHouseClient): Promise<Map<RevenueStream, string>> {
  return cached('revenue:cold-marks', 15_000, async () => {
    const res = await client.query({
      query: `-- rev:cold-marks
SELECT stream, toString(max(block_timestamp)) AS mark FROM price_data.revenue_events GROUP BY stream`,
      format: 'JSONEachRow',
    })
    const out = new Map<RevenueStream, string>()
    for (const row of await res.json<{ stream: RevenueStream; mark: string }>()) {
      if (CH_TS.test(row.mark)) out.set(row.stream, row.mark)
    }
    return out
  })
}

/** Streams' cold caps as one predicate, so the cold arm never crosses the marks the tail was built from. */
export function revenueColdCapPredicateSql(marks: ReadonlyMap<RevenueStream, string>): string {
  const arms = REVENUE_STREAMS.map(stream =>
    `(stream = '${stream}' AND block_timestamp <= toDateTime('${marks.get(stream) ?? EPOCH_TS}'))`)
  return `(${arms.join(' OR ')})`
}

/**
 * How far the raw tail must reach: the oldest cold mark, floored so a stream the
 * job has never built (no mark) cannot demand an unbounded raw scan — its
 * history is simply incomplete until the job lands, which the derivations
 * freshness contract states rather than hides.
 */
const MAX_TAIL_HOURS = 26

export function revenueTailHours(marks: ReadonlyMap<RevenueStream, string>, nowSeconds: number): number {
  let oldest = nowSeconds
  for (const stream of EVENTFUL_STREAMS) {
    const mark = marks.get(stream)
    const seconds = mark ? Math.floor(Date.parse(`${mark.replace(' ', 'T')}Z`) / 1000) : 0
    if (seconds < oldest) oldest = seconds
  }
  return Math.min(MAX_TAIL_HOURS, Math.max(1, Math.ceil((nowSeconds - oldest) / 3_600) + 1))
}

export interface RevenueTailRow {
  stream: RevenueStream
  block_height: number
  block_timestamp: string
  event_index: number
  leg_index: number
  dest: string
  account: string
  asset_id: number
  amount: string
  internal_payer: number
  amount_usd: string
}

/**
 * The raw tail: every eventful stream's rows past its own cold mark, one UNION
 * query through the shared builders, bounded to `hours` before now and sorted by
 * chain position. Cached briefly (single-flight) so concurrent readers share one
 * execution. The marks are part of the cache identity — a tail built from older
 * marks must never be paired with fresher cold caps (rows between the two mark
 * generations would count twice) or vice versa (counted in neither arm).
 */
export async function revenueTailRows(client: ClickHouseClient, hours: number, marks: ReadonlyMap<RevenueStream, string>): Promise<RevenueTailRow[]> {
  const marksKey = [...marks].map(([s, m]) => `${s}=${m}`).sort().join(',')
  return cached(`revenue:tail:${hours}:${marksKey}`, 2_000, async () => {
    const arms = EVENTFUL_STREAMS.map(stream => `SELECT * FROM (
${buildRevenueEventRowsSql(stream)}
) WHERE block_timestamp > toDateTime('${marks.get(stream) ?? EPOCH_TS}')`)
    const res = await client.query({
      query: `-- rev:tail\n${arms.join('\nUNION ALL\n')}`,
      query_params: { anchor: chTimestamp(Math.floor(Date.now() / 1000)), hours },
      format: 'JSONEachRow',
      clickhouse_settings: DECIMAL_STRINGS,
    })
    const rows = await res.json<RevenueTailRow>()
    rows.sort((a, b) => a.block_height - b.block_height || a.event_index - b.event_index || a.leg_index - b.leg_index)
    return rows
  })
}

export function revenueTailSeconds(row: RevenueTailRow): number {
  return Math.floor(Date.parse(`${row.block_timestamp.replace(' ', 'T')}Z`) / 1000)
}

/** One stream's protocol revenue over the trailing windows, in integer 1e-12 USD. */
export interface ProtocolRevenueWindows { day: bigint; week: bigint; month: bigint; allTime: bigint }

/**
 * Protocol revenue per stream over the trailing 24h / 7d / 30d and all time,
 * in integer 1e-12 USD: the cold sums under PROTOCOL_REVENUE_PREDICATE_SQL and
 * the marks' caps, plus every positive tail row the TS twin admits. `tail` must
 * be built from the SAME `marks` (revenueTailRows); pass it in so a caller that
 * also needs the rows (the dashboard's buckets and payer ranking) reads raw once.
 */
export async function protocolRevenueWindows(
  client: ClickHouseClient,
  marks: ReadonlyMap<RevenueStream, string>,
  tail: readonly RevenueTailRow[],
  nowSeconds: number,
): Promise<Map<RevenueStream, ProtocolRevenueWindows>> {
  const res = await client.query({
    query: `-- rev:protocol-revenue-windows
SELECT stream,
       toString(sumIf(amount_usd, block_timestamp > toDateTime('${chTimestamp(nowSeconds - 86_400)}'))) AS day,
       toString(sumIf(amount_usd, block_timestamp > toDateTime('${chTimestamp(nowSeconds - 7 * 86_400)}'))) AS week,
       toString(sumIf(amount_usd, block_timestamp > toDateTime('${chTimestamp(nowSeconds - 30 * 86_400)}'))) AS month,
       toString(sum(amount_usd)) AS all_time
FROM price_data.revenue_events
WHERE ${PROTOCOL_REVENUE_PREDICATE_SQL} AND ${revenueColdCapPredicateSql(marks)}
GROUP BY stream`,
    format: 'JSONEachRow',
    clickhouse_settings: DECIMAL_STRINGS,
  })
  const totals = new Map<RevenueStream, ProtocolRevenueWindows>()
  for (const row of await res.json<{ stream: RevenueStream; day: string; week: string; month: string; all_time: string }>()) {
    totals.set(row.stream, { day: scaledUsd(row.day), week: scaledUsd(row.week), month: scaledUsd(row.month), allTime: scaledUsd(row.all_time) })
  }
  for (const row of tail) {
    if (!isProtocolRevenue(row.stream, row.dest, row.internal_payer)) continue
    const usd = scaledUsd(row.amount_usd)
    if (usd <= 0n) continue
    const t = revenueTailSeconds(row)
    const w = totals.get(row.stream) ?? { day: 0n, week: 0n, month: 0n, allTime: 0n }
    if (t > nowSeconds - 86_400) w.day += usd
    if (t > nowSeconds - 7 * 86_400) w.week += usd
    if (t > nowSeconds - 30 * 86_400) w.month += usd
    w.allTime += usd
    totals.set(row.stream, w)
  }
  return totals
}
