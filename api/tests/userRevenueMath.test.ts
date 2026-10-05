import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OMNI_FIXED, omnipoolRemoveLiquidity } from '../src/services/lpMath.ts'
import {
  FIXED_U128_ONE,
  OMNIPOOL_AT_SPOT_CAPTURE,
  farmAccrual,
  formatUsd1e12,
  gigahdxBookings,
  interpolateRpvs,
  omnipoolCapture,
  omnipoolPositionIncome,
  parseUsd1e12,
  PEG_OPEN_END,
  pegCapBound,
  pegContinuous,
  pegSegmentHash,
  pegSegments,
  segmentRiseIn,
  type PegPoint,
  splitProRata,
  stakingGross,
  usd1e12,
} from '../src/services/userRevenueMath.ts'

// The aDOT sub-pool at grid block 15,363,000 (raw): the state omni_half measured ½ on.
const R = 14943466928366071n
const Q = 298026602711447529n
const S = 17532284339008871n

/** A position of 1% of the shares entered at x = spot / entry. */
function positionAt(x: number) {
  // entry price p_x = p / x, p = Q/R; as FixedU128: Q·1e18 / (R·x)
  const priceRaw = (Q * OMNI_FIXED * 1_000_000n) / (R * BigInt(Math.round(x * 1_000_000)))
  return { assetId: 1001, amount: 0n, shares: S / 100n, priceNum: priceRaw, priceDen: OMNI_FIXED }
}

/** The payoff valued at FIXED prices (asset at the state's spot Q/R, H2O at 1), in hub units ×1e18. */
function value(st: { reserve: bigint; hub: bigint; shares: bigint }, pos: ReturnType<typeof positionAt>): bigint {
  const { liquidity, hub } = omnipoolRemoveLiquidity(st, pos)
  return liquidity * Q * OMNI_FIXED / R + hub * OMNI_FIXED
}

/** The probe of the design: Δ payoff value for a small inflow ε, over ε's value, as a ratio to the pro-rata slice s/S. */
function probe(kind: 'asset' | 'hub', x: number): number {
  const pos = positionAt(x)
  const base = { reserve: R, hub: Q, shares: S }
  const eps = kind === 'asset' ? R / 1_000_000n : Q / 1_000_000n
  const moved = kind === 'asset' ? { ...base, reserve: R + eps } : { ...base, hub: Q + eps }
  const dv = value(moved, pos) - value(base, pos)
  const epsValue = kind === 'asset' ? eps * Q * OMNI_FIXED / R : eps * OMNI_FIXED
  return Number(dv) / Number(epsValue) / (Number(pos.shares) / Number(S))
}

const ratio = (c: { num: bigint; den: bigint }) => Number(c.num * 10n ** 18n / c.den) / 1e18

describe('Omnipool capture c(x) — the closed form against the repo payoff (lpMath.omnipoolRemoveLiquidity)', () => {
  for (const kind of ['asset', 'hub'] as const) {
    for (const x of [0.25, 0.5, 0.9, 0.999, 1, 1.001, 1.25, 2, 4]) {
      it(`${kind} inflow, x = ${x}: the derivative matches the payoff's response to a 1e-6 probe`, () => {
        const pos = positionAt(x)
        const cap = omnipoolCapture(kind, R, Q, pos.priceNum)
        expect(Math.abs(ratio(cap) - probe(kind, x))).toBeLessThan(1e-4)
      })
    }
  }

  it('is ½ at the entry price for both inflow kinds (the measured 0.49975 on aDOT)', () => {
    const pos = positionAt(1)
    expect(ratio(omnipoolCapture('asset', R, Q, pos.priceNum))).toBeCloseTo(0.5, 5)
    expect(ratio(omnipoolCapture('hub', R, Q, pos.priceNum))).toBeCloseTo(0.5, 5)
    expect(OMNIPOOL_AT_SPOT_CAPTURE.num * 2n).toBe(OMNIPOOL_AT_SPOT_CAPTURE.den)
  })

  it('states the design formulas: 2x²/(1+x)², (1+x²)/(1+x)², 2x/(1+x)², (x²+2x−1)/(1+x)²', () => {
    const f = (x: number, kind: 'asset' | 'hub') => (kind === 'asset'
      ? (x <= 1 ? 2 * x * x : 1 + x * x)
      : (x <= 1 ? 2 * x : x * x + 2 * x - 1)) / (1 + x) ** 2
    for (const x of [0.3, 0.8, 1.5, 3]) {
      const pos = positionAt(x)
      expect(ratio(omnipoolCapture('asset', R, Q, pos.priceNum))).toBeCloseTo(f(x, 'asset'), 5)
      expect(ratio(omnipoolCapture('hub', R, Q, pos.priceNum))).toBeCloseTo(f(x, 'hub'), 5)
    }
  })

  it('matches the exact payoff difference over a real-sized inflow to < 1e-4 relative (V3b shape)', () => {
    for (const x of [0.7, 1, 1.4]) {
      const pos = positionAt(x)
      const D = R / 2_000n // a 0.05% fee inflow
      const exact = value({ reserve: R + D, hub: Q, shares: S }, pos) - value({ reserve: R, hub: Q, shares: S }, pos)
      const booked = omnipoolPositionIncome(D, omnipoolCapture('asset', R, Q, pos.priceNum), pos.shares, S) * Q * OMNI_FIXED / R
      expect(Math.abs(Number(booked - exact) / Number(exact))).toBeLessThan(1e-3)
    }
  })

  it('books D·c·s/S with a single floor, and nothing for an empty or unpriced state', () => {
    expect(omnipoolPositionIncome(1000n, { num: 1n, den: 2n }, 3n, 10n)).toBe(150n)
    expect(omnipoolPositionIncome(1000n, { num: 1n, den: 3n }, 1n, 7n)).toBe(47n) // 1000/21 floored once
    expect(omnipoolCapture('asset', 0n, Q, 1n)).toEqual({ num: 0n, den: 1n })
    expect(omnipoolPositionIncome(1000n, { num: 1n, den: 2n }, 0n, 10n)).toBe(0n)
  })
})

