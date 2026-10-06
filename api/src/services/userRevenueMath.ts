// The pure, integer arithmetic of User Revenue (services/userRevenueStreams.ts
// states the semantics). No I/O: services/userRevenueFold.ts feeds these from
// indexed rows, and api/tests/userRevenueMath.test.ts pins each rule against the
// chain's own formula where one exists (the Omnipool's remove-liquidity payoff in
// lpMath.ts, Aave's ray arithmetic in aaveMath.ts).

import { OMNI_FIXED, omnipoolRemoveLiquidity } from './lpMath.ts'

// ── Omnipool: non-pro-rata capture ─────────────────────────────────────────────
//
// An Omnipool position's claim is its remove-liquidity payoff
// (lpMath.omnipoolRemoveLiquidity, bit-exact with the node), which is NOT a
// pro-rata slice of the sub-pool: a position entered at price p_x in a sub-pool
// whose spot is p (x = p / p_x) is paid out differently on either side of its
// entry price. So an inflow into the sub-pool — a fee retained in the reserve, an
// exit fee, a rebasing aToken's interest on the reserve (units δr into R), or the
// hub fee credited to the HDX sub-pool (δq into Q) — raises the position's payoff
// by c(x) of its pro-rata slice s/S, valued at FIXED external prices (the
// asset leg at the sub-pool's spot when the inflow lands, H2O at 1):
//
//   asset inflow δr:  c(x) = 2x²/(1+x)²          x ≤ 1
//                     c(x) = (1+x²)/(1+x)²        x ≥ 1
//   hub inflow δq:    c(x) = 2x/(1+x)²           x ≤ 1
//                     c(x) = (x²+2x−1)/(1+x)²     x ≥ 1
//
// — the closed-form derivative of the payoff (both are ½ at the entry price,
// the measured 0.49975 on the aDOT sub-pool). Protocol-owned shares are a
// position at spot (x = 1, c = ½). What no position captures leaks to the hub
// side (arbitrage, the other sub-pools) and is booked unattributed as the
// 'omnipool-hub-channel' remainder. The rule is the linearization of the
// payoff's response to the inflow at the state where it lands: its error is
// second order in the inflow and in the spot's drift over the grid interval the
// state is sampled at (the tests pin it against the exact payoff difference).

export type OmnipoolInflowKind = 'asset' | 'hub' | 'price'

/** c(x) as an exact rational num/den for a position with entry price `priceRaw` (FixedU128) in a sub-pool with reserves (R, Q). */
export function omnipoolCapture(kind: OmnipoolInflowKind, reserve: bigint, hub: bigint, priceRaw: bigint): { num: bigint; den: bigint } {
  if (reserve <= 0n || hub <= 0n || priceRaw <= 0n) return { num: 0n, den: 1n }
  if (kind === 'price') return omnipoolPriceCapture(reserve, hub, priceRaw)
  // p = Q/R, a = priceRaw/1e18; scaled to one denominator: Q' = Q·1e18, A = priceRaw·R,
  // so x = p/a = Q'/A.
  const q = hub * OMNI_FIXED
  const a = priceRaw * reserve
  const den = (q + a) * (q + a)
  if (kind === 'asset') return { num: q <= a ? 2n * q * q : q * q + a * a, den }
  return { num: q <= a ? 2n * q * a : q * q + 2n * q * a - a * a, den }
}

/**
 * PRICE-type inflow: the held asset's value per unit rises (a NAV wrapper such
 * as GETH or GSOL whose pool earned, a yield-bearing token's rate) while its
 * units stay. Arbitrage restores the external price — R' = R/√(1+e),
 * Q' = Q·√(1+e) — and the position's income is its payoff's value change, each
 * side at its own external price, over the gain a plain holder of R units would
 * have made (R·p·e). That is the linear response at e → 0, taken here by a
 * 1e-6 probe of omnipoolRemoveLiquidity itself: ≈ 1 at the entry price (the
 * position captures the full amount, about half of it as H2O).
 */
