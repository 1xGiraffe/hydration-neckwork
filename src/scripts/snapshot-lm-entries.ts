import type { RpcClient } from '@subsquid/rpc-client'
import { BOUNDED_QUERY_SETTINGS, createClickHouseClient } from '../db/client.js'
import { appendFileSync, writeFileSync } from 'node:fs'
import { hasFlag, integerOption, optionalIntegerOption, stringOption } from '../util/cliArgs.js'
import { captureRange, chunks, normalizeDeposit, type ChunkStats, type LmFarmEntryRow, type LmPallet } from './lmEntryCapture.js'
import { createLmCaptureChain, createLmCaptureSink, createLmCaptureSource, createLmReconcileSource } from './lmEntryPorts.js'
import { createSnapshotRpcClient, runSnapshotProcess } from './snapshotRuntime.js'

// Verify / repair tool for price_data.raw_lm_farm_entries. The rows are captured
// by the raw indexer itself, in every raw pipeline (raw-live and the backfill
// workers), at the end of every entry-creating block (src/raw/lmFarmEntries.ts);
// a deposit it could not read is left without rows and named by a
// raw_parser_warnings row (parser 'raw_lm_farm_entries'). This tool re-walks
// indexed rows (the entry events with their farms from lm_deposit_farm_events,
// spec versions from blocks) and archive-node state with the same row builders,
// and inserts only the targets that have no row yet — so it is the repair for
// such a warning, and a dry run with --verify is the check of what is stored.
//
// Modes:
//   --from-block=N --to-block=M   capture the missing entry targets of [N, M] in
//                                 chunks (--block-chunk-size, default 100,000 blocks)
//   (neither)                     one reconcile pass over the whole history.
//   --open                        read-only: list the OPEN capture warnings (a
//                                 warning whose target still has no row — the set
//                                 the anchors loop repairs every cycle) and every
//                                 entry event with no decimal deposit id, and exit
//                                 non-zero when either is non-empty.
// Flags: --dry-run (read and report, write nothing), --verify (compare the entries
// read against the current lm_reward_snapshots generation: the constants of an
// entry that is still open must equal what storage holds now), --recapture (re-read
// targets already captured; rows are replaced in place with identical values),
// --concurrency=N blocks in flight (default 4), --out=FILE (with --dry-run: the
// rows that would be inserted, as JSON lines — inspect a run without writing to
// ClickHouse). RPC pacing: RPC_RATE_LIMIT /
// RPC_CAPACITY. Needs an ARCHIVE node: it reads state at historical block hashes.
//
// The ClickHouse and archive-node ports are lmEntryPorts.ts, shared with the
// anchors loop; every read there is bounded under BOUNDED_QUERY_SETTINGS.
//
//   npx tsx src/scripts/snapshot-lm-entries.ts --from-block=2750000 --to-block=2849999 --dry-run --verify

const dryRun = hasFlag('dry-run')
const verify = hasFlag('verify')
const recapture = hasFlag('recapture')
const fromBlock = optionalIntegerOption('from-block')
const toBlock = optionalIntegerOption('to-block')
const chunkSize = integerOption('block-chunk-size', 100_000, { min: 1 })
const concurrency = integerOption('concurrency', 4, { min: 1, max: 64 })
const outFile = stringOption('out')
if (outFile && !dryRun) throw new Error('--out is a dry-run output; pass --dry-run')
if (outFile) writeFileSync(outFile, '')

const client = createClickHouseClient()
const rpc: RpcClient = createSnapshotRpcClient()

async function rows<T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const res = await client.query({ query, query_params: params, format: 'JSONEachRow', clickhouse_settings: BOUNDED_QUERY_SETTINGS })
  return res.json<T>()
}

const source = createLmCaptureSource(client, { missingTableIsEmpty: dryRun })
const chain = createLmCaptureChain(rpc)
const sink = createLmCaptureSink(client)

const collected: LmFarmEntryRow[] = []
const totals = { chunks: 0, events: 0, targets: 0, skipped: 0, blocks: 0, reads: 0, rows: 0, gone: 0, ms: 0 }

async function runRange(from: number, to: number, label: string): Promise<void> {
  for (const [a, b] of chunks(from, to, chunkSize)) {
    const chunkRows: LmFarmEntryRow[] = []
    const s: ChunkStats = await captureRange(a, b, { source, chain, sink }, { dryRun, recapture, concurrency, collect: verify || outFile ? chunkRows : undefined })
    if (verify) collected.push(...chunkRows)
    if (outFile && chunkRows.length) appendFileSync(outFile, chunkRows.map(r => JSON.stringify(r)).join('\n') + '\n')
    totals.chunks++
    for (const k of ['events', 'targets', 'skipped', 'blocks', 'reads', 'rows', 'gone', 'ms'] as const) totals[k] += s[k]
    console.log(JSON.stringify({ type: 'lm_entries_chunk', mode: label, ...s, dry_run: dryRun }))
  }
}

async function firstEventBlock(): Promise<number> {
  const r = await rows<{ h: number | null }>(`
    SELECT if(count() = 0, NULL, min(block_height)) AS h FROM price_data.lm_deposit_farm_events PREWHERE event_kind IN ('deposited', 'redeposited')`)
  return r[0]?.h == null ? 0 : Number(r[0].h)
}

async function finalizedHead(): Promise<number> {
  const hash = await rpc.call<string>('chain_getFinalizedHead', [])
  const header = await rpc.call<{ number: string }>('chain_getHeader', [hash])
  return Number.parseInt(header.number, 16)
}

async function indexedHead(): Promise<number> {
  const r = await rows<{ h: number }>(`SELECT max(block_height) AS h FROM price_data.lp_lifecycle_events`)
  return Number(r[0]?.h ?? 0)
}

