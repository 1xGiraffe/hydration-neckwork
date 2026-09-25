import { describe, expect, it } from 'vitest'
import { accountTools } from '../../src/mcp/tools/account.ts'
import { UpstreamError, type UpstreamClient } from '../../src/mcp/upstream.ts'
import type { ToolContext, ToolDefinition } from '../../src/mcp/toolTypes.ts'

// The three account tools against recorded shapes, with no network. What is
// pinned here is the interpretation an agent would otherwise get wrong on its
// own: the isolated money markets, the 1e18 health factor, the basis-point
// thresholds, the related-set scoping, the summary-vs-full build, and the fact
// that a series is never printed point by point.

const tool = (name: string): ToolDefinition => {
  const found = accountTools.find(t => t.name === name)
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

interface Recorded { path: string; query?: Record<string, unknown> }

function fakeUpstream(routes: Record<string, unknown>): { upstream: UpstreamClient; calls: Recorded[] } {
  const calls: Recorded[] = []
  const upstream: UpstreamClient = {
    async get<T>(path: string, query?: Record<string, string | number | boolean | null | undefined>): Promise<T> {
      calls.push({ path, query: query as Record<string, unknown> | undefined })
      if (!(path in routes)) throw new UpstreamError('Address not recognized', 404, { error: 'Address not recognized' }, path)
      const value = routes[path]
      if (value instanceof Error) throw value
      return value as T
    },
  }
  return { upstream, calls }
}

const ctxWith = (upstream: UpstreamClient, maxTextChars = 24_000): ToolContext => ({
  upstream,
  explorerBaseUrl: 'https://explorer.test',
  publicUrl: 'https://mcp.test',
  maxTextChars,
})

const ADDRESS = '12mVEpBf5btD9i8iLRKFT8FGzEpAmhh2ANBCtrrv12kcJ4dr'
const ACCOUNT_ID = '0x4e2a16e182e406a9885b2bb2a20136cc7152bc6de166c10feaf8313671d056c1'
const EVM_ID = '0x455448004e2a16e182e406a9885b2bb2a20136cc7152bc6d0000000000000000'
const DETAIL_PATH = `/explorer/address/${ADDRESS}`

const hdx = { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12 }
const hollar = { assetId: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18 }
const usdc = { assetId: 22, symbol: 'USDC', name: null, decimals: 6 }

function addressDetail(overrides: Record<string, unknown> = {}) {
  return {
    input: ADDRESS,
    kind: 'substrate',
    accountId: ACCOUNT_ID,
    emoji: '🦕',
    evmAddress: null,
    ss58: '7KN3XKJ4HvyzzQcwPxjkEu13hophEFMp3d5UevNtAuDL2PXN',
    ss58Polkadot: ADDRESS,
    tag: null,
    identity: null,
    profile: null,
    relatedAccountIds: [ACCOUNT_ID, EVM_ID],
    aliases: [],
    balances: [
      { asset: hdx, total: '444000000000000000', free: '440000000000000000', reserved: '2010000000000000', frozen: '355000000000000000', lastBlock: 14_745_010, valueUsd: 3420 },
      { asset: usdc, total: '9201941668', free: '9201941668', reserved: '0', lastBlock: 14_744_674, valueUsd: 9204.47 },
      { asset: hollar, total: '36200000000000000000', free: '36200000000000000000', reserved: '0', lastBlock: 0, valueUsd: 36.2 },
    ],
    topAssets: [{ asset: usdc, valueUsd: 9204.47 }],
    portfolioUsd: 12_660.67,
    tradingVolumeUsd: 184_013.96,
    liquidationVolumeUsd: 0,
    revenueUsd: 408.09,
    moneyMarket: [
      {
        marketKey: 'core',
        market: 'Money Market',
        role: 'primary',
        defiSimSupported: true,
        stakingBacked: false,
        blockHeight: 14_744_614,
        timestamp: '2026-09-18 10:38:00',
        totalCollateralBase: '1446915244805',
        totalSuppliedBase: '1446915244805',
        totalDebtBase: '767017341775',
        availableBorrowsBase: '387042257481',
        liquidationThreshold: '8477',
        ltv: '7976',
        healthFactor: '1599116455675654336',
        reserves: [
          { assetId: 222, symbol: 'HOLLAR', decimals: 18, supplied: '0', debt: '7670000000000000000000', suppliedUsd: 0, debtUsd: 7660, collateral: false, marketKey: 'core' },
        ],
      },
      {
        marketKey: 'gigahdx',
        market: 'GIGAHDX',
        role: 'supplemental',
        defiSimSupported: false,
        stakingBacked: true,
        blockHeight: 14_745_005,
        timestamp: '2026-09-18 10:54:22',
        totalCollateralBase: '267457674817',
        totalSuppliedBase: '271408146551',
        totalDebtBase: '84871390052',
        availableBorrowsBase: '22111679875',
        liquidationThreshold: '7000',
        ltv: '4000',
        healthFactor: '2205930317122078754',
        reserves: [],
      },
    ],
    liquidityPositions: [
      { positionId: '73215', asset: hdx, amount: '900000000000000', shares: '900000000000000', valueUsd: 3930.91, venue: 'Omnipool Farm' },
    ],
    activeDcas: [
      {
        id: 36_331,
        assetIn: hdx,
        assetOut: hollar,
        direction: 'Sell',
        amountPerTrade: '500000000000000',
        totalAmount: '0',
        filledAmount: '93000000000000000',
        remainingAmount: null,
        executionsDone: 186,
        period: 1800,
        periodSeconds: 4074,
        nextExecutionBlock: 14_746_501,
        valueUsd: 3.86,
        budgetUsd: null,
        fundingBalance: null,
      },
    ],
    openLimitOrders: [],
    proxy: null,
    multisig: null,
    multisigMemberships: [],
    ...overrides,
  }
}

describe('get_account', () => {
  it('leads with the Value the Explorer page shows, not the gross holdings', async () => {
    // The page's headline is `portfolioUsd - Σ totalDebtBase/1e8` across every
    // market (PortfolioChart's netUsd in explorer-ui/src/pages/Account.tsx), and
    // the /history series ends on the same number. `portfolioUsd` alone is
    // GROSS: money-market collateral is an ordinary aToken balance and is
    // already inside it, so printing it as "Portfolio" contradicts both the page
    // the answer links to and this server's own history tool.
    const { upstream } = fakeUpstream({ [DETAIL_PATH]: addressDetail() })
    const out = await tool('get_account').handler({ address: ADDRESS }, ctxWith(upstream))
    const json = out.json as { valueUsd: number; holdingsUsd: number; moneyMarketDebtUsd: number }

    const debt = (767_017_341_775 + 84_871_390_052) / 1e8
    expect(json.holdingsUsd).toBeCloseTo(12_660.67, 6)
    expect(json.moneyMarketDebtUsd).toBeCloseTo(debt, 6)
    expect(json.valueUsd).toBeCloseTo(12_660.67 - debt, 6)

    expect(out.markdown).toContain('## Value')
    expect(out.markdown).toContain('holdings minus money-market debt')
    // Both halves are shown, so the arithmetic is checkable rather than a
    // second opinion — and neither is labelled with the other's name.
    expect(out.markdown).toContain('Holdings (gross: balances + LP positions + claimable farm rewards and lending incentives)')
    expect(out.markdown).toContain('Money-market debt (netted out above)')
    expect(out.markdown).not.toMatch(/\*\*Portfolio:\*\*/)
  })

  // The upstream portfolioUsd already counts the claimable farm rewards; the tool
  // says how much of Holdings they are (and on the farmed row), never adds them.
  it('states the farm rewards inside Holdings and beside the farmed position', async () => {
    const reward = { depositId: '9', globalFarmId: 133, yieldFarmId: 139, asset: hdx, amount: '2000000000000000', valueUsd: 8.7, projected: true, belowExistentialDeposit: false }
    const detail = addressDetail({
      liquidityPositions: [{ positionId: '73215', asset: hdx, amount: '900000000000000', shares: '900000000000000', valueUsd: 3930.91, venue: 'Omnipool Farm', unclaimedRewards: [reward] }],
      farmRewards: {
        asOfBlock: 14_745_000, totalUsd: 8.7,
        items: [
          { depositId: '9', positionId: '73215', globalFarmId: 133, yieldFarmId: 139, venue: 'Omnipool Farm', farmState: 'active', asset: hdx, claimable: '2000000000000000', claimableUsd: 8.7, forfeitIfWithdrawnNow: '0', projected: true, belowExistentialDeposit: false, loyaltyPct: 50, lastSyncPeriod: 1 },
          { depositId: '9', positionId: '73215', globalFarmId: 134, yieldFarmId: 140, venue: 'Omnipool Farm', farmState: 'active', asset: hdx, claimable: '5', claimableUsd: null, forfeitIfWithdrawnNow: '0', projected: true, belowExistentialDeposit: true, loyaltyPct: 50, lastSyncPeriod: 1 },
          { depositId: '9', positionId: '73215', globalFarmId: 135, yieldFarmId: 141, venue: 'Omnipool Farm', farmState: 'active', asset: hdx, claimable: '7', claimableUsd: 0, forfeitIfWithdrawnNow: '0', projected: true, belowExistentialDeposit: true, payable: false, loyaltyPct: 50, lastSyncPeriod: 1 },
        ],
      },
    })
    const { upstream } = fakeUpstream({ [DETAIL_PATH]: detail })
    const out = await tool('get_account').handler({ address: ADDRESS }, ctxWith(upstream))
    const json = out.json as { holdingsUsd: number; farmRewardsUsd: number | null; farmRewardsAsOfBlock: number | null; liquidityPositions: { unclaimedRewards?: unknown[]; valueUsd: number }[] }
    expect(out.markdown).toContain('Unclaimed farm rewards (inside holdings)')
    expect(out.markdown).toContain('as of block 14,745,000')
    expect(out.markdown).toContain('plus 1 entry the index cannot price (not counted)')
    expect(out.markdown).toContain('| Unclaimed rewards |')
    expect(out.markdown).toContain("counted in the account's Holdings and Value above")
    // Holdings is the upstream figure as it stands — no reward added a second time.
    expect(json.holdingsUsd).toBeCloseTo(12_660.67, 6)
    expect(json.farmRewardsUsd).toBe(8.7)
    expect(json.farmRewardsAsOfBlock).toBe(14_745_000)
    // The unpriced entry is counted aloud; the unpayable one is named, not counted.
    expect((json as unknown as { farmRewardsUnpriced: number }).farmRewardsUnpriced).toBe(1)
    expect(out.markdown).toContain('1 entry is below the reward asset\'s existential deposit while the account holds less than it')
    expect(json.liquidityPositions[0].valueUsd).toBe(3930.91)
    expect(json.liquidityPositions[0].unclaimedRewards).toHaveLength(1)
  })

  // The upstream portfolioUsd already counts the claimable lending incentives too;
  // the tool states them inside Holdings and under their market, never adds them.
  it('states the money-market incentives inside Holdings and under their market', async () => {
    const gdot = { assetId: 69, iconAssetId: 69, symbol: 'GDOT', name: null, decimals: 18, parachainId: null, origin: null }
    const item = { marketKey: 'core', holder: '0x4a9ab52a6f688ede97c23d946f7e8ef4f1e47a47', asset: gdot, claimable: '2100000000000000000', claimableUsd: 12.5, reconciled: true, belowExistentialDeposit: true, legs: [] }
    const base = addressDetail() as { moneyMarket: Array<Record<string, unknown>> }
    const detail = addressDetail({
      moneyMarketRewards: { asOfBlock: 15_000_000, totalUsd: 12.5, items: [item] },
      moneyMarket: base.moneyMarket.map(m => (m.marketKey === 'core' ? { ...m, unclaimedRewards: [item] } : m)),
    })
    const { upstream } = fakeUpstream({ [DETAIL_PATH]: detail })
    const out = await tool('get_account').handler({ address: ADDRESS }, ctxWith(upstream))
    const json = out.json as { holdingsUsd: number; moneyMarketRewardsUsd: number | null; moneyMarketRewardsAsOfBlock: number | null }
    expect(out.markdown).toContain('Unclaimed lending incentives (inside holdings)')
    expect(out.markdown).toContain("the chain's own RewardsController.getAllUserRewards")
    expect(out.markdown).toContain('below the reward asset\'s existential deposit')
    expect(out.markdown).toContain("Unclaimed incentives (in the account value, not in this market's collateral)")
    expect(out.markdown).toContain('2.1 GDOT ($12.5')
    expect(json.holdingsUsd).toBeCloseTo(12_660.67, 6)
    expect(json.moneyMarketRewardsUsd).toBe(12.5)
    expect(json.moneyMarketRewardsAsOfBlock).toBe(15_000_000)
    expect((json as unknown as { moneyMarketRewardsUnpriced: number }).moneyMarketRewardsUnpriced).toBe(0)
  })

  it('shows no reward line or column for an account without farm rewards', async () => {
    const { upstream } = fakeUpstream({ [DETAIL_PATH]: addressDetail() })
    const out = await tool('get_account').handler({ address: ADDRESS }, ctxWith(upstream))
    expect(out.markdown).not.toContain('Unclaimed farm rewards (inside holdings)')
    expect(out.markdown).not.toContain('| Unclaimed rewards |')
    expect((out.json as { farmRewardsUsd: number | null }).farmRewardsUsd).toBeNull()
  })

  it('does not invent a debt subtraction for an account that owes nothing', async () => {
    const detail = addressDetail({ moneyMarket: [] })
    const { upstream } = fakeUpstream({ [DETAIL_PATH]: detail })
    const out = await tool('get_account').handler({ address: ADDRESS }, ctxWith(upstream))
    const json = out.json as { valueUsd: number; holdingsUsd: number; moneyMarketDebtUsd: number }
    expect(json.moneyMarketDebtUsd).toBe(0)
    expect(json.valueUsd).toBe(json.holdingsUsd)
    // With nothing netted out the explanation would be noise.
    expect(out.markdown).not.toContain('Money-market debt (netted out above)')
  })

  it('converts a DCA block period at the runtime slot time, never at a literal', async () => {
    // A schedule's `period` is a BLOCK COUNT defined at the nominal slot time;
    // a hardcoded 2 is correct only until the cadence changes.
    const detail = addressDetail()
    ;(detail.activeDcas as Record<string, unknown>[])[0].periodSeconds = null
    const routes = { [DETAIL_PATH]: detail, '/explorer/stats': { headBlock: 1, finalizedBlock: 1, headTime: '2026-09-18 10:00:00', avgBlockSec: 2.3, nominalBlockSec: 6, transfers24h: 0, extrinsics24h: 0, activeAccounts24h: 0, hdxPrice: 0.0077 } }
    const { upstream } = fakeUpstream(routes)
    const out = await tool('get_account').handler({ address: ADDRESS }, ctxWith(upstream))
    // 1,800 blocks at the runtime's 6s slot is 3h, not the 1h a literal 2 gives.
    // Matched as its own table cell: a bare '3h' is also what relativeAge emits
    // for a fixture timestamped a few hours before the wall clock, so the loose
    // form passed with the conversion hardcoded to 2 seconds.
    expect(out.markdown).toMatch(/\|\s*3h\s*\|/)
    expect(out.markdown).not.toMatch(/\|\s*1h\s*\|/)
    expect(out.markdown).toContain("nominal 6s slot time")
    const json = out.json as { activeDcas: { periodSeconds: number | null; periodBlocks: number }[] }
    expect(json.activeDcas[0].periodSeconds).toBe(1800 * 6)
    expect(json.activeDcas[0].periodBlocks).toBe(1800)
  })

  it('shows the block count rather than a wrong duration when the slot time cannot be read', async () => {
    const detail = addressDetail()
    ;(detail.activeDcas as Record<string, unknown>[])[0].periodSeconds = null
    const { upstream } = fakeUpstream({ [DETAIL_PATH]: detail })
    const out = await tool('get_account').handler({ address: ADDRESS }, ctxWith(upstream))
    expect(out.markdown).toContain('1,800 blocks')
  })

  it('labels a derived address form as derived, never as an observed binding', async () => {
    // `relatedAccountIds` always carries the runtime-truncated `0x45544800…`
    // form of the account's own key. With no alias row behind it, nothing has
    // been observed binding the two, and the scope sentence must not borrow the
    // authority of the relationships that ARE observed.
    const { upstream } = fakeUpstream({ [DETAIL_PATH]: addressDetail() })
    const out = await tool('get_account').handler({ address: ADDRESS }, ctxWith(upstream))
    expect(out.markdown).toContain('no binding has been observed on chain')
    expect(out.markdown).toContain('alternative ADDRESS FORMS')
    expect(out.markdown).not.toContain('the explorer folds them because they are the same wallet')

    // An observed binding still reads as one, with its confidence.
    const bound = addressDetail({
      aliases: [{ accountId: EVM_ID, evmAddress: '0x4e2a16e182e406a9885b2bb2a20136cc7152bc6d', relationship: 'explicit_binding', confidence: 1 }],
    })
    const withAlias = fakeUpstream({ [DETAIL_PATH]: bound })
    const out2 = await tool('get_account').handler({ address: ADDRESS }, ctxWith(withAlias.upstream))
    expect(out2.markdown).toContain('explicit_binding (confidence 1)')
    expect(out2.markdown).toContain('the relationship and confidence the explorer observed')
  })

  it('renders each isolated market separately, with its own 1e18 health factor and basis-point limits', async () => {
    const { upstream } = fakeUpstream({ [DETAIL_PATH]: addressDetail() })
    const out = await tool('get_account').handler({ address: ADDRESS }, ctxWith(upstream))

    // 1599116455675654336 / 1e18 = 1.5991…; 2205930317122078754 / 1e18 = 2.2059…
    // Each figure is asserted ON ITS OWN MARKET. Checked as four loose
    // substrings the same test passes with the two health factors swapped,
    // which is precisely the blending this invariant forbids.
    expect(out.markdown).toContain('Money Market (core, primary market) — health factor 1.5991')
    expect(out.markdown).toContain('GIGAHDX (gigahdx, supplemental market) — health factor 2.2059')
    // Basis points, not percent and not a fraction: 8477 is 84.77%.
    expect(out.markdown).toContain('84.77%')
    expect(out.markdown).toContain('79.76%')
    expect(out.markdown).toContain('40.00%')
    // The markets are named and never merged into one figure.
    expect(out.markdown).toContain('Money Market (core, primary market)')
    expect(out.markdown).toContain('GIGAHDX (gigahdx, supplemental market)')
    expect(out.markdown).toMatch(/ISOLATED/)
    const blended = (1.599116455675654336 + 2.205930317122078754) / 2
    expect(out.markdown).not.toContain(blended.toFixed(4))
  })

  it("says '∞ (no debt)' rather than a number when there is no debt", async () => {
    const detail = addressDetail()
    ;(detail.moneyMarket as Record<string, unknown>[])[1].healthFactor = 'inf'
    const { upstream } = fakeUpstream({ [DETAIL_PATH]: detail })
    const out = await tool('get_account').handler({ address: ADDRESS }, ctxWith(upstream))
    expect(out.markdown).toContain('∞ (no debt)')
  })

  it('scales every balance by its own asset decimals and prints no raw integer', async () => {
    const { upstream } = fakeUpstream({ [DETAIL_PATH]: addressDetail() })
    const out = await tool('get_account').handler({ address: ADDRESS }, ctxWith(upstream))
    expect(out.markdown).toContain('444k')   // 4.44e17 raw at 12 decimals
    expect(out.markdown).toContain('9.2k')   // 9201941668 at 6 decimals
    // As its own cell: a bare '36.2' also matches the USD column, which is not
    // scaled by the asset's decimals and so cannot catch a decimals regression.
    expect(out.markdown).toMatch(/\|\s*36\.2\s*\|/)   // 3.62e19 at 18 decimals
    expect(out.markdown).not.toContain('9201941668')
    expect(out.markdown).not.toContain('444000000000000000')
  })

  it('prints block heights in full rather than on the money scale', async () => {
    const { upstream } = fakeUpstream({ [DETAIL_PATH]: addressDetail() })
    const out = await tool('get_account').handler({ address: ADDRESS }, ctxWith(upstream))
    expect(out.markdown).toContain('14,744,614')
    expect(out.markdown).not.toContain('block 14.7M')
  })

  it('names the related set and says every figure is scoped to it', async () => {
    const { upstream } = fakeUpstream({ [DETAIL_PATH]: addressDetail() })
    const out = await tool('get_account').handler({ address: ADDRESS }, ctxWith(upstream))
    expect(out.markdown).toMatch(/RELATED SET of 2 addresses/)
    // The truncated `0x45544800…` id is shown as the EVM address it encodes,
    // never as a bare public key.
    expect(out.markdown).toContain('0x4e2a16e182e406a9885b2bb2a20136cc7152bc6d (EVM)')
    expect(out.markdown).not.toContain(EVM_ID)
  })

  it('takes the cheap summary build only when no section needs the full one', async () => {
    const lean = fakeUpstream({ [DETAIL_PATH]: addressDetail() })
    await tool('get_account').handler({ address: ADDRESS, include: ['moneymarket'] }, ctxWith(lean.upstream))
    expect(lean.calls[0].query).toEqual({ summary: 1 })

    const full = fakeUpstream({ [DETAIL_PATH]: addressDetail() })
    await tool('get_account').handler({ address: ADDRESS }, ctxWith(full.upstream))
    expect(full.calls[0].query).toBeUndefined()

    // A lock snapshot lives only in the full build, so asking for balances must
    // not take the summary.
    const balances = fakeUpstream({ [DETAIL_PATH]: addressDetail() })
    await tool('get_account').handler({ address: ADDRESS, include: ['balances'] }, ctxWith(balances.upstream))
    expect(balances.calls[0].query).toBeUndefined()
  })

  it('says so when the summary build could not carry the locks and the live reads', async () => {
    const { upstream } = fakeUpstream({ [DETAIL_PATH]: addressDetail() })
    const out = await tool('get_account').handler({ address: ADDRESS, include: ['moneymarket'] }, ctxWith(upstream))
    expect(out.markdown).not.toContain('## Balances')
    expect(out.markdown).toContain('## Money market')
  })

  it('reads counts and revenue only when asked, and each from its own route', async () => {
    const routes = {
      [DETAIL_PATH]: addressDetail(),
      [`${DETAIL_PATH}/counts`]: { extrinsics: 994_520, extrinsicsOnBehalf: 0, events: 10_307_656, votes: 0 },
      [`${DETAIL_PATH}/revenue-breakdown`]: { totalUsd: 408.09, streams: [{ stream: 'omnipool_asset_fee', usd: 408.09, assets: [{ asset: hdx, usd: 408.09 }] }] },
    }
    const bare = fakeUpstream(routes)
    await tool('get_account').handler({ address: ADDRESS }, ctxWith(bare.upstream))
    // The default build reads the account and the chain stats — the latter only
    // to convert a DCA schedule's BLOCK period at the runtime's nominal slot
    // time instead of at a hardcoded one. Neither counts nor revenue is read.
    expect(bare.calls.map(c => c.path).sort()).toEqual([DETAIL_PATH, '/explorer/stats'].sort())

    const asked = fakeUpstream(routes)
    const out = await tool('get_account').handler({ address: ADDRESS, include: ['counts', 'revenue'] }, ctxWith(asked.upstream))
    // No `dca` section, so no stats read either.
    expect(asked.calls.map(c => c.path).sort()).toEqual([DETAIL_PATH, `${DETAIL_PATH}/counts`, `${DETAIL_PATH}/revenue-breakdown`].sort())
    // Counts are exact, not on the money scale: 994,520 is comparable, "995k" is not.
    expect(out.markdown).toContain('994,520')
    expect(out.markdown).toContain('omnipool_asset_fee')
  })

  it('returns the rest of the answer plus an error when one enrichment fails', async () => {
    const { upstream } = fakeUpstream({
      [DETAIL_PATH]: addressDetail(),
      [`${DETAIL_PATH}/counts`]: new UpstreamError('upstream responded 500', 500, null, `${DETAIL_PATH}/counts`),
      [`${DETAIL_PATH}/revenue-breakdown`]: { totalUsd: 0, streams: [] },
    })
    const out = await tool('get_account').handler({ address: ADDRESS, include: ['counts', 'revenue'] }, ctxWith(upstream))
    expect(out.markdown).toContain('## Value')
    expect(out.errors).toHaveLength(1)
    expect(out.errors?.[0].code).toBe('UPSTREAM_UNAVAILABLE')
    // A section that failed is missing, not empty, and the difference is stated.
    expect(out.markdown).toMatch(/MISSING because their read failed/)
    expect(out.markdown).toContain('counts')
  })

  it('answers an unrecognized address with NOT_FOUND naming the accepted forms', async () => {
    const { upstream } = fakeUpstream({})
    const out = await tool('get_account').handler({ address: 'not-an-address' }, ctxWith(upstream))
    expect(out.markdown).toBe('')
    expect(out.errors?.[0].code).toBe('NOT_FOUND')
    expect(out.errors?.[0].message).toMatch(/SS58/)
    expect(out.errors?.[0].message).toMatch(/AccountId32/)
    expect(out.errors?.[0].message).toMatch(/0x \+ 40 hex/)
  })

  it('rejects an include section it does not implement', async () => {
    const { upstream, calls } = fakeUpstream({ [DETAIL_PATH]: addressDetail() })
    const out = await tool('get_account').handler({ address: ADDRESS, include: ['everything'] }, ctxWith(upstream))
    expect(out.errors?.[0].code).toBe('INVALID_ARGUMENT')
    expect(calls).toHaveLength(0)
  })

  it('answers format:"json" with a record that parses and carries scaled figures', async () => {
    const { upstream } = fakeUpstream({ [DETAIL_PATH]: addressDetail() })
    const out = await tool('get_account').handler({ address: ADDRESS, format: 'json' }, ctxWith(upstream))
    const parsed = JSON.parse(JSON.stringify(out.json, null, 2))
    expect(parsed.address.ss58Polkadot).toBe(ADDRESS)
    expect(parsed.scopedToRelatedAccountIds).toHaveLength(2)
    expect(parsed.balances[0].total).toBeCloseTo(9201.941668, 6)
    // Both isolated markets survive, each with its own ratio and neither merged.
    expect(parsed.moneyMarketByIsolatedMarket).toHaveLength(2)
    expect(parsed.moneyMarketByIsolatedMarket[0].healthFactorRatio).toBeCloseTo(1.5991, 3)
    expect(parsed.moneyMarketByIsolatedMarket[1].marketKey).toBe('gigahdx')
    expect(parsed.moneyMarketByIsolatedMarket[0].ltvPct).toBe(79.76)
    expect(parsed.moneyMarketByIsolatedMarket[0].debtUsd).toBeCloseTo(7670.17, 2)
  })

  it('keeps a large answer inside the text budget and says what it cut', async () => {
    const detail = addressDetail()
    const { upstream } = fakeUpstream({ [DETAIL_PATH]: detail })
    const out = await tool('get_account').handler({ address: ADDRESS }, ctxWith(upstream, 900))
    expect(out.markdown.length).toBeLessThanOrEqual(900)
    expect(out.markdown).toContain('Truncated')
  })
})

/* ============ get_account_history ============ */

const HISTORY_PATH = `/explorer/address/${ADDRESS}/history`
const VALUE_EVENTS_PATH = `/explorer/address/${ADDRESS}/value-events`

// 40 buckets with a spike in the middle that no 12-point sample can land on, so
// the min/max assertions below really test the aggregate rather than the sample.
const series = Array.from({ length: 40 }, (_, i) => 1000 + i * 10)
series[17] = 9999
series[23] = 12
const dates = Array.from({ length: 40 }, (_, i) => `2026-0${1 + Math.floor(i / 20)}-${String((i % 20) + 1).padStart(2, '0')} 00:00:00`)
const blocks = Array.from({ length: 40 }, (_, i) => 14_000_000 + i * 1000)

const history = { portfolioSeries: series, portfolioSeriesExHdx: [], portfolioDates: dates, portfolioBlocks: blocks, balanceHistory: [] }

const valueEvents = [
  { blockHeight: 14_001_000, eventIndex: 2, extrinsicIndex: null, timestamp: '2026-01-02 10:00:00', kind: 'transfer-in', valueUsd: 3000.34, asset: usdc, counterparty: null, direction: 'in' },
  { blockHeight: 14_030_000, eventIndex: 4, extrinsicIndex: null, timestamp: '2026-01-20 10:00:00', kind: 'price', valueUsd: -2111.55, asset: null, counterparty: null },
  { blockHeight: 14_900_000, eventIndex: 7, extrinsicIndex: null, timestamp: '2026-03-01 10:00:00', kind: 'swap', valueUsd: 50, asset: hdx, counterparty: null },
]

describe('get_account_history', () => {
  it('names the series as the same Value measure get_account reports', async () => {
    // The two tools must not answer "what is this account worth" with different
    // numbers: the series ends on holdings net of money-market debt, which is
    // exactly get_account's Value and the Explorer page's headline.
    const { upstream } = fakeUpstream({ [HISTORY_PATH]: history, [VALUE_EVENTS_PATH]: [] })
    const out = await tool('get_account_history').handler({ address: ADDRESS }, ctxWith(upstream))
    expect(out.markdown).toContain('## Value history')
    expect(out.markdown).toContain('holdings minus money-market debt')
    expect(out.markdown).not.toContain('## Portfolio history')
    const json = out.json as { measure: string; series: { sampled: { valueUsd: number }[] } }
    expect(json.measure).toContain('valueUsd')
    expect(json.series.sampled[0]).toHaveProperty('valueUsd')
  })

  it('suppresses a percentage whose baseline cannot support one', async () => {
    // "+5358293.20%" against a $0.01 opening bucket says only that the account
    // started near zero. The Explorer's own chart suppresses these windows.
    const dust = { ...history, portfolioSeries: [0.01, ...series.slice(1)] }
    const { upstream } = fakeUpstream({ [HISTORY_PATH]: dust, [VALUE_EVENTS_PATH]: [] })
    const out = await tool('get_account_history').handler({ address: ADDRESS }, ctxWith(upstream))
    expect(out.markdown).toMatch(/\*\*Change:\*\* \+\$/)
    expect(out.markdown).not.toMatch(/\+\d{4,}\.\d\d%/)
    expect(out.markdown).toContain('no percentage')
    const json = out.json as { series: { changeFraction: number | null } }
    expect(json.series.changeFraction).toBeNull()

    // A window with a real baseline still carries its percentage.
    const sane = { ...history, portfolioSeries: [1000, ...series.slice(1)] }
    const ok = fakeUpstream({ [HISTORY_PATH]: sane, [VALUE_EVENTS_PATH]: [] })
    const out2 = await tool('get_account_history').handler({ address: ADDRESS }, ctxWith(ok.upstream))
    expect(out2.markdown).toMatch(/\([+-]\d+\.\d\d%\)/)
  })

  it('tells two same-symbol legs of a DCA value event apart', async () => {
    // Four registry assets call themselves USDC; `USDC → USDC` reads as a no-op.
    const other = { assetId: 1_000_766, symbol: 'USDC', name: 'USDC (Ethereum native)', decimals: 6 }
    const events = [{ blockHeight: 14_001_000, eventIndex: 2, extrinsicIndex: null, timestamp: '2026-01-02 10:00:00', kind: 'dca', valueUsd: 500, asset: null, assetIn: usdc, assetOut: other, dcaTrades: 3, counterparty: null }]
    const { upstream } = fakeUpstream({ [HISTORY_PATH]: history, [VALUE_EVENTS_PATH]: events })
    const out = await tool('get_account_history').handler({ address: ADDRESS }, ctxWith(upstream))
    expect(out.markdown).toContain('USDC (#22) → USDC (#1000766) ×3')
    expect(out.markdown).not.toContain('USDC → USDC')
  })

  it('summarises the series instead of printing it, and states the sampling', async () => {
    const { upstream } = fakeUpstream({ [HISTORY_PATH]: history, [VALUE_EVENTS_PATH]: valueEvents })
    const out = await tool('get_account_history').handler({ address: ADDRESS }, ctxWith(upstream))

    // Aggregates come from the WHOLE series, including the points no sample hit.
    expect(out.markdown).toContain('$10k')   // the 9999 spike, on the rough scale
    expect(out.markdown).toContain('$12')    // the trough
    expect(out.markdown).toMatch(/Sampled path \(\d+ of 40 points, every \d+\w+ bucket\)/)
    expect(out.markdown).toContain('This is a SAMPLE')

    const pathSection = out.markdown.slice(out.markdown.indexOf('## Sampled path')).split('\n## ')[0]
    const pathRows = pathSection.split('\n').filter(l => /^\| 2026-/.test(l))
    expect(pathRows.length).toBeLessThanOrEqual(13)
    expect(pathRows.length).toBeGreaterThan(3)
    // Neither the series nor anything near it: 40 points in, at most 13 out.
    expect(pathRows.length).toBeLessThan(series.length / 2)
  })

  it('takes the cheap series-only build for the portfolio kind and the full one for balances', async () => {
    const portfolio = fakeUpstream({ [HISTORY_PATH]: history, [VALUE_EVENTS_PATH]: [] })
    await tool('get_account_history').handler({ address: ADDRESS }, ctxWith(portfolio.upstream))
    expect(portfolio.calls[0].query).toEqual({ series: 1 })

    const balances = fakeUpstream({
      [HISTORY_PATH]: { ...history, balanceHistory: [{ asset: hdx, current: 444_000, points: [{ ts: dates[0], blockHeight: blocks[0], balance: 10_200 }, { ts: dates[39], blockHeight: blocks[39], balance: 444_000 }] }] },
    })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'balances' }, ctxWith(balances.upstream))
    expect(balances.calls[0].query).toEqual({})
    expect(out.markdown).toContain('## Per-asset balances')
    expect(out.markdown).toContain('TOKEN units')
  })

  it('windows in block space, and refuses half a window', async () => {
    const { upstream, calls } = fakeUpstream({ [HISTORY_PATH]: history, [VALUE_EVENTS_PATH]: valueEvents })
    const half = await tool('get_account_history').handler({ address: ADDRESS, fromBlock: 14_000_000 }, ctxWith(upstream))
    expect(half.errors?.[0].code).toBe('INVALID_ARGUMENT')
    expect(calls).toHaveLength(0)

    const backwards = await tool('get_account_history').handler({ address: ADDRESS, fromBlock: 14_100_000, toBlock: 14_000_000 }, ctxWith(upstream))
    expect(backwards.errors?.[0].code).toBe('INVALID_ARGUMENT')

    const out = await tool('get_account_history').handler({ address: ADDRESS, fromBlock: 14_000_000, toBlock: 14_100_000 }, ctxWith(upstream))
    expect(calls[0].query).toMatchObject({ fromBlock: 14_000_000, toBlock: 14_100_000, series: 1 })
    // The value-event route takes no block window, so it is applied here: the
    // 14,900,000 row is outside and must not be counted.
    expect(out.markdown).toContain('transfer-in')
    expect(out.markdown).not.toContain('14,900,000')
  })

  it('distinguishes "nothing in this window" from "nothing ever"', async () => {
    const { upstream } = fakeUpstream({ [HISTORY_PATH]: history, [VALUE_EVENTS_PATH]: valueEvents })
    const out = await tool('get_account_history').handler(
      { address: ADDRESS, kind: 'value-events', fromBlock: 14_500_000, toBlock: 14_600_000 },
      ctxWith(upstream),
    )
    expect(out.markdown).toMatch(/3 exist outside it/)
  })

  it('never renders a failed value-event read as "no events"', async () => {
    const { upstream } = fakeUpstream({
      [HISTORY_PATH]: history,
      [VALUE_EVENTS_PATH]: new UpstreamError('upstream responded 500', 500, null, VALUE_EVENTS_PATH),
    })
    const out = await tool('get_account_history').handler({ address: ADDRESS }, ctxWith(upstream))
    expect(out.markdown).toContain('## Value line')
    expect(out.markdown).toMatch(/could not be read/)
    expect(out.markdown).not.toMatch(/no event has moved/)
    expect(out.errors?.[0].code).toBe('UPSTREAM_UNAVAILABLE')
  })

  it('names the read that failed when the kind\'s own route is the one that broke', async () => {
    const { upstream } = fakeUpstream({
      [HISTORY_PATH]: history,
      [VALUE_EVENTS_PATH]: new UpstreamError('upstream responded 500', 500, null, VALUE_EVENTS_PATH),
    })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'value-events' }, ctxWith(upstream))
    expect(out.markdown).toBe('')
    expect(out.errors?.[0].message).toMatch(/The value events for/)
  })

  it('orders value events by absolute USD and marks a price marker as not a transfer', async () => {
    const { upstream } = fakeUpstream({ [HISTORY_PATH]: history, [VALUE_EVENTS_PATH]: valueEvents })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'value-events' }, ctxWith(upstream))
    const first = out.markdown.indexOf('transfer-in')
    const second = out.markdown.indexOf('price')
    const third = out.markdown.indexOf('swap')
    expect(first).toBeLessThan(second)
    expect(second).toBeLessThan(third)
    expect(out.markdown).toContain("A 'price' row is not a transfer")
  })

  it('answers format:"json" with a sampled series that parses', async () => {
    const { upstream } = fakeUpstream({ [HISTORY_PATH]: history, [VALUE_EVENTS_PATH]: valueEvents })
    const out = await tool('get_account_history').handler({ address: ADDRESS, format: 'json' }, ctxWith(upstream))
    const parsed = JSON.parse(JSON.stringify(out.json, null, 2))
    expect(parsed.series.points).toBe(40)
    expect(parsed.series.max.value).toBe(9999)
    expect(parsed.series.min.value).toBe(12)
    expect(parsed.series.sampled.length).toBeLessThanOrEqual(13)
    expect(parsed.series.sampleStride).toBeGreaterThan(1)
  })
})