describe('splitProRata', () => {
  it('splits exactly by cumulative floors, in order, for positive and negative totals', () => {
    const w: Array<[string, bigint]> = [['a', 1n], ['b', 1n], ['c', 1n]]
    const pos = splitProRata(100n, w)
    expect(pos.reduce((s, [, v]) => s + v, 0n)).toBe(100n)
    expect(pos).toEqual([['a', 33n], ['b', 33n], ['c', 34n]])
    const neg = splitProRata(-100n, w)
    expect(neg.reduce((s, [, v]) => s + v, 0n)).toBe(-100n)
  })
  it('skips non-positive weights and splits nothing over no weight', () => {
    expect(splitProRata(10n, [['a', 0n], ['b', -5n]])).toEqual([])
    expect(splitProRata(10n, [['a', 0n], ['b', 2n]])).toEqual([['b', 10n]])
  })
})

describe('valuation', () => {
  it('values amount × close / 10^decimals at 1e-12 USD, truncating toward zero', () => {
    expect(usd1e12(15n * 10n ** 9n, 4_500_000_000_000n, 10)).toBe(6_750_000_000_000n) // 1.5 DOT × $4.5
    expect(usd1e12(-15n * 10n ** 9n, 4_500_000_000_000n, 10)).toBe(-6_750_000_000_000n)
    expect(usd1e12(1n, 1n, 12)).toBe(0n)
  })
  it('round-trips the Decimal(38,12) wire form', () => {
    for (const v of [0n, 1n, -1n, 123_456_789_012_345n, -(10n ** 20n)]) expect(parseUsd1e12(formatUsd1e12(v))).toBe(v)
    expect(parseUsd1e12('12.5')).toBe(12_500_000_000_000n)
  })
})

describe('legacy staking', () => {
  it('books the gross stake × Δrps (FixedU128) and nothing for a falling or equal rps', () => {
    expect(stakingGross(10n ** 15n, FIXED_U128_ONE, 2n * FIXED_U128_ONE)).toBe(10n ** 15n)
    expect(stakingGross(10n ** 15n, 2n, 1n)).toBe(0n)
    expect(stakingGross(0n, 1n, 2n)).toBe(0n)
  })
})

describe('GIGAHDX opening inflow', () => {
  it('books the opening stock and every zero-supply inflow once, at the first supply block, by END-of-block holdings', () => {
    const b = gigahdxBookings([{ block: 10, amount: 5n }, { block: 12, amount: 7n }, { block: 20, amount: 3n }], 100n, 12)
    expect(b).toEqual([
      { block: 12, amount: 112n, endOfBlock: true, opening: true },
      { block: 20, amount: 3n, endOfBlock: false, opening: false },
    ])
  })
  it('books nothing before any supply exists (no division by a zero supply is reachable)', () => {
    expect(gigahdxBookings([{ block: 10, amount: 5n }], 100n, null)).toEqual([])
  })
})

