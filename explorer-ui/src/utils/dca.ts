// DCA is scheduled in blocks but lived in time: a period of 770 blocks is "every
// 1h 17m" to the person who set it, and the block count is the mechanism behind
// that. Everything here turns the pallet's block arithmetic into the durations
// the schedule pages lead with, so the DCA detail page, the account's active
// orders and the hover card cannot drift apart on what "every" or "left" means.

// Last-resort block time. Nothing here should reach for it when the chain's own
// measured pace (stats.avgBlockSec) or a schedule's observed cadence is at hand:
// Hydration has produced blocks at 12s, produces them at ~6s and is heading for
// 2s, so a hard-coded seconds-per-block is wrong for every era but one.
export const NOMINAL_BLOCK_SECONDS = 6

export function blockSeconds(measured: number | null | undefined): number {
  return measured != null && Number.isFinite(measured) && measured > 0 ? measured : NOMINAL_BLOCK_SECONDS
}

export function blockSpanSeconds(blocks: number, secondsPerBlock?: number | null): number {
  return Math.max(0, Math.round(blocks * blockSeconds(secondsPerBlock)))
}

// How long this order waits between trades. Its own executions are the only
// era-correct answer — they were produced under whatever block time was running
// at the time — so a measured cadence always wins over the block count times
// today's pace, which is only an estimate for an order that has yet to run twice.
export function dcaCadence(
  periodSeconds: number | null | undefined,
  period: number,
  chainBlockSec?: number | null,
): { seconds: number; measured: boolean } {
  return periodSeconds != null && periodSeconds > 0
    ? { seconds: periodSeconds, measured: true }
    : { seconds: blockSpanSeconds(period, chainBlockSec), measured: false }
}

// Two units, largest first: 3d 4h · 1h 17m · 12m · 45s. `seconds` keeps the
// second component under an hour, which a live countdown needs to visibly tick.
export function fmtDuration(totalSeconds: number, opts: { seconds?: boolean } = {}): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return opts.seconds ? `${m}m ${sec}s` : `${m}m`
  return `${sec}s`
}

function big(v: string | null | undefined): bigint | null {
  try { return BigInt(v ?? '') } catch { return null }
}

export interface DcaRunway {
  // Trades the order can still pay for, and how long they take at its cadence.
  // `estimated` marks the ones we can only average or project, not read off the
  // order (see below). `funded` marks a runway that comes from the owner's
  // balance rather than from a budget — a top-up moves it.
  trades: number
  seconds: number
  estimated: boolean
  funded: boolean
}

// How much an order still has to run.
//
// A budgeted order is bounded by what is left of its budget. An open-ended one
// has no budget at all — it runs "until stopped or unfunded" — so its bound is
// the owner's spendable balance of the sold asset, which makes the answer a
// projection: a top-up extends it and a withdrawal cuts it short. Both are
// marked (`funded`, `estimated`) rather than presented as a schedule.
//
// A Sell order fixes what it spends per trade, so what is left divides exactly.
// A Buy order fixes what it BUYS, and what that costs moves with the price — the
// only honest answer there is the average of what it has actually spent so far,
// hence `estimated` too. Before a Buy has executed once there is nothing to
// average and this returns null rather than a made-up number.
//
// The runway starts at the next planned execution when the caller knows it
// (`secondsToNext`), so the countdown and the end estimate agree.
export function dcaRunway(args: {
  direction: string
  amountPer: string
  totalAmount: string
  filledAmount: string
  executionsDone: number
  // The order's cadence in seconds (see dcaCadence) — not its block count, which
  // cannot be turned into a duration without knowing the block time of the era.
  periodSeconds: number
  secondsToNext?: number | null
  // Spendable balance behind an open-ended order; ignored when there is a budget.
  fundingBalance?: string | null
}): DcaRunway | null {
  const total = big(args.totalAmount)
  const filled = big(args.filledAmount)
  if (total == null || filled == null) return null
  const funded = total <= 0n
  const left = funded ? (big(args.fundingBalance) ?? -1n) : (total > filled ? total - filled : 0n)
  if (left < 0n) return null      // open-ended and no balance to project from
  if (left === 0n) return { trades: 0, seconds: 0, estimated: funded, funded }

  const perTrade = args.direction === 'Buy'
    ? (args.executionsDone > 0 ? filled / BigInt(args.executionsDone) : null)
    : big(args.amountPer)
  if (perTrade == null || perTrade <= 0n) return null

  // Round up: a remainder smaller than one trade is still a trade's worth of
  // waiting, and the pallet closes the schedule out on it either way.
  const trades = Number((left + perTrade - 1n) / perTrade)
  if (!Number.isFinite(trades) || trades <= 0) return null
  const first = args.secondsToNext != null && args.secondsToNext >= 0 ? args.secondsToNext : args.periodSeconds
  return {
    trades,
    seconds: first + (trades - 1) * args.periodSeconds,
    estimated: funded || args.direction === 'Buy',
    funded,
  }
}

// How far along an order is, 0–100.
//
// With a budget that is simply the share of it already spent. Without one there
// is no denominator on the chain, so the honest stand-in is what it has spent
// against what it has spent PLUS what the wallet still funds — a projection that
// moves with the balance, flagged so a page never presents it as a plan. Both
// amounts are in the sold asset whatever the order type, so this is exact for
// Buy orders too.
export function dcaProgress(totalAmount: string, filledAmount: string, fundingBalance?: string | null):
  { pct: number | null; projected: boolean } {
  const filled = big(filledAmount)
  const total = big(totalAmount)
  if (filled == null || total == null) return { pct: null, projected: false }
  const projected = total <= 0n
  const funds = big(fundingBalance)
  // Open-ended with no balance to project against has no denominator at all —
  // saying 100% there would read as "finished" when it is merely unknowable.
  if (projected && funds == null) return { pct: null, projected }
  const denominator = projected ? filled + (funds ?? 0n) : total
  if (denominator <= 0n) return { pct: null, projected }
  if (filled >= denominator) return { pct: 100, projected }
  // Percent with one decimal of headroom, in integer arithmetic — these are
  // 18-decimal token amounts, well past what a float divide holds exactly.
  return { pct: Number((filled * 1000n) / denominator) / 10, projected }
}

// A Permill (parts per million) as a percentage: 30000 → "3%", 1000 → "0.1%".
// Not F.pct, which signs its output for price CHANGES — a slippage tolerance is a
// magnitude, and "+3.00%" would read as a move rather than a limit. Trailing zeros
// go, because every value the pallet has been given is a round fraction of a
// percent and "3.00%" implies a precision the setting does not have.
export function fmtPermill(permill: number): string {
  if (!Number.isFinite(permill)) return '—'
  const pct = permill / 10_000
  return `${Number(pct.toFixed(4))}%`
}
