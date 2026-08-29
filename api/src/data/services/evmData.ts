import type { ClickHouseClient } from '../../db/client.ts'
import { attachExtrinsicHashes, type WithExtrinsicHash } from './extrinsicHashes.ts'
import { iso } from '../schemas/common.ts'
import { parseJsonColumn } from './chainCore.ts'
import { DEDUP_SLACK, dedupPage, orderSql, positionCursorSql, versionedPageSql, windowSql, type Order, type PositionCursor, type WindowFilters } from './feed.ts'

// EVM reads for /v1/evm/*: transactions by hash (evm_transactions, hash-first),
// contract identity (evm_contract_code_snapshot + contract_abis +
// evm_contract_log_stats), per-contract logs (evm_logs_by_contract →
// page-scoped enrichment from raw_evm_logs), and verified ABI/sources
// (contract_abis / contract_sources — public by design).

const H160_RE = /^0x[0-9a-f]{40}$/

export function isH160(value: string): boolean {
  return H160_RE.test(value.toLowerCase())
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export interface EvmTransactionDetail {
  txHash: string
  blockHeight: number
  extrinsicIndex: number | null
  eventIndex: number
  timestamp: string
  from: string
  to: string
  success: boolean
  /** The EVM exit reason: Succeed | Error | Revert (live vocabulary). */
  exitKind: string
  exitDetail: string | null
  /** Returned revert data, when the node reported any. */
  extraData: string | null
}

export async function evmTransactionByHash(client: ClickHouseClient, txHash: string): Promise<WithExtrinsicHash<EvmTransactionDetail> | null> {
  const res = await client.query({
    query: `-- data:evm:transaction
        SELECT tx_hash, block_height, extrinsic_index, event_index, toString(block_timestamp) AS ts,
               from_address, to_address, exit_kind, exit_detail, extra_data
        FROM price_data.evm_transactions FINAL
        WHERE tx_hash = {hash:String}
        LIMIT 1`,
    query_params: { hash: txHash.toLowerCase() },
    format: 'JSONEachRow',
  })
  const [row] = await res.json<{
    tx_hash: string; block_height: number; extrinsic_index: number | null; event_index: number; ts: string
    from_address: string; to_address: string; exit_kind: string; exit_detail: string; extra_data: string
  }>()
  if (!row) return null
  const [detail] = await attachExtrinsicHashes(client, [{
    txHash: String(row.tx_hash).toLowerCase(),
    blockHeight: Number(row.block_height),
    extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
    eventIndex: Number(row.event_index),
    timestamp: iso(row.ts),
    from: String(row.from_address).toLowerCase(),
    to: String(row.to_address).toLowerCase(),
    success: row.exit_kind === 'Succeed',
    exitKind: row.exit_kind,
    exitDetail: row.exit_detail || null,
    extraData: row.extra_data || null,
  }])
  return detail
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export interface ContractLogStats {
  count: number
  firstBlock: number
  lastBlock: number
  firstTime: string
  lastTime: string
}

export interface ContractDetail {
  address: string
  /** Registry kind: contract | asset-erc20 | oracle-adapter | system-precompile | … */
  kind: string
  codeHash: string
  codeSize: number
  destroyed: boolean
  verified: boolean
  contractName: string | null
  compilerVersion: string | null
  matchType: string | null
  /** How the ABI got here: verified | import:blockscout | manual. */
  abiSource: string | null
  logs: ContractLogStats | null
}

interface AbiRow {
  address: string
  abi_json: string
  contract_name: string
  compiler_version: string
  source: string
  match_type: string
  code_hash: string
}

async function abiRowFor(client: ClickHouseClient, address: string): Promise<AbiRow | null> {
  const res = await client.query({
    query: `-- data:evm:abi
        SELECT address, abi_json, contract_name, compiler_version, source, match_type, code_hash
        FROM price_data.contract_abis FINAL
        WHERE address = {address:String} AND deleted = 0
        LIMIT 1`,
    query_params: { address },
    format: 'JSONEachRow',
  })
  return (await res.json<AbiRow>())[0] ?? null
}

export async function contractDetail(client: ClickHouseClient, address: string): Promise<ContractDetail | null> {
  const lower = address.toLowerCase()
  const [snapshotRes, abi, statsRes] = await Promise.all([
    client.query({
      query: `-- data:evm:contract
          SELECT address, kind, code_hash, code_size, destroyed
          FROM price_data.evm_contract_code_snapshot FINAL
          WHERE address = {address:String}
          LIMIT 1`,
      query_params: { address: lower },
      format: 'JSONEachRow',
    }),
    abiRowFor(client, lower),
    client.query({
      query: `-- data:evm:contract-log-stats
          SELECT toUInt64(groupBitmapMerge(log_identity_state)) AS log_count,
                 min(first_block) AS first_block, max(last_block) AS last_block,
                 toString(min(first_timestamp)) AS first_ts, toString(max(last_timestamp)) AS last_ts
          FROM price_data.evm_contract_log_stats
          WHERE contract_address = {address:String}
          GROUP BY contract_address`,
      query_params: { address: lower },
      format: 'JSONEachRow',
    }),
  ])
  const [snapshot] = await snapshotRes.json<{ address: string; kind: string; code_hash: string; code_size: number; destroyed: number }>()
  if (!snapshot) return null
  const [stats] = await statsRes.json<{ log_count: string; first_block: number; last_block: number; first_ts: string; last_ts: string }>()
  return {
    address: lower,
    kind: snapshot.kind,
    codeHash: snapshot.code_hash,
    codeSize: Number(snapshot.code_size),
    destroyed: Number(snapshot.destroyed) === 1,
    verified: abi != null,
    contractName: abi?.contract_name || null,
    compilerVersion: abi?.compiler_version || null,
    matchType: abi?.match_type || null,
    abiSource: abi?.source || null,
    logs: stats
      ? {
          count: Number(stats.log_count),
          firstBlock: Number(stats.first_block),
          lastBlock: Number(stats.last_block),
          firstTime: iso(stats.first_ts),
          lastTime: iso(stats.last_ts),
        }
      : null,
  }
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface ContractLogItem {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  topics: string[]
  data: string
  decoded: { name: string; signature: string; args: unknown } | null
}

export interface ContractLogsOptions extends WindowFilters {
  limit: number
  order: Order
  cursor: PositionCursor | null
  topic0?: string
}

interface LogIndexRow { block_height: number; event_index: number; ts: string; ingested_at: string }

// Page from the narrow contract-first index, then enrich the page's (block,
// event) identities with one primary-key IN read on raw_evm_logs — the heavy
// topics/data/decoded columns are decompressed for the PAGE only.
export async function contractLogs(client: ClickHouseClient, address: string, options: ContractLogsOptions): Promise<{ items: Array<WithExtrinsicHash<ContractLogItem>>; hasMore: boolean }> {
  const params: Record<string, unknown> = { address: address.toLowerCase(), bound: options.limit + 1 + DEDUP_SLACK }
  const clauses = ['contract_address = {address:String}']
  if (options.topic0) { clauses.push('topic0 = {topic0:String}'); params.topic0 = options.topic0.toLowerCase() }
  const indexRes = await client.query({
    query: versionedPageSql(`-- data:evm:logs:index
        SELECT block_height, event_index, toString(block_timestamp) AS ts, ingested_at
        FROM price_data.evm_logs_by_contract
        WHERE ${clauses.join(' AND ')}${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`, orderSql(options.order, 'event_index')),
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(await indexRes.json<LogIndexRow>(), row => `${row.block_height}:${row.event_index}`, options.limit)
  if (page.length === 0) return { items: [], hasMore }

  const enrichRes = await client.query({
    query: `-- data:evm:logs:enrich
        SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts,
               topics, data, decode_status, event_name, event_signature, decoded_args_json,
               ingested_at
        FROM price_data.raw_evm_logs
        WHERE (block_height, event_index) IN arrayZip({bs:Array(UInt32)}, {es:Array(UInt32)})`,
    // Two flat arrays zipped server-side: ClickHouse's parameter parser cannot
    // read an Array(Tuple(…)) literal from the client's JSON (measured live).
    query_params: {
      bs: page.map(row => Number(row.block_height)),
      es: page.map(row => Number(row.event_index)),
    },
    format: 'JSONEachRow',
  })
  interface EnrichRow {
    block_height: number; event_index: number; extrinsic_index: number | null; ts: string
    topics: string[]; data: string; decode_status: string
    event_name: string | null; event_signature: string | null; decoded_args_json: string; ingested_at: string
  }
  const byKey = new Map<string, EnrichRow>()
  for (const row of await enrichRes.json<EnrichRow>()) {
    const key = `${row.block_height}:${row.event_index}`
    const prior = byKey.get(key)
    if (!prior || String(row.ingested_at) > String(prior.ingested_at)) byKey.set(key, row)
  }
  const items: ContractLogItem[] = []
  for (const indexRow of page) {
    const row = byKey.get(`${indexRow.block_height}:${indexRow.event_index}`)
    // An index row whose parent row is not readable (a mid-replace sliver) is
    // skipped rather than fabricated; the identity remains reachable next page.
    if (!row) continue
    items.push({
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
      timestamp: iso(row.ts),
      topics: (row.topics ?? []).map(topic => String(topic).toLowerCase()),
      data: String(row.data ?? ''),
      decoded: row.decode_status === 'decoded' && row.event_name
        ? { name: row.event_name, signature: row.event_signature ?? '', args: parseJsonColumn(row.decoded_args_json) }
        : null,
    })
  }
  return { items: await attachExtrinsicHashes(client, items), hasMore }
}

// ---------------------------------------------------------------------------
// ABI + sources
// ---------------------------------------------------------------------------

export interface ContractSourceFile {
  path: string
  content: string
  evmVersion: string | null
  optimizerEnabled: boolean
  optimizerRuns: number
  constructorArguments: string | null
}

export interface ContractAbiDetail {
  address: string
  abi: unknown
  contractName: string | null
  compilerVersion: string | null
  source: string
  matchType: string | null
  codeHash: string | null
  sources: ContractSourceFile[]
}

export async function contractAbi(client: ClickHouseClient, address: string): Promise<ContractAbiDetail | null> {
  const lower = address.toLowerCase()
  const [abi, sourcesRes] = await Promise.all([
    abiRowFor(client, lower),
    client.query({
      query: `-- data:evm:sources
          SELECT path, content, evm_version, optimizer_enabled, optimizer_runs, constructor_arguments
          FROM price_data.contract_sources FINAL
          WHERE address = {address:String} AND deleted = 0
          ORDER BY path`,
      query_params: { address: lower },
      format: 'JSONEachRow',
    }),
  ])
  if (!abi) return null
  const sources = await sourcesRes.json<{ path: string; content: string; evm_version: string; optimizer_enabled: number; optimizer_runs: number; constructor_arguments: string }>()
  return {
    address: lower,
    abi: parseJsonColumn(abi.abi_json),
    contractName: abi.contract_name || null,
    compilerVersion: abi.compiler_version || null,
    source: abi.source,
    matchType: abi.match_type || null,
    codeHash: abi.code_hash || null,
    sources: sources.map(row => ({
      path: row.path,
      content: row.content,
      evmVersion: row.evm_version || null,
      optimizerEnabled: Number(row.optimizer_enabled) === 1,
      optimizerRuns: Number(row.optimizer_runs),
      constructorArguments: row.constructor_arguments || null,
    })),
  }
}
