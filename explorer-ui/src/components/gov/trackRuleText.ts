import type { TrackCurveDef } from '../../governanceTypes'

// A track's rules in plain words, for the proposal wizard:
// what the track is for, its bars (approval, support) from the start to the end of the
// decision period, and its periods at the governance clock's measured pace.

// What each track is FOR, by its runtime name. Unknown names fall back to none.
export const PURPOSE: Record<string, string> = {
  root: 'The most powerful track: anything the chain can do, including runtime upgrades. It needs the most support and waits the longest.',
  whitelisted_caller: 'Calls the technical committee has already vetted and whitelisted, so they can pass with lower support and a shorter wait.',
  referendum_canceller: 'Cancels a running referendum — the brake for a proposal that should not go ahead. Its deposits can then be reclaimed by whoever placed them.',
  referendum_killer: 'Kills a running referendum and slashes its deposits — for one that is malicious.',
  general_admin: 'Everyday administration: registry entries, identities, collators and similar upkeep.',
  treasurer: 'Large treasury spends.',
  spender: 'Medium treasury spends.',
  tipper: 'Small treasury tips.',
  omnipool_admin: 'Omnipool settings: listing assets, weight caps, fees and trading states.',
  economic_parameters: 'Protocol economics: fees, rates, caps and other money-market and stability parameters.',
}

/** A period at the measured pace, one decimal at most: "~7.6 days", "~2.4 hours", "~10 minutes". */
export function days(blocks: number, msPerBlock: number): string {
  const one = (v: number) => String(Number(v.toFixed(1)))
  const d = (blocks * msPerBlock) / 86_400_000
  if (d >= 1) return `~${one(d)} ${one(d) === '1' ? 'day' : 'days'}`
  const h = (blocks * msPerBlock) / 3_600_000
  if (h >= 1) return `~${one(h)} ${one(h) === '1' ? 'hour' : 'hours'}`
  return `~${Math.max(1, Math.round((blocks * msPerBlock) / 60_000))} minutes`
}

/** A curve point as a percentage, trailing zeros dropped (a perbill a unit off 50% is "50%"). */
export const pct = (perbill: number) => {
  const v = perbill / 1e7
  return `${Number(v.toFixed(v < 1 ? 2 : 1))}%`
}

/** A period in short: "7.6 d", "13 h", "10 min". */
export function short(blocks: number, msPerBlock: number): string {
  const one = (v: number) => String(Number(v.toFixed(1)))
  const d = (blocks * msPerBlock) / 86_400_000
  if (d >= 1) return `${one(d)} d`
  const h = (blocks * msPerBlock) / 3_600_000
  if (h >= 1) return `${one(h)} h`
  return `${Math.max(1, Math.round((blocks * msPerBlock) / 60_000))} min`
}

/** A curve's start and end in short: "100→50%", or "50%" when it does not move. */
export const span = (samples: number[]) => {
  const start = samples[0] ?? 0, end = samples[samples.length - 1] ?? 0
  return start === end ? pct(start) : `${pct(start).replace('%', '')}→${pct(end)}`
}

/** A curve in words: "100% falling to 50%". */
export function curveWords(c: TrackCurveDef, samples: number[]): string {
  const start = samples[0], end = samples[samples.length - 1]
  if (start == null || end == null) return '—'
  const shape = 'reciprocal' in c ? 'falling fast at first, then slowly' : 'linearDecreasing' in c ? 'falling steadily' : 'falling in steps'
  return start === end ? `${pct(start)} throughout` : `${pct(start)} → ${pct(end)}, ${shape}`
}

/** "falling steadily" — the shape part of a curve in words. */
export const shape = (words: string) => (words.includes(', ') ? words.slice(words.indexOf(', ') + 2) : 'throughout')
