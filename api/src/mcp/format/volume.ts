import type { VolumeKpis, VolumeWindowStat } from '../types.ts'
import { DASH, formatPercent, formatPercentChange, formatUsd } from './units.ts'

// Renderers shared by every tool that states a trading-volume figure (the
// platform dashboard, the asset and pool readings, the account history), so the
// three definitions are worded one way wherever they appear.

/** The explorer's venue wording (`VOLUME_VENUES` order). */
export const VOLUME_VENUE_LABEL: Record<string, string> = {
  omnipool: 'Omnipool', stableswap: 'Stableswap', xyk: 'XYK', uniswapv3: 'Uniswap v3', otc: 'OTC', hsm: 'HSM', lbp: 'LBP',
}

export const venueLabel = (venue: string): string => VOLUME_VENUE_LABEL[venue] ?? venue

export const WINDOW_LABEL = { d1: '24 h', d7: '7 d', d30: '30 d' } as const
export const WINDOW_KEYS = ['d1', 'd7', 'd30'] as const

/** `$1.2M (+5.40% vs the prior 7 d)` — the explorer's `changePct` is a PERCENT. */
export function statWithChange(s: VolumeWindowStat | null | undefined, window: string): string {
  if (!s) return DASH
  const change = s.changePct == null ? 'no prior-period volume to compare' : `${formatPercentChange(s.changePct / 100)} vs the prior ${window}`
  return `${formatUsd(s.volumeUsd)} (${change})`
}

/** Just the change cell. */
export function changeCell(s: VolumeWindowStat | null | undefined): string {
  return s?.changePct == null ? DASH : formatPercentChange(s.changePct / 100)
}

/** A volume/TVL ratio (0.96) as the percentage the explorer prints (96%). */
export function ratioPct(r: number | null | undefined): string {
  return r == null || !Number.isFinite(r) ? DASH : formatPercent(r * 100, r * 100 >= 100 ? 0 : 1)
}

/** The three windows as kv rows. */
export function kpiRows(kpis: VolumeKpis | null | undefined, prefix: string): [string, string][] {
  return WINDOW_KEYS.map(k => [`${prefix} ${WINDOW_LABEL[k]}`, statWithChange(kpis?.[k], WINDOW_LABEL[k])])
}

export const CUT_NOTE = 'Volume is read from hourly models of CLOSED hours; every window ends at the cut stated above (the first hour not yet published, one to two hours behind the chain), and the previous period is the same span just before it. Event-time USD: each leg at the hourly candle closed by its fill, never today\'s price.'
