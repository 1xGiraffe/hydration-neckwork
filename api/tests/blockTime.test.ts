import { describe, expect, it, vi } from 'vitest'
import {
  NOMINAL_BLOCKS_PER_HOUR, NOMINAL_PARA_BLOCK_MS, NOMINAL_RELAY_BLOCK_MS, RUNTIME_SLOT_MS_LADDER,
  avgBlockMsSql, blocksPerHour, clampBlockMs, dailyBlockCountSql, dailyBlockMs,
  decideParaBlockTime, measuredParaBlockMs, nominalBlockMsMismatch, resolveNominalBlockMs, type ResolvedBlockTime,
} from '../src/services/blockTime.ts'

vi.mock('../src/services/runtimeConstants.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/runtimeConstants.ts')>()),
  runtimeParaBlockMs: vi.fn(() => 2_000),
}))
import { breakerDefaultsFromJson, paraBlockMsFromConstants, rationalFromJson } from '../src/services/runtimeConstants.ts'
import { fusePeriodFromBlockTime, fusePeriodWarning, shouldLogStandingWarning } from '../src/services/securityService.ts'
import { gigaUnbondingBlocks, parseGigaUnbondingBlocks } from '../src/services/lockBreakdownService.ts'

// Hydration's block time is ~6s today and 2s is planned. Everything derived
// from it either measures the chain or is pinned with a documented migration
// action; these pin the arithmetic that decides which.

// Runtime 440 DECOUPLES the author slot from the block interval: SLOT_DURATION
// stays 6000 while MILLISECS_PER_BLOCK drops to 2000, and
// AllowMultipleBlocksPerSlot lets one author produce 3 blocks per slot. So
// `aura.slotDuration` reads 6000 before AND after the switch — the one metadata
// constant that looks authoritative and silently is not. These pin the
// replacement: constants that are fixed WALL-CLOCK quantities expressed in
// blocks, which therefore divide out to the block time on both sides.
describe('paraBlockMsFromConstants', () => {
  // system.blockHashCount = 4h of blocks; gigaHdx.cooldownPeriod = 28d of blocks
  it('reads 6000 from the pre-upgrade runtime', () => {
    expect(paraBlockMsFromConstants(2_400, 403_200)).toBe(6_000)
  })

  it('reads 2000 from runtime 440, where aura.slotDuration still says 6000', () => {
    expect(paraBlockMsFromConstants(7_200, 1_209_600)).toBe(2_000)
  })

  it('works from either constant alone', () => {
    expect(paraBlockMsFromConstants(7_200, null)).toBe(2_000)
    expect(paraBlockMsFromConstants(null, 1_209_600)).toBe(2_000)
    expect(paraBlockMsFromConstants(null, null)).toBeNull()
  })

  // Disagreement means one of the two wall-clock premises (4h / 28d) changed.
  // Picking a side would silently rescale every projected date, so refuse and
  // let the caller fall back to the measured ladder.
  it('refuses when the two constants disagree rather than picking one', () => {
    expect(paraBlockMsFromConstants(7_200, 403_200)).toBeNull()
  })

  it('refuses a value that does not divide the wall-clock premise exactly', () => {
    expect(paraBlockMsFromConstants(7_000, null)).toBeNull()
    expect(paraBlockMsFromConstants(0, null)).toBeNull()
  })
})

describe('avgBlockMsSql', () => {
  it('averages the newest sample of indexed blocks', () => {
    const sql = avgBlockMsSql(100)
    expect(sql).toContain('price_data.blocks')
    expect(sql).not.toContain('price_data.raw_blocks')
    expect(sql).toContain('ORDER BY block_height DESC LIMIT 100')
    // Bounded on the key as well as ordered by it: read-in-order alone still
    // opens a granule per part of the live partition (1.99M rows for 100).
    expect(sql).toContain('WHERE block_height > (SELECT max(block_height) FROM price_data.blocks) - 200')
    expect(sql).toContain("dateDiff('millisecond'")
    // count()-1 intervals between count() samples, and never a division by zero.
    expect(sql).toContain('greatest(count() - 1, 1)')
  })

  it('needs at least two blocks to have an interval at all', () => {
    expect(avgBlockMsSql(1)).toContain('LIMIT 2')
    expect(avgBlockMsSql(1000)).toContain('LIMIT 1000')
  })
})

