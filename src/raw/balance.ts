import { xxhashAsHex } from '@polkadot/util-crypto'
import type { Block as StorageBlock } from '../types/support.js'
import * as systemStorage from '../types/system/storage.js'
import * as tokensStorage from '../types/tokens/storage.js'
import type { RawCall, RawEvent } from './processor.js'
import { callAddressToString, toJsonString } from './json.js'
import { deriveTruncatedAccountId, extractHexLike, normalizeAccountId, normalizeH160 } from './accountIdentity.js'
import type { RawBalanceObservationRow, RawParserWarningRow } from './types.js'
import { chunk, forEachConcurrent } from '../util/collections.js'

const NATIVE_ASSET_ID = '0'
const GENESIS_BOOTSTRAP_BLOCK = 1
const STORAGE_PREFIXES = {
  systemAccount: storagePrefix('System', 'Account'),
  tokensAccounts: storagePrefix('Tokens', 'Accounts'),
}

interface BalanceCandidate {
  accountId: string
  assetId: string
  assetKind: string
  sourceKind: string
  sourceName: string
  sourceEventIndex: number | null
  sourceCallAddress: string | null
  evidence: unknown
}

interface BalanceReadResult {
  free: string | null
  reserved: string | null
  frozen: string | null
  total: string | null
  nonce: number | null
  flags: string | null
}

interface IndexedBalanceCandidate {
  id: string
  candidate: BalanceCandidate
}

export interface BalanceExtractionResult {
  observations: RawBalanceObservationRow[]
  warnings: RawParserWarningRow[]
}

export interface DecodedBalanceStorageKey {
  storageItem: 'System.Account' | 'Tokens.Accounts'
  accountId: string
  assetId: string
}

function storagePrefix(pallet: string, item: string): string {
  return `${xxhashAsHex(pallet, 128)}${xxhashAsHex(item, 128).slice(2)}`.toLowerCase()
}

function lowerHex(value: string): string {
  return value.toLowerCase()
}

function decodeLittleEndianUInt(hexWithoutPrefix: string): number | null {
  if (hexWithoutPrefix.length < 2 || hexWithoutPrefix.length % 2 !== 0) return null
  const bytes = Buffer.from(hexWithoutPrefix, 'hex')
  let value = 0
  for (let i = 0; i < bytes.length; i++) {
    value += bytes[i] * (256 ** i)
  }
  return Number.isSafeInteger(value) ? value : null
}

function storageKeyCandidates(value: unknown): string[] {
  const keys: string[] = []
  const visit = (current: unknown): void => {
    const hex = extractHexLike(current)
    if (hex != null && hex.length > 66) {
      keys.push(hex)
      return
    }

    if (Array.isArray(current)) {
      for (const item of current) visit(item)
      return
    }
    if (current != null && typeof current === 'object') {
      for (const nested of Object.values(current as Record<string, unknown>)) visit(nested)
    }
  }
  visit(value)
  return [...new Set(keys.map(lowerHex))]
}

export function decodeBalanceStorageKey(key: string): DecodedBalanceStorageKey | null {
  const normalized = lowerHex(key)

  if (normalized.startsWith(STORAGE_PREFIXES.systemAccount)) {
    const remainder = normalized.slice(STORAGE_PREFIXES.systemAccount.length)
    const accountHex = `0x${remainder.slice(32, 96)}`
    const accountId = normalizeAccountId(accountHex)
    if (accountId == null) return null
    return {
      storageItem: 'System.Account',
      accountId,
      assetId: NATIVE_ASSET_ID,
    }
  }

  if (normalized.startsWith(STORAGE_PREFIXES.tokensAccounts)) {
    const remainder = normalized.slice(STORAGE_PREFIXES.tokensAccounts.length)
    const accountHex = `0x${remainder.slice(32, 96)}`
    const assetHexStart = 96 + 16
    const assetHex = remainder.slice(assetHexStart, assetHexStart + 8)
    const accountId = normalizeAccountId(accountHex)
    const assetId = decodeLittleEndianUInt(assetHex)
    if (accountId == null || assetId == null) return null
    return {
      storageItem: 'Tokens.Accounts',
      accountId,
      assetId: assetId.toString(),
    }
  }

  return null
}

