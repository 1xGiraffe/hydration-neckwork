import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DATA_UPGRADES } from '../src/db/schemaBootstrap.ts'
import {
  HOLLAR_DEBT_LOGS_SELECT, HOLLAR_DEBT_LOGS_WHERE, HOLLAR_DEBT_TOKENS, discountSeries, foldHolderDiscount, principalScaledDelta, rateAt, seriesAt,
  type HollarDebtLog,
} from '../src/services/hollarDiscount.ts'

const RAY = 10n ** 27n
const E18 = 10n ** 18n
const rayMul = (a: bigint, b: bigint) => (a * b + RAY / 2n) / RAY
const rayDiv = (a: bigint, b: bigint) => (a * RAY + b / 2n) / b

const sql = readFileSync(new URL('../../clickhouse/schema/025_hollar_debt_logs.sql', import.meta.url), 'utf8')
const mv = sql.split('\n').find(l => l.startsWith('CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.hollar_debt_logs_mv '))!

describe('hollar_debt_logs', () => {
  // The fold reads exactly what the view copies: a token the constant names but the view
  // misses (or the reverse) would fold a borrower from a partial history.
  it('copies the debt tokens and topics the fold reads, by the select its replay uses', () => {
    expect(mv).toContain(`AS SELECT ${HOLLAR_DEBT_LOGS_SELECT} FROM price_data.raw_evm_logs WHERE ${HOLLAR_DEBT_LOGS_WHERE};`)
    for (const c of HOLLAR_DEBT_TOKENS) expect(HOLLAR_DEBT_LOGS_WHERE).toContain(`'${c}'`)
    const up = DATA_UPGRADES.find(u => u.table === 'price_data.hollar_debt_logs')!
    expect(up.where).toBe(HOLLAR_DEBT_LOGS_WHERE)
    expect(up.select).toBe(HOLLAR_DEBT_LOGS_SELECT)
  })
})

/** A borrower's logs, as the token emits them: a refresh's rate change ahead of its action's Mint/Burn. */
function borrower() {
  const out: HollarDebtLog[] = []
  let e = 0
  const base = { contract: '0xvdebt', holder: '0xb0', pctOld: 0n, pctNew: 0n, value: 0n, balanceIncrease: 0n, index: 0n }
  return {
    out,
    mint: (block: number, value: bigint, bi: bigint, index: bigint) => out.push({ ...base, block, eventIndex: e++, ts: block * 6, kind: 'Mint', value, balanceIncrease: bi, index }),
    burn: (block: number, value: bigint, bi: bigint, index: bigint) => out.push({ ...base, block, eventIndex: e++, ts: block * 6, kind: 'Burn', value, balanceIncrease: bi, index }),
    rate: (block: number, from: bigint, to: bigint) => out.push({ ...base, block, eventIndex: e++, ts: block * 6, kind: 'DiscountPercentUpdated', pctOld: from, pctNew: to }),
  }
}

describe('foldHolderDiscount — GHO discount, the token\'s own arithmetic', () => {
  it('burns rate × the interest settled at each action and ends on the chain\'s scaled balance', () => {
    const b = borrower()
    const i0 = RAY, i1 = 1_010_000_000_000_000_000_000_000_000n, i2 = 1_030_000_000_000_000_000_000_000_000n
    // Borrow 1,000 at i0; the refresh inside it sets 40% (logged first, applies from the next action).
    b.rate(10, 0n, 4000n)
    b.mint(10, 1000n * E18, 0n, i0)
    const S0 = rayDiv(1000n * E18, i0)
    // Borrow 100 more at i1: the full interest since i0, 40% excused; the event states the net.
    const full1 = rayMul(S0, i1) - rayMul(S0, i0)
    const disc1 = (full1 * 4000n + 5000n) / 10000n
    b.mint(20, 100n * E18 + (full1 - disc1), full1 - disc1, i1)
    const S1 = S0 + rayDiv(100n * E18, i1) - rayDiv(disc1, i1)
    // A rate refresh at i2 (no principal): its accrual still uses 40%, then 90% applies.
    const full2 = rayMul(S1, i2) - rayMul(S1, i1)
    const disc2 = (full2 * 4000n + 5000n) / 10000n
    b.rate(30, 4000n, 9000n)
    b.mint(30, full2 - disc2, full2 - disc2, i2)
    const S2 = S1 - rayDiv(disc2, i2)

    const f = foldHolderDiscount(b.out)!
    expect(f.mismatches).toBe(0)
    expect(f.scaled).toBe(S2)
    expect(f.burns.map(x => x.scaled)).toEqual([rayDiv(disc1, i1), rayDiv(disc2, i2)])
    expect(f.burns.map(x => x.amount)).toEqual([disc1, disc2])
    expect(rateAt(f.rates, 9)).toBe(0n)
    expect(rateAt(f.rates, 10)).toBe(4000n)
    expect(rateAt(f.rates, 29)).toBe(4000n)
    expect(rateAt(f.rates, 30)).toBe(9000n)
  })

  it('flags an action whose stated interest the fold cannot reproduce', () => {
    const b = borrower()
    b.rate(10, 0n, 9000n)
    b.mint(10, 1000n * E18, 0n, RAY)
    b.mint(20, 1n, 5n, 2n * RAY) // a full-rate balanceIncrease where 90% is excused
    expect(foldHolderDiscount(b.out)!.mismatches).toBe(1)
  })

  it('states a repayment\'s principal as the scaled deltas do, the burn left out', () => {
    // Burn: value excludes the interest settled; Mint with value < balanceIncrease is a repayment too.
    expect(principalScaledDelta({ kind: 'Burn', value: 90n * E18, balanceIncrease: 10n * E18, index: 2n * RAY })).toBe(-50n * E18)
    expect(principalScaledDelta({ kind: 'Mint', value: 2n * E18, balanceIncrease: 12n * E18, index: 2n * RAY })).toBe(-5n * E18)
  })
})

