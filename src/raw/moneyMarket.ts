import { keccakAsHex } from '@polkadot/util-crypto'
import { deriveTruncatedAccountId, normalizeH160 } from './accountIdentity.js'
import { toJsonString } from './json.js'
import type {
  RawEvmLogRow,
  RawMoneyMarketEventRow,
  RawMoneyMarketPositionRow,
  RawMoneyMarketReserveRow,
  RawParserWarningRow,
} from './types.js'
import { chunk, forEachConcurrent } from '../util/collections.js'

const POOL_IMPLEMENTATION_PROXY = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const ATOKEN = '0xc0df4c545bafa1788a4ee55f79704d12fc2c7b5c'
// Second, isolated market introduced with GIGAHDX.  It is a first-class chain
// deployment now, rather than an optional launch-day override: keeping it here
// means fresh installs and future raw workers cannot silently miss its logs.
export const GIGAHDX_POOL_PROXY = '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923'
export const GIGAHDX_ATOKEN = '0x6b9ac524ec8f08c49ec80176b138d16eb461c3d8'
const HOLLAR = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const POOL_ADDRESS_PROVIDER = '0xf3ba4d1b50f78301bdd7eaea9b67822a15fca691'
const UI_POOL_DATA_PROVIDER = '0x112b087b60c1a166130d59266363c45f8aa99db0'
const MM_TREASURY = '0xe52567ff06acd6cbe7ba94dc777a3126e180b6d9'
const HSMPOOL_FACILITATOR = '0x6d6f646c70792f68736d6f640000000000000000'
export const DEFAULT_RAW_EVM_RPC_URL = 'https://hydration-rpc.n.dwellir.com'
export const DEFAULT_RAW_EVM_RPC_FALLBACK_URLS = [
  'https://hydration-rpc.n.dwellir.com',
  'https://rpc.coke.hydration.cloud',
  'https://rpc.sin.hydration.cloud',
]

// money markets
// Each AAVE v3 market is an isolated pool: getUserAccountData(user) on one pool
// returns ONLY that pool's aggregate, so every position read must target the pool
// the triggering log belongs to, and every derived row is tagged with its pool.
// Core and the deployed GIGAHDX market are built from the constants above.
// Future isolated deployments can still be supplied via RAW_MM_EXTRA_MARKETS:
//   RAW_MM_EXTRA_MARKETS=[{"key":"future","poolProxy":"0x…","contracts":["0x…aToken"]}]
// `contracts` lists the market-specific contracts whose logs belong to it (the pool
// proxy is added automatically). Contracts shared across markets (HOLLAR, treasury,
// the HSM facilitator) stay attributed to the core market for `pool_address`; that
// is harmless because per-market pool/a-token events already drive each market's
// position reads, and a redundant zero-position read against the core pool is
// skipped on insert.
export interface MoneyMarketDef {
  key: string
  poolProxy: string
  contracts: Set<string>
}

const CORE_MARKET: MoneyMarketDef = {
  key: 'core',
  poolProxy: POOL_IMPLEMENTATION_PROXY,
  contracts: new Set([POOL_IMPLEMENTATION_PROXY, ATOKEN]),
}

const GIGAHDX_MARKET: MoneyMarketDef = {
  key: 'gigahdx',
  poolProxy: GIGAHDX_POOL_PROXY,
  contracts: new Set([GIGAHDX_POOL_PROXY, GIGAHDX_ATOKEN]),
}

const SHARED_MM_CONTRACTS = new Set([
  HOLLAR,
  POOL_ADDRESS_PROVIDER,
  UI_POOL_DATA_PROVIDER,
  MM_TREASURY,
  HSMPOOL_FACILITATOR,
])

function parseExtraMarkets(): MoneyMarketDef[] {
  const raw = process.env.RAW_MM_EXTRA_MARKETS?.trim()
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('RAW_MM_EXTRA_MARKETS must be valid JSON')
  }
  if (!Array.isArray(parsed)) throw new Error('RAW_MM_EXTRA_MARKETS must be a JSON array')
  return parsed.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>
    const key = typeof record.key === 'string' && record.key.trim() !== '' ? record.key.trim() : `market${index + 1}`
    const poolProxy = normalizeH160(record.poolProxy)
    if (poolProxy == null) {
      throw new Error(`RAW_MM_EXTRA_MARKETS[${index}].poolProxy must be a 20-byte hex address`)
    }
    const contracts = new Set<string>([poolProxy])
    const rawContracts = Array.isArray(record.contracts) ? record.contracts : []
    for (const candidate of rawContracts) {
      const address = normalizeH160(candidate)
      if (address == null) {
        throw new Error(`RAW_MM_EXTRA_MARKETS[${index}].contracts contains an invalid address`)
      }
      contracts.add(address)
    }
    return { key, poolProxy, contracts }
  })
}