function extractStorageBalanceCandidate(
  key: string,
  call: RawCall,
  blockTimestamp: string,
  ingestSource: string,
): { candidate: BalanceCandidate | null; warning: RawParserWarningRow | null } {
  const normalized = lowerHex(key)
  const callAddress = callAddressToString(call.address)
  const sourceIndex = callAddress ?? call.id
  const baseWarning = (warningCode: string, warning: string): RawParserWarningRow => ({
    block_height: call.block.height,
    block_timestamp: blockTimestamp,
    parser: 'raw_balance',
    source_kind: 'call',
    source_name: call.name ?? '',
    source_index: sourceIndex,
    warning_code: warningCode,
    warning,
    evidence_json: toJsonString({ call: call.name, key, args: call.args ?? null }),
    ingest_source: ingestSource,
  })

  const decodedKey = decodeBalanceStorageKey(normalized)
  if (normalized.startsWith(STORAGE_PREFIXES.systemAccount)) {
    if (decodedKey == null) {
      return { candidate: null, warning: baseWarning('unparsed_system_account_key', 'System.Account storage key did not contain a decodable AccountId32') }
    }
    return {
      warning: null,
      candidate: {
        accountId: decodedKey.accountId,
        assetId: decodedKey.assetId,
        assetKind: 'substrate',
        sourceKind: 'storage_mutation',
        sourceName: call.name ?? 'System.set_storage',
        sourceEventIndex: null,
        sourceCallAddress: callAddress,
        evidence: {
          call: call.name,
          storage_key: key,
          storage_item: 'System.Account',
          reason: 'post-state read after System.set_storage',
        },
      },
    }
  }

  if (normalized.startsWith(STORAGE_PREFIXES.tokensAccounts)) {
    if (decodedKey == null) {
      return { candidate: null, warning: baseWarning('unparsed_tokens_account_key', 'Tokens.Accounts storage key did not contain a decodable account/asset pair') }
    }
    return {
      warning: null,
      candidate: {
        accountId: decodedKey.accountId,
        assetId: decodedKey.assetId,
        assetKind: 'substrate',
        sourceKind: 'storage_mutation',
        sourceName: call.name ?? 'System.set_storage',
        sourceEventIndex: null,
        sourceCallAddress: callAddress,
        evidence: {
          call: call.name,
          storage_key: key,
          storage_item: 'Tokens.Accounts',
          reason: 'post-state read after System.set_storage',
        },
      },
    }
  }

  return { candidate: null, warning: null }
}

function toBigIntString(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value).toString()
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  return null
}

function bigintOrZero(value: unknown): bigint {
  const stringValue = toBigIntString(value)
  return stringValue == null ? 0n : BigInt(stringValue)
}

function nativeV205Balance(value: { data: { free: unknown; reserved: unknown; frozen: unknown; flags: unknown }; nonce: number }): BalanceReadResult {
  const free = bigintOrZero(value.data.free)
  const reserved = bigintOrZero(value.data.reserved)
  return {
    free: free.toString(),
    reserved: reserved.toString(),
    frozen: bigintOrZero(value.data.frozen).toString(),
    total: (free + reserved).toString(),
    nonce: value.nonce,
    flags: String(value.data.flags),
  }
}

function nativeV100Balance(value: { data: { free: unknown; reserved: unknown; miscFrozen: unknown; feeFrozen: unknown }; nonce: number }): BalanceReadResult {
  const free = bigintOrZero(value.data.free)
  const reserved = bigintOrZero(value.data.reserved)
  const frozen = bigintOrZero(value.data.miscFrozen) > bigintOrZero(value.data.feeFrozen)
    ? bigintOrZero(value.data.miscFrozen)
    : bigintOrZero(value.data.feeFrozen)
  return {
    free: free.toString(),
    reserved: reserved.toString(),
    frozen: frozen.toString(),
    total: (free + reserved).toString(),
    nonce: value.nonce,
    flags: null,
  }
}

function tokenBalance(value: { free: unknown; reserved: unknown; frozen: unknown }): BalanceReadResult {
  const free = bigintOrZero(value.free)
  const reserved = bigintOrZero(value.reserved)
  return {
    free: free.toString(),
    reserved: reserved.toString(),
    frozen: bigintOrZero(value.frozen).toString(),
    total: (free + reserved).toString(),
    nonce: null,
    flags: null,
  }
}

function assetIdFromUnknown(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value.toString()
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.__kind === 'Token' && record.value != null) return assetIdFromUnknown(record.value)
    if (record.__kind === 'ForeignAsset' && record.value != null) return assetIdFromUnknown(record.value)
    for (const key of ['id', 'value', 'assetId', 'asset_id', 'currencyId', 'currency_id']) {
      const nested = assetIdFromUnknown(record[key])
      if (nested != null) return nested
    }
  }
  return null
}

function collectAssets(value: unknown): string[] {
  const assets = new Set<string>()
  const visit = (current: unknown, keyHint = ''): void => {
    if (
      /^(asset|assetId|asset_id|currency|currencyId|currency_id|token|tokenId|token_id)$/i.test(keyHint) ||
      /asset|currency|token/i.test(keyHint)
    ) {
      const asset = assetIdFromUnknown(current)
      if (asset != null) assets.add(asset)
    }

    if (Array.isArray(current)) {
      for (const item of current) visit(item)
      return
    }
    if (current != null && typeof current === 'object') {
      for (const [key, nested] of Object.entries(current as Record<string, unknown>)) visit(nested, key)
    }
  }
  visit(value)
  return [...assets]
}