describe('clampBlockMs', () => {
  it('passes a plausible measurement through unchanged', () => {
    // The pace actually measured on the live chain in Aug 2026.
    expect(clampBlockMs(4969.7)).toBe(4969.7)
    expect(clampBlockMs(1980)).toBe(1980)
  })

  it('falls back to the nominal for an unusable read', () => {
    for (const bad of [null, undefined, NaN, 0, -1, 100, 60_000, Infinity]) {
      expect(clampBlockMs(bad as number)).toBe(NOMINAL_PARA_BLOCK_MS)
    }
  })
})

describe('resolveNominalBlockMs', () => {
  // A measured pace is snapped to the runtime's slot ladder, so the value the
  // date projections ride on is a step function that moves exactly once — at
  // the runtime upgrade — instead of tracking throughput noise.
  it('keeps today’s elastic-scaling pace on the 6s rung', () => {
    for (const measured of [4_806, 4_970, 5_414, 5_576, 5_588, 5_810, 6_000, 6_400]) {
      expect(resolveNominalBlockMs(measured)).toBe(6_000)
    }
  })

  it('resolves a post-upgrade pace to the 2s rung', () => {
    for (const measured of [1_700, 1_900, 2_000, 2_200, 2_600]) {
      expect(resolveNominalBlockMs(measured)).toBe(2_000)
    }
  })

  // The retired 12s rung is deliberately gone: the chain cannot return to it,
  // and keeping it turned a stall into a doubled date. A slow reading now
  // resolves to 6s and is separately rejected as out of band.
  it('does not resolve a stall to a retired 12s era', () => {
    expect(RUNTIME_SLOT_MS_LADDER).not.toContain(12_000)
    expect(resolveNominalBlockMs(10_454)).toBe(6_000)
    expect(nominalBlockMsMismatch(10_454)).not.toBeNull()
  })

  it('every rung resolves to itself', () => {
    for (const rung of RUNTIME_SLOT_MS_LADDER) expect(resolveNominalBlockMs(rung)).toBe(rung)
  })

  it('falls back to the nominal for an unusable measurement', () => {
    expect(resolveNominalBlockMs(0)).toBe(NOMINAL_PARA_BLOCK_MS)
  })
})

describe('nominalBlockMsMismatch', () => {
  it('stays quiet across the whole range real production covers', () => {
    for (const measured of [4_806, 4_970, 5_588, 5_810, 6_000, 1_900, 2_400]) {
      expect(nominalBlockMsMismatch(measured)).toBeNull()
    }
  })

  // Measured over 600k blocks, aligned 100-block windows ranged 4454-10454ms.
  // The fast end is ordinary elastic scaling and must be accepted; the slow end
  // is a stall and must be rejected, because at 10 454ms a 12s-rung ladder used
  // to double every projected date.
  it('accepts the fast end of the observed range and rejects the slow end', () => {
    expect(nominalBlockMsMismatch(4_454)).toBeNull()
    expect(nominalBlockMsMismatch(10_454)).not.toBeNull()
  })

  it('names a slot time that is not on the ladder', () => {
    // 3.5s sits between the 6s and 2s rungs and is close to neither.
    const warning = nominalBlockMsMismatch(3_500)
    expect(warning).toContain('RUNTIME_SLOT_MS_LADDER')
    expect(warning).toContain('3500ms/block')
  })
})

describe('blocksPerHour', () => {
  it('matches the nominal constant at the nominal slot time', () => {
    expect(blocksPerHour(NOMINAL_PARA_BLOCK_MS)).toBe(NOMINAL_BLOCKS_PER_HOUR)
    expect(NOMINAL_BLOCKS_PER_HOUR).toBe(600)
  })

  it('tracks a faster chain', () => {
    expect(blocksPerHour(2_000)).toBe(1_800)
    expect(Math.round(blocksPerHour(5_588))).toBe(644)
  })

  it('degrades to the nominal rather than dividing by an absurd value', () => {
    expect(blocksPerHour(0)).toBe(NOMINAL_BLOCKS_PER_HOUR)
  })
})