describe('farm rewards', () => {
  const s0 = { period: 100, rpvs: 1_000n }
  const s1 = { period: 200, rpvs: 2_000n }
  it('interpolates linearly between syncs while funded', () => {
    expect(interpolateRpvs(s0, s1, 150, 10n)).toBe(1_500n)
    expect(interpolateRpvs(s0, s1, 150, null)).toBe(1_500n)
    expect(interpolateRpvs(s0, s1, 99, 10n)).toBe(1_000n)
    expect(interpolateRpvs(s0, s1, 250, 10n)).toBe(2_000n)
  })
  it('a pot that ran dry accrues at the funded rate up to p_dry and nothing after it', () => {
    // funded rate 20/period would have paid 2,000 over the gap; observed 1,000 → p_dry = 100 + 1000/20 = 150
    expect(interpolateRpvs(s0, s1, 125, 20n)).toBe(1_500n)
    expect(interpolateRpvs(s0, s1, 150, 20n)).toBe(2_000n)
    expect(interpolateRpvs(s0, s1, 180, 20n)).toBe(2_000n)
  })
  it('nets accrual as Δclaimable + claimed, and a termination as −claimable', () => {
    expect(farmAccrual(100n, 30n, 90n)).toBe(20n)
    expect(farmAccrual(70n, 0n, 0n)).toBe(-70n)
  })
})

