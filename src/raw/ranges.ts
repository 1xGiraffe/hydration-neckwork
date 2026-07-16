import { type ClickHouseClient } from '../db/client.js'
import { toClickHouseDateTime, toClickHouseDateTime64 } from '../db/timestamp.js'
import { escapeSqlString } from '../db/sql.js'

export type RawRangeStatus = 'running' | 'completed' | 'failed' | 'blocked'

export interface CompletedRawRange {
  fromBlock: number
  toBlock: number
}

interface RawRangeStats {
  blockCount: number
  minBlock: number
  maxBlock: number
  firstHash: string
  firstParentHash: string
  lastHash: string
  brokenParentLinks: number
}

function rawRangeId(pipelineId: string, fromBlock: number, toBlock: number): string {
  return `${pipelineId}:${fromBlock}-${toBlock}`
}

function expectedBlockCount(fromBlock: number, toBlock: number): number {
  return toBlock >= fromBlock ? toBlock - fromBlock + 1 : 0
}

async function insertRangeState(
  client: ClickHouseClient,
  input: {
    pipelineId: string
    fromBlock: number
    toBlock: number
    status: RawRangeStatus
    firstHash?: string
    firstParentHash?: string
    lastHash?: string
    blockCount?: number
    expectedBlockCount?: number
    brokenParentLinks?: number
    error?: string | null
    startedAt?: string
    completedAt?: string | null
  },
): Promise<void> {
  const now = new Date()
  const updatedAt = toClickHouseDateTime64(now)
  const lifecycleAt = toClickHouseDateTime(now)
  await client.insert({
    table: 'price_data.raw_ingestion_ranges',
    values: [{
      range_id: rawRangeId(input.pipelineId, input.fromBlock, input.toBlock),
      pipeline_id: input.pipelineId,
      from_block: input.fromBlock,
      to_block: input.toBlock,
      status: input.status,
      first_hash: input.firstHash ?? '',
      first_parent_hash: input.firstParentHash ?? '',
      last_hash: input.lastHash ?? '',
      block_count: input.blockCount ?? 0,
      expected_block_count: input.expectedBlockCount ?? expectedBlockCount(input.fromBlock, input.toBlock),
      broken_parent_links: input.brokenParentLinks ?? 0,
      error: input.error ?? null,
      started_at: input.startedAt ?? lifecycleAt,
      completed_at: input.completedAt ?? null,
      updated_at: updatedAt,
    }],
    format: 'JSONEachRow',
  })
}

async function loadExistingStartedAt(
  client: ClickHouseClient,
  pipelineId: string,
  fromBlock: number,
  toBlock: number,
): Promise<string | undefined> {
  const result = await client.query({
    query: `
      SELECT toString(started_at) AS started_at
      FROM price_data.raw_ingestion_ranges FINAL
      WHERE range_id = '${escapeSqlString(rawRangeId(pipelineId, fromBlock, toBlock))}'
      LIMIT 1
    `,
    format: 'JSONEachRow',
  })
  const rows = await result.json<{ started_at: string }>()
  return rows[0]?.started_at
}

async function loadExistingRangeStatus(
  client: ClickHouseClient,
  pipelineId: string,
  fromBlock: number,
  toBlock: number,
): Promise<RawRangeStatus | undefined> {
  const result = await client.query({
    query: `
      SELECT status
      FROM price_data.raw_ingestion_ranges FINAL
      WHERE range_id = '${escapeSqlString(rawRangeId(pipelineId, fromBlock, toBlock))}'
      LIMIT 1
    `,
    format: 'JSONEachRow',
  })
  const rows = await result.json<{ status: RawRangeStatus }>()
  return rows[0]?.status
}

export async function markRawRangeRunning(
  client: ClickHouseClient,
  pipelineId: string,
  fromBlock: number,
  toBlock: number,
): Promise<void> {
  if (await loadExistingRangeStatus(client, pipelineId, fromBlock, toBlock) === 'completed') {
    return
  }

  await insertRangeState(client, {
    pipelineId,
    fromBlock,
    toBlock,
    status: 'running',
    startedAt: await loadExistingStartedAt(client, pipelineId, fromBlock, toBlock),
  })
}