export const PRICE_PROBE = 10n ** 12n // e = 1e-6 at 1e18 scale
const E18 = 10n ** 18n
function isqrt(n: bigint): bigint {
  if (n < 2n) return n
  let x = BigInt(Math.floor(Math.sqrt(Number(n))))
  while (x * x > n) x--
  while ((x + 1n) * (x + 1n) <= n) x++
  return x
}
const SQRT_1_PLUS_E = isqrt((E18 + PRICE_PROBE) * E18)
export function omnipoolPriceCapture(reserve: bigint, hub: bigint, priceRaw: bigint): { num: bigint; den: bigint } {
  if (reserve <= 0n || hub <= 0n || priceRaw <= 0n) return { num: 0n, den: 1n }
  const shares = 10n ** 30n
  const pos = { assetId: 0, amount: 0n, shares, priceNum: priceRaw, priceDen: OMNI_FIXED }
  const before = omnipoolRemoveLiquidity({ reserve, hub, shares }, pos)
  const r1 = (reserve * E18) / SQRT_1_PLUS_E
  const q1 = (hub * SQRT_1_PLUS_E) / E18
  const after = omnipoolRemoveLiquidity({ reserve: r1, hub: q1, shares }, pos)
  // Values in H2O ×1e18: the asset leg at the state's own (arbitraged) price.
  const v0 = (before.liquidity * hub * E18) / reserve + before.hub * E18
  const v1 = (after.liquidity * q1 * E18) / r1 + after.hub * E18
  // A plain holder of the whole reserve gains R·p·e = Q·e (H2O), ×1e18 → Q·PRICE_PROBE.
  return { num: v1 - v0, den: hub * PRICE_PROBE }
}

/** A position's capture of an inflow D: floor(D · c · s / S) — one floor, no intermediate scaling. */
export function omnipoolPositionIncome(inflow: bigint, cap: { num: bigint; den: bigint }, shares: bigint, totalShares: bigint): bigint {
  if (inflow === 0n || shares <= 0n || totalShares <= 0n || cap.num <= 0n) return 0n
  return (inflow * cap.num * shares) / (cap.den * totalShares)
}

/** Protocol-owned shares, a position at spot: c = ½ for either inflow kind. */
export const OMNIPOOL_AT_SPOT_CAPTURE = { num: 1n, den: 2n } as const

// ── pro-rata splitting ─────────────────────────────────────────────────────────

/**
 * Splits `total` over `weights` by cumulative floors, in the given order: the
 * parts sum to `total` exactly (negative totals included — BigInt division
 * truncates toward zero and the telescoping keeps the sum). A zero or negative
 * total weight splits nothing (the caller books the whole amount as its named
 * remainder). Order is the caller's and must be deterministic.
 */
export function splitProRata<K>(total: bigint, weights: ReadonlyArray<readonly [K, bigint]>): Array<[K, bigint]> {
  let sum = 0n
  for (const [, w] of weights) if (w > 0n) sum += w
  if (sum <= 0n || total === 0n) return []
  const out: Array<[K, bigint]> = []
  let cum = 0n
  let prev = 0n
  for (const [k, w] of weights) {
    if (w <= 0n) continue
    cum += w
    const upto = (total * cum) / sum
    const part = upto - prev
    prev = upto
    if (part !== 0n) out.push([k, part])
  }
  return out
}

// ── valuation ──────────────────────────────────────────────────────────────────

/** 10^decimals as a BigInt (cached). */
const units = new Map<number, bigint>()
export function unitOf(decimals: number): bigint {
  let u = units.get(decimals)
  if (u == null) { u = 10n ** BigInt(decimals); units.set(decimals, u) }
  return u
}

/** amount (raw units) × close (1e-12 USD per whole unit) / 10^decimals, at 1e-12 USD, truncated toward zero. */
export function usd1e12(amount: bigint, close1e12: bigint, decimals: number): bigint {
  return (amount * close1e12) / unitOf(decimals)
}

/** A Decimal(38,12) wire string → 1e-12 integer. */
export function parseUsd1e12(s: string): bigint {
  const neg = s.startsWith('-')
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.')
  const v = BigInt(i || '0') * 10n ** 12n + BigInt((f + '000000000000').slice(0, 12))
  return neg ? -v : v
}

/** A 1e-12 integer as the Decimal(38,12) wire string. */
export function formatUsd1e12(v: bigint): string {
  const neg = v < 0n
  const m = neg ? -v : v
  return `${neg ? '-' : ''}${m / 10n ** 12n}.${(m % 10n ** 12n).toString().padStart(12, '0')}`
}

