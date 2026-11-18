import { useQueryClient } from '@tanstack/react-query'
import type { VoteAction } from './chainWrite'
import type { CartAction } from './voteBus'
import { formatHdx } from './voteMath'

// The cart's non-vote actions as the engine's actions, what to refresh once one of
// them lands (ActionSheet and the vote cart share both), a long list said in one
// sentence, and a list too long for one signature split into several.

export function toVoteAction(a: CartAction): VoteAction {
  switch (a.kind) {
    case 'unnote-preimage': return { kind: 'unnote-preimage', hash: a.hash! }
    default: return { kind: a.kind, index: a.index! }
  }
}

/** Refresh what these actions change: the deposits on the account and referendum pages. */
export function useRefreshAfterActions() {
  const qc = useQueryClient()
  return (items: CartAction[]) => {
    const run = () => {
      void qc.invalidateQueries({ queryKey: ['gov-account'] })
      void qc.invalidateQueries({ queryKey: ['vote-actor'] })
      for (const i of items) if (i.index != null) void qc.invalidateQueries({ queryKey: ['referendum', 'opengov', i.index] })
    }
    run()
    for (const ms of [6_000, 20_000, 60_000]) setTimeout(run, ms)
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const hdxOf = (items: CartAction[]) => formatHdx(items.reduce((t, a) => t + BigInt(a.amount ?? '0'), 0n), 2)

/**
 * A long list of actions as one sentence — "Returns 280 submission deposits
 * (28,000 HDX) and 12 preimage deposits (4,915 HDX) to their owners." — so a sheet
 * signing hundreds says what they come to rather than listing every one first.
 */
export function actionSummary(items: CartAction[]): string {
  const of = (k: CartAction['kind']) => items.filter(a => a.kind === k)
  const parts: string[] = []
  const returns = [
    [of('refund-submission-deposit'), 'submission deposit', 'submission deposits'],
    [of('refund-decision-deposit'), 'decision deposit', 'decision deposits'],
    [of('unnote-preimage'), 'preimage deposit', 'preimage deposits'],
  ] as const
  const back = returns.filter(([xs]) => xs.length).map(([xs, one, many]) => `${plural(xs.length, one, many)} (${hdxOf(xs)} HDX)`)
  if (back.length) parts.push(`returns ${back.length > 1 ? `${back.slice(0, -1).join(', ')} and ${back[back.length - 1]}` : back[0]} to ${items.length === 1 ? 'its owner' : 'their owners'}`)
  const place = of('place-decision-deposit')
  if (place.length) parts.push(`places ${plural(place.length, 'decision deposit', 'decision deposits')} (${hdxOf(place)} HDX)`)
  const s = parts.join('; ')
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}.` : ''
}

/**
 * What one signature's actions move, split by who pays: placed decision deposits are
 * reserved from the account it signs as; refunds and unnotes return deposits to
 * whoever placed them. The two never add up to one figure — a batch placing 100 HDX
 * and refunding 100 HDX reserves 100 HDX, not 200.
 */
export function actionAmounts(items: CartAction[]): { reserved: bigint; returned: bigint } {
  const out = { reserved: 0n, returned: 0n }
  for (const a of items) {
    const v = BigInt(a.amount ?? '0')
    if (a.kind === 'place-decision-deposit') out.reserved += v
    else out.returned += v
  }
  return out
}

/** The most actions one signature carries (a 292-refund batch measured 22% of a block's proof-size budget, ~4.4 KB a refund). */
export const ACTIONS_PER_SIGNATURE = 400

/** Split a long list into signatures of at most `max` actions, signed one after another. */
export function signatureBatches(items: CartAction[], max = ACTIONS_PER_SIGNATURE): CartAction[][] {
  const out: CartAction[][] = []
  for (let i = 0; i < items.length; i += max) out.push(items.slice(i, i + max))
  return out
}
