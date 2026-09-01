import { randomUUID } from 'node:crypto'
import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import { contractByH160 } from './contractRegistryService.ts'
import { fetchDeployedBytecode, verifyStandardJson, type MatchType } from './verifierClient.ts'

// Contract verification: owns the job lifecycle and the three ClickHouse tables
// in `005_contracts.sql`, plus the in-memory verified-contract map that feeds
// registry display (directory chip, AddressDetail.verification, search) without
// a per-request query.
//
// Sourcify's model is a job ticket: submit returns an id immediately and the
// client polls. We honour that rather than compiling inside the request, because
// a large project can take longer than a client is willing to hold a connection.

let client: ClickHouseClient

export function initContractVerificationService(c: ClickHouseClient) {
  client = c
}

// One chain forever; the Sourcify path chainId is deliberately not validated
// against this (an unconfigured forge sends 1), it is only ever echoed back.
export const CHAIN_ID = process.env.EVM_CHAIN_ID?.trim() || '222222'

// Sourcify V2's match vocabulary. `exact_match` is a metadata-exact match,
// `match` is a match with differing metadata (what Blockscout calls PARTIAL),
// and `null` means not verified at all.
export type MatchLevel = 'exact_match' | 'match' | null

export function toMatchLevel(matchType: MatchType | '' | undefined): MatchLevel {
  if (matchType === 'FULL') return 'exact_match'
  if (matchType === 'PARTIAL') return 'match'
  return null
}

export type JobState = {
  verificationId: string
  address: string
  chainId: string
  status: 'pending' | 'verified' | 'failed'
  matchType: MatchType | ''
  contractIdentifier: string
  compilerVersion: string
  errorCode: string
  errorMessage: string
  // Cached at submit time so the read paths never call eth_getCode. Carried on
  // every write: `contract_verifications` is a ReplacingMergeTree keyed by
  // verification_id, so a later row that omitted this column would win and
  // silently blank it.
  deployedBytecode: string
  submittedAt: Date
  completedAt: Date | null
}

// In-process view of jobs. Every transition is also written to ClickHouse, so a
// poll that arrives after a redeploy still resolves (see `getJob`) instead of
// telling the client its verification vanished.
const jobs = new Map<string, JobState>()

export function normalizeAddressParam(address: string): string {
  return address.trim().toLowerCase()
}

export function isH160(address: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(address)
}

// --- verified-contract map ------------------------------------------------
//
// One bounded load (a few hundred rows) into memory, refreshed after every
// successful verification and on a slow timer (external writers: the ad-hoc
// Blockscout seed). Feeds the directory `verified` chip, the AddressDetail
// `verification` card, verified-name search, and the Sourcify probe.

export interface VerifiedContractInfo {
  address: string
  name: string
  compilerVersion: string
  matchType: MatchType | ''
  source: string          // 'verified' | 'import:blockscout' | 'manual'
  verifiedAt: string
  abiPresent: boolean
  sourceFileCount: number
  codeHash: string        // registry code hash at verification time
}

let verifiedByAddress = new Map<string, VerifiedContractInfo>()

async function loadVerifiedUncached(): Promise<void> {
  const [abiRows, countRows] = await Promise.all([
    client
      .query({
        query: `
          SELECT address, contract_name, compiler_version, match_type, source, code_hash,
                 toString(updated_at) AS verified_at, abi_json != '' AS abi_present
          FROM price_data.contract_abis FINAL
          WHERE deleted = 0`,
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ address: string; contract_name: string; compiler_version: string; match_type: string; source: string; code_hash: string; verified_at: string; abi_present: number }>()),
    client
      .query({
        query: `
          SELECT address, toUInt32(count()) AS c
          FROM price_data.contract_sources FINAL
          WHERE deleted = 0
          GROUP BY address`,
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ address: string; c: number }>()),
  ])
  const counts = new Map(countRows.map(r => [r.address.toLowerCase(), Number(r.c) || 0]))
  const next = new Map<string, VerifiedContractInfo>()
  for (const row of abiRows) {
    const address = row.address.toLowerCase()
    next.set(address, {
      address,
      name: row.contract_name,
      compilerVersion: row.compiler_version,
      matchType: row.match_type === 'FULL' ? 'FULL' : row.match_type === 'PARTIAL' ? 'PARTIAL' : '',
      source: row.source,
      verifiedAt: row.verified_at,
      abiPresent: !!Number(row.abi_present),
      sourceFileCount: counts.get(address) ?? 0,
      codeHash: row.code_hash,
    })
  }
  verifiedByAddress = next
}

