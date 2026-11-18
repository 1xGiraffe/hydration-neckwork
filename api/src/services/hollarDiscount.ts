import type { ClickHouseClient } from '../db/client.ts'
import { RAY } from './aaveMath.ts'

// HOLLAR's variable-debt tokens are GHO debt tokens: a borrower the token's discount
// strategy enrols (Juicer's JuicerDiscount — the strategy's Main vaults at one rate, its
// shared loop at another) is charged only (1 − rate) of the interest its debt accrues.
// The token keeps the rate per borrower, cached between actions, and realizes the
// discount at the borrower's next action (a borrow, a repayment, a rate refresh) by
// BURNING scaled debt. Nothing in the action's Mint/Burn states that burn — the
// event's amounts are the principal plus the NET interest settled — so every model
// built on the scaled deltas (atoken_scaled_deltas) carries a discounted borrower's
// debt above the chain's by every burn, and books the full-rate interest on it.
//
// This module folds the discount back, exactly, from the token's own logs
// (hollar_debt_logs, 025_hollar_debt_logs.sql), with the token's own arithmetic
// (GhoVariableDebtToken._accrueDebtOnAction):
//   full     = rayMul(S, index) − rayMul(S, userIndex)   S the scaled balance, userIndex the index of its last action
//   discount = percentMul(full, rate)                     rate the cached percent (bps)
//   burned   = rayDiv(discount, index)                    scaled debt the action burns
//   balanceIncrease (the event's) = full − discount       the check: every action is verified against it
// The cached rate is the one in force BEFORE the action: the token accrues first, then
// refreshes the rate (DiscountPercentUpdated, emitted inside the action's own call,
// ahead of its Transfer and Mint/Burn logs), so a rate change applies from the action
// that emitted it onwards.
//
// What it yields per borrower: the burns (scaled, and in HOLLAR) and the rate as a step
// function over blocks — what hollar_borrow subtracts from the market's accrual, and
// what the User Revenue money-market walk applies to the borrower's own interest.

/** Every HOLLAR variable-debt token (core, GIGAHDX, BIL) — hollar_debt_logs_mv's contract set, verbatim. */
export const HOLLAR_DEBT_TOKENS: readonly string[] = [
  '0x342923782ccaebf9c38dd9cb40436e82c42c73b5',
  '0x6f731562cbf2c0da50a10e5ac922b95b42204863',
  '0xfa8793b777f86df01a71f898d9c65a339aee54bf',
]

export const HOLLAR_DEBT_TOPIC = {
  Mint: '0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196',
  Burn: '0x4cf25bc1d991c17529c25213d3cc0cda295eeaad5f13f361969b12ea48015f90',
  DiscountPercentUpdated: '0x74ab9665e7c36c29ddb78ef88a3e2eac73d35b8b16de7bc573e313e320104956',
} as const

const T = HOLLAR_DEBT_TOPIC
const isDpu = `ifNull(raw_evm_logs.topic0, '') = '${T.DiscountPercentUpdated}'`
const word = (offset: number) => `reinterpretAsUInt256(reverse(unhex(substring(data, ${offset}, 64))))`

/** hollar_debt_logs_mv's WHERE, verbatim (and its DATA_UPGRADES entry's). */
export const HOLLAR_DEBT_LOGS_WHERE
  = `raw_evm_logs.topic0 IN ('${T.Mint}', '${T.Burn}', '${T.DiscountPercentUpdated}') AND lower(raw_evm_logs.contract_address) IN (${HOLLAR_DEBT_TOKENS.map(c => `'${c}'`).join(', ')}) AND length(topics) >= 3`

/** hollar_debt_logs_mv's SELECT, verbatim (and its DATA_UPGRADES entry's). */
export const HOLLAR_DEBT_LOGS_SELECT = [
  'lower(raw_evm_logs.contract_address) AS contract_address',
  `lower(concat('0x', substring(if(ifNull(raw_evm_logs.topic0, '') = '${T.Mint}', topics[3], topics[2]), 27, 40))) AS holder`,
  'block_height', 'event_index', 'block_timestamp',
  `multiIf(ifNull(raw_evm_logs.topic0, '') = '${T.Mint}', 'Mint', ifNull(raw_evm_logs.topic0, '') = '${T.Burn}', 'Burn', 'DiscountPercentUpdated') AS kind`,
  `if(${isDpu}, toUInt256(0), ${word(3)}) AS value`,
  `if(${isDpu}, toUInt256(0), ${word(67)}) AS balance_increase`,
  `if(${isDpu}, toUInt256(0), ${word(131)}) AS idx`,
  `if(${isDpu}, ${word(3)}, toUInt256(0)) AS pct_old`,
  `if(${isDpu}, reinterpretAsUInt256(reverse(unhex(substring(topics[3], 3, 64)))), toUInt256(0)) AS pct_new`,
  'ingested_at',
].join(', ')