describe('relay block time', () => {
  it('is the relay chain’s own 6s and is not the parachain constant', () => {
    // Same value today; separate constants because only one of them moves at
    // the 2s upgrade.
    expect(NOMINAL_RELAY_BLOCK_MS).toBe(6_000)
  })
})

// ── the circuit breaker's per-block defaults ────────────────────────────────
// Metadata constants that the 2s runtime cut to a third: a per-block cap is a
// per-6s cap only while a block is 6s. These pin the decode of what polkadot-js
// hands back, so a pinned 6s-era copy can never be read as the runtime's.
describe('rationalFromJson', () => {
  it('reads a (u32, u32) pair', () => {
    expect(rationalFromJson([1670, 10000])).toEqual([1670, 10000])
    expect(rationalFromJson([500, 10000])).toEqual([500, 10000])
  })
  it('refuses anything the pallet could not hold', () => {
    for (const bad of [null, undefined, [], [1670], [1670, 0], [-1, 10000], [1.5, 10000], ['1670', 'x'], { num: 1, den: 2 }]) {
      expect(rationalFromJson(bad)).toBeNull()
    }
  })
})

describe('breakerDefaultsFromJson', () => {
  it('reads the spec-440 defaults', () => {
    expect(breakerDefaultsFromJson([1670, 10000], [167, 10000], [167, 10000]))
      .toEqual({ trade: [1670, 10000], add: [167, 10000], remove: [167, 10000] })
  })
  it('reads the 6s-era defaults the same way', () => {
    expect(breakerDefaultsFromJson([5000, 10000], [500, 10000], [500, 10000]))
      .toEqual({ trade: [5000, 10000], add: [500, 10000], remove: [500, 10000] })
  })
  it('keeps a `None` liquidity default as disabled, not as unreadable', () => {
    expect(breakerDefaultsFromJson([1670, 10000], null, [167, 10000]))
      .toEqual({ trade: [1670, 10000], add: null, remove: [167, 10000] })
  })
  it('refuses the whole set when any part is not a limit', () => {
    expect(breakerDefaultsFromJson(null, [167, 10000], [167, 10000])).toBeNull()
    expect(breakerDefaultsFromJson([1670, 10000], [167, 0], [167, 10000])).toBeNull()
    expect(breakerDefaultsFromJson([1670, 10000], [167, 10000], 'x')).toBeNull()
  })
})

// ── the deposit fuse's period ───────────────────────────────────────────────
// pallet_circuit_breaker's `Period = DAYS` is derived from MILLISECS_PER_BLOCK
// and is NOT a metadata constant (verified against the live runtime: the pallet
// publishes only its three default limit rationals), so it is derived from the
// resolved block time and follows a runtime upgrade by itself. The env pin it
// replaced sat at 14 400 for ~1.27M blocks of the 2s runtime.
const resolved = (nominalMs: number, source: 'metadata' | 'measured' | 'held', measuredMs: number | null): ResolvedBlockTime =>
  ({ nominalMs, source, measuredMs })

describe('fusePeriodFromBlockTime', () => {
  it('is one day of blocks at the runtime slot time', () => {
    expect(fusePeriodFromBlockTime(resolved(6_000, 'metadata', null))).toEqual({ blocks: 14_400, source: 'metadata' })
    expect(fusePeriodFromBlockTime(resolved(2_000, 'metadata', 2_140))).toEqual({ blocks: 43_200, source: 'metadata' })
  })
  it('follows an inferred slot time when the node is unreachable', () => {
    expect(fusePeriodFromBlockTime(resolved(2_000, 'measured', 2_140))).toEqual({ blocks: 43_200, source: 'measured' })
  })
  it('carries a held resolution as held, so the caller can say the verdicts are unverified', () => {
    expect(fusePeriodFromBlockTime(resolved(6_000, 'held', null))).toEqual({ blocks: 14_400, source: 'held' })
  })
  it('does not depend on the measured pace, only on the nominal', () => {
    // Elastic scaling runs ~7% ahead of nominal; the runtime still means 43 200.
    for (const measured of [1_850, 2_000, 2_140, 2_727]) {
      expect(fusePeriodFromBlockTime(resolved(2_000, 'metadata', measured)).blocks).toBe(43_200)
    }
  })
})