describe('token rate segments (accrual when earned)', () => {
  const ONE = 10n ** 36n
  const D = 86_400
  const T0 = 1_780_000_000
  /** A 600-block grid every 20 min from T0 to `until`, the rate given by `rateAt(ts)`. */
  const grid = (until: number, rateAt: (ts: number) => bigint, step = 1_200): PegPoint[] => {
    const out: PegPoint[] = []
    for (let ts = T0; ts <= until; ts += step) out.push({ ts, rate: rateAt(ts) })
    return out
  }

  it('treats a re-encoded rate (under 1e-9 relative) as no move', () => {
    const noisy = grid(T0 + 20 * D, ts => ONE + (ts % 2400 === 0 ? 1n : 0n) * (ONE / 10n ** 12n))
    const segs = pegSegments(noisy)
    expect(segs).toEqual([{ startTs: T0, endTs: PEG_OPEN_END, rise: 0n, kind: 'pending', moves: 0 }])
  })

  it('spreads a stalled oracle\'s rate-limited catch-up ramp over the stretch it ends (PRIME: flat ~50 d, then capped steps)', () => {
    const rampFrom = T0 + 50 * D
    const step = ONE / 40_000n // 2.5e-5 per grid row
    const rampRows = 300 // ~4 days
    const points = grid(T0 + 60 * D, ts => ts < rampFrom ? ONE : ONE + step * BigInt(Math.min(rampRows, Math.floor((ts - rampFrom) / 1200) + 1)))
    const segs = pegSegments(points)
    expect(segs).toHaveLength(2)
    const [s, open] = segs
    expect(s.kind).toBe('catchup')
    expect(s.startTs).toBe(T0)
    expect(s.endTs).toBe(rampFrom + (rampRows - 1) * 1200)
    expect(s.rise).toBe(step * BigInt(rampRows))
    expect(s.moves).toBe(rampRows)
    expect(open.kind).toBe('pending')
    expect(open.startTs).toBe(s.endTs)
    // Every day of the flat stretch carries its even share, summing to the rise exactly.
    let total = 0n
    for (let t = T0; t < s.endTs; t += 3_600) total += segmentRiseIn(s, t, t + 3_600)
    expect(total).toBe(s.rise)
    const firstDay = segmentRiseIn(s, T0, T0 + D)
    expect(Number(firstDay) / Number(s.rise)).toBeCloseTo(D / (s.endTs - T0), 6)
  })

  it('keeps an ordinary moving peg one segment per move, each over its own interval, booked as accrual', () => {
    // A move every grid row at ~6 % APR.
    const points = grid(T0 + 2 * D, ts => ONE + (ONE / 10n ** 6n) * 2n * BigInt((ts - T0) / 1200))
    const segs = pegSegments(points)
    expect(segs.filter(s => s.kind === 'accrual')).toHaveLength(points.length - 1)
    expect(segs.at(-1)!.kind).toBe('pending')
    expect(segs[0]).toMatchObject({ startTs: T0, endTs: T0 + 1200, moves: 1 })
  })

  it('states a catch-up implying more than 50 % APR over its stretch as a price jump, and a fall over 1 % under the trailing high as give-back', () => {
    const jump = pegSegments(grid(T0 + 10 * D, ts => (ts < T0 + 4 * D ? ONE : ONE + ONE / 20n)))
    expect(jump[0].kind).toBe('jump')
    const fall = pegSegments(grid(T0 + 10 * D, ts => (ts < T0 + D ? ONE : ts < T0 + 2 * D ? ONE - ONE / 50n : ONE - (ONE * 15n) / 1000n)))
    expect(fall.map(s => s.kind)).toEqual(['gave-back', 'gave-back', 'pending'])
  })

  it('books only rises above the running high-water mark: a drop and its recovery net to zero, stated under-high-water', () => {
    const up = ONE / 10_000n
    const dip = ONE / 2_000n
    // hourly: +1bp, −5bp (a measured fall, under the give-back and jump bounds), back +5bp, then +1bp — only the two +1bp are yield
    const small = pegSegments(grid(T0 + 10 * 3_600, ts => {
      const k = Math.floor((ts - T0) / 3_600)
      return k < 1 ? ONE : k < 2 ? ONE + up : k < 3 ? ONE + up - dip : k < 4 ? ONE + up : ONE + 2n * up
    }))
    expect(small.map(x => x.kind)).toEqual(['accrual', 'under-high-water', 'under-high-water', 'accrual', 'pending'])
    expect(small.map(x => x.rise)).toEqual([up, 0n, 0n, up, 0n])
    // a give-back (−2 %, unmeasured) and its slow recovery (+0.1 %/day): the recovery books nothing, the rise past the old high does
    const day = (d: number) => (d === 0 ? ONE : d <= 21 ? ONE - ONE / 50n + (ONE / 1_000n) * BigInt(Math.min(20, d - 1)) : ONE + up)
    const big = pegSegments(grid(T0 + 23 * D, ts => day(Math.floor((ts - T0) / D)), D))
    const kinds = big.map(x => x.kind)
    expect(kinds.slice(0, 10)).toEqual(Array(10).fill('gave-back'))
    expect(kinds.slice(10, 21)).toEqual(Array(11).fill('under-high-water'))
    expect(kinds.slice(21)).toEqual(['accrual', 'pending'])
    expect(big.reduce((a, x) => a + x.rise, 0n)).toBe(up)
  })

  it('judges every segment for a jump, not only a catch-up: a single steep move is a price event, a steep hourly step of a moving oracle is not', () => {
    // flat one day, then +0.5 % in one row: it opens an episode (a burst after ≥ 12 h flat), decided once 36 h pass
    // with no move, and alone it still implies > 50 % APR judged over an episode's three days
    const steep = pegSegments(grid(T0 + 3 * D, ts => (ts < T0 + D ? ONE : ONE + ONE / 200n)))
    expect(steep.map(x => x.kind)).toEqual(['jump', 'pending'])
    expect(steep[0].rise).toBe(0n)
    // hourly steps of 3e-5 (an hourly oracle at ~26 % APR annualised per hour, but a few bp a day): ordinary accrual
    const oracle = pegSegments(grid(T0 + 2 * D, ts => ONE + (ONE / 100_000n) * 3n * BigInt(Math.floor((ts - T0) / 3_600)), 3_600))
    expect(oracle.filter(x => x.kind === 'accrual')).toHaveLength(48)
    expect(oracle.reduce((a, x) => a + x.rise, 0n)).toBe((ONE / 100_000n) * 3n * 48n)
  })

  it('books nothing of an oscillating price relay and never lets its peaks set the high-water mark (wstETH, July 2025)', () => {
    // A relay of ±0.6 % hourly around a level for 10 days (with small steps in between that alone would pass),
    // then the true rate: a plateau, then ~3 % APR moves every 6 h.
    const L = ONE + ONE / 5n // 1.2
    const osc = [0n, 6n, -3n, 7n, 7n, 2n, -5n, -5n, 4n, 0n] // per mille of 1 %, cycling hourly
    const relayEnd = T0 + 10 * D
    const plateau = L + L / 1_000n
    const step = L / 120_000n // ~0.0008 % per 6 h ≈ 3 % APR
    const rateAt = (ts: number): bigint => {
      if (ts < relayEnd) return L + (L * osc[Math.floor((ts - T0) / 3_600) % osc.length]) / 1_000n
      if (ts < relayEnd + 5 * D) return plateau
      return plateau + step * BigInt(Math.floor((ts - relayEnd - 5 * D) / (6 * 3_600)) + 1)
    }
    const points = grid(relayEnd + 15 * D, rateAt, 3_600)
    const segs = pegSegments(points)
    const relay = segs.filter(x => x.endTs <= relayEnd)
    expect(relay.length).toBeGreaterThan(100)
    expect(relay.every(x => x.kind === 'jump' || x.kind === 'gave-back')).toBe(true)
    expect(relay.reduce((a, x) => a + x.rise, 0n)).toBe(0n)
    // After the relay every move is measured and books exactly its own rise from the plateau: Σ = final − plateau.
    const after = segs.filter(x => x.startTs >= relayEnd && x.kind !== 'pending')
    expect(after.every(x => x.kind === 'accrual' || x.kind === 'catchup')).toBe(true)
    const final = points.at(-1)!.rate
    expect(segs.reduce((a, x) => a + x.rise, 0n)).toBe(final - plateau)
  })

  it('leaves an undecided episode pending from where it starts, its identity unchanged while moves join it', () => {
    const rampFrom = T0 + 20 * D
    const at = (rows: number) => pegSegments(grid(rampFrom + rows * 1200, ts => (ts < rampFrom ? ONE : ONE + (ONE / 40_000n) * BigInt(Math.floor((ts - rampFrom) / 1200) + 1))))
    const a = at(10)
    const b = at(20)
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ kind: 'pending', startTs: T0 })
    expect(pegSegmentHash(43, a[0])).toBe(pegSegmentHash(43, b[0]))
  })
})