function collectAccounts(value: unknown): string[] {
  const accounts = new Set<string>()
  const visit = (current: unknown, keyHint = ''): void => {
    const account = normalizeAccountId(current)
    if (account != null) {
      accounts.add(account)
      return
    }

    const h160 = normalizeH160(current)
    if (h160 != null && /address|evm|h160|account|from|to|who|owner|user|recipient|sender/i.test(keyHint)) {
      accounts.add(deriveTruncatedAccountId(h160))
      return
    }

    if (Array.isArray(current)) {
      for (const item of current) visit(item, keyHint)
      return
    }
    if (current != null && typeof current === 'object') {
      for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
        if (/from|to|who|account|owner|source|dest|beneficiary|sender|recipient|user|target|address/i.test(key)) {
          visit(nested, key)
        } else if (typeof nested === 'object') {
          visit(nested, key)
        }
      }
    }
  }
  visit(value)
  return [...accounts]
}

function isBalanceEvent(name: string): boolean {
  if (name === 'EVM.Log') return false
  return /^(Balances|Tokens|Currencies)\./.test(name) ||
    name === 'System.NewAccount' ||
    name === 'System.KilledAccount' ||
    /^(EVM|EVMAccounts)\./.test(name)
}

function isBalanceCall(name: string): boolean {
  return /^(Balances|Tokens|Currencies|EVM|EVMAccounts)\./.test(name)
}

function isAdministrativeCall(name: string): boolean {
  return name === 'System.set_storage' ||
    /^(Sudo|Utility|Scheduler|Democracy|Referenda|Whitelist|Preimage|Council|TechnicalCommittee)\./.test(name)
}

// Pallets whose balance events/calls imply the native asset by construction:
// their args never carry a substrate asset id. Balances./System. are native-
// only; EVM./EVMAccounts. events (Executed, Bound, …) also never encode a
// substrate asset — the intended observation there is the account's NATIVE
// balance (gas fees, binding deposits), and ERC20 movements arrive through the
// dedicated EVM-log path instead. Only Tokens./Currencies. genuinely encode an
// asset id in their args, so an empty collectAssets() result there means the
// shape couldn't be decoded (runtime change) — skip + warn rather than
// fabricate a native observation for an unknown asset.
function isNativeImpliedEventSource(name: string): boolean {
  return name.startsWith('Balances.') || name.startsWith('System.') ||
    name.startsWith('EVM.') || name.startsWith('EVMAccounts.')
}

function isNativeImpliedCallSource(name: string): boolean {
  return name.startsWith('Balances.') ||
    name.startsWith('EVM.') || name.startsWith('EVMAccounts.')
}

// Event candidates have no per-row warning channel (candidatesFromEvent only
// returns BalanceCandidate[]), so anomalies are logged instead. Deduped per
// event name per process to avoid flooding logs on a hot path.
const warnedUndecodedAssetEventNames = new Set<string>()

function warnUndecodedAssetEvent(name: string): void {
  if (warnedUndecodedAssetEventNames.has(name)) return
  warnedUndecodedAssetEventNames.add(name)
  console.warn(`[RawBalance] ${name} carried an account but no decodable asset id; skipping balance candidate(s) instead of assuming the native asset`)
}

function candidatesFromEvent(event: RawEvent): BalanceCandidate[] {
  const name = event.name ?? ''
  if (!isBalanceEvent(name)) return []
  const accounts = collectAccounts(event.args)
  if (accounts.length === 0) return []

  const assets = isNativeImpliedEventSource(name) ? [NATIVE_ASSET_ID] : collectAssets(event.args)
  if (assets.length === 0) {
    warnUndecodedAssetEvent(name)
    return []
  }

  const candidates: BalanceCandidate[] = []
  for (const accountId of accounts) {
    for (const assetId of assets) {
      candidates.push({
        accountId,
        assetId,
        assetKind: 'substrate',
        sourceKind: 'event',
        sourceName: name,
        sourceEventIndex: event.index,
        sourceCallAddress: callAddressToString(event.callAddress),
        evidence: {
          event: name,
          event_index: event.index,
          args: event.args ?? null,
        },
      })
    }
  }
  return candidates
}

interface CallCandidateResult {
  candidates: BalanceCandidate[]
  warningNeeded: boolean
  // Set only for the new undecodable-multi-asset-shape case below, so the
  // caller can surface an accurate warning without changing the meaning of
  // warningNeeded for the pre-existing branches (administrative calls / no
  // accounts decoded), whose warning wiring is untouched.
  warningCode?: string
  warningMessage?: string
}

