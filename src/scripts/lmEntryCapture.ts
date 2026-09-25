// The verify/repair side of the liquidity-mining entry capture
// (snapshot-lm-entries.ts), kept free of any connection so it can be exercised
// with fakes. The capture itself runs inside the raw indexer
// (src/raw/lmFarmEntries.ts, called per block from src/raw/indexer.ts); this
// re-walks a block range from indexed rows and archive-node state with the SAME
// row builders, to repair targets the indexer could not read (it records each
// as a raw_parser_warnings row) and to check what is stored.

import {
  captureTargets, compareEntryRows, entryRows, normalizeDeposit, targetKey,
  type CaptureTarget, type DepositEvent, type LmFarmEntryRow, type LmPallet,
} from '../raw/lmFarmEntries.js'

export {
  ENTRY_EVENTS, ENTRY_EVENT_NAMES, LM_STORAGE, captureTargets, entryRows, normalizeDeposit, targetKey,
  type CaptureTarget, type CapturedDeposit, type CapturedEntry, type DepositEvent, type LmFarmEntryRow, type LmPallet,
} from '../raw/lmFarmEntries.js'

/**
 * The entry event a lm_deposit_farm_events row was projected from: its MV names
 * the pallet from the event's prefix and the kind from its suffix, so the pair
 * restores the name exactly. Null for a kind that creates no entry.
 */
export function entryEventName(pallet: string, eventKind: string): string | null {
  const prefix = pallet === 'omnipool' ? 'OmnipoolLiquidityMining' : pallet === 'xyk' ? 'XYKLiquidityMining' : null
  const suffix = eventKind === 'deposited' ? 'SharesDeposited' : eventKind === 'redeposited' ? 'SharesRedeposited' : null
  return prefix && suffix ? `${prefix}.${suffix}` : null
}

/** A lm_deposit_farm_events row as the capture reads it. */
export interface DepositFarmEventRow { block_height: number; event_index: number; pallet: string; event_kind: string; deposit_id: string; global_farm_id: number; yield_farm_id: number }

/**
 * The entry events of lm_deposit_farm_events rows. One table carries the event,
 * its deposit and its farm (all from one raw event, one MV row), so no row can
 * arrive without its farm — reading them from two separately-visible tables
 * could see one before the other.
 */
export function depositEventsFromRows(rows: DepositFarmEventRow[]): DepositEvent[] {
  const out: DepositEvent[] = []
  for (const r of rows) {
    const eventName = entryEventName(r.pallet, r.event_kind)
    if (!eventName) continue
    out.push({ blockHeight: Number(r.block_height), eventIndex: Number(r.event_index), eventName, depositId: String(r.deposit_id), globalFarmId: Number(r.global_farm_id), yieldFarmId: Number(r.yield_farm_id) })
  }
  return out
}

// ───────────────────────── which runtime decodes a block ─────────────────────────

/**
 * The spec whose storage layout a block's POST-state is in: the runtime that
 * EXECUTED the block, i.e. the code in its parent's state. `blocks.spec_version`
 * records the post-state version instead, which differs exactly at an upgrade
 * block — the one whose set_validation_data applied new code (System.CodeUpdated):
 * its state still has the old layout, and the new runtime's migrations run at the
 * start of the NEXT block. So the layout of block N is the spec of block N − 1.
 */
export const executingSpec = (specByHeight: Map<number, number>, height: number): number | undefined =>
  specByHeight.get(height - 1) ?? (height === 0 ? specByHeight.get(0) : undefined)

// ───────────────────────── ports ─────────────────────────

export interface CaptureSource {
  /** Entry events with their farm, blocks [from, to]. */
  depositEvents(from: number, to: number): Promise<DepositEvent[]>
  /** price_data.blocks spec_version for these heights. */
  specVersions(heights: number[]): Promise<Map<number, number>>
  /**
   * Target keys (targetKey) already in raw_lm_farm_entries within [from, to],
   * for these deposits only (the table is deposit-first: a key-prefix read).
   */
  capturedKeys(from: number, to: number, deposits: Array<{ pallet: LmPallet; depositId: string }>): Promise<Set<string>>
}

export interface CaptureChain {
  /** Canonical hashes by height. */
  blockHashes(heights: number[]): Promise<Map<number, string>>
  /**
   * The deposits' decoded values at the END of `block`, decoded with the
   * runtime of `layoutSpec` (see executingSpec); `undefined` where no deposit is
   * stored. A runtime not cached yet is loaded from the parent's state
   * (height − 1), whose code is the one that executed the block.
   */
  readDeposits(block: { height: number; hash: string; layoutSpec: number }, pallet: LmPallet, depositIds: string[]): Promise<Array<unknown | undefined>>
}