describe('Omnipool PRICE-type inflow (a NAV wrapper\'s or a token rate\'s value per unit rising)', () => {
  it('captures the full amount at the entry price, about half of it as H2O', () => {
    const pos = positionAt(1)
    const c = omnipoolCapture('price', R, Q, pos.priceNum)
    expect(ratio(c)).toBeCloseTo(1, 4)
    // The half as H2O: after the arbitrage the payoff's hub leg is about half the gain.
    const shares = 10n ** 30n
    const p = { ...pos, shares }
    const k = 1_000_000_500_000n // √(1+1e-6) at 1e12
    const after = omnipoolRemoveLiquidity({ reserve: R * 10n ** 12n / k, hub: Q * k / 10n ** 12n, shares }, p)
    const gain = Number(Q) * 1e-6 // R·p·e in H2O
    expect(Number(after.hub) / gain).toBeGreaterThan(0.45)
    expect(Number(after.hub) / gain).toBeLessThan(0.55)
  })
  it('stays a full capture to first order on either side of the entry price', () => {
    for (const x of [0.5, 0.9, 1.1, 2]) {
      const c = ratio(omnipoolCapture('price', R, Q, positionAt(x).priceNum))
      expect(c).toBeGreaterThan(0.3)
      expect(c).toBeLessThan(1.5)
    }
  })
})

describe('farm configuration versions (the one in force per gap)', () => {
  it('uses the creation config before an update and an uncapped version after it, never the later config earlier', async () => {
    const { globalVersionAt } = await import('../src/services/userRevenueFarms.ts')
    const g = { versions: [
      { block: 100, yieldPerPeriod: 10n, maxRewardPerPeriod: 1_000n },
      { block: 200, yieldPerPeriod: 20n, maxRewardPerPeriod: null },
    ] }
    expect(globalVersionAt(g, 99)).toBeNull()
    expect(globalVersionAt(g, 150)).toEqual({ block: 100, yieldPerPeriod: 10n, maxRewardPerPeriod: 1_000n })
    expect(globalVersionAt(g, 199)!.yieldPerPeriod).toBe(10n)
    expect(globalVersionAt(g, 200)).toEqual({ block: 200, yieldPerPeriod: 20n, maxRewardPerPeriod: null })
  })
})