// ── legacy HDX staking ─────────────────────────────────────────────────────────

/** FixedU128's one. */
export const FIXED_U128_ONE = 10n ** 18n

/**
 * A position's GROSS reward over a stretch of constant stake: stake × Δrps,
 * rps being the pallet's FixedU128 accumulated reward per stake. Gross is what
 * the chain says is owed before the governance-action points decide the payable
 * percentage — not reconstructable from indexed data, so the forfeit is booked
 * negative at the claim that decides it (slashedUnpaidRewards).
 */
export function stakingGross(stake: bigint, rpsFrom: bigint, rpsTo: bigint): bigint {
  if (stake <= 0n || rpsTo <= rpsFrom) return 0n
  return (stake * (rpsTo - rpsFrom)) / FIXED_U128_ONE
}

// ── GIGAHDX ────────────────────────────────────────────────────────────────────

/**
 * The GIGAHDX pot's HDX inflows as distributable amounts. Each inflow is shared
 * by the stakers holding at the end of the previous block (start-of-block
 * semantics) — except while the supply is zero, when there is nobody to share
 * it: those inflows, and the pot's opening stock (what it held before the first
 * stake), accumulate into ONE opening inflow booked at the first block with a
 * positive supply and shared by that block's END supply — the stated exception,
 * and how the chain's rate credited it. No division by a zero supply is ever
 * evaluated.
 */
export interface PotInflow { block: number; amount: bigint }
export interface PotBooking { block: number; amount: bigint; endOfBlock: boolean; opening: boolean }
export function gigahdxBookings(inflows: readonly PotInflow[], openingStock: bigint, firstSupplyBlock: number | null): PotBooking[] {
  const out: PotBooking[] = []
  let carry = openingStock
  for (const f of [...inflows].sort((a, b) => a.block - b.block)) {
    if (firstSupplyBlock == null || f.block <= firstSupplyBlock) { carry += f.amount; continue }
    out.push({ block: f.block, amount: f.amount, endOfBlock: false, opening: false })
  }
  if (firstSupplyBlock != null && carry !== 0n) out.unshift({ block: firstSupplyBlock, amount: carry, endOfBlock: true, opening: true })
  return out
}

// ── liquidity-mining farms ─────────────────────────────────────────────────────

/**
 * A yield farm's accumulated reward per valued share between two on-chain syncs,
 * interpolated in relay periods. The chain publishes rpvs only at syncs; between
 * them it accrues at the farm's rate WHILE the global farm is funded. When the
 * observed rise falls short of what the funded rate would have paid over the gap,
 * the pot ran dry inside it: it accrued at the funded rate up to
 * p_dry = p0 + observed / rate and nothing after. A gap whose observed rise meets
 * the expectation (or with no expectation available) is interpolated linearly.
 * Before p0 or at/after p1 the endpoints hold.
 */
export interface RpvsSync { period: number; rpvs: bigint }
export function interpolateRpvs(s0: RpvsSync, s1: RpvsSync, period: number, expectedRatePerPeriod: bigint | null): bigint {
  if (period <= s0.period) return s0.rpvs
  if (period >= s1.period || s1.period <= s0.period) return s1.rpvs
  const observed = s1.rpvs - s0.rpvs
  if (observed <= 0n) return s0.rpvs
  const span = BigInt(s1.period - s0.period)
  const dt = BigInt(period - s0.period)
  if (expectedRatePerPeriod != null && expectedRatePerPeriod > 0n && observed < expectedRatePerPeriod * span) {
    // Dry inside the gap: the funded rate until the observed rise is exhausted.
    const atRate = expectedRatePerPeriod * dt
    return s0.rpvs + (atRate < observed ? atRate : observed)
  }
  return s0.rpvs + (observed * dt) / span
}

/**
 * Farm accrual under the netting convention: what the chain says is owed NOW is
 * the vested claimable, so an entry's accrual over a stretch is
 * Δclaimable + claimed-in-the-stretch. A termination that zeroes claimable is a
 * negative fact (−claimable) at the termination block — never a silent drop.
 */
export function farmAccrual(claimableBefore: bigint, claimableAfter: bigint, claimedBetween: bigint): bigint {
  return claimableAfter - claimableBefore + claimedBetween
}

