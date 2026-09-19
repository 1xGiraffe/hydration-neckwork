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
    expect(out.markdown).toContain('Holdings (gross: balances + LP positions)')
    expect(out.markdown).toContain('Money-market debt (netted out above)')
    expect(out.markdown).not.toMatch(/\*\*Portfolio:\*\*/)
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
