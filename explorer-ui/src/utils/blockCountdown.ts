export interface BlockCountdown {
  etaMs: number
  secondsUntil: number
}

function timestampMs(timestamp: string | null | undefined): number {
  if (!timestamp) return NaN
  const iso = timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T')
  return new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`).getTime()
}

// Anchor estimates to the observed head block's chain timestamp. Adding the
// remaining duration to Date.now() on every render makes the ETA drift forward
// and leaves the displayed countdown permanently unchanged.
export function estimateBlockCountdown(
  targetBlock: number,
  headBlock: number,
  headTimestamp: string | null | undefined,
  nowMs: number,
  blockSeconds = 6,
): BlockCountdown | null {
  const headMs = timestampMs(headTimestamp)
  if (!Number.isFinite(headMs) || headBlock <= 0 || targetBlock <= headBlock) return null
  const etaMs = headMs + (targetBlock - headBlock) * blockSeconds * 1000
  return { etaMs, secondsUntil: Math.max(0, Math.ceil((etaMs - nowMs) / 1000)) }
}
