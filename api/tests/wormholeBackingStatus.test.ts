import { describe, it, expect } from 'vitest'
import {
  backingTolerance,
  classifyBacking,
  worstStatus,
  type BackingInput,
} from '../src/services/wormholeNtt.ts'

// The backing verdict is the whole point of the feature, so every branch is
// pinned: an unread input must never read as balanced, a surplus must never read
// as a problem, and a real shortfall must never be graded away.
const usdc = (over: Partial<BackingInput> = {}): BackingInput => ({
  locked: 227_031_998_904n,
  issuance: 227_031_998_904n,
  burned: 0n,
  inflightIn: 0n,
  inflightOut: 0n,
  queued: 0n,
  decimals: 6,
  symbol: 'USDC',
  priceUsd: 1,
  originConfigured: true,
  scanEnabled: true,
  lookbackDays: 14,
  // Most cases here exercise the classifier itself, so they present an already
  // confirmed reading taken this cycle; the damping rule and the carried-over
  // custody rule each have their own block below.
  custodyFresh: true,
  downgradeConfirmed: true,
  ...over,
})

describe('backingTolerance', () => {
  it('takes the larger of a hundred payload units and a dollar', () => {
    // 18-decimal asset trimmed at 8 → the smallest transferable unit is 1e10.
    // At $2500 a hundred of them are worth $2.50, so the dollar floor wins.
    expect(backingTolerance(18, 2500)).toBe(400_000_000_000_000n)
    // Price it high enough that a hundred payload units are worth more than a
    // dollar and the payload floor takes over.
    expect(backingTolerance(18, 2_000_000)).toBe(100n * 10n ** 10n)
  })

  it('rises to a dollar when a hundred payload units are worth less than that', () => {
    // 100 raw USDC units is $0.0001; one dollar is 1_000_000 raw.
    expect(backingTolerance(6, 1)).toBe(1_000_000n)
  })

  it('never collapses to zero for an unpriced or zero-decimal asset', () => {
    expect(backingTolerance(0, null)).toBe(100n)
    expect(backingTolerance(6, 0)).toBe(100n)
  })
})

describe('classifyBacking null ladder', () => {
  it('reports an unconfigured origin chain rather than a zero balance', () => {
    const verdict = classifyBacking(usdc({ originConfigured: false, locked: null }))
    expect(verdict.status).toBe('unconfigured')
    expect(verdict.residual).toBeNull()
  })

  it('reports an unread custody balance as unconfigured, not as a total deficit', () => {
    expect(classifyBacking(usdc({ locked: null })).status).toBe('unconfigured')
  })

  it('reports unread issuance as unconfigured', () => {
    expect(classifyBacking(usdc({ issuance: null })).status).toBe('unconfigured')
  })
})

describe('classifyBacking with in-flight known', () => {
  it('is ok when custody covers supply plus everything in flight', () => {
    const verdict = classifyBacking(usdc({ locked: 227_031_998_904n + 5_000_000n, inflightIn: 5_000_000n }))
    expect(verdict.status).toBe('ok')
    expect(verdict.residual).toBe(0n)
  })

  it('is ok exactly at the tolerance edge, on both signs', () => {
    const tol = backingTolerance(6, 1)
    expect(classifyBacking(usdc({ locked: 227_031_998_904n + tol })).status).toBe('ok')
    expect(classifyBacking(usdc({ locked: 227_031_998_904n - tol })).status).toBe('ok')
  })

  it('calls one unit past the tolerance a surplus above and a shortfall below', () => {
    const tol = backingTolerance(6, 1)
    expect(classifyBacking(usdc({ locked: 227_031_998_904n + tol + 1n })).status).toBe('surplus')
    expect(classifyBacking(usdc({ locked: 227_031_998_904n - tol - 1n })).status).toBe('attention')
  })

  it('grades a small shortfall as attention and a material one as deficit', () => {
    // The live SUI position: 194,145.757 SUI minted against custody that is
    // 8.82 SUI short — worth about $26 and 0.0045% of supply, so it is worth
    // showing but is not a backing failure.
    const sui = classifyBacking({
      locked: 194_145_757_066_522n - 8_820_000_000n,
      issuance: 194_145_757_066_522n,
      burned: 0n,
      inflightIn: 0n,
      inflightOut: 0n,
      queued: 0n,
      decimals: 9,
      symbol: 'SUI',
      priceUsd: 3,
      originConfigured: true,
      scanEnabled: true,
      lookbackDays: 14,
      custodyFresh: true,
    downgradeConfirmed: true,
    })
    expect(sui.status).toBe('attention')

    // The same shortfall at a price that makes it worth more than $100.
    expect(classifyBacking({
      locked: 194_145_757_066_522n - 8_820_000_000n,
      issuance: 194_145_757_066_522n,
      burned: 0n,
      inflightIn: 0n,
      inflightOut: 0n,
      queued: 0n,
      decimals: 9,
      symbol: 'SUI',
      priceUsd: 500,
      originConfigured: true,
      scanEnabled: true,
      custodyFresh: true,
    downgradeConfirmed: true,
      lookbackDays: 14,
    }).status).toBe('deficit')

    // Attention needs BOTH gates. Worth little but half the supply is missing:
    // still a deficit.
    expect(classifyBacking(usdc({ issuance: 10_000_000n, locked: 5_000_000n })).status).toBe('deficit')
    // A rounding-scale share of a very large supply, but $200 of it: still a
    // deficit.
    expect(classifyBacking(usdc({ issuance: 100_000_000_000_000n, locked: 100_000_000_000_000n - 200_000_000n })).status).toBe('deficit')
  })

  it('subtracts in-flight in both directions, so a pending transfer is not a deficit', () => {
    // 5 USDC left Hydration and has not been released on Ethereum yet: custody
    // still holds it while the supply is already burned.
    const verdict = classifyBacking(usdc({ issuance: 227_031_998_904n - 5_000_000n, inflightOut: 5_000_000n }))
    expect(verdict.status).toBe('ok')
    expect(verdict.residual).toBe(0n)
  })

  it('names the lookback window in the detail so a stale surplus is explainable', () => {
    expect(classifyBacking(usdc({ locked: 227_031_998_904n + 80_000_000_000n })).detail).toContain('14 days')
  })
})