export async function markRawRangeFailed(
  client: ClickHouseClient,
  pipelineId: string,
  fromBlock: number,
  toBlock: number,
  error: unknown,
): Promise<void> {
  if (await loadExistingRangeStatus(client, pipelineId, fromBlock, toBlock) === 'completed') {
    return
  }

  await insertRangeState(client, {
    pipelineId,
    fromBlock,
    toBlock,
    status: 'failed',
    startedAt: await loadExistingStartedAt(client, pipelineId, fromBlock, toBlock),
    error: error instanceof Error ? error.message : String(error),
  })
}

async function readRawRangeStats(client: ClickHouseClient, fromBlock: number, toBlock: number): Promise<RawRangeStats> {
  const statsResult = await client.query({
    query: `
      SELECT
        toUInt32(countDistinct(block_height)) AS block_count,
        toUInt32(coalesce(min(block_height), 0)) AS min_block,
        toUInt32(coalesce(max(block_height), 0)) AS max_block,
        argMin(block_hash, block_height) AS first_hash,
        argMin(parent_hash, block_height) AS first_parent_hash,
        argMax(block_hash, block_height) AS last_hash
      FROM price_data.raw_blocks FINAL
      WHERE block_height >= ${fromBlock}
        AND block_height <= ${toBlock}
    `,
    format: 'JSONEachRow',
  })
  const rows = await statsResult.json<{
    block_count: number
    min_block: number
    max_block: number
    first_hash: string
    first_parent_hash: string
    last_hash: string
  }>()
  const stats = rows[0]

  const linkResult = await client.query({
    query: `
      SELECT toUInt32(count()) AS broken_parent_links
      FROM
      (
        SELECT block_height, block_hash
        FROM price_data.raw_blocks FINAL
        WHERE block_height >= ${fromBlock}
          AND block_height < ${toBlock}
      ) AS parent
      INNER JOIN
      (
        SELECT block_height, parent_hash
        FROM price_data.raw_blocks FINAL
        WHERE block_height > ${fromBlock}
          AND block_height <= ${toBlock}
      ) AS child
      ON child.block_height = parent.block_height + 1
      WHERE child.parent_hash != parent.block_hash
    `,
    format: 'JSONEachRow',
  })
  const linkRows = await linkResult.json<{ broken_parent_links: number }>()

  return {
    blockCount: Number(stats?.block_count ?? 0),
    minBlock: Number(stats?.min_block ?? 0),
    maxBlock: Number(stats?.max_block ?? 0),
    firstHash: stats?.first_hash ?? '',
    firstParentHash: stats?.first_parent_hash ?? '',
    lastHash: stats?.last_hash ?? '',
    brokenParentLinks: Number(linkRows[0]?.broken_parent_links ?? 0),
  }
}

async function validateAdjacentRanges(
  client: ClickHouseClient,
  fromBlock: number,
  toBlock: number,
  stats: RawRangeStats,
): Promise<string[]> {
  const errors: string[] = []

  if (fromBlock > 0) {
    const previousResult = await client.query({
      query: `
        SELECT last_hash
        FROM price_data.raw_ingestion_ranges FINAL
        WHERE status = 'completed'
          AND to_block = ${fromBlock - 1}
        LIMIT 1
      `,
      format: 'JSONEachRow',
    })
    const previousRows = await previousResult.json<{ last_hash: string }>()
    const previousLastHash = previousRows[0]?.last_hash
    if (previousLastHash != null && previousLastHash !== stats.firstParentHash) {
      errors.push(`previous completed range boundary mismatch: expected first parent ${previousLastHash}, got ${stats.firstParentHash}`)
    }
  }

  const nextResult = await client.query({
    query: `
      SELECT first_parent_hash
      FROM price_data.raw_ingestion_ranges FINAL
      WHERE status = 'completed'
        AND from_block = ${toBlock + 1}
      LIMIT 1
    `,
    format: 'JSONEachRow',
  })
  const nextRows = await nextResult.json<{ first_parent_hash: string }>()
  const nextFirstParent = nextRows[0]?.first_parent_hash
  if (nextFirstParent != null && nextFirstParent !== stats.lastHash) {
    errors.push(`next completed range boundary mismatch: expected next parent ${stats.lastHash}, got ${nextFirstParent}`)
  }

  return errors
}