// ── yield-bearing tokens ───────────────────────────────────────────────────────

/** A peg unchanged for this long (block time) before the move that ends it makes that move a catch-up. */
export const STALE_PEG_SECONDS = 14 * 86_400

/**
 * The oracle re-pushes the same rate as a slightly different 128-bit rational
 * every grid row (1.0505e36 / 1.0505000000000001e36 / …): a change smaller than
 * one part in PEG_NOISE_INVERSE is re-encoding noise, not a move — the rate is
 * held at the last real move.
 */
export const PEG_NOISE_INVERSE = 1_000_000_000n
/** A move after a flat stretch at least this long may open a catch-up episode (a rate-limited ramp follows a stalled oracle). */
export const CATCHUP_MIN_FLAT_SECONDS = 3 * 86_400
/**
 * An episode's next move joins it within this gap of the previous one (a capped ramp pauses while the pool is not
 * touched: jitoSOL, 2026-08-02 05:13 → 08-03 01:58, 20.75 h between two at-cap steps); a move held at the pool's
 * tight cap joins after any gap. A later move of a step-cadence oracle (sUSDS, sUSDe: steps 2–8 days apart) stays its
 * own segment.
 */
export const CATCHUP_LINK_GAP_SECONDS = 36 * 3_600
/**
 * A move after a shorter flat stretch (≥ 12 h) also opens an episode when it alone reads as a jump: an oracle that
 * lagged the rate and caught up in a burst (sUSDe 2025-12-30: +0.15 % after 16 h, then +0.05 %).
 */
export const CATCHUP_FAST_MIN_FLAT_SECONDS = 12 * 3_600
/** An episode's jump test is judged over at least this long (a burst repays the slower days before it). */
export const CATCHUP_JUMP_MIN_SPAN_SECONDS = 3 * 86_400
/**
 * The pool's peg cap (`maxPegUpdate`, Perbill per block since the peg's last update; the pallet's
 * `calculate_peg_deltas`) rate-limits a move only when it is tight: at this many perbill or fewer a run held at the
 * cap stays under ~100 % APR, so it is a ramp chasing a target, never a relayed price. A looser cap (vDOT's 0.1 % per
 * block until 2026-07-14) bounds nothing.
 */
export const PEG_CAP_BINDING_MAX_PERBILL = 190
/** A peg source replacing another at a new level starts its high-water mark at its lowest row within this long. */
export const PEG_SOURCE_SETTLE_SECONDS = 86_400
/** The grid's row spacing in blocks: the peg's last update before a row may lie up to one row earlier. */
export const PEG_GRID_BLOCKS = 600
/** An episode spans at most this long from its first move. */
export const CATCHUP_MAX_SECONDS = 14 * 86_400
/** After its first 24 h an episode continues only while its trailing-24h rise runs at ≥ 25 % APR (the ramp, not the token's own pace). */
export const CATCHUP_RAMP_MIN_APR_BPS = 2_500n
export const CATCHUP_TRAILING_SECONDS = 86_400
/** A segment whose rise or fall over its own stretch implies more than 50 % APR is a price event, not accrual: unmeasured. */
export const CATCHUP_ABSURD_APR_BPS = 5_000n
/** Give-back: a move ending more than 1 % below the peg's high of the trailing 30 days relays a price — unmeasured. */
export const PEG_GIVE_BACK_WINDOW_SECONDS = 30 * 86_400
export const PEG_GIVE_BACK_BPS = 100n
const YEAR_SECONDS = 31_557_600n

/**
 * One grid point of a token's rate (×1e36, underlying per token, whole units). `block` is the grid row's block;
 * `source` the block of the PoolPegSourceUpdated that put the row's peg source in force (0: the pool's creation
 * source), so a source change splits the series; `cap` the pool's maxPegUpdate (Perbill per block) in force.
 */
export interface PegPoint { ts: number; rate: bigint; block?: number; source?: number; cap?: number }

/**
 * After a price-like segment (a jump or a give-back) the peg is relaying a
 * price for a while (wstETH, July 2025: ±0.7 % hourly for ten days): every
 * segment ending within this long of one is a jump too, so a small move that
 * happens to land at a relayed peak cannot set the high-water mark.
 */
