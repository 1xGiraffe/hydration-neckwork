import { RpcClient } from '@subsquid/rpc-client'
import { createClickHouseClient } from '../db/client.js'
import { config } from '../config.js'
import { toClickHouseDateTime } from '../raw/json.js'
import { moneyMarketDefinitions, snapshotMoneyMarketCollateralFlags, snapshotMoneyMarketPositions, type MoneyMarketRuntimeDef } from '../raw/moneyMarket.js'
import { isZeroPosition, moneyMarketSweepHasNoSuccess, openPositionKey } from '../raw/moneyMarketSnapshot.js'
import { hasFlag, integerOption, stringOption } from '../util/cliArgs.js'

// Full money-market position sweep.
//
// The event-driven indexer + per-borrower periodic snapshots only know accounts
// that have ALREADY been seen acting in the money market within the indexed range.
// An account with an open position whose opening event hasn't been backfilled yet
// (or predates the window) therefore has no indexed position — so the Accounts
// list shows no health factor for it until backfill reaches it.
//
// This sweep closes that gap. The primary market retains the exhaustive strategy:
// read EVERY known account seeded by the balance snapshot. Secondary markets that
// launched within complete raw-EVM coverage instead sweep only addresses observed
// in their own contracts. This gives immediate coverage without multiplying the
// dominant all-account RPC workload. Zero positions are skipped (Aave returns
// zeroed totals for non-users) EXCEPT for a holder whose projected aggregate is
// still non-zero: that zero is the exit, written as a tombstone so the projection
// closes the position. A position emptied by a native aToken transfer has no pool
// event, so the sweeps are the only observers of that exit — every such holder is
// therefore re-read each cycle whether or not the balance snapshot named it. The
// bounded secondary sweep writes every zero instead, so an account that fully
// exits cannot retain a stale last position while raw-live remains on an older
// image.
//
// Usage:
//   npx tsx src/scripts/snapshot-money-market.ts [--dry-run] [--loop] [--refresh-hours=6]
//   npx tsx src/scripts/snapshot-money-market.ts --market=gigahdx
//   npx tsx src/scripts/snapshot-money-market.ts --market=gigahdx,bil --loop --refresh-minutes=15
//   npx tsx src/scripts/snapshot-money-market.ts --collateral-only
//
// Each sweep also re-reads the usage-as-collateral bitmap for the market's
// position holders (money_market_collateral_anchor), which the explorer merges
// with the pool's own Enabled/Disabled events. --collateral-only does that half
// alone, without the exhaustive getUserAccountData pass.

interface BlockHeader { number: string }

const dryRun = hasFlag('dry-run')
const loop = hasFlag('loop')
const collateralOnly = hasFlag('collateral-only')
const refreshHours = integerOption('refresh-hours', 6)
const refreshMinutes = integerOption('refresh-minutes', 0)
const insertBatch = integerOption('insert-batch', 5_000)
// One key, or a comma-separated list so a single supplemental worker can sweep
// every sparse market (--market=gigahdx,bil) without duplicating the container.
const requestedMarket = stringOption('market')
const requestedMarketKeys = requestedMarket == null
  ? null
  : new Set(requestedMarket.split(',').map(key => key.trim()).filter(key => key !== ''))

const client = createClickHouseClient()
const rpc = new RpcClient({
  url: config.RPC_URL,
  capacity: Math.max(1, Math.min(config.RPC_CAPACITY, 20)),
  rateLimit: Math.max(1, config.RPC_RATE_LIMIT),
  requestTimeout: 60_000,
})

async function chainHead(): Promise<number> {
  const hash = await rpc.call<string>('chain_getFinalizedHead', [])
  const header = await rpc.call<BlockHeader>('chain_getHeader', [hash])
  return Number.parseInt(header.number, 16)
}

// An account's money-market H160 (where getUserAccountData is keyed): the embedded
// H160 for an already-EVM-truncated AccountId, else the account's first 20 bytes.
// Module accounts (modl…) are never MM users — skip them.
function mmH160(accountId: string): string | null {
  const id = accountId.toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(id)) return null
  if (id.slice(2, 10) === '45544800' && id.slice(50) === '0000000000000000') return `0x${id.slice(10, 50)}`
  if (id.slice(2, 10) === '6d6f646c') return null
  return `0x${id.slice(2, 42)}`
}