function candidatesFromCall(call: RawCall): CallCandidateResult {
  const name = call.name ?? ''
  if (!isBalanceCall(name)) return { candidates: [], warningNeeded: isAdministrativeCall(name) }

  const accounts = collectAccounts(call.args)
  if (accounts.length === 0) return { candidates: [], warningNeeded: true }

  const assets = isNativeImpliedCallSource(name) ? [NATIVE_ASSET_ID] : collectAssets(call.args)
  if (assets.length === 0) {
    return {
      candidates: [],
      warningNeeded: true,
      warningCode: 'undecoded_multi_asset_call',
      warningMessage: `${name} did not include a decodable asset id; skipping balance candidate(s) instead of assuming the native asset`,
    }
  }
  const callAddress = callAddressToString(call.address)
  const evidenceArgs = name === 'Balances.upgrade_accounts'
    ? { accounts_count: accounts.length, args_omitted: true, reason: 'large account list stored in raw_calls.args_json' }
    : call.args ?? null

  const candidates: BalanceCandidate[] = []
  for (const accountId of accounts) {
    for (const assetId of assets) {
      candidates.push({
        accountId,
        assetId,
        assetKind: 'substrate',
        sourceKind: 'call',
        sourceName: name,
        sourceEventIndex: null,
        sourceCallAddress: callAddress,
        evidence: {
          call: name,
          call_address: callAddress,
          args: evidenceArgs,
        },
      })
    }
  }
  return { candidates, warningNeeded: false }
}

function parserWarning(
  blockHeight: number,
  blockTimestamp: string,
  ingestSource: string,
  sourceKind: string,
  sourceName: string,
  sourceIndex: string,
  warningCode: string,
  warning: string,
  evidence: unknown,
): RawParserWarningRow {
  return {
    block_height: blockHeight,
    block_timestamp: blockTimestamp,
    parser: 'raw_balance',
    source_kind: sourceKind,
    source_name: sourceName,
    source_index: sourceIndex,
    warning_code: warningCode,
    warning,
    evidence_json: toJsonString(evidence),
    ingest_source: ingestSource,
  }
}

async function readNativeBalance(block: StorageBlock, accountId: string): Promise<BalanceReadResult> {
  if (systemStorage.account.v205.is(block)) {
    const value = await systemStorage.account.v205.get(block, accountId) ?? systemStorage.account.v205.getDefault(block)
    return nativeV205Balance(value)
  }

  if (systemStorage.account.v100.is(block)) {
    const value = await systemStorage.account.v100.get(block, accountId) ?? systemStorage.account.v100.getDefault(block)
    return nativeV100Balance(value)
  }

  throw new Error('No supported System.Account storage type at block')
}

async function readTokenBalance(block: StorageBlock, accountId: string, assetId: string): Promise<BalanceReadResult> {
  const numericAssetId = Number.parseInt(assetId, 10)
  if (!Number.isSafeInteger(numericAssetId)) {
    throw new Error(`Asset id ${assetId} is not a safe integer for Tokens.Accounts`)
  }
  if (!tokensStorage.accounts.v108.is(block)) {
    throw new Error('No supported Tokens.Accounts storage type at block')
  }

  const value = await tokensStorage.accounts.v108.get(block, accountId, numericAssetId) ?? tokensStorage.accounts.v108.getDefault(block)
  return tokenBalance(value)
}

async function readBalance(block: StorageBlock, candidate: BalanceCandidate): Promise<BalanceReadResult> {
  if (candidate.assetId === NATIVE_ASSET_ID) {
    return readNativeBalance(block, candidate.accountId)
  }
  return readTokenBalance(block, candidate.accountId, candidate.assetId)
}

function balanceReadBatchSize(): number {
  const configured = Number.parseInt(process.env.RAW_BALANCE_READ_BATCH_SIZE ?? '250', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 1000) : 250
}

function balanceBatchReadsEnabled(): boolean {
  return process.env.RAW_BALANCE_READ_BATCH_ENABLED === 'true'
}

function balanceReadBatchConcurrency(): number {
  const configured = Number.parseInt(process.env.RAW_BALANCE_READ_BATCH_CONCURRENCY ?? '4', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 50) : 4
}

