// Money-market usage-as-collateral SEED (money_market_collateral_anchor), one port
// of the anchors loop (anchorLoop.ts, the `atoken-anchor` service).
//
// The raw indexer reads a user's getUserConfiguration at every block that can move
// one of its collateral bits (moneyMarketTriggerPhase.ts: the user's own money-
// market events, a leg of one of the pool's reserve tokens, a configuration change)
// and writes a row per reserve of the pool. A (user, pool) read once at or after B0
// therefore stays current: below B0 the EVM-log coverage is partial, so a block
// there can have moved a bit with no trigger, and an observation below B0 does not
// count. What no block has read yet — a bit set before the indexed range with no
// event since, a user whose collateral was enabled through the Substrate side — is
// read here: every candidate (user, pool) without an anchor row at or above B0 is
// read at ONE pinned block (min(indexed head, finalized head)), every reserve of
// the pool written, enabled or not. On a fresh database that is every candidate
// (the full enumeration); in steady state, the candidates first named since the
// last cycle. A dry run reads every candidate and writes nothing.
//
// Candidates: every holder the position projection shows open in the pool, and
// every user any collateral event of the pool names (a bit can stand enabled after
// the position closed, and only a read can take it back).

import { BOUNDED_QUERY_SETTINGS, type ClickHouseClient } from '../db/client.js'
import { snapshotMoneyMarketCollateralFlags } from '../raw/moneyMarket.js'
import { openPositionKey } from '../raw/moneyMarketSnapshot.js'
import type { RawMoneyMarketCollateralFlagRow } from '../raw/types.js'
import type { AnchorMode } from './atokenAnchor.js'

/** A (pool, user) pair, both lowercase. */
export interface CollateralPair {
  pool: string
  user: string
}

/**
 * The users to read per pool: every candidate of a known pool under 'full'; under
 * 'top-up' only those with no anchor row at or above B0 (`covered`, openPositionKey).
 */
export function collateralPairsToRead(
  candidates: readonly CollateralPair[],
  covered: ReadonlySet<string>,
  pools: readonly string[],
  mode: AnchorMode,
): Map<string, string[]> {
  const known = new Set(pools.map(pool => pool.toLowerCase()))
  const byPool = new Map<string, Set<string>>()
  for (const { pool, user } of candidates) {
    const p = pool.toLowerCase()
    const u = user.toLowerCase()
    if (!known.has(p) || !/^0x[0-9a-f]{40}$/.test(u)) continue
    if (mode === 'top-up' && covered.has(openPositionKey(p, u))) continue
    let users = byPool.get(p)
    if (users == null) byPool.set(p, users = new Set())
    users.add(u)
  }
  return new Map([...byPool].map(([pool, users]) => [pool, [...users].sort()]))
}

const CANDIDATES_SQL = `
  SELECT DISTINCT lower(pool_address) AS pool, lower(user_address) AS user FROM (
    SELECT pool_address, user_address FROM (
      SELECT pool_address, user_address, argMaxMerge(position_state) AS pos
      FROM price_data.money_market_latest_positions
      WHERE user_address != ''
      GROUP BY pool_address, user_address
    ) WHERE tupleElement(pos, 'total_collateral_base') > 0 OR tupleElement(pos, 'total_debt_base') > 0
    UNION ALL
    SELECT pool_address, user_address FROM price_data.money_market_collateral_flags
  )
  WHERE match(user_address, '^0x[0-9a-fA-F]{40}$')`

const COVERED_SQL = `
  SELECT DISTINCT lower(pool_address) AS pool, lower(user_address) AS user
  FROM price_data.money_market_collateral_anchor
  WHERE block_height >= {b0:UInt32}`

const INSERT_BATCH = 5_000

export function createCollateralAnchorJob(deps: {
  client: ClickHouseClient
  anchorBlock: number
  pools: readonly string[]
  /** The block every read of a cycle is pinned to: min(indexed head, finalized head). */
  pinnedBlock: () => Promise<number>
  readCollateral?: (users: string[], blockHeight: number, poolProxy: string) => Promise<{ flags: RawMoneyMarketCollateralFlagRow[]; failedUsers: string[] }>
  log?: (record: Record<string, unknown>) => void
}) {
  const read = deps.readCollateral ?? ((users, blockHeight, poolProxy) => snapshotMoneyMarketCollateralFlags(users, blockHeight, poolProxy))
  const log = deps.log ?? (record => console.log(JSON.stringify(record)))
  const pairs = async (query: string): Promise<CollateralPair[]> => {
    const res = await deps.client.query({ query, query_params: { b0: deps.anchorBlock }, format: 'JSONEachRow', clickhouse_settings: BOUNDED_QUERY_SETTINGS })
    return res.json<CollateralPair>()
  }

  return {
    async capture(options: { dryRun: boolean; mode: AnchorMode }): Promise<void> {
      const startedAt = Date.now()
      const [candidates, covered] = await Promise.all([pairs(CANDIDATES_SQL), pairs(COVERED_SQL)])
      const coveredKeys = new Set(covered.map(pair => openPositionKey(pair.pool, pair.user)))
      const toRead = collateralPairsToRead(candidates, coveredKeys, deps.pools, options.mode)
      const users = [...toRead.values()].reduce((sum, list) => sum + list.length, 0)
      if (users === 0) {
        log({ type: 'mm_collateral_anchor_done', mode: options.mode, dry_run: options.dryRun, candidates: candidates.length, read: 0 })
        return
      }
      const block = await deps.pinnedBlock()
      const markets: Array<{ pool: string; read: number; rows: number; failed: number }> = []
      for (const [pool, list] of toRead) {
        const { flags, failedUsers } = await read(list, block, pool)
        if (!options.dryRun) {
          for (let i = 0; i < flags.length; i += INSERT_BATCH) {
            await deps.client.insert({ table: 'price_data.money_market_collateral_anchor', values: flags.slice(i, i + INSERT_BATCH), format: 'JSONEachRow' })
          }
        }
        markets.push({ pool, read: list.length, rows: flags.length, failed: failedUsers.length })
      }
      log({
        type: 'mm_collateral_anchor_done', mode: options.mode, dry_run: options.dryRun, block, candidates: candidates.length, read: users, markets,
        seconds: Math.round((Date.now() - startedAt) / 1000),
      })
    },
  }
}
