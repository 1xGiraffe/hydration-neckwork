import type { AccountDeposits, PreimageDeposit, ReferendumDeposit } from '../../governanceTypes'
import type { CartAction } from '../../vote/voteBus'

// What a governance deposit is now and what can be signed about it, in one place for
// the referendum page and the account's Deposits list. The states are the api's
// (governanceDeposits.ts, the pallet's own rules); refunds are anyone's to sign and
// pay the depositor, an unnote only its owner's.

const KIND_WORD: Record<ReferendumDeposit['kind'], string> = { submission: 'Submission', decision: 'Decision' }

/** "Submission deposit", "Decision deposit". */
export function depositName(d: Pick<ReferendumDeposit, 'kind'>): string {
  return `${KIND_WORD[d.kind]} deposit`
}

/** The state in words: what happened to it, or what can happen next. */
export function depositStateWord(d: Pick<ReferendumDeposit, 'state'>): string {
  switch (d.state) {
    case 'held': return 'held until it concludes'
    case 'refundable': return 'refundable'
    case 'refunded': return 'refunded'
    case 'kept': return 'kept by the chain'
    case 'slashed': return 'slashed'
  }
}

/** The refund a refundable referendum deposit offers, as a cart action; null otherwise. */
export function depositRefund(d: ReferendumDeposit): CartAction | null {
  if (d.state !== 'refundable') return null
  return {
    kind: d.kind === 'decision' ? 'refund-decision-deposit' : 'refund-submission-deposit',
    index: d.index,
    label: `Refund the ${d.kind} deposit of #${d.index}`,
    amount: d.amount,
  }
}

/** "0x83e8…0cb0" */
export function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash
}

/** The unnote a refundable preimage deposit offers (its owner's to sign); null otherwise. */
export function preimageRefund(p: PreimageDeposit): CartAction | null {
  if (!p.refundable) return null
  return { kind: 'unnote-preimage', hash: p.hash, owner: p.owner, label: `Refund the preimage deposit ${shortHash(p.hash)}`, amount: p.amount }
}

/** Placing a running referendum's decision deposit (paid by whoever signs). */
export function placeDecisionDeposit(index: number, amount: string | null): CartAction {
  return { kind: 'place-decision-deposit', index, label: `Place the decision deposit of #${index}`, amount }
}

/**
 * Everything "Refund all" signs at once: every refundable referendum deposit, and the
 * refundable preimage deposits when one account owns them all (an unnote is its
 * owner's alone, so preimages of several owners cannot share one signature).
 */
export function refundAll(d: AccountDeposits): CartAction[] {
  const refs = d.referenda.map(depositRefund).filter((a): a is CartAction => !!a)
  const pre = (d.preimages ?? []).map(preimageRefund).filter((a): a is CartAction => !!a)
  const owners = new Set(pre.map(a => a.owner))
  return owners.size <= 1 ? [...refs, ...pre] : refs
}

/** The raw HDX a list of actions moves. */
export function actionsTotal(items: CartAction[]): bigint {
  return items.reduce((t, a) => t + BigInt(a.amount ?? '0'), 0n)
}

/**
 * What the account's deposits hold apart from what the chain keeps for good (a
 * rejected or timed-out referendum's submission deposit), and that kept part. An
 * api that sends no `kept` counted it inside `held`, so it is taken out here.
 */
export function heldAndKept(d: AccountDeposits): { held: bigint; kept: bigint } {
  if (d.totals.kept != null) return { held: BigInt(d.totals.held), kept: BigInt(d.totals.kept) }
  const kept = d.referenda.filter(r => r.state === 'kept').reduce((t, r) => t + BigInt(r.amount), 0n)
  const held = BigInt(d.totals.held) - kept
  return { held: held > 0n ? held : 0n, kept }
}
