import type { PendingBlock, PendingEventRow } from './pendingHeadService.ts'

// BASIC activity rows from an unfinalized block — deliberately a small,
// honest subset of the finalized classifier, not a reimplementation of it:
//   trades    — Broadcast.Swapped* legs folded per originating extrinsic
//               (route hops share one extrinsic: first input, last output);
//               block-initialization swaps (DCA executions) fold per swapper.
//   transfers — Balances/Tokens.Transfer, suppressed when their extrinsic
//               also swapped (those transfers are the trade's own plumbing).
// Everything else (liquidity, XCM, money market, staking, votes, OTC) waits
// for finality and the real classifier. Rows are marked unfinalized upstream
// and may reorg away with their block.

export interface PendingTradeActivity {
  kind: 'trade'
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  swapper: string
  assetIn: number
  amountIn: string
  assetOut: number
  amountOut: string
}
export interface PendingTransferActivity {
  kind: 'transfer'
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  from: string
  to: string
  assetId: number
  amount: string
}
export type PendingActivity = PendingTradeActivity | PendingTransferActivity

export function buildPendingActivities(block: PendingBlock): PendingActivity[] {
  const swapGroups = new Map<string, PendingEventRow[]>()
  const swapExtrinsics = new Set<number>()
  // Initialization-phase swaps have no extrinsic to anchor suppression on, so
  // their plumbing transfers are recognized by touching the swapper instead.
  const initSwappers = new Set<string>()
  for (const e of block.events) {
    if (!e.swap) continue
    if (e.extrinsicIndex != null) swapExtrinsics.add(e.extrinsicIndex)
    else initSwappers.add(e.swap.swapper)
    // Initialization-phase swaps (no extrinsic — DCA executions) group per
    // swapper; two same-swapper schedules in one block would fold together,
    // an accepted imprecision for rows that live ~40 seconds.
    const key = e.extrinsicIndex != null ? `x${e.extrinsicIndex}` : `i${e.swap.swapper}`
    const group = swapGroups.get(key)
    if (group) group.push(e)
    else swapGroups.set(key, [e])
  }

  const out: PendingActivity[] = []
  for (const group of swapGroups.values()) {
    const first = group[0]
    const last = group[group.length - 1]
    const input = first.swap!.inputs[0]
    const output = last.swap!.outputs[last.swap!.outputs.length - 1]
    if (!input || !output) continue
    out.push({
      kind: 'trade',
      blockHeight: block.height,
      timestamp: block.timestamp,
      eventIndex: first.eventIndex,
      extrinsicIndex: first.extrinsicIndex,
      swapper: first.swap!.swapper,
      assetIn: input.assetId,
      amountIn: input.amount,
      assetOut: output.assetId,
      amountOut: output.amount,
    })
  }

  for (const e of block.events) {
    if (!e.transfer) continue
    if (e.extrinsicIndex != null && swapExtrinsics.has(e.extrinsicIndex)) continue
    if (e.extrinsicIndex == null && (initSwappers.has(e.transfer.from) || initSwappers.has(e.transfer.to))) continue
    out.push({
      kind: 'transfer',
      blockHeight: block.height,
      timestamp: block.timestamp,
      eventIndex: e.eventIndex,
      extrinsicIndex: e.extrinsicIndex,
      from: e.transfer.from,
      to: e.transfer.to,
      assetId: e.transfer.assetId,
      amount: e.transfer.amount,
    })
  }

  return out.sort((a, b) => b.eventIndex - a.eventIndex)
}
