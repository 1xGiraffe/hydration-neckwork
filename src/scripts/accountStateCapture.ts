// The repair side of the raw indexer's account-state hook
// (src/raw/accountState.ts → price_data.raw_account_state_observations), kept free
// of any connection so it can be exercised with fakes; the ports are in
// accountStatePorts.ts. The anchors loop (snapshot-atoken-anchors.ts --loop, the
// `atoken-anchor` service) runs reconcileAccountState every cycle, as it runs the
// LM entry reconcile.
//
// A warning is OPEN while its (block, kind, account) has no observation row — that
// anti-join (OPEN_ACCOUNT_STATE_WARNINGS_SQL) is the whole open/repaired
// distinction. The warning row is never rewritten; the repair's row landing closes
// it. A block that still cannot be read (pruned state, a layout the decoder
// refuses) stays open and is retried next cycle.

import {
  ACCOUNT_STATE_STORAGE,
  canonicalJson,
  captureAccountState,
  storedKinds,
  UNDELEGATED_EVENT,
  votingByClass,
  type AccountStateKind,
  type AccountStateRow,
  type AccountStateRuntime,
  type AccountStateTarget,
} from '../raw/accountState.js'

/** One open capture warning. */
export interface OpenAccountStateWarning {
  blockHeight: number
  blockTimestamp: string
  kind: AccountStateKind
  account: string
  triggers: string[]
}

export interface AccountStateReconcileSource {
  /** The OPEN warnings (at most `limit`), block order. */
  openWarnings(limit: number): Promise<OpenAccountStateWarning[]>
}

export interface AccountStateChain {
  blockHash(height: number): Promise<string>
  /** The runtime that EXECUTED `height` (the code in its parent's state), with storage access. */
  executingRuntime(height: number): Promise<AccountStateRuntime>
}

export interface AccountStateSink {
  insert(rows: AccountStateRow[]): Promise<void>
}

export interface AccountStateReconcileResult {
  openBefore: number
  /** The open set reached `limit`: more remains for the next pass. */
  truncated: boolean
  blocks: number
  rows: number
  /** Blocks whose re-read threw or still failed a read: still open, retried next pass. */
  failed: Array<{ block: number; reason: string }>
  /** Open warnings after the repair; null in a dry run. */
  openAfter: number | null
}

/** Group open warnings into one capture per block: each account with the kinds that failed for it. */
export function repairTargets(warnings: readonly OpenAccountStateWarning[]): Map<number, { timestamp: string; targets: AccountStateTarget[] }> {
  const byBlock = new Map<number, { timestamp: string; accounts: Map<string, { kinds: Set<AccountStateKind>; triggers: Set<string> }> }>()
  for (const w of warnings) {
    let block = byBlock.get(w.blockHeight)
    if (block == null) {
      block = { timestamp: w.blockTimestamp, accounts: new Map() }
      byBlock.set(w.blockHeight, block)
    }
    let account = block.accounts.get(w.account)
    if (account == null) {
      account = { kinds: new Set(), triggers: new Set() }
      block.accounts.set(w.account, account)
    }
    account.kinds.add(w.kind)
    for (const t of w.triggers) account.triggers.add(t)
  }
  const out = new Map<number, { timestamp: string; targets: AccountStateTarget[] }>()
  for (const height of [...byBlock.keys()].sort((a, b) => a - b)) {
    const block = byBlock.get(height)!
    out.set(height, {
      timestamp: block.timestamp,
      targets: [...block.accounts].sort(([a], [b]) => a.localeCompare(b)).map(([account, v]): AccountStateTarget => ({
        account,
        triggers: [...v.triggers].sort(),
        kinds: [...v.kinds].sort(),
        // A failed undelegation is repaired whole: its targets are found again.
        ...(v.kinds.has('conviction_voting') && v.triggers.has(UNDELEGATED_EVENT) ? { expandDelegations: true } : {}),
      })),
    })
  }
  return out
}

/**
 * One reconcile pass: every block with an open warning is re-read — only the
 * (kind, account) pairs that failed there — with the runtime that executed it,
 * one block at a time, so a block that cannot be read never holds back the
 * others. Rows are chain state at a fixed block under a ReplacingMergeTree key: a
 * repeat writes identical rows.
 */