async function readNativeBalances(block: StorageBlock, candidates: IndexedBalanceCandidate[]): Promise<Map<string, BalanceReadResult>> {
  const balances = new Map<string, BalanceReadResult>()
  if (candidates.length === 0) return balances

  const idsByAccount = new Map<string, string[]>()
  for (const { id, candidate } of candidates) {
    const ids = idsByAccount.get(candidate.accountId)
    if (ids == null) {
      idsByAccount.set(candidate.accountId, [id])
    } else {
      ids.push(id)
    }
  }

  const accounts = [...idsByAccount.keys()]
  const pageSize = balanceReadBatchSize()

  if (systemStorage.account.v205.is(block)) {
    const fallback = systemStorage.account.v205.getDefault(block)
    await forEachConcurrent(chunk(accounts, pageSize), balanceReadBatchConcurrency(), async (page) => {
      const values = await systemStorage.account.v205.getMany(block, page)
      for (let index = 0; index < page.length; index++) {
        const balance = nativeV205Balance(values[index] ?? fallback)
        for (const id of idsByAccount.get(page[index]) ?? []) balances.set(id, balance)
      }
    })
    return balances
  }

  if (systemStorage.account.v100.is(block)) {
    const fallback = systemStorage.account.v100.getDefault(block)
    await forEachConcurrent(chunk(accounts, pageSize), balanceReadBatchConcurrency(), async (page) => {
      const values = await systemStorage.account.v100.getMany(block, page)
      for (let index = 0; index < page.length; index++) {
        const balance = nativeV100Balance(values[index] ?? fallback)
        for (const id of idsByAccount.get(page[index]) ?? []) balances.set(id, balance)
      }
    })
    return balances
  }

  throw new Error('No supported System.Account storage type at block')
}

async function readTokenBalances(block: StorageBlock, candidates: IndexedBalanceCandidate[]): Promise<Map<string, BalanceReadResult>> {
  const balances = new Map<string, BalanceReadResult>()
  if (candidates.length === 0) return balances

  if (!tokensStorage.accounts.v108.is(block)) {
    throw new Error('No supported Tokens.Accounts storage type at block')
  }

  const idsByKey = new Map<string, { accountId: string; assetId: number; ids: string[] }>()
  for (const { id, candidate } of candidates) {
    const numericAssetId = Number.parseInt(candidate.assetId, 10)
    if (!Number.isSafeInteger(numericAssetId)) {
      throw new Error(`Asset id ${candidate.assetId} is not a safe integer for Tokens.Accounts`)
    }

    const key = `${candidate.accountId}:${numericAssetId}`
    const entry = idsByKey.get(key)
    if (entry == null) {
      idsByKey.set(key, { accountId: candidate.accountId, assetId: numericAssetId, ids: [id] })
    } else {
      entry.ids.push(id)
    }
  }

  const keys = [...idsByKey.values()]
  const fallback = tokensStorage.accounts.v108.getDefault(block)
  const pageSize = balanceReadBatchSize()
  await forEachConcurrent(chunk(keys, pageSize), balanceReadBatchConcurrency(), async (page) => {
    const values = await tokensStorage.accounts.v108.getMany(
      block,
      page.map(({ accountId, assetId }) => [accountId, assetId]),
    )
    for (let index = 0; index < page.length; index++) {
      const balance = tokenBalance(values[index] ?? fallback)
      for (const id of page[index].ids) balances.set(id, balance)
    }
  })

  return balances
}

async function readBalancesBatched(block: StorageBlock, candidates: IndexedBalanceCandidate[]): Promise<Map<string, BalanceReadResult>> {
  const nativeCandidates = candidates.filter(({ candidate }) => candidate.assetId === NATIVE_ASSET_ID)
  const tokenCandidates = candidates.filter(({ candidate }) => candidate.assetId !== NATIVE_ASSET_ID)

  const [nativeBalances, tokenBalances] = await Promise.all([
    readNativeBalances(block, nativeCandidates),
    readTokenBalances(block, tokenCandidates),
  ])

  return new Map([...nativeBalances, ...tokenBalances])
}

function balanceReadConcurrency(): number {
  const configured = Number.parseInt(process.env.RAW_BALANCE_READ_CONCURRENCY ?? '20', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 100) : 20
}

function observationId(candidate: BalanceCandidate): string {
  const source = candidate.sourceEventIndex == null
    ? candidate.sourceCallAddress ?? 'none'
    : candidate.sourceEventIndex.toString()
  return [
    candidate.sourceKind,
    candidate.sourceName,
    source,
    candidate.accountId,
    candidate.assetKind,
    candidate.assetId,
  ].join(':')
}

function observationRow(
  block: StorageBlock,
  blockTimestamp: string,
  ingestSource: string,
  id: string,
  candidate: BalanceCandidate,
  balance: BalanceReadResult,
): RawBalanceObservationRow {
  return {
    block_height: block.height,
    block_timestamp: blockTimestamp,
    observation_id: id,
    account_id: candidate.accountId,
    asset_kind: candidate.assetKind,
    asset_id: candidate.assetId,
    free: balance.free,
    reserved: balance.reserved,
    frozen: balance.frozen,
    total: balance.total,
    nonce: balance.nonce,
    flags: balance.flags,
    source_kind: candidate.sourceKind,
    source_name: candidate.sourceName,
    source_event_index: candidate.sourceEventIndex,
    source_call_address: candidate.sourceCallAddress,
    evidence_json: toJsonString(candidate.evidence),
    ingest_source: ingestSource,
  }
}