/* ---- kind 'liquidity' ---- */

const LP_HISTORY_PATH = `/explorer/address/${ADDRESS}/liquidity-history`
const dot = { assetId: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10 }
const h2o = { assetId: 1, symbol: 'H2O', name: null, decimals: 12 }
const pool2 = { assetId: 102, symbol: '2-Pool', name: null, decimals: 18 }
const lpDates = ['2026-09-20 00:00:00', '2026-09-21 00:00:00', '2026-09-22 00:00:00', '2026-09-23 00:00:00']
const lpBlocks = [14_000_000, 14_014_400, 14_028_800, 14_043_200]

function lpHistoryFixture(extraPositions = 0) {
  const omnipool = {
    venue: 'omnipool', farmed: true, positionId: '5690', poolKey: 'omnipool', shareAsset: null,
    spans: [
      { fromBlock: 13_990_000, fromTime: '2026-09-19 10:00:00', toBlock: 14_010_000, toTime: '2026-09-20 18:00:00', kind: 'direct' },
      { fromBlock: 14_010_000, fromTime: '2026-09-20 18:00:00', toBlock: null, toTime: null, kind: 'farmed' },
    ],
    points: [
      { i: 0, shares: '1000', valueUsd: 900, legs: [{ asset: dot, amount: '2000000000000', valueUsd: 900 }] },
      { i: 1, shares: '1000', valueUsd: 700, legs: [{ asset: dot, amount: '1500000000000', valueUsd: 650 }, { asset: h2o, amount: '50000000000000', valueUsd: 50 }] },
      { i: 3, shares: '1000', valueUsd: 1_234, legs: [{ asset: dot, amount: '2500000000000', valueUsd: 1_134 }, { asset: h2o, amount: '100000000000000', valueUsd: 100 }] },
    ],
  }
  const stable = {
    venue: 'stableswap', farmed: false, positionId: null, poolKey: '102', shareAsset: pool2, spans: [],
    points: [
      { i: 0, shares: '5', valueUsd: 50, legs: [{ asset: usdc, amount: '50000000', valueUsd: 50 }] },
      { i: 1, shares: '5', valueUsd: null, legs: [{ asset: usdc, amount: '50000000', valueUsd: null }] },
    ],
  }
  const tail = Array.from({ length: extraPositions }, (_, k) => ({
    venue: 'omnipool', farmed: false, positionId: String(9000 + k), poolKey: 'omnipool', shareAsset: null, spans: [],
    points: [{ i: 3, shares: '1', valueUsd: 1 + k, legs: [{ asset: dot, amount: '10000000000', valueUsd: 1 + k }] }],
  }))
  return {
    stepSec: 86_400, priceGrain: '1d', dates: lpDates, blocks: lpBlocks,
    valueUsd: [950, 700, 800, 1_234 + tail.reduce((s, p) => s + p.points[0].valueUsd, 0)],
    unpriced: [0, 1, 0, 0],
    positions: [stable, ...tail, omnipool],
    positionsOmitted: 7,
  }
}