export async function finalizeRawRange(
  client: ClickHouseClient,
  pipelineId: string,
  fromBlock: number,
  toBlock: number,
): Promise<void> {
  const expected = expectedBlockCount(fromBlock, toBlock)
  if (expected <= 0) {
    throw new Error(`Invalid raw range ${fromBlock}-${toBlock}`)
  }

  const stats = await readRawRangeStats(client, fromBlock, toBlock)
  const errors: string[] = []

  if (stats.blockCount !== expected) {
    errors.push(`expected ${expected} raw blocks, found ${stats.blockCount}`)
  }
  if (stats.minBlock !== fromBlock) {
    errors.push(`expected min block ${fromBlock}, got ${stats.minBlock}`)
  }
  if (stats.maxBlock !== toBlock) {
    errors.push(`expected max block ${toBlock}, got ${stats.maxBlock}`)
  }
  if (stats.brokenParentLinks > 0) {
    errors.push(`${stats.brokenParentLinks} parent hash link(s) are broken inside range`)
  }
  errors.push(...await validateAdjacentRanges(client, fromBlock, toBlock, stats))

  if (errors.length > 0) {
    const error = new Error(`Raw range ${fromBlock}-${toBlock} failed validation: ${errors.join('; ')}`)
    await markRawRangeFailed(client, pipelineId, fromBlock, toBlock, error)
    throw error
  }

  await insertRangeState(client, {
    pipelineId,
    fromBlock,
    toBlock,
    status: 'completed',
    firstHash: stats.firstHash,
    firstParentHash: stats.firstParentHash,
    lastHash: stats.lastHash,
    blockCount: stats.blockCount,
    expectedBlockCount: expected,
    brokenParentLinks: stats.brokenParentLinks,
    startedAt: await loadExistingStartedAt(client, pipelineId, fromBlock, toBlock),
    completedAt: toClickHouseDateTime(),
  })
}

export function mergeRawRanges(ranges: CompletedRawRange[]): CompletedRawRange[] {
  const sorted = [...ranges].sort((a, b) => a.fromBlock - b.fromBlock || a.toBlock - b.toBlock)
  const merged: CompletedRawRange[] = []

  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last == null || range.fromBlock > last.toBlock + 1) {
      merged.push({ ...range })
    } else if (range.toBlock > last.toBlock) {
      last.toBlock = range.toBlock
    }
  }

  return merged
}

export async function getCompletedRawRanges(
  client: ClickHouseClient,
  fromBlock: number,
  toBlock: number,
): Promise<CompletedRawRange[]> {
  const result = await client.query({
    query: `
      SELECT from_block, to_block
      FROM price_data.raw_ingestion_ranges FINAL
      WHERE status = 'completed'
        AND to_block >= ${fromBlock}
        AND from_block <= ${toBlock}
      ORDER BY from_block ASC, to_block ASC
    `,
    format: 'JSONEachRow',
  })
  const rows = await result.json<{ from_block: number; to_block: number }>()

  return mergeRawRanges(rows.map(row => ({
    fromBlock: Math.max(fromBlock, Number(row.from_block)),
    toBlock: Math.min(toBlock, Number(row.to_block)),
  })))
}

export function missingRawCoverage(
  fromBlock: number,
  toBlock: number,
  completedRanges: CompletedRawRange[],
): CompletedRawRange[] {
  const missing: CompletedRawRange[] = []
  let cursor = fromBlock

  for (const range of mergeRawRanges(completedRanges)) {
    if (range.toBlock < cursor) continue
    if (range.fromBlock > cursor) {
      missing.push({ fromBlock: cursor, toBlock: Math.min(range.fromBlock - 1, toBlock) })
    }
    cursor = Math.max(cursor, range.toBlock + 1)
    if (cursor > toBlock) break
  }

  if (cursor <= toBlock) {
    missing.push({ fromBlock: cursor, toBlock })
  }

  return missing
}

export async function assertFinalizedRawCoverage(
  client: ClickHouseClient,
  fromBlock: number,
  toBlock: number,
): Promise<void> {
  const completed = await getCompletedRawRanges(client, fromBlock, toBlock)
  const missing = missingRawCoverage(fromBlock, toBlock, completed)
  if (missing.length === 0) return

  const preview = missing
    .slice(0, 5)
    .map(range => `${range.fromBlock}-${range.toBlock}`)
    .join(', ')
  const suffix = missing.length > 5 ? `, ... ${missing.length - 5} more` : ''
  throw new Error(`Missing finalized raw coverage for ${fromBlock}-${toBlock}: ${preview}${suffix}`)
}