describe('fusePeriodWarning', () => {
  it('is silent on an established block time', () => {
    expect(fusePeriodWarning(resolved(2_000, 'metadata', null))).toBeNull()
    expect(fusePeriodWarning(resolved(2_000, 'metadata', 2_140))).toBeNull()
    expect(fusePeriodWarning(resolved(2_000, 'measured', 2_140))).toBeNull()
  })

  // "I checked and it holds" and "I could not check" must not read the same.
  it('says UNVERIFIED when the chain could not be consulted', () => {
    const warning = fusePeriodWarning(resolved(6_000, 'held', null))
    expect(warning).toContain('UNVERIFIED')
    expect(warning).toContain('14400 blocks')
    expect(warning).toContain('could not be measured')
  })

  it('surfaces a stall that held the resolution', () => {
    const warning = fusePeriodWarning(resolved(2_000, 'held', 10_454))
    expect(warning).toContain('held at 43200 blocks')
    expect(warning).toContain('10454ms/block')
    expect(warning).not.toContain('UNVERIFIED')
  })
})

// The check runs on every 60s security refresh, but the condition it reports is
// a standing one, so the log is rate limited.
describe('shouldLogStandingWarning', () => {
  it('always logs the first occurrence', () => {
    expect(shouldLogStandingWarning(1_000_000, 0)).toBe(true)
  })

  it('stays quiet for an hour and then repeats', () => {
    const at = 1_000_000_000
    expect(shouldLogStandingWarning(at + 60_000, at)).toBe(false)
    expect(shouldLogStandingWarning(at + 59 * 60_000, at)).toBe(false)
    expect(shouldLogStandingWarning(at + 3_600_000, at)).toBe(true)
  })
})

describe('parseGigaUnbondingBlocks', () => {
  it('reports "not set" rather than a value, so the chain read can win', () => {
    expect(parseGigaUnbondingBlocks(undefined)).toBeNull()
    expect(parseGigaUnbondingBlocks('')).toBeNull()
    expect(parseGigaUnbondingBlocks('  ')).toBeNull()
  })

  it('takes the migration-day override', () => {
    // 28 days of 2s blocks, if the runtime rescales gigaHdx.cooldownPeriod.
    expect(parseGigaUnbondingBlocks('1209600')).toBe(1_209_600)
  })

  it('ignores a nonsense override rather than adopting it', () => {
    for (const bad of ['0', '-5', 'twentyeight', '1.5']) expect(parseGigaUnbondingBlocks(bad)).toBeNull()
  })
})

describe('gigaUnbondingBlocks', () => {
  // No node connection in a unit test, so runtimeConstants reports null and the
  // resolver must land on the documented pin rather than throwing or reporting 0.
  // The pin tracks the LIVE constant: runtime 440 moved it to 1,209,600 with the
  // 6s → 2s rescale, keeping the nominal 28 days. Pinning the superseded 403,200
  // would understate the wait threefold and show positions as claimable early.
  it('falls back to the pinned 28-day cooldown with no chain and no override', () => {
    expect(gigaUnbondingBlocks()).toBe(1_209_600)
  })

  it('prefers an explicit operator override over everything', () => {
    const previous = process.env.GIGA_UNBONDING_BLOCKS
    // Deliberately not the pinned default, or this would pass even if the
    // override were ignored entirely.
    process.env.GIGA_UNBONDING_BLOCKS = '654321'
    try {
      expect(gigaUnbondingBlocks()).toBe(654_321)
    } finally {
      if (previous == null) delete process.env.GIGA_UNBONDING_BLOCKS
      else process.env.GIGA_UNBONDING_BLOCKS = previous
    }
  })
})