export interface CaptureSink { insert(rows: LmFarmEntryRow[]): Promise<void> }

export interface ChunkStats {
  from: number
  to: number
  events: number
  targets: number
  skipped: number
  blocks: number
  rows: number
  gone: number
  reads: number
  ms: number
}

export interface CaptureOptions {
  dryRun: boolean
  /** Re-read targets already captured (a replay: same rows, replaced in place). */
  recapture: boolean
  /** Blocks read concurrently. */
  concurrency: number
  /** Rows collected for --verify; untouched when absent. */
  collect?: LmFarmEntryRow[]
}

async function pool<T>(items: T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(width, items.length)) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i]) }
  })
  await Promise.all(workers)
}

/**
 * Capture one block range: its entry events → storage reads (skipping what is
 * already captured unless `recapture`) → rows, inserted once the whole chunk
 * has been read (a failure mid-chunk writes nothing for it; the next run redoes
 * it). Idempotent: the rows are chain state at fixed blocks under a
 * ReplacingMergeTree key, so a replay replaces them with identical values.
 */
export async function captureRange(
  from: number, to: number,
  deps: { source: CaptureSource; chain: CaptureChain; sink: CaptureSink },
  opts: CaptureOptions,
): Promise<ChunkStats> {
  const t0 = Date.now()
  const events = await deps.source.depositEvents(from, to)
  const all = captureTargets(events)
  const deposits = [...new Map(all.map(t => [`${t.pallet}:${t.depositId}`, { pallet: t.pallet, depositId: t.depositId }])).values()]
  const done = opts.recapture || !deposits.length ? new Set<string>() : await deps.source.capturedKeys(from, to, deposits)
  const targets = all.filter(t => !done.has(targetKey(t.pallet, t.depositId, t.blockHeight)))
  const heights = [...new Set(targets.map(t => t.blockHeight))].sort((a, b) => a - b)
  const stats: ChunkStats = { from, to, events: events.length, targets: targets.length, skipped: all.length - targets.length, blocks: heights.length, rows: 0, gone: 0, reads: 0, ms: 0 }
  if (!heights.length) { stats.ms = Date.now() - t0; return stats }

  const [specs, hashes] = await Promise.all([
    deps.source.specVersions([...new Set(heights.flatMap(h => [h, h - 1]))]),
    deps.chain.blockHashes(heights),
  ])
  const byBlock = new Map<number, CaptureTarget[]>()
  for (const t of targets) { const list = byBlock.get(t.blockHeight) ?? []; list.push(t); byBlock.set(t.blockHeight, list) }

  const rows: LmFarmEntryRow[] = []
  await pool(heights, opts.concurrency, async height => {
    const hash = hashes.get(height)
    const layoutSpec = executingSpec(specs, height)
    if (!hash || layoutSpec == null) throw new Error(`block ${height}: no hash/spec to read it at`)
    const list = byBlock.get(height)!
    for (const pallet of ['omnipool', 'xyk'] as const) {
      const ts = list.filter(t => t.pallet === pallet)
      if (!ts.length) continue
      const values = await deps.chain.readDeposits({ height, hash, layoutSpec }, pallet, ts.map(t => t.depositId))
      stats.reads++
      if (values.length !== ts.length) throw new Error(`block ${height}: ${values.length} values for ${ts.length} deposits`)
      ts.forEach((t, i) => {
        const deposit = values[i] == null ? undefined : normalizeDeposit(values[i], pallet)
        rows.push(...entryRows(t, deposit, { blockHash: hash, specVersion: layoutSpec }))
      })
    }
  })
  rows.sort(compareEntryRows)
  stats.rows = rows.length
  stats.gone = rows.filter(r => r.capture_status === 'gone_at_block_end').length
  if (opts.collect) opts.collect.push(...rows)
  if (!opts.dryRun && rows.length) await deps.sink.insert(rows)
  stats.ms = Date.now() - t0
  return stats
}

/** [from, to] as consecutive chunks of at most `size` blocks. */
export function chunks(from: number, to: number, size: number): Array<[number, number]> {
  if (!Number.isInteger(size) || size <= 0) throw new Error('chunk size must be a positive integer')
  const out: Array<[number, number]> = []
  for (let a = from; a <= to; a += size) out.push([a, Math.min(to, a + size - 1)])
  return out
}

