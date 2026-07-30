import { RpcClient } from '@subsquid/rpc-client'
import { Runtime } from '@subsquid/substrate-runtime'
import { createClickHouseClient } from '../db/client.js'
import { config } from '../config.js'
import { integerOption, optionalIntegerOption } from '../util/cliArgs.js'

type BalanceRow = {
  block_height: number
  block_hash: string
  account_id: string
  asset_id: string
  free: string | null
  reserved: string | null
  frozen: string | null
  total: string | null
  nonce: number | null
  flags: string | null
  source_kind: string
  source_name: string
  source_event_index: number | null
}

type RuntimeVersion = {
  specName: string
  specVersion: number
  implName: string
  implVersion: number
}

type DecodedBalance = {
  free: string
  reserved: string
  frozen: string
  total: string
  nonce: number | null
  flags: string | null
}

type ValidationResult = {
  row: BalanceRow
  ok: boolean
  expected?: DecodedBalance
  mismatch?: Record<string, { stored: string | number | null; rpc: string | number | null }>
  error?: string
}

const client = createClickHouseClient()
const rpc = new RpcClient({
  url: config.RPC_URL,
  capacity: 4,
  rateLimit: Math.min(config.RPC_RATE_LIMIT, 20),
  requestTimeout: 30_000,
})

const runtimeCache = new Map<string, Runtime>()

function bigintString(value: unknown): string {
  if (value == null) return '0'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return Math.trunc(value).toString()
  if (typeof value === 'string') return /^\d+$/.test(value) ? value : '0'
  if (typeof value === 'object' && 'toString' in value) {
    const asString = value.toString()
    return /^\d+$/.test(asString) ? asString : '0'
  }
  return '0'
}

function maxBigintString(a: unknown, b: unknown): string {
  const left = BigInt(bigintString(a))
  const right = BigInt(bigintString(b))
  return left > right ? left.toString() : right.toString()
}

async function query<T>(queryText: string): Promise<T[]> {
  const result = await client.query({
    query: queryText,
    format: 'JSONEachRow',
  })
  return result.json<T>()
}

async function getRuntime(blockHash: string): Promise<Runtime> {
  const cached = runtimeCache.get(blockHash)
  if (cached != null) return cached

  const [runtimeVersion, metadata] = await Promise.all([
    rpc.call<RuntimeVersion>('state_getRuntimeVersion', [blockHash]),
    rpc.call<string>('state_getMetadata', [blockHash]),
  ])
  const runtime = new Runtime(runtimeVersion, metadata, undefined, rpc)
  runtimeCache.set(blockHash, runtime)
  return runtime
}

function fallbackStorage(runtime: Runtime, name: string): unknown {
  try {
    return runtime.getStorageFallback(name)
  } catch {
    return undefined
  }
}

async function readRpcBalance(row: BalanceRow): Promise<DecodedBalance> {
  const runtime = await getRuntime(row.block_hash)

  if (row.asset_id === '0') {
    const value = await runtime.getStorage(row.block_hash, 'System.Account', row.account_id) ??
      fallbackStorage(runtime, 'System.Account') as any
    const data = value?.data ?? {}
    const free = bigintString(data.free)
    const reserved = bigintString(data.reserved)
    const frozen = data.frozen == null
      ? maxBigintString(data.miscFrozen, data.feeFrozen)
      : bigintString(data.frozen)

    return {
      free,
      reserved,
      frozen,
      total: (BigInt(free) + BigInt(reserved)).toString(),
      nonce: Number.isSafeInteger(value?.nonce) ? value.nonce : null,
      flags: data.flags == null ? null : bigintString(data.flags),
    }
  }

  if (!runtime.hasStorageItem('Tokens.Accounts')) {
    throw new Error(`Tokens.Accounts does not exist at spec ${runtime.specVersion}`)
  }

  const assetId = Number.parseInt(row.asset_id, 10)
  if (!Number.isSafeInteger(assetId)) {
    throw new Error(`Invalid asset_id ${row.asset_id}`)
  }

  const value = await runtime.getStorage(row.block_hash, 'Tokens.Accounts', row.account_id, assetId) ??
    fallbackStorage(runtime, 'Tokens.Accounts') as any
  const free = bigintString(value?.free)
  const reserved = bigintString(value?.reserved)
  return {
    free,
    reserved,
    frozen: bigintString(value?.frozen),
    total: (BigInt(free) + BigInt(reserved)).toString(),
    nonce: null,
    flags: null,
  }
}

function compare(row: BalanceRow, expected: DecodedBalance): ValidationResult {
  const mismatch: ValidationResult['mismatch'] = {}

  for (const field of ['free', 'reserved', 'frozen', 'total', 'nonce', 'flags'] as const) {
    const stored = row[field]
    const rpcValue = expected[field]
    if ((stored ?? null) !== (rpcValue ?? null)) {
      mismatch[field] = { stored: stored ?? null, rpc: rpcValue ?? null }
    }
  }

  return {
    row,
    ok: Object.keys(mismatch).length === 0,
    expected,
    mismatch: Object.keys(mismatch).length === 0 ? undefined : mismatch,
  }
}

async function sampleRows(limit: number, fromBlock: number | null, toBlock: number | null): Promise<BalanceRow[]> {
  const lowerBound = fromBlock == null
    ? 'greatest((SELECT max(block_height) FROM price_data.raw_balance_observations) - 5000, 0)'
    : String(fromBlock)
  const upperBound = toBlock == null ? '' : `AND b.block_height <= ${toBlock}`
  return query<BalanceRow>(`
    SELECT
      b.block_height,
      rb.block_hash,
      b.account_id,
      b.asset_id,
      b.free,
      b.reserved,
      b.frozen,
      b.total,
      b.nonce,
      b.flags,
      b.source_kind,
      b.source_name,
      b.source_event_index
    FROM (SELECT * FROM price_data.raw_balance_observations FINAL) AS b
    INNER JOIN (SELECT block_height, block_hash FROM price_data.raw_blocks FINAL) AS rb
      ON rb.block_height = b.block_height
    WHERE b.total IS NOT NULL
      AND b.block_height >= ${lowerBound}
      ${upperBound}
    ORDER BY cityHash64(concat(toString(b.block_height), b.account_id, b.asset_id))
    LIMIT ${limit}
  `)
}

async function validateSamples(limit: number, fromBlock: number | null, toBlock: number | null): Promise<ValidationResult[]> {
  const rows = await sampleRows(limit, fromBlock, toBlock)
  const results: ValidationResult[] = []

  for (const row of rows) {
    try {
      const expected = await readRpcBalance(row)
      results.push(compare(row, expected))
    } catch (error) {
      results.push({
        row,
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown validation error',
      })
    }
  }

  return results
}

async function main(): Promise<void> {
  const sampleLimit = integerOption('sample-limit', 30)
  const fromBlock = optionalIntegerOption('from-block')
  const toBlock = optionalIntegerOption('to-block')
  if (fromBlock != null && toBlock != null && fromBlock > toBlock) {
    throw new Error('--from-block must not exceed --to-block')
  }

  const results = await validateSamples(sampleLimit, fromBlock, toBlock)
  const failures = results.filter(result => !result.ok)
  console.log(JSON.stringify({
    type: 'raw_balance_validation',
    range: { fromBlock, toBlock },
    checked: results.length,
    failures: failures.length,
    failed_rows: failures.slice(0, 10),
  }, null, 2))

  if (failures.length > 0) {
    process.exitCode = 1
  }
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await client.close()
    rpc.close()
  })
