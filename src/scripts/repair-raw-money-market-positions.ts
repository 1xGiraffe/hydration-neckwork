import { createClickHouseClient, type ClickHouseClient } from '../db/client.js'
import { RawClickHouseStore } from '../raw/store.js'
import { extractMoneyMarketRows } from '../raw/moneyMarket.js'
import type { RawEvmLogRow } from '../raw/types.js'
import { hasFlag, optionalIntegerOption } from '../util/cliArgs.js'
import { chunk } from '../util/collections.js'

// Replays failed money-market position reads from indexed EVM logs. The command
// is dry-run by default, requires a bounded range, and mutates only with --apply:
//   npm run repair:raw-money-market -- --from-block=N --to-block=M [--apply]

type BlockRow = {
  block_height: number
}

const client = createClickHouseClient()
const MAX_REPAIR_BLOCK_SPAN = 10_000

async function query<T>(queryText: string): Promise<T[]> {
  const result = await client.query({
    query: queryText,
    format: 'JSONEachRow',
  })
  return result.json<T>()
}

async function affectedBlocks(fromBlock: number, toBlock: number): Promise<number[]> {
  const rows = await query<BlockRow>(`
    SELECT DISTINCT block_height
    FROM price_data.raw_parser_warnings FINAL
    WHERE parser = 'raw_money_market'
      AND warning_code = 'position_eth_call_failed'
      AND block_height >= ${fromBlock}
      AND block_height <= ${toBlock}
    ORDER BY block_height
  `)
  return rows.map(row => row.block_height)
}

async function fetchEvmLogs(blocks: number[]): Promise<RawEvmLogRow[]> {
  if (blocks.length === 0) return []
  return query<RawEvmLogRow>(`
    SELECT
      block_height,
      block_timestamp,
      event_index,
      extrinsic_index,
      call_address,
      contract_address,
      topic0,
      topics,
      data,
      decode_status,
      event_signature,
      event_name,
      decoded_args_json,
      participants,
      assets,
      warning,
      raw_log_json,
      ingest_source
    FROM price_data.raw_evm_logs FINAL
    WHERE block_height IN (${blocks.join(',')})
    ORDER BY block_height, event_index
  `)
}

async function clearResolvedWarnings(client: ClickHouseClient, blocks: number[]): Promise<void> {
  if (blocks.length === 0) return
  const blockList = blocks.join(',')
  await client.command({
    query: `
      ALTER TABLE price_data.raw_parser_warnings
      DELETE WHERE block_height IN (${blockList})
        AND parser = 'raw_money_market'
        AND warning_code = 'position_eth_call_failed'
    `,
    clickhouse_settings: { mutations_sync: '2' },
  })
}

async function repairBlocks(blocks: number[], dryRun: boolean): Promise<{
  positions: number
  warnings: number
}> {
  const evmLogs = await fetchEvmLogs(blocks)
  const logsByBlock = new Map<number, RawEvmLogRow[]>()
  for (const row of evmLogs) {
    const rows = logsByBlock.get(row.block_height)
    if (rows == null) {
      logsByBlock.set(row.block_height, [row])
    } else {
      rows.push(row)
    }
  }

  const store = new RawClickHouseStore(client, 10_000, 'money-market-repair')
  let positionCount = 0
  let warningCount = 0
  const failedBlocks = new Set<number>()
  for (const block of blocks) {
    const rows = logsByBlock.get(block) ?? []
    if (rows.length === 0) continue
    const ingestSource = rows[0].ingest_source || 'sqd'
    const extracted = await extractMoneyMarketRows(rows, ingestSource)
    positionCount += extracted.positions.length
    warningCount += extracted.warnings.length
    for (const warning of extracted.warnings) {
      if (warning.warning_code === 'position_eth_call_failed') failedBlocks.add(block)
    }
    if (!dryRun) {
      store.addMoneyMarketPositions(extracted.positions)
      store.addParserWarnings(extracted.warnings)
    }
  }

  if (!dryRun) {
    // Insert replacements before clearing resolved warnings. Existing position
    // rows stay intact until ReplacingMergeTree selects the replayed key, and a
    // failed run remains discoverable through its original warning.
    await store.flushMoneyMarketPositions()
    await store.flushParserWarnings()
    await clearResolvedWarnings(client, blocks.filter(block => !failedBlocks.has(block)))
  }

  return { positions: positionCount, warnings: warningCount }
}

async function main(): Promise<void> {
  const fromBlock = optionalIntegerOption('from-block')
  const toBlock = optionalIntegerOption('to-block')
  const apply = hasFlag('apply')
  if (apply && hasFlag('dry-run')) throw new Error('Use either --apply or --dry-run, not both')
  const dryRun = !apply
  const failOnWarning = hasFlag('fail-on-warning')
  const chunkSize = optionalIntegerOption('block-chunk-size') ?? 50
  if (fromBlock == null || toBlock == null || fromBlock > toBlock) {
    throw new Error('A bounded range is required: --from-block=N --to-block=M (M >= N)')
  }
  if (toBlock - fromBlock + 1 > MAX_REPAIR_BLOCK_SPAN) {
    throw new Error(`Repair range exceeds the ${MAX_REPAIR_BLOCK_SPAN}-block safety limit`)
  }
  if (chunkSize <= 0) throw new Error('--block-chunk-size must be greater than zero')

  const blocks = await affectedBlocks(fromBlock, toBlock)
  console.log(`mode=${dryRun ? 'dry-run' : 'apply'} range=${fromBlock}-${toBlock}`)
  console.log(`affected_blocks=${blocks.length}`)
  if (blocks.length === 0) return
  console.log(`min_block=${blocks[0]} max_block=${blocks[blocks.length - 1]}`)

  let totalPositions = 0
  let totalWarnings = 0
  for (const blockChunk of chunk(blocks, chunkSize)) {
    const startedAt = Date.now()
    const { positions, warnings } = await repairBlocks(blockChunk, dryRun)
    totalPositions += positions
    totalWarnings += warnings
    console.log(JSON.stringify({
      from_block: blockChunk[0],
      to_block: blockChunk[blockChunk.length - 1],
      blocks: blockChunk.length,
      positions,
      warnings,
      ms: Date.now() - startedAt,
    }))
  }

  console.log(`repaired_positions=${totalPositions} remaining_warnings=${totalWarnings} dry_run=${dryRun}`)
  if (failOnWarning && totalWarnings > 0) {
    process.exitCode = 1
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