const HALF_RAY = RAY / 2n
const PERCENT = 10_000n
const rayMul = (a: bigint, b: bigint): bigint => (a * b + HALF_RAY) / RAY
const rayDiv = (a: bigint, b: bigint): bigint => (a * RAY + b / 2n) / b
const percentMul = (v: bigint, pct: bigint): bigint => (v * pct + PERCENT / 2n) / PERCENT

export interface HollarDebtLog {
  contract: string
  holder: string
  block: number
  eventIndex: number
  /** Unix seconds. */
  ts: number
  kind: 'Mint' | 'Burn' | 'DiscountPercentUpdated'
  value: bigint
  balanceIncrease: bigint
  index: bigint
  pctOld: bigint
  pctNew: bigint
}

/** One action's realized discount: the scaled debt it burned, and that in HOLLAR. */
export interface DiscountBurn { block: number; eventIndex: number; ts: number; scaled: bigint; amount: bigint }

/** The cached rate (bps) from an action on: in force for every action after it, until the next step. */
export interface RateStep { block: number; eventIndex: number; ts: number; pct: bigint }

/**
 * A borrower's state after one block it logged in: the scaled debt the deltas still count
 * but the chain burned (cumulative), and rate × its true scaled balance (bps × scaled) —
 * the share of the interest accruing from there that it is excused.
 */
export interface DiscountSeriesPoint { ts: number; burned: bigint; rateScaled: bigint }

export interface HolderDiscount {
  contract: string
  holder: string
  burns: DiscountBurn[]
  /** Ascending; the rate before the first step is 0. */
  rates: RateStep[]
  /** After each block the borrower logged in, ascending by time (one point per second). */
  points: DiscountSeriesPoint[]
  /** The scaled balance the chain holds after the last folded log. */
  scaled: bigint
  /** Actions whose balanceIncrease disagreed with the fold (0 on an exact fold), and rate changes whose `old` disagreed. */
  mismatches: number
}

/**
 * The scaled delta an action's Mint/Burn states (atoken_scaled_deltas_mv's formula): the
 * principal alone, rayDiv(amount, index), with the burn the discount adds left out.
 */
export function principalScaledDelta(log: Pick<HollarDebtLog, 'kind' | 'value' | 'balanceIncrease' | 'index'>): bigint {
  const idx = log.index > 0n ? log.index : 1n
  if (log.kind === 'Mint') {
    return log.value >= log.balanceIncrease
      ? rayDiv(log.value - log.balanceIncrease, idx)
      : -rayDiv(log.balanceIncrease - log.value, idx)
  }
  return -rayDiv(log.value + log.balanceIncrease, idx)
}

/**
 * Folds one borrower's logs on one debt token (every log of theirs, chain order) into
 * its discount burns and rate steps. Pure; the fold starts from a zero balance, so the
 * logs must reach back to the borrower's first action.
 */
export function foldHolderDiscount(logs: readonly HollarDebtLog[]): HolderDiscount | null {
  if (!logs.length) return null
  const sorted = [...logs].sort((a, b) => a.block - b.block || a.eventIndex - b.eventIndex)
  const { contract, holder } = sorted[0]
  let S = 0n
  let userIndex = 0n
  let pct = 0n
  let pending: RateStep | null = null
  let mismatches = 0
  let burnedTotal = 0n
  const burns: DiscountBurn[] = []
  const rates: RateStep[] = []
  const points: DiscountSeriesPoint[] = []
  const settle = () => { if (pending) { pct = pending.pct; rates.push(pending); pending = null } }
  const mark = (i: number) => {
    // One point per block, after its last log (a rate change applies from its action on).
    if (i + 1 < sorted.length && sorted[i + 1].block === sorted[i].block) return
    const p = { ts: sorted[i].ts, burned: burnedTotal, rateScaled: (pending?.pct ?? pct) * (S > 0n ? S : 0n) }
    if (points.length && points[points.length - 1].ts === p.ts) points[points.length - 1] = p
    else points.push(p)
  }
  for (let i = 0; i < sorted.length; i++) {
    const log = sorted[i]
    if (log.kind === 'DiscountPercentUpdated') {
      // A refresh whose action logged no Mint/Burn after it (never seen) applies at once.
      settle()
      if (log.pctOld !== pct) mismatches++
      pending = { block: log.block, eventIndex: log.eventIndex, ts: log.ts, pct: log.pctNew }
      mark(i)
      continue
    }
    const full = S > 0n && userIndex > 0n ? rayMul(S, log.index) - rayMul(S, userIndex) : 0n
    const discount = full > 0n && pct > 0n ? percentMul(full, pct) : 0n
    if ((full > 0n ? full - discount : 0n) !== log.balanceIncrease) mismatches++
    const burned = discount > 0n ? rayDiv(discount, log.index) : 0n
    S += principalScaledDelta(log) - burned
    userIndex = log.index
    burnedTotal += burned
    if (burned > 0n) burns.push({ block: log.block, eventIndex: log.eventIndex, ts: log.ts, scaled: burned, amount: discount })
    // The rate this action's refresh set applies from here on.
    if (pending && pending.block === log.block) settle()
    mark(i)
  }
  settle()
  return { contract, holder, burns, rates, points, scaled: S, mismatches }
}

