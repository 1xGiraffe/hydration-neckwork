import type { OracleFeedRow } from '../api/oracles'

/** The feed list shows what is live or read by something; the rest folds behind one line. */
export function splitFeeds(feeds: OracleFeedRow[]): { shown: OracleFeedRow[]; folded: OracleFeedRow[] } {
  const shown: OracleFeedRow[] = [], folded: OracleFeedRow[] = []
  for (const f of feeds) (f.status === 'live' || (f.status === 'stale' && f.consumers.length > 0) ? shown : folded).push(f)
  return { shown, folded }
}
