import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { review } from './chainWrite'
import type { TxStage, WritePlan } from './chainWrite'

/** A stable key for a plan, so the review re-runs exactly when the transaction would change. */
export function planKey(plan: WritePlan | null): string {
  if (!plan) return ''
  return JSON.stringify({ s: plan.signerId, w: plan.signer.id, p: plan.proxy, v: plan.via?.real ?? null, a: plan.actions, h: !!plan.feeInHdx }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

export function useReview(plan: WritePlan | null, blocked: string | null) {
  const key = useDebounced(planKey(plan), 450)
  const current = planKey(plan)
  const q = useQuery({
    queryKey: ['vote-review', key],
    queryFn: () => review(plan as WritePlan),
    enabled: !!plan && !blocked && key === current && key !== '',
    staleTime: 15_000,
    retry: 0,
  })
  return { ...q, stale: key !== current }
}


/**
 * What a signing attempt's outcome allows next, for the plan it signed. A call that
 * reached a block and went through — final, or included and not yet seen final — is
 * done: signing the same plan again would send the same call a second time (a placed
 * deposit or a paid spend then fails on chain and still costs its fee), so Sign stays
 * off until the plan changes. A call included but failed on chain may be signed again,
 * but only after a fresh dry-run, however recent the review. An attempt that never
 * reached a block (a declined wallet, a node's rejection, a failed final check) leaves
 * the review as it was.
 */
export function signGate(stage: TxStage | null): { busy: boolean; done: boolean; recheck: boolean } {
  if (!stage) return { busy: false, done: false, recheck: false }
  switch (stage.phase) {
    case 'finalized':
    case 'unconfirmed': return { busy: false, done: true, recheck: false }
    case 'failed': return { busy: false, done: false, recheck: stage.blockNumber != null }
    default: return { busy: true, done: false, recheck: false }
  }
}