/** The rate in force for interest accruing after (block, eventIndex): the last step at or before it. */
export function rateAt(rates: readonly RateStep[], block: number, eventIndex = Number.MAX_SAFE_INTEGER): bigint {
  let pct = 0n
  for (const r of rates) {
    if (r.block > block || (r.block === block && r.eventIndex > eventIndex)) break
    pct = r.pct
  }
  return pct
}

interface LogRow { c: string; h: string; b: string; e: string; ts: string; k: string; v: string; bi: string; i: string; po: string; pn: string }

/**
 * Every discounted borrower's fold, up to a block or an instant: the borrowers a
 * DiscountPercentUpdated ever named, each with its whole history on that token. A few
 * accounts (the enrolled vaults and the loop, at most 17 per token), so the read is a
 * handful of primary-key ranges.
 */
export async function loadHollarDiscounts(client: ClickHouseClient, upTo: { block: number } | { seconds: number }): Promise<HolderDiscount[]> {
  const bound = 'block' in upTo
    ? { sql: 'block_height <= {to:UInt32}', params: { to: upTo.block } }
    : { sql: 'block_timestamp <= toDateTime({to:UInt32})', params: { to: upTo.seconds } }
  const res = await client.query({
    query: `-- hollar:discounts
      SELECT contract_address AS c, holder AS h, block_height AS b, event_index AS e, toUnixTimestamp(any(block_timestamp)) AS ts,
             argMax(kind, ingested_at) AS k, toString(argMax(value, ingested_at)) AS v, toString(argMax(balance_increase, ingested_at)) AS bi,
             toString(argMax(idx, ingested_at)) AS i, toString(argMax(pct_old, ingested_at)) AS po, toString(argMax(pct_new, ingested_at)) AS pn
      FROM price_data.hollar_debt_logs
      WHERE (contract_address, holder) IN (
          SELECT DISTINCT contract_address, holder FROM price_data.hollar_debt_logs WHERE kind = 'DiscountPercentUpdated' AND ${bound.sql})
        AND ${bound.sql}
      GROUP BY c, h, b, e
      ORDER BY c, h, b, e`,
    query_params: bound.params,
    format: 'JSONEachRow',
  })
  const byHolder = new Map<string, HollarDebtLog[]>()
  for (const r of await res.json<LogRow>()) {
    const key = `${r.c}|${r.h}`
    const list = byHolder.get(key) ?? []
    list.push({
      contract: r.c, holder: r.h, block: Number(r.b), eventIndex: Number(r.e), ts: Number(r.ts),
      kind: r.k as HollarDebtLog['kind'], value: BigInt(r.v), balanceIncrease: BigInt(r.bi), index: BigInt(r.i),
      pctOld: BigInt(r.po), pctNew: BigInt(r.pn),
    })
    byHolder.set(key, list)
  }
  const out: HolderDiscount[] = []
  for (const logs of byHolder.values()) {
    const fold = foldHolderDiscount(logs)
    if (!fold) continue
    if (fold.mismatches) console.warn(`[hollar-discount] ${fold.contract} ${fold.holder}: ${fold.mismatches} log(s) disagree with the fold`)
    out.push(fold)
  }
  return out
}

/**
 * Per debt token, the discounted borrowers' part of the market's indexed accrual as a
 * step function of time: at each point, Σ burned-so-far and Σ rate × true scaled. The
 * market accrual over an index move Δi from a moment t (debt_scaled × Δi / RAY, the
 * scaled debt the deltas state) is overstated by (burned(t) + rateScaled(t) / 10⁴) × Δi
 * / RAY — the burned debt no longer accrues, and the rest accrues at (1 − rate).
 */
export function discountSeries(folds: readonly HolderDiscount[]): Map<string, DiscountSeriesPoint[]> {
  const out = new Map<string, DiscountSeriesPoint[]>()
  const byContract = new Map<string, HolderDiscount[]>()
  for (const f of folds) byContract.set(f.contract, [...(byContract.get(f.contract) ?? []), f])
  for (const [contract, list] of byContract) {
    const times = [...new Set(list.flatMap(f => f.points.map(p => p.ts)))].sort((a, b) => a - b)
    const cursor = list.map(() => -1)
    const points: DiscountSeriesPoint[] = []
    for (const t of times) {
      let burned = 0n, rateScaled = 0n
      list.forEach((f, i) => {
        while (cursor[i] + 1 < f.points.length && f.points[cursor[i] + 1].ts <= t) cursor[i]++
        if (cursor[i] >= 0) { burned += f.points[cursor[i]].burned; rateScaled += f.points[cursor[i]].rateScaled }
      })
      points.push({ ts: t, burned, rateScaled })
    }
    out.set(contract, points)
  }
  return out
}

/** The step function's value at or before `ts` (zeros before its first point). */
export function seriesAt(points: readonly DiscountSeriesPoint[] | undefined, ts: number): { burned: bigint; rateScaled: bigint } {
  let value = { burned: 0n, rateScaled: 0n }
  for (const p of points ?? []) {
    if (p.ts > ts) break
    value = p
  }
  return value
}