// Core is deliberately first: it is the primary market in every downstream
// presentation. Environment entries remain useful for future deployments, but
// cannot duplicate or reorder a built-in market.
const MONEY_MARKETS: MoneyMarketDef[] = (() => {
  const out: MoneyMarketDef[] = []
  const pools = new Set<string>()
  const keys = new Set<string>()
  for (const market of [CORE_MARKET, GIGAHDX_MARKET, ...parseExtraMarkets()]) {
    if (pools.has(market.poolProxy) || keys.has(market.key)) continue
    pools.add(market.poolProxy)
    keys.add(market.key)
    out.push(market)
  }
  return out
})()

const MARKET_BY_CONTRACT = new Map<string, MoneyMarketDef>()
for (const market of MONEY_MARKETS) {
  for (const contract of market.contracts) MARKET_BY_CONTRACT.set(contract, market)
}

// Every contract we extract money-market rows from: each market's own contracts
// plus the shared ones. Used as the log filter; market attribution is then by
// contract via marketForContract().
const CURRENT_MM_CONTRACTS = new Set<string>([
  ...MONEY_MARKETS.flatMap(market => [...market.contracts]),
  ...SHARED_MM_CONTRACTS,
])

// Which market a log belongs to, by emitting contract. Shared/unknown contracts
// fall back to the core market (preserving single-market behaviour).
function marketForContract(contractAddress: string): MoneyMarketDef {
  return MARKET_BY_CONTRACT.get(contractAddress.toLowerCase()) ?? CORE_MARKET
}

// The configured market keys (core + any from RAW_MM_EXTRA_MARKETS). Exposed for
// backfill/repair tooling that scopes work to one market.
export function moneyMarketKeys(): string[] {
  return MONEY_MARKETS.map(market => market.key)
}

// (poolProxy, marketKey) for every configured market. Used by the aToken-anchor
// snapshot to enumerate reserves (reservesList/reserveData) per pool.
export function moneyMarketPools(): { poolProxy: string; marketKey: string }[] {
  return MONEY_MARKETS.map(market => ({ poolProxy: market.poolProxy, marketKey: market.key }))
}

// Read-only runtime descriptors for maintenance services. Callers receive fresh
// arrays so they cannot mutate the extractor's contract routing sets.
export interface MoneyMarketRuntimeDef {
  key: string
  poolProxy: string
  contracts: string[]
}

export function moneyMarketDefinitions(): MoneyMarketRuntimeDef[] {
  return MONEY_MARKETS.map(market => ({
    key: market.key,
    poolProxy: market.poolProxy,
    contracts: [...market.contracts],
  }))
}

const USER_EVENT_NAMES = new Set([
  'Approval',
  'BackUnbacked',
  'BalanceTransfer',
  'Borrow',
  'Burn',
  'FlashLoan',
  'LiquidationCall',
  'Mint',
  'MintUnbacked',
  'RebalanceStableBorrowRate',
  'Repay',
  'ReserveUsedAsCollateralDisabled',
  'ReserveUsedAsCollateralEnabled',
  'Supply',
  'SwapBorrowRateMode',
  'Transfer',
  'UserEModeSet',
  'Withdraw',
])

const POSITION_TRIGGER_EVENTS = new Set([
  'BalanceTransfer',
  'Borrow',
  'Burn',
  'LiquidationCall',
  'Mint',
  'Repay',
  'ReserveUsedAsCollateralDisabled',
  'ReserveUsedAsCollateralEnabled',
  'Supply',
  'Transfer',
  'UserEModeSet',
  'Withdraw',
])

const RESERVE_EVENT_NAMES = new Set([
  'DelegatedTokenUpdated',
  'FacilitatorAdded',
  'FacilitatorBucketCapacityUpdated',
  'FacilitatorBucketLevelUpdated',
  'FacilitatorRemoved',
  'Initialized',
  'IsolationModeTotalDebtUpdated',
  'MintedToTreasury',
  'OracleUpdate',
  'OwnershipTransferred',
  'PriceUpdated',
  'ReserveDataUpdated',
  'RoleAdminChanged',
  'RoleGranted',
  'RoleRevoked',
  'UpdaterAddressChange',
])