async function buildRowsFromCandidates(
  block: StorageBlock,
  blockTimestamp: string,
  ingestSource: string,
  candidates: BalanceCandidate[],
): Promise<BalanceExtractionResult> {
  const observations: RawBalanceObservationRow[] = []
  const warnings: RawParserWarningRow[] = []
  const seen = new Set<string>()
  const uniqueCandidates: Array<{ id: string; candidate: BalanceCandidate }> = []

  for (const candidate of candidates) {
    const id = observationId(candidate)
    if (seen.has(id)) continue
    seen.add(id)
    uniqueCandidates.push({ id, candidate })
  }

  if (balanceBatchReadsEnabled()) {
    try {
      const balances = await readBalancesBatched(block, uniqueCandidates)
      for (const { id, candidate } of uniqueCandidates) {
        const balance = balances.get(id)
        if (balance == null) {
          warnings.push(parserWarning(
            block.height,
            blockTimestamp,
            ingestSource,
            candidate.sourceKind,
            candidate.sourceName,
            candidate.sourceEventIndex == null ? candidate.sourceCallAddress ?? 'none' : candidate.sourceEventIndex.toString(),
            'post_state_read_failed',
            'Batched post-state balance read did not return a result',
            candidate.evidence,
          ))
          continue
        }

        observations.push(observationRow(block, blockTimestamp, ingestSource, id, candidate, balance))
      }

      return { observations, warnings }
    } catch {
      observations.length = 0
      warnings.length = 0
    }
  }

  const results: Array<{
    observation?: RawBalanceObservationRow
    warning?: RawParserWarningRow
  }> = new Array(uniqueCandidates.length)
  const readGroups = new Map<string, {
    candidate: BalanceCandidate
    entries: Array<{ index: number; id: string; candidate: BalanceCandidate }>
  }>()

  for (let index = 0; index < uniqueCandidates.length; index++) {
    const { id, candidate } = uniqueCandidates[index]
    const readKey = `${candidate.assetKind}:${candidate.assetId}:${candidate.accountId}`
    const group = readGroups.get(readKey)
    if (group == null) {
      readGroups.set(readKey, { candidate, entries: [{ index, id, candidate }] })
    } else {
      group.entries.push({ index, id, candidate })
    }
  }

  const groupedReads = [...readGroups.values()]
  let nextIndex = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++
      if (index >= groupedReads.length) return

      const group = groupedReads[index]

      try {
        const balance = await readBalance(block, group.candidate)
        for (const { index: resultIndex, id, candidate } of group.entries) {
          results[resultIndex] = {
            observation: observationRow(block, blockTimestamp, ingestSource, id, candidate, balance),
          }
        }
      } catch (error) {
        for (const { index: resultIndex, candidate } of group.entries) {
          results[resultIndex] = {
            warning: parserWarning(
              block.height,
              blockTimestamp,
              ingestSource,
              candidate.sourceKind,
              candidate.sourceName,
              candidate.sourceEventIndex == null ? candidate.sourceCallAddress ?? 'none' : candidate.sourceEventIndex.toString(),
              'post_state_read_failed',
              error instanceof Error ? error.message : 'Failed to read post-state balance',
              candidate.evidence,
            ),
          }
        }
      }
    }
  }

  const workerCount = Math.min(balanceReadConcurrency(), groupedReads.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  for (const result of results) {
    if (result?.observation != null) observations.push(result.observation)
    if (result?.warning != null) warnings.push(result.warning)
  }

  return { observations, warnings }
}