async function loadAllAccounts(): Promise<string[]> {
  const res = await client.query({
    query: `SELECT DISTINCT account_id FROM price_data.raw_balance_observations WHERE account_id != ''`,
    format: 'JSONEachRow',
  })
  return (await res.json<{ account_id: string }>()).map(r => r.account_id)
}

// Secondary markets launched after raw EVM coverage began, so their complete
// candidate set is the small set of addresses seen in their own pool/a-token
// logs (plus any already-materialised position). This avoids multiplying the
// expensive full-account sweep for a market used by only a few hundred accounts.
async function loadKnownMarketParticipants(market: MoneyMarketRuntimeDef): Promise<string[]> {
  // Reserve token contracts are discovered on-chain by atoken-anchor and are
  // market-specific even when the underlying asset (HOLLAR) is shared. Include
  // them here so a direct aToken transfer recipient is not missed merely because
  // they never called the pool proxy themselves.
  const reserveTokenResult = await client.query({
    query: `SELECT
              argMax(atoken, updated_at) AS atoken,
              argMax(vdebt, updated_at) AS vdebt
            FROM price_data.atoken_reserve_map
            WHERE lower(pool_proxy) = {pool:String}
            GROUP BY asset_address`,
    query_params: { pool: market.poolProxy },
    format: 'JSONEachRow',
  })
  const reserveTokens = await reserveTokenResult.json<{ atoken: string; vdebt: string }>()
  const contracts = [...new Set([
    ...market.contracts,
    ...reserveTokens.flatMap(row => [row.atoken, row.vdebt]),
  ].map(contract => contract.toLowerCase()).filter(contract => /^0x[0-9a-f]{40}$/.test(contract)))]
  const res = await client.query({
    query: `SELECT DISTINCT lower(h) AS h FROM (
              SELECT arrayJoin(participants) AS h
              FROM price_data.raw_evm_logs
              WHERE contract_address IN ({contracts:Array(String)})
              UNION ALL
              SELECT user_address AS h
              FROM price_data.raw_money_market_positions
              WHERE pool_address = {pool:String}
            )
            WHERE match(h, '^0x[0-9a-fA-F]{40}$')
              AND h != '0x0000000000000000000000000000000000000000'`,
    query_params: { contracts, pool: market.poolProxy },
    format: 'JSONEachRow',
  })
  return (await res.json<{ h: string }>()).map(row => row.h.toLowerCase())
}

// Holders whose projected aggregate in this market is currently non-zero — the
// positions the explorer shows as open. Each of them is re-read every sweep, and
// a zero read for one of them is written (see snapshotMoneyMarketPositions'
// `tombstoneFor`): it is the exit nothing else will ever record.
const OPEN_HOLDERS_SQL = `
  SELECT user_address FROM (
    SELECT user_address, argMaxMerge(position_state) AS pos
    FROM price_data.money_market_latest_positions
    WHERE pool_address = {pool:String}
    GROUP BY user_address
  ) WHERE tupleElement(pos, 'total_collateral_base') > 0 OR tupleElement(pos, 'total_debt_base') > 0`

async function loadOpenPositionHolders(poolProxy: string): Promise<string[]> {
  const res = await client.query({
    query: `SELECT user_address FROM (${OPEN_HOLDERS_SQL}) WHERE match(user_address, '^0x[0-9a-fA-F]{40}$')`,
    query_params: { pool: poolProxy },
    format: 'JSONEachRow',
  })
  return (await res.json<{ user_address: string }>()).map(row => row.user_address.toLowerCase())
}

// Who needs their usage-as-collateral bitmap re-read for this market: everyone
// holding a live position, plus everyone the pool ever emitted a collateral event
// for. The second half matters in the retracting direction — a bit cleared without
// an event (a native aToken transfer) leaves a stale Enabled standing, and only a
// fresh read of the word can take it back.
async function loadCollateralCandidates(poolProxy: string): Promise<string[]> {
  const res = await client.query({
    query: `
      SELECT DISTINCT user_address FROM (
        ${OPEN_HOLDERS_SQL}
        UNION ALL
        SELECT DISTINCT user_address FROM price_data.money_market_collateral_flags WHERE pool_address = {pool:String}
      )
      WHERE match(user_address, '^0x[0-9a-fA-F]{40}$')`,
    query_params: { pool: poolProxy },
    format: 'JSONEachRow',
  })
  return (await res.json<{ user_address: string }>()).map(row => row.user_address.toLowerCase())
}