export const PEG_JUMP_QUARANTINE_SECONDS = 86_400
/**
 * The jump test judges a segment over at least this long: an oracle that
 * updates hourly in steps of a few 1e-5 (sUSDe, sUSDS) is a moving rate, not a
 * price event, however steep one hour's step reads annualized.
 */
export const PEG_JUMP_MIN_SPAN_SECONDS = 86_400

/**
 * How a stretch of a token's rate is booked:
 *   'accrual'          — the rise accrued evenly over (startTs, endTs] (the move's own interval since the previous move);
 *   'catchup'          — the same, for an episode that ends a ≥ 14-day stale stretch (token_accrual_catchup, via 'catchup-spread');
 *   'under-high-water' — a measured stretch ending at or under the high-water mark: it books nothing, stated unmeasured;
 *   'gave-back'        — a price relayed through the peg (more than 1 % under its trailing 30-day high): unmeasured;
 *   'jump'             — a stretch implying more than 50 % APR either way, or ending within a day of a price-like stretch: unmeasured;
 *   'source-changed'   — from a peg source's last move to the first row of the source that replaced it: unmeasured;
 *   'pending'          — after the last decided move (an open episode, or no move yet): unmeasured until the next move decides it;
 *   'external'         — before the token's first peg row, a stretch of the issuer's own published rate (userRevenueTokens
 *                        EXTERNAL_RATES), anchored to end at the first peg row: booked, via the series' `via` (external-rate:<source>).
 */
export type PegSegmentKind = 'accrual' | 'catchup' | 'under-high-water' | 'gave-back' | 'jump' | 'source-changed' | 'pending' | 'external'
/**
 * `source`: the peg source's PoolPegSourceUpdated block the segment's rows belong to (0: the creation source).
 * `via`: an 'external' segment's booking label (the rate series it was read from).
 */
export interface PegSegment { startTs: number; endTs: number; rise: bigint; kind: PegSegmentKind; moves: number; source?: number; via?: string }
/** endTs of the open 'pending' segment. */
export const PEG_OPEN_END = Number.MAX_SAFE_INTEGER

/** The segment kinds whose rise is booked (and which alone may raise the high-water mark). */
export const pegSegmentBooks = (kind: PegSegmentKind): boolean => kind === 'accrual' || kind === 'catchup' || kind === 'external'

/**
 * A token's rate history as booking segments (accrual when earned). Every real
 * move's rise accrued over the interval since the previous move, so it is spread
 * evenly over that interval. A stalled oracle catches up as a rate-limited RAMP
 * (PRIME: flat ~50 days, then +1.0–1.3 % over ~7 days at one capped step per grid
 * row): the moves of such an EPISODE are one segment over (the move before the
 * episode, the episode's last move], so the yield the flat stretch hid is booked
 * over the stretch, to its holders then. An episode
 *   - opens with a move after ≥ 3 flat days, or after ≥ 12 h when that move alone is a RISE reading as a jump (a
 *     lagging oracle's burst);
 *   - is joined by each next move within 36 h of the previous one while the episode is under 24 h old, and after that
 *     while its trailing-24h rise runs at ≥ 25 % APR; a move held AT the pool's tight peg cap (`maxPegUpdate`, see
 *     pegCapBound) always joins, whatever the gap: it is still chasing its target;
 *   - lasts at most 14 days, and is decided once a later move fails to join or 36 h pass with none;
 * until then it is 'pending', as is everything after the last decided move.
 *
 * Every decided segment is then judged, in this order: more than 1 % under the
 * trailing 30-day high is a give-back; a rise or fall implying more than 50 %
 * APR over its own stretch (judged over at least a day, an episode over at least
 * three), or an end within PEG_JUMP_QUARANTINE_SECONDS of a give-back's or jump's,
 * is a jump — both unmeasured, booking nothing. A rising stretch every move of
 * which stays within the pool's tight cap is rate-limited by the chain, so it is
 * never a jump by its APR. A measured segment books the part of its own rise above
 * the running HIGH-WATER MARK, end − max(start, mark), and only it raises the mark:
 * a give-back and the recovery after it net to zero, a relayed spike never lifts
 * the mark, and the lift an unmeasured stretch carried is never booked later. A
 * measured segment ending at or under max(start, mark) — a fall, or a recovery of
 * value already booked — books nothing and is stated 'under-high-water'.
 *
 * A PEG SOURCE CHANGE (PoolPegSourceUpdated for either leg of the token's rate)
 * splits the series: each source is judged alone, the old source's last episode
 * decided at its last row, with no give-back, jump or quarantine test across the
 * boundary. A LEVEL change (vDOT 2025-12-19: Bifrost's EMA → an MMOracle reading
 * 0.9 % lower; the new first row further from the old last row than noise or the
 * pool's tight cap allows) starts the new source fresh: the stretch from the old
 * source's last move to the new source's first row is 'source-changed'
 * (unmeasured) and the new high-water mark is its lowest row of its first day. A
 * CONTINUOUS change hands the new source the old source's last row, undecided
 * tail and high-water mark (pegContinuous), so a catch-up through the new source
 * spans the stall and books only above max(old mark, the handed-over row).
 * Pure and deterministic in the points, so every build that sees the same grid
 * books the same hours.
 */