describe("get_account_history kind 'liquidity'", () => {
  it('reads the explorer LP-history route with the block window and nothing else', async () => {
    const { upstream, calls } = fakeUpstream({ [LP_HISTORY_PATH]: lpHistoryFixture() })
    await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity' }, ctxWith(upstream))
    expect(calls).toEqual([{ path: LP_HISTORY_PATH, query: undefined }])

    const windowed = fakeUpstream({ [LP_HISTORY_PATH]: lpHistoryFixture() })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity', fromBlock: 14_000_000, toBlock: 14_050_000 }, ctxWith(windowed.upstream))
    expect(windowed.calls).toEqual([{ path: LP_HISTORY_PATH, query: { fromBlock: 14_000_000, toBlock: 14_050_000 } }])
    expect(out.markdown).toContain('WINDOWED')
  })

  it('renders the LP value line and a position row with its H2O leg', async () => {
    const { upstream } = fakeUpstream({ [LP_HISTORY_PATH]: lpHistoryFixture() })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity' }, ctxWith(upstream))
    expect(out.markdown).toContain('## LP history')
    expect(out.markdown).toContain('## LP value line')
    expect(out.markdown).toContain('4 buckets of 1d')
    expect(out.markdown).toContain('not a return')
    const row = out.markdown.split('\n').find(l => l.includes('DOT #5690'))
    expect(row).toBeDefined()
    expect(row).toContain('Omnipool (farmed)')
    // Spans exist: the exact open time, to the minute, not the first bucket end.
    expect(row).toContain('2026-09-19 10:00 → still held')
    expect(row).toContain('250 DOT + 100 H2O')
    // The largest last-held value leads; the unpriced last point is a dash, not $0.
    expect(out.markdown.indexOf('DOT #5690')).toBeLessThan(out.markdown.indexOf('2-Pool (#102)'))
    const stableRow = out.markdown.split('\n').find(l => l.includes('2-Pool (#102)'))!
    expect(stableRow).not.toContain('$0')
    // Span-less venue: the first and last bucket end it was held at, marked `~`.
    expect(stableRow).toContain('~2026-09-20 → ~2026-09-21')
    expect(out.markdown).toContain('A `~date` is a point date')
  })

  it('never reports a low that exists only because a position dropped out unpriced', async () => {
    // Bucket 1 totals $700 only because the stableswap position is unpriced there.
    const { upstream } = fakeUpstream({ [LP_HISTORY_PATH]: lpHistoryFixture() })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity' }, ctxWith(upstream))
    expect(out.markdown).toMatch(/\*\*Low \(fully priced buckets only\):\*\* \$800/)
    expect(out.markdown).not.toMatch(/\*\*Low[^*]*:\*\* \$700/)
    expect(out.markdown).toContain('the 1 with an unpriced position are left out')

    // An unpriced ENDPOINT is named, and no percentage is taken against it.
    const partial = { ...lpHistoryFixture(), unpriced: [0, 1, 0, 2] }
    const p2 = fakeUpstream({ [LP_HISTORY_PATH]: partial })
    const out2 = await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity' }, ctxWith(p2.upstream))
    expect(out2.markdown).toMatch(/\*\*Last:\*\* [^\n]*2 held position\(s\) unpriced there and left out/)
    expect(out2.markdown).toContain('no percentage: an endpoint leaves unpriced positions out')
    const json = (await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity', format: 'json' }, ctxWith(p2.upstream))).json as { series: { changeFraction: number | null; unpricedAtLast: number } }
    expect(json.series.changeFraction).toBeNull()
    expect(json.series.unpricedAtLast).toBe(2)
  })

  it('adds a sampled path of the LP value line, in markdown and JSON', async () => {
    const n = 40
    const long = {
      ...lpHistoryFixture(),
      dates: Array.from({ length: n }, (_, i) => `2026-0${1 + Math.floor(i / 20)}-${String((i % 20) + 1).padStart(2, '0')} 00:00:00`),
      blocks: Array.from({ length: n }, (_, i) => 14_000_000 + i * 1000),
      valueUsd: Array.from({ length: n }, (_, i) => 100 + i),
      unpriced: Array.from({ length: n }, () => 0),
      positions: [],
      positionsOmitted: 0,
    }
    const { upstream } = fakeUpstream({ [LP_HISTORY_PATH]: long })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity' }, ctxWith(upstream))
    expect(out.markdown).toMatch(/## Sampled path \(\d+ of 40 points, every \d+\w+ point\)/)
    const json = (await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity', format: 'json' }, ctxWith(upstream))).json as { series: { sampled: unknown[]; sampleStride: number } }
    expect(json.series.sampled.length).toBeLessThanOrEqual(13)
    expect(json.series.sampleStride).toBeGreaterThan(1)
  })

  it('names the collapsed daily grid of an un-windowed sub-day step, and a window\'s end as the window\'s', async () => {
    const hourly = { ...lpHistoryFixture(), stepSec: 10_800 }
    const { upstream } = fakeUpstream({ [LP_HISTORY_PATH]: hourly })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity' }, ctxWith(upstream))
    expect(out.markdown).toContain('4 daily points (the last 3h bucket of each day)')
    expect(out.markdown).not.toContain('buckets of 3h')
    expect(out.markdown).toContain('inside one day has no point')
    const json = (await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity', format: 'json' }, ctxWith(upstream))).json as { grid: string; pointSpacingSec: number }
    expect(json).toMatchObject({ grid: 'daily', pointSpacingSec: 86_400 })

    // A window keeps every bucket, and "held at the last point" is the window's end.
    const w = await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity', fromBlock: 14_000_000, toBlock: 14_050_000 }, ctxWith(upstream))
    expect(w.markdown).toContain('4 buckets of 3h')
    expect(w.markdown).toContain('→ held at window end')
    expect(w.markdown).not.toContain('still held')
    const wj = (await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity', fromBlock: 14_000_000, toBlock: 14_050_000, format: 'json' }, ctxWith(upstream))).json as { grid: string; asOf: { block: number }; positions: { heldAtLastBucket: boolean }[] }
    expect(wj.grid).toBe('step')
    expect(wj.asOf.block).toBe(14_043_200)
    expect(wj.positions[0].heldAtLastBucket).toBe(true)
  })

  it('marks a position farmed earlier and closes its Held on the exact span end', async () => {
    const closed = {
      venue: 'omnipool', farmed: false, positionId: '77', poolKey: 'omnipool', shareAsset: null,
      spans: [
        { fromBlock: 13_990_000, fromTime: '2026-09-19 08:15:30', toBlock: 14_000_100, toTime: '2026-09-20 00:10:00', kind: 'farmed' },
        { fromBlock: 14_000_100, fromTime: '2026-09-20 00:10:00', toBlock: 14_020_000, toTime: '2026-09-21 09:45:12', kind: 'direct' },
      ],
      points: [{ i: 0, shares: '1', valueUsd: 10, legs: [{ asset: dot, amount: '10000000000', valueUsd: 10 }] }, { i: 1, shares: '1', valueUsd: 12, legs: [{ asset: dot, amount: '10000000000', valueUsd: 12 }] }],
    }
    const { upstream } = fakeUpstream({ [LP_HISTORY_PATH]: { ...lpHistoryFixture(), positions: [closed], positionsOmitted: 0 } })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity' }, ctxWith(upstream))
    const row = out.markdown.split('\n').find(l => l.includes('DOT #77'))!
    expect(row).toContain('Omnipool (farmed earlier)')
    expect(row).toContain('2026-09-19 08:15 → 2026-09-21 09:45')
    expect(out.markdown).toContain('`(farmed earlier)`')
    const json = (await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity', format: 'json' }, ctxWith(upstream))).json as { positions: Record<string, unknown>[] }
    expect(json.positions[0]).toMatchObject({
      farmed: false, farmedEver: true, heldAtLastBucket: false,
      heldFrom: { date: '2026-09-19 08:15:30', block: 13_990_000, source: 'span' },
      heldTo: { date: '2026-09-21 09:45:12', block: 14_020_000, source: 'span' },
    })
  })

  it('keeps the first span when it trims a long span history', async () => {
    const spans = Array.from({ length: 14 }, (_, k) => ({ fromBlock: 13_000_000 + k * 10, fromTime: null, toBlock: k === 13 ? null : 13_000_010 + k * 10, toTime: null, kind: k % 2 ? 'farmed' : 'direct' }))
    const flipper = { venue: 'omnipool', farmed: true, positionId: '88', poolKey: 'omnipool', shareAsset: null, spans, points: [{ i: 3, shares: '1', valueUsd: 5, legs: [{ asset: dot, amount: '10000000000', valueUsd: 5 }] }] }
    const { upstream } = fakeUpstream({ [LP_HISTORY_PATH]: { ...lpHistoryFixture(), positions: [flipper], positionsOmitted: 0 } })
    const json = (await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity', format: 'json' }, ctxWith(upstream))).json as { positions: { spans: { fromBlock: number }[]; spansOmitted: number }[] }
    expect(json.positions[0].spans).toHaveLength(10)
    expect(json.positions[0].spans[0].fromBlock).toBe(13_000_000)
    expect(json.positions[0].spans[9].fromBlock).toBe(13_000_130)
    expect(json.positions[0].spansOmitted).toBe(4)
  })

  it('states the closed-candle pricing, the excluded fees and the unpriced counting', async () => {
    const { upstream } = fakeUpstream({ [LP_HISTORY_PATH]: lpHistoryFixture() })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity' }, ctxWith(upstream))
    expect(out.markdown).toMatch(/candle fully CLOSED by the bucket end/)
    expect(out.markdown).toContain("differs from `get_account`'s current Value")
    expect(out.markdown).toContain('uncollected fees are excluded')
    expect(out.markdown).toContain('The portfolio kind\'s value line and `get_account`\'s Value DO count them')
    expect(out.markdown).toContain('COUNTED and left out of the line, not valued at zero')
    expect(out.markdown).toContain('related set')
  })

  it('states the settled farm rewards at the last point beside the LP line, not in it', async () => {
    const fixture = { ...lpHistoryFixture(), unclaimedRewardsUsd: [0, 1, 2, 3.5], rewardsIncomplete: [0, 0, 0, 1] }
    const { upstream } = fakeUpstream({ [LP_HISTORY_PATH]: fixture })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity' }, ctxWith(upstream))
    expect(out.markdown).toContain('Unclaimed farm rewards at the last point')
    expect(out.markdown).toContain('(+ 1 farm entry not stated or unpriced, left out) — settled, beside the LP line and not in it')
    const json = out.json as { unclaimedRewardsUsdAtLast: number | null; rewardsIncompleteAtLast: number; series: { last: { value: number } } }
    expect(json.unclaimedRewardsUsdAtLast).toBe(3.5)
    expect(json.rewardsIncompleteAtLast).toBe(1)
    // The LP line itself is untouched.
    expect(json.series.last.value).toBe(fixture.valueUsd[3])
  })

  it('lists positions still held first, then closed ones, each by last value with unpriced last', async () => {
    const pos = (id: string, lastI: number, valueUsd: number | null) => ({
      venue: 'omnipool', farmed: false, positionId: id, poolKey: 'omnipool', shareAsset: null, spans: [],
      points: [{ i: lastI, shares: '1', valueUsd, legs: [{ asset: dot, amount: '10000000000', valueUsd }] }],
    })
    const fixture = {
      ...lpHistoryFixture(),
      // Route order (last-held value alone): the big closed position leads.
      positions: [pos('1', 1, 50_000), pos('2', 3, 300), pos('3', 2, 900), pos('4', 3, 20), pos('5', 3, null), pos('6', 0, null)],
      positionsOmitted: 0,
    }
    const { upstream } = fakeUpstream({ [LP_HISTORY_PATH]: fixture })
    const md = await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity' }, ctxWith(upstream))
    const order = md.markdown.split('\n').map(l => /DOT #(\d+)/.exec(l)?.[1]).filter(Boolean)
    expect(order).toEqual(['2', '4', '5', '1', '3', '6'])
    const json = await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity', format: 'json' }, ctxWith(upstream))
    expect((json.json as { positions: { positionId: string }[] }).positions.map(p => p.positionId)).toEqual(['2', '4', '5', '1', '3', '6'])
  })

  it('trims to limit and counts what it did not show, the route\'s own cap included', async () => {
    const { upstream } = fakeUpstream({ [LP_HISTORY_PATH]: lpHistoryFixture(5) })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity', limit: 3 }, ctxWith(upstream))
    const rows = out.markdown.split('\n').filter(l => /^\| (Omnipool|Stableswap)/.test(l))
    expect(rows).toHaveLength(3)
    // 7 positions in, 3 shown, 7 more beyond the explorer's cap.
    expect(out.markdown).toMatch(/11 more position\(s\) not shown \(7 of them beyond/)
  })

  it('answers format:"json" with the series stats and a positions array', async () => {
    const { upstream } = fakeUpstream({ [LP_HISTORY_PATH]: lpHistoryFixture() })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity', format: 'json' }, ctxWith(upstream))
    const parsed = JSON.parse(JSON.stringify(out.json))
    expect(parsed.kind).toBe('liquidity')
    expect(parsed.grid).toBe('step')
    expect(parsed.series.points).toBe(4)
    expect(parsed.series.min.value).toBe(800)
    expect(parsed.series.fullyPricedPoints).toBe(3)
    expect(parsed.series.pointsWithUnpriced).toBe(1)
    expect(parsed.positions).toHaveLength(2)
    const omni = parsed.positions[0]
    expect(omni).toMatchObject({ venue: 'omnipool', positionId: '5690', farmed: true, heldAtLastBucket: true, heldTo: null, lastUsd: 1_234, lowUsd: 700, lastSharesRaw: '1000' })
    expect(omni.lastLegs).toEqual([
      { asset: { assetId: 5, symbol: 'DOT', decimals: 10 }, amount: 250, valueUsd: 1_134 },
      { asset: { assetId: 1, symbol: 'H2O', decimals: 12 }, amount: 100, valueUsd: 100 },
    ])
    expect(omni.spans[0]).toMatchObject({ fromTime: '2026-09-19 10:00:00', kind: 'direct' })
    expect(parsed.positions[1]).toMatchObject({ venue: 'stableswap', lastUsd: null, heldAtLastBucket: false, shareAsset: { assetId: 102, symbol: '2-Pool', decimals: 18 }, heldFrom: { source: 'bucket' } })
    expect(parsed.positions[1].lastShares).toBeCloseTo(5e-18)
    expect(parsed.positionsNotShown).toBe(7)
    expect(parsed.positionsBeyondExplorerCap).toBe(7)
  })

  it('names a missing address as NOT_FOUND', async () => {
    const { upstream } = fakeUpstream({})
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'liquidity' }, ctxWith(upstream))
    expect(out.errors?.[0].code).toBe('NOT_FOUND')
  })
})

/* ============ list_accounts ============ */

const directoryPage = {
  total: 114_911,
  rows: [
    {
      account: null,
      tag: { tagId: 'treasury', name: 'Treasury', color: '', icon: '🏦', memberCount: 7 },
      portfolioUsd: 30_081_039.7,
      lastBlock: 14_745_031,
      suppliedUsd: 9_518_159.48,
      borrowedUsd: 3_590_500.14,
      healthFactor: '1210263104132797440',
      supplementalMarket: { marketKey: 'gigahdx', market: 'GIGAHDX', borrowedUsd: 0, healthFactor: null },
      activityCount: 139_799,
      activityCountComplete: false,
      tradingVolumeUsd: 16_983_745.37,
    },
    {
      account: { accountId: ACCOUNT_ID, address: ADDRESS, emoji: '🦕', tag: null, identity: null, profile: null },
      portfolioUsd: 419_854.02,
      lastBlock: 14_742_154,
      suppliedUsd: 2_661_551.07,
      borrowedUsd: 2_241_726.69,
      healthFactor: '1036144325110620416',
      tag: null,
      tradingVolumeUsd: 14_226_184.54,
    },
  ],
}

/* ---- kind 'money-market' ---- */

const MM_HISTORY_PATH = `/explorer/address/${ADDRESS}/money-market-history`
const MAX_UINT = '115792089237316195423570985008687907853269984665640564039457584007913129639935'

function mmHistoryFixture() {
  const obs = (block: number, hf: string, debt = '1000000000') => ({ observedAtBlock: block, timestamp: '2026-09-20 00:00:00', healthFactor: hf, totalCollateralBase: '5000000000', totalDebtBase: debt, availableBorrowsBase: '100', ltv: '7500', liquidationThreshold: '8000' })
  return {
    stepSec: 86_400, priceGrain: '1d', dates: lpDates, blocks: lpBlocks,
    reserveHistoryFrom: { blockHeight: 14_010_000, time: '2026-09-20 12:00:00' },
    suppliedUsd: [null, 900, 950, 1_000],
    borrowedUsd: [null, 400, 450, 420],
    unpriced: [0, 0, 1, 0],
    unclaimedRewardsUsd: [null, 0, 0, 18],
    rewardsIncomplete: [0, 0, 0, 1],
    markets: [
      {
        marketKey: 'core', market: 'Money Market', poolAddress: '0x1b02e051683b5cfac5929c25e84adb26ecf87b38', role: 'primary', stakingBacked: false,
        points: [
          { i: 0, suppliedUsd: null, borrowedUsd: null, netUsd: null, unpriced: 0, observation: obs(13_999_000, '1800000000000000000'), eModeCategoryId: null },
          { i: 1, suppliedUsd: 900, borrowedUsd: 400, netUsd: 500, unpriced: 0, observation: obs(14_013_000, '1150000000000000000'), eModeCategoryId: 1 },
          { i: 2, suppliedUsd: 950, borrowedUsd: 450, netUsd: null, unpriced: 1, observation: obs(14_013_000, '1150000000000000000'), eModeCategoryId: 1 },
          { i: 3, suppliedUsd: 1_000, borrowedUsd: 420, netUsd: 580, unpriced: 0, observation: obs(14_040_000, '1420000000000000000'), eModeCategoryId: 1,
            unclaimedRewards: [{ asset: { assetId: 69, iconAssetId: 69, symbol: 'GDOT', name: null, decimals: 18, parachainId: null, origin: null }, amount: '3000000000000000000', valueUsd: 18, settledAtBlock: 14_039_990 }] },
        ],
        reserves: [
          { asset: dot, aToken: { assetId: 1001, symbol: 'aDOT', name: null, decimals: 10 }, reserveAddress: '0x0000000000000000000000000000000100000005',
            points: [{ i: 1, supplied: '2000000000000', borrowed: '0', suppliedUsd: 900, borrowedUsd: 0, collateral: true }, { i: 3, supplied: '2200000000000', borrowed: '0', suppliedUsd: 1_000, borrowedUsd: 0, collateral: true }] },
          { asset: hollar, aToken: null, reserveAddress: '0x531a654d1696ed52e7275a8cede955e82620f99a',
            points: [{ i: 1, supplied: '0', borrowed: '400000000000000000000', suppliedUsd: 0, borrowedUsd: 400, collateral: false }, { i: 3, supplied: '0', borrowed: '420000000000000000000', suppliedUsd: 0, borrowedUsd: 420, collateral: false }] },
          { asset: usdc, aToken: null, reserveAddress: '0x0000000000000000000000000000000100000016',
            points: [{ i: 2, supplied: '5000000', borrowed: '0', suppliedUsd: null, borrowedUsd: 0, collateral: null }] },
        ],
      },
      {
        marketKey: 'gigahdx', market: 'GIGAHDX', poolAddress: '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923', role: 'supplemental', stakingBacked: true,
        points: [{ i: 3, suppliedUsd: 300, borrowedUsd: 0, netUsd: 300, unpriced: 0, observation: obs(14_041_000, MAX_UINT, '0'), eModeCategoryId: null }],
        reserves: [],
      },
    ],
  }
}

describe("get_account_history kind 'money-market'", () => {
  it('reads the explorer money-market-history route with the block window and nothing else', async () => {
    const { upstream, calls } = fakeUpstream({ [MM_HISTORY_PATH]: mmHistoryFixture() })
    await tool('get_account_history').handler({ address: ADDRESS, kind: 'money-market' }, ctxWith(upstream))
    expect(calls).toEqual([{ path: MM_HISTORY_PATH, query: undefined }])
    const windowed = fakeUpstream({ [MM_HISTORY_PATH]: mmHistoryFixture() })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'money-market', fromBlock: 14_000_000, toBlock: 14_050_000 }, ctxWith(windowed.upstream))
    expect(windowed.calls).toEqual([{ path: MM_HISTORY_PATH, query: { fromBlock: 14_000_000, toBlock: 14_050_000 } }])
    expect(out.markdown).toContain('WINDOWED')
  })

  it('states each market\'s observed health factor with its block, never blended', async () => {
    const { upstream } = fakeUpstream({ [MM_HISTORY_PATH]: mmHistoryFixture() })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'money-market' }, ctxWith(upstream))
    expect(out.markdown).toContain('## Money-market history')
    expect(out.markdown).toContain('### Money Market (core, primary market)')
    expect(out.markdown).toContain('### GIGAHDX (gigahdx, supplemental market) — staking-backed collateral')
    // Last and lowest, each at the block the chain was read at; the repeated
    // carried-forward observation counts once.
    expect(out.markdown).toMatch(/Observed health factor — last:\*\* 1\.4200 \(observed at block 14,040,000/)
    expect(out.markdown).toMatch(/Observed health factor — lowest:\*\* 1\.1500 \(observed at block 14,013,000/)
    expect(out.markdown).toMatch(/Observations in the reading:\*\* 3/)
    // No debt is said in words, never a 1e59 ratio.
    expect(out.markdown).toContain('∞ (no debt)')
    expect(out.markdown).toContain('ISOLATED')
    expect(out.markdown).toContain('AS OBSERVED')
  })

  it('tables the reserves held at the last point and says a pre-floor point states nothing', async () => {
    const { upstream } = fakeUpstream({ [MM_HISTORY_PATH]: mmHistoryFixture() })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'money-market' }, ctxWith(upstream))
    const dotRow = out.markdown.split('\n').find(l => l.includes('DOT (#5)'))!
    expect(dotRow).toContain('220')
    expect(dotRow).toContain('yes')
    const hollarRow = out.markdown.split('\n').find(l => l.includes('HOLLAR (#222)'))!
    expect(hollarRow).toContain('420')
    // USDC was held only earlier.
    expect(out.markdown).not.toContain('USDC (#22)')
    expect(out.markdown).toContain('1 reserve(s) held earlier')
    expect(out.markdown).toContain('end before the reserve coverage floor')
    expect(out.markdown).toContain('block 14,010,000')
  })

  it('returns one structured entry per isolated market and stats over fully priced points', async () => {
    const { upstream } = fakeUpstream({ [MM_HISTORY_PATH]: mmHistoryFixture() })
    const json = (await tool('get_account_history').handler({ address: ADDRESS, kind: 'money-market', format: 'json' }, ctxWith(upstream))).json as {
      kind: string
      series: { statedPoints: number; fullyPricedPoints: number; suppliedUsd: { min: { value: number } }; borrowedUsdAtLast: number }
      markets: Array<{ marketKey: string; observedHealthFactor: { last: { ratio: number | null; observedAtBlock: number }; lowest: { ratio: number } | null }; reservesAtLast: unknown[]; reservesHeldEarlierOnly: number }>
    }
    expect(json.kind).toBe('money-market')
    expect(json.series).toMatchObject({ statedPoints: 3, fullyPricedPoints: 2, borrowedUsdAtLast: 420 })
    expect(json.series.suppliedUsd.min.value).toBe(900)
    expect(json.markets.map(m => m.marketKey)).toEqual(['core', 'gigahdx'])
    expect(json.markets[0].observedHealthFactor.last).toMatchObject({ ratio: 1.42, observedAtBlock: 14_040_000 })
    expect(json.markets[0].observedHealthFactor.lowest?.ratio).toBe(1.15)
    expect(json.markets[0].reservesAtLast).toHaveLength(2)
    expect(json.markets[0].reservesHeldEarlierOnly).toBe(1)
    expect(json.markets[1].observedHealthFactor.last.ratio).toBeNull()
  })
})

describe("get_account_history kind 'money-market' incentives", () => {
  it('states the settled incentives at the last point beside, never inside, the supplied figures', async () => {
    const { upstream } = fakeUpstream({ [MM_HISTORY_PATH]: mmHistoryFixture() })
    const out = await tool('get_account_history').handler({ address: ADDRESS, kind: 'money-market' }, ctxWith(upstream))
    expect(out.markdown).toContain('Unclaimed lending incentives at the last point (settled):** $18')
    expect(out.markdown).toContain('+ 1 reward(s) not stated or not priced, left out')
    expect(out.markdown).toContain('3 GDOT ($18) settled at block 14,039,990')
    expect(out.markdown).toContain('SETTLED at each point')
    const json = (await tool('get_account_history').handler({ address: ADDRESS, kind: 'money-market', format: 'json' }, ctxWith(upstream))).json as { series: { unclaimedRewardsUsdAtLast: number; rewardsIncompleteAtLast: number } }
    expect(json.series).toMatchObject({ unclaimedRewardsUsdAtLast: 18, rewardsIncompleteAtLast: 1 })
  })
})

describe('list_accounts', () => {
  it('renders rank, label, portfolio, activity and volume, and links every account', async () => {
    const { upstream, calls } = fakeUpstream({ '/explorer/accounts': directoryPage })
    const out = await tool('list_accounts').handler({ limit: 2 }, ctxWith(upstream))
    expect(calls[0].query).toEqual({ sort: 'value', limit: 2, offset: 0 })
    expect(out.markdown).toContain('| # | Account | Value | Activity | Volume | Last seen |')
    expect(out.markdown).toContain(`https://explorer.test/account/${ADDRESS}`)
    expect(out.markdown).toContain('139,799+')
    expect(out.markdown).toContain('14,745,031')
  })

  it('marks a folded tag row and says an absent activity count is not zero', async () => {
    const { upstream } = fakeUpstream({ '/explorer/accounts': directoryPage })
    const out = await tool('list_accounts').handler({}, ctxWith(upstream))
    expect(out.markdown).toContain('7 accounts folded into one row')
    expect(out.markdown).toContain('not that it is zero')
  })

  it('shows the primary market only, and says so, on a risk sort', async () => {
    const { upstream } = fakeUpstream({ '/explorer/accounts': directoryPage })
    const out = await tool('list_accounts').handler({ sort: 'health' }, ctxWith(upstream))
    // 1210263104132797440 / 1e18 = 1.21 — the 1e18 encoding, not 1e8.
    expect(out.markdown).toContain('1.21')
    expect(out.markdown).toContain('PRIMARY money market only')
    expect(out.markdown).toContain('riskiest')
  })

  it('refuses a sort the directory does not implement instead of silently using value', async () => {
    const { upstream, calls } = fakeUpstream({ '/explorer/accounts': directoryPage })
    const out = await tool('list_accounts').handler({ sort: 'portfolio' }, ctxWith(upstream))
    expect(out.errors?.[0].code).toBe('INVALID_ARGUMENT')
    expect(calls).toHaveLength(0)
  })

  it('reads a tag through the members route and pages it here, because that route does not', async () => {
    const members = { total: 3, rows: [directoryPage.rows[1], directoryPage.rows[1], directoryPage.rows[1]] }
    const { upstream, calls } = fakeUpstream({ '/explorer/tag/treasury/members': members })
    const out = await tool('list_accounts').handler({ tag: 'treasury', limit: 1, offset: 1 }, ctxWith(upstream))
    expect(calls[0].path).toBe('/explorer/tag/treasury/members')
    expect(calls[0].query).toEqual({ sort: 'value' })
    expect(out.markdown).toContain('rank 2–2 of 3')
  })

  it('treats an explicit null as an unset parameter rather than coercing it to zero', async () => {
    const { upstream, calls } = fakeUpstream({ '/explorer/accounts': directoryPage })
    const out = await tool('list_accounts').handler({ limit: '2', offset: null, tag: null }, ctxWith(upstream))
    expect(out.errors).toBeUndefined()
    expect(calls[0].path).toBe('/explorer/accounts')
    expect(calls[0].query).toEqual({ sort: 'value', limit: 2, offset: 0 })
  })

  it('names an unknown tag rather than reporting an empty directory', async () => {
    const { upstream } = fakeUpstream({})
    const out = await tool('list_accounts').handler({ tag: 'nope' }, ctxWith(upstream))
    expect(out.errors?.[0].code).toBe('NOT_FOUND')
    expect(out.errors?.[0].message).toMatch(/fixed code-defined set/)
  })

  it('answers format:"json" with rows that parse and keep the markets apart', async () => {
    const { upstream } = fakeUpstream({ '/explorer/accounts': directoryPage })
    const out = await tool('list_accounts').handler({ format: 'json' }, ctxWith(upstream))
    const parsed = JSON.parse(JSON.stringify(out.json, null, 2))
    expect(parsed.total).toBe(114_911)
    expect(parsed.rows[0].tagGroup.tagId).toBe('treasury')
    expect(parsed.rows[0].address).toBeNull()
    expect(parsed.rows[0].primaryMarket.healthFactor).toBe('1210263104132797440')
    expect(parsed.rows[0].supplementalMarket.marketKey).toBe('gigahdx')
    expect(parsed.rows[1].url).toBe(`https://explorer.test/account/${ADDRESS}`)
  })
})
