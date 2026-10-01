import type { ActivityRow, FailureReason } from '../types'

// Why an extrinsic's Activity tab is empty, when the extrinsic itself says so —
// otherwise null, and the table keeps its plain "No activity". A bare empty state
// under a green SUCCESS badge read as missing data when nothing had happened at all:
// a multisig that executed a call which then failed, a cancellation, an approval
// still waiting for the rest of the signatories.
export function emptyActivityReason(detail: {
  success: boolean
  events: readonly { name: string }[]
  innerErrorReason?: FailureReason | null
}): string | null {
  if (detail.innerErrorReason) return `Nothing happened: the dispatched call failed (${detail.innerErrorReason.label}).`
  if (!detail.success) return 'Nothing happened: the extrinsic failed.'
  const has = (name: string) => detail.events.some(e => e.name === name)
  if (has('Multisig.MultisigCancelled')) return 'This cancelled a pending multisig operation; nothing else happened.'
  if ((has('Multisig.NewMultisig') || has('Multisig.MultisigApproval')) && !has('Multisig.MultisigExecuted')) {
    return 'A multisig approval: the operation runs once enough signatories approve.'
  }
  return null
}

/** The ICE solver's settlement pot (`modl` + `ice_ice#`). */
export const ICE_POT_ACCOUNT_ID = '0x6d6f646c6963655f696365230000000000000000000000000000000000000000'

/**
 * The block and extrinsic lists without the ICE pot's settlement trades — the API's
 * own fold for every feed (suppressIcePotSettlementTrades), applied to the two pages
 * that receive them unfolded. Inside a solution the pot's AMM trades are how the
 * fills were produced, the same value a second time, so a list showing both read as
 * three trades where one intent filled. They stay in the API for the extrinsic's ICE
 * panel, which lists them as the solution's routing, and for each trade's own page;
 * the pot's account page keeps them too. A pot trade in an extrinsic with no intent
 * row (none has happened) is kept.
 */
export function foldIcePotTrades<T extends Pick<ActivityRow, 'type' | 'blockHeight' | 'extrinsicIndex' | 'who'>>(rows: readonly T[]): T[] {
  const solved = new Set(rows.filter(r => r.type === 'intent' && r.extrinsicIndex != null).map(r => `${r.blockHeight}:${r.extrinsicIndex}`))
  if (!solved.size) return [...rows]
  return rows.filter(r => !(r.type === 'trade' && r.extrinsicIndex != null && r.who?.accountId.toLowerCase() === ICE_POT_ACCOUNT_ID
    && solved.has(`${r.blockHeight}:${r.extrinsicIndex}`)))
}