// ── the wall-clock-anchored sample and the refusal to move ──────────────────
// A 100-block window can sit entirely inside one stall; a day cannot. Measured
// over 600k blocks, aligned 100-block windows ranged 4454-10454ms while the
// 24h-anchored figure stayed at ~5.6s throughout.
describe('dailyBlockCountSql', () => {
  it('counts a fixed span of wall clock, not a fixed number of blocks', () => {
    const sql = dailyBlockCountSql()
    expect(sql).toContain('INTERVAL 24 HOUR')
    expect(sql).toContain('price_data.blocks')
    expect(sql).toContain('count()')
    expect(sql).not.toContain('LIMIT')
  })
})

describe('dailyBlockMs', () => {
  it('turns a day of blocks into a per-block average', () => {
    expect(dailyBlockMs(14_400)).toBe(6_000)
    expect(dailyBlockMs(43_200)).toBe(2_000)
    // The live Aug 2026 count.
    expect(Math.round(dailyBlockMs(15_461) as number)).toBe(5_588)
  })

  it('refuses a sample too small to be a day of chain', () => {
    for (const n of [null, undefined, NaN, 0, -1, 999]) expect(dailyBlockMs(n as number)).toBeNull()
  })

  it('refuses an implausible average instead of substituting one', () => {
    // 2000 blocks/day = 43.2s per block: a stalled or half-ingested day.
    expect(dailyBlockMs(2_000)).toBeNull()
  })
})

describe('decideParaBlockTime', () => {
  it('prefers runtime metadata over any measurement', () => {
    const d = decideParaBlockTime(2_000, 5_588, 6_000)
    expect(d.nominalMs).toBe(2_000)
    expect(d.source).toBe('metadata')
    // ...and says so, because every block count derived from it is about to move.
    expect(d.warning).toContain('deposit-fuse period')
  })

  it('is quiet when metadata confirms what was already held', () => {
    expect(decideParaBlockTime(6_000, 5_588, 6_000).warning).toBeNull()
  })

  it('infers from a good measurement when metadata is unavailable', () => {
    const d = decideParaBlockTime(null, 5_588, null)
    expect(d).toMatchObject({ nominalMs: 6_000, source: 'measured', warning: null })
  })

  // THE load-bearing guard: an out-of-band sample must not MOVE the value. The
  // reviewer's 600k-block sweep found ~1% of 100-block windows above the old
  // 6s/12s boundary; holding is what keeps such a moment from rescaling every
  // projected date and republishing the whole lock snapshot.
  it('holds the previous value on an out-of-band measurement instead of moving', () => {
    const d = decideParaBlockTime(null, 10_454, 6_000)
    expect(d.nominalMs).toBe(6_000)
    expect(d.source).toBe('held')
    expect(d.measuredMs).toBe(10_454)
    expect(d.warning).toContain('holding 6000ms/block rather than moving')
  })

  it('holds a 2s resolution through a stall just as firmly', () => {
    const d = decideParaBlockTime(null, 9_000, 2_000)
    expect(d.nominalMs).toBe(2_000)
    expect(d.source).toBe('held')
  })

  it('holds, and reports null, when the chain cannot be measured at all', () => {
    const d = decideParaBlockTime(null, null, 2_000)
    expect(d).toMatchObject({ nominalMs: 2_000, source: 'held', measuredMs: null })
    expect(d.warning).toContain('could not be measured')
  })

  it('starts from the nominal before anything has been established', () => {
    expect(decideParaBlockTime(null, null, null).nominalMs).toBe(NOMINAL_PARA_BLOCK_MS)
    expect(decideParaBlockTime(null, 10_454, null).nominalMs).toBe(NOMINAL_PARA_BLOCK_MS)
  })

  it('still moves when the chain genuinely upgrades and metadata is down', () => {
    const d = decideParaBlockTime(null, 1_990, 6_000)
    expect(d).toMatchObject({ nominalMs: 2_000, source: 'measured' })
  })
})

describe('measuredParaBlockMs degradation', () => {
  it('degrades a failed measurement to the runtime-reported nominal, not the constant', async () => {
    // With the mocked runtime on a 2s slot, one broken 100-block read must not
    // report 6s throughput for a cache window on a 2s chain.
    const failing = { query: vi.fn(async () => { throw new Error('clickhouse down') }) }
    await expect(measuredParaBlockMs(failing as never)).resolves.toBe(2_000)
  })
})
