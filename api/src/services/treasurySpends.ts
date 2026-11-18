// The Treasury's spends and proposals, folded from its own events (treasury_events, an
// MV over raw_events). A pure module: the explorer's treasury read model and the Data
// API both fold with it, so they cannot disagree about a spend's state.
//
// Hydration's Treasury pays HDX only (`AssetKind = ()`, so AssetSpendApproved carries no
// asset) and its paymaster pays synchronously from the treasury account. A spend
// approved by `treasury.spend` (AssetSpendApproved{index, amount, beneficiary,
// validFrom, expireAt}) is paid by anyone's `payout(index)` once `validFrom` has passed
// and before `expireAt` (Paid); `check_status(index)` then removes it from storage
// (SpendProcessed, fee refunded) — and removes an unpaid one once it has expired. A
// failed payment (PaymentFailed) can be paid out again. `void_spend` (AssetSpendVoided)
// cancels a spend nobody has paid yet. The older `spend_local` (SpendApproved) and the
// pre-OpenGov proposals (Proposed, then Awarded or Rejected) are paid by the treasury
// itself at its next spend period (Awarded), never claimed.

export type SpendState = 'pending' | 'claimable' | 'paid' | 'failed' | 'expired' | 'voided'

export interface TreasuryEventRow {
  event_name: string
  block_height: number
  event_index: number
  extrinsic_index: number | null
  ts: string
  args_json: string
}

export interface EventAt { blockHeight: number; extrinsicIndex: number | null; timestamp: string }

export interface SpendFold {
  index: number
  /** Raw HDX (12 decimals). */
  amount: string
  /** The beneficiary's account id (hex), as the event states it. */
  beneficiary: string | null
  validFrom: number | null
  /** As approved; a payout re-dates it in storage (now + the payout period). */
  expireAt: number | null
  approvedAt: EventAt
  paidAt: EventAt | null
  failedAt: EventAt | null
  /** check_status removed it from storage (paid, or expired unpaid). */
  processedAt: EventAt | null
  voidedAt: EventAt | null
  state: SpendState
  /** Anyone may sign payout(index) now (the dry-run is the final word). */
  canPayout: boolean
  /** Anyone may sign check_status(index) now: it would clear the spend from storage. */
  canCheckStatus: boolean
}

export type ProposalState = 'proposed' | 'approved' | 'awarded' | 'rejected'

export interface ProposalFold {
  index: number
  amount: string | null
  beneficiary: string | null
  /** 'spend_local' when OpenGov approved it directly (SpendApproved), 'proposal' for a pre-OpenGov treasury proposal. */
  origin: 'spend_local' | 'proposal'
  proposedAt: EventAt
  awardedAt: EventAt | null
  rejectedAt: EventAt | null
  state: ProposalState
}

function parse(json: string): Record<string, unknown> {
  try { return JSON.parse(json) as Record<string, unknown> } catch { return {} }
}

function isoOf(chTs: string): string {
  const t = Date.parse(chTs.includes('T') ? chTs : `${chTs.replace(' ', 'T')}Z`)
  return Number.isFinite(t) ? new Date(t).toISOString() : chTs
}

const at = (r: TreasuryEventRow): EventAt => ({ blockHeight: r.block_height, extrinsicIndex: r.extrinsic_index, timestamp: isoOf(r.ts) })
const intOf = (v: unknown): number | null => (Number.isInteger(Number(v)) && v !== null && v !== '' ? Number(v) : null)
const rawOf = (v: unknown): string | null => (typeof v === 'string' && /^\d+$/.test(v) ? v : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : null)
const accountOf = (v: unknown): string | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : null)

/**
 * Fold the treasury's events (in block, event order) into its spends and proposals, as
 * they stand at `headBlock`. The next block is the one a signed call would execute in,
 * so the windows are judged against it: payout needs validFrom ≤ it < expireAt,
 * check_status on an unpaid spend needs it > expireAt.
 */