// Re-read the collateral bitmap for one market and replace those users' anchor
// rows. Separate from the position sweep because it is cheap (one word per user
// over a few thousand users, against getUserAccountData for every account on the
// chain) and because a failure here must not discard a completed position sweep.
async function refreshCollateralAnchor(market: MoneyMarketRuntimeDef, head: number): Promise<{ market: string; users: number; rows: number; failed: number }> {
  const candidates = await loadCollateralCandidates(market.poolProxy)
  if (!candidates.length) return { market: market.key, users: 0, rows: 0, failed: 0 }
  const { flags, failedUsers } = await snapshotMoneyMarketCollateralFlags(candidates, head, market.poolProxy)
  if (!dryRun && flags.length) {
    for (let i = 0; i < flags.length; i += insertBatch) {
      await client.insert({
        table: 'price_data.money_market_collateral_anchor',
        values: flags.slice(i, i + insertBatch),
        format: 'JSONEachRow',
      })
    }
  }
  return { market: market.key, users: candidates.length, rows: flags.length, failed: failedUsers.length }
}

async function accountCount(): Promise<number> {
  const res = await client.query({
    query: `SELECT uniqExact(account_id) AS c FROM price_data.raw_balance_observations WHERE account_id != ''`,
    format: 'JSONEachRow',
  })
  return Number((await res.json<{ c: string }>())[0]?.c ?? 0)
}

// Wait for the balance snapshot to finish seeding accounts so the first sweep runs
// against the full set (counts stop climbing between polls), bounded by a max wait.
async function waitForAccountsSeeded(): Promise<void> {
  let previous = -1
  for (let i = 0; i < 90; i++) {
    const count = await accountCount()
    if (count > 1000 && count === previous) return
    previous = count
    await new Promise(resolve => setTimeout(resolve, 20_000))
  }
}

