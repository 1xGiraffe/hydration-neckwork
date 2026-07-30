// Reconstructs account-first economic ownership intervals for Omnipool positions from
// their NFT + liquidity-mining lifecycle events. Pure and deterministic so it can be
// unit-tested and re-run idempotently by the checkpointed builder job. See
// docs/superpowers/specs/2026-07-17-lp-value-history-phase1-omnipool-design.md.
//
// Ownership model (verified against raw_events): a position is owned "bare" while its
// collection-1337 NFT is held by a real account, and "farmed" while its collection-2584
// deposit NFT is held (the 1337 NFT then sits with the LM pallet). The economic owner is
// conserved across the bare<->farmed handoff; the LM pallet is never an economic owner.
// A deposit maps to exactly one position; a redeposit adds a yield-farm relation to the
// same deposit and must not open a second interval. Omnipool SharesWithdrawn does not
// change principal or ownership on its own (the deposit persists until destroyed), so it
// is intentionally not an interval boundary.

export const LM_PALLET_ACCOUNT = '0x6d6f646c4f6d6e692f2f4c4d0000000000000000000000000000000000000000'

export type OwnerLifecycleKind =
  | 'nft_issue'
  | 'nft_transfer'
  | 'nft_burn'
  | 'shares_deposited'
  | 'shares_redeposited'
  | 'shares_withdrawn'
  | 'deposit_destroyed'
  | 'position_destroyed'

export interface OwnerLifecycleEvent {
  kind: OwnerLifecycleKind
  collection?: '1337' | '2584'
  item?: string
  positionId?: string
  depositId?: string
  owner?: string
  from?: string
  to?: string
  block: number
  extrinsic: number | null
  event: number
  ts: number
}

export interface OrderPoint {
  block: number
  extrinsic: number | null
  event: number
  ts: number
}

export interface OwnerIntervalBound {
  block: number
  extrinsic: number | null
  event: number
}

export interface OwnerInterval {
  accountId: string
  positionId: string
  ownershipKind: 'bare' | 'farmed'
  depositId: string
  validFrom: OrderPoint
  validTo: OwnerIntervalBound | null
  sourceEventKind: string
}

interface OpenState {
  accountId: string
  kind: 'bare' | 'farmed'
  depositId: string
  from: OrderPoint
  sourceEventKind: string
}

interface DesiredOwner {
  account: string
  kind: 'bare' | 'farmed'
  depositId: string
}

function compareEvents(a: OwnerLifecycleEvent, b: OwnerLifecycleEvent): number {
  if (a.block !== b.block) return a.block - b.block
  const ax = a.extrinsic ?? -1
  const bx = b.extrinsic ?? -1
  if (ax !== bx) return ax - bx
  return a.event - b.event
}

const norm = (a?: string): string => (a ?? '').toLowerCase()