async function genesisBootstrapCandidates(block: StorageBlock): Promise<BalanceCandidate[]> {
  if (block.height !== GENESIS_BOOTSTRAP_BLOCK) return []
  const pageSize = Number.parseInt(process.env.RAW_BALANCE_BOOTSTRAP_PAGE_SIZE ?? '1000', 10)
  const candidates: BalanceCandidate[] = []

  const systemAccount = systemStorage.account.v205.is(block)
    ? systemStorage.account.v205
    : systemStorage.account.v100.is(block)
      ? systemStorage.account.v100
      : null
  if (systemAccount != null) {
    for await (const page of systemAccount.getKeysPaged(pageSize, block)) {
      for (const account of page) {
        const accountId = normalizeAccountId(account)
        if (accountId != null) {
          candidates.push({
            accountId,
            assetId: NATIVE_ASSET_ID,
            assetKind: 'substrate',
            sourceKind: 'genesis_bootstrap',
            sourceName: 'System.Account',
            sourceEventIndex: null,
            sourceCallAddress: null,
            evidence: { storage_item: 'System.Account', reason: 'genesis bootstrap' },
          })
        }
      }
    }
  }

  if (tokensStorage.accounts.v108.is(block)) {
    for await (const page of tokensStorage.accounts.v108.getKeysPaged(pageSize, block)) {
      for (const [account, assetId] of page) {
        const accountId = normalizeAccountId(account)
        if (accountId != null) {
          candidates.push({
            accountId,
            assetId: assetId.toString(),
            assetKind: 'substrate',
            sourceKind: 'genesis_bootstrap',
            sourceName: 'Tokens.Accounts',
            sourceEventIndex: null,
            sourceCallAddress: null,
            evidence: { storage_item: 'Tokens.Accounts', reason: 'genesis bootstrap' },
          })
        }
      }
    }
  }

  return candidates
}

export interface BalanceSnapshotCounts {
  nativeAccounts: number
  tokenEntries: number
}

export interface BalanceSnapshotOptions {
  pageSize?: number
  includeNative?: boolean
  includeTokens?: boolean
  ingestSource?: string
  // Count keys only via getKeysPaged — no value reads, no decode, no row
  // emission. Use it to cheaply measure account volume before a full snapshot.
  countOnly?: boolean
  // Called for each page of observation rows. Ignored when countOnly is set.
  onObservations?: (rows: RawBalanceObservationRow[]) => Promise<void>
  onProgress?: (counts: BalanceSnapshotCounts) => void
}

interface NativeStorageAccessor {
  decode: (value: any) => BalanceReadResult
  keysPaged: (pageSize: number, block: StorageBlock) => AsyncIterable<unknown[]>
  pairsPaged: (pageSize: number, block: StorageBlock) => AsyncIterable<[unknown, unknown][]>
  fallback: unknown
}

function snapshotRow(
  block: StorageBlock,
  blockTimestamp: string,
  ingestSource: string,
  accountId: string,
  assetId: string,
  sourceName: 'System.Account' | 'Tokens.Accounts',
  balance: BalanceReadResult,
): RawBalanceObservationRow {
  const candidate: BalanceCandidate = {
    accountId,
    assetId,
    assetKind: 'substrate',
    sourceKind: 'snapshot_bootstrap',
    sourceName,
    sourceEventIndex: null,
    sourceCallAddress: null,
    evidence: { storage_item: sourceName, reason: 'full-state snapshot', anchor_block: block.height },
  }
  return observationRow(block, blockTimestamp, ingestSource, observationId(candidate), candidate, balance)
}