export interface MoneyMarketExtractionResult {
  events: RawMoneyMarketEventRow[]
  positions: RawMoneyMarketPositionRow[]
  reserves: RawMoneyMarketReserveRow[]
  warnings: RawParserWarningRow[]
}

function parseDecodedArgs(row: RawEvmLogRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.decoded_args_json) as unknown
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function isCurrentMoneyMarketLog(row: RawEvmLogRow): boolean {
  if (row.decode_status !== 'decoded' || row.event_name == null) return false
  return CURRENT_MM_CONTRACTS.has(row.contract_address.toLowerCase())
}

function addressArg(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const address = normalizeH160(args[key])
    if (address != null) return address
  }
  return null
}

function stringArg(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && /^\d+$/.test(value)) return value
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value).toString()
    if (typeof value === 'bigint') return value.toString()
  }
  return null
}

function uniqueAddresses(values: Iterable<string | null>): string[] {
  const addresses: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const address = normalizeH160(value)
    if (address == null || seen.has(address)) continue
    seen.add(address)
    addresses.push(address)
  }
  return addresses
}

function positionObservationId(row: RawEvmLogRow, userAddress: string): string {
  return `money-market:${row.block_height}:${row.event_index}:${userAddress}`
}

// Periodic-snapshot id. The core market keeps its original key (so existing rows
// dedupe and forward-fill continuity is preserved); extra markets get a market-key
// suffix so the same borrower's per-market snapshots don't collide.
function periodicObservationId(blockHeight: number, userAddress: string, market: MoneyMarketDef): string {
  return market.key === CORE_MARKET.key
    ? `money-market-periodic:${blockHeight}:${userAddress}`
    : `money-market-periodic:${market.key}:${blockHeight}:${userAddress}`
}

function parseRpcUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`RAW_EVM_RPC_URL must be a valid HTTP(S) URL, got "${trimmed}"`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`RAW_EVM_RPC_URL must use http or https for eth_call, got "${trimmed}"`)
  }

  return trimmed
}

function evmRpcUrls(): string[] {
  const primary = process.env.RAW_EVM_RPC_URL?.trim() || DEFAULT_RAW_EVM_RPC_URL
  const fallbackConfig = process.env.RAW_EVM_RPC_FALLBACK_URLS ?? DEFAULT_RAW_EVM_RPC_FALLBACK_URLS.join(',')
  const candidates = [
    primary,
    ...fallbackConfig.split(',').map(value => value.trim()).filter(value => value !== ''),
  ]
  const urls: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const url = parseRpcUrl(candidate)
    if (seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  return urls
}

function rpcOriginForEvidence(rpcUrl: string): string {
  return new URL(rpcUrl).origin
}

export function assertMoneyMarketPositionConfig(): void {
  evmRpcUrls()
}

function moneyMarketEthCallTimeoutMs(): number {
  const configured = Number.parseInt(process.env.RAW_MONEY_MARKET_ETH_CALL_TIMEOUT_MS ?? '20000', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 60_000) : 20_000
}

function moneyMarketPositionConcurrency(): number {
  const configured = Number.parseInt(process.env.RAW_MONEY_MARKET_POSITION_CONCURRENCY ?? '8', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 20) : 8
}

function moneyMarketBatchSize(): number {
  const configured = Number.parseInt(process.env.RAW_MONEY_MARKET_BATCH_SIZE ?? '50', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 100) : 50
}

function encodeGetUserAccountData(address: string): string {
  const selector = keccakAsHex('getUserAccountData(address)').slice(2, 10)
  const paddedAddress = address.slice(2).padStart(64, '0')
  return `0x${selector}${paddedAddress}`
}

function decodeUserAccountData(result: string): Omit<RawMoneyMarketPositionRow,
  'block_height' | 'block_timestamp' | 'observation_id' | 'user_address' | 'account_id' | 'pool_address' | 'evidence_json' | 'ingest_source'
> {
  const body = result.startsWith('0x') ? result.slice(2) : result
  const words: string[] = []
  for (let i = 0; i < 6; i++) {
    const word = body.slice(i * 64, (i + 1) * 64)
    if (word.length !== 64) throw new Error('getUserAccountData returned fewer than six words')
    words.push(BigInt(`0x${word}`).toString())
  }
  return {
    total_collateral_base: words[0],
    total_debt_base: words[1],
    available_borrows_base: words[2],
    current_liquidation_threshold: words[3],
    ltv: words[4],
    health_factor: words[5],
  }
}

function userPositionRequest(userAddress: string, blockHeight: number, poolProxy: string): {
  jsonrpc: '2.0'
  id: string
  method: 'eth_call'
  params: Array<Record<string, string> | string>
} {
  return {
    jsonrpc: '2.0',
    id: `raw-money-market-${blockHeight}-${userAddress}`,
    method: 'eth_call',
    params: [
      {
        to: poolProxy,
        data: encodeGetUserAccountData(userAddress),
      },
      `0x${blockHeight.toString(16)}`,
    ],
  }
}

async function fetchMoneyMarketRpc(rpcUrl: string, body: unknown): Promise<unknown> {
  const timeoutMs = moneyMarketEthCallTimeoutMs()
  let response: Response
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`Money Market eth_call timed out after ${timeoutMs}ms`)
    }
    throw error
  }
  if (!response.ok) {
    throw new Error(`Money Market eth_call failed with HTTP ${response.status} ${response.statusText}`)
  }

  return response.json()
}

