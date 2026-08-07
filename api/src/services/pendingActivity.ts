import type { PendingBlock, PendingEventRow, PendingMmLeg } from './pendingHeadService.ts'

// BASIC activity rows from an unfinalized block — deliberately a small,
// honest subset of the finalized classifier, not a reimplementation of it:
//   trades    — Broadcast.Swapped* legs folded per originating extrinsic
//               (route hops share one extrinsic: first input, last output);
//               block-initialization swaps (DCA executions) fold per swapper.
//   transfers — Balances/Tokens.Transfer, suppressed when their extrinsic
//               also swapped, or performed any other action the finalized
//               classifier owns (those transfers are that action's plumbing).
//   money mkt — Supply/Withdraw/Borrow/Repay/LiquidationCall, read from the
//               Aave log the EVM emits (see AAVE_LOG_TOPICS).
//   cross-ch  — outbound XCM, where the message's own amounts identify which
//               of the extrinsic's withdrawals is the transfer.
// Everything else (liquidity, staking, votes, OTC) waits for finality and the
// real classifier. Rows are marked unfinalized upstream and may reorg away.

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
export interface PendingMmActivity {
  kind: 'mm'
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  action: PendingMmLeg['action']
  assetAddress: string
  amount: string
  who: string
}
export interface PendingXcmActivity {
  kind: 'xcm'
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  who: string
  assetId: number
  amount: string
  destParaId: number | null
}
export type PendingActivity = PendingTradeActivity | PendingTransferActivity | PendingMmActivity | PendingXcmActivity

// Pallets whose events mean "this extrinsic performs a classified action, and
// its Transfer events are that action's plumbing". A GIGAHDX stake or reward
// claim, for instance, moves the tokens with real Balances/Tokens.Transfer
// events and is rendered by the finalized classifier as one GIGAHDX row with
// those legs suppressed. Reading them here as plain transfers publishes a claim
// finality then contradicts — the row appears to be "from the GIGAHDX Pot to
// someone" and is replaced a few seconds later by a staking row.
//
// Under-showing is the right error for this layer: a suppressed row simply
// appears at finality, which reads as data arriving, while a wrong row reads as
// data disappearing. `evm` is on the list for the same reason — money-market
// actions are EVM-driven and their transfer legs are suppressed downstream —
// at the cost of a plain ERC-20 transfer waiting for finality to show up.
const CLASSIFIED_ACTION_PALLETS = new Set([
  'gigahdx', 'gigahdxrewards', 'staking', 'collatorrewards',   // staking family
  'omnipool', 'stableswap', 'xyk', 'lbp',                      // liquidity
  'otc', 'dca', 'referrals',
  'xtokens', 'polkadotxcm', 'xcmpqueue',                       // cross-chain
  'convictionvoting', 'democracy',                             // votes
  'evm',                                                       // money market + contracts
])
// Substrate derives a pallet's own account from the bytes `modl` + its pallet
// id, so an actor whose account starts with those bytes is the protocol moving
// its own funds — never a person whose activity is worth a row.
export function isPalletPot(account: string): boolean {
  return account.toLowerCase().startsWith('0x6d6f646c')
}

export function isClassifiedAction(eventName: string): boolean {
  const pallet = eventName.slice(0, eventName.indexOf('.'))
  return pallet !== '' && CLASSIFIED_ACTION_PALLETS.has(pallet.toLowerCase())
}

