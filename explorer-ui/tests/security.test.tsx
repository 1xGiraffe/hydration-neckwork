import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Security } from '../src/pages/Security'
import { fmtBlocks, fmtDuration, fmtPct, loadColor } from '../src/utils/security'
import { parseRoute, paths, SECURITY_SECTIONS } from '../src/router'
import type { SecuritySection } from '../src/router'
import type { ExplorerStats, SecurityDashboard } from '../src/types'

const DOT = { assetId: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachainId: null }
const ASTR = { assetId: 9, symbol: 'ASTR', name: 'Astar', decimals: 18, parachainId: 2006 }
const SKY = { assetId: 1000795, symbol: 'SKY', name: 'Sky', decimals: 18, parachainId: null }
const HDX = { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null }
const account = (accountId: string, address: string) => ({ accountId, address, emoji: '🦛', tag: null })

function mockData(): SecurityDashboard {
  return {
    head: { blockHeight: 13_554_516, blockTimestamp: '2026-08-10 20:50:30' },
    chainAsOf: '2026-08-10T20:51:18.000Z',
    chainBlock: 13_554_524,
    withdraw: {
      configured: true,
      limit: 1_000_000_000,
      used: 20_503_404,
      usagePct: 2.05,
      windowMs: 21_600_000,
      lastCreditedMs: Date.parse('2026-08-10T20:47:06Z'),
      lockdownUntilMs: null,
      armedAt: { blockHeight: 11_998_954, blockTimestamp: '2026-04-06 11:15:12' },
      everTripped: false,
      egressAccounts: [{ account: account('0x7369626ce8030000000000000000000000000000000000000000000000000000', '13cKp89UHns9eDQQV3CZ1seFH6QQ6bnVeLHe4SpsekeJse1r'), chain: 'AssetHub' }],
      localAssets: [HDX],
      externalAssetCount: 56,
    },
    fuses: {
      periodBlocks: 14_400,
      rows: [
        { asset: ASTR, status: 'active', limit: (16_831_140n * 10n ** 18n).toString(), used: (424_804n * 10n ** 18n).toString(), headroom: '0', usagePct: 2.52, untilBlock: null, periodEndBlock: 13_560_000, category: 'external', lockdownCount: 1 },
        { asset: DOT, status: 'locked', limit: (5_000_000n * 10n ** 10n).toString(), used: '0', headroom: '0', usagePct: 100, untilBlock: 13_560_000, periodEndBlock: null, category: 'external', lockdownCount: 3 },
        { asset: SKY, status: 'expired', limit: (118_000n * 10n ** 18n).toString(), used: '0', headroom: (118_000n * 10n ** 18n).toString(), usagePct: 0, untilBlock: null, periodEndBlock: 13_500_000, category: 'external', lockdownCount: 2 },
      ],
      lockedCount: 1,
      frozenCount: 0,
      lockdownTotal: 26,
      releaseTotal: 108,
      lockdowns: [
        { asset: DOT, blockHeight: 13_112_383, blockTimestamp: '2026-07-13 06:29:51', untilBlock: 13_126_783, liftedAtBlock: 13_137_370, liftedAtTimestamp: '2026-07-14 18:18:57', liftedEarly: false, extrinsicIndex: null },
        { asset: SKY, blockHeight: 12_000_000, blockTimestamp: '2026-04-06 12:00:00', untilBlock: 12_014_400, liftedAtBlock: 12_001_000, liftedAtTimestamp: '2026-04-06 13:40:00', liftedEarly: true, extrinsicIndex: 3 },
      ],
    },
    perBlock: {
      defaultTradePct: 50,
      defaultAddPct: 5,
      defaultRemovePct: 5,
      peakWindowDays: 30,
      rows: [
        {
          asset: DOT, reserve: (500_000n * 10n ** 10n).toString(), reserveUsd: 2_200_000,
          tradeLimitPct: 50, tradeAllowance: (250_000n * 10n ** 10n).toString(), tradeAllowanceUsd: 1_100_000,
          addLimitPct: 5, addAllowance: (25_000n * 10n ** 10n).toString(),
          removeLimitPct: 5, removeAllowance: (25_000n * 10n ** 10n).toString(),
          overridden: false, peakBlockNet: (4_000n * 10n ** 10n).toString(), peakBlockHeight: 13_500_000,
          peakPressurePct: 1.6, tradable: ['Sell', 'Buy', 'Add liquidity', 'Remove liquidity'],
        },
        {
          asset: ASTR, reserve: (1_000_000n * 10n ** 18n).toString(), reserveUsd: 40_000,
          tradeLimitPct: 50, tradeAllowance: (500_000n * 10n ** 18n).toString(), tradeAllowanceUsd: 20_000,
          addLimitPct: null, addAllowance: null,
          removeLimitPct: 5, removeAllowance: (50_000n * 10n ** 18n).toString(),
          overridden: true, peakBlockNet: null, peakBlockHeight: null, peakPressurePct: null,
          tradable: ['Sell', 'Buy', 'Remove liquidity'],
        },
      ],
    },
    trips: {
      total: 438,
      enforcementTotal: 431,
      directTotal: 253,
      nestedTotal: 185,
      byError: [
        { name: 'MaxLiquidityLimitPerBlockReached', count: 430, enforcement: true },
        { name: 'AssetInLockdown', count: 1, enforcement: true },
        { name: 'InvalidAmount', count: 5, enforcement: false },
        { name: 'AssetNotInLockdown', count: 2, enforcement: false },
      ],
      byYear: [{ year: 2023, count: 38 }, { year: 2024, count: 94 }, { year: 2025, count: 161 }, { year: 2026, count: 138 }],
      recent: [
        { blockHeight: 13_366_828, blockTimestamp: '2026-07-29 08:23:27', extrinsicId: '13366828-4', callName: 'Omnipool.remove_liquidity', errorName: 'MaxLiquidityLimitPerBlockReached', account: account('0xaa', '15dbuPRSHXXMhnfuo7Fp8LXBUEhMKeZRcZBZBnz6R5C5WMHv') },
      ],
    },
    freezes: {
      paused: [
        { pallet: 'PolkadotXcm', call: 'claim_assets', pausedAtBlock: 13_469_888, pausedAtTimestamp: '2026-08-05 08:51:42', extrinsicIndex: 3, orphaned: false },
        { pallet: 'Elections', call: 'vote', pausedAtBlock: 8_450_540, pausedAtTimestamp: '2025-07-22 13:14:36', extrinsicIndex: 2, orphaned: true },
      ],
      hubTradability: ['Sell'],
      omnipool: [],
      omnipoolAssetCount: 19,
      delisted: [{ asset: SKY, poolId: null, bits: 0, flags: ['Frozen'] }],
      stableswap: [],
    },
    risk: {
      windowDays: 30,
      markets: [
        { key: 'core', label: 'Money Market', role: 'primary', borrowers: 662, debtUsd: 15_712_980, collateralUsd: 31_400_000, underwaterCount: 54, underwaterDebtUsd: 8_797.34, underwaterCollateralUsd: 0.17, badDebtCount: 45, badDebtUsd: 8_795.14, liquidatableCount: 9, liquidatableDebtUsd: 2.20, nearLiquidationCount: 24, nearLiquidationDebtUsd: 65_341 },
        { key: 'gigahdx', label: 'GIGAHDX', role: 'supplemental', borrowers: 53, debtUsd: 223_622, collateralUsd: 900_000, underwaterCount: 0, underwaterDebtUsd: 0, underwaterCollateralUsd: 0, badDebtCount: 0, badDebtUsd: 0, liquidatableCount: 0, liquidatableDebtUsd: 0, nearLiquidationCount: 0, nearLiquidationDebtUsd: 0 },
      ],
      liquidations: {
        day: 0, week: 5, month: 487, total: 8_358, lastTimestamp: '2026-08-09 01:44:45',
        recent: [{ blockHeight: 13_526_292, blockTimestamp: '2026-08-09 01:44:45', extrinsicIndex: 2, borrower: account('0x4a7a', '0x4a7acf7f326f3917cb1f4024185950dff92af50e'), collateral: DOT, debt: ASTR }],
      },
      largestMoves: [
        { asset: ASTR, kind: 'add', amount: (59_324n * 10n ** 18n).toString(), blockHeight: 13_451_312, blockTimestamp: '2026-08-01 10:00:00', extrinsicIndex: 4, allowance: (56_000n * 10n ** 18n).toString(), shareOfAllowancePct: 105.9 },
        { asset: DOT, kind: 'remove', amount: (1_000n * 10n ** 10n).toString(), blockHeight: 13_400_000, blockTimestamp: '2026-07-30 10:00:00', extrinsicIndex: null, allowance: (25_000n * 10n ** 10n).toString(), shareOfAllowancePct: 4 },
      ],
    },
    runtime: { specVersion: 435, upgrades: 64, lastUpgrade: { blockHeight: 13_478_846, blockTimestamp: '2026-08-05 22:59:42' } },
    timeline: [
      { kind: 'pause', label: 'Call paused', detail: 'PolkadotXcm.claim_assets', blockHeight: 13_469_888, blockTimestamp: '2026-08-05 08:51:42', extrinsicIndex: 3, asset: null },
      { kind: 'lockdown', label: 'Deposit fuse tripped', detail: 'USDT locked until block 13,126,783', blockHeight: 13_112_383, blockTimestamp: '2026-07-13 06:29:51', extrinsicIndex: null, asset: DOT },
      { kind: 'limit', label: 'Global withdraw limit set', detail: '1,000,000,000 HDX per 6h', blockHeight: 11_998_954, blockTimestamp: '2026-04-06 11:15:12', extrinsicIndex: 5, asset: null },
    ],
    guardians: {
      techCommittee: {
        members: [account('0x1ad9', '7JCmEdYEruZ6eQAoLRpU6btAyEcdjFpgDiusjqhyd4cKtB7D')],
        size: 7,
        majority: 4,
        superMajority: 5,
      },
      memberSetAtBlock: 12_563_525,
      outstandingWhitelisted: [{ callHash: '0x95dddfa3a727e46ac23c451d603846dafd4c8d50f0ae1144ab99077dd9dc650a', blockHeight: 11_168_260, blockTimestamp: '2026-01-30 22:00:12' }],
    },
    // The Wormhole overview card and section have their own suite
    // (security-wormhole.test.tsx); here the summary is absent, which is the
    // state before the first custody snapshot.
    wormhole: null,
  }
}