let loadInflight: Promise<void> | null = null
export function loadVerifiedContracts(): Promise<void> {
  if (loadInflight) return loadInflight
  const request = loadVerifiedUncached().finally(() => {
    if (loadInflight === request) loadInflight = null
  })
  loadInflight = request
  return request
}

let refreshTimer: ReturnType<typeof setInterval> | null = null
export function startVerifiedContractsRefresh(intervalMs = 10 * 60_000): void {
  if (refreshTimer) return
  refreshTimer = setInterval(() => { void loadVerifiedContracts().catch(() => {}) }, intervalMs)
  refreshTimer.unref()
}
export function stopVerifiedContractsRefresh(): void {
  if (!refreshTimer) return
  clearInterval(refreshTimer)
  refreshTimer = null
}

export function verifiedContractInfo(address: string): VerifiedContractInfo | null {
  return verifiedByAddress.get(address.toLowerCase()) ?? null
}
export function allVerifiedContracts(): Map<string, VerifiedContractInfo> {
  return verifiedByAddress
}

// --- display shapes ---------------------------------------------------------

// AddressDetail/directory `verification` object (§5.2). An unverified contract
// gets an explicit status rather than a null, so the UI can label the state
// without inferring it from absence.
export interface VerificationDisplay {
  status: 'verified' | 'unverified'
  name?: string
  compilerVersion?: string
  matchType?: string
  source?: string
  verifiedAt?: string
  abiPresent?: boolean
  sourceFileCount?: number
  supersededBytecode?: boolean
}

export function verificationDisplay(info: VerifiedContractInfo | null, currentCodeHash: string): VerificationDisplay {
  if (!info) return { status: 'unverified' }
  return {
    status: 'verified',
    name: info.name,
    compilerVersion: info.compilerVersion,
    matchType: toMatchLevel(info.matchType) ?? '',
    source: info.source,
    verifiedAt: info.verifiedAt,
    abiPresent: info.abiPresent,
    sourceFileCount: info.sourceFileCount,
    // A CREATE2 redeploy moved the code out from under the verification. Only
    // claimed when both hashes are known — never inferred from absence.
    supersededBytecode: !!info.codeHash && !!currentCodeHash && info.codeHash !== currentCodeHash,
  }
}

// Verified contract names for /explorer/search. Same exact/prefix/word-start/
// substring tiering as explorerService's nameMatchRank (kept local: importing
// it from there would make the two modules mutually dependent).
export function searchVerifiedNames(q: string, entries: Map<string, VerifiedContractInfo>): { address: string; name: string }[] {
  const ql = q.trim().toLowerCase()
  if (!ql || !/[a-z]/i.test(ql)) return []
  const ranked: { address: string; name: string; rank: number }[] = []
  for (const info of entries.values()) {
    if (!info.name) continue
    const t = info.name.toLowerCase()
    let rank: number
    if (t === ql) rank = 0
    else if (t.startsWith(ql)) rank = 1
    else {
      const idx = t.indexOf(ql)
      if (idx < 0) continue
      rank = /[a-z0-9]/i.test(info.name[idx - 1]) ? 3 : 2
    }
    ranked.push({ address: info.address, name: info.name, rank })
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) || a.address.localeCompare(b.address))
    .map(({ address, name }) => ({ address, name }))
}

// --- lookups -------------------------------------------------------------

export type VerifiedContract = {
  address: string
  matchType: MatchType
  contractName: string
  compilerVersion: string
}

// The Sourcify probe / submit guard. Only `source='verified'` counts: an
// imported ABI is externally attested, not bytecode-matched here, so a real
// verification is still allowed to land and replace it.
export async function getVerifiedContract(address: string): Promise<VerifiedContract | null> {
  const info = verifiedByAddress.get(address.toLowerCase())
  if (!info || info.source !== 'verified') return null
  return {
    address: info.address,
    matchType: info.matchType === 'FULL' ? 'FULL' : 'PARTIAL',
    contractName: info.name,
    compilerVersion: info.compilerVersion,
  }
}

