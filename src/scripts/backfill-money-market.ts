import { createClickHouseClient } from '../db/client.js'
import { RawClickHouseStore } from '../raw/store.js'
import { extractMoneyMarketRows, moneyMarketDefinitions, moneyMarketKeys } from '../raw/moneyMarket.js'
import type { RawEvmLogRow } from '../raw/types.js'
import { hasFlag, optionalIntegerOption, stringOption } from '../util/cliArgs.js'

// Re-derive money-market rows (events / reserves / positions) from the raw EVM log
// lake — no chain or gateway re-ingestion. Because raw_evm_logs captures EVERY EVM
// log unconditionally, configured market history can be projected into the derived
// tables without re-ingesting the chain. Idempotent: the derived tables are
// ReplacingMergeTree(ingested_at), so a re-run replaces rather than duplicates.
//
// Events + reserves are a pure transform (no RPC). Positions require historical
// getUserAccountData eth_calls against the market's pool, so they hit a full-archive
// node — throttle with RAW_MONEY_MARKET_POSITION_CONCURRENCY / _BATCH_SIZE. Use
// --events-only for the cheap part, or run positions separately.
//
// Configure extra markets via RAW_MM_EXTRA_MARKETS (same as the live indexer), then:
//   npx tsx src/scripts/backfill-money-market.ts --from-block=N --to-block=M \
//     [--market=gigahdx] [--events-only] [--apply] [--verify] [--block-chunk-size=500]

const client = createClickHouseClient()

async function query<T>(queryText: string): Promise<T[]> {
  const result = await client.query({ query: queryText, format: 'JSONEachRow' })
  return result.json<T>()
}

async function fetchEvmLogs(fromBlock: number, toBlock: number): Promise<RawEvmLogRow[]> {
  return query<RawEvmLogRow>(`
    SELECT
      block_height, block_timestamp, event_index, extrinsic_index, call_address,
      contract_address, topic0, topics, data, decode_status, event_signature,
      event_name, decoded_args_json, participants, assets, warning, raw_log_json,
      ingest_source
    FROM price_data.raw_evm_logs FINAL
    WHERE block_height >= ${fromBlock} AND block_height <= ${toBlock}
    ORDER BY block_height, event_index
  `)
}

// Compare re-derived events/reserves against what's already stored for the range,
// by the ReplacingMergeTree dedup key (block_height, event_index, event_name). A
// pure-transform re-derivation of the SAME market should reproduce the stored set
// exactly — a non-zero diff means the projection logic changed (or the market
// scope differs).
async function verifyRange(
  fromBlock: number,
  toBlock: number,
  poolAddress: string | null,
  derivedEventKeys: Set<string>,
  derivedReserveKeys: Set<string>,
): Promise<boolean> {
  const poolFilter = poolAddress == null ? '' : `AND pool_address = '${poolAddress}'`
  const ev = await query<{ k: string }>(`
    SELECT concat(toString(block_height), ':', toString(event_index), ':', event_name) AS k
    FROM price_data.raw_money_market_events FINAL
    WHERE block_height >= ${fromBlock} AND block_height <= ${toBlock}
      ${poolFilter}
  `)
  const rs = await query<{ k: string }>(`
    SELECT concat(toString(block_height), ':', toString(event_index), ':', event_name) AS k
    FROM price_data.raw_money_market_reserves FINAL
    WHERE block_height >= ${fromBlock} AND block_height <= ${toBlock}
      ${poolFilter}
  `)
  const storedEvents = new Set(ev.map(r => r.k))
  const storedReserves = new Set(rs.map(r => r.k))
  const diff = (a: Set<string>, b: Set<string>) => [...a].filter(k => !b.has(k))
  const report = (label: string, derived: Set<string>, stored: Set<string>): boolean => {
    const missing = diff(derived, stored)   // re-derived but not stored
    const extra = diff(stored, derived)      // stored but not re-derived
    console.log(JSON.stringify({
      check: label, derived: derived.size, stored: stored.size,
      only_in_derived: missing.length, only_in_stored: extra.length,
      sample_only_in_derived: missing.slice(0, 5), sample_only_in_stored: extra.slice(0, 5),
      match: missing.length === 0 && extra.length === 0,
    }))
    return missing.length === 0 && extra.length === 0
  }
  const eventsMatch = report('events', derivedEventKeys, storedEvents)
  const reservesMatch = report('reserves', derivedReserveKeys, storedReserves)
  return eventsMatch && reservesMatch
}