async function runOnce(): Promise<void> {
  const head = await chainHead()
  const timestamp = toClickHouseDateTime(Date.now())
  const allMarkets = moneyMarketDefinitions()
  const markets = requestedMarketKeys == null ? allMarkets : allMarkets.filter(market => requestedMarketKeys.has(market.key))
  if (!markets.length || (requestedMarketKeys != null && markets.length !== requestedMarketKeys.size)) {
    throw new Error(`unknown money market: ${requestedMarket}`)
  }
  // Anchor-only mode re-reads the collateral bitmaps without the exhaustive
  // position sweep behind them — the cheap half, for a rollout or a repair.
  if (collateralOnly) {
    const anchors = []
    for (const market of markets) anchors.push(await refreshCollateralAnchor(market, head))
    console.log(JSON.stringify({ type: 'mm_collateral_anchor_done', dry_run: dryRun, anchor_block: head, markets: anchors }, null, 2))
    return
  }

  const primary = markets.find(market => market.key === 'core')
  const accounts = primary ? await loadAllAccounts() : []
  const h160s: string[] = []
  for (const accountId of accounts) {
    const h = mmH160(accountId)
    if (h != null) h160s.push(h)
  }
  const startedAt = Date.now()
  console.log(JSON.stringify({ type: 'mm_sweep_start', dry_run: dryRun, anchor_block: head, accounts: accounts.length, primary_candidates: h160s.length, rpc_url: config.RPC_URL }))

  let positionsFound = 0
  let inserted = 0
  let warningCount = 0
  const marketStats: Array<{ market: string; candidates: number; positions: number; zeros: number; warnings: number }> = []
  const zeroCount = (positions: Awaited<ReturnType<typeof snapshotMoneyMarketPositions>>['positions']): number =>
    positions.filter(isZeroPosition).length

  async function insertPositions(positions: Awaited<ReturnType<typeof snapshotMoneyMarketPositions>>['positions']): Promise<number> {
    if (dryRun) return 0
    let count = 0
    for (let i = 0; i < positions.length; i += insertBatch) {
      const rows = positions.slice(i, i + insertBatch)
      await client.insert({
        table: 'price_data.raw_money_market_positions',
        values: rows,
        format: 'JSONEachRow',
      })
      count += rows.length
    }
    return count
  }

  // Preserve the existing exhaustive candidate strategy for the primary market,
  // plus every holder the projection still shows open: those are read whether or
  // not the balance snapshot named them, and a zero for one of them is written.
  if (primary) {
    const openHolders = await loadOpenPositionHolders(primary.poolProxy)
    const candidates = [...new Set([...h160s, ...openHolders])]
    const tombstoneFor = new Set(openHolders.map(holder => openPositionKey(primary.poolProxy, holder)))
    const primaryResult = await snapshotMoneyMarketPositions(candidates, head, timestamp, 'rpc', { marketKeys: [primary.key], tombstoneFor })
    if (moneyMarketSweepHasNoSuccess(primaryResult.positions.length, primaryResult.warnings.length)) {
      throw new Error(`primary money-market sweep produced no successful positions (${primaryResult.warnings.length} RPC warnings)`)
    }
    positionsFound += primaryResult.positions.length
    warningCount += primaryResult.warnings.length
    inserted += await insertPositions(primaryResult.positions)
    marketStats.push({ market: primary.key, candidates: candidates.length, positions: primaryResult.positions.length, zeros: zeroCount(primaryResult.positions), warnings: primaryResult.warnings.length })
  }

  // Supplemental markets are independent and sparse. A failure in one must not
  // discard or delay the already-completed primary sweep.
  for (const market of markets.filter(candidate => candidate.key !== 'core')) {
    try {
      const participants = await loadKnownMarketParticipants(market)
      const result = await snapshotMoneyMarketPositions(participants, head, timestamp, 'rpc', {
        marketKeys: [market.key],
        includeZeroPositions: true,
      })
      if (moneyMarketSweepHasNoSuccess(result.positions.length, result.warnings.length)) {
        throw new Error(`supplemental market ${market.key} produced no successful positions (${result.warnings.length} RPC warnings)`)
      }
      positionsFound += result.positions.length
      warningCount += result.warnings.length
      inserted += await insertPositions(result.positions)
      marketStats.push({ market: market.key, candidates: participants.length, positions: result.positions.length, zeros: zeroCount(result.positions), warnings: result.warnings.length })
    } catch (error) {
      console.error(`[mm-snapshot] supplemental market ${market.key} failed:`, error)
      // A dedicated supplemental worker has no other useful work to preserve.
      // Propagate so its loop uses the short failure-retry delay.
      if (markets.length === 1) throw error
    }
  }

  // After the sweep, so a market that only just materialised a position is
  // included. Its own failure leaves the position rows already inserted intact.
  const collateralAnchors = []
  for (const market of markets) {
    try {
      collateralAnchors.push(await refreshCollateralAnchor(market, head))
    } catch (error) {
      console.error(`[mm-snapshot] collateral anchor for ${market.key} failed:`, error)
    }
  }

  console.log(JSON.stringify({
    type: 'mm_sweep_done',
    dry_run: dryRun,
    anchor_block: head,
    primary_candidates: h160s.length,
    collateral_anchors: collateralAnchors,
    positions_found: positionsFound,
    rows_inserted: inserted,
    warnings: warningCount,
    markets: marketStats,
    seconds: Math.round((Date.now() - startedAt) / 1000),
  }, null, 2))
}

async function main(): Promise<void> {
  if (!loop) {
    await runOnce()
    return
  }
  // Service mode: let the balance snapshot seed accounts first, sweep, then repeat.
  if (requestedMarketKeys == null || requestedMarketKeys.has('core')) await waitForAccountsSeeded()
  const intervalMs = refreshMinutes > 0
    ? Math.max(5, refreshMinutes) * 60_000
    : Math.max(1, refreshHours) * 3_600_000
  for (;;) {
    let delayMs = intervalMs
    try {
      await runOnce()
    } catch (error) {
      console.error(error)
      // Startup DNS/RPC availability is often transient; do not turn one failed
      // first attempt into a full refresh-interval data gap.
      delayMs = Math.min(intervalMs, 30_000)
    }
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    if (loop) return
    await client.close()
    rpc.close()
  })
