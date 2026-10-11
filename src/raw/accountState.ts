// Account state captured raw from chain storage by the raw indexer into
// price_data.raw_account_state_observations: the locks, vesting schedules,
// conviction votes and proxies of every account a block's governance, vesting,
// staking, lock and proxy events (and the proxy/vote calls that emit no event)
// name, read at the end of that block. Same template as raw_lm_farm_entries
// (lmFarmEntries.ts): pure apart from the runtime it is handed, decoded with the
// runtime that EXECUTED the block (subsquid's `block.header._runtime`, the parent
// state's code), a failed read is a raw_parser_warnings row (parser
// raw_account_state) and never aborts the block, and the anchors loop re-reads
// every open one (accountStateCapture.ts).
//
// Why: none of these four storage items is restated by an event. A
// ConvictionVoting.Voted moves the account's lock (and so its `frozen` balance)
// without any Balances event — measured, 19 of 120 Voted events in 30 days left
// the indexed `frozen` stale — and Proxy.remove_proxies drops every delegate with
// no per-delegate event at all. So the hook also emits a System.Account balance
// observation for each account it names (balanceCandidates).
//
// One row per (block, kind, account): the item's whole value for that account at
// the block's end, the storage default when it holds nothing (an emptied lock list
// is a row, so argMax(≤ B) per (kind, account) is that account's state at B).
// ConvictionVoting.VotingFor is a double map (account, class): its row is every
// class of the account, {class: voting}, so a class that disappears disappears
// from the next row. `sub_key` is reserved for an item keyed below the account
// that is stored per sub-key; every kind here uses ''.

import type { BalanceCandidate } from './balance.js'
import { normalizeAccountId } from './accountIdentity.js'
import type { RawCallRow, RawEventRow, RawParserWarningRow } from './types.js'

export type AccountStateKind = 'balances_locks' | 'vesting_schedules' | 'conviction_voting' | 'proxies'

export const ACCOUNT_STATE_STORAGE: Record<AccountStateKind, string> = {
  balances_locks: 'Balances.Locks',
  vesting_schedules: 'Vesting.VestingSchedules',
  conviction_voting: 'ConvictionVoting.VotingFor',
  proxies: 'Proxy.Proxies',
}

export const ACCOUNT_STATE_KINDS = Object.keys(ACCOUNT_STATE_STORAGE) as AccountStateKind[]

export const ACCOUNT_STATE_WARNING_PARSER = 'raw_account_state'
export const ACCOUNT_STATE_WARNING_CODE = 'account_state_read_failed'

// Event → the arg fields naming the accounts whose state it moved. A tuple-shaped
// event (args a JSON array, e.g. ConvictionVoting.Delegated(who, target)) or a
// single unnamed field (ConvictionVoting.Undelegated(who)) names every account in
// it; ACCOUNT_ARGS_ALL marks those.
const ACCOUNT_ARGS_ALL = ['*']
const EVENT_ACCOUNT_ARGS: Record<string, string[]> = {
  'ConvictionVoting.Voted': ['who'],
  'ConvictionVoting.VoteRemoved': ['who'],
  'ConvictionVoting.VoteUnlocked': ['who'],
  'ConvictionVoting.Delegated': ACCOUNT_ARGS_ALL,
  'ConvictionVoting.Undelegated': ACCOUNT_ARGS_ALL,
  'Democracy.Voted': ['voter'],
  'Democracy.Delegated': ['who', 'target'],
  'Democracy.Undelegated': ['account'],
  'Vesting.VestingScheduleAdded': ['from', 'to'],
  'Vesting.Claimed': ['who'],
  'Vesting.VestingSchedulesUpdated': ['who'],
  'Staking.PositionCreated': ['who'],
  'Staking.StakeAdded': ['who'],
  'Staking.RewardsClaimed': ['who'],
  'Staking.Unstaked': ['who'],
  'Staking.ForceUnstaked': ['who'],
  'GigaHdx.Staked': ['who'],
  'GigaHdx.Unstaked': ['who'],
  'GigaHdx.Unlocked': ['who'],
  'GigaHdx.UnstakeCancelled': ['who'],
  'GigaHdx.MigratedFromLegacy': ['who'],
  'GigaHdx.YieldRealized': ['who'],
  'Balances.Locked': ['who'],
  'Balances.Unlocked': ['who'],
  'Balances.Frozen': ['who'],
  'Balances.Thawed': ['who'],
  'Proxy.ProxyAdded': ['delegator', 'delegatee'],
  'Proxy.ProxyRemoved': ['delegator', 'delegatee'],
  'Proxy.PureCreated': ['pure', 'who'],
  'Proxy.PureKilled': ['pure', 'spawner'],
  'Proxy.DepositPoked': ['who'],
}