// Full-state balance snapshot at an arbitrary anchor block. This is
// genesisBootstrapCandidates generalized to any block: it pages over every
// System.Account and Tokens.Accounts entry with getPairsPaged (reading keys and
// values in one pass instead of re-reading) and emits one observation per
// account/asset. Run it once against the chain head to seed the dormant
// accounts the event-driven indexer never touched — accounts that transact
// afterwards simply get fresher, higher-block observations that supersede the
// snapshot via the argMax(total, block_height) the read path already uses.
export async function streamBalanceSnapshot(
  block: StorageBlock,
  blockTimestamp: string,
  options: BalanceSnapshotOptions = {},
): Promise<BalanceSnapshotCounts> {
  const configuredPageSize = options.pageSize
    ?? Number.parseInt(process.env.RAW_BALANCE_SNAPSHOT_PAGE_SIZE ?? '1000', 10)
  const pageSize = Number.isSafeInteger(configuredPageSize) && configuredPageSize > 0 ? configuredPageSize : 1000
  const ingestSource = options.ingestSource ?? 'rpc'
  const includeNative = options.includeNative ?? true
  const includeTokens = options.includeTokens ?? true
  const countOnly = options.countOnly ?? false
  const counts: BalanceSnapshotCounts = { nativeAccounts: 0, tokenEntries: 0 }

  const emit = async (rows: RawBalanceObservationRow[]): Promise<void> => {
    if (options.onObservations != null && rows.length > 0) await options.onObservations(rows)
  }

  if (includeNative) {
    const native: NativeStorageAccessor | null = systemStorage.account.v205.is(block)
      ? {
          decode: nativeV205Balance,
          keysPaged: (size, b) => systemStorage.account.v205.getKeysPaged(size, b),
          pairsPaged: (size, b) => systemStorage.account.v205.getPairsPaged(size, b),
          fallback: systemStorage.account.v205.getDefault(block),
        }
      : systemStorage.account.v100.is(block)
        ? {
            decode: nativeV100Balance,
            keysPaged: (size, b) => systemStorage.account.v100.getKeysPaged(size, b),
            pairsPaged: (size, b) => systemStorage.account.v100.getPairsPaged(size, b),
            fallback: systemStorage.account.v100.getDefault(block),
          }
        : null
    if (native == null) throw new Error('No supported System.Account storage type at snapshot block')

    if (countOnly) {
      for await (const page of native.keysPaged(pageSize, block)) {
        for (const account of page) if (normalizeAccountId(account) != null) counts.nativeAccounts++
        options.onProgress?.(counts)
      }
    } else {
      for await (const page of native.pairsPaged(pageSize, block)) {
        const rows: RawBalanceObservationRow[] = []
        for (const [account, info] of page) {
          const accountId = normalizeAccountId(account)
          if (accountId == null) continue
          rows.push(snapshotRow(block, blockTimestamp, ingestSource, accountId, NATIVE_ASSET_ID, 'System.Account', native.decode(info ?? native.fallback)))
        }
        counts.nativeAccounts += rows.length
        await emit(rows)
        options.onProgress?.(counts)
      }
    }
  }

  if (includeTokens) {
    if (!tokensStorage.accounts.v108.is(block)) {
      throw new Error('No supported Tokens.Accounts storage type at snapshot block')
    }
    if (countOnly) {
      for await (const page of tokensStorage.accounts.v108.getKeysPaged(pageSize, block)) {
        for (const [account] of page) if (normalizeAccountId(account) != null) counts.tokenEntries++
        options.onProgress?.(counts)
      }
    } else {
      const fallback = tokensStorage.accounts.v108.getDefault(block)
      for await (const page of tokensStorage.accounts.v108.getPairsPaged(pageSize, block)) {
        const rows: RawBalanceObservationRow[] = []
        for (const [[account, assetId], value] of page) {
          const accountId = normalizeAccountId(account)
          if (accountId == null) continue
          rows.push(snapshotRow(block, blockTimestamp, ingestSource, accountId, assetId.toString(), 'Tokens.Accounts', tokenBalance(value ?? fallback)))
        }
        counts.tokenEntries += rows.length
        await emit(rows)
        options.onProgress?.(counts)
      }
    }
  }

  return counts
}

export async function extractBalanceObservations(
  block: StorageBlock,
  blockTimestamp: string,
  events: RawEvent[],
  calls: RawCall[],
  ingestSource: string,
): Promise<BalanceExtractionResult> {
  const candidates: BalanceCandidate[] = []
  const warnings: RawParserWarningRow[] = []

  candidates.push(...await genesisBootstrapCandidates(block))

  for (const event of events) {
    candidates.push(...candidatesFromEvent(event))
  }

  for (const call of calls) {
    const name = call.name ?? ''
    const callAddress = callAddressToString(call.address) ?? call.id

    if (name === 'System.set_storage') {
      let matched = false
      for (const key of storageKeyCandidates(call.args)) {
        const { candidate, warning } = extractStorageBalanceCandidate(key, call, blockTimestamp, ingestSource)
        if (candidate != null) {
          candidates.push(candidate)
          matched = true
        }
        if (warning != null) warnings.push(warning)
      }
      if (!matched) {
        warnings.push(parserWarning(
          call.block.height,
          blockTimestamp,
          ingestSource,
          'call',
          name,
          callAddress,
          'unmatched_set_storage',
          'System.set_storage did not include a decodable System.Account or Tokens.Accounts key',
          { call: name, call_address: callAddress, args: call.args ?? null },
        ))
      }
      continue
    }

    const { candidates: callCandidates, warningNeeded, warningCode, warningMessage } = candidatesFromCall(call)
    candidates.push(...callCandidates)
    if (warningCode != null) {
      warnings.push(parserWarning(
        call.block.height,
        blockTimestamp,
        ingestSource,
        'call',
        name,
        callAddress,
        warningCode,
        warningMessage ?? 'Balance call could not be fully parsed',
        { call: name, call_address: callAddress, args: call.args ?? null },
      ))
    } else if (warningNeeded && isAdministrativeCall(name)) {
      warnings.push(parserWarning(
        call.block.height,
        blockTimestamp,
        ingestSource,
        'call',
        name,
        callAddress,
        'administrative_balance_surface',
        'Administrative call may affect balances through nested dispatch or governance execution; raw call arguments are preserved for targeted validation',
        { call: name, call_address: callAddress, args: call.args ?? null },
      ))
    }
  }

  const rows = await buildRowsFromCandidates(block, blockTimestamp, ingestSource, candidates)
  return {
    observations: rows.observations,
    warnings: [...warnings, ...rows.warnings],
  }
}