describe('discountSeries', () => {
  it('sums each borrower\'s burned debt and rate × true scaled, as steps over time', () => {
    const a = borrower(), c = borrower()
    a.rate(10, 0n, 4000n); a.mint(10, 1000n * E18, 0n, RAY)
    c.rate(15, 0n, 9000n); c.mint(15, 500n * E18, 0n, RAY)
    const fa = foldHolderDiscount(a.out)!, fc = { ...foldHolderDiscount(c.out)!, holder: '0xb1' }
    const s = discountSeries([fa, fc]).get('0xvdebt')!
    expect(seriesAt(s, 10 * 6 - 1)).toEqual({ burned: 0n, rateScaled: 0n })
    expect(seriesAt(s, 10 * 6).rateScaled).toBe(4000n * 1000n * E18)
    expect(seriesAt(s, 15 * 6).rateScaled).toBe(4000n * 1000n * E18 + 9000n * 500n * E18)
  })
})

describe('User Revenue: a discounted borrower is walked as the token charges it', () => {
  const H0 = Date.UTC(2026, 10, 10) / 1000
  const B = 16_700_000
  const w = {
    month: 202611, monthStart: Date.UTC(2026, 10, 1) / 1000, monthEnd: Date.UTC(2026, 11, 1) / 1000, fromHour: H0, hours: 2,
    openBlock: B, openTs: H0 - 6,
    hourBlocks: [{ first: B + 1, last: B + 600, lastTs: H0 + 3594 }, { first: B + 601, last: B + 1200, lastTs: H0 + 7194 }],
    lastBlock: B + 1200,
  }
  const VDEBT = '0x342923782ccaebf9c38dd9cb40436e82c42c73b5'
  const HOLDER = '0x2df1d70f413b5edd16bb794791117948a7436a45'
  const contracts = [{ contract: VDEBT, side: 'debt' as const, reserve: '0x531a654d1696ed52e7275a8cede955e82620f99a', pool: '0xpool', market: 'core', reserveAsset: 222, aTokenAsset: null }]
  // One index update before the window at 5% a year; the index compounds from it.
  const client = {
    query: async (p: { clickhouse_settings?: { log_comment?: string } }) => {
      const tag = p.clickhouse_settings?.log_comment ?? ''
      const data = tag === 'ur:mm-carry'
        ? [{ pool: '0xpool', reserve: contracts[0].reserve, b: String(B - 10), e: '0', ts: String(H0 - 66), liq: String(RAY), vbi: String(RAY), lr: '0', vr: String(RAY / 20n) }]
        : []
      return { json: async () => data, text: async () => '' }
    },
  } as never
  const S = 1000n * E18

  it('accrues (1 − rate) of the indexed interest and applies the burn its action realizes', async () => {
    const { buildMmInterest } = await import('../src/services/userRevenueMm.ts')
    const opening = () => new Map([[`${HOLDER}|${VDEBT}`, S]])
    const plain = await buildMmInterest(client, w, contracts, opening(), h => h)
    // 90% off throughout, and an action at B+700 that burns 7 scaled units.
    const discount = { contract: VDEBT, holder: HOLDER, burns: [{ block: B + 700, eventIndex: 3, ts: H0 + 4200, scaled: 7n, amount: 7n }], rates: [{ block: B - 5, eventIndex: 1, ts: H0 - 30, pct: 9000n }], points: [], scaled: 0n, mismatches: 0 }
    const discounted = await buildMmInterest(client, w, contracts, opening(), h => h, [discount])
    const full = plain.ledgers[0].amounts, net = discounted.ledgers[0].amounts
    expect(full[0]).toBeLessThan(0n)
    // Hour 0 holds no action: exactly a tenth (each stretch floors its own tenth).
    expect(net[0]).toBe(-((-full[0] * 1000n) / 10_000n))
    // Hour 1 splits at the action into two stretches, each floored: within a unit or two of a tenth.
    expect(net[1] * 10n - full[1]).toBeGreaterThanOrEqual(0n)
    expect(net[1] * 10n - full[1]).toBeLessThanOrEqual(20n)
    expect(discounted.closing.get(`${HOLDER}|${VDEBT}`)).toBe(S - 7n)
    expect(plain.closing.get(`${HOLDER}|${VDEBT}`)).toBe(S)
  })
})
