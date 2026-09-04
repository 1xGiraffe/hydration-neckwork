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
import { paraBlockMsFromConstants } from '../src/services/runtimeConstants.ts'
import { fusePeriodPinWarning, parseFusePeriodBlocks, shouldLogFusePinWarning } from '../src/services/securityService.ts'
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

// ── the deposit fuse's period pin ───────────────────────────────────────────
// pallet_circuit_breaker's `Period = DAYS` is derived from MILLISECS_PER_BLOCK
// and is NOT a metadata constant (verified against the live runtime: the pallet
// publishes only its three default limit rationals), so it is pinned in code
// and re-pinned by hand at the migration. The tripwire is what makes a stale
// pin loud instead of silently flipping live fuses to `expired`.
describe('parseFusePeriodBlocks', () => {
  it('defaults to one day of 6s blocks', () => {
    expect(parseFusePeriodBlocks(undefined)).toBe(14_400)
    expect(parseFusePeriodBlocks('')).toBe(14_400)
    expect(parseFusePeriodBlocks('   ')).toBe(14_400)
  })

  it('takes the migration-day override', () => {
    expect(parseFusePeriodBlocks('43200')).toBe(43_200)
    expect(parseFusePeriodBlocks(' 43200 ')).toBe(43_200)
  })

  it('keeps the default rather than adopting a nonsense override', () => {
    for (const bad of ['0', '-1', 'DAYS', '43_200', '1.5']) {
      expect(parseFusePeriodBlocks(bad)).toBe(14_400)
    }
  })
})

const resolved = (nominalMs: number, source: 'metadata' | 'measured' | 'held', measuredMs: number | null): ResolvedBlockTime =>
  ({ nominalMs, source, measuredMs })

describe('fusePeriodPinWarning', () => {
  it('is silent while the pin matches the runtime', () => {
    // Today: pin 14 400, chain measured at 4.8-5.8s/block against a 6s slot.
    for (const measured of [4_806, 4_970, 5_588, 5_810, 6_000]) {
      expect(fusePeriodPinWarning(14_400, resolved(6_000, 'measured', measured))).toBeNull()
    }
    // And silent on the authoritative source, which carries no measurement.
    expect(fusePeriodPinWarning(14_400, resolved(6_000, 'metadata', null))).toBeNull()
  })

  it('trips loudly when the 2s runtime redefines DAYS', () => {
    const warning = fusePeriodPinWarning(14_400, resolved(2_000, 'metadata', 1_980))
    expect(warning).toContain('43200')
    expect(warning).toContain('SECURITY_FUSE_PERIOD_BLOCKS')
    expect(warning).toContain('STALE')
    expect(warning).toContain('runtime metadata')
  })

  it('goes silent again once the pin is moved', () => {
    expect(fusePeriodPinWarning(43_200, resolved(2_000, 'metadata', null))).toBeNull()
    expect(fusePeriodPinWarning(43_200, resolved(2_000, 'measured', 2_100))).toBeNull()
  })

  it('trips on a pin that was moved too early', () => {
    expect(fusePeriodPinWarning(43_200, resolved(6_000, 'measured', 5_588))).toContain('14400')
  })

  // The whole point of the null-vs-number distinction: "I checked and it
  // matches" and "I could not check" must not read the same in a log.
  it('says UNVERIFIED rather than nothing when the chain could not be consulted', () => {
    const warning = fusePeriodPinWarning(14_400, resolved(6_000, 'held', null))
    expect(warning).toContain('UNVERIFIED')
    expect(warning).not.toContain('STALE')
    // ...and it does not claim the pin is wrong, because it does not know.
    expect(warning).toContain('could not be checked')
  })

  it('surfaces a stall that held the resolution, even though the pin matches', () => {
    const warning = fusePeriodPinWarning(14_400, resolved(6_000, 'held', 10_454))
    expect(warning).toContain('still matches')
    expect(warning).toContain('10454ms/block')
  })
})

// The check runs on every 60s security refresh, but the condition it reports is
// a standing one, so the log is rate limited.
describe('shouldLogFusePinWarning', () => {
  it('always logs the first occurrence', () => {
    expect(shouldLogFusePinWarning(1_000_000, 0)).toBe(true)
  })

  it('stays quiet for an hour and then repeats', () => {
    const at = 1_000_000_000
    expect(shouldLogFusePinWarning(at + 60_000, at)).toBe(false)
    expect(shouldLogFusePinWarning(at + 59 * 60_000, at)).toBe(false)
    expect(shouldLogFusePinWarning(at + 3_600_000, at)).toBe(true)
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
    // ...and says so, because every hand-pinned block count now needs re-pinning.
    expect(d.warning).toContain('SECURITY_FUSE_PERIOD_BLOCKS')
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