// Calls that change one of the items with no event naming the account: the
// origin's state (`origin`) and/or an account argument. remove_proxies is the case
// that motivated it (no per-delegate event); the vote removals and unlocks emit no
// event on older runtimes.
const CALL_ACCOUNT_ARGS: Record<string, { origin: boolean; args: string[] }> = {
  'Proxy.remove_proxies': { origin: true, args: [] },
  'ConvictionVoting.remove_vote': { origin: true, args: [] },
  'ConvictionVoting.remove_other_vote': { origin: false, args: ['target'] },
  'ConvictionVoting.unlock': { origin: false, args: ['target'] },
  'Democracy.remove_vote': { origin: true, args: [] },
  'Democracy.remove_other_vote': { origin: false, args: ['target'] },
  'Democracy.unlock': { origin: false, args: ['target'] },
}

/** One account the block names, the triggers that named it, and the kinds to read. */
export interface AccountStateTarget {
  account: string
  /** Sorted, unique event/call names. */
  triggers: string[]
  kinds?: AccountStateKind[]
  /**
   * The account undelegated (ConvictionVoting.Undelegated names only the
   * delegator): its delegation targets' VotingFor lost the delegated capital with
   * no event naming them, so they are found in the delegator's VotingFor at the
   * PARENT block (Delegating{target}) and read too.
   */
  expandDelegations?: boolean
}

/** The event whose delegation targets are read from the parent state. */
export const UNDELEGATED_EVENT = 'ConvictionVoting.Undelegated'