describe('classifyBacking with the origin rate-limiter queue', () => {
  it('subtracts a queued release the same way an outbound transfer is subtracted', () => {
    // Burned here, redeemed at the peer, still held by its rate limiter: the
    // supply is gone from Hydration while the custody has not moved.
    const verdict = classifyBacking(usdc({ issuance: 227_031_998_904n - 5_000_000n, queued: 5_000_000n }))
    expect(verdict.status).toBe('ok')
    expect(verdict.residual).toBe(0n)
  })

  it('is what turns the real sUSDS reading from surplus into ok', () => {
    // 79,998.96642431 sUSDS was burned, redeemed on Ethereum and queued there.
    // Wormholescan called the operation completed, so it is not in flight, and
    // without the queued term the amount is unexplained custody.
    const queuedRaw = 79_998_966_424_310_000_000_000n
    const susds = (over: Partial<BackingInput>) => classifyBacking({
      locked: 3_284_711_408_355_733_425_437_090n,
      issuance: 3_284_711_408_355_733_425_437_090n - queuedRaw - 410_000_000_000_000_000n,
      burned: 0n,
      inflightIn: 0n,
      inflightOut: 0n,
      queued: null,
      decimals: 18,
      symbol: 'sUSDS',
      priceUsd: 1.09,
      originConfigured: true,
      scanEnabled: true,
      lookbackDays: 14,
      custodyFresh: true,
    downgradeConfirmed: true,
      ...over,
    })
    const blind = susds({})
    expect(blind.status).toBe('surplus')
    expect(blind.residual).toBe(queuedRaw + 410_000_000_000_000_000n)

    const withQueue = susds({ queued: queuedRaw })
    expect(withQueue.status).toBe('ok')
    // What is left is the 0.41 sUSDS of seed overfunding, inside tolerance.
    expect(withQueue.residual).toBe(410_000_000_000_000_000n)
  })

  it('treats an unread queue as nothing queued, which can only widen a surplus', () => {
    // Null must never subtract, because subtracting an amount nobody measured
    // would manufacture a deficit. It costs a surplus instead.
    const unread = classifyBacking(usdc({ issuance: 227_031_998_904n - 5_000_000n, queued: null }))
    expect(unread.status).toBe('surplus')
    expect(unread.residual).toBe(5_000_000n)
  })

  it('applies the queue even when the scan is off, since the origin answers for it', () => {
    const noScan = classifyBacking(usdc({
      scanEnabled: false, inflightIn: null, inflightOut: null,
      issuance: 227_031_998_904n - 5_000_000n, queued: 5_000_000n,
    }))
    expect(noScan.status).toBe('ok')
    expect(noScan.residual).toBe(0n)
  })

  it('does not let a queued release hide a real shortfall underneath it', () => {
    const verdict = classifyBacking(usdc({
      issuance: 227_031_998_904n,
      locked: 227_031_998_904n - 80_000_000_000n,
      queued: 5_000_000n,
    }))
    expect(verdict.status).toBe('deficit')
    expect(verdict.residual).toBe(-80_005_000_000n)
  })
})

