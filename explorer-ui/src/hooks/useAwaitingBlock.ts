import { useStats } from './useExplorerData'
import { isAwaitingBlock } from '../queryRetry'

/**
 * Is this page's answer missing only because its block has not been indexed?
 *
 * Two signals, both meaning "wait, do not say not-found":
 *  - the API described its 404 as "the block is not in the index yet"
 *    (`queryRetry.ts`), which covers a lookup that answered nothing at all; and
 *  - the block sits above `finalizedBlock`, the boundary the explorer's
 *    finalized index has reached. That covers a miss INSIDE an answer: an
 *    unfinalized block is served from the pending layer, which decodes trades,
 *    transfers, money-market actions and outbound XCM — so a reader who
 *    followed a liquidity, staking, vote or OTC link gets a list that really
 *    does not hold their row yet, and the classifier that will produce it runs
 *    at finality.
 *
 * `missing` is the caller's own verdict: an answer (or failure) has arrived and
 * it does not contain what the URL addressed. While the first request is still
 * in flight the page shows its skeleton, not this.
 */
export function useAwaitingBlock(height: number | null | undefined, missing: boolean, failureReason?: unknown): boolean {
  const enabled = missing && height != null
  const { data: stats } = useStats(enabled)
  if (!enabled) return false
  if (isAwaitingBlock(failureReason, height)) return true
  return stats != null && (height as number) > stats.finalizedBlock
}