async function readUserPositions(userAddresses: string[], blockHeight: number, rpcUrl: string, poolProxy: string): Promise<Map<string, {
  metrics: ReturnType<typeof decodeUserAccountData>
  evidence: Record<string, unknown>
}>> {
  const requests = userAddresses.map(userAddress => userPositionRequest(userAddress, blockHeight, poolProxy))
  const rawJson = await fetchMoneyMarketRpc(rpcUrl, requests.length === 1 ? requests[0] : requests)
  const responses = Array.isArray(rawJson) ? rawJson : [rawJson]
  const responsesById = new Map<string, { result?: string; error?: unknown }>()
  for (const response of responses) {
    if (response != null && typeof response === 'object') {
      const record = response as { id?: unknown; result?: string; error?: unknown }
      if (typeof record.id === 'string') responsesById.set(record.id, record)
    }
  }

  const positions = new Map<string, {
    metrics: ReturnType<typeof decodeUserAccountData>
    evidence: Record<string, unknown>
  }>()
  for (const request of requests) {
    const userAddress = request.id.slice(`raw-money-market-${blockHeight}-`.length)
    const response = responsesById.get(request.id) ?? (requests.length === 1 && responses.length === 1 && responses[0] != null && typeof responses[0] === 'object'
      ? responses[0] as { result?: string; error?: unknown }
      : undefined)
    if (response == null || typeof response.result !== 'string') {
      throw new Error(`Money Market eth_call failed: ${toJsonString(response?.error ?? response ?? { id: request.id, error: 'missing response' })}`)
    }
    positions.set(userAddress, {
      metrics: decodeUserAccountData(response.result),
      evidence: {
        rpc_origin: rpcOriginForEvidence(rpcUrl),
        rpc_method: 'eth_call',
        pool: poolProxy,
        block_tag: request.params[1],
      },
    })
  }
  return positions
}

async function readUserPositionsWithFallback(userAddresses: string[], blockHeight: number, rpcUrls: string[], poolProxy: string): Promise<Map<string, {
  metrics: ReturnType<typeof decodeUserAccountData>
  evidence: Record<string, unknown>
}>> {
  let lastError: unknown
  const attemptedOrigins: string[] = []
  for (const rpcUrl of rpcUrls) {
    attemptedOrigins.push(rpcOriginForEvidence(rpcUrl))
    try {
      return await readUserPositions(userAddresses, blockHeight, rpcUrl, poolProxy)
    } catch (error) {
      lastError = error
    }
  }

  const detail = lastError instanceof Error ? lastError.message : 'Money Market eth_call failed'
  throw new Error(`${detail}; attempted RPC origins: ${attemptedOrigins.join(', ')}`)
}

function positionWarning(
  row: RawEvmLogRow,
  userAddress: string,
  rpcUrls: string[],
  ingestSource: string,
  error: unknown,
): RawParserWarningRow {
  return {
    block_height: row.block_height,
    block_timestamp: row.block_timestamp,
    parser: 'raw_money_market',
    source_kind: 'evm_log',
    source_name: row.event_name ?? '',
    source_index: row.event_index.toString(),
    warning_code: 'position_eth_call_failed',
    warning: error instanceof Error ? error.message : 'Money Market eth_call failed',
    evidence_json: toJsonString({
      raw_evm_log_event_index: row.event_index,
      event_signature: row.event_signature,
      user_address: userAddress,
      rpc_origins: rpcUrls.map(rpcOriginForEvidence),
    }),
    ingest_source: ingestSource,
  }
}