// `stats` seeds the chain's two block times; omitted, the page renders without
// them and every conversion falls back to the nominal constant.
function render(data: SecurityDashboard, section: SecuritySection | null = null, stats?: Partial<ExplorerStats>): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(['security-dashboard'], data)
  if (stats) {
    queryClient.setQueryData(['stats'], {
      headBlock: data.chainBlock ?? data.head.blockHeight, finalizedBlock: data.head.blockHeight, headTime: data.head.blockTimestamp,
      avgBlockSec: 6, nominalBlockSec: 6, transfers24h: 0, extrinsics24h: 0, activeAccounts24h: 0, hdxPrice: null,
      ...stats,
    } satisfies ExplorerStats)
  }
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}><Security section={section} /></QueryClientProvider>)
}

describe('/security routes', () => {
  it('resolves the overview and every section, and round-trips through paths', () => {
    expect(parseRoute('/security')).toEqual({ name: 'security', section: null })
    expect(paths.security()).toBe('/security')
    for (const section of SECURITY_SECTIONS) {
      expect(parseRoute(`/security/${section}`)).toEqual({ name: 'security', section })
      expect(paths.security(section)).toBe(`/security/${section}`)
    }
  })
  it('falls back to the overview for an unknown section', () => {
    expect(parseRoute('/security/nope')).toEqual({ name: 'security', section: null })
    // The retired ?tab= form lands on the overview rather than a dead page.
    expect(parseRoute('/security?tab=risk')).toEqual({ name: 'security', section: null })
  })
})