// --- lazy explorer payloads (§5.3) ----------------------------------------
//
// Primary-key SELECTs behind `cached`. The cache key carries `verifiedAt`, so a
// re-verification rotates the key instead of needing eviction — stale entries
// simply age out.

export async function getContractAbiPayload(address: string): Promise<{ address: string; abi: unknown; source: string; contractName: string } | null> {
  const addr = normalizeAddressParam(address)
  const info = verifiedByAddress.get(addr)
  if (!info?.abiPresent) return null
  return cached(`contract:abi:${addr}:${info.verifiedAt}`, 3_600_000, async () => {
    const rows = await client
      .query({
        query: `SELECT abi_json, contract_name, source FROM price_data.contract_abis FINAL WHERE address = {address:String} AND deleted = 0 LIMIT 1`,
        query_params: { address: addr },
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ abi_json: string; contract_name: string; source: string }>())
    const row = rows[0]
    if (!row?.abi_json) return null
    let abi: unknown
    try {
      abi = JSON.parse(row.abi_json)
    } catch {
      return null
    }
    return { address: addr, abi, source: row.source, contractName: row.contract_name }
  })
}

// keccak('Upgraded(address)') — the upgrade event the ERC1967/UUPS/OZ/Aave
// proxy families all emit, including from the constructor, so a proxy's
// implementation history is already in indexed logs and needs no RPC storage
// read (contrast the UI's proxyDetect.ts, which reads the EIP-1967 slot live).
const UPGRADED_TOPIC0 = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b'

// The implementation addresses a proxy has pointed to, newest upgrade first,
// deduplicated. Read via the contract-first log index and a primary-key IN on
// raw_evm_logs (the data-API page pattern), so the scan stays bounded even for
// a chatty contract. Bounded to the 8 newest implementations: Upgraded is an
// ordinary event any contract can fake-emit, so the list must not be allowed
// to grow with emissions. Empty for non-proxies; the empty result is cached
// too, so a page of logs costs at most one scan per emitter per TTL.
export async function getProxyImplementations(address: string): Promise<string[]> {
  const addr = normalizeAddressParam(address)
  return cached(`contract:proxy-impls:${addr}`, 600_000, async () => {
    const rows = await client
      .query({
        query: `
          SELECT topics
          FROM price_data.raw_evm_logs
          WHERE (block_height, event_index) IN (
            SELECT block_height, event_index
            FROM price_data.evm_logs_by_contract
            WHERE contract_address = {address:String} AND topic0 = {topic0:String}
            ORDER BY block_height DESC, event_index DESC
            LIMIT 24)
            AND contract_address = {address:String} AND topic0 = {topic0:String}
          ORDER BY block_height DESC, event_index DESC`,
        query_params: { address: addr, topic0: UPGRADED_TOPIC0 },
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ topics: string[] }>())
    const impls: string[] = []
    for (const row of rows) {
      if (!Array.isArray(row.topics) || row.topics.length !== 2) continue
      // The implementation is the indexed arg: a left-padded 20-byte address.
      const m = String(row.topics[1]).toLowerCase().match(/^0x0{24}([0-9a-f]{40})$/)
      if (!m || /^0{40}$/.test(m[1])) continue
      const impl = `0x${m[1]}`
      if (impl === addr || impls.includes(impl)) continue
      impls.push(impl)
      if (impls.length >= 8) break
    }
    return impls
  })
}

export interface ContractSourcesPayload {
  address: string
  files: { path: string; content: string }[]
  compiler: {
    version: string
    evmVersion: string
    optimizerEnabled: boolean
    optimizerRuns: number
    constructorArguments: string
    settings: unknown
  }
}

