// One cycle of the anchors loop (snapshot-atoken-anchors.ts --loop, the
// `atoken-anchor` service), kept free of any connection so its decisions can be
// exercised with fakes. Two B0 anchors and one repair share it, each keeping its
// own gate:
//
//   aToken scaled-balance anchor (atoken_scaled_anchor): the reserve map is
//     refreshed every cycle; the anchor is captured when its table is empty (or
//     every cycle under --force) AND raw ingestion has completed every block from
//     MM_LOGS_FROM to B0 — its candidate holders come from the money market's own
//     logs and the models fed by them, so a capture on a partial backfill would
//     anchor too few holders and, the table then being non-empty, never again.
//     The coverage gate holds under --force too.
//   money-market incentive anchor (mm_incentive_anchor): captured when its table
//     is empty (or under --force-incentive) AND raw ingestion has completed every
//     block from CONTROLLER_LOGS_FROM to B0 — its candidates come from the
//     controller's logs, so a capture on a partial backfill would anchor too few
//     users and, the table then being non-empty, never again. The coverage gate
//     holds under --force-incentive too.
//   liquidity-mining entry reconcile (raw_lm_farm_entries): every cycle. The raw
//     indexer captures entries in-block and leaves a raw_parser_warnings row for a
//     deposit it could not read; a failure that is deterministic for that block
//     (pruned state on the indexer's node, a DepositData layout the decoder
//     refuses) would never heal by itself. This port re-captures every block with
//     an OPEN warning, plus every block the full check finds without its rows
//     (reconcileLmEntries, lmEntryCapture.ts), against the service's archive node.
//
// The aToken anchor runs first: the incentive candidate set includes the aToken
// anchor's holders, so on a fresh database a cycle that establishes both reads the
// fuller set. A failure in one never skips another — they are independent, and
// each retries next cycle.

import type { LmReconcileResult } from './lmEntryCapture.js'

export type AnchorDecision = { capture: true } | { capture: false; reason: string; detail?: Record<string, unknown> }

export interface AtokenAnchorPort {
  /** Refresh atoken_reserve_map (every cycle; picks up newly added reserves). */
  refreshReserveMap(): Promise<void>
  anchorRowCount(): Promise<number>
  /** The gaps in completed raw ingestion over MM_LOGS_FROM..B0. */
  logGaps(): Promise<Array<{ fromBlock: number; toBlock: number }>>
  capture(): Promise<void>
}

export interface IncentiveAnchorPort {
  anchorRowCount(): Promise<number>
  controllerLogGaps(): Promise<Array<{ fromBlock: number; toBlock: number }>>
  capture(): Promise<void>
}

export interface LmEntryReconcilePort {
  reconcile(): Promise<LmReconcileResult>
}

export async function atokenAnchorDecision(port: Pick<AtokenAnchorPort, 'anchorRowCount' | 'logGaps'>, force: boolean, logsFrom: number, anchorBlock: number): Promise<AnchorDecision> {
  if (!force) {
    const existing = await port.anchorRowCount()
    if (existing > 0) return { capture: false, reason: 'anchor already present', detail: { existing_anchor_rows: existing } }
  }
  const gaps = await port.logGaps()
  if (gaps.length) {
    return { capture: false, reason: `raw ingestion has not completed ${logsFrom}..${anchorBlock} (the money market's logs)`, detail: { gaps: gaps.length, first_gaps: gaps.slice(0, 5) } }
  }
  return { capture: true }
}

export async function incentiveAnchorDecision(port: Pick<IncentiveAnchorPort, 'anchorRowCount' | 'controllerLogGaps'>, force: boolean, logsFrom: number, anchorBlock: number): Promise<AnchorDecision> {
  if (!force) {
    const existing = await port.anchorRowCount()
    if (existing > 0) return { capture: false, reason: 'anchor already present', detail: { existing_rows: existing } }
  }
  const gaps = await port.controllerLogGaps()
  if (gaps.length) {
    return { capture: false, reason: `raw ingestion has not completed ${logsFrom}..${anchorBlock} (the controller's logs)`, detail: { gaps: gaps.length, first_gaps: gaps.slice(0, 5) } }
  }
  return { capture: true }
}

export type AnchorOutcome = 'captured' | 'skipped' | 'failed'

/**
 * clean: nothing was open or missing. repaired: every gap found was closed.
 * open: a gap remains (a block failed, a set was truncated, an entry event has no
 * readable deposit id, or a dry run). failed: the pass itself threw.
 */
export type ReconcileOutcome = 'clean' | 'repaired' | 'open' | 'failed'

export interface AnchorCycleResult {
  atoken: AnchorOutcome
  incentive: AnchorOutcome
  lmEntries: ReconcileOutcome
}

export function reconcileOutcome(r: LmReconcileResult): ReconcileOutcome {
  if (r.unparsedDepositIds > 0) return 'open'
  if (!r.blocks && !r.truncated) return 'clean'
  return !r.failed.length && !r.truncated && r.openAfter === 0 ? 'repaired' : 'open'
}

export async function runAnchorCycle(
  ports: { atoken: AtokenAnchorPort; incentive: IncentiveAnchorPort; lmEntries: LmEntryReconcilePort },
  opts: { forceAtoken: boolean; forceIncentive: boolean; atokenLogsFrom: number; incentiveLogsFrom: number; anchorBlock: number },
  log: (record: Record<string, unknown>) => void,
): Promise<AnchorCycleResult> {
  const result: AnchorCycleResult = { atoken: 'failed', incentive: 'failed', lmEntries: 'failed' }

  try {
    await ports.atoken.refreshReserveMap()
    const decision = await atokenAnchorDecision(ports.atoken, opts.forceAtoken, opts.atokenLogsFrom, opts.anchorBlock)
    if (decision.capture) {
      await ports.atoken.capture()
      result.atoken = 'captured'
    } else {
      log({ type: 'atoken_anchor_done', skipped_anchor: true, reason: decision.reason, ...decision.detail })
      result.atoken = 'skipped'
    }
  } catch (error) {
    log({ type: 'atoken_anchor_error', reason: error instanceof Error ? error.message : String(error) })
  }

  try {
    const decision = await incentiveAnchorDecision(ports.incentive, opts.forceIncentive, opts.incentiveLogsFrom, opts.anchorBlock)
    if (decision.capture) {
      await ports.incentive.capture()
      result.incentive = 'captured'
    } else {
      log({ type: 'mm_incentive_anchor_done', skipped: true, reason: decision.reason, ...decision.detail })
      result.incentive = 'skipped'
    }
  } catch (error) {
    log({ type: 'mm_incentive_anchor_error', reason: error instanceof Error ? error.message : String(error) })
  }

  try {
    const r = await ports.lmEntries.reconcile()
    result.lmEntries = reconcileOutcome(r)
    // The monitoring record: open_before/open_after are the open warning set (the
    // anti-join) either side of the repair.
    log({
      type: 'lm_entries_reconcile', outcome: result.lmEntries,
      open_before: r.openBefore, uncaptured_blocks: r.uncapturedBlocks, unparsed_deposit_ids: r.unparsedDepositIds, first_unparsed: r.firstUnparsed, truncated: r.truncated,
      blocks: r.blocks, rows: r.rows, gone: r.gone, failed_blocks: r.failed.length, first_failures: r.failed.slice(0, 5), open_after: r.openAfter,
    })
  } catch (error) {
    log({ type: 'lm_entries_reconcile_error', reason: error instanceof Error ? error.message : String(error) })
  }

  return result
}