// ───────────────────────── reconcile (the anchors loop's third port) ─────────────────────────

/** One open capture warning: its block and `<pallet>:<deposit>`. */
export interface OpenLmEntryWarning { blockHeight: number; sourceIndex: string }

/** An entry event whose deposit id is not a decimal integer: no storage key to read. */
export interface UnparsedEntryEvent { blockHeight: number; eventIndex: number; pallet: string; depositId: string }

export interface LmReconcileSource {
  /**
   * The OPEN warnings (at most `limit`): raw_parser_warnings rows of parser
   * raw_lm_farm_entries whose (pallet, deposit, block) has no raw_lm_farm_entries
   * row (lmEntryPorts.ts OPEN_LM_ENTRY_WARNINGS_SQL). A warning is never rewritten
   * when it is repaired — the row landing closes it, so this anti-join is the
   * whole open/repaired distinction.
   */
  openWarnings(limit: number): Promise<OpenLmEntryWarning[]>
  /**
   * The full check (at most `limit` blocks): blocks with an entry target in
   * lm_deposit_farm_events and no raw_lm_farm_entries row — gaps no warning names
   * (a block whose commit was cut between the event and entry inserts).
   */
  uncapturedBlocks(limit: number): Promise<number[]>
  /**
   * Entry events (at most `limit`) whose deposit id is not a decimal integer. The
   * full check cannot list them — they have no target — and no re-read closes
   * them; they need a decoder fix, so each pass reports them.
   */
  unparsedEntryEvents(limit: number): Promise<UnparsedEntryEvent[]>
}

export interface LmReconcileOptions {
  dryRun: boolean
  concurrency: number
  /** Cap on warnings and on full-check blocks read per pass. */
  limit: number
}

export interface LmReconcileResult {
  /** Open warnings before the repair (capped at `limit`). */
  openBefore: number
  /** Full-check blocks without their rows (capped at `limit`). */
  uncapturedBlocks: number
  /** Entry events with no decimal deposit id (capped at `limit`); any keeps the pass open. */
  unparsedDepositIds: number
  /** The first few of them, for the log line. */
  firstUnparsed: UnparsedEntryEvent[]
  /** A set reached `limit`: more remains for the next pass. */
  truncated: boolean
  /** Distinct blocks re-read. */
  blocks: number
  rows: number
  gone: number
  /** Blocks whose re-read threw (a pruned node, a runtime layout normalizeDeposit refuses): still open, retried next pass. */
  failed: Array<{ block: number; reason: string }>
  /** Open warnings after the repair; null in a dry run (nothing was written). */
  openAfter: number | null
}

/**
 * One reconcile pass: every block that holds an open warning or fails the full
 * check is re-captured with captureRange(block, block) — which reads only the
 * targets still without a row, so a replay rewrites nothing — one block at a
 * time, so a block that cannot be read (its read throws, and captureRange then
 * writes nothing for it) never holds back the others. A deterministic failure
 * stays open, is reported in `failed` each pass, and repairs itself on the first
 * pass after its cause is fixed (an archive node, a decoder for the new layout).
 */
export async function reconcileLmEntries(
  source: LmReconcileSource,
  deps: { source: CaptureSource; chain: CaptureChain; sink: CaptureSink },
  opts: LmReconcileOptions,
): Promise<LmReconcileResult> {
  const warnings = await source.openWarnings(opts.limit)
  const uncaptured = await source.uncapturedBlocks(opts.limit)
  const unparsed = await source.unparsedEntryEvents(opts.limit)
  const blocks = [...new Set([...warnings.map(w => w.blockHeight), ...uncaptured])].sort((a, b) => a - b)
  const result: LmReconcileResult = {
    openBefore: warnings.length, uncapturedBlocks: uncaptured.length,
    unparsedDepositIds: unparsed.length, firstUnparsed: unparsed.slice(0, 5),
    truncated: warnings.length >= opts.limit || uncaptured.length >= opts.limit || unparsed.length >= opts.limit,
    blocks: blocks.length, rows: 0, gone: 0, failed: [], openAfter: null,
  }
  for (const block of blocks) {
    try {
      const s = await captureRange(block, block, deps, { dryRun: opts.dryRun, recapture: false, concurrency: opts.concurrency })
      result.rows += s.rows
      result.gone += s.gone
    } catch (error) {
      result.failed.push({ block, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  if (!opts.dryRun) result.openAfter = blocks.length ? (await source.openWarnings(opts.limit)).length : warnings.length
  return result
}