export async function getContractSourcesPayload(address: string): Promise<ContractSourcesPayload | null> {
  const addr = normalizeAddressParam(address)
  const info = verifiedByAddress.get(addr)
  if (!info) return null
  return cached(`contract:sources:${addr}:${info.verifiedAt}`, 3_600_000, async () => {
    const rows = await client
      .query({
        query: `
          SELECT path, content, evm_version, toUInt8(optimizer_enabled) AS optimizer_enabled,
                 toUInt32(optimizer_runs) AS optimizer_runs, constructor_arguments, compiler_settings
          FROM price_data.contract_sources FINAL
          WHERE address = {address:String} AND deleted = 0
          ORDER BY path`,
        query_params: { address: addr },
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ path: string; content: string; evm_version: string; optimizer_enabled: number; optimizer_runs: number; constructor_arguments: string; compiler_settings: string }>())
    if (!rows.length) return null
    const head = rows[0]
    let settings: unknown = null
    try {
      settings = head.compiler_settings ? JSON.parse(head.compiler_settings) : null
    } catch {
      settings = head.compiler_settings
    }
    return {
      address: addr,
      files: rows.map(r => ({ path: r.path, content: r.content })),
      compiler: {
        version: info.compilerVersion,
        evmVersion: head.evm_version,
        optimizerEnabled: !!Number(head.optimizer_enabled),
        optimizerRuns: Number(head.optimizer_runs) || 0,
        constructorArguments: head.constructor_arguments,
        settings,
      },
    }
  })
}

// --- artifact rows ----------------------------------------------------------

// What a successful compile-and-compare (or an import) yields, shaped for
// storage. Kept structural so the Blockscout import reuses it.
export interface VerifiedArtifacts {
  matchType: MatchType
  contractName: string
  abi: string
  compilerVersion: string
  compilerSettings: string
  constructorArguments: string
  sourceFiles: Record<string, string>
}

// Pure: the exact rows a verification writes. Idempotent under the tables'
// replacement keys — (address) for the ABI, (address, path) for sources — and
// paths present before but absent now become tombstones, so a re-verification
// with a smaller file set cannot leave stale files live.
export function verifiedArtifactRows(args: {
  address: string
  result: VerifiedArtifacts
  codeHash: string
  previousPaths: string[]
  source?: string
}): { abiRow: Record<string, unknown>; sourceRows: Record<string, unknown>[] } {
  const { address, result, codeHash, previousPaths } = args
  const settings = parseSettings(result.compilerSettings)
  const abiRow: Record<string, unknown> = {
    address,
    abi_json: result.abi,
    contract_name: result.contractName,
    compiler_version: result.compilerVersion,
    source: args.source ?? 'verified',
    match_type: result.matchType,
    code_hash: codeHash,
    deleted: 0,
  }
  const sourceRows: Record<string, unknown>[] = Object.entries(result.sourceFiles).map(([path, content]) => ({
    address,
    path,
    content,
    evm_version: settings.evmVersion,
    optimizer_enabled: settings.optimizerEnabled ? 1 : 0,
    optimizer_runs: settings.optimizerRuns,
    constructor_arguments: result.constructorArguments,
    compiler_settings: result.compilerSettings,
    deleted: 0,
  }))
  const kept = new Set(Object.keys(result.sourceFiles))
  for (const path of previousPaths) {
    if (kept.has(path)) continue
    sourceRows.push({
      address,
      path,
      content: '',
      evm_version: '',
      optimizer_enabled: 0,
      optimizer_runs: 0,
      constructor_arguments: '',
      compiler_settings: '',
      deleted: 1,
    })
  }
  return { abiRow, sourceRows }
}

export function parseSettings(raw: string): { evmVersion: string; optimizerEnabled: boolean; optimizerRuns: number } {
  try {
    const s = JSON.parse(raw) as { evmVersion?: unknown; optimizer?: { enabled?: unknown; runs?: unknown } }
    return {
      evmVersion: typeof s.evmVersion === 'string' ? s.evmVersion : '',
      optimizerEnabled: s.optimizer?.enabled === true,
      optimizerRuns: typeof s.optimizer?.runs === 'number' ? s.optimizer.runs : 0,
    }
  } catch {
    return { evmVersion: '', optimizerEnabled: false, optimizerRuns: 0 }
  }
}

