// Liquidity-mining farm entries, captured raw from chain storage by the raw
// indexer into price_data.raw_lm_farm_entries: which deposits a block's entry
// events name, how a decoded `<Instance>WarehouseLM.Deposit` becomes rows, and the
// in-block capture itself (captureLmFarmEntries). Pure apart from the runtime it
// is handed, so it is exercised with fakes; src/scripts/snapshot-lm-entries.ts
// reuses the same row builders to verify and repair ranges from an archive node.
//
// Why a capture at all: an entry's stake (`valued_shares`, the deposit's shares
// priced by the EMA oracle at entry) is storage-only — no event carries it — so
// its unclaimed reward cannot be restated from events. The deposit's storage is
// read once at the end of every block that created one of its entries
// (SharesDeposited / SharesRedeposited), which is all the history needs: an
// entry's constants never change during its life, and each capture also dates
// every older entry's `accumulated_claimed_rewards` of the same deposit.
//
// Which runtime decodes it: the one that EXECUTED the block, i.e. the code in its
// parent's state — subsquid's `block.header._runtime`, the runtime it also decodes
// the block's events with (fetched at the parent hash). `header.specVersion`, and
// so `blocks.spec_version`, is the POST-state version instead, which differs
// exactly at an upgrade block — the one whose set_validation_data applied new code
// (System.CodeUpdated): its state still has the old layout, and the new runtime's
// migrations run at the start of the NEXT block. (`_runtimeOfPrevBlock` is one
// block further back — the grandparent's code — and is wrong on the block after
// an upgrade: at 14,362,831 it is spec 440 while the state is already 443's.)

import type { RawParserWarningRow } from './types.js'

export type LmPallet = 'omnipool' | 'xyk'

export const LM_STORAGE: Record<LmPallet, string> = {
  omnipool: 'OmnipoolWarehouseLM.Deposit',
  xyk: 'XYKWarehouseLM.Deposit',
}

/** The events that create a farm entry. */
export const ENTRY_EVENTS: Record<string, LmPallet> = {
  'OmnipoolLiquidityMining.SharesDeposited': 'omnipool',
  'OmnipoolLiquidityMining.SharesRedeposited': 'omnipool',
  'XYKLiquidityMining.SharesDeposited': 'xyk',
  'XYKLiquidityMining.SharesRedeposited': 'xyk',
}
export const ENTRY_EVENT_NAMES = Object.keys(ENTRY_EVENTS)

/** One SharesDeposited/SharesRedeposited, with the farm it entered. */
export interface DepositEvent {
  blockHeight: number
  eventIndex: number
  eventName: string
  depositId: string
  globalFarmId: number
  yieldFarmId: number
}

/** A raw_events row as serialized by the raw indexer (only the fields read here). */
export interface EntryEventSource {
  block_height: number
  event_index: number
  event_name: string
  args_json: string
}

// The lm_deposit_farm_events MV's extraction, restated over the serialized row:
// `trim(BOTH '"' FROM JSONExtractRaw(args_json, 'depositId'))` (a u128 serializes
// as a JSON string, an older number stays a number) and
// `toUInt32(JSONExtractUInt(args_json, '<farm>'))` (0 when absent). The repair tool
// reads the MV's rows, the indexer the events themselves: one definition of which
// deposit and farm an event names keeps the two captures identical.
const rawIdOf = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : '')
const farmIdOf = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff ? v : 0)

/** The entry events among a block's serialized events. */
export function entryEventsFromRawEvents(rows: EntryEventSource[]): DepositEvent[] {
  const out: DepositEvent[] = []
  for (const r of rows) {
    if (ENTRY_EVENTS[r.event_name] == null) continue
    const args = JSON.parse(r.args_json) as Record<string, unknown> | null
    out.push({
      blockHeight: r.block_height, eventIndex: r.event_index, eventName: r.event_name,
      depositId: rawIdOf(args?.depositId), globalFarmId: farmIdOf(args?.globalFarmId), yieldFarmId: farmIdOf(args?.yieldFarmId),
    })
  }
  return out
}