export function foldTreasury(rows: TreasuryEventRow[], headBlock: number): { spends: SpendFold[]; proposals: ProposalFold[] } {
  const spends = new Map<number, SpendFold>()
  const proposals = new Map<number, ProposalFold>()
  const sorted = [...rows].sort((a, b) => a.block_height - b.block_height || a.event_index - b.event_index)
  for (const r of sorted) {
    const a = parse(r.args_json)
    switch (r.event_name) {
      case 'Treasury.AssetSpendApproved': {
        const index = intOf(a.index)
        const amount = rawOf(a.amount)
        if (index == null || amount == null) break
        spends.set(index, {
          index, amount, beneficiary: accountOf(a.beneficiary), validFrom: intOf(a.validFrom), expireAt: intOf(a.expireAt),
          approvedAt: at(r), paidAt: null, failedAt: null, processedAt: null, voidedAt: null,
          state: 'pending', canPayout: false, canCheckStatus: false,
        })
        break
      }
      case 'Treasury.Paid': { const s = spends.get(intOf(a.index) ?? -1); if (s) { s.paidAt = at(r); s.failedAt = null } break }
      case 'Treasury.PaymentFailed': { const s = spends.get(intOf(a.index) ?? -1); if (s) s.failedAt = at(r); break }
      case 'Treasury.SpendProcessed': { const s = spends.get(intOf(a.index) ?? -1); if (s) s.processedAt = at(r); break }
      case 'Treasury.AssetSpendVoided': { const s = spends.get(intOf(a.index) ?? -1); if (s) s.voidedAt = at(r); break }
      case 'Treasury.Proposed': {
        const index = intOf(a.proposalIndex)
        if (index == null || proposals.has(index)) break
        proposals.set(index, { index, amount: null, beneficiary: null, origin: 'proposal', proposedAt: at(r), awardedAt: null, rejectedAt: null, state: 'proposed' })
        break
      }
      case 'Treasury.SpendApproved': {
        const index = intOf(a.proposalIndex)
        if (index == null) break
        const p = proposals.get(index)
        if (p) { p.amount = rawOf(a.amount) ?? p.amount; p.beneficiary = accountOf(a.beneficiary) ?? p.beneficiary; p.state = 'approved' }
        else proposals.set(index, { index, amount: rawOf(a.amount), beneficiary: accountOf(a.beneficiary), origin: 'spend_local', proposedAt: at(r), awardedAt: null, rejectedAt: null, state: 'approved' })
        break
      }
      case 'Treasury.Awarded': {
        const index = intOf(a.proposalIndex)
        if (index == null) break
        const p = proposals.get(index) ?? { index, amount: null, beneficiary: null, origin: 'proposal' as const, proposedAt: at(r), awardedAt: null, rejectedAt: null, state: 'proposed' as ProposalState }
        p.amount = rawOf(a.award) ?? p.amount
        p.beneficiary = accountOf(a.account) ?? p.beneficiary
        p.awardedAt = at(r)
        p.state = 'awarded'
        proposals.set(index, p)
        break
      }
      case 'Treasury.Rejected': {
        const p = proposals.get(intOf(a.proposalIndex) ?? -1)
        if (p) { p.rejectedAt = at(r); p.state = 'rejected' }
        break
      }
    }
  }
  const next = headBlock + 1
  for (const s of spends.values()) {
    const started = s.validFrom == null || s.validFrom <= next
    const lapsed = s.expireAt != null && next >= s.expireAt
    if (s.voidedAt) s.state = 'voided'
    else if (s.paidAt && !s.failedAt) s.state = 'paid'
    else if (s.processedAt) s.state = 'expired'
    else if (lapsed) s.state = 'expired'
    else if (s.failedAt) s.state = 'failed'
    else s.state = started ? 'claimable' : 'pending'
    s.canPayout = !s.processedAt && !s.voidedAt && (s.state === 'claimable' || s.state === 'failed')
    // A paid spend waits for check_status to clear it; an unpaid one can be cleared once expired.
    s.canCheckStatus = !s.processedAt && !s.voidedAt && (s.state === 'paid' || (s.state === 'expired' && s.expireAt != null && next > s.expireAt))
  }
  return {
    spends: [...spends.values()].sort((a, b) => b.index - a.index),
    proposals: [...proposals.values()].sort((a, b) => b.index - a.index),
  }
}