describe('Security section pages', () => {
  it('renders each section on its own page, under its own crumb', () => {
    const cases: [SecuritySection, string][] = [
      ['cross-chain', 'Withdraw limit'],
      ['omnipool', 'Per-block limits'],
      ['money-market', 'Solvency'],
      ['freezes', 'Freezes &amp; pauses'],
      ['ledger', 'Safety ledger'],
      ['guardians', 'Guardians'],
    ]
    for (const [section, heading] of cases) {
      const html = render(mockData(), section)
      expect(html, section).toContain(heading)
      // The crumb trail leads back to the overview.
      expect(html, section).toContain('href="/security"')
    }
  })

  // A registry `xcm_rate_limit` of zero arms the fuse with no headroom, so the
  // asset admits nothing at all. It is the strictest state a fuse has, and used
  // to be invisible — a zero read as "carries no limit" and dropped the row.
  it('shows an asset frozen at a zero limit as shut, not as unused', () => {
    const data = mockData()
    data.fuses = {
      ...data.fuses,
      frozenCount: 1,
      rows: [
        { asset: SKY, status: 'frozen', limit: '0', used: '0', headroom: '0', usagePct: 100, untilBlock: null, periodEndBlock: null, category: 'external', lockdownCount: 0 },
        ...data.fuses.rows,
      ],
    }
    const crossChain = render(data, 'cross-chain')
    expect(crossChain).toContain('Frozen')
    expect(crossChain).toContain('no deposit accepted')
    expect(crossChain).toContain('FRZ')

    // The overview counts it alongside the lockdown rather than reporting idle.
    const overview = render(data)
    expect(overview).toContain('2 shut')
    expect(overview).toContain('1 locked down · 1 held at a zero limit')
  })

  it('keeps the money market and the Omnipool on separate pages', () => {
    const mm = render(mockData(), 'money-market')
    expect(mm).toContain('Solvency')
    expect(mm).toContain('Liquidations')
    expect(mm).not.toContain('Largest liquidity moves')

    const omni = render(mockData(), 'omnipool')
    expect(omni).toContain('Per-block limits')
    expect(omni).toContain('Largest liquidity moves')
    expect(omni).not.toContain('Solvency')
  })

  // The page carries both kinds of number, and they do NOT convert at the same
  // rate (api/src/services/blockTime.ts). A pallet CONSTANT — the fuse period,
  // a scheduled lockdown span — is derived from the runtime's slot time, so it
  // is stated at the nominal; a LIVE delta plays out at the pace the chain is
  // actually producing. A measured 2s against a nominal 6s tells them apart:
  // conflating the two reports the runtime's 24h day as 8h.
  it('states pallet windows at the nominal slot time and live deltas at the measured pace', () => {
    const data = mockData()
    // A lockdown still running, so its span is the scheduled one rather than an
    // observed gap between two produced blocks.
    data.fuses.lockdowns.unshift({
      asset: DOT, blockHeight: 13_540_000, blockTimestamp: '2026-08-09 12:00:00', untilBlock: 13_554_400,
      liftedAtBlock: null, liftedAtTimestamp: null, liftedEarly: null, extrinsicIndex: null,
    })
    const html = render(data, 'cross-chain', { avgBlockSec: 2, nominalBlockSec: 6 })

    // 14 400 blocks is the runtime's DAYS, and a day is a day in every era.
    expect(html).toContain('24 h window')
    expect(html).toContain('24 h (scheduled)')
    expect(html).not.toContain('8 h (scheduled)')
    // 13 560 000 − 13 554 524 = 5 476 blocks still to be produced, at 2s each.
    expect(html).toContain('unlocks in 3 h')
    expect(html).toContain('resets in 3 h')
    expect(html).not.toContain('unlocks in 9.1 h')
  })

  it('uses indexed timestamps for elapsed history instead of today\'s block pace', () => {
    const data = mockData()
    const crossChain = render(data, 'cross-chain', { avgBlockSec: 2, nominalBlockSec: 2 })
    // The first lockdown lasted from 06:29:51 to 18:18:57: 35h49m. Its block
    // delta at today's hypothetical 2s pace would incorrectly read 13.9h.
    expect(crossChain).toContain('35.8 h')
    expect(crossChain).not.toContain('13.9 h')
  })
})