function periodicPositionWarning(
  userAddress: string,
  blockHeight: number,
  blockTimestamp: string,
  rpcUrls: string[],
  ingestSource: string,
  error: unknown,
): RawParserWarningRow {
  return {
    block_height: blockHeight,
    block_timestamp: blockTimestamp,
    parser: 'raw_money_market',
    source_kind: 'periodic_snapshot',
    source_name: 'getUserAccountData',
    source_index: userAddress,
    warning_code: 'periodic_position_eth_call_failed',
    warning: error instanceof Error ? error.message : 'Money Market periodic eth_call failed',
    evidence_json: toJsonString({
      user_address: userAddress,
      rpc_origins: rpcUrls.map(rpcOriginForEvidence),
    }),
    ingest_source: ingestSource,
  }
}

// Re-snapshot a set of borrowers' aggregate positions at an arbitrary block via
// getUserAccountData — independent of whether they emitted an MM event at that
// block. This is the periodic re-aggregation the explorer's portfolio history
// relies on: between a borrower's own MM actions their collateral/debt still
// drifts (interest accrual + oracle price moves), so event-only snapshots leave
// the curve frozen until the next user action. Mirrors hydration-data-lake's
// per-oracle-update position aggregation (handleAllAccountsMmPositionDataUpdate).
// Zero positions are skipped by default: core opens/exits are already captured by
// the event-driven snapshots, so a zero there is just an inactive account and would
// bloat the table. Supplemental followers can intentionally request zero rows as
// tombstones because a still-running older raw worker does not emit their exit
// snapshots; the bounded sparse sweep then closes positions correctly.
export async function snapshotMoneyMarketPositions(
  userAddresses: Iterable<string>,
  blockHeight: number,
  blockTimestamp: string,
  ingestSource: string,
  options: { marketKeys?: Iterable<string>; includeZeroPositions?: boolean } = {},
): Promise<{ positions: RawMoneyMarketPositionRow[]; warnings: RawParserWarningRow[] }> {
  const positions: RawMoneyMarketPositionRow[] = []
  const warnings: RawParserWarningRow[] = []
  const addresses = uniqueAddresses(userAddresses)
  if (addresses.length === 0) return { positions, warnings }

  const rpcUrls = evmRpcUrls()
  const batches = chunk(addresses, moneyMarketBatchSize())
  const requestedMarkets = options.marketKeys == null ? null : new Set(options.marketKeys)
  const selectedMarkets = requestedMarkets == null
    ? MONEY_MARKETS
    : MONEY_MARKETS.filter(market => requestedMarkets.has(market.key))
  if (requestedMarkets != null) {
    const known = new Set(selectedMarkets.map(market => market.key))
    const unknown = [...requestedMarkets].filter(key => !known.has(key))
    if (unknown.length > 0) throw new Error(`unknown money-market snapshot key(s): ${unknown.join(', ')}`)
  }
  // Each isolated market needs its own getUserAccountData read per borrower, so
  // fan out over (market × batch). Inactive (market, user) pairs return zeroed
  // totals and are skipped, so this only materialises real positions per market.
  const work = selectedMarkets.flatMap(market => batches.map(batch => ({ market, batch })))
  await forEachConcurrent(work, moneyMarketPositionConcurrency(), async ({ market, batch }) => {
    let positionsByUser: Awaited<ReturnType<typeof readUserPositionsWithFallback>>
    try {
      positionsByUser = await readUserPositionsWithFallback(batch, blockHeight, rpcUrls, market.poolProxy)
    } catch (error) {
      for (const userAddress of batch) {
        warnings.push(periodicPositionWarning(userAddress, blockHeight, blockTimestamp, rpcUrls, ingestSource, error))
      }
      return
    }

    for (const userAddress of batch) {
      const position = positionsByUser.get(userAddress)
      if (position == null) {
        warnings.push(periodicPositionWarning(userAddress, blockHeight, blockTimestamp, rpcUrls, ingestSource, new Error('eth_call returned no position')))
        continue
      }
      if (!options.includeZeroPositions
        && position.metrics.total_collateral_base === '0'
        && position.metrics.total_debt_base === '0') continue
      positions.push({
        block_height: blockHeight,
        block_timestamp: blockTimestamp,
        observation_id: periodicObservationId(blockHeight, userAddress, market),
        user_address: userAddress,
        account_id: deriveTruncatedAccountId(userAddress),
        pool_address: market.poolProxy,
        ...position.metrics,
        evidence_json: toJsonString({ trigger: 'periodic_snapshot', ...position.evidence }),
        ingest_source: ingestSource,
      })
    }
  })

  positions.sort((left, right) => left.observation_id.localeCompare(right.observation_id))
  return { positions, warnings }
}