describe('farm checkpoint (the month anchor\'s farm entries)', () => {
  it('an anchored entry advanced by the window\'s rows matches the full history after the anchor block', async () => {
    const { advanceAnchoredEntries, entriesFromAnchor } = await import('../src/services/userRevenueFarms.ts')
    const { buildEntryHistories } = await import('../src/services/lmRewardHistory.ts')
    const ev = (b: number, kind: string, amount = '0', dep = '7', y = 3) => ({ pallet: 'omnipool', deposit_id: dep, yield_farm_id: y, global_farm_id: 1, block_height: b, event_index: 1, event_kind: kind, amount_s: amount })
    const cap = (b: number, claimed: string, dep = '7', y = 3) => ({ pallet: 'omnipool', deposit_id: dep, yield_farm_id: y, global_farm_id: 1, block_height: b, capture_status: 'ok', is_event_entry: 1, valued_s: '1000', rpvs_entry_s: '5', claimed_s: claimed, entered_at_period: 10, stopped_at_creation: 0 })
    const events = [ev(100, 'deposited'), ev(150, 'claimed', '40'), ev(250, 'claimed', '25'), ev(300, 'withdrawn'), ev(120, 'deposited', '0', '8'), ev(260, 'destroyed', '0', '8')]
    const captures = [cap(100, '0'), cap(150, '40'), cap(120, '0', '8')]
    const full = buildEntryHistories(events as never, captures as never)
    const B = 200
    const anchorRows = full.filter(e => e.enteredBlock <= B && (e.closedBlock == null || e.closedBlock > B)).map(e => ({
      pot: 'farm', holder: '0xabc', exposure_id: `${e.pallet}:${e.depositId}:${e.yieldFarmId}`,
      units: e.depositId === '7' ? 40n : 0n,
      aux: [e.globalFarmId, e.enteredBlock, e.constants!.valuedShares, e.constants!.rpvsEntry, e.constants!.enteredAt, e.constants!.stoppedAtCreation].join('|'),
    }))
    const { entries } = entriesFromAnchor({ rows: anchorRows, block: B })
    advanceAnchoredEntries(entries, events.filter(e => e.block_height > B) as never, captures.filter(c => c.block_height > B) as never, B)
    for (const e of entries) {
      const f = full.find(x => x.depositId === e.depositId && x.yieldFarmId === e.yieldFarmId)!
      expect(e.closedBlock).toBe(f.closedBlock)
      expect(e.constants).toEqual(f.constants)
      expect(e.claims).toEqual(f.claims.filter(c => c.block > B))
    }
    expect(entries.find(e => e.depositId === '7')!.closedBlock).toBe(300)
    expect(entries.find(e => e.depositId === '8')!.closedBlock).toBe(260)
  })
})