// --verify: every entry this run read that is still open NOW must carry, at its
// creation block, the constants storage holds for it today — they never change
// during an entry's life. "Now" is read twice: straight from storage at the
// finalized head (all four constants), and from the lm-rewards refresher's
// published generation (lm_reward_snapshots, which stores valued_shares,
// rpvs_entry and entered_at_period). An entry is the same instance when its
// entered_at matches (a deposit can leave a farm and enter it again).
async function verifyAgainstCurrent(): Promise<boolean> {
  const created = new Map<string, LmFarmEntryRow>()
  for (const r of collected) {
    if (r.capture_status !== 'ok' || r.is_event_entry !== 1) continue
    created.set(`${r.pallet}:${r.deposit_id}:${r.yield_farm_id}:${r.entered_at_period}`, r)
  }
  const report = (label: string, current: Array<{ key: string; valued_shares: string; rpvs_entry: string; stopped_at_creation?: number }>): boolean => {
    let compared = 0, matched = 0, notInRun = 0
    const mismatches: unknown[] = []
    for (const c of current) {
      const r = created.get(c.key)
      if (!r) { notInRun++; continue }
      compared++
      const same = r.valued_shares === c.valued_shares && r.rpvs_entry === c.rpvs_entry
        && (c.stopped_at_creation == null || r.stopped_at_creation === c.stopped_at_creation)
      if (same) matched++
      else if (mismatches.length < 10) mismatches.push({ key: c.key, captured: { valued_shares: r.valued_shares, rpvs_entry: r.rpvs_entry, stopped_at_creation: r.stopped_at_creation }, current: c })
    }
    console.log(JSON.stringify({ type: 'lm_entries_verify', against: label, current_entries: current.length, compared, matched, mismatched: compared - matched, current_not_created_in_range: notInRun, sample_mismatches: mismatches }))
    return compared === matched
  }

  // Storage at the finalized head, for the deposits this run touched.
  const head = await finalizedHead()
  const hashes = await chain.blockHashes([head, head - 1])
  const headHash = hashes.get(head)
  const parentHash = hashes.get(head - 1)
  // The head's layout is the runtime that executed it: the code in its parent's state.
  const headSpec = parentHash ? (await rpc.call<{ specVersion: number }>('state_getRuntimeVersion', [parentHash])).specVersion : null
  const fromHead: Array<{ key: string; valued_shares: string; rpvs_entry: string; stopped_at_creation: number }> = []
  if (headHash && headSpec != null) {
    for (const pallet of ['omnipool', 'xyk'] as const) {
      const ids = [...new Set(collected.filter(r => r.pallet === pallet).map(r => r.deposit_id))]
      for (let i = 0; i < ids.length; i += 500) {
        const slice = ids.slice(i, i + 500)
        const values = await chain.readDeposits({ height: head, hash: headHash, layoutSpec: headSpec }, pallet, slice)
        slice.forEach((id, k) => {
          if (values[k] == null) return
          for (const e of normalizeDeposit(values[k], pallet).entries) {
            fromHead.push({ key: `${pallet}:${id}:${e.yieldFarmId}:${e.enteredAt}`, valued_shares: e.valuedShares.toString(), rpvs_entry: e.accumulatedRpvs.toString(), stopped_at_creation: e.stoppedAtCreation })
          }
        })
      }
    }
  }
  const headOk = report(`storage@${head}`, fromHead)

  const snap = await rows<{ pallet: LmPallet; deposit_id: string; yield_farm_id: number; valued_shares: string; rpvs_entry: string; entered_at_period: number }>(`
    SELECT pallet, deposit_id, yield_farm_id, toString(valued_shares) AS valued_shares, toString(rpvs_entry) AS rpvs_entry, entered_at_period
    FROM price_data.lm_reward_snapshots
    WHERE snapshot_id = (SELECT argMax(snapshot_id, computed_at) FROM price_data.lm_reward_snapshot_state WHERE snapshot_key = 'current')`)
  const snapOk = report('lm_reward_snapshots', snap.map(c => ({ key: `${c.pallet}:${c.deposit_id}:${c.yield_farm_id}:${c.entered_at_period}`, valued_shares: c.valued_shares, rpvs_entry: c.rpvs_entry })))
  return headOk && snapOk
}

async function listOpen(): Promise<void> {
  const source = createLmReconcileSource(client)
  const open = await source.openWarnings(10_000)
  const unparsed = await source.unparsedEntryEvents(10_000)
  console.log(JSON.stringify({ type: 'lm_entries_open', open: open.length, truncated: open.length >= 10_000, first: open.slice(0, 20), unparsed_deposit_ids: unparsed.length, first_unparsed: unparsed.slice(0, 20) }))
  if (open.length || unparsed.length) process.exitCode = 1
}

async function once(): Promise<void> {
  if (hasFlag('open')) { await listOpen(); return }
  if (fromBlock != null || toBlock != null) {
    if (fromBlock == null || toBlock == null || toBlock < fromBlock) throw new Error('--from-block and --to-block (M >= N) go together')
    await runRange(fromBlock, toBlock, 'range')
  } else {
    await runRange(await firstEventBlock(), Math.min(await finalizedHead(), await indexedHead()), 'reconcile')
  }
  console.log(JSON.stringify({ type: 'lm_entries_done', ...totals, dry_run: dryRun }))
  if (verify && !(await verifyAgainstCurrent())) process.exitCode = 1
}

void runSnapshotProcess({
  loop: false,
  refreshHours: 1,
  runOnce: once,
  close: async () => {
    rpc.close()
    await client.close()
  },
})
