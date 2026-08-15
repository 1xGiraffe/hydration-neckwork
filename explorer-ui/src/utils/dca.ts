// DCA is scheduled in blocks but lived in time: a period of 770 blocks is "every
// 1h 17m" to the person who set it, and the block count is the mechanism behind
// that. Everything here turns the pallet's block arithmetic into the durations
// the schedule pages lead with, so the DCA detail page, the account's active
// orders and the hover card cannot drift apart on what "every" or "left" means.

// Last-resort block time, for the moment before any payload has arrived.
// Nothing displayed should reach for it: the chain publishes both of its own
// block times in the stats payload — `avgBlockSec`, the measured pace, for a
// live block delta, and `nominalBlockSec`, the runtime's slot time, for a
// runtime block-count constant (see api/src/services/blockTime.ts for why the
// two are not interchangeable) — and a schedule's observed cadence beats both.
// Hydration has produced blocks at 12s, produces them at ~6s and is heading for
// 2s, so a hard-coded seconds-per-block is wrong for every era but one. What is
// left for this constant is the empty-state default below and the poll/freshness
// timers in live.ts, which are needed before the first fetch resolves.
export const NOMINAL_BLOCK_SECONDS = 6

// Resolve a seconds-per-block from the payload, whichever of the two rates the
// caller asked for, falling back only when the payload is not loaded yet.
export function blockSeconds(fromChain: number | null | undefined): number {
  return fromChain != null && Number.isFinite(fromChain) && fromChain > 0 ? fromChain : NOMINAL_BLOCK_SECONDS
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

// BigInt('') is 0n rather than an error, so an absent value has to be rejected
// before the conversion: otherwise "no balance to project against" silently
// becomes "a balance of zero", and the callers below cannot tell the two apart —
// an unknown runway reads as no runway, and an unknowable progress reads as 100%,
// which is to say as finished.
function big(v: string | null | undefined): bigint | null {
  if (v == null || v === '') return null
  try { return BigInt(v) } catch { return null }
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

// What a finished budgeted order never got to spend.
//
// The pallet closes a schedule as soon as what is left of the budget can no longer
// fund another trade, so "completed" does not mean "spent it all". A Sell order
// fixes what each trade costs and leaves a rounding remainder — 98% of completed
// ones stop with less than a single trade left. A Buy order fixes what it BUYS, so
// the pallet has to keep the slippage-adjusted worst case (maxAmountIn) reserved
// per execution rather than what a trade actually costs, and it can therefore close
// with most of a trade's budget untouched: a page reading "completed" beside a
// two-thirds-full ring, explaining neither. The remainder is released back to the
// owner when the schedule closes.
//
// Null while the order still runs, when it has no budget to fall short of, and
// when it did spend the lot.
export function dcaUnspentBudget(totalAmount: string, filledAmount: string): string | null {
  const total = big(totalAmount)
  const filled = big(filledAmount)
  if (total == null || filled == null || total <= 0n || filled >= total) return null
  return (total - filled).toString()
}

// What a RUNNING budgeted order still has to spend. Distinct from
// dcaUnspentBudget, which is the remainder a FINISHED one never got to use: this
// one is the live figure, and the same number dcaRunway divides into trades.
//
// Null for an open-ended order — it has no budget, and what funds it is the
// owner's balance, which the surfaces already show as "… left" from
// `fundingBalance` — and null once the budget is spent, so a row shows nothing
// rather than "0 left".
export function dcaAmountLeft(totalAmount: string, filledAmount: string): string | null {
  const total = big(totalAmount)
  const filled = big(filledAmount)
  if (total == null || filled == null || total <= 0n || filled >= total) return null
  return (total - filled).toString()
}

// The same figure in dollars, which is what the surfaces actually show: "$10k
// left" says more about a budget than an amount of a token a reader may not price
// in their head.
//
// A budget and its remainder are the same asset at the same moment, so scaling
// the budget's dollar value (`budgetUsd`) by the unspent share IS pricing the
// remainder — and it keeps a row's "left" on the same basis as the budget beside
// it and as the section total (dcaAggregates), which no separately fetched price
// could guarantee. The share is taken on the integers, the way dcaProgress takes
// its percentage: these are 128-bit amounts that shed their low digits on the way
// through a double, and only the display value here becomes a Number.
//
// Null wherever dcaAmountLeft is, and null when the asset has no price feed at
// all — the callers then state the remainder in the sold asset rather than print
// a dollar figure they don't have.
export function dcaLeftUsd(totalAmount: string, filledAmount: string, budgetUsd: number | null | undefined): number | null {
  if (budgetUsd == null || !Number.isFinite(budgetUsd)) return null
  const left = big(dcaAmountLeft(totalAmount, filledAmount))
  const total = big(totalAmount)
  if (left == null || total == null || total <= 0n) return null
  // A 1e12-part share is far finer than the ~3 significant digits F.usd prints.
  return (budgetUsd * Number((left * 1_000_000_000_000n) / total)) / 1e12
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