function reserveMetrics(args: Record<string, unknown>, eventName: string): Record<string, unknown> {
  const metrics: Record<string, unknown> = {}
  for (const key of [
    'liquidityRate',
    'stableBorrowRate',
    'variableBorrowRate',
    'liquidityIndex',
    'variableBorrowIndex',
    'totalDebt',
    'amountMinted',
    'bucketCapacity',
    'oldCapacity',
    'newCapacity',
    'oldLevel',
    'newLevel',
    'value',
    'answer',
    'timestamp',
  ]) {
    if (args[key] != null) metrics[key] = args[key]
  }
  metrics.event = eventName
  return metrics
}

// Options for backfill/repair callers. `marketKeys` restricts extraction to the
// given market(s) (by key) so a single-market backfill doesn't re-derive the rest;
// `skipPositions` derives only events + reserves (a pure transform with no eth_call
// RPC), for the cheap idempotent part of a migration.
export interface ExtractMoneyMarketOptions {
  marketKeys?: Iterable<string>
  skipPositions?: boolean
}

export async function extractMoneyMarketRows(
  evmLogs: RawEvmLogRow[],
  ingestSource: string,
  options: ExtractMoneyMarketOptions = {},
): Promise<MoneyMarketExtractionResult> {
  const events: RawMoneyMarketEventRow[] = []
  const reserves: RawMoneyMarketReserveRow[] = []
  const positions: RawMoneyMarketPositionRow[] = []
  const warnings: RawParserWarningRow[] = []
  const marketFilter = options.marketKeys != null ? new Set(options.marketKeys) : null
  const positionTasks = new Map<string, {
    row: RawEvmLogRow
    userAddress: string
    poolProxy: string
    entries: Array<{ row: RawEvmLogRow; id: string }>
  }>()
  const positionSeen = new Set<string>()

  for (const row of evmLogs) {
    if (!isCurrentMoneyMarketLog(row) || row.event_name == null) continue

    const market = marketForContract(row.contract_address)
    if (marketFilter != null && !marketFilter.has(market.key)) continue
    const args = parseDecodedArgs(row)
    const userAddress = addressArg(args, ['user', 'onBehalfOf', 'from', 'to', 'owner', 'account', 'caller', 'repayer', 'liquidator', 'backer', 'target'])
    const assetAddress = addressArg(args, ['reserve', 'asset', 'underlyingAsset', 'collateralAsset', 'debtAsset', 'oldDelegatedToken', 'newDelegatedToken'])
    const amount = stringArg(args, ['amount', 'value', 'debtToCover', 'liquidatedCollateralAmount', 'amountMinted', 'bucketCapacity', 'newLevel'])
    const participants = uniqueAddresses([
      ...row.participants,
      addressArg(args, ['user']),
      addressArg(args, ['onBehalfOf']),
      addressArg(args, ['from']),
      addressArg(args, ['to']),
      addressArg(args, ['owner']),
      addressArg(args, ['account']),
      addressArg(args, ['caller']),
      addressArg(args, ['repayer']),
      addressArg(args, ['liquidator']),
      addressArg(args, ['backer']),
      addressArg(args, ['target']),
    ])

    let positionId: string | null = null
    if (USER_EVENT_NAMES.has(row.event_name)) {
      if (userAddress != null && POSITION_TRIGGER_EVENTS.has(row.event_name)) {
        positionId = positionObservationId(row, userAddress)
      }
      events.push({
        block_height: row.block_height,
        block_timestamp: row.block_timestamp,
        event_index: row.event_index,
        contract_address: row.contract_address,
        pool_address: market.poolProxy,
        event_name: row.event_name,
        user_address: userAddress,
        account_id: userAddress == null ? null : deriveTruncatedAccountId(userAddress),
        asset_address: assetAddress,
        amount,
        participants,
        decoded_args_json: row.decoded_args_json,
        position_observation_id: positionId,
        evidence_json: toJsonString({
          raw_evm_log_event_index: row.event_index,
          event_signature: row.event_signature,
          market: market.key,
          current_market_contracts: {
            pool: market.poolProxy,
            routed_contracts: [...market.contracts],
            shared_hollar: HOLLAR,
          },
        }),
        ingest_source: ingestSource,
      })
    }

    if (RESERVE_EVENT_NAMES.has(row.event_name)) {
      reserves.push({
        block_height: row.block_height,
        block_timestamp: row.block_timestamp,
        event_index: row.event_index,
        contract_address: row.contract_address,
        pool_address: market.poolProxy,
        event_name: row.event_name,
        reserve_address: addressArg(args, ['reserve', 'underlyingAsset', 'asset']),
        asset_address: assetAddress,
        metrics_json: toJsonString(reserveMetrics(args, row.event_name)),
        decoded_args_json: row.decoded_args_json,
        evidence_json: toJsonString({
          raw_evm_log_event_index: row.event_index,
          event_signature: row.event_signature,
        }),
        ingest_source: ingestSource,
      })
    }

    if (!POSITION_TRIGGER_EVENTS.has(row.event_name)) continue
    for (const participant of participants) {
      const id = positionObservationId(row, participant)
      if (positionSeen.has(id)) continue
      positionSeen.add(id)
      // Key by market too: a borrower active in two isolated markets at the same
      // block needs a separate getUserAccountData read against each pool.
      const readKey = `${row.block_height}:${market.poolProxy}:${participant}`
      const task = positionTasks.get(readKey)
      if (task == null) {
        positionTasks.set(readKey, {
          row,
          userAddress: participant,
          poolProxy: market.poolProxy,
          entries: [{ row, id }],
        })
      } else {
        task.entries.push({ row, id })
      }
    }
  }

  if (positionTasks.size > 0 && !options.skipPositions) {
    const rpcUrls = evmRpcUrls()
    // Group by (block, pool): one getUserAccountData batch hits a single pool at a
    // single block height.
    const tasksByBlockPool = new Map<string, Array<{
      row: RawEvmLogRow
      userAddress: string
      poolProxy: string
      entries: Array<{ row: RawEvmLogRow; id: string }>
    }>>()
    for (const task of positionTasks.values()) {
      const groupKey = `${task.row.block_height}:${task.poolProxy}`
      const tasks = tasksByBlockPool.get(groupKey)
      if (tasks == null) {
        tasksByBlockPool.set(groupKey, [task])
      } else {
        tasks.push(task)
      }
    }
    const taskBatches = [...tasksByBlockPool.values()].flatMap(tasks => chunk(tasks, moneyMarketBatchSize()))

    await forEachConcurrent(taskBatches, moneyMarketPositionConcurrency(), async (tasks) => {
      const blockHeight = tasks[0]?.row.block_height
      const poolProxy = tasks[0]?.poolProxy
      if (blockHeight == null || poolProxy == null) return
      try {
        const positionsByUser = await readUserPositionsWithFallback(tasks.map(task => task.userAddress), blockHeight, rpcUrls, poolProxy)
        for (const task of tasks) {
          const position = positionsByUser.get(task.userAddress)
          if (position == null) {
            throw new Error(`Money Market eth_call returned no position for ${task.userAddress}`)
          }
          for (const entry of task.entries) {
            positions.push({
              block_height: entry.row.block_height,
              block_timestamp: entry.row.block_timestamp,
              observation_id: entry.id,
              user_address: task.userAddress,
              account_id: deriveTruncatedAccountId(task.userAddress),
              pool_address: task.poolProxy,
              ...position.metrics,
              evidence_json: toJsonString({
                raw_evm_log_event_index: entry.row.event_index,
                event_name: entry.row.event_name,
                ...position.evidence,
              }),
              ingest_source: ingestSource,
            })
          }
        }
      } catch (error) {
        for (const task of tasks) {
          for (const entry of task.entries) {
            warnings.push(positionWarning(entry.row, task.userAddress, rpcUrls, ingestSource, error))
          }
        }
      }
    })
  }

  positions.sort((left, right) =>
    left.block_height - right.block_height ||
    left.observation_id.localeCompare(right.observation_id)
  )

  return { events, positions, reserves, warnings }
}
