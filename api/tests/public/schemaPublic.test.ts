import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { selectSchemaFiles, splitSqlStatements } from '../../src/db/schemaBootstrap.ts'

const sql = readFileSync(new URL('../../../clickhouse/schema/006_public.sql', import.meta.url), 'utf8')
const accountTradeVolume = readFileSync(new URL('../../src/services/accountTradeVolume.ts', import.meta.url), 'utf8')
// The splitter keeps each statement's leading comment block, which is where this
// file's rationale lives. Assertions run against the executable SQL alone so a
// word in a comment can neither satisfy nor break one.
const statements = splitSqlStatements(sql).map(s => s.replace(/^[ \t]*--.*$/gm, '').trim())

// Compare SQL modulo the formatting ClickHouse's own SHOW CREATE applies (backtick
// quoting and whitespace), so these assertions survive a schema regeneration.
function noSpace(text: string): string {
  return text.replace(/`/g, '').replace(/\s+/g, '')
}

// A SQL fragment lifted out of a TS template literal carries that literal's own
// backslash escaping (`\\\\d` in source is `\\d` in the emitted SQL). Collapse runs
// of backslashes on both sides so the two spellings of one regex compare equal.
function sqlText(text: string): string {
  return noSpace(text).replace(/\\+/g, '\\')
}

// The pre-Broadcast era, one MV per pallet because the four pallets disagree about
// which field is which side and where the fee sits. They all write pool_swap_legs.
const LEGACY_MVS = [
  'pool_swap_legs_omnipool_legacy_mv', 'pool_swap_legs_stableswap_legacy_mv',
  'pool_swap_legs_xyk_legacy_mv', 'pool_swap_legs_lbp_legacy_mv',
]
const SWAP_LEG_MVS = ['pool_swap_legs_mv', ...LEGACY_MVS]

function statementFor(name: string): string {
  const found = statements.filter(s =>
    s.startsWith(`CREATE TABLE IF NOT EXISTS price_data.${name} `)
    || s.startsWith(`CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.${name} `))
  expect(found, name).toHaveLength(1)
  return found[0]
}

// 006_public.sql is the /v1 public API's read layer: three MV-fed projections over
// raw_events. Every assertion here pins a durable invariant of the declaration —
// replacement key, era boundary, and the exact JSON extraction the rest of the
// codebase already agreed on — because a schema file is applied once to an empty
// database and never migrated, so a silent drift here is only visible as wrong
// public numbers.
describe('006_public.sql', () => {
  it('is applied last by schema bootstrap', () => {
    const files = selectSchemaFiles([
      '000_database.sql', '001_tables.sql', '002_views.sql',
      '003_materialized_views.sql', '004_user.sql', '005_contracts.sql', '006_public.sql',
    ])
    expect(files[files.length - 1]).toBe('006_public.sql')
  })

  it('declares the five event tables and their MVs idempotently', () => {
    for (const name of ['pool_swap_legs', 'farm_config_events', 'otc_order_events',
                        'gigahdx_reward_allocations', 'gigahdx_stake_events',
                        ...SWAP_LEG_MVS, 'farm_config_events_mv', 'otc_order_events_mv',
                        'gigahdx_reward_allocations_mv', 'gigahdx_stake_events_mv']) {
      expect(sql).toMatch(new RegExp(`CREATE (TABLE|MATERIALIZED VIEW) IF NOT EXISTS price_data\\.${name}`))
    }
  })

  it('every statement parses through the bootstrap splitter and only creates', () => {
    // 5 projections + 9 source MVs + pool_swap_hourly, its staging twin, and
    // the compact hourly source-watermark table.
    expect(statements).toHaveLength(18)
    for (const statement of statements) expect(statement.startsWith('CREATE ')).toBe(true)
    // No DROP/ALTER/INSERT: the file is re-applied on every deployment start, and a
    // destructive or additive statement there would wipe or double-count live data.
    // Checked on the executable SQL only — a comment is free to document the one-time
    // rollout INSERT … SELECT that carries an existing deployment's history.
    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(DROP|ALTER|INSERT|TRUNCATE|EXCHANGE)\b/)
    }
  })

  it('creates each destination table before the MV that writes to it', () => {
    for (const name of ['pool_swap_legs', 'farm_config_events', 'otc_order_events',
                        'gigahdx_reward_allocations', 'gigahdx_stake_events']) {
      const table = sql.indexOf(`CREATE TABLE IF NOT EXISTS price_data.${name} `)
      const view = sql.indexOf(`CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.${name}_mv`)
      expect(table, name).toBeGreaterThan(-1)
      expect(view, name).toBeGreaterThan(table)
    }
    const legsTable = sql.indexOf('CREATE TABLE IF NOT EXISTS price_data.pool_swap_legs ')
    for (const name of LEGACY_MVS) {
      expect(sql.indexOf(`CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.${name} `), name)
        .toBeGreaterThan(legsTable)
    }
  })

  // Replay safety (AGENTS.md): raw ranges are re-insertable, so each projection must
  // replace on a natural leg/event identity rather than accumulate. No additive state.
  it('keys every projection on a replay-safe natural identity', () => {
    expect(noSpace(statementFor('pool_swap_legs'))).toContain(noSpace(
      `ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY toYYYYMM(block_timestamp)
       ORDER BY (venue, pool_key, block_height, event_index, leg_kind, leg_index)`))
    expect(noSpace(statementFor('farm_config_events'))).toContain(noSpace(
      `ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (global_farm_id, block_height, event_index)`))
    expect(noSpace(statementFor('otc_order_events'))).toContain(noSpace(
      `ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (order_id, block_height, event_index)`))
    expect(noSpace(statementFor('gigahdx_reward_allocations'))).toContain(noSpace(
      `ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (ref_index, block_height, event_index)`))
    expect(noSpace(statementFor('gigahdx_stake_events'))).toContain(noSpace(
      `ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (block_height, event_index)`))
    for (const name of ['pool_swap_legs', 'farm_config_events', 'otc_order_events',
                        'gigahdx_reward_allocations', 'gigahdx_stake_events']) {
      expect(statementFor(name), name).not.toMatch(/SummingMergeTree|AggregatingMergeTree/)
    }
  })

  it('declares pool_swap_legs columns with amounts as strings', () => {
    const table = noSpace(statementFor('pool_swap_legs'))
    for (const column of [
      'venue LowCardinality(String)', 'pool_key String', 'block_height UInt32',
      'event_index UInt32', 'leg_index UInt16', `leg_kind Enum8('in' = 1, 'out' = 2, 'fee' = 3)`,
      'asset_id UInt32', 'amount String', 'fee_dest LowCardinality(String)',
      'fee_recipient String', 'swapper String', 'op_key String',
      'extrinsic_index Nullable(UInt32)', 'block_timestamp DateTime', 'ingested_at DateTime',
    ]) {
      expect(table, column).toContain(noSpace(column))
    }
    // Amounts are u128 on chain. UInt64 would silently truncate real fills (a single
    // 18-decimal leg observed at 8.6e21 raw units), and a float would lose precision.
    expect(table).not.toContain(noSpace('amount UInt64'))
    expect(table).not.toContain(noSpace('amount Float'))
  })

  // The hourly pre-aggregate is the one model here that is NOT MV-fed, and every
  // assertion below pins a reason for that or a property the split read depends on.
  describe('pool_swap_hourly', () => {
    const live = noSpace(statementFor('pool_swap_hourly'))
    const staging = noSpace(statementFor('pool_swap_hourly_staging'))

    // The job publishes a rebuilt month with ALTER TABLE … REPLACE PARTITION FROM
    // the twin, which ClickHouse refuses unless the two structures and partition
    // keys match exactly. A column added to one and not the other is a rollout
    // failure, so the declarations are compared rather than eyeballed.
    it('declares the staging twin identically to the live table', () => {
      expect(staging.replace('pool_swap_hourly_staging', 'pool_swap_hourly')).toBe(live)
    })

    // toYYYYMM(hour) with hour = toStartOfHour(block_timestamp) makes one derived
    // partition exactly one source partition, which is what lets the job rebuild a
    // month by reading only that month.
    it('partitions by month on the source clock and keys on the full group', () => {
      expect(live).toContain(noSpace(
        `ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(hour)
         ORDER BY (venue, leg_kind, hour, asset_id, pool_key, fee_dest, fee_recipient)`))
    })

    // Replay safety, the reason this is a job and not an MV: pool_swap_legs is
    // replayable, so its rows must be deduplicated BEFORE they are summed. An
    // additive engine here would re-add a replayed leg on every re-index, and an MV
    // writing to this table would do the same at insert time.
    it('is neither an additive engine nor fed by a materialized view', () => {
      for (const [name, text] of [['live', live], ['staging', staging]] as const) {
        expect(text, name).not.toMatch(/SummingMergeTree|AggregatingMergeTree/)
      }
      expect(sql).not.toMatch(/CREATE MATERIALIZED VIEW[^;]*TO price_data\.pool_swap_hourly/)
    })

    it('carries the summed amount as a string and the deduplicated leg count', () => {
      for (const column of [
        'venue LowCardinality(String)', 'pool_key String', 'asset_id UInt32',
        `leg_kind Enum8('in' = 1, 'out' = 2, 'fee' = 3)`, 'fee_dest LowCardinality(String)',
        'fee_recipient String', 'hour DateTime', 'amount_sum String', 'leg_count UInt64',
        'computed_at DateTime',
      ]) expect(live, column).toContain(noSpace(column))
      // An hour of 18-decimal legs passes 2^64 by a wide margin, so the sum is a
      // string widened to Decimal256 by the reader — never a UInt64 or a float.
      expect(live).not.toContain(noSpace('amount_sum UInt64'))
      expect(live).not.toContain(noSpace('amount_sum Float'))
    })

    // fee_recipient is a KEY column rather than something folded away: the fees
    // charts' lp/protocol split is a recipient question (poolVolumes.OMNIPOOL_ACCOUNT),
    // and an aggregate that summed across recipients could not answer it.
    it('keeps fee_dest and fee_recipient in the key so the fee split survives', () => {
      expect(live).toContain(noSpace('ORDER BY (venue, leg_kind, hour, asset_id, pool_key, fee_dest, fee_recipient)'))
    })
  })

  it('declares farm_config_events and otc_order_events columns', () => {
    const farm = noSpace(statementFor('farm_config_events'))
    for (const column of [
      'pallet LowCardinality(String)', 'event_name LowCardinality(String)',
      'global_farm_id UInt32', 'yield_farm_id Nullable(UInt32)', 'block_height UInt32',
      'event_index UInt32', 'block_timestamp DateTime', 'args_json String', 'ingested_at DateTime',
    ]) expect(farm, column).toContain(noSpace(column))

    const otc = noSpace(statementFor('otc_order_events'))
    for (const column of [
      'order_id UInt32', 'event_name LowCardinality(String)', 'asset_in UInt32',
      'asset_out UInt32', 'amount_in String', 'amount_out String', 'partially_fillable UInt8',
      'filler String', 'block_height UInt32', 'event_index UInt32',
      'block_timestamp DateTime', 'ingested_at DateTime',
    ]) expect(otc, column).toContain(noSpace(column))
  })

  it('splits the two swap eras at 6837788, exclusively on both sides', () => {
    expect(sql).toContain('6837788')
    expect(sql).toMatch(/event_name IN \('Broadcast\.Swapped', 'Broadcast\.Swapped2', 'Broadcast\.Swapped3'\)/)
    // The era boundary must agree with the read model that already draws it, or the two
    // count the same trade twice / not at all across the cutover.
    expect(accountTradeVolume).toContain('BROADCAST_MIN_BLOCK = 6_837_788')
    expect(statementFor('pool_swap_legs_mv')).toContain('block_height >= 6837788')
    // The boundary is the ONLY separator: the per-pallet events did not stop when
    // Broadcast.Swapped arrived (Omnipool.SellExecuted alone fires 4.7M more times at
    // or above it, alongside the Broadcast event for the same fill). A legacy MV that
    // lost its clause would double-project the whole modern era into the same table.
    for (const name of LEGACY_MVS) {
      expect(statementFor(name), name).toContain('block_height < 6837788')
      expect(statementFor(name), name).not.toContain('block_height >= 6837788')
    }
  })

  it('every pool_swap_legs MV carries ingested_at through (replay-safe)', () => {
    // now() as the replacement version would make a replayed range beat the row it
    // replaces on wall-clock order instead of on ingest order, and would defeat
    // deduplication for backward backfill.
    for (const name of [...SWAP_LEG_MVS, 'farm_config_events_mv', 'otc_order_events_mv',
                        'gigahdx_reward_allocations_mv', 'gigahdx_stake_events_mv']) {
      expect(statementFor(name), name).toContain('ingested_at')
      expect(statementFor(name), name).not.toContain('now()')
    }
  })

  it('reuses the ExactOut inversion guard verbatim from accountTradeVolume', () => {
    // Broadcast.Swapped (v1) reported inverted amounts for single-leg ExactOut XYK/LBP
    // fills. The guard exists in two places by necessity (SQL text vs a TS template),
    // so pin them character-for-character modulo whitespace: a one-sided edit swaps a
    // trade's two sides, and because the pair rarely shares decimals the error is
    // unbounded, not a rounding slip.
    const guard = accountTradeVolume.match(/const inv = `([^`]+)`/)?.[1]
    expect(guard, 'inv guard in accountTradeVolume.ts').toBeDefined()
    expect(noSpace(statementFor('pool_swap_legs_mv'))).toContain(noSpace(guard as string))
  })

  // Pinning the guard's CONDITION is not enough: reverting to the plan sketch's
  // "swap the whole arrays" form, or transposing the leg-kind constants, keeps the
  // condition intact and silently exchanges the trade's two sides. So pin the
  // application — which array each leg kind maps, and which array the corrected
  // amount is taken from — as whole expressions.
  it('applies the ExactOut correction to amounts only, per leg kind', () => {
    const mv = noSpace(statementFor('pool_swap_legs_mv'))
    // in_raw/out_raw must stay bound to their own JSON keys, or the leg expressions
    // below would read correctly while meaning the opposite.
    expect(mv).toContain(noSpace(`JSONExtractArrayRaw(args_json, 'inputs') AS in_raw`))
    expect(mv).toContain(noSpace(`JSONExtractArrayRaw(args_json, 'outputs') AS out_raw`))
    // Leg kind 1 ('in') maps the INPUT legs and, when corrected, takes the OUTPUT's
    // amount while keeping the input's asset.
    expect(mv).toContain(noSpace(
      `arrayMap(x -> tuple(toUInt8(1), toUInt32(JSONExtractUInt(x, 'asset')),
         if(legacy_exact_out, JSONExtractString(out_raw[1], 'amount'), JSONExtractString(x, 'amount')),
         '', ''), in_raw) AS in_legs`))
    // Leg kind 2 ('out') is the exact mirror.
    expect(mv).toContain(noSpace(
      `arrayMap(x -> tuple(toUInt8(2), toUInt32(JSONExtractUInt(x, 'asset')),
         if(legacy_exact_out, JSONExtractString(in_raw[1], 'amount'), JSONExtractString(x, 'amount')),
         '', ''), out_raw) AS out_legs`))
    // Fee legs are never corrected, and they are the only legs carrying a destination.
    expect(mv).toContain(noSpace(`arrayMap(x -> tuple(toUInt8(3), toUInt32(JSONExtractUInt(x, 'asset')), JSONExtractString(x, 'amount'),`))
    expect(mv).toContain(noSpace(`JSONExtractArrayRaw(args_json, 'fees')) AS fee_legs`))
    // Concatenation order is what makes leg_index deterministic across the three kinds.
    expect(mv).toContain(noSpace(`arrayConcat(in_legs, out_legs, fee_legs) AS legs`))
    // The plan sketch's array-swapping form must not come back.
    expect(mv).not.toContain(noSpace(`if(legacy_exact_out, 'outputs', 'inputs')`))
    expect(mv).not.toContain(noSpace(`if(legacy_exact_out, 'inputs', 'outputs')`))
  })

  it('groups routed legs by the operationStack Router id', () => {
    const mv = statementFor('pool_swap_legs_mv')
    // op_key is what platform-total netting groups on: a multi-hop route emits one
    // fill per hop, and grouping by extrinsic instead under-nets a batch carrying
    // several independent trades. Mirror accountTradeVolume.ts's `rid` rather than
    // re-deriving it, so the two never disagree about which fills are one trade.
    const rid = accountTradeVolume.match(/const rid = `([^`]+)`/)?.[1]
    expect(rid, 'rid expression in accountTradeVolume.ts').toBeDefined()
    expect(sqlText(mv)).toContain(sqlText(rid as string))
    expect(sqlText(mv)).toContain(sqlText(`'"__kind":"Router","value":(\\\\d+)'`))
    // A fill with no Router entry (direct pallet swap, block hook) gets '', so a
    // consumer can fall back to the leg's own event identity instead of collapsing
    // every unrouted fill onto one key.
    expect(noSpace(mv)).toContain(noSpace(`if(router_id > 0, toString(router_id), '') AS op_key`))
  })

  it('extracts leg amounts and fee destinations as the chain shapes them', () => {
    const mv = noSpace(statementFor('pool_swap_legs_mv'))
    // args_json holds leg amounts as JSON strings; JSONExtractUInt would cap at 2^64.
    expect(mv).toContain(noSpace(`JSONExtractString(x, 'amount')`))
    expect(mv).not.toMatch(/JSONExtractUInt\(x,'amount'\)/)
    // Destination is the Substrate enum Account(AccountId32) | Burned, so a fee leg
    // always has a destination and only the Account variant carries a recipient.
    expect(mv).toContain(noSpace(`lower(JSONExtractString(x, 'destination', '__kind'))`))
    expect(mv).toContain(noSpace(`JSONExtractString(x, 'destination', 'value')`))
  })

  it('keys pool_key per venue so no venue collapses onto an empty string', () => {
    const mv = noSpace(statementFor('pool_swap_legs_mv'))
    // Verified over the whole modern era: fillerType.value carries the pool id for
    // Stableswap and the order id for OTC; Omnipool is the single pool; XYK/LBP/AAVE/HSM
    // identify themselves by the filler account. No venue yields an empty pool_key.
    expect(mv).toContain(noSpace(`filler_kind = 'Omnipool', 'omnipool'`))
    expect(mv).toContain(noSpace(`filler_kind IN ('Stableswap', 'OTC'), toString(JSONExtractUInt(args_json, 'fillerType', 'value'))`))
    expect(mv).toContain(noSpace(`JSONExtractString(args_json, 'filler')`))
  })

  it('projects the farm lifecycle events of both liquidity-mining pallets', () => {
    const mv = statementFor('farm_config_events_mv')
    const lifecycle = ['GlobalFarmCreated', 'GlobalFarmUpdated', 'GlobalFarmTerminated',
                       'YieldFarmCreated', 'YieldFarmUpdated', 'YieldFarmStopped',
                       'YieldFarmResumed', 'YieldFarmTerminated']
    for (const pallet of ['OmnipoolLiquidityMining', 'XYKLiquidityMining']) {
      for (const name of lifecycle) expect(mv, `${pallet}.${name}`).toContain(`'${pallet}.${name}'`)
    }
    // The warehouse pallets emit per-block accumulator updates under similar names.
    // They are not lifecycle events and would swamp the projection.
    expect(mv).not.toContain('WarehouseLM')
    expect(mv).not.toContain('AccRPZUpdated')
    expect(mv).not.toContain('RewardClaimed')
    // GlobalFarmCreated/Updated name the farm `id`; every other event names it
    // `globalFarmId`. Reading one spelling only writes farm 0 for the other half.
    expect(noSpace(mv)).toContain(noSpace(`JSONHas(args_json, 'globalFarmId')`))
    expect(noSpace(mv)).toContain(noSpace(`JSONExtractUInt(args_json, 'id')`))
  })

  it('projects the four OTC order events with absent fields defaulted', () => {
    const mv = statementFor('otc_order_events_mv')
    expect(mv).toMatch(/event_name IN \('OTC\.Placed', 'OTC\.Filled', 'OTC\.PartiallyFilled', 'OTC\.Cancelled'\)/)
    // Only Placed carries the assets and partiallyFillable; only Filled/PartiallyFilled
    // carry `who`. Cancelled carries orderId alone, so the rest must default, not fail.
    expect(noSpace(mv)).toContain(noSpace(`JSONExtractString(args_json, 'amountIn')`))
    expect(noSpace(mv)).toContain(noSpace(`JSONExtractBool(args_json, 'partiallyFillable')`))
    expect(noSpace(mv)).toContain(noSpace(`JSONExtractString(args_json, 'who')`))
  })

  // ---- legacy era (pre-Broadcast per-pallet events) ----

  it('gives every legacy MV the same leg identity as the modern one', () => {
    for (const name of LEGACY_MVS) {
      const mv = noSpace(statementFor(name))
      // leg_index counts the same in→out→fee concatenation the modern MV builds, so a
      // legacy row's (leg_kind, leg_index) means what a modern row's means.
      expect(mv, name).toContain(noSpace(`arrayConcat([tuple(toUInt8(1),`))
      expect(mv, name).toContain(noSpace(`toUInt16(leg_i - 1) AS leg_index`))
      expect(mv, name).toContain(noSpace(`ARRAY JOIN arrayEnumerate(legs) AS leg_i`))
      // Router.Executed carries no operation id in that era, so there is nothing to
      // group a route by; a consumer falls back to the leg's own event identity.
      expect(mv, name).toContain(noSpace(`'' AS op_key`))
      expect(mv, name).toContain(noSpace(`JSONExtractString(args_json, 'who') AS swapper`))
      // Amounts are u128 JSON strings; JSONExtractUInt would cap them at 2^64.
      expect(mv, name).not.toMatch(/JSONExtractUInt\(args_json,'am(ount|In|Out)/)
    }
  })

  it('maps the Omnipool legacy fee legs to the out asset and to LRNA', () => {
    const mv = noSpace(statementFor('pool_swap_legs_omnipool_legacy_mv'))
    expect(mv).toContain(noSpace(`event_name IN ('Omnipool.SellExecuted', 'Omnipool.BuyExecuted')`))
    expect(mv).toContain(noSpace(`'omnipool' AS venue, 'omnipool' AS pool_key`))
    // protocolFeeAmount is charged in LRNA (asset 1) and assetFeeAmount in the asset
    // LEAVING the pool — except on a BUY before the runtime upgrade at block
    // 4,221,778, which charges it in the asset ENTERING the pool. Measured on the
    // legacy fills whose two assets have different decimals, the only ones where the
    // two readings are distinguishable: sells put the fee on the out asset 1,655,268
    // times against 5 on the in asset, while buys split totally by block — 25,913 of
    // 25,913 on the in asset below the upgrade, 265,339 of 265,421 on the out asset at
    // or above it, with no buy between the last of one (4,221,745) and the first of
    // the other (4,221,815). A median over both directions hides this and values one
    // 0.1 WBTC buy's 10.65 DAI fee as 106 billion WBTC.
    //
    // Both fee fields arrived together in spec v170 and are absent before block
    // 3,112,604, so one JSONHas gates both legs: defaulting them to 0 would invent
    // 267,638 zero-fee legs that the chain never reported.
    //
    // The two legs' fee_dest differs, and that asymmetry is the load-bearing part.
    // Over blocks 6,837,788–6,950,000 the ASSET fee reaches three recipients (pool
    // 117,713 / referrals 59,609 / staking 58,090), so a legacy asset fee's
    // destination is unknowable and stays '' — naming the pool would be a guess.
    // The PROTOCOL fee is unambiguous there: 115,913 of 115,913 LRNA protocol-fee
    // legs are Burned. Leaving that one '' too would pass it through every
    // `fee_dest != 'burned'` filter and book burned LRNA as accrued revenue for the
    // whole legacy era, so it is pinned as a whole expression, not by substring.
    expect(mv).toContain(noSpace(
      `if(JSONHas(args_json, 'assetFeeAmount'),
         [tuple(toUInt8(3), if(event_name = 'Omnipool.BuyExecuted' AND block_height < 4221778, asset_in, asset_out), JSONExtractString(args_json, 'assetFeeAmount'), '', ''),
          tuple(toUInt8(3), toUInt32(1), JSONExtractString(args_json, 'protocolFeeAmount'), 'burned', '')],
         CAST([], 'Array(Tuple(UInt8, UInt32, String, String, String))'))`))
    expect(mv).not.toContain(noSpace(`JSONExtractString(args_json, 'assetFeeAmount'), 'account'`))
    expect(mv).not.toContain(noSpace(`JSONExtractString(args_json, 'assetFeeAmount'), 'burned'`))
    expect(mv).not.toContain(noSpace(`JSONExtractString(args_json, 'protocolFeeAmount'), ''`))
  })

  it('maps the Stableswap legacy fee to the side the pallet charges it on', () => {
    const mv = noSpace(statementFor('pool_swap_legs_stableswap_legacy_mv'))
    expect(mv).toContain(noSpace(`event_name IN ('Stableswap.SellExecuted', 'Stableswap.BuyExecuted')`))
    expect(mv).toContain(noSpace(`'stableswap' AS venue, toString(toUInt32(greatest(0, JSONExtractInt(args_json, 'poolId')))) AS pool_key`))
    // Sell charges the fee in the asset leaving the pool, Buy in the asset entering it
    // (the pallet's own event docs, corroborated on the modern era). Reading one side
    // for both would book every buy's fee against the wrong asset.
    expect(mv).toContain(noSpace(
      `tuple(toUInt8(3), if(event_name = 'Stableswap.SellExecuted', asset_out, asset_in),
         JSONExtractString(args_json, 'fee'), 'account', '')`))
  })

  it('maps XYK legacy sides by role and credits the fee to the pool it names', () => {
    const mv = noSpace(statementFor('pool_swap_legs_xyk_legacy_mv'))
    expect(mv).toContain(noSpace(`event_name IN ('XYK.SellExecuted', 'XYK.BuyExecuted')`))
    // A sell is (amount paid, salePrice received); a buy is (buyPrice paid, amount
    // received) — the mapping swap_activity_mv and accountTradeVolume.ts already use.
    expect(mv).toContain(noSpace(
      `tuple(toUInt8(1), asset_in, if(event_name = 'XYK.SellExecuted',
         JSONExtractString(args_json, 'amount'), JSONExtractString(args_json, 'buyPrice')), '', '')`))
    expect(mv).toContain(noSpace(
      `tuple(toUInt8(2), asset_out, if(event_name = 'XYK.SellExecuted',
         JSONExtractString(args_json, 'salePrice'), JSONExtractString(args_json, 'amount')), '', '')`))
    // The event names its own feeAsset, so no side is inferred, and the `pool` account
    // it carries is the same account the modern era reports as the XYK fee recipient.
    expect(mv).toContain(noSpace(
      `tuple(toUInt8(3), toUInt32(greatest(0, JSONExtractInt(args_json, 'feeAsset'))),
         JSONExtractString(args_json, 'feeAmount'), 'account', pool_account)`))
    expect(mv).toContain(noSpace(`'xyk' AS venue, pool_account AS pool_key`))
  })

  it('reads LBP buys in LBP order, not XYK order', () => {
    const mv = noSpace(statementFor('pool_swap_legs_lbp_legacy_mv'))
    expect(mv).toContain(noSpace(`event_name IN ('LBP.SellExecuted', 'LBP.BuyExecuted')`))
    // LBP names its buy fields exactly as XYK does and means the opposite by them: an
    // LBP buy is (amount paid, buyPrice received), so LBP pays `amount` on both sides
    // of the pallet. Reading it in XYK's order exchanges the trade's two sides, and
    // since the pair rarely shares decimals the error is unbounded — accountTradeVolume
    // measured one such misread at $77.3M of volume for a $1,562 trade.
    expect(mv).toContain(noSpace(`tuple(toUInt8(1), asset_in, JSONExtractString(args_json, 'amount'), '', '')`))
    expect(mv).toContain(noSpace(
      `tuple(toUInt8(2), asset_out, if(event_name = 'LBP.SellExecuted',
         JSONExtractString(args_json, 'salePrice'), JSONExtractString(args_json, 'buyPrice')), '', '')`))
    expect(mv).not.toContain(noSpace(`tuple(toUInt8(1), asset_in, if(event_name = 'LBP.SellExecuted'`))
    // The divergence is stated in exactly one other place; keep the two in step.
    expect(noSpace(accountTradeVolume)).toContain(noSpace(`event_name = 'XYK.BuyExecuted', JSONExtractString(args_json,'buyPrice')`))
    expect(noSpace(accountTradeVolume)).toContain(noSpace(`event_name = 'LBP.BuyExecuted', JSONExtractString(args_json,'amount')`))
    // The pallet event carries no `pool` (unlike XYK) and an MV cannot join
    // LBP.PoolCreated, so LBP legs are venue-scoped rather than keyed on a guess.
    expect(mv).toContain(noSpace(`'lbp' AS venue, '' AS pool_key`))
    expect(mv).not.toContain(noSpace(`JSONExtractString(args_json, 'pool')`))
  })

  it('reads raw_events without FINAL in the MVs', () => {
    // An MV is an insert trigger over the inserted block, so FINAL there is both
    // meaningless and a full-table read; deduplication is the destination table's job.
    for (const name of [...SWAP_LEG_MVS, 'farm_config_events_mv', 'otc_order_events_mv',
                        'gigahdx_reward_allocations_mv', 'gigahdx_stake_events_mv']) {
      expect(statementFor(name), name).toContain('FROM price_data.raw_events')
      expect(statementFor(name), name).not.toContain('FINAL')
    }
  })

  // ---- GIGAHDX voting-reward models (Semantics 10) ----

  it('projects the reward allocations with u128 amounts as strings', () => {
    const table = noSpace(statementFor('gigahdx_reward_allocations'))
    for (const column of [
      'ref_index UInt32', 'track_id UInt16', 'total_reward String',
      'total_weighted_votes String', 'voters_remaining UInt32', 'block_height UInt32',
      'event_index UInt32', 'block_timestamp DateTime', 'ingested_at DateTime',
    ]) expect(table, column).toContain(noSpace(column))
    // totalWeightedVotes is stake × multiplier and passes 2^64 on every real
    // referendum; JSONExtractUInt would silently cap both amounts.
    const mv = statementFor('gigahdx_reward_allocations_mv')
    expect(mv).toContain(`= 'GigaHdxRewards.RewardPoolAllocated'`)
    expect(noSpace(mv)).toContain(noSpace(`JSONExtractString(args_json, 'totalReward')`))
    expect(noSpace(mv)).toContain(noSpace(`JSONExtractString(args_json, 'totalWeightedVotes')`))
    expect(noSpace(mv)).not.toContain(noSpace(`JSONExtractUInt(args_json, 'totalReward')`))
  })

  it('projects the three stake flows and excludes the migration double-emit', () => {
    const mv = statementFor('gigahdx_stake_events_mv')
    expect(mv).toMatch(/event_name IN \('GigaHdx\.Staked', 'GigaHdx\.Unstaked', 'GigaHdx\.YieldRealized'\)/)
    // Every MigratedFromLegacy also emits a Staked for the same amount (verified
    // on the full history), so projecting both would double-count the stake.
    expect(mv).not.toContain('MigratedFromLegacy')
    // Unstaked reduces the lock by its PAYOUT (principal + realized yield), not
    // by the burned share amount; reading `amount` there would be null anyway.
    expect(noSpace(mv)).toContain(noSpace(
      `if(raw_events.event_name = 'GigaHdx.Unstaked', JSONExtractString(args_json, 'payout'), JSONExtractString(args_json, 'amount')) AS hdx_amount`))
  })
})