/** One storage read: a deposit at the end of a block, and the entries that block created. */
export interface CaptureTarget {
  blockHeight: number
  pallet: LmPallet
  depositId: string
  /** The block's first entry event for the deposit — the row identity. */
  eventIndex: number
  eventName: string
  eventFarms: Array<{ globalFarmId: number; yieldFarmId: number }>
}

export const targetKey = (pallet: LmPallet, depositId: string, blockHeight: number): string => `${pallet}:${depositId}:${blockHeight}`

/** A deposit id storage can be keyed by: the decimal u128 the pallet emits. */
export const isNumericDepositId = (id: string): boolean => /^\d+$/.test(id)

/**
 * Entry events whose deposit id is not a decimal integer (absent, or a shape the
 * extraction does not know). They name no storage key, so they cannot become a
 * target — each one is surfaced instead (a raw_parser_warnings row in-block, the
 * reconcile's `unparsed_deposit_ids`), never dropped. Duplicates collapse on
 * (block, event index), as in captureTargets.
 */
export function unparsedDepositEvents(events: DepositEvent[]): DepositEvent[] {
  const seen = new Set<string>()
  const out: DepositEvent[] = []
  for (const e of [...events].sort((a, b) => a.blockHeight - b.blockHeight || a.eventIndex - b.eventIndex)) {
    if (!ENTRY_EVENTS[e.eventName] || isNumericDepositId(e.depositId)) continue
    const id = `${e.blockHeight}:${e.eventIndex}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(e)
  }
  return out
}

/**
 * Group entry events into storage reads: one per (block, pallet, deposit), in
 * block order. Duplicate event rows (a ReplacingMergeTree source read before a
 * merge) collapse on (block, event index). An event with a non-numeric deposit id
 * is no target (unparsedDepositEvents surfaces it).
 */
export function captureTargets(events: DepositEvent[]): CaptureTarget[] {
  const seen = new Set<string>()
  const byKey = new Map<string, CaptureTarget>()
  const sorted = [...events].sort((a, b) => a.blockHeight - b.blockHeight || a.eventIndex - b.eventIndex)
  for (const e of sorted) {
    const pallet = ENTRY_EVENTS[e.eventName]
    if (!pallet || !isNumericDepositId(e.depositId)) continue
    const id = `${e.blockHeight}:${e.eventIndex}`
    if (seen.has(id)) continue
    seen.add(id)
    const key = targetKey(pallet, e.depositId, e.blockHeight)
    let t = byKey.get(key)
    if (!t) {
      t = { blockHeight: e.blockHeight, pallet, depositId: e.depositId, eventIndex: e.eventIndex, eventName: e.eventName, eventFarms: [] }
      byKey.set(key, t)
    }
    if (!t.eventFarms.some(f => f.yieldFarmId === e.yieldFarmId)) t.eventFarms.push({ globalFarmId: e.globalFarmId, yieldFarmId: e.yieldFarmId })
  }
  return [...byKey.values()]
}

// ───────────────────────── decoded storage → rows ─────────────────────────

export interface CapturedEntry {
  globalFarmId: number
  yieldFarmId: number
  valuedShares: bigint
  accumulatedRpvs: bigint
  accumulatedClaimedRewards: bigint
  enteredAt: number
  updatedAt: number
  stoppedAtCreation: number
}
export interface CapturedDeposit { shares: bigint; ammPoolId: string; entries: CapturedEntry[] }

const bigOf = (v: unknown, what: string): bigint => {
  const s = typeof v === 'bigint' ? v.toString() : String(v ?? '')
  if (!/^\d+$/.test(s)) throw new Error(`${what}: not an unsigned integer (${s})`)
  return BigInt(s)
}
const numOf = (v: unknown, what: string): number => {
  const n = Number(bigOf(v, what))
  if (!Number.isSafeInteger(n)) throw new Error(`${what}: not a safe integer`)
  return n
}

/**
 * A decoded `DepositData` (the @subsquid/substrate-runtime shape: camelCase
 * fields, integers as number or bigint, an AccountId32 as 0x hex) as plain
 * values. Throws on any field it cannot read — a layout this does not know is
 * a failed capture, never a guessed row.
 */
export function normalizeDeposit(value: unknown, pallet: LmPallet): CapturedDeposit {
  if (value == null || typeof value !== 'object') throw new Error('deposit: not a struct')
  const v = value as Record<string, unknown>
  const entries = v.yieldFarmEntries
  if (!Array.isArray(entries)) throw new Error('deposit: no yieldFarmEntries')
  let ammPoolId: string
  if (pallet === 'omnipool') ammPoolId = String(numOf(v.ammPoolId, 'ammPoolId'))
  else {
    const pool = v.ammPoolId
    const hex = typeof pool === 'string' ? pool.toLowerCase() : pool instanceof Uint8Array ? `0x${Buffer.from(pool).toString('hex')}` : ''
    if (!/^0x[0-9a-f]{64}$/.test(hex)) throw new Error('deposit: ammPoolId is not an AccountId32')
    ammPoolId = hex
  }
  return {
    shares: bigOf(v.shares, 'shares'),
    ammPoolId,
    entries: entries.map((raw, i) => {
      if (raw == null || typeof raw !== 'object') throw new Error(`entry ${i}: not a struct`)
      const e = raw as Record<string, unknown>
      return {
        globalFarmId: numOf(e.globalFarmId, 'globalFarmId'),
        yieldFarmId: numOf(e.yieldFarmId, 'yieldFarmId'),
        valuedShares: bigOf(e.valuedShares, 'valuedShares'),
        accumulatedRpvs: bigOf(e.accumulatedRpvs, 'accumulatedRpvs'),
        accumulatedClaimedRewards: bigOf(e.accumulatedClaimedRewards, 'accumulatedClaimedRewards'),
        enteredAt: numOf(e.enteredAt, 'enteredAt'),
        updatedAt: numOf(e.updatedAt, 'updatedAt'),
        stoppedAtCreation: numOf(e.stoppedAtCreation, 'stoppedAtCreation'),
      }
    }),
  }
}

/** One raw_lm_farm_entries row, as inserted (UInt128 columns as decimal strings). */
export interface LmFarmEntryRow {
  pallet: LmPallet
  deposit_id: string
  yield_farm_id: number
  global_farm_id: number
  valued_shares: string
  rpvs_entry: string
  claimed_raw: string
  entered_at_period: number
  updated_at_period: number
  stopped_at_creation: number
  deposit_shares: string
  amm_pool_id: string
  is_event_entry: number
  block_height: number
  event_index: number
  event_name: string
  block_hash: string
  spec_version: number
  capture_status: 'ok' | 'gone_at_block_end'
}

/**
 * The rows one storage read yields: every entry of the deposit as held at the
 * block's end, plus a `gone_at_block_end` row for each entry the block created
 * that did not survive it (the deposit destroyed, or that farm withdrawn, in the
 * same block) — counted, never valued.
 */
export function entryRows(
  target: CaptureTarget, deposit: CapturedDeposit | undefined,
  ctx: { blockHash: string; specVersion: number },
): LmFarmEntryRow[] {
  const base = {
    pallet: target.pallet, deposit_id: target.depositId, block_height: target.blockHeight,
    event_index: target.eventIndex, event_name: target.eventName, block_hash: ctx.blockHash, spec_version: ctx.specVersion,
  }
  const gone = (f: { globalFarmId: number; yieldFarmId: number }): LmFarmEntryRow => ({
    ...base, yield_farm_id: f.yieldFarmId, global_farm_id: f.globalFarmId,
    valued_shares: '0', rpvs_entry: '0', claimed_raw: '0', entered_at_period: 0, updated_at_period: 0, stopped_at_creation: 0,
    deposit_shares: deposit ? deposit.shares.toString() : '0', amm_pool_id: deposit?.ammPoolId ?? '',
    is_event_entry: 1, capture_status: 'gone_at_block_end',
  })
  if (!deposit) return target.eventFarms.map(gone)
  const eventYfs = new Set(target.eventFarms.map(f => f.yieldFarmId))
  const rows: LmFarmEntryRow[] = deposit.entries.map(e => ({
    ...base, yield_farm_id: e.yieldFarmId, global_farm_id: e.globalFarmId,
    valued_shares: e.valuedShares.toString(), rpvs_entry: e.accumulatedRpvs.toString(), claimed_raw: e.accumulatedClaimedRewards.toString(),
    entered_at_period: e.enteredAt, updated_at_period: e.updatedAt, stopped_at_creation: e.stoppedAtCreation,
    deposit_shares: deposit.shares.toString(), amm_pool_id: deposit.ammPoolId,
    is_event_entry: eventYfs.has(e.yieldFarmId) ? 1 : 0, capture_status: 'ok',
  }))
  const present = new Set(deposit.entries.map(e => e.yieldFarmId))
  for (const f of target.eventFarms) if (!present.has(f.yieldFarmId)) rows.push(gone(f))
  return rows
}

/** Row order for a capture: stable, so a replayed block writes its rows in the same order. */
export function compareEntryRows(a: LmFarmEntryRow, b: LmFarmEntryRow): number {
  return a.block_height - b.block_height || a.pallet.localeCompare(b.pallet) || a.deposit_id.localeCompare(b.deposit_id) || a.yield_farm_id - b.yield_farm_id
}

// ───────────────────────── the in-block capture ─────────────────────────

/** What the capture needs of a runtime: the executing one (subsquid's `block.header._runtime`). */
export interface LmStorageRuntime {
  readonly specVersion: number
  hasStorageItem(name: string): boolean
  queryStorage(blockHash: string, name: string, keys: unknown[]): Promise<unknown[]>
}

export const LM_ENTRY_WARNING_PARSER = 'raw_lm_farm_entries'
export const LM_ENTRY_WARNING_CODE = 'lm_entry_capture_failed'
/**
 * An entry event whose deposit id the capture cannot read. Not a capture gap the
 * reconcile can close by re-reading (there is no key to read), so it is not in the
 * open set (OPEN_LM_ENTRY_WARNINGS_SQL); the reconcile counts such events from
 * lm_deposit_farm_events every pass instead, and a count above zero keeps it open.
 */
export const LM_ENTRY_UNPARSED_DEPOSIT_ID_CODE = 'lm_entry_unparsed_deposit_id'

function unparsedWarning(e: DepositEvent, block: { height: number; timestamp: string }, specVersion: number, ingestSource: string): RawParserWarningRow {
  return {
    block_height: block.height,
    block_timestamp: block.timestamp,
    parser: LM_ENTRY_WARNING_PARSER,
    source_kind: 'event',
    source_name: e.eventName,
    // The event is the identity: its deposit id is exactly what could not be read.
    source_index: String(e.eventIndex),
    warning_code: LM_ENTRY_UNPARSED_DEPOSIT_ID_CODE,
    warning: `entry event has no decimal deposit id (${JSON.stringify(e.depositId)})`,
    evidence_json: JSON.stringify({ event_index: e.eventIndex, event_name: e.eventName, deposit_id: e.depositId, global_farm_id: e.globalFarmId, yield_farm_id: e.yieldFarmId, spec_version: specVersion }),
    ingest_source: ingestSource,
  }
}

function captureWarning(
  target: CaptureTarget, block: { height: number; timestamp: string }, specVersion: number, ingestSource: string, error: unknown,
): RawParserWarningRow {
  return {
    block_height: block.height,
    block_timestamp: block.timestamp,
    parser: LM_ENTRY_WARNING_PARSER,
    source_kind: 'storage',
    source_name: LM_STORAGE[target.pallet],
    // The deposit is the identity: raw_parser_warnings replaces on (block, parser,
    // source_kind, source_index, warning_code), and one block can fail several.
    source_index: `${target.pallet}:${target.depositId}`,
    warning_code: LM_ENTRY_WARNING_CODE,
    warning: error instanceof Error ? error.message : 'LM deposit storage read failed',
    // Plain JSON: toJsonString would render the small farm-id array as hex bytes.
    evidence_json: JSON.stringify({
      pallet: target.pallet,
      deposit_id: target.depositId,
      event_index: target.eventIndex,
      event_name: target.eventName,
      yield_farm_ids: target.eventFarms.map(f => f.yieldFarmId),
      spec_version: specVersion,
    }),
    ingest_source: ingestSource,
  }
}

/**
 * Capture the farm entries a block created: one `queryStorage` per pallet for
 * every deposit its entry events name, at the block's own hash, decoded by the
 * runtime that executed it. A no-op (no RPC) for a block without entry events.
 *
 * Failure semantics are the money-market position reads' (moneyMarket.ts): a
 * failed read or an undecodable deposit never aborts the block. It yields no row
 * for that deposit — never a `gone_at_block_end`, which states the chain's answer
 * "not there" — and a `raw_parser_warnings` row naming the block and deposit, so
 * the gap is visible. The anchors loop (`atoken-anchor`, reconcileLmEntries)
 * re-reads every block with such an open warning from its archive node each
 * cycle, and `snapshot-lm-entries.ts` is the manual repair; the warning row stays
 * as written, and the target's row landing is what closes it (the open set is
 * the anti-join, lmEntryPorts.ts). Other deposits of the block are unaffected.
 * An entry event with no readable deposit id yields a warning of its own
 * (LM_ENTRY_UNPARSED_DEPOSIT_ID_CODE) and no read.
 */
export async function captureLmFarmEntries(
  block: { height: number; hash: string; timestamp: string },
  events: DepositEvent[],
  runtime: LmStorageRuntime,
  ingestSource: string,
): Promise<{ rows: LmFarmEntryRow[]; warnings: RawParserWarningRow[]; reads: number }> {
  const rows: LmFarmEntryRow[] = []
  const warnings: RawParserWarningRow[] = []
  let reads = 0
  const specVersion = runtime.specVersion
  for (const e of unparsedDepositEvents(events)) warnings.push(unparsedWarning(e, block, specVersion, ingestSource))
  const targets = captureTargets(events)
  if (!targets.length) return { rows, warnings, reads }
  for (const pallet of ['omnipool', 'xyk'] as const) {
    const ts = targets.filter(t => t.pallet === pallet)
    if (!ts.length) continue
    const name = LM_STORAGE[pallet]
    let values: unknown[]
    try {
      if (!runtime.hasStorageItem(name)) throw new Error(`spec ${specVersion} has no ${name}`)
      reads++
      values = await runtime.queryStorage(block.hash, name, ts.map(t => BigInt(t.depositId)))
      if (values.length !== ts.length) throw new Error(`${values.length} values for ${ts.length} deposits`)
    } catch (error) {
      for (const t of ts) warnings.push(captureWarning(t, block, specVersion, ingestSource, error))
      continue
    }
    ts.forEach((t, i) => {
      try {
        const deposit = values[i] == null ? undefined : normalizeDeposit(values[i], pallet)
        rows.push(...entryRows(t, deposit, { blockHash: block.hash, specVersion }))
      } catch (error) {
        warnings.push(captureWarning(t, block, specVersion, ingestSource, error))
      }
    })
  }
  rows.sort(compareEntryRows)
  return { rows, warnings, reads }
}