describe('Security page overview', () => {
  // The tab lives in the query string, and a server render always reports the
  // default location — so this file owns the overview and e2e/security.spec.ts owns
  // what each tab shows once a reader switches.
  it('opens every section from a tile, as a real link', () => {
    const html = render(mockData())
    for (const slug of ['cross-chain', 'omnipool', 'money-market', 'freezes', 'ledger', 'guardians']) {
      expect(html).toContain(`href="/security/${slug}"`)
    }
    // Tiles are links, not buttons: a path change is what resets the scroll and
    // gives each section its own history entry.
    expect(html).not.toContain('<button type="button" class="hdx-card sec-ov-card"')
  })

  it('makes each ribbon number open the section that explains it', () => {
    const html = render(mockData())
    expect(html).toContain('sec-ribbon-cell')
    expect(html).toContain('Assets locked')
    expect(html).toContain('Egress used')
  })

  it('shows the posture numbers in the ribbon', () => {
    const html = render(mockData())
    expect(html).toContain('Assets locked')
    expect(html).toContain('2.05%')   // egress used
    expect(html).toContain('431')     // enforcement trips, not the 438 total
  })

  it('leads with the two live instruments — the egress meter and the fuse grid', () => {
    const html = render(mockData())
    expect(html).toContain('20,503,404')
    expect(html).toContain('1,000,000,000 HDX')
    expect(html).toContain('6 h')
    expect(html).toContain('It has never been tripped.')
    // The limit is armed in every state but a governance lockdown, so only the
    // lockdown earns a badge — an always-on "Armed" chip said nothing.
    expect(html).not.toContain('Locked down')

    // Only the gauges carrying load: the locked DOT fuse and ASTR at 2.52%. The
    // idle SKY fuse is left to the cross-chain page, and the count says so.
    const fuses = html.match(/class="fuse[ "]/g) ?? []
    expect(fuses).toHaveLength(2)
    expect(html).toContain('class="fuse locked"')
    expect(html).toContain('LOCK')
    expect(html).toContain('showing the 2 carrying load of 3')
    expect(html).toContain('See the ingress detail')
  })

  it('summarises each area in a card that opens its tab', () => {
    const html = render(mockData())
    expect(html).toContain('Deposit fuses')
    expect(html).toContain('Per-block limits')
    expect(html).toContain('Breaker trips')
    expect(html).toContain('Borrowed')
    expect(html).toContain('$15.7M')          // primary-market debt
    expect(html).toContain('Bad debt')
    expect(html).toContain('$8.8k')           // unrecoverable, not the under-water total
    expect(html).toContain('unrecoverable, on 45 of the 54 positions under water')
    expect(html).toContain('Liquidations')
    expect(html).toContain('487')
    expect(html).toContain('Switched off')
    expect(html).toContain('2 calls')
    expect(html).toContain('spec 435')
    // Cards are buttons that switch tabs, not links that leave the page.
    expect(html).toContain('sec-ov-card')
  })

  it('previews the newest safety actions and offers the full ledger', () => {
    const html = render(mockData())
    expect(html).toContain('Latest safety action')
    expect(html).toContain('Open the full ledger')
    expect(html).toContain('PolkadotXcm.claim_assets')
  })

  it('keeps the chain-state timestamp visible so a stale snapshot is obvious', () => {
    const html = render(mockData())
    expect(html).toContain('13,554,524')
    expect(html).toContain('13,554,516')
  })

  it('withholds the live limits, and says so, when chain state is unavailable', () => {
    const data = mockData()
    data.chainAsOf = null
    data.chainBlock = null
    data.withdraw = { ...data.withdraw, configured: false, usagePct: null, used: null, limit: null }
    data.risk = { ...data.risk, markets: data.risk.markets.map(m => ({ ...m, nearLiquidationCount: null, nearLiquidationDebtUsd: null })) }
    const html = render(data)
    expect(html).toContain('Chain state is unavailable')
    expect(html).not.toContain('20,503,404')
    // The fuse grid and the summary cards still render from indexed data.
    expect(html).toContain('Value arriving, per asset')
    expect(html).toContain('Bad debt')
  })

  it('renders with no fuses, no trips and nothing paused', () => {
    const data = mockData()
    data.fuses = { ...data.fuses, rows: [], lockedCount: 0, frozenCount: 0, lockdownTotal: 0, releaseTotal: 0, lockdowns: [] }
    data.trips = { ...data.trips, total: 0, enforcementTotal: 0, directTotal: 0, nestedTotal: 0, byError: [], byYear: [], recent: [] }
    data.freezes = { ...data.freezes, paused: [], delisted: [] }
    data.timeline = []
    const html = render(data)
    expect(html).toContain('No asset is minting against its limit right now.')
    expect(html).toContain('no asset is minting against its limit')
    expect(html).toContain('No safety action on record')
  })

  it('badges the withdraw limit only while a lockdown is armed', () => {
    const data = mockData()
    data.withdraw = { ...data.withdraw, lockdownUntilMs: Date.parse('2026-08-11T00:00:00Z') }
    const html = render(data)
    expect(html).toContain('Locked down')
  })

  it('says every position is covered when no market is under water', () => {
    const data = mockData()
    data.risk = {
      ...data.risk,
      markets: data.risk.markets.map(m => ({ ...m, underwaterCount: 0, underwaterDebtUsd: 0, underwaterCollateralUsd: 0, badDebtCount: 0, badDebtUsd: 0, liquidatableCount: 0, liquidatableDebtUsd: 0, nearLiquidationCount: 0, nearLiquidationDebtUsd: 0 })),
    }
    const html = render(data)
    expect(html).toContain('every position covers its debt')
  })
})