// Pure transform of a Blockscout `/api/v2/smart-contracts/:address` detail
// payload into our rows, `source='import:blockscout'` (§4.5). The invocation is
// a one-time ad-hoc rollout step; only this transform is committed. Returns
// null when the payload carries no ABI — an import without one is useless.
export function blockscoutImportRows(detail: unknown, address: string, codeHash: string): { abiRow: Record<string, unknown>; sourceRows: Record<string, unknown>[] } | null {
  const d = detail as {
    name?: unknown
    compiler_version?: unknown
    optimization_enabled?: unknown
    optimization_runs?: unknown
    evm_version?: unknown
    constructor_args?: unknown
    abi?: unknown
    source_code?: unknown
    file_path?: unknown
    additional_sources?: { file_path?: unknown; source_code?: unknown }[]
    compiler_settings?: unknown
    is_fully_verified?: unknown
    is_partially_verified?: unknown
  }
  if (!d || !Array.isArray(d.abi)) return null
  const sourceFiles: Record<string, string> = {}
  if (typeof d.source_code === 'string' && d.source_code) {
    const path = typeof d.file_path === 'string' && d.file_path ? d.file_path : `${String(d.name ?? 'Contract')}.sol`
    sourceFiles[path] = d.source_code
  }
  for (const extra of Array.isArray(d.additional_sources) ? d.additional_sources : []) {
    if (typeof extra?.file_path === 'string' && typeof extra?.source_code === 'string') {
      sourceFiles[extra.file_path] = extra.source_code
    }
  }
  const settings = d.compiler_settings != null && typeof d.compiler_settings === 'object' ? JSON.stringify(d.compiler_settings) : ''
  return verifiedArtifactRows({
    address: address.toLowerCase(),
    result: {
      matchType: d.is_fully_verified === true ? 'FULL' : 'PARTIAL',
      contractName: String(d.name ?? ''),
      abi: JSON.stringify(d.abi),
      compilerVersion: String(d.compiler_version ?? ''),
      compilerSettings: settings || JSON.stringify({
        evmVersion: typeof d.evm_version === 'string' ? d.evm_version : '',
        optimizer: { enabled: d.optimization_enabled === true, runs: typeof d.optimization_runs === 'number' ? d.optimization_runs : 0 },
      }),
      constructorArguments: typeof d.constructor_args === 'string' ? d.constructor_args : '',
      sourceFiles,
    },
    codeHash,
    previousPaths: [],
    source: 'import:blockscout',
  })
}

// --- submit --------------------------------------------------------------

export type SubmitInput = {
  address: string
  chainId: string
  compilerVersion: string
  contractIdentifier: string
  stdJsonInput: unknown
}

export type SubmitOutcome =
  | { ok: true; verificationId: string }
  | { ok: false; code: 'already_verified' | 'cannot_fetch_bytecode'; message: string }

export async function submitVerification(input: SubmitInput): Promise<SubmitOutcome> {
  const existing = await getVerifiedContract(input.address)
  if (existing) {
    return { ok: false, code: 'already_verified', message: `Contract ${input.address} is already verified` }
  }

  const bytecode = await fetchDeployedBytecode(input.address)
  if (!bytecode) {
    return {
      ok: false,
      code: 'cannot_fetch_bytecode',
      message: `No contract code found at ${input.address}`,
    }
  }

  const verificationId = randomUUID()
  const job: JobState = {
    verificationId,
    address: input.address,
    chainId: input.chainId,
    status: 'pending',
    matchType: '',
    contractIdentifier: input.contractIdentifier,
    compilerVersion: input.compilerVersion,
    errorCode: '',
    errorMessage: '',
    deployedBytecode: bytecode,
    submittedAt: new Date(),
    completedAt: null,
  }
  jobs.set(verificationId, job)
  await persistJob(job)

  // Fire and forget: the client polls. Any throw is captured onto the job so a
  // failure surfaces as a clean verification failure rather than a hung poll.
  void runVerification(job, input).catch(async err => {
    job.status = 'failed'
    job.errorCode = 'internal_error'
    job.errorMessage = err instanceof Error ? err.message : String(err)
    job.completedAt = new Date()
    await persistJob(job).catch(() => {})
  })

  return { ok: true, verificationId }
}

