import type { GovernanceStats } from '../governanceTypes'

// Pure helpers behind the hub's Stats view: raw HDX for drawing and the Stats
// ribbon's figures.

/** Raw HDX (12 decimals) as a whole-HDX number, for drawing only (the figures shown use the raw value). */
export function hdxNumber(raw: string | null | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) return 0
  const v = BigInt(raw)
  return Number(v / 1_000_000n) / 1_000_000
}

/** The newest calendar month that has fully ended (UTC), as 'YYYY-MM'. */
export function lastFullMonth(nowMs: number): string {
  const d = new Date(nowMs)
  const y = d.getUTCMonth() === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear()
  const m = d.getUTCMonth() === 0 ? 12 : d.getUTCMonth()
  return `${y}-${String(m).padStart(2, '0')}`
}

/** Approved over decided (approved + rejected) across every track; null before any decision. */
export function overallPassRate(tracks: GovernanceStats['tracks']): { rate: number | null; approved: number; decided: number } {
  const approved = tracks.reduce((t, x) => t + x.approved, 0)
  const decided = approved + tracks.reduce((t, x) => t + x.rejected, 0)
  return { rate: decided ? approved / decided : null, approved, decided }
}

/** "Mar 2025" for a 'YYYY-MM' month key. */
export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return names[(m || 1) - 1] ? `${names[m - 1]} ${y}` : key
}
