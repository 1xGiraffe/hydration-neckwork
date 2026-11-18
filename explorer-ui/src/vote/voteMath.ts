// The arithmetic of a vote, with no chain client and no React: conviction stops,
// lock lengths, the amount presets and what a vote does to a tally. Amounts are
// planck bigints (HDX has 12 decimals); nothing here goes through floating point
// except the percentages a reader sees.

export const HDX_DECIMALS = 12
export const ONE_HDX = 10n ** 12n

/** Conviction 0..6: its multiplier in tenths and the lock periods a won vote carries (pallet conviction-voting). */
export const CONVICTIONS = [
  { conviction: 0, label: '0.1×', tenths: 1n, periods: 0 },
  { conviction: 1, label: '1×', tenths: 10n, periods: 1 },
  { conviction: 2, label: '2×', tenths: 20n, periods: 2 },
  { conviction: 3, label: '3×', tenths: 30n, periods: 4 },
  { conviction: 4, label: '4×', tenths: 40n, periods: 8 },
  { conviction: 5, label: '5×', tenths: 50n, periods: 16 },
  { conviction: 6, label: '6×', tenths: 60n, periods: 32 },
] as const

export type Conviction = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** The vote byte of a Standard vote: the aye bit (0x80) over the conviction. */
export function voteByte(aye: boolean, conviction: Conviction): number {
  return (aye ? 0x80 : 0) | conviction
}

export function decodeVoteByte(byte: number): { aye: boolean; conviction: Conviction } {
  return { aye: (byte & 0x80) !== 0, conviction: Math.min(6, byte & 0x7f) as Conviction }
}

/** Votes counted: balance × multiplier (0.1× for no conviction). */
export function weighted(balance: bigint, conviction: Conviction): bigint {
  return balance * CONVICTIONS[conviction].tenths / 10n
}

/** How many blocks a won vote at this conviction stays locked after the referendum ends. */
export function lockBlocks(conviction: Conviction, voteLockingPeriod: number): number {
  return CONVICTIONS[conviction].periods * voteLockingPeriod
}

// ---- vote shapes ------------------------------------------------------------

export type Direction = 'aye' | 'nay' | 'abstain'

/** The AccountVote a composer choice encodes to. Abstain is SplitAbstain with only the abstain part. */
export type VoteSpec =
  | { kind: 'Standard'; aye: boolean; conviction: Conviction; balance: bigint }
  | { kind: 'Split'; aye: bigint; nay: bigint }
  | { kind: 'SplitAbstain'; aye: bigint; nay: bigint; abstain: bigint }

export function voteSpec(direction: Direction, balance: bigint, conviction: Conviction): VoteSpec {
  if (direction === 'abstain') return { kind: 'SplitAbstain', aye: 0n, nay: 0n, abstain: balance }
  return { kind: 'Standard', aye: direction === 'aye', conviction, balance }
}

/** The HDX a vote puts up (and locks while the referendum runs). */
export function voteCapital(v: VoteSpec): bigint {
  return v.kind === 'Standard' ? v.balance : v.kind === 'Split' ? v.aye + v.nay : v.aye + v.nay + v.abstain
}

/**
 * What a vote adds to a tally (pallet conviction-voting Tally::add): a Standard aye
 * adds its weight to ayes and its capital to support, a nay only its weight to nays;
 * split parts count at 0.1× as votes but at their full capital toward support, and
 * abstain counts toward support only.
 */
export function tallyDelta(v: VoteSpec): { ayes: bigint; nays: bigint; support: bigint } {
  if (v.kind === 'Standard') {
    const w = weighted(v.balance, v.conviction)
    return v.aye ? { ayes: w, nays: 0n, support: v.balance } : { ayes: 0n, nays: w, support: 0n }
  }
  const tenth = (x: bigint) => x / 10n
  if (v.kind === 'Split') return { ayes: tenth(v.aye), nays: tenth(v.nay), support: v.aye }
  return { ayes: tenth(v.aye), nays: tenth(v.nay), support: v.aye + v.abstain }
}

export interface Tally { ayes: bigint; nays: bigint; support: bigint }

/** The tally after replacing `previous` (the account's standing vote, if any) with `next`. */
/**
 * The tally after replacing `previous` (the account's standing vote, if any) with
 * `next`. Votes delegated to the account (`delegations`) follow its Standard vote —
 * the pallet adds them with it (Tally::increase) and takes them away when it changes
 * side or turns into a split — so they move too.
 */
export function tallyAfter(tally: Tally, next: VoteSpec | null, previous: VoteSpec | null, delegations?: { votes: bigint; capital: bigint }): Tally {
  const out = { ...tally }
  const del = (v: VoteSpec | null, sign: 1n | -1n) => {
    if (!delegations || !v || v.kind !== 'Standard') return
    if (v.aye) { out.ayes += sign * delegations.votes; out.support += sign * delegations.capital } else out.nays += sign * delegations.votes
  }
  if (previous) {
    const d = tallyDelta(previous)
    out.ayes -= d.ayes; out.nays -= d.nays; out.support -= d.support
    del(previous, -1n)
  }
  if (next) {
    const d = tallyDelta(next)
    out.ayes += d.ayes; out.nays += d.nays; out.support += d.support
    del(next, 1n)
  }
  for (const k of ['ayes', 'nays', 'support'] as const) if (out[k] < 0n) out[k] = 0n
  return out
}