export function pegSegments(points: readonly PegPoint[]): PegSegment[] {
  const out: PegSegment[] = []
  const runs: PegPoint[][] = []
  for (const p of points) {
    const last = runs.at(-1)
    if (last && (last[0].source ?? 0) === (p.source ?? 0)) last.push(p)
    else runs.push([p])
  }
  // A CONTINUOUS change (the new source's first row within what the pool's tight cap lets the peg move from the old
  // source's last row: the 2026-09-25 MMOracle swaps of PRIME, jitoSOL, wstETH, apyUSD) hands the new source the old
  // one's last row as its baseline and its undecided tail as a leading flat stretch, so a stalled old source's
  // catch-up through the new one stays one catch-up over the stall; a LEVEL change (vDOT) starts the new source fresh.
  // The handed-over baseline carries the old source's high-water MARK too: the new source books only above
  // max(old mark, handed-over row), so a rise the old source already booked (and then gave back under its mark) is
  // never booked again across the hand-over.
  let lead: { ts: number; point: PegPoint; mark: bigint } | null = null
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r]
    const closed = r + 1 < runs.length
    const pts = lead ? [{ ...lead.point, source: run[0].source }, ...run] : run
    const { tailTs, mark } = sourceSegments(pts, closed, lead?.ts ?? null, lead?.mark ?? null, out)
    if (!closed) break
    const next = runs[r + 1][0]
    if (pegContinuous(run[run.length - 1], next)) lead = { ts: tailTs, point: run[run.length - 1], mark }
    else {
      if (next.ts > tailTs) out.push({ startTs: tailTs, endTs: next.ts, rise: 0n, kind: 'source-changed', moves: 0, ...(run[0].source ? { source: run[0].source } : {}) })
      lead = null
    }
  }
  return out
}

/** Whether the peg moved from `a` (the old source's last row) to `b` (the new source's first) no more than noise or the pool's tight cap allows. */
export function pegContinuous(a: PegPoint, b: PegPoint): boolean {
  if (a.rate <= 0n) return false
  const d = b.rate > a.rate ? b.rate - a.rate : a.rate - b.rate
  if (d * PEG_NOISE_INVERSE < a.rate) return true
  const cap = b.cap ?? 0
  if (cap <= 0 || cap > PEG_CAP_BINDING_MAX_PERBILL || a.block == null || b.block == null) return false
  return d * 1_000_000_000n <= BigInt(cap) * BigInt(Math.max(0, b.block - a.block) + PEG_GRID_BLOCKS) * a.rate
}

interface PegMove { ts: number; before: bigint; after: bigint; block: number | null; prevBlock: number | null; cap: number }

/**
 * A rising move within the pool's TIGHT cap: rise ≤ cap × (blocks since the previous move's row + one row) of the
 * rate before it (the peg's last update may precede that row by up to a row). `atCap` also asks that the move used at
 * least half of what the elapsed blocks allowed: the peg was held back by the cap, chasing a target above it.
 */