export function buildPendingActivities(block: PendingBlock): PendingActivity[] {
  const swapGroups = new Map<string, PendingEventRow[]>()
  const swapExtrinsics = new Set<number>()
  // Which classified-action pallets each extrinsic touched. A row this layer
  // publishes must be the extrinsic's OWN action, so each family asks the same
  // question — "did this extrinsic also do something else the finalized
  // classifier owns?" — while ignoring the pallet its own reading comes from.
  const actionPallets = new Map<number, Set<string>>()
  for (const e of block.events) {
    if (e.extrinsicIndex == null || !isClassifiedAction(e.name)) continue
    const pallet = e.name.slice(0, e.name.indexOf('.')).toLowerCase()
    const set = actionPallets.get(e.extrinsicIndex) ?? new Set<string>()
    set.add(pallet)
    actionPallets.set(e.extrinsicIndex, set)
  }
  const actionExtrinsics = new Set(actionPallets.keys())
  // True when the extrinsic performs a classified action OTHER than the ones
  // named — i.e. other than the family currently being read.
  const actsBeyond = (extrinsicIndex: number | null, own: string[]): boolean => {
    if (extrinsicIndex == null) return false
    const pallets = actionPallets.get(extrinsicIndex)
    if (!pallets) return false
    for (const p of pallets) if (!own.includes(p)) return true
    return false
  }
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

  // Money market: one row per Aave log — but only when the log describes
  // somebody LENDING, which most of them do not. A routed swap travels through
  // the money market and emits Supply/Withdraw on the way: in a 10-minute live
  // sample every single money-market log belonged to `modlrouterex`, the
  // Router's own pot, and the finalized classifier folds each into the trade it
  // is part of. Publishing them as lends invented 20 lends nobody made, and
  // they vanished at finality. Two rules keep the row honest: the actor must
  // not be a pallet pot, and the extrinsic must not also be a swap.
  for (const e of block.events) {
    if (!e.mm) continue
    if (isPalletPot(e.mm.who)) continue
    if (e.extrinsicIndex != null && swapExtrinsics.has(e.extrinsicIndex)) continue
    if (e.extrinsicIndex == null && initSwappers.size > 0) continue
    // A GIGAHDX stake supplies into the money market to implement itself, and
    // the finalized classifier calls the whole extrinsic a stake. Observed
    // live: an `Evm.Log` Supply of asset 670 that settled as one staking row.
    // So a money-market leg is only somebody's lend when lending is all the
    // extrinsic did — 'evm' is excluded from the test because it IS this
    // reading's own source.
    if (actsBeyond(e.extrinsicIndex, ['evm'])) continue
    out.push({
      kind: 'mm',
      blockHeight: block.height,
      timestamp: block.timestamp,
      eventIndex: e.eventIndex,
      extrinsicIndex: e.extrinsicIndex,
      action: e.mm.action,
      assetAddress: e.mm.assetAddress,
      amount: e.mm.amount,
      who: e.mm.who,
    })
  }

  // Outbound cross-chain: the message names the amounts it carries, and the
  // extrinsic's Withdrawn events say which asset each amount was. Only an
  // unambiguous pairing becomes a row — an XCM whose legs cannot be matched is
  // left to the finalized classifier rather than guessed at.
  for (const e of block.events) {
    if (!e.xcm) continue
    const withdrawals = block.events.filter(w =>
      w.withdrawn && w.extrinsicIndex === e.extrinsicIndex)
    const named = withdrawals.filter(w =>
      e.xcm!.amounts.includes(w.withdrawn!.amount) && !e.xcm!.feeAmounts.includes(w.withdrawn!.amount))
    // One leg named by the message wins; failing that, an extrinsic with a
    // single withdrawal is unambiguous on its own.
    const leg = named.length === 1 ? named[0] : withdrawals.length === 1 ? withdrawals[0] : null
    if (!leg?.withdrawn) continue
    // Same rule as the money market: a pot sending cross-chain is the protocol
    // rebalancing itself, not activity a reader is looking for.
    if (isPalletPot(leg.withdrawn.who)) continue
    // ...and a send that is part of some other classified action belongs to
    // that action, not to a cross-chain row of its own.
    if (actsBeyond(e.extrinsicIndex, ['xtokens', 'polkadotxcm', 'xcmpqueue'])) continue
    out.push({
      kind: 'xcm',
      blockHeight: block.height,
      timestamp: block.timestamp,
      eventIndex: e.eventIndex,
      extrinsicIndex: e.extrinsicIndex,
      who: leg.withdrawn.who,
      assetId: leg.withdrawn.assetId,
      amount: leg.withdrawn.amount,
      destParaId: e.xcm.destParaId,
    })
  }

  for (const e of block.events) {
    if (!e.transfer) continue
    if (e.extrinsicIndex != null && (swapExtrinsics.has(e.extrinsicIndex) || actionExtrinsics.has(e.extrinsicIndex))) continue
    if (e.extrinsicIndex == null && (initSwappers.has(e.transfer.from) || initSwappers.has(e.transfer.to))) continue
    // A transfer somebody MADE is signed. An unanchored one is the chain moving
    // funds in a hook — fee sweeps, scheduler payouts, the internals of a
    // block-initialization swap — and a pot on either end says the same thing.
    // Measured against the finalized feed: 199 of 200 settled transfer rows are
    // extrinsic-anchored with no pot on either side, while 283 of 305 rows this
    // layer produced had a pot as SENDER (modlfeeproc/, modlomnipool,
    // modlrouterex) and matched no settled row at all. Those rows appeared for
    // a few seconds and vanished at finality, which is precisely the "it
    // disappeared" a reader reports.
    if (e.extrinsicIndex == null) continue
    if (isPalletPot(e.transfer.from) || isPalletPot(e.transfer.to)) continue
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

// Mempool activity rows: the same folding/suppression classifier run over a
// transaction's DRY-RUN projected events (see pendingHeadService.syncMempool).
// A failing or unprojectable transaction yields no activity row — it still
// lists in the extrinsics feed; only judged, evented projections make claims.
export interface MempoolActivityInput {
  hash: string
  firstSeen: string
  success: boolean | null
  events: PendingEventRow[]
}
export function buildMempoolActivities(txs: MempoolActivityInput[]): (PendingActivity & { hash: string })[] {
  const out: (PendingActivity & { hash: string })[] = []
  for (const tx of txs) {
    if (tx.success !== true || !tx.events.length) continue
    const synthetic: PendingBlock = {
      height: 0, hash: tx.hash, parentHash: '', timestamp: tx.firstSeen, specVersion: 0,
      extrinsics: [],
      // All projected events belong to this one transaction — anchor them to a
      // synthetic extrinsic so the per-extrinsic folding and transfer
      // suppression apply exactly as they do inside a block.
      events: tx.events.map(e => ({ ...e, extrinsicIndex: 0 })),
    }
    for (const a of buildPendingActivities(synthetic)) out.push({ ...a, hash: tx.hash })
  }
  return out
}
