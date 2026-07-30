// Reconstructs account-first ownership intervals for XYK farm deposits (collection 5389)
// from their NFT + liquidity-mining lifecycle. Pure and deterministic for unit testing and
// idempotent re-runs. Verified against raw_events (Phase 2 design doc):
//   - collection 5389 NFT is the deposit; its owner is the economic owner throughout
//     (unlike Omnipool there is no separate "bare" NFT — direct XYK LP is a fungible balance).
//   - XYKLiquidityMining.SharesDeposited{lpToken,amount} sets the principal (once).
//   - SharesRedeposited restates the SAME amount for another yield farm — association, never
//     new principal — and must not open a second interval.
//   - The deposit persists until DepositDestroyed / 5389 burn (SharesWithdrawn from one yield
//     farm is not a boundary), so those end the interval.

import type { OrderPoint, OwnerIntervalBound } from './omnipoolOwnerIntervals.ts'

export type XykFarmLifecycleKind =
  | 'nft_issue'
  | 'nft_transfer'
  | 'nft_burn'
  | 'shares_deposited'
  | 'shares_redeposited'
  | 'deposit_destroyed'

export interface XykFarmLifecycleEvent {
  kind: XykFarmLifecycleKind
  depositId: string
  owner?: string
  from?: string
  to?: string
  lpAssetId?: number
  principalShares?: string
  block: number
  extrinsic: number | null
  event: number
  ts: number
}

export interface XykFarmInterval {
  accountId: string
  depositId: string
  lpAssetId: number
  principalShares: string
  validFrom: OrderPoint
  validTo: OwnerIntervalBound | null
  sourceEventKind: string
}

interface Principal { lpAssetId: number; principalShares: string }
interface OpenState { accountId: string; from: OrderPoint; sourceEventKind: string }

function compareEvents(a: XykFarmLifecycleEvent, b: XykFarmLifecycleEvent): number {
  if (a.block !== b.block) return a.block - b.block
  const ax = a.extrinsic ?? -1
  const bx = b.extrinsic ?? -1
  if (ax !== bx) return ax - bx
  return a.event - b.event
}

const norm = (a?: string): string => (a ?? '').toLowerCase()

export function buildXykFarmIntervals(events: XykFarmLifecycleEvent[]): XykFarmInterval[] {
  const sorted = [...events].sort(compareEvents)

  const holder = new Map<string, string | null>()
  const principal = new Map<string, Principal>()
  const open = new Map<string, OpenState | null>()
  const out: XykFarmInterval[] = []

  function recompute(depositId: string, at: OrderPoint, sourceEventKind: string): void {
    const owner = holder.get(depositId) ?? null
    const prin = principal.get(depositId)
    const desiredAccount = owner && prin ? owner : null
    const cur = open.get(depositId) ?? null
    if ((cur?.accountId ?? null) === desiredAccount) return
    if (cur && prin) {
      out.push({
        accountId: cur.accountId,
        depositId,
        lpAssetId: prin.lpAssetId,
        principalShares: prin.principalShares,
        validFrom: cur.from,
        validTo: { block: at.block, extrinsic: at.extrinsic, event: at.event },
        sourceEventKind: cur.sourceEventKind,
      })
      open.set(depositId, null)
    }
    if (desiredAccount) open.set(depositId, { accountId: desiredAccount, from: at, sourceEventKind })
  }

  for (const e of sorted) {
    const at: OrderPoint = { block: e.block, extrinsic: e.extrinsic, event: e.event, ts: e.ts }
    switch (e.kind) {
      case 'nft_issue':
        holder.set(e.depositId, norm(e.owner))
        recompute(e.depositId, at, 'nft_issue_5389')
        break
      case 'nft_transfer':
        holder.set(e.depositId, norm(e.to))
        recompute(e.depositId, at, 'nft_transfer_5389')
        break
      case 'nft_burn':
        holder.set(e.depositId, null)
        recompute(e.depositId, at, 'nft_burn_5389')
        break
      case 'shares_deposited':
      case 'shares_redeposited':
        // Principal is fixed by the first deposit; redeposit restates the same amount.
        if (!principal.has(e.depositId) && e.lpAssetId != null && e.principalShares != null) {
          principal.set(e.depositId, { lpAssetId: e.lpAssetId, principalShares: e.principalShares })
        }
        recompute(e.depositId, at, e.kind)
        break
      case 'deposit_destroyed':
        holder.set(e.depositId, null)
        recompute(e.depositId, at, 'deposit_destroyed')
        break
    }
  }

  for (const [depositId, state] of open) {
    if (!state) continue
    const prin = principal.get(depositId)
    if (!prin) continue
    out.push({
      accountId: state.accountId,
      depositId,
      lpAssetId: prin.lpAssetId,
      principalShares: prin.principalShares,
      validFrom: state.from,
      validTo: null,
      sourceEventKind: state.sourceEventKind,
    })
  }

  out.sort((a, b) => {
    if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1
    if (a.depositId !== b.depositId) return a.depositId < b.depositId ? -1 : 1
    if (a.validFrom.block !== b.validFrom.block) return a.validFrom.block - b.validFrom.block
    return a.validFrom.event - b.validFrom.event
  })

  return out
}