export function pegCapBound(m: { before: bigint; after: bigint; block: number | null; prevBlock: number | null; cap: number }): { within: boolean; atCap: boolean } {
  if (m.after <= m.before || m.block == null || m.prevBlock == null || m.cap <= 0 || m.cap > PEG_CAP_BINDING_MAX_PERBILL) return { within: false, atCap: false }
  const rise = m.after - m.before
  const blocks = BigInt(Math.max(0, m.block - m.prevBlock))
  const cap = BigInt(m.cap)
  // rise / before ≤ cap / 1e9 × blocks  ⇔  rise × 1e9 ≤ cap × blocks × before
  const within = rise * 1_000_000_000n <= cap * (blocks + BigInt(PEG_GRID_BLOCKS)) * m.before
  const atCap = within && rise * 1_000_000_000n * 2n >= cap * blocks * m.before
  return { within, atCap }
}

/**
 * One peg source's run of points into `out`; `closed` when a later source replaced it (every episode is then
 * decided), `leadTs` the start of the stretch a continuous predecessor handed over and `leadMark` its high-water
 * mark (the new mark starts at max(leadMark, the handed-over row)). Returns where the run's tail (after its last
 * decided move) starts and the run's final high-water mark; an open run's tail is pushed as 'pending'.
 */
function sourceSegments(points: readonly PegPoint[], closed: boolean, leadTs: number | null, leadMark: bigint | null, out: PegSegment[]): { tailTs: number; mark: bigint } {
  const source = points[0].source ?? 0
  const src = source ? { source } : {}
  const moves: PegMove[] = []
  let eff = points[0].rate
  let effBlock = points[0].block ?? null
  for (let i = 1; i < points.length; i++) {
    const r = points[i].rate
    const d = r > eff ? r - eff : eff - r
    if (eff > 0n && d * PEG_NOISE_INVERSE >= eff) {
      const block = points[i].block ?? null
      moves.push({ ts: points[i].ts, before: eff, after: r, block, prevBlock: effBlock, cap: points[i].cap ?? 0 })
      eff = r
      effBlock = block
    }
  }
  const headTs = points[points.length - 1].ts
  // The peg's high over the trailing give-back window ending at ts (this source's rows only; ≤ 30 days of rows).
  const highAt = (ts: number): bigint => {
    let a = 0
    let b = points.length
    while (a < b) { const m = (a + b) >> 1; if (points[m].ts >= ts - PEG_GIVE_BACK_WINDOW_SECONDS) b = m; else a = m + 1 }
    let hi = 0n
    for (let k = a; k < points.length && points[k].ts <= ts; k++) if (points[k].rate > hi) hi = points[k].rate
    return hi
  }
  // |rise| / before × year / span > 50 %  ⇔  |rise| × year × 10⁴ > 5000 × before × span
  const readsAsJump = (rise: bigint, before: bigint, spanSeconds: number): boolean =>
    (rise < 0n ? -rise : rise) * YEAR_SECONDS * 10_000n > CATCHUP_ABSURD_APR_BPS * before * BigInt(spanSeconds)
  // The trailing-24h rise of moves[i..k] ending at moves[k] runs at ≥ 25 % APR.
  const trailingPasses = (i: number, k: number): boolean => {
    const at = moves[k]
    let rise = 0n
    for (let q = i; q <= k; q++) if (moves[q].ts > at.ts - CATCHUP_TRAILING_SECONDS) rise += moves[q].after - moves[q].before
    // rise/before × year/24h ≥ 25 %  ⇔  rise × year × 10⁴ ≥ 2500 × before × 24h
    return rise * YEAR_SECONDS * 10_000n >= CATCHUP_RAMP_MIN_APR_BPS * at.before * BigInt(CATCHUP_TRAILING_SECONDS)
  }
  let prevTs = leadTs ?? points[0].ts
  // The rate's running HIGH-WATER MARK, raised by measured segments only. A source that replaced another at a new
  // level starts it at its LOWEST row of its first day: the peg may still be settling off the old source (wstETH
  // 2025-07-11: the first MMOracle row 1.20894 still carried the relayed price, the next 1.20782 was the rate).
  let hwm = leadMark != null && leadMark > points[0].rate ? leadMark : points[0].rate
  if (leadTs == null && source !== 0) {
    for (const p of points) { if (p.ts >= points[0].ts + PEG_SOURCE_SETTLE_SECONDS) break; if (p.rate < hwm) hwm = p.rate }
  }
  let lastPriceLikeTs = Number.NEGATIVE_INFINITY
  let i = 0
  while (i < moves.length) {
    const first = moves[i]
    const flat = first.ts - prevTs
    let j = i
    let decided = true
    const episode = flat >= CATCHUP_MIN_FLAT_SECONDS
      || (flat >= CATCHUP_FAST_MIN_FLAT_SECONDS && first.after > first.before && readsAsJump(first.after - first.before, first.before, Math.max(PEG_JUMP_MIN_SPAN_SECONDS, flat)))
    if (episode) {
      while (j + 1 < moves.length) {
        const next = moves[j + 1]
        if (next.ts - first.ts > CATCHUP_MAX_SECONDS) break
        // A move held at the pool's tight cap is still chasing its target: it joins however long the pool sat untouched.
        if (!pegCapBound(next).atCap) {
          if (next.ts - moves[j].ts >= CATCHUP_LINK_GAP_SECONDS) break
          if (next.ts - first.ts >= CATCHUP_TRAILING_SECONDS && !trailingPasses(i, j + 1)) break
        }
        j++
      }
      decided = j + 1 < moves.length || closed || headTs - moves[j].ts >= CATCHUP_LINK_GAP_SECONDS
    }
    if (!decided) break
    const endTs = moves[j].ts
    const before = first.before
    const after = moves[j].after
    const span = Math.max(episode ? CATCHUP_JUMP_MIN_SPAN_SECONDS : PEG_JUMP_MIN_SPAN_SECONDS, endTs - prevTs)
    let capLimited = after > before
    for (let k = i; k <= j && capLimited; k++) capLimited = pegCapBound(moves[k]).within
    let kind: PegSegmentKind
    let rise = 0n
    if (after * 10_000n < highAt(endTs) * (10_000n - PEG_GIVE_BACK_BPS)) { kind = 'gave-back'; lastPriceLikeTs = endTs }
    else if (!capLimited && readsAsJump(after - before, before, span)) { kind = 'jump'; lastPriceLikeTs = endTs }
    // Quarantine runs from the last price-like segment itself, never from a quarantined one (it would never end).
    else if (endTs - lastPriceLikeTs < PEG_JUMP_QUARANTINE_SECONDS) kind = 'jump'
    else {
      // The mark a measured segment books above: the running high, or its own start when an unmeasured stretch lifted it.
      const base = before > hwm ? before : hwm
      if (after <= base) kind = 'under-high-water'
      else {
        kind = flat >= STALE_PEG_SECONDS ? 'catchup' : 'accrual'
        rise = after - base
        hwm = after
      }
    }
    out.push({ startTs: prevTs, endTs, rise, kind, moves: j - i + 1, ...src })
    prevTs = endTs
    i = j + 1
  }
  if (!closed) out.push({ startTs: prevTs, endTs: PEG_OPEN_END, rise: 0n, kind: 'pending', moves: moves.length - i, ...src })
  return { tailTs: prevTs, mark: hwm }
}

