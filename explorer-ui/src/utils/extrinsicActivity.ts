import type { FailureReason } from '../types'

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
