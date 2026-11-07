import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Juicer } from '../src/pages/Juicer'
import { JuicerPositions } from '../src/components/positions/JuicerPositions'
import { parseRoute, paths } from '../src/router'
import { NAV_CONFIG } from '../src/components/navConfig'
import { activityBadge, CAT } from '../src/components/activityColors'
import { activityLabel, activitySlug, SLUG_TYPES } from '../src/components/ActivityTable'
import type { AccountJuicer, ActivityRow, JuicerDashboard } from '../src/types'

const GETH = { assetId: 4200, symbol: 'GETH', name: '2-Pool-GETH', decimals: 18, parachainId: null }
const JETH = { assetId: 5551, symbol: 'jETH', name: 'Juicer ETH', decimals: 18, parachainId: null }
const ETH = { assetId: 34, symbol: 'ETH', name: 'Ethereum', decimals: 18, parachainId: null }
const acct = (h: string) => ({ accountId: '0x45544800' + h.slice(2) + '0'.repeat(16), address: h })
const VAULT = acct('0x98db179d65b8abc53946bd89b3433a4fd3bfb60c')
const LOOP = acct('0x2df1d70f413b5edd16bb794791117948a7436a45')
const HOLDER = acct('0x553f022201fa7c88e6cc10d1c688b157d6fa7775')

function dashboard(over: Partial<JuicerDashboard> = {}): JuicerDashboard {
  return {
    generatedAt: '2026-11-07T12:00:00.000Z', asOfBlock: 16_729_229, launchBlock: 16_683_445,
    vaults: [{
      vault: VAULT, name: 'Juicer ETH', shareAsset: JETH, collateral: GETH, baseAsset: ETH, status: 'full',
      paused: false, depositsPaused: false, deficitStop: false, deleverPending: false,
      tvl: '44396384373040580239', tvlUsd: 101_460, cap: '44400000000000000000', remaining: '3615626959419761',
      sharesOutstanding: '44396384373040580239', exchangeRate: '1000000000000000000', apyPct: 7.11, runRateApyPct: -0.4, deployedFraction: 0.986, deploying: false,
      maxLtvBps: 8000, targetLtvBps: 7500, releverLtvBps: 6500, deleverLtvBps: 8300, liquidationThresholdBps: 8500,
      exitHeadroom: { enabled: true, gapBps: 0 },
      main: { collateralUsd: 101_883, syntheticUsd: 76_897, debtUsd: 75_359, healthFactor: 2.15, ltv: 0.74 },
      protocolFeeBps: 6900, mainDiscountBps: 4000, withdrawalDelaySec: 604_800, holders: 1,
      positions: [{ account: HOLDER, totalShares: '5863068850281047237', totalAssets: '5863068850281047237', totalUsd: 13_394, shares: '5764825606493326523', assets: '5764825606493326523', valueUsd: 13_170, share: 0.191, inWithdrawal: '98243243787720714', inWithdrawalAssets: '98243243787720714', inWithdrawalUsd: 224 }],
      withdrawals: [{ requestId: 0, owner: HOLDER, shares: '98243243787720714', status: 'cooldown', requestedAt: '2026-11-06 10:22:26', eligibleAt: '2026-11-13T10:22:26.000Z', collateralOwed: null, collateralSettled: '0', claimed: '0', assets: '98243243787720714', valueUsd: 224 }],
    }],
    loop: { account: LOOP, collateralUsd: 75_559, debtUsd: 372, healthFactor: 178.9, targetHf: 1.05, leverage: 1.005, targetLeverage: 6.18, borrowRatePct: 4.4, loopDiscountBps: 9000, primeSupplyApyPct: 6.75, primeLtBps: 8800, emergencyPaused: false },
    totals: { tvlUsd: 101_460, depositors: 19, deposits: 27, depositsUsd: 101_000, withdrawals: 3, claims: 0, claimsUsd: 0, harvests: 0, harvestsUsd: 0, rebalances: 47, unpricedRows: 0 },
    perDay: [
      { day: '2026-11-05', deposits: 10, depositsUsd: 40_000, withdrawals: 0, withdrawShares: '0', claims: 0, claimsUsd: 0, harvestsUsd: 0, rebalances: 20 },
      { day: '2026-11-06', deposits: 17, depositsUsd: 61_000, withdrawals: 3, withdrawShares: '14397665489126807402', claims: 0, claimsUsd: 0, harvestsUsd: 0, rebalances: 27 },
    ],
    contracts: [{ role: 'Juicer ETH vault (CollateralVault, the jETH token)', account: VAULT }, { role: 'PRIME loop (SubLoop)', account: LOOP }],
    ...over,
  }
}
function render(data: JuicerDashboard): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['juicer-dashboard'], data)
  return renderToStaticMarkup(<QueryClientProvider client={client}><Juicer /></QueryClientProvider>)
}