/**
 * The part of a segment's rise that accrued in [from, to): a cumulative floor
 * of the time fraction, so the parts of any partition of the segment sum to its
 * rise exactly, whichever window computes them.
 */
export function segmentRiseIn(seg: PegSegment, from: number, to: number): bigint {
  if (seg.endTs === PEG_OPEN_END) return 0n
  const L = BigInt(Math.max(1, seg.endTs - seg.startTs))
  const F = (t: number): bigint => {
    const c = t <= seg.startTs ? 0 : t >= seg.endTs ? seg.endTs - seg.startTs : t - seg.startTs
    return (seg.rise * BigInt(c)) / L
  }
  return F(to) - F(from)
}

/** A segment's identity for the staleness fingerprints (FNV-1a 64 over its fields). */
export function pegSegmentHash(token: number, seg: PegSegment, rule = 0): bigint {
  // An open segment is identified by where it starts only: moves joining an undecided episode re-mark nothing.
  // The peg source the segment belongs to is part of it: a source change re-marks the buckets its segments span.
  // So is the token's own booking-rule version (AccruingToken.ruleVersion; 0 leaves the identity as it was).
  const src = (seg.source ? `|src:${seg.source}` : '') + (seg.via ? `|via:${seg.via}` : '') + (rule ? `|rule:${rule}` : '')
  const s = seg.endTs === PEG_OPEN_END ? `${token}|pending|${seg.startTs}${src}` : `${token}|${seg.kind}|${seg.startTs}|${seg.endTs}|${seg.rise}${src}`
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn }
  return h
}
