// The raw indexer's money-market trigger phase: per block, after the block's own
// event-driven position reads (extractMoneyMarketRows), re-read getUserAccountData
// for the holders whose health factor the block moved without an event of theirs.
//
//   price_step  a reserve's oracle price moved ≥ RAW_MM_PRICE_STEP_BP against block
//               b − 1 (moneyMarketPrices.ts) → every holder of that reserve
//               (supplier or borrower), from the reserve holder index.
//   config      a PoolConfigurator / PoolAddressesProvider log of the market (LTVs,
//               thresholds, e-mode, reserves) → the market's every holder and open
//               position.
//   cadence     chain time: every open position on RAW_MM_CADENCE_MINUTES (60), the
//               GIGAHDX market's on RAW_MM_GIGAHDX_CADENCE_MINUTES (5) — the interest
//               and sub-step price drift no single block shows.
//
// One read per (block, pool, user), through snapshotMoneyMarketPositions
// (observation id `money-market-periodic:` + market key + block + user, ranked at
// the end of the block by the projection), with `evidence_json.trigger` naming why
// (and the stepped reserves). A zero read is written only for a pair the projection
// shows open (its exit). Pairs the block already read through its own events are
// not read again.
//
// The same phase reads the usage-as-collateral bitmap (getUserConfiguration →
// money_market_collateral_anchor, a row per reserve of the pool) of every (pool,
// user) whose bit the block can have moved: the block's own event-driven reads
// (the collateral events among them), every holder of a Mint / Burn /
// BalanceTransfer leg of one of the pool's reserve tokens — an aToken that is also
// a registry asset (GDOT) moves through the Substrate side, where the runtime sets
// the receiver's bit with no Aave event, but the token still logs the leg — and,
// on a configuration change, the whole market's config reads. So every change of
// the bit is observed at its block; the anchors loop seeds the users no block has
// read yet (src/scripts/collateralAnchor.ts).
//
// The health factor stored is the chain's getUserAccountData at that block, AS
// OBSERVED: nothing here computes, interpolates or carries one forward.
//
// Replay: the price comparison is against block b − 1 read from the chain and the
// cadence is an absolute chain-time grid (with b − 1's timestamp read when a worker
// starts on a block), so any worker that processes a block makes the same step and
// cadence decisions. The cohort differs by worker kind: raw-live holds an EXACT
// reserve holder index (seeded from atoken_scaled_anchor + the indexed deltas below
// its first block); a range worker, whose lower history may not be indexed yet,
// reads a SUPERSET (every account ever known to hold the reserve) — extra reads of
// accounts with nothing open write nothing.

import type { ClickHouseClient } from '../db/client.js'
import { crossedChainTimeBoundary } from '../util/chainTimeCadence.js'
import type { EthCallBatch } from './moneyMarket.js'
import {
  cadenceDueMarkets,
  MoneyMarketHolderIndex,
  openHoldersOfPool,
  openPositionKey,
  planTriggerReads,
  scaledLegsFromLog,
  triggerEvidence,
  type HolderIndexMode,
  type MoneyMarketCadence,
  type PlannedRead,
} from './moneyMarketSnapshot.js'
import { MoneyMarketPriceTracker, oraclePriceRows, type MoneyMarketOraclePriceRow, type PriceObservation } from './moneyMarketPrices.js'
import { toJsonString } from './json.js'
import type { RawEvmLogRow, RawMoneyMarketCollateralFlagRow, RawMoneyMarketPositionRow, RawParserWarningRow } from './types.js'

export type ReadPositions = (
  users: string[],
  blockHeight: number,
  blockTimestamp: string,
  ingestSource: string,
  options: {
    marketKeys: string[]
    tombstoneFor: ReadonlySet<string>
    evidenceFor: (poolProxy: string, userAddress: string) => Record<string, unknown>
    warningSourceKind: string
  },
) => Promise<{ positions: RawMoneyMarketPositionRow[]; warnings: RawParserWarningRow[] }>

/** getUserConfiguration of `users` in one pool at one block (snapshotMoneyMarketCollateralFlags). */
export type ReadCollateral = (
  users: string[],
  blockHeight: number,
  poolProxy: string,
) => Promise<{ flags: RawMoneyMarketCollateralFlagRow[]; failedUsers: string[] }>

export interface TriggerPhaseOptions {
  markets: ReadonlyArray<{ key: string; pool: string }>
  mode: HolderIndexMode
  thresholdBp100: bigint
  cadence: MoneyMarketCadence
  ethCall: EthCallBatch
  readPositions: ReadPositions
  readCollateral: ReadCollateral
}

export interface TriggerBlock {
  height: number
  timestamp: string
  timestampMs: number | null | undefined
  /** Block b − 1's timestamp; null when unknown (the phase then cannot fire cadence). */
  previousTimestampMs: number | null | undefined
  ingestSource: string
}