async function main(): Promise<void> {
  const fromBlock = optionalIntegerOption('from-block')
  const toBlock = optionalIntegerOption('to-block')
  const marketKey = stringOption('market') ?? null
  const eventsOnly = hasFlag('events-only')
  const apply = hasFlag('apply')
  if (apply && hasFlag('dry-run')) throw new Error('Use either --apply or --dry-run, not both')
  const dryRun = !apply
  const verify = hasFlag('verify')
  const chunkSize = optionalIntegerOption('block-chunk-size') ?? 500

  if (fromBlock == null || toBlock == null || toBlock < fromBlock) {
    console.error('usage: --from-block=N --to-block=M (M>=N) [--market=key] [--events-only] [--apply] [--verify] [--block-chunk-size=500]')
    process.exit(2)
  }
  const knownMarkets = moneyMarketKeys()
  if (marketKey != null && !knownMarkets.includes(marketKey)) {
    console.error(`unknown --market=${marketKey}; configured markets: ${knownMarkets.join(', ')} (set RAW_MM_EXTRA_MARKETS for extra markets)`)
    process.exit(2)
  }
  if (chunkSize <= 0) throw new Error('--block-chunk-size must be greater than zero')
  const selectedMarket = marketKey == null
    ? null
    : moneyMarketDefinitions().find(market => market.key === marketKey) ?? null

  console.log(JSON.stringify({
    from_block: fromBlock, to_block: toBlock, market: marketKey ?? 'all',
    configured_markets: knownMarkets, events_only: eventsOnly, dry_run: dryRun, verify,
  }))

  const namespace = `mm-backfill-${marketKey ?? 'all'}`
  const store = new RawClickHouseStore(client, 10_000, namespace)
  const marketKeys = marketKey == null ? undefined : [marketKey]
  const derivedEventKeys = new Set<string>()
  const derivedReserveKeys = new Set<string>()
  let totalEvents = 0, totalReserves = 0, totalPositions = 0, totalWarnings = 0

  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock)
    const startedAt = Date.now()
    const logs = await fetchEvmLogs(start, end)
    const extracted = await extractMoneyMarketRows(logs, 'sqd', { marketKeys, skipPositions: eventsOnly })

    for (const e of extracted.events) derivedEventKeys.add(`${e.block_height}:${e.event_index}:${e.event_name}`)
    for (const r of extracted.reserves) derivedReserveKeys.add(`${r.block_height}:${r.event_index}:${r.event_name}`)
    totalEvents += extracted.events.length
    totalReserves += extracted.reserves.length
    totalPositions += extracted.positions.length
    totalWarnings += extracted.warnings.length

    if (!dryRun) {
      store.addMoneyMarketEvents(extracted.events)
      store.addMoneyMarketReserves(extracted.reserves)
      if (!eventsOnly) store.addMoneyMarketPositions(extracted.positions)
      store.addParserWarnings(extracted.warnings)
      await store.flushMoneyMarketEvents()
      await store.flushMoneyMarketReserves()
      if (!eventsOnly) await store.flushMoneyMarketPositions()
      await store.flushParserWarnings()
    }

    console.log(JSON.stringify({
      from_block: start, to_block: end, logs: logs.length,
      events: extracted.events.length, reserves: extracted.reserves.length,
      positions: extracted.positions.length, warnings: extracted.warnings.length,
      ms: Date.now() - startedAt,
    }))
  }

  console.log(JSON.stringify({
    done: true, total_events: totalEvents, total_reserves: totalReserves,
    total_positions: totalPositions, total_warnings: totalWarnings, dry_run: dryRun,
  }))

  if (verify) {
    const matches = await verifyRange(
      fromBlock,
      toBlock,
      selectedMarket?.poolProxy ?? null,
      derivedEventKeys,
      derivedReserveKeys,
    )
    if (!matches) process.exitCode = 1
  }
}

main()
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => {
    client.close()
  })