/** Approval and support as fractions (0..1); approval is null with no votes either way. */
export function tallyShares(t: Tally, electorate: bigint): { approval: number | null; support: number | null } {
  const total = t.ayes + t.nays
  return {
    approval: total > 0n ? Number(t.ayes * 1_000_000n / total) / 1_000_000 : null,
    support: electorate > 0n ? Number(t.support * 1_000_000_000n / electorate) / 1_000_000_000 : null,
  }
}

// ---- amounts ----------------------------------------------------------------

/** "1,234.5" / "1234.5" HDX → planck; null when it is not a plain decimal or has more than 12 decimals. */
export function parseHdx(input: string): bigint | null {
  const t = input.trim().replace(/[,_\s]/g, '')
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t)
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null
  const frac = m[2] ?? ''
  if (frac.length > HDX_DECIMALS) return null
  return BigInt(m[1] || '0') * ONE_HDX + BigInt(frac.padEnd(HDX_DECIMALS, '0') || '0')
}

/** Planck → a plain decimal HDX string for an input field ("1234.5"), never compacted. */
export function formatHdxInput(planck: bigint): string {
  const neg = planck < 0n
  const v = neg ? -planck : planck
  const whole = v / ONE_HDX
  const frac = (v % ONE_HDX).toString().padStart(HDX_DECIMALS, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/**
 * Planck → a readable HDX figure with grouping and up to `decimals` decimals (rounded
 * down), for sentences where the exact amount matters ("keeps 2.5 HDX free").
 */
export function formatHdx(planck: bigint, decimals = 4): string {
  const v = planck < 0n ? -planck : planck
  const whole = (v / ONE_HDX).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = (v % ONE_HDX).toString().padStart(HDX_DECIMALS, '0').slice(0, decimals).replace(/0+$/, '')
  return `${planck < 0n ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/**
 * The HDX side of an account as the chain sees it (System.Account): free and
 * reserved add up to the total a vote may use (pallet conviction-voting checks
 * `vote ≤ total_balance`); `frozen` is the largest lock (staking, vesting, votes…).
 */
export interface HdxAccount { free: bigint; reserved: bigint; frozen: bigint }

export function totalBalance(a: HdxAccount): bigint { return a.free + a.reserved }

/**
 * What the account can still spend (fees included) with a lock of `lock` in place —
 * pallet balances' reducible balance: free minus the part frozen beyond what is
 * reserved, never below the existential deposit.
 */
export function spendableWith(a: HdxAccount, lock: bigint, existentialDeposit: bigint): bigint {
  const frozen = a.frozen > lock ? a.frozen : lock
  const lockedFree = frozen > a.reserved ? frozen - a.reserved : 0n
  const untouchable = lockedFree > existentialDeposit ? lockedFree : existentialDeposit
  return a.free > untouchable ? a.free - untouchable : 0n
}

export const DEFAULT_RESERVE = 2n * ONE_HDX

/**
 * The amount presets for one account.
 *  - full: every HDX the chain lets this account vote with. When the account also
 *    pays this transaction's fee in HDX, the fee leaves before the vote is checked,
 *    so it (with headroom) comes off the top.
 *  - almostFull: full minus the reserve, which stays unlocked for later fees.
 * Both are rounded down to 0.01 HDX.
 * `feeInHdxFromActor` is the fee this signature takes from the voting account in HDX
 * (0 when another account signs, through a proxy, or the fee is paid in another asset).
 */
export function amountPresets(a: HdxAccount, opts: { feeInHdxFromActor: bigint; reserve: bigint }): { full: bigint; almostFull: bigint } {
  const total = totalBalance(a)
  const feeHeadroom = opts.feeInHdxFromActor > 0n ? opts.feeInHdxFromActor * 2n : 0n
  const full = total > feeHeadroom ? total - feeHeadroom : 0n
  const almost = total > opts.reserve + feeHeadroom ? total - opts.reserve - feeHeadroom : 0n
  // Rounded down to 0.01 HDX, so the field reads as an amount rather than dust.
  const step = ONE_HDX / 100n
  return { full: (full / step) * step, almostFull: (almost / step) * step }
}

/**
 * The reserve suggested for "almost full": 2 HDX, or three rounds of a vote's fee and
 * a later clean-up's fee when that is more — enough to remove the vote and unlock it
 * later without topping up.
 */
export function suggestedReserve(voteFee: bigint | null, cleanupFee: bigint | null): bigint {
  const three = 3n * ((voteFee ?? 0n) + (cleanupFee ?? 0n))
  return three > DEFAULT_RESERVE ? three : DEFAULT_RESERVE
}

/** Round up to 0.1 HDX, for a reserve suggestion that reads cleanly. */
export function roundUpTenth(planck: bigint): bigint {
  const step = ONE_HDX / 10n
  return ((planck + step - 1n) / step) * step
}

/** Any asset amount in its own decimals as a grouped decimal string with at most `shown` decimals (rounded down). */
export function formatUnits(value: bigint, decimals: number, shown = 4): string {
  const scale = 10n ** BigInt(decimals)
  const v = value < 0n ? -value : value
  const whole = (v / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = decimals > 0 ? (v % scale).toString().padStart(decimals, '0').slice(0, shown).replace(/0+$/, '') : ''
  return `${value < 0n ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}