describe('the /juicer route', () => {
  it('is its own page under paths.juicer', () => {
    expect(paths.juicer()).toBe('/juicer')
    expect(parseRoute('/juicer')).toEqual({ name: 'juicer' })
  })
  it('closes the Assets menu, directly after Charts, in every layout', () => {
    for (const items of [NAV_CONFIG.ASSETS_GROUP.menuItems!, NAV_CONFIG.ASSETS_FOLD_GROUP.menuItems!, NAV_CONFIG.DRAWER_LINKS]) {
      const labels = items.map(i => i.label)
      expect(labels.indexOf('Juicer')).toBe(labels.indexOf('Charts') + 1)
    }
    expect(NAV_CONFIG.ASSETS_GROUP.items.some(i => i.label === 'Juicer' && i.to === '/juicer')).toBe(true)
  })
})

describe('the Juicer page', () => {
  it('explains the strategy in the official app’s terms before any figure', () => {
    const html = render(dashboard())
    expect(html).toContain('PRIME looping strategy')
    expect(html).toContain('Requests cannot be cancelled')
    expect(html).toContain('not an unconditional guarantee')
    expect(html).toContain('Terms on this page')
    expect(html.indexOf('Terms on this page')).toBeLessThan(html.indexOf('>TVL<'))
  })
  it('states the vault as the app does: TVL, est. APY, a full cap, Main and its settings', () => {
    const html = render(dashboard())
    expect(html).toContain('$101k')
    expect(html).toContain('7.11%')
    expect(html).toContain('Vault is full')
    expect(html).toContain('69%')
    expect(html).toContain('7 days')
    expect(html).toContain('at target leverage')
    expect(html).toContain('-0.40%')
    expect(html).toContain('relevers under 65%, delevers over 83%')
  })
  it('lists positions with the shares in withdrawal, and each request with its state', () => {
    const html = render(dashboard())
    expect(html).toContain('in withdrawal')
    expect(html).toContain('#0')
    expect(html).toContain('Cooldown')
  })
  it('says when the current state is unavailable instead of showing zeros', () => {
    const html = render(dashboard({ asOfBlock: null }))
    expect(html).toContain('current state is unavailable')
  })
})

describe('Juicer activity rows', () => {
  const row = (juicerAction: ActivityRow['juicerAction']): ActivityRow => ({
    type: 'juicer', blockHeight: 16_702_270, timestamp: '2026-11-06 20:32:42', eventIndex: 64, extrinsicIndex: 3,
    who: HOLDER, to: null, asset: GETH, assetIn: null, assetOut: null, amount: '1', amountIn: null, amountOut: null, valueUsd: 2, juicerAction,
  })
  it('link each act to its own slug, which resolves back to the juicer rows', () => {
    expect(activitySlug(row('Deposit'))).toBe('juicer-deposit')
    expect(activitySlug(row('ClaimSurplus'))).toBe('juicer-claim-surplus')
    expect(SLUG_TYPES['juicer-rebalance']).toEqual(['juicer'])
    expect(activityLabel('juicer-withdraw')).toBe('Withdrawal requested')
  })
  it('wear the Juicer family’s shades', () => {
    expect(activityBadge(row('Deposit'))).toEqual({ label: 'Juicer deposit', col: CAT.juicer })
    expect(activityBadge(row('Settle')).col).toBe(CAT.juicerExit)
    expect(activityBadge(row('Harvest')).col).toBe(CAT.juicerKeeper)
  })
})

describe('the Strategies tab', () => {
  const positions: AccountJuicer = {
    asOfBlock: 16_729_229,
    positions: [{ vault: VAULT, name: 'Juicer ETH', shareAsset: JETH, collateral: GETH, apyPct: 7.11, runRateApyPct: -0.4, totalShares: '5764825606493326523', totalAssets: '5764825606493326523', totalUsd: 13_170, shares: '5764825606493326523', assets: '5764825606493326523', valueUsd: 13_170, share: 0.191, inWithdrawal: '0', inWithdrawalAssets: '0', inWithdrawalUsd: 0,
      withdrawals: [{ requestId: 2, owner: HOLDER, shares: '1', status: 'claimable', requestedAt: '2026-11-06 22:30:18', eligibleAt: null, collateralOwed: '1', collateralSettled: '1', claimed: '0', assets: '1', valueUsd: 0 }] }],
  }
  it('leads with the whole position and says how it is valued', () => {
    const html = renderToStaticMarkup(<JuicerPositions positions={positions} />)
    expect(html).toContain('Juicer ETH')
    expect(html).toContain('7.11%')
    expect(html).toContain('earning -0.40% now')
    expect(html).toContain('Claim ready')
    expect(html).toContain('in the account’s Value')
  })
  it('says unavailable rather than empty when the vault state is stale', () => {
    const html = renderToStaticMarkup(<JuicerPositions positions={{ asOfBlock: null, positions: [] }} />)
    expect(html).toContain('unknown, not empty')
  })
})