export interface TriggerPhaseResult {
  positions: RawMoneyMarketPositionRow[]
  warnings: RawParserWarningRow[]
  oraclePrices: MoneyMarketOraclePriceRow[]
  /** money_market_collateral_anchor rows: every reserve of each (pool, user) read. */
  collateral: RawMoneyMarketCollateralFlagRow[]
  stats: {
    steppedReserves: number
    configPools: number
    cadencePools: number
    planned: number
    priceCalls: number
    legs: number
    collateralReads: number
  }
}

export function cadenceFromEnvironment(env: NodeJS.ProcessEnv = process.env): MoneyMarketCadence {
  const minutes = (name: string, fallback: number): number => {
    const raw = env[name]?.trim()
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer number of minutes, got "${raw}"`)
    return value
  }
  return {
    allMinutes: minutes('RAW_MM_CADENCE_MINUTES', 60),
    marketMinutes: { gigahdx: minutes('RAW_MM_GIGAHDX_CADENCE_MINUTES', 5) },
  }
}

function collateralWarning(block: TriggerBlock, pool: string, user: string, reason: string): RawParserWarningRow {
  return {
    block_height: block.height,
    block_timestamp: block.timestamp,
    parser: 'raw_money_market',
    source_kind: 'collateral_snapshot',
    source_name: 'getUserConfiguration',
    source_index: `${pool}:${user}`,
    warning_code: 'collateral_eth_call_failed',
    warning: reason,
    evidence_json: toJsonString({ pool, user_address: user }),
    ingest_source: block.ingestSource,
  }
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * The (pool → users) whose usage-as-collateral bit the block can have moved: the
 * block's event-driven reads (`eventReads`, openPositionKey pairs), every holder of
 * a reserve-token leg the block's logs carry, and the market's config reads.
 */
export function collateralReadPlan(input: {
  pools: readonly string[]
  eventReads: ReadonlySet<string>
  legHolders: ReadonlyMap<string, ReadonlySet<string>>
  configReads: ReadonlyMap<string, Iterable<string>>
}): Map<string, string[]> {
  const byPool = new Map<string, Set<string>>(input.pools.map(pool => [pool.toLowerCase(), new Set<string>()]))
  const add = (pool: string, user: string): void => {
    const u = user.toLowerCase()
    if (u !== ZERO_ADDRESS) byPool.get(pool.toLowerCase())?.add(u)
  }
  for (const key of input.eventReads) {
    const at = key.indexOf(':')
    if (at > 0) add(key.slice(0, at), key.slice(at + 1))
  }
  for (const [pool, users] of input.legHolders) for (const user of users) add(pool, user)
  for (const [pool, users] of input.configReads) for (const user of users) add(pool, user)
  const out = new Map<string, string[]>()
  for (const [pool, users] of byPool) if (users.size > 0) out.set(pool, [...users].sort())
  return out
}

function oracleWarning(block: TriggerBlock, pool: string, reason: string): RawParserWarningRow {
  return {
    block_height: block.height,
    block_timestamp: block.timestamp,
    parser: 'raw_money_market',
    source_kind: 'oracle',
    source_name: 'getAssetsPrices',
    source_index: pool,
    warning_code: 'oracle_price_read_failed',
    warning: reason,
    evidence_json: toJsonString({ pool }),
    ingest_source: block.ingestSource,
  }
}

export class MoneyMarketTriggerPhase {
  readonly index: MoneyMarketHolderIndex
  private readonly tracker: MoneyMarketPriceTracker
  private readonly pools: string[]
  private readonly keyByPool: Map<string, string>
  private foldedThrough = -1

  constructor(private readonly options: TriggerPhaseOptions) {
    this.index = new MoneyMarketHolderIndex(options.mode)
    this.tracker = new MoneyMarketPriceTracker(options.markets, options.ethCall, options.thresholdBp100)
    this.pools = options.markets.map(m => m.pool.toLowerCase())
    this.keyByPool = new Map(options.markets.map(m => [m.pool.toLowerCase(), m.key]))
  }

  /**
   * The block's prices against b − 1 (and any re-resolve its configuration logs
   * ask for). Never throws: a failed read is a warning and no step.
   */
  async observe(block: TriggerBlock, logs: readonly RawEvmLogRow[]): Promise<PriceObservation | Error> {
    try {
      const observation = await this.tracker.observe(block.height, logs)
      for (const config of this.tracker.configsResolved()) {
        if (observation.resolved.has(config.pool)) this.index.setMarket(config.pool, config.reserveTokens)
      }
      return observation
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }

  /**
   * Fold the block's token logs, plan the reads and run them. `alreadyRead` is the
   * set of openPositionKey pairs the block's own events read already; `eventReads`
   * every pair its events named for a read, failed ones included (each gets its
   * collateral bitmap read here); `openPositions` the projection's open set
   * (tombstones and the raw-live cadence cohort).
   */
  async run(
    block: TriggerBlock,
    logs: readonly RawEvmLogRow[],
    observation: PriceObservation | Error,
    context: { alreadyRead: ReadonlySet<string>; eventReads: ReadonlySet<string>; openPositions: ReadonlySet<string> },
  ): Promise<TriggerPhaseResult> {
    const warnings: RawParserWarningRow[] = []
    // A block at or below one already folded (the processor re-delivering a batch)
    // is not folded again: an exact balance would count its deltas twice.
    const legs = block.height > this.foldedThrough ? this.index.apply(logs, block.height) : 0
    this.foldedThrough = Math.max(this.foldedThrough, block.height)
    let steps = new Map<string, string[]>()
    let configChanged = new Set<string>()
    if (observation instanceof Error) {
      for (const pool of this.pools) warnings.push(oracleWarning(block, pool, observation.message))
    } else {
      steps = observation.steps
      configChanged = observation.configChanged
      for (const [pool, reason] of observation.failed) warnings.push(oracleWarning(block, pool, reason))
    }

    const cadenceDue = cadenceDueMarkets(block.previousTimestampMs, block.timestampMs, this.options.markets, this.options.cadence, crossedChainTimeBoundary)
    const cohort = (pool: string): string[] => [...new Set([...openHoldersOfPool(context.openPositions, pool), ...this.index.holdersOfMarket(pool, block.height)])]
    const plan = planTriggerReads({
      pools: this.pools,
      configChanged,
      steps,
      cadenceDue,
      holdersOfReserve: (pool, reserve) => this.index.holdersOfReserve(pool, reserve, block.height),
      holdersOfMarket: pool => this.index.holdersOfMarket(pool, block.height),
      cadenceCohort: cohort,
      alreadyRead: context.alreadyRead,
    })

    const configReads = new Map<string, string[]>()
    for (const [pool, reads] of plan) {
      const users = [...reads].filter(([, read]) => read.triggers.has('config')).map(([user]) => user)
      if (users.length > 0) configReads.set(pool, users)
    }
    const collateralPlan = collateralReadPlan({ pools: this.pools, eventReads: context.eventReads, legHolders: this.legHolders(logs), configReads })
    const collateral: RawMoneyMarketCollateralFlagRow[] = []
    let collateralReads = 0
    const readCollateral = Promise.all([...collateralPlan].map(async ([pool, users]) => {
      collateralReads += users.length
      try {
        const result = await this.options.readCollateral(users, block.height, pool)
        collateral.push(...result.flags)
        for (const user of result.failedUsers) warnings.push(collateralWarning(block, pool, user, 'getUserConfiguration returned no word'))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        for (const user of users) warnings.push(collateralWarning(block, pool, user, reason))
      }
    }))

    const positions: RawMoneyMarketPositionRow[] = []
    let planned = 0
    await Promise.all([readCollateral, ...[...plan].map(async ([pool, reads]) => {
      const key = this.keyByPool.get(pool)
      if (key == null || reads.size === 0) return
      planned += reads.size
      const users = [...reads.keys()].sort()
      const result = await this.options.readPositions(users, block.height, block.timestamp, block.ingestSource, {
        marketKeys: [key],
        tombstoneFor: context.openPositions,
        evidenceFor: (_pool, user) => triggerEvidence(reads.get(user.toLowerCase()) ?? EMPTY_READ),
        warningSourceKind: 'trigger_snapshot',
      })
      positions.push(...result.positions)
      warnings.push(...result.warnings)
    })])
    positions.sort((a, b) => a.observation_id.localeCompare(b.observation_id))
    collateral.sort((a, b) => a.pool_address.localeCompare(b.pool_address) || a.user_address.localeCompare(b.user_address) || a.reserve_address.localeCompare(b.reserve_address))

    let oraclePrices: MoneyMarketOraclePriceRow[] = []
    if (!(observation instanceof Error)) {
      // Baselines: a market's first resolve or configuration change, and the
      // all-positions cadence block, so the latest price ≤ B is always within reach.
      const allCadence = this.options.cadence.allMinutes > 0 &&
        crossedChainTimeBoundary(block.previousTimestampMs, block.timestampMs, this.options.cadence.allMinutes * 60_000)
      const baseline = new Set([...observation.resolved, ...(allCadence ? this.pools : [])])
      oraclePrices = oraclePriceRows(block, this.tracker.configsResolved(), observation.previous, observation.prices, baseline)
    }

    let steppedReserves = 0
    for (const reserves of steps.values()) steppedReserves += reserves.length
    return {
      positions,
      warnings,
      oraclePrices,
      collateral,
      stats: {
        steppedReserves,
        configPools: configChanged.size,
        cadencePools: cadenceDue.size,
        planned,
        priceCalls: observation instanceof Error ? 0 : observation.calls,
        legs,
        collateralReads,
      },
    }
  }

  /** pool → every holder of a Mint / Burn / BalanceTransfer leg of one of its reserve tokens in these logs. */
  private legHolders(logs: readonly RawEvmLogRow[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>()
    for (const log of logs) {
      for (const leg of scaledLegsFromLog(log)) {
        for (const pool of this.index.poolsOfToken(leg.contract)) {
          let holders = out.get(pool)
          if (holders == null) out.set(pool, holders = new Set())
          holders.add(leg.holder)
        }
      }
    }
    return out
  }
}

const EMPTY_READ: PlannedRead = { triggers: new Set(['cadence']), reserves: new Set() }

/** The (pool, user) pairs one batch of position rows read. */
export function readPairs(rows: Iterable<Pick<RawMoneyMarketPositionRow, 'pool_address' | 'user_address'>>, into = new Set<string>()): Set<string> {
  for (const row of rows) if (row.user_address) into.add(openPositionKey(row.pool_address, row.user_address))
  return into
}

// ───────────────────────── holder-index seeds ─────────────────────────

const SEED_SETTINGS = { max_threads: 4, max_memory_usage: '3000000000', max_execution_time: 300 } as const

/**
 * EXACT seed: every (token, holder) scaled balance at the end of block
 * `beforeBlock − 1` — the B0 anchor (atoken_scaled_anchor, the chain's own
 * scaledBalanceOf at B0) plus every indexed delta after B0 and below `beforeBlock`
 * (atoken_scaled_deltas_by_contract, deduplicated with FINAL). The deltas after B0
 * are complete (conservation held to the wei for every live contract); below B0
 * they are not, so a block at or below B0 cannot be seeded exactly.
 */
export async function loadExactHolderSeed(client: ClickHouseClient, beforeBlock: number): Promise<Array<{ contract: string; holder: string; scaled: bigint }>> {
  const b0 = await client.query({ query: 'SELECT max(anchor_block) AS b0 FROM price_data.atoken_scaled_anchor', format: 'JSONEachRow', clickhouse_settings: SEED_SETTINGS })
  const anchorBlock = Number((await b0.json<{ b0: number | string }>())[0]?.b0 ?? 0)
  if (!(anchorBlock > 0) || beforeBlock <= anchorBlock + 1) {
    throw new Error(`exact holder seed needs a block above the scaled-balance anchor (B0 ${anchorBlock}), got ${beforeBlock}`)
  }
  const res = await client.query({
    query: `
      SELECT contract, holder, toString(sum(scaled)) AS scaled_balance FROM (
        SELECT lower(contract_address) AS contract, lower(holder) AS holder, toInt256(argMax(scaled_balance, updated_at)) AS scaled
        FROM price_data.atoken_scaled_anchor WHERE holder != '' GROUP BY contract, holder
        UNION ALL
        SELECT contract_address AS contract, holder, sum(scaled_delta) AS scaled
        FROM price_data.atoken_scaled_deltas_by_contract FINAL
        WHERE block_height > {b0:UInt32} AND block_height < {before:UInt32}
        GROUP BY contract, holder
      )
      GROUP BY contract, holder
      HAVING sum(scaled) != 0`,
    query_params: { b0: anchorBlock, before: beforeBlock },
    format: 'JSONEachRow',
    clickhouse_settings: SEED_SETTINGS,
  })
  return (await res.json<{ contract: string; holder: string; scaled_balance: string }>()).map(r => ({ contract: r.contract, holder: r.holder, scaled: BigInt(r.scaled_balance) }))
}

/**
 * SUPERSET seed: every account ever known to hold a token — the B0 anchor's
 * holders (from block 0: they held before B0, when is unknown) and every account
 * any indexed delta credited, from its first credit.
 */
export async function loadSupersetHolderSeed(client: ClickHouseClient): Promise<Array<{ contract: string; holder: string; firstBlock: number }>> {
  const res = await client.query({
    query: `
      SELECT contract, holder, min(first_block) AS first_block FROM (
        SELECT lower(contract_address) AS contract, lower(holder) AS holder, toUInt32(0) AS first_block
        FROM price_data.atoken_scaled_anchor WHERE holder != ''
        UNION ALL
        SELECT contract_address AS contract, holder, min(block_height) AS first_block
        FROM price_data.atoken_scaled_deltas_by_contract
        WHERE scaled_delta > 0
        GROUP BY contract, holder
      )
      GROUP BY contract, holder`,
    format: 'JSONEachRow',
    clickhouse_settings: SEED_SETTINGS,
  })
  return (await res.json<{ contract: string; holder: string; first_block: number | string }>()).map(r => ({ contract: r.contract, holder: r.holder, firstBlock: Number(r.first_block) }))
}