describe('security formatting', () => {
  it('escalates the load colour at the half and three-quarter marks', () => {
    expect(loadColor(0)).toBe('var(--green)')
    expect(loadColor(49.9)).toBe('var(--green)')
    expect(loadColor(50)).toBe('var(--amber)')
    expect(loadColor(74.9)).toBe('var(--amber)')
    expect(loadColor(75)).toBe('var(--red)')
    expect(loadColor(100)).toBe('var(--red)')
  })

  it('keeps a tiny non-zero percentage distinguishable from zero', () => {
    expect(fmtPct(0)).toBe('0%')
    expect(fmtPct(0.001)).toBe('<0.01%')
    expect(fmtPct(2.5)).toBe('2.5%')
    expect(fmtPct(2.567)).toBe('2.57%')
    expect(fmtPct(50, 0)).toBe('50%')
    expect(fmtPct(null)).toBe('—')
  })

  // The domain speaks in hours (the fuse period is "24h", not "one day"), so days
  // only take over once hours stop reading.
  it('says a block count in hours up to two days, then days', () => {
    expect(fmtBlocks(5, 6)).toBe('<1 min')
    expect(fmtBlocks(10, 6)).toBe('1 min')
    expect(fmtBlocks(600, 6)).toBe('1 h')
    expect(fmtBlocks(14_400, 6)).toBe('24 h')
    expect(fmtBlocks(28_800, 6)).toBe('2 d')
    expect(fmtBlocks(100_800, 6)).toBe('7 d')
  })

  // The pallet's windows are block counts; what they are worth in hours is the
  // chain's pace, so the same fuse period reads 24h before and after a block-time
  // change instead of tripling on the day the chain speeds up.
  it('converts a block count at the measured pace, not a fixed one', () => {
    expect(fmtBlocks(14_400, 2)).toBe('8 h')
    expect(fmtBlocks(43_200, 2)).toBe('24 h')
    expect(fmtBlocks(7_200, 12)).toBe('24 h')
    // A measured pace is fractional: 14,400 blocks at 5.63s is 22.5h.
    expect(fmtBlocks(14_400, 5.63)).toBe('22.5 h')
  })

  it('says a millisecond window the same way', () => {
    expect(fmtDuration(21_600_000)).toBe('6 h')
    expect(fmtDuration(86_400_000)).toBe('24 h')
    expect(fmtDuration(172_800_000)).toBe('2 d')
    expect(fmtDuration(0)).toBe('—')
  })
})