function parseJson(text: string | null | undefined): unknown {
  if (text == null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function accountsIn(args: unknown, fields: string[]): string[] {
  const out: string[] = []
  const push = (value: unknown): void => {
    const account = normalizeAccountId(value)
    if (account != null) out.push(account)
  }
  if (fields === ACCOUNT_ARGS_ALL || Array.isArray(args) || typeof args === 'string') {
    if (Array.isArray(args)) for (const item of args) push(item)
    else if (args != null && typeof args === 'object') for (const value of Object.values(args as Record<string, unknown>)) push(value)
    else push(args)
    return out
  }
  if (args == null || typeof args !== 'object') return out
  for (const field of fields) push((args as Record<string, unknown>)[field])
  return out
}

/** The Signed account of a serialized call origin, else null. */
export function signedOriginAccount(originJson: string | null | undefined): string | null {
  const origin = parseJson(originJson) as { __kind?: unknown; value?: { __kind?: unknown; value?: unknown } } | null
  if (origin == null || origin.__kind !== 'system' || origin.value?.__kind !== 'Signed') return null
  return normalizeAccountId(origin.value.value)
}

export interface AccountStateSources {
  targets: AccountStateTarget[]
  /** The events and calls that named each account (for the balance observations). */
  sources: Array<{ account: string; kind: 'event' | 'call'; name: string; eventIndex: number | null; callAddress: string | null }>
}

/**
 * The accounts a block's events and calls name, in account order. A failed call
 * (success 0) changed nothing and names nobody; a synthetic nested call (success
 * null) is taken as it is recorded.
 */
export function accountStateTargets(
  events: ReadonlyArray<Pick<RawEventRow, 'event_index' | 'event_name' | 'args_json' | 'call_address'>>,
  calls: ReadonlyArray<Pick<RawCallRow, 'call_name' | 'args_json' | 'origin_json' | 'success' | 'call_address'>>,
): AccountStateSources {
  const triggers = new Map<string, Set<string>>()
  const undelegated = new Set<string>()
  const sources: AccountStateSources['sources'] = []
  const name = (account: string, trigger: string): void => {
    let set = triggers.get(account)
    if (set == null) {
      set = new Set()
      triggers.set(account, set)
    }
    set.add(trigger)
  }
  for (const event of events) {
    const fields = EVENT_ACCOUNT_ARGS[event.event_name]
    if (fields == null) continue
    for (const account of new Set(accountsIn(parseJson(event.args_json), fields))) {
      name(account, event.event_name)
      if (event.event_name === UNDELEGATED_EVENT) undelegated.add(account)
      sources.push({ account, kind: 'event', name: event.event_name, eventIndex: event.event_index, callAddress: event.call_address })
    }
  }
  for (const call of calls) {
    const rule = CALL_ACCOUNT_ARGS[call.call_name]
    if (rule == null || call.success === 0) continue
    const accounts = new Set(accountsIn(parseJson(call.args_json), rule.args))
    if (rule.origin) {
      const origin = signedOriginAccount(call.origin_json)
      if (origin != null) accounts.add(origin)
    }
    for (const account of accounts) {
      name(account, call.call_name)
      sources.push({ account, kind: 'call', name: call.call_name, eventIndex: null, callAddress: call.call_address })
    }
  }
  const targets = [...triggers].sort(([a], [b]) => a.localeCompare(b)).map(([account, set]): AccountStateTarget =>
    undelegated.has(account) ? { account, triggers: [...set].sort(), expandDelegations: true } : { account, triggers: [...set].sort() })
  return { targets, sources }
}

/**
 * System.Account observations for the named accounts (raw_balance_observations,
 * through extractBalanceObservations): one candidate per naming event/call, so a
 * lock that moved with no Balances event still restates `frozen` at its block. A
 * Balances.* event already is a balance source of its own (same observation id),
 * so it adds nothing here.
 */
export function accountStateBalanceCandidates(sources: AccountStateSources['sources']): BalanceCandidate[] {
  const out: BalanceCandidate[] = []
  for (const source of sources) {
    if (source.name.startsWith('Balances.')) continue
    out.push({
      accountId: source.account,
      assetId: '0',
      assetKind: 'substrate',
      sourceKind: source.kind,
      sourceName: source.name,
      sourceEventIndex: source.eventIndex,
      sourceCallAddress: source.callAddress,
      evidence: { reason: 'account-state trigger', [source.kind]: source.name, ...(source.eventIndex == null ? {} : { event_index: source.eventIndex }) },
    })
  }
  return out
}

// ───────────────────────── decoded storage → rows ─────────────────────────

/**
 * A decoded storage value as canonical JSON: bigints as decimal strings, bytes as
 * 0x hex, object keys sorted. Arrays stay arrays (a list of small integers is NOT
 * read as bytes — the generic toJsonString would).
 */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString()
    if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString('hex')}`
    if (Array.isArray(v)) return v.map(norm)
    if (v != null && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(v as Record<string, unknown>).sort()) out[key] = norm((v as Record<string, unknown>)[key])
      return out
    }
    return v === undefined ? null : v
  }
  return JSON.stringify(norm(value))
}

/** ConvictionVoting.VotingFor pairs of one account as {class: voting}, classes ascending. */
export function votingByClass(pairs: ReadonlyArray<[unknown, unknown]>): Record<string, unknown> {
  const entries: Array<[number, unknown]> = []
  for (const [key, value] of pairs) {
    const classId = Array.isArray(key) ? key[1] : key
    const n = typeof classId === 'number' ? classId : Number(classId)
    if (!Number.isSafeInteger(n)) throw new Error(`VotingFor key has no class: ${canonicalJson(key)}`)
    entries.push([n, value])
  }
  entries.sort((a, b) => a[0] - b[0])
  const out: Record<string, unknown> = {}
  for (const [classId, value] of entries) out[String(classId)] = value
  return out
}

/** One raw_account_state_observations row, as inserted. */
export interface AccountStateRow {
  block_height: number
  block_timestamp: string
  kind: AccountStateKind
  account_id: string
  sub_key: string
  value_json: string
  triggers: string[]
  block_hash: string
  spec_version: number
  ingest_source: string
}

/** What the capture needs of a runtime: the executing one (subsquid's `block.header._runtime`). */
export interface AccountStateRuntime {
  readonly specVersion: number
  hasStorageItem(name: string): boolean
  getStorageFallback(name: string): unknown
  queryStorage(blockHash: string, name: string, keys: unknown[]): Promise<unknown[]>
  getStoragePairs(blockHash: string, name: string, ...args: unknown[]): Promise<Array<[unknown, unknown]>>
}

/** The kinds this runtime stores (an item the runtime lacks is no state, never a warning). */
export function storedKinds(runtime: Pick<AccountStateRuntime, 'hasStorageItem'>): AccountStateKind[] {
  return ACCOUNT_STATE_KINDS.filter(kind => runtime.hasStorageItem(ACCOUNT_STATE_STORAGE[kind]))
}

function captureWarning(
  block: { height: number; timestamp: string },
  kind: AccountStateKind,
  target: AccountStateTarget,
  specVersion: number,
  ingestSource: string,
  error: unknown,
): RawParserWarningRow {
  return {
    block_height: block.height,
    block_timestamp: block.timestamp,
    parser: ACCOUNT_STATE_WARNING_PARSER,
    source_kind: 'storage',
    source_name: ACCOUNT_STATE_STORAGE[kind],
    // (kind, account) is the identity: one block can fail several.
    source_index: `${kind}:${target.account}`,
    warning_code: ACCOUNT_STATE_WARNING_CODE,
    warning: error instanceof Error ? error.message : 'account state storage read failed',
    evidence_json: JSON.stringify({ kind, account: target.account, triggers: target.triggers, spec_version: specVersion }),
    ingest_source: ingestSource,
  }
}

async function eachLimited<T>(items: readonly T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i])
    }
  }))
}

/** The delegation targets in one account's VotingFor pairs (Delegating{target}), sorted. */
export function delegationTargets(pairs: ReadonlyArray<[unknown, unknown]>): string[] {
  const out = new Set<string>()
  for (const [, value] of pairs) {
    const voting = value as { __kind?: unknown; value?: { target?: unknown } } | null
    if (voting?.__kind !== 'Delegating') continue
    const target = normalizeAccountId(voting.value?.target)
    if (target != null) out.add(target)
  }
  return [...out].sort()
}

/**
 * The targets with every undelegating account's delegation targets added (read
 * from its VotingFor at the parent block): a target already named gains the
 * trigger; a new one is read for conviction_voting only. A delegator whose lookup
 * failed is returned in `unresolved` — its own conviction_voting row is then held
 * back, so its warning stays open until a repair can name the targets.
 */
async function withDelegationTargets(
  targets: readonly AccountStateTarget[],
  parentHash: string | undefined,
  runtime: AccountStateRuntime,
): Promise<{ targets: AccountStateTarget[]; unresolved: Map<string, unknown> }> {
  const unresolved = new Map<string, unknown>()
  const delegators = targets.filter(t => t.expandDelegations)
  if (delegators.length === 0 || !runtime.hasStorageItem(ACCOUNT_STATE_STORAGE.conviction_voting)) return { targets: [...targets], unresolved }
  const byAccount = new Map(targets.map(t => [t.account, { ...t }]))
  for (const delegator of delegators) {
    try {
      if (parentHash == null) throw new Error('no parent block to read the delegation targets at')
      const pairs = await runtime.getStoragePairs(parentHash, ACCOUNT_STATE_STORAGE.conviction_voting, delegator.account)
      for (const target of delegationTargets(pairs)) {
        const existing = byAccount.get(target)
        if (existing == null) {
          byAccount.set(target, { account: target, triggers: [UNDELEGATED_EVENT], kinds: ['conviction_voting'] })
        } else {
          existing.triggers = [...new Set([...existing.triggers, UNDELEGATED_EVENT])].sort()
          if (existing.kinds != null && !existing.kinds.includes('conviction_voting')) existing.kinds = [...existing.kinds, 'conviction_voting' as const].sort()
        }
      }
    } catch (error) {
      unresolved.set(delegator.account, error)
    }
  }
  return { targets: [...byAccount.values()].sort((a, b) => a.account.localeCompare(b.account)), unresolved }
}

/**
 * Read the named accounts' state at the end of `block`, decoded by `runtime`: one
 * queryStorage per single-keyed item for every account, and the VotingFor prefix
 * of each account. A no-op (no RPC) for no targets. A failed read yields no row
 * for that (kind, account) and a raw_parser_warnings row; the others are kept.
 */
export async function captureAccountState(
  block: { height: number; hash: string; parentHash?: string; timestamp: string },
  named: readonly AccountStateTarget[],
  runtime: AccountStateRuntime,
  ingestSource: string,
): Promise<{ rows: AccountStateRow[]; warnings: RawParserWarningRow[]; reads: number }> {
  const rows: AccountStateRow[] = []
  const warnings: RawParserWarningRow[] = []
  let reads = 0
  if (named.length === 0) return { rows, warnings, reads }
  const specVersion = runtime.specVersion
  const { targets, unresolved } = await withDelegationTargets(named, block.parentHash, runtime)
  for (const [account, error] of unresolved) {
    const target = targets.find(t => t.account === account)!
    warnings.push(captureWarning(block, 'conviction_voting', target, specVersion, ingestSource,
      new Error(`delegation targets unread: ${error instanceof Error ? error.message : String(error)}`)))
  }
  const kinds = storedKinds(runtime)
  const row = (kind: AccountStateKind, target: AccountStateTarget, value: unknown): AccountStateRow => ({
    block_height: block.height,
    block_timestamp: block.timestamp,
    kind,
    account_id: target.account,
    sub_key: '',
    value_json: canonicalJson(value),
    triggers: target.triggers,
    block_hash: block.hash,
    spec_version: specVersion,
    ingest_source: ingestSource,
  })
  for (const kind of kinds) {
    const name = ACCOUNT_STATE_STORAGE[kind]
    const ts = targets.filter(t => t.kinds == null || t.kinds.includes(kind))
    if (ts.length === 0) continue
    if (kind === 'conviction_voting') {
      await eachLimited(ts.filter(t => !unresolved.has(t.account)), 8, async target => {
        try {
          reads++
          const pairs = await runtime.getStoragePairs(block.hash, name, target.account)
          rows.push(row(kind, target, votingByClass(pairs)))
        } catch (error) {
          warnings.push(captureWarning(block, kind, target, specVersion, ingestSource, error))
        }
      })
      continue
    }
    let values: unknown[]
    try {
      reads++
      values = await runtime.queryStorage(block.hash, name, ts.map(t => t.account))
      if (values.length !== ts.length) throw new Error(`${values.length} values for ${ts.length} accounts`)
    } catch (error) {
      for (const target of ts) warnings.push(captureWarning(block, kind, target, specVersion, ingestSource, error))
      continue
    }
    const fallback = runtime.getStorageFallback(name)
    ts.forEach((target, i) => rows.push(row(kind, target, values[i] ?? fallback)))
  }
  rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.account_id.localeCompare(b.account_id))
  return { rows, warnings, reads }
}