async function runVerification(job: JobState, input: SubmitInput): Promise<void> {
  const result = await verifyStandardJson({
    bytecode: job.deployedBytecode,
    compilerVersion: input.compilerVersion,
    stdJsonInput: input.stdJsonInput,
  })

  if (!result.ok) {
    job.status = 'failed'
    job.errorCode = result.code
    job.errorMessage = result.message
    job.completedAt = new Date()
    await persistJob(job)
    return
  }

  job.status = 'verified'
  job.matchType = result.matchType
  job.completedAt = new Date()
  await Promise.all([persistJob(job), persistVerified(job.address, result)])
  // Flip the in-memory map so the probe, directory chip and account card render
  // verified immediately, not on the next timer pass.
  await loadVerifiedContracts().catch(() => {})
}

async function persistJob(job: JobState): Promise<void> {
  await client.insert({
    table: 'price_data.contract_verifications',
    values: [
      {
        verification_id: job.verificationId,
        address: job.address,
        status: job.status,
        match_type: job.matchType,
        contract_identifier: job.contractIdentifier,
        compiler_version: job.compilerVersion,
        error_code: job.errorCode,
        error_message: job.errorMessage,
        deployed_bytecode: job.deployedBytecode,
        submitted_at: toClickHouseDateTime(job.submittedAt),
        completed_at: job.completedAt ? toClickHouseDateTime(job.completedAt) : null,
      },
    ],
    format: 'JSONEachRow',
  })
}

async function persistVerified(address: string, result: VerifiedArtifacts): Promise<void> {
  const previousPaths = await client
    .query({
      query: `SELECT path FROM price_data.contract_sources FINAL WHERE address = {address:String} AND deleted = 0`,
      query_params: { address },
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ path: string }>())
    .then(rows => rows.map(r => r.path))
  const { abiRow, sourceRows } = verifiedArtifactRows({
    address,
    result,
    codeHash: contractByH160(address)?.codeHash ?? '',
    previousPaths,
  })
  await Promise.all([
    client.insert({ table: 'price_data.contract_abis', values: [abiRow], format: 'JSONEachRow' }),
    sourceRows.length
      ? client.insert({ table: 'price_data.contract_sources', values: sourceRows, format: 'JSONEachRow' })
      : Promise.resolve(),
  ])
}

// --- poll ----------------------------------------------------------------

export async function getJob(verificationId: string): Promise<JobState | null> {
  const inProcess = jobs.get(verificationId)
  if (inProcess) return inProcess

  const rows = await client
    .query({
      query: `
        SELECT verification_id, address, status, match_type, contract_identifier,
               compiler_version, error_code, error_message, deployed_bytecode,
               toUnixTimestamp(submitted_at) AS submitted_ts,
               toUnixTimestamp(ifNull(completed_at, toDateTime(0))) AS completed_ts
        FROM price_data.contract_verifications FINAL
        WHERE verification_id = {id:String}
        LIMIT 1`,
      query_params: { id: verificationId },
      format: 'JSONEachRow',
    })
    .then(r =>
      r.json<{
        verification_id: string
        address: string
        status: string
        match_type: string
        contract_identifier: string
        compiler_version: string
        error_code: string
        error_message: string
        deployed_bytecode: string
        submitted_ts: number
        completed_ts: number
      }>(),
    )

  const row = rows[0]
  if (!row) return null
  return {
    verificationId: row.verification_id,
    address: row.address,
    chainId: CHAIN_ID,
    status: row.status === 'verified' ? 'verified' : row.status === 'failed' ? 'failed' : 'pending',
    matchType: row.match_type === 'FULL' ? 'FULL' : row.match_type === 'PARTIAL' ? 'PARTIAL' : '',
    contractIdentifier: row.contract_identifier,
    compilerVersion: row.compiler_version,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    deployedBytecode: row.deployed_bytecode,
    submittedAt: new Date(Number(row.submitted_ts) * 1000),
    // A pending job has no completion time; the query floors it to the epoch.
    completedAt: Number(row.completed_ts) > 0 ? new Date(Number(row.completed_ts) * 1000) : null,
  }
}

function toClickHouseDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}