// Supply burned at the dead address (0x…dEaD) is counted by
// `Tokens.TotalIssuance` but has no key, so it can never be bridged back and
// needs no custody. The equation is stated on CIRCULATING supply.
describe('classifyBacking with supply burned at the dead address', () => {
  it('turns the real SUI reading from a false shortfall into a small surplus', () => {
    // Live 2026-08-22: 194,145.757066522 SUI issued, custody 194,136.934939680,
    // and 10 SUI sitting at 0x…dEaD. Gross the row reads −8.822126842 and flags
    // attention; net of the dead-address balance it is +1.177873158, a surplus.
    const sui = (over: Partial<BackingInput>) => classifyBacking({
      locked: 194_136_934_939_680n,
      issuance: 194_145_757_066_522n,
      burned: 0n,
      inflightIn: 0n,
      inflightOut: 0n,
      queued: 0n,
      decimals: 9,
      symbol: 'SUI',
      priceUsd: 3,
      originConfigured: true,
      scanEnabled: true,
      lookbackDays: 14,
      custodyFresh: true,
    downgradeConfirmed: true,
      ...over,
    })
    const gross = sui({})
    expect(gross.status).toBe('attention')
    expect(gross.residual).toBe(-8_822_126_842n)

    const net = sui({ burned: 10_000_000_000n })
    expect(net.status).toBe('surplus')
    expect(net.residual).toBe(1_177_873_158n)
    expect(net.detail).toContain('10 SUI burned at the dead address are excluded')
  })

  it('says nothing about a dead address holding nothing', () => {
    const zero = classifyBacking(usdc({ burned: 0n }))
    expect(zero.detail).not.toContain('dead address')
    // Unread is not zero either — it leaves the equation on gross issuance,
    // which can only make a row look worse, never better.
    expect(classifyBacking(usdc({ burned: null })).residual).toBe(zero.residual)
  })

  // The whole point of the term: a gap-closing mint raises issuance and the dead
  // address balance by the same amount in the same block, so the residual must
  // not move. Without this, closing a gap would itself read as a new deficit.
  it('leaves the residual unchanged when a gap-closing mint lands', () => {
    const before = classifyBacking(usdc({}))
    const mint = 40_000_000n
    const after = classifyBacking(usdc({
      issuance: 227_031_998_904n + mint,
      burned: mint,
    }))
    expect(after.residual).toBe(before.residual)
    expect(after.status).toBe(before.status)
  })

  it('measures the attention/deficit share against circulating supply', () => {
    // 200 raw units short of a 100M-unit float. Gross, the dead-address balance
    // inflates the denominator and the shortfall looks like a smaller slice than
    // it is; the classifier must judge it against what actually circulates.
    const shortfall = 200_000_000n
    const circulating = 100_000_000_000_000n
    const verdict = classifyBacking(usdc({
      issuance: circulating + 900_000_000_000_000n,
      burned: 900_000_000_000_000n,
      locked: circulating - shortfall,
    }))
    expect(verdict.residual).toBe(-shortfall)
    expect(verdict.status).toBe('deficit')
  })
})

describe('classifyBacking when custody is a carried-over reading', () => {
  // An origin chain that stops answering keeps its last custody balance rather
  // than blanking the row, which is right for the surplus side and wrong for
  // the shortfall side: the carried figure and the freshly read supply describe
  // different moments, and the same failed read is what would have said whether
  // an outbound transfer had already been unlocked out of that balance.
  it('holds a shortfall at unverified rather than grading it', () => {
    const verdict = classifyBacking(usdc({ locked: 227_031_998_904n - 175_000_000n, custodyFresh: false }))
    expect(verdict.status).toBe('unverified')
    expect(verdict.residual).toBe(-175_000_000n)
    expect(verdict.detail).toMatch(/could not be read this cycle/i)
  })

  it('still grades the same shortfall once custody is read again', () => {
    expect(classifyBacking(usdc({ locked: 227_031_998_904n - 175_000_000n })).status).toBe('deficit')
  })

  it('leaves a balanced or surplus reading alone', () => {
    // Both are the safe direction, and a stale balance cannot invent them.
    expect(classifyBacking(usdc({ custodyFresh: false })).status).toBe('ok')
    expect(classifyBacking(usdc({ locked: 227_031_998_904n + 175_000_000n, custodyFresh: false })).status).toBe('surplus')
  })
})

describe('classifyBacking with the scan disabled', () => {
  const noScan = (over: Partial<BackingInput> = {}) => classifyBacking(usdc({ scanEnabled: false, inflightIn: null, inflightOut: null, ...over }))

  it('still calls a match ok and a surplus a surplus', () => {
    expect(noScan().status).toBe('ok')
    expect(noScan({ locked: 227_031_998_904n + 80_000_000_000n }).status).toBe('surplus')
  })

  it('refuses to call a shortfall a deficit it cannot rule out as a pending transfer', () => {
    const verdict = noScan({ locked: 227_031_998_904n - 80_000_000_000n })
    expect(verdict.status).toBe('unverified')
    expect(verdict.residual).toBe(-80_000_000_000n)
  })

  it('treats missing in-flight figures as unknown even when the scan says it is on', () => {
    expect(classifyBacking(usdc({ inflightOut: null, locked: 1n })).status).toBe('unverified')
  })
})

describe('worstStatus', () => {
  it('orders deficit above attention above unverified above unconfigured above surplus above ok', () => {
    expect(worstStatus(['ok', 'surplus'])).toBe('surplus')
    expect(worstStatus(['surplus', 'unconfigured'])).toBe('unconfigured')
    expect(worstStatus(['unconfigured', 'unverified'])).toBe('unverified')
    expect(worstStatus(['unverified', 'attention'])).toBe('attention')
    expect(worstStatus(['attention', 'deficit'])).toBe('deficit')
    expect(worstStatus(['deficit', 'ok', 'surplus'])).toBe('deficit')
    expect(worstStatus([])).toBe('ok')
  })
})
