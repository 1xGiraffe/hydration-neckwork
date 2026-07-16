import { RpcClient } from '@subsquid/rpc-client'
import { createClickHouseClient } from '../db/client.js'
import { config } from '../config.js'
import { toClickHouseDateTime } from '../raw/json.js'
import { moneyMarketDefinitions, snapshotMoneyMarketPositions, type MoneyMarketRuntimeDef } from '../raw/moneyMarket.js'
import { moneyMarketSweepHasNoSuccess } from '../raw/moneyMarketSnapshot.js'
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
// zeroed totals for non-users). The bounded secondary sweep also writes zero
// tombstones so an account that fully exits cannot retain a stale last position
// while raw-live remains on an older image.
//
// Usage:
//   npx tsx src/scripts/snapshot-money-market.ts [--dry-run] [--loop] [--refresh-hours=6]
//   npx tsx src/scripts/snapshot-money-market.ts --market=gigahdx
//   npx tsx src/scripts/snapshot-money-market.ts --market=gigahdx --loop --refresh-minutes=15

interface BlockHeader { number: string }

const dryRun = hasFlag('dry-run')
const loop = hasFlag('loop')
const refreshHours = integerOption('refresh-hours', 6)
const refreshMinutes = integerOption('refresh-minutes', 0)
const insertBatch = integerOption('insert-batch', 5_000)
const requestedMarket = stringOption('market')

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
  const markets = requestedMarket == null ? allMarkets : allMarkets.filter(market => market.key === requestedMarket)
  if (!markets.length) throw new Error(`unknown money market: ${requestedMarket}`)
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
  const marketStats: Array<{ market: string; candidates: number; positions: number; warnings: number }> = []

  async function insertPositions(marketKey: string, positions: Awaited<ReturnType<typeof snapshotMoneyMarketPositions>>['positions']): Promise<number> {
    if (dryRun) return 0
    let count = 0
    for (let i = 0; i < positions.length; i += insertBatch) {
      const rows = positions.slice(i, i + insertBatch)
      await client.insert({
        table: 'price_data.raw_money_market_positions',
        values: rows,
        format: 'JSONEachRow',
        clickhouse_settings: { insert_deduplication_token: `mm-sweep-${marketKey}-${head}-${i}-${rows.length}` },
      })
      count += rows.length
    }
    return count
  }

  // Preserve the existing exhaustive candidate strategy for the primary market.
  if (primary) {
    const primaryResult = await snapshotMoneyMarketPositions(h160s, head, timestamp, 'rpc', { marketKeys: [primary.key] })
    if (moneyMarketSweepHasNoSuccess(primaryResult.positions.length, primaryResult.warnings.length)) {
      throw new Error(`primary money-market sweep produced no successful positions (${primaryResult.warnings.length} RPC warnings)`)
    }
    positionsFound += primaryResult.positions.length
    warningCount += primaryResult.warnings.length
    inserted += await insertPositions(primary.key, primaryResult.positions)
    marketStats.push({ market: primary.key, candidates: h160s.length, positions: primaryResult.positions.length, warnings: primaryResult.warnings.length })
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
      inserted += await insertPositions(market.key, result.positions)
      marketStats.push({ market: market.key, candidates: participants.length, positions: result.positions.length, warnings: result.warnings.length })
    } catch (error) {
      console.error(`[mm-snapshot] supplemental market ${market.key} failed:`, error)
      // A dedicated supplemental worker has no other useful work to preserve.
      // Propagate so its loop uses the short failure-retry delay.
      if (markets.length === 1) throw error
    }
  }

  console.log(JSON.stringify({
    type: 'mm_sweep_done',
    dry_run: dryRun,
    anchor_block: head,
    primary_candidates: h160s.length,
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
  if (requestedMarket == null || requestedMarket === 'core') await waitForAccountsSeeded()
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