describe('peg source changes and capped ramps (real series, tests/fixtures/userRevenuePegSeries.json)', () => {
  type Row = [number, string, number, number, number]
  const fx = JSON.parse(readFileSync(new URL('./fixtures/userRevenuePegSeries.json', import.meta.url), 'utf8')) as Record<string, { points: Row[] }>
  const series = (name: string): PegPoint[] => fx[name].points.map(([ts, rate, block, source, cap]) => ({
    ts, rate: BigInt(rate), block, ...(source ? { source } : {}), ...(cap ? { cap } : {}),
  }))
  const at = (iso: string) => Date.parse(`${iso}Z`) / 1000
  const booked = (segs: ReturnType<typeof pegSegments>, from: number, to: number) =>
    segs.filter(x => x.startTs >= from && x.endTs <= to).reduce((a, x) => a + x.rise, 0n)

  it('vDOT 2025-12-19: Bifrost EMA → MMOracle 0.9 % lower is a source change, not a jump — the new source accrues from its own first rows', () => {
    const pts = series('vdotSourceChange')
    const segs = pegSegments(pts)
    const boundary = at('2025-12-20T00:01:48')
    const changed = segs.filter(x => x.kind === 'source-changed')
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({ startTs: at('2025-12-19T01:40:00'), endTs: boundary, rise: 0n })
    expect(changed[0].source).toBeUndefined()
    // Nothing after the change is a jump or under the old source's high: Dec 20 → Jan 19 is ordinary daily accrual.
    const after = segs.filter(x => x.startTs >= boundary && x.endTs <= at('2026-01-19T00:00:00'))
    expect(after.length).toBeGreaterThan(25)
    expect(after.every(x => x.kind === 'accrual' && x.source === 10_579_734)).toBe(true)
    // It books the new source's whole rise from its first (lowest) row to the last move.
    const lastMove = after[after.length - 1]
    const rateAt = (ts: number) => pts.filter(p => p.ts <= ts).at(-1)!.rate
    expect(booked(segs, boundary, lastMove.endTs)).toBe(rateAt(lastMove.endTs) - rateAt(boundary))
    // Before the change, the old source is booked as before (its own daily moves).
    expect(segs.filter(x => x.endTs < boundary && x.endTs > at('2025-12-15T00:00:00')).every(x => x.kind === 'accrual' && x.source === undefined)).toBe(true)
  })

  it('wstETH 2025-07-11 (block 8,295,905): the source changes mid-relay; the new mark is its settled low, so the August catch-up books from the rate, not the relayed peak', () => {
    const pts = series('wstethSourceChange')
    const segs = pegSegments(pts)
    const changed = segs.filter(x => x.kind === 'source-changed')
    expect(changed).toHaveLength(1)
    expect(changed[0].endTs).toBe(at('2025-07-11T16:41:00'))
    const next = segs.filter(x => x.startTs >= changed[0].endTs)
    expect(next[0]).toMatchObject({ kind: 'under-high-water', rise: 0n, source: 8_295_905 })
    const catchup = next.find(x => x.kind === 'catchup')!
    expect(catchup.startTs).toBe(at('2025-07-11T17:41:42'))
    // The rise from the settled rate (1.20782…) to the 2025-08-18 move, whole.
    const rateAt = (ts: number) => pts.filter(p => p.ts <= ts).at(-1)!.rate
    expect(catchup.rise).toBe(rateAt(catchup.endTs) - rateAt(catchup.startTs))
    // The relay before the change still books nothing.
    expect(booked(segs, at('2025-07-06T00:00:00'), changed[0].startTs)).toBe(0n)
  })

  it('jitoSOL 2026-07-31 → 08-04: a ramp held at the pool\'s cap (160 perbill/block) pausing up to 21 h is one catch-up over the 79-day stall, never a jump', () => {
    const segs = pegSegments(series('jitosolCappedRamp'))
    const ramp = segs.filter(x => x.endTs > at('2026-07-31T00:00:00') && x.startTs < at('2026-08-05T00:00:00'))
    expect(ramp).toHaveLength(2)
    expect(ramp[0]).toMatchObject({ kind: 'catchup', startTs: at('2026-05-17T02:33:12'), endTs: at('2026-08-04T10:33:03'), moves: 23 })
    expect(Number(ramp[0].rise) / 1e36).toBeCloseTo(0.0144, 9)
    expect(segs.some(x => x.kind === 'jump')).toBe(false)
  })

  it('sUSDe 2025-12-29 → 31: an oracle that lagged and caught up in a burst after 16 h is accrual over the burst\'s days, not a jump', () => {
    const segs = pegSegments(series('susdeLaggingBurst'))
    const burst = segs.find(x => x.startTs === at('2025-12-29T20:28:36'))!
    expect(burst).toMatchObject({ kind: 'accrual', endTs: at('2025-12-31T08:17:42'), moves: 11 })
    expect(Number(burst.rise) / 1e36).toBeCloseTo(0.002574664, 9)
    expect(segs.some(x => x.kind === 'jump')).toBe(false)
  })

  it('reads the cap as the pallet does: rise ≤ cap × (blocks since the last move\'s row + one row), at the cap when it used half of it; a loose cap bounds nothing', () => {
    const ONE = 10n ** 36n
    const m = { before: ONE, block: 10_000, prevBlock: 4_000, cap: 160 }
    // 160e-9 × 6,000 = 0.096 % allowed (0.1056 % with the row's slack)
    expect(pegCapBound({ ...m, after: ONE + ONE * 96n / 100_000n })).toEqual({ within: true, atCap: true })
    expect(pegCapBound({ ...m, after: ONE + ONE * 105n / 100_000n })).toEqual({ within: true, atCap: true })
    expect(pegCapBound({ ...m, after: ONE + ONE * 107n / 100_000n })).toEqual({ within: false, atCap: false })
    expect(pegCapBound({ ...m, after: ONE + ONE * 4n / 100_000n })).toEqual({ within: true, atCap: false })
    expect(pegCapBound({ ...m, after: ONE - ONE / 10_000n })).toEqual({ within: false, atCap: false })
    expect(pegCapBound({ ...m, cap: 1_000_000, after: ONE + ONE / 100n })).toEqual({ within: false, atCap: false })
    // continuity across a source change: within noise, or within the tight cap from the old last row to the new first
    expect(pegContinuous({ ts: 0, rate: ONE, block: 0 }, { ts: 1, rate: ONE + 1n, block: 600 })).toBe(true)
    expect(pegContinuous({ ts: 0, rate: ONE, block: 0 }, { ts: 1, rate: ONE + ONE / 10_000n, block: 600, cap: 120 })).toBe(true)
    expect(pegContinuous({ ts: 0, rate: ONE, block: 0 }, { ts: 1, rate: ONE - ONE * 9n / 1_000n, block: 600, cap: 1_000_000 })).toBe(false)
  })

  it('a continuous source change hands the stall over: the new source\'s catch-up spans the old source\'s flat tail', () => {
    const ONE = 10n ** 36n
    const H = 3_600
    const pts: PegPoint[] = []
    // old source: a move at hour 1, then flat for 20 days; new source from day 20 (cap 120), ramping 5e-5/row (at the cap) for 50 rows
    for (let h = 0; h <= 20 * 24; h++) pts.push({ ts: h * H, rate: h >= 1 ? ONE + ONE / 1_000n : ONE, block: h * 600, cap: 120 })
    for (let k = 1; k <= 120; k++) pts.push({ ts: (20 * 24 + k) * H, rate: ONE + ONE / 1_000n + (ONE / 20_000n) * BigInt(Math.min(k, 50)), block: (20 * 24 + k) * 600, source: 288_000, cap: 120 })
    const segs = pegSegments(pts)
    expect(segs.some(x => x.kind === 'source-changed')).toBe(false)
    const catchup = segs.find(x => x.kind === 'catchup')!
    expect(catchup).toMatchObject({ startTs: H, source: 288_000, moves: 50 })
    expect(catchup.rise).toBe((ONE / 20_000n) * 50n)
    // the same change at a new LEVEL (0.9 % lower, a loose cap) starts the new source fresh instead
    const level = pegSegments(pts.map(p => (p.source ? { ...p, rate: p.rate - ONE * 9n / 1_000n, cap: 1_000_000 } : p)))
    expect(level.find(x => x.kind === 'source-changed')).toMatchObject({ startTs: H, endTs: (20 * 24 + 1) * H })
  })

  it('a continuous source change hands over the high-water mark: a rise the old source booked is never booked again', () => {
    const ONE = 10n ** 36n
    const H = 3_600
    const M = ONE / 1_000n
    // old source: +0.1 %/day to +0.2 % (booked), back to +0.1 % on day 3 (under its mark); new source from day 4 at
    // the same rate (continuous), back to +0.2 % on day 5 (already booked) and on to +0.25 % on day 6.
    const oldRate = (d: number) => ONE + M * BigInt([0, 1, 2, 1][Math.min(d, 3)])
    const newRate = (d: number) => (d >= 6 ? ONE + M * 5n / 2n : d >= 5 ? ONE + 2n * M : ONE + M)
    const pts: PegPoint[] = []
    for (let h = 0; h < 4 * 24; h++) pts.push({ ts: h * H, rate: oldRate(Math.floor(h / 24)), block: h * 600, cap: 120 })
    for (let h = 4 * 24; h <= 9 * 24; h++) pts.push({ ts: h * H, rate: newRate(Math.floor(h / 24)), block: h * 600, source: 57_600, cap: 120 })
    const segs = pegSegments(pts)
    expect(segs.some(x => x.kind === 'source-changed' || x.kind === 'jump' || x.kind === 'gave-back')).toBe(false)
    // booked once: the rate's whole rise, +0.25 %
    expect(segs.reduce((a, x) => a + x.rise, 0n)).toBe(M * 5n / 2n)
    expect(segs.find(x => x.endTs === 5 * 24 * H)).toMatchObject({ kind: 'under-high-water', rise: 0n, source: 57_600 })
    expect(segs.find(x => x.endTs === 6 * 24 * H)).toMatchObject({ kind: 'accrual', rise: M / 2n, source: 57_600 })
  })

  it('folds the peg source into a segment\'s identity, so a source change re-marks the buckets it spans', () => {
    const seg = { startTs: 1, endTs: 2, rise: 5n, kind: 'accrual' as const, moves: 1 }
    expect(pegSegmentHash(15, seg)).not.toBe(pegSegmentHash(15, { ...seg, source: 10_579_734 }))
    expect(pegSegmentHash(15, seg)).toBe(pegSegmentHash(15, { ...seg }))
  })

  it('assigns each grid row the source and cap in force: a row at the PoolPegSourceUpdated block or later reads the new source', async () => {
    const { pegGridFromRows, pegParamsFromEvents } = await import('../src/services/userRevenueTokens.ts')
    const params = pegParamsFromEvents([
      { pool: 690, block: 7_346_897, event: 'Stableswap.PoolCreated', args: '{"poolId":690,"assets":[15,1001],"peg":{"maxPegUpdate":1000000}}' },
      { pool: 690, block: 10_579_734, event: 'Stableswap.PoolPegSourceUpdated', args: '{"poolId":690,"assetId":15,"pegSource":{"__kind":"MMOracle","value":"0xaafd"}}' },
      { pool: 690, block: 13_134_013, event: 'Stableswap.PoolMaxPegUpdateUpdated', args: '{"poolId":690,"maxPegUpdate":120}' },
    ])
    const row = (block: number) => ({ pool: 690, block, ts: block, ids: [15, 1001], pn: ['3', '1'], pd: ['2', '1'] })
    const pts = pegGridFromRows([row(10_579_200), row(10_579_734), row(10_579_800), row(13_134_600)], params).get(15)!
    expect(pts.map(p => [p.block, p.source ?? 0, p.cap])).toEqual([
      [10_579_200, 0, 1_000_000], [10_579_734, 10_579_734, 1_000_000], [10_579_800, 10_579_734, 1_000_000], [13_134_600, 10_579_734, 120],
    ])
    expect(pts[0].rate).toBe((10n ** 36n * 3n) / 2n)
  })
})