export async function reconcileAccountState(
  source: AccountStateReconcileSource,
  deps: { chain: AccountStateChain; sink: AccountStateSink },
  opts: { dryRun: boolean; limit: number },
): Promise<AccountStateReconcileResult> {
  const warnings = await source.openWarnings(opts.limit)
  const blocks = repairTargets(warnings)
  const result: AccountStateReconcileResult = {
    openBefore: warnings.length,
    truncated: warnings.length >= opts.limit,
    blocks: blocks.size,
    rows: 0,
    failed: [],
    openAfter: null,
  }
  for (const [height, block] of blocks) {
    try {
      const [hash, parentHash, runtime] = await Promise.all([deps.chain.blockHash(height), deps.chain.blockHash(height - 1), deps.chain.executingRuntime(height)])
      const captured = await captureAccountState({ height, hash, parentHash, timestamp: block.timestamp }, block.targets, runtime, 'repair')
      if (captured.warnings.length > 0) result.failed.push({ block: height, reason: captured.warnings[0].warning })
      if (!opts.dryRun && captured.rows.length > 0) await deps.sink.insert(captured.rows)
      result.rows += captured.rows.length
    } catch (error) {
      result.failed.push({ block: height, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  if (!opts.dryRun) result.openAfter = blocks.size ? (await source.openWarnings(opts.limit)).length : warnings.length
  return result
}

// ───────────────────────── seed and verify (snapshot-account-state.ts) ─────────────────────────

/** A runtime that can page through a whole storage item (the seed's full read). */
export interface AccountStateEnumerationRuntime extends AccountStateRuntime {
  getStorage(blockHash: string, name: string, ...key: unknown[]): Promise<unknown>
  getStoragePairsPaged(pageSize: number, blockHash: string, name: string, ...args: unknown[]): AsyncIterable<Array<[unknown, unknown]>>
}

/** kind → account → canonical value_json, for every account the item stores anything for. */
export type AccountStateEnumeration = Map<AccountStateKind, Map<string, string>>

/**
 * Every account's state of every stored kind at the end of the block `hash`, read
 * whole (the seed at the hook's start block S, and the verifier's reference). The
 * double map is grouped by account exactly as the hook groups it.
 */
export async function enumerateAccountState(runtime: AccountStateEnumerationRuntime, hash: string, pageSize = 1_000): Promise<AccountStateEnumeration> {
  const out: AccountStateEnumeration = new Map()
  for (const kind of storedKinds(runtime)) {
    const name = ACCOUNT_STATE_STORAGE[kind]
    const accounts = new Map<string, string>()
    if (kind === 'conviction_voting') {
      const pairsByAccount = new Map<string, Array<[unknown, unknown]>>()
      for await (const page of runtime.getStoragePairsPaged(pageSize, hash, name)) {
        for (const [key, value] of page) {
          const account = String((key as unknown[])[0]).toLowerCase()
          let list = pairsByAccount.get(account)
          if (list == null) {
            list = []
            pairsByAccount.set(account, list)
          }
          list.push([key, value])
        }
      }
      for (const [account, pairs] of pairsByAccount) accounts.set(account, canonicalJson(votingByClass(pairs)))
    } else {
      for await (const page of runtime.getStoragePairsPaged(pageSize, hash, name)) {
        for (const [key, value] of page) accounts.set(String(Array.isArray(key) ? key[0] : key).toLowerCase(), canonicalJson(value))
      }
    }
    out.set(kind, accounts)
  }
  return out
}

/** The seed rows of an enumeration: one per (kind, account) with state, trigger 'seed'. */
export function seedRows(enumeration: AccountStateEnumeration, block: { height: number; hash: string; timestamp: string; specVersion: number }): AccountStateRow[] {
  const rows: AccountStateRow[] = []
  for (const [kind, accounts] of enumeration) {
    for (const [account, value] of [...accounts].sort(([a], [b]) => a.localeCompare(b))) {
      rows.push({
        block_height: block.height, block_timestamp: block.timestamp, kind, account_id: account, sub_key: '',
        value_json: value, triggers: ['seed'], block_hash: block.hash, spec_version: block.specVersion, ingest_source: 'seed',
      })
    }
  }
  return rows
}

/** Each kind's empty value as the hook writes it (the storage default; VotingFor: no class). */
export function accountStateDefaults(runtime: Pick<AccountStateRuntime, 'getStorageFallback' | 'hasStorageItem'>): Map<AccountStateKind, string> {
  const out = new Map<AccountStateKind, string>()
  for (const kind of storedKinds(runtime)) {
    out.set(kind, kind === 'conviction_voting' ? '{}' : canonicalJson(runtime.getStorageFallback(ACCOUNT_STATE_STORAGE[kind])))
  }
  return out
}

/**
 * The hook's latest value ≤ B per (kind, account) against a full enumeration at B,
 * for every account the hook observed: `matched` / `mismatched` (with the first
 * few), and `unobserved` — accounts the enumeration holds state for that the hook
 * never named (zero after a seed at or below B).
 */
export function compareAccountState(
  enumeration: AccountStateEnumeration,
  observed: ReadonlyMap<AccountStateKind, ReadonlyMap<string, string>>,
  defaults: ReadonlyMap<AccountStateKind, string>,
): Record<string, { observed: number; matched: number; mismatched: number; unobserved: number; firstMismatches: Array<{ account: string; observed: string; chain: string }> }> {
  const out: ReturnType<typeof compareAccountState> = {}
  for (const [kind, chain] of enumeration) {
    const seen = observed.get(kind) ?? new Map<string, string>()
    const stats = { observed: seen.size, matched: 0, mismatched: 0, unobserved: 0, firstMismatches: [] as Array<{ account: string; observed: string; chain: string }> }
    for (const [account, value] of seen) {
      const expected = chain.get(account) ?? defaults.get(kind) ?? ''
      if (value === expected) stats.matched++
      else {
        stats.mismatched++
        if (stats.firstMismatches.length < 5) stats.firstMismatches.push({ account, observed: value.slice(0, 300), chain: expected.slice(0, 300) })
      }
    }
    for (const account of chain.keys()) if (!seen.has(account)) stats.unobserved++
    out[kind] = stats
  }
  return out
}