export function buildOmnipoolOwnerIntervals(events: OwnerLifecycleEvent[]): OwnerInterval[] {
  const sorted = [...events].sort(compareEvents)

  const depositToPosition = new Map<string, string>()
  const deposit2584Holder = new Map<string, string | null>()
  const bareHolder = new Map<string, string | null>()
  const activeDeposit = new Map<string, string | null>()
  const open = new Map<string, OpenState | null>()
  const out: OwnerInterval[] = []

  function econOwnerFor(positionId: string): DesiredOwner | null {
    const depId = activeDeposit.get(positionId) ?? null
    if (depId) {
      const holder = deposit2584Holder.get(depId) ?? null
      if (holder && holder !== LM_PALLET_ACCOUNT) return { account: holder, kind: 'farmed', depositId: depId }
    }
    const bare = bareHolder.get(positionId) ?? null
    if (bare && bare !== LM_PALLET_ACCOUNT) return { account: bare, kind: 'bare', depositId: '' }
    return null
  }

  function recompute(positionId: string, at: OrderPoint, sourceEventKind: string): void {
    const desired = econOwnerFor(positionId)
    const cur = open.get(positionId) ?? null
    const same = !!cur && !!desired
      && cur.accountId === desired.account
      && cur.kind === desired.kind
      && cur.depositId === desired.depositId
    if (same) return
    if (cur) {
      out.push({
        accountId: cur.accountId,
        positionId,
        ownershipKind: cur.kind,
        depositId: cur.depositId,
        validFrom: cur.from,
        validTo: { block: at.block, extrinsic: at.extrinsic, event: at.event },
        sourceEventKind: cur.sourceEventKind,
      })
      open.set(positionId, null)
    }
    if (desired) {
      open.set(positionId, {
        accountId: desired.account,
        kind: desired.kind,
        depositId: desired.depositId,
        from: at,
        sourceEventKind,
      })
    }
  }

  for (const e of sorted) {
    const at: OrderPoint = { block: e.block, extrinsic: e.extrinsic, event: e.event, ts: e.ts }
    switch (e.kind) {
      case 'nft_issue': {
        if (e.collection === '1337' && e.item) {
          bareHolder.set(e.item, norm(e.owner))
          recompute(e.item, at, 'nft_issue_1337')
        } else if (e.collection === '2584' && e.item) {
          deposit2584Holder.set(e.item, norm(e.owner))
          const p = depositToPosition.get(e.item)
          if (p) recompute(p, at, 'nft_issue_2584')
        }
        break
      }
      case 'nft_transfer': {
        if (e.collection === '1337' && e.item) {
          bareHolder.set(e.item, norm(e.to))
          recompute(e.item, at, 'nft_transfer_1337')
        } else if (e.collection === '2584' && e.item) {
          deposit2584Holder.set(e.item, norm(e.to))
          const p = depositToPosition.get(e.item)
          if (p) recompute(p, at, 'nft_transfer_2584')
        }
        break
      }
      case 'nft_burn': {
        if (e.collection === '1337' && e.item) {
          bareHolder.set(e.item, null)
          recompute(e.item, at, 'nft_burn_1337')
        } else if (e.collection === '2584' && e.item) {
          deposit2584Holder.set(e.item, null)
          const p = depositToPosition.get(e.item)
          if (p) {
            if (activeDeposit.get(p) === e.item) activeDeposit.set(p, null)
            recompute(p, at, 'nft_burn_2584')
          }
        }
        break
      }
      case 'shares_deposited':
      case 'shares_redeposited': {
        const d = e.depositId
        const p = e.positionId
        if (!d || !p) break
        depositToPosition.set(d, p)
        activeDeposit.set(p, d)
        if (!deposit2584Holder.has(d)) deposit2584Holder.set(d, norm(e.owner))
        recompute(p, at, e.kind)
        break
      }
      case 'deposit_destroyed': {
        const d = e.depositId
        if (!d) break
        deposit2584Holder.set(d, null)
        const p = depositToPosition.get(d)
        if (p) {
          if (activeDeposit.get(p) === d) activeDeposit.set(p, null)
          recompute(p, at, 'deposit_destroyed')
        }
        break
      }
      case 'position_destroyed': {
        const p = e.positionId
        if (!p) break
        bareHolder.set(p, null)
        activeDeposit.set(p, null)
        recompute(p, at, 'position_destroyed')
        break
      }
      case 'shares_withdrawn':
        // Omnipool: not an ownership/principal boundary (the deposit persists until
        // destroyed). Intentionally ignored.
        break
    }
  }

  for (const [positionId, state] of open) {
    if (!state) continue
    out.push({
      accountId: state.accountId,
      positionId,
      ownershipKind: state.kind,
      depositId: state.depositId,
      validFrom: state.from,
      validTo: null,
      sourceEventKind: state.sourceEventKind,
    })
  }

  out.sort((a, b) => {
    if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1
    if (a.positionId !== b.positionId) return a.positionId < b.positionId ? -1 : 1
    if (a.validFrom.block !== b.validFrom.block) return a.validFrom.block - b.validFrom.block
    return a.validFrom.event - b.validFrom.event
  })

  return out
}
