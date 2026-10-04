import type { ApiCandle } from '../types'
import { compactAmount, formatUsd } from './format'

/**
 * One candle's volume bar. On an asset pair (a token quote) the bar is the
 * pair's own volume in BASE-TOKEN units — the trades between the two assets,
 * normalised across price ranges as an exchange shows it. On a dollar pair it is
 * the base asset's own dollar volume. A server that does not send the pair
 * fields yet falls back to the latter.
 */
export function candleVolume(c: ApiCandle, pairVolume: boolean): number {
  if (!pairVolume || c.pairVolumeBase == null) return c.volumeTotal
  return c.pairVolumeBase
}

/** A token amount, grouped where it stays short ("12,345", "4.66"), compact past a million ("12.3M"). */
export function formatTokenAmount(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e6 || (abs > 0 && abs < 1)) return compactAmount(value)
  return value.toLocaleString('en-US', { maximumFractionDigits: abs >= 1000 ? 0 : 2 })
}

/**
 * The volume readout for a candle: on an asset pair both the base-token amount
 * and its dollars ("12,345 DOT · $14.2k"); on a dollar pair the dollars alone.
 */
export function formatVolumeReadout(c: ApiCandle, pairVolume: boolean, base: string): string {
  if (!pairVolume || c.pairVolumeBase == null) return formatUsd(c.volumeTotal)
  return `${formatTokenAmount(c.pairVolumeBase)} ${base} · ${formatUsd(c.pairVolumeUsd ?? 0)}`
}

/** The volume scale's labels, in the bars' own unit. */
export function formatVolumeAxis(value: number, pairVolume: boolean, base: string): string {
  return pairVolume ? `${compactAmount(value)} ${base}` : formatUsd(value)
}
