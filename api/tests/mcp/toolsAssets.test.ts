import { describe, expect, it } from 'vitest'
import { assetTools } from '../../src/mcp/tools/assets.ts'
import { UpstreamError, type UpstreamClient } from '../../src/mcp/upstream.ts'
import type { ToolContext, ToolDefinition } from '../../src/mcp/toolTypes.ts'

// The asset tools against recorded shapes, with no network. The load-bearing
// case is the NULL SHELL: `/explorer/asset/:id` answers an unknown-but-valid id
// with a record of nulls rather than a 404, and rendering that shell would state
// that a token exists when none does.

const tool = (name: string): ToolDefinition => {
  const found = assetTools.find(t => t.name === name)
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

interface Recorded { path: string; query?: Record<string, unknown> }

function fakeUpstream(routes: Record<string, unknown>): { upstream: UpstreamClient; calls: Recorded[] } {
  const calls: Recorded[] = []
  const upstream: UpstreamClient = {
    async get<T>(path: string, query?: Record<string, string | number | boolean | null | undefined>): Promise<T> {
      calls.push({ path, query: query as Record<string, unknown> | undefined })
      if (!(path in routes)) throw new UpstreamError('not found', 404, { error: 'not found' }, path)
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

const REGISTRY = [
  { assetId: 0, iconAssetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null, origin: null, price: 0.0077, change24h: 0.055, type: 'Native', amountUsd: 49_611_348, holderCount: 61_136 },
  { assetId: 22, iconAssetId: 22, symbol: 'USDC', name: null, decimals: 6, parachainId: 1000, origin: { ecosystem: 'polkadot', chainId: '1000', assetId: null }, price: 1.0002, change24h: -0.000004, type: 'Token', amountUsd: 4_876_949, holderCount: 4367 },
  { assetId: 21, iconAssetId: 21, symbol: 'USDC', name: 'USDC (Wormhole)', decimals: 6, parachainId: null, origin: { ecosystem: 'ethereum', chainId: '1', assetId: '0xa0b8' }, price: 1.0004, change24h: 0.0012, type: 'Token', amountUsd: 180_000, holderCount: 741 },
  { assetId: 222, iconAssetId: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachainId: null, origin: null, price: 0.999, change24h: 0.0008, type: 'Token', amountUsd: 12_686_136, holderCount: 392 },
  { assetId: 5, iconAssetId: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachainId: null, origin: null, price: 1.13, change24h: 0.0959, type: 'Token', amountUsd: 4_540_000, holderCount: 19_783 },
  {
    assetId: -1,
    iconAssetId: -1,
    symbol: 'wNEAR',
    name: 'Wrapped NEAR',
    decimals: 24,
    parachainId: null,
    origin: { ecosystem: 'near', chainId: 'near', assetId: 'NEAR' },
    price: 3.53,
    change24h: null,
    type: 'Cross-chain',
    amountUsd: null,
    xcDestination: { platform: 'near', oneClickId: 'nep141:wrap.near', symbol: 'wNEAR', name: 'Wrapped NEAR', decimals: 24, chain: 'near', chainName: 'NEAR', origin: { ecosystem: 'near', chainId: 'near', assetId: 'NEAR' } },
  },
]

function assetDetail(asset: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    asset,
    holderCount: 392,
    dcaCount: 6,
    limitOrderCount: 1,
    totalUsd: 12_686_136,
    priceSeries: [0.9, 1.1, 1.0, 0.95, 1.05],
    priceDates: ['2026-09-14 00:00:00', '2026-09-15 00:00:00', '2026-09-16 00:00:00', '2026-09-17 00:00:00', '2026-09-18 00:00:00'],
    liquidations: null,
    liquiditySourceCount: 14,
    ...overrides,
  }
}

/** Exactly what the explorer answers for an id no asset carries. */
const nullShell = (assetId: number) => ({
  asset: { assetId, iconAssetId: assetId, symbol: `#${assetId}`, name: null, decimals: 12, parachainId: null, origin: null, price: null, change24h: null, type: 'Token', amountUsd: 0 },
  holderCount: 0,
  dcaCount: 0,
  limitOrderCount: 0,
  totalUsd: 0,
  priceSeries: [],
  priceDates: [],
  liquidations: null,
  liquiditySourceCount: 0,
})

describe('get_asset — the null shell', () => {
  it('reports an unregistered id as NOT_FOUND instead of rendering the shell as a token', async () => {
    const { upstream } = fakeUpstream({ '/explorer/asset/999999': nullShell(999_999) })
    const out = await tool('get_asset').handler({ asset: '999999' }, ctxWith(upstream))
    expect(out.markdown).toBe('')
    expect(out.errors?.[0].code).toBe('NOT_FOUND')
    expect(out.errors?.[0].message).toMatch(/EMPTY SHELL/)
    expect(out.errors?.[0].message).toMatch(/rather than a 404/)
    expect((out.json as { registered: boolean }).registered).toBe(false)
    // Nothing that looks like a real record leaks out.
    expect(out.markdown).not.toContain('#999999')
  })

  it('does not mistake a real but quiet asset for the shell', async () => {
    // A freshly registered token: no holders, no price, no liquidity — but it
    // has a SYMBOL, which the shell never does.
    const quiet = {
      asset: { assetId: 4242, iconAssetId: 4242, symbol: 'NEWT', name: null, decimals: 12, parachainId: null, origin: null, price: null, change24h: null, type: 'Token', amountUsd: 0 },
      holderCount: 0,
      dcaCount: 0,
      limitOrderCount: 0,
      totalUsd: 0,
      priceSeries: [],
      priceDates: [],
      liquidations: null,
      liquiditySourceCount: 0,
    }
    const { upstream } = fakeUpstream({ '/explorer/asset/4242': quiet })
    const out = await tool('get_asset').handler({ asset: '4242' }, ctxWith(upstream))
    expect(out.errors).toBeUndefined()
    expect(out.markdown).toContain('NEWT')
    expect(out.markdown).toContain('not priced by the index')
  })

  it('keeps an asset that carries a #id symbol but real substance', async () => {
    // The registry really does hold `#1000015b`-style names; only a record that
    // is empty in every dimension at once is a shell.
    const bond = assetDetail(
      { assetId: 1_000_051, iconAssetId: 1_000_015, symbol: '#1000051', name: '#1000015 Bond · matures 2024-10-24', decimals: 12, parachainId: null, origin: null, price: null, change24h: null, type: 'Token', amountUsd: null },
      { holderCount: 3, totalUsd: 0, priceSeries: [], priceDates: [], liquiditySourceCount: 0, dcaCount: 0, limitOrderCount: 0 },
    )
    const { upstream } = fakeUpstream({ '/explorer/asset/1000051': bond })
    const out = await tool('get_asset').handler({ asset: '1000051' }, ctxWith(upstream))
    expect(out.errors).toBeUndefined()
    expect(out.markdown).toContain('Bond')
  })
})

describe('get_asset — resolving the asset', () => {
  it('lists the candidates and refuses to guess when a symbol is ambiguous', async () => {
    const { upstream, calls } = fakeUpstream({ '/explorer/assets': REGISTRY })
    const out = await tool('get_asset').handler({ asset: 'usdc' }, ctxWith(upstream))
    expect(out.errors?.[0].code).toBe('INVALID_ARGUMENT')
    expect(out.errors?.[0].message).toMatch(/matches 2 registered assets/)
    expect(out.markdown).toContain('is ambiguous')
    // Most-held first, so the list leads with the likely one.
    expect(out.markdown.indexOf('| 22 |')).toBeLessThan(out.markdown.indexOf('| 21 |'))
    // It must NOT have fetched a detail for either candidate.
    expect(calls.map(c => c.path)).toEqual(['/explorer/assets'])
    expect((out.json as { candidates: unknown[] }).candidates).toHaveLength(2)
  })

  it('resolves an unambiguous symbol to its id and reads that detail', async () => {
    const { upstream, calls } = fakeUpstream({
      '/explorer/assets': REGISTRY,
      '/explorer/asset/222': assetDetail(REGISTRY[3]),
    })
    const out = await tool('get_asset').handler({ asset: 'hollar' }, ctxWith(upstream))
    expect(calls.map(c => c.path)).toEqual(['/explorer/assets', '/explorer/asset/222'])
    expect(out.markdown).toContain('asset #222')
    expect(out.markdown).toContain('Resolved from')
  })

  it('takes an id without touching the registry', async () => {
    const { upstream, calls } = fakeUpstream({ '/explorer/asset/222': assetDetail(REGISTRY[3]) })
    await tool('get_asset').handler({ asset: '222' }, ctxWith(upstream))
    expect(calls.map(c => c.path)).toEqual(['/explorer/asset/222'])
  })

  it('refuses a cross-chain destination as an asset id, because its id routes nowhere', async () => {
    const { upstream } = fakeUpstream({ '/explorer/assets': REGISTRY })
    const out = await tool('get_asset').handler({ asset: 'wNEAR' }, ctxWith(upstream))
    expect(out.errors?.[0].code).toBe('NOT_FOUND')
    expect(out.errors?.[0].message).toMatch(/CROSS-CHAIN DESTINATION/)
    expect(out.errors?.[0].message).toContain('near')
  })

  it('says a symbol is unknown and points at the ids that still work', async () => {
    const { upstream } = fakeUpstream({ '/explorer/assets': REGISTRY })
    const out = await tool('get_asset').handler({ asset: '2-Pool-GDOT' }, ctxWith(upstream))
    expect(out.errors?.[0].code).toBe('NOT_FOUND')
    expect(out.errors?.[0].message).toMatch(/pool-share tokens/)
  })
})

describe('get_asset — sections', () => {
  const routes = {
    '/explorer/asset/222': assetDetail(REGISTRY[3]),
    '/explorer/holders/222': {
      asset: REGISTRY[3],
      total: 376,
      totalUsd: 12_686_136,
      holders: [
        { rank: 1, account: null, tag: { tagId: 'stableswap-pools', name: 'Stableswap Pool', color: '#57a5ec', icon: '💧', memberCount: 9 }, balance: '4701297114145144140504195', lastBlock: 14_745_071, valueUsd: 4_697_229, share: 0.370264 },
        { rank: 2, account: { accountId: '0xaa', address: '112CsJbui45Q8UEQzHL68UEUZeTP8BS3b5vjP5JRywxuUxQV', emoji: '🐈', tag: null, identity: null, profile: null }, tag: null, balance: '164000000000000000000000', lastBlock: 14_745_000, valueUsd: 164_000, share: 0.0129 },
      ],
    },
    '/explorer/asset/222/liquidity': {
      asset: { assetId: 222, symbol: 'HOLLAR', decimals: 18 },
      totalAmount: '5000000000000000000000000',
      totalUsd: 4_995_000,
      sources: [
        { kind: 'stableswap', poolId: 102, name: '2-Pool', tvlUsd: 218_754, assetAmount: '4701297114145144140504195', assetUsd: 4_697_229, assetSharePct: 51.2, composition: [], hasPegs: false },
        { kind: 'xyk', poolId: 1_000_086, name: 'dead / HOLLAR', tvlUsd: null, assetAmount: '0', assetUsd: 0, assetSharePct: null, composition: [], hasPegs: false },
      ],
      former: [{ kind: 'xyk', poolId: 1_000_476, name: 'HOLLAR / X', lastActiveBlock: 11_213_400, lastActiveAt: '2026-02-03 02:27:42' }],
      history: { buckets: [], series: [] },
    },
    '/explorer/asset/222/dcas': {
      buys: [{ id: 35_305, assetIn: REGISTRY[0], assetOut: REGISTRY[3], direction: 'Sell', amountPerTrade: '500000000000000', totalAmount: '0', filledAmount: '0', remainingAmount: null, executionsDone: 65, period: 1800, periodSeconds: null, nextExecutionBlock: null, valueUsd: 5.44, budgetUsd: null, fundingBalance: null, who: { accountId: '0xbb', address: '12mVEpBf5btD9i8iLRKFT8FGzEpAmhh2ANBCtrrv12kcJ4dr', emoji: '🦕', tag: null, identity: null, profile: null } }],
      sells: [],
    },
    '/explorer/asset/222/limit-orders': {
      bids: [{
        intentId: '33013174137020597645340573696141',
        seq: 141,
        who: { accountId: '0xcc', address: '135yiujiLFfogvTwbfr3yoqGK7zAu3f5SD5y1q8PMokYeSuc', emoji: '🦋', tag: null, identity: null, profile: null },
        assetIn: REGISTRY[1],
        assetOut: REGISTRY[3],
        amountIn: '20810000',
        amountOut: '23787347216527690690',
        filledIn: '0',
        filledOut: '0',
        remainingIn: '20810000',
        remainingOut: '23787347216527690690',
        fills: 0,
        partial: false,
        limitPrice: 1.143,
        valueUsd: 23.92,
        placedBlock: 14_708_909,
        placedIndex: 3,
        timestamp: '2026-09-17 12:22:36',
        deadline: null,
        price: 0.8748,
        priceUsd: 1.0056,
        size: '23787347216527690690',
        total: '20810000',
        counter: REGISTRY[1],
      }],
      asks: [],
    },
    '/explorer/asset/222/prices': { interval: '1d', priceSeries: [0.99, 1.0, 1.01], priceDates: ['2026-08-01 00:00:00', '2026-08-02 00:00:00', '2026-08-03 00:00:00'] },
  }

  it('reads nothing but the detail by default', async () => {
    const { upstream, calls } = fakeUpstream(routes)
    const out = await tool('get_asset').handler({ asset: '222' }, ctxWith(upstream))
    expect(calls.map(c => c.path)).toEqual(['/explorer/asset/222'])
    expect(out.markdown).toContain('## Price history')
    expect(out.markdown).toContain('Ask for `include:')
  })

  it('maps each include to its own route and renders it', async () => {
    const { upstream, calls } = fakeUpstream(routes)
    const out = await tool('get_asset').handler({ asset: '222', include: ['holders', 'pools', 'dca', 'orders'] }, ctxWith(upstream))
    expect(calls.map(c => c.path).sort()).toEqual([
      '/explorer/asset/222',
      '/explorer/asset/222/dcas',
      '/explorer/asset/222/limit-orders',
      '/explorer/asset/222/liquidity',
      '/explorer/holders/222',
    ])
    expect(out.markdown).toContain('## Top holders')
    expect(out.markdown).toContain('## Where the liquidity sits')
    expect(out.markdown).toContain('## Ongoing DCA')
    expect(out.markdown).toContain('## Open limit orders')
    // The 18-decimal balance is scaled, and the tag row is marked as a fold.
    expect(out.markdown).toContain('4.7M HOLLAR')
    expect(out.markdown).toContain('9 accounts folded')
    expect(out.markdown).toContain('37.03%')
    // A venue holding none of the asset is dropped and the drop is stated.
    expect(out.markdown).toContain('2-Pool')
    expect(out.markdown).toMatch(/1 registered venue\(s\) hold none of this asset/)
  })

  it('accepts a calendar day or unix seconds for the price window and sends seconds', async () => {
    const byDate = fakeUpstream(routes)
    await tool('get_asset').handler({ asset: '222', include: ['series'], seriesFrom: '2026-08-01', seriesTo: '2026-08-03' }, ctxWith(byDate.upstream))
    const dateCall = byDate.calls.find(c => c.path.endsWith('/prices'))
    expect(dateCall?.query).toMatchObject({ fromTs: Date.parse('2026-08-01T00:00:00Z') / 1000, toTs: Date.parse('2026-08-03T00:00:00Z') / 1000 })

    const bySeconds = fakeUpstream(routes)
    await tool('get_asset').handler({ asset: '222', include: ['series'], seriesFrom: '1755000000', seriesTo: '1758000000' }, ctxWith(bySeconds.upstream))
    expect(bySeconds.calls.find(c => c.path.endsWith('/prices'))?.query).toMatchObject({ fromTs: 1_755_000_000, toTs: 1_758_000_000 })
  })

  it('refuses an empty price window rather than asking for one', async () => {
    const { upstream, calls } = fakeUpstream(routes)
    const out = await tool('get_asset').handler({ asset: '222', include: ['series'], seriesFrom: '2026-08-03', seriesTo: '2026-08-01' }, ctxWith(upstream))
    expect(out.errors?.[0].code).toBe('INVALID_ARGUMENT')
    expect(calls.filter(c => c.path.endsWith('/prices'))).toHaveLength(0)
  })

  it('returns the sections that answered plus an error for the one that did not', async () => {
    const { upstream } = fakeUpstream({ ...routes, '/explorer/holders/222': new UpstreamError('upstream responded 500', 500, null, '/explorer/holders/222') })
    const out = await tool('get_asset').handler({ asset: '222', include: ['holders', 'dca'] }, ctxWith(upstream))
    expect(out.markdown).toContain('## Ongoing DCA')
    expect(out.markdown).not.toContain('## Top holders')
    expect(out.errors).toHaveLength(1)
    expect(out.errors?.[0].code).toBe('UPSTREAM_UNAVAILABLE')
    // The missing section is named, so its absence cannot read as "no holders".
    expect(out.markdown).toMatch(/MISSING because their read failed[^\n]*holders/)
  })

  it('answers format:"json" with a record that parses and carries scaled figures', async () => {
    const { upstream } = fakeUpstream(routes)
    const out = await tool('get_asset').handler({ asset: '222', include: ['holders', 'pools', 'orders'], format: 'json' }, ctxWith(upstream))
    const parsed = JSON.parse(JSON.stringify(out.json, null, 2))
    expect(parsed.assetId).toBe(222)
    expect(parsed.registered).toBe(true)
    expect(parsed.decimals).toBe(18)
    expect(parsed.url).toBe('https://explorer.test/asset/222')
    expect(parsed.holders.top[0].balance).toBeCloseTo(4_701_297.11, 1)
    expect(parsed.holders.top[0].address).toBeNull()
    expect(parsed.holders.top[0].tagGroup).toBe('stableswap-pools')
    expect(parsed.liquidity.sources[0].amount).toBeCloseTo(4_701_297.11, 1)
    expect(parsed.limitOrders.bids[0].remainingIn).toBeCloseTo(20.81, 2)
  })
})

describe('list_assets', () => {
  it('states how many of the registry it shows and renders the columns', async () => {
    const { upstream } = fakeUpstream({ '/explorer/assets': REGISTRY })
    const out = await tool('list_assets').handler({ limit: 3 }, ctxWith(upstream))
    expect(out.markdown).toContain('3 of 6 matching, out of 6 registered')
    expect(out.markdown).toContain('| Id | Symbol | Name | Dec | Price | 24 h | Value held | Holder rows | Origin |')
    expect(out.markdown).toContain('3 further matching asset(s) not shown')
    // change24h is a FRACTION upstream: 0.055 is +5.50%, not +0.06%.
    expect(out.markdown).toContain('+5.50%')
    expect(out.markdown).toContain('61,136')
    expect(out.markdown).toContain('https://explorer.test/asset/0')
  })

  // `indexOf(a) < indexOf(b)` is vacuously true when `a` is absent: -1 is below
  // every index, so a sort that dropped the leading row would pass. Each
  // comparison below is guarded by asserting both rows are present first.
  const orderedBefore = (md: string, first: string, second: string) => {
    expect(md, `${first} is missing from the table entirely`).toContain(first)
    expect(md, `${second} is missing from the table entirely`).toContain(second)
    expect(md.indexOf(first), `${first} must sort above ${second}`).toBeLessThan(md.indexOf(second))
  }

  it('sorts by value held, holders, symbol and volume, and reads the price surface only for volume', async () => {
    const byTvl = fakeUpstream({ '/explorer/assets': REGISTRY })
    const tvl = await tool('list_assets').handler({}, ctxWith(byTvl.upstream))
    expect(byTvl.calls.map(c => c.path)).toEqual(['/explorer/assets'])
    orderedBefore(tvl.markdown, 'HDX', 'HOLLAR')

    const bySymbol = fakeUpstream({ '/explorer/assets': REGISTRY })
    const symbol = await tool('list_assets').handler({ sort: 'symbol' }, ctxWith(bySymbol.upstream))
    orderedBefore(symbol.markdown, 'DOT', 'HDX')

    const byVolume = fakeUpstream({
      '/explorer/assets': REGISTRY,
      '/market-stats': [{ assetId: 222, volumeUsd24h: 900_000 }, { assetId: 0, volumeUsd24h: 17_734 }],
    })
    const volume = await tool('list_assets').handler({ sort: 'volume', limit: 3 }, ctxWith(byVolume.upstream))
    expect(byVolume.calls.map(c => c.path).sort()).toEqual(['/explorer/assets', '/market-stats'])
    expect(volume.markdown).toContain('Volume 24 h')
    orderedBefore(volume.markdown, 'HOLLAR', 'HDX')
    expect(volume.markdown).toMatch(/covers only the traded assets/)
  })

  it('filters on symbol, name and exact id', async () => {
    const { upstream } = fakeUpstream({ '/explorer/assets': REGISTRY })
    const bySymbol = await tool('list_assets').handler({ query: 'usdc' }, ctxWith(upstream))
    expect(bySymbol.markdown).toContain('2 of 2 matching')

    const byId = await tool('list_assets').handler({ query: '5' }, ctxWith(upstream))
    expect(byId.markdown).toContain('1 of 1 matching')
    expect(byId.markdown).toContain('DOT')

    const miss = await tool('list_assets').handler({ query: 'zzz' }, ctxWith(upstream))
    expect(miss.markdown).toMatch(/no registered asset matches/)
  })

  it('never prints a cross-chain destination\'s negative sentinel as an asset id', async () => {
    const { upstream } = fakeUpstream({ '/explorer/assets': REGISTRY })
    const out = await tool('list_assets').handler({ query: 'wnear' }, ctxWith(upstream))
    expect(out.markdown).toContain('xc/near')
    expect(out.markdown).not.toContain('| -1 |')
    expect(out.markdown).toMatch(/cross-chain destination/)
    const parsed = out.json as { assets: { assetId: number | null; crossChainPlatform: string | null }[] }
    expect(parsed.assets[0].assetId).toBeNull()
    expect(parsed.assets[0].crossChainPlatform).toBe('near')
  })

  it('takes a numeric argument spelled as a string, and an explicit null as absent', async () => {
    const { upstream } = fakeUpstream({ '/explorer/assets': REGISTRY })
    // A model routinely writes "3" for 3 and null for "not using this".
    const out = await tool('list_assets').handler({ limit: '3', query: null, sort: null }, ctxWith(upstream))
    expect(out.errors).toBeUndefined()
    expect(out.markdown).toContain('3 of 6 matching')
  })

  it('warns that symbols are not unique, every time', async () => {
    const { upstream } = fakeUpstream({ '/explorer/assets': REGISTRY })
    const out = await tool('list_assets').handler({ limit: 1 }, ctxWith(upstream))
    expect(out.markdown).toMatch(/Symbols are NOT unique/)
  })

  it('reports the registry being unavailable rather than an empty registry', async () => {
    const { upstream } = fakeUpstream({ '/explorer/assets': new UpstreamError('upstream request timed out after 60000ms', 0, null, '/explorer/assets') })
    const out = await tool('list_assets').handler({}, ctxWith(upstream))
    expect(out.markdown).toBe('')
    expect(out.errors?.[0].code).toBe('UPSTREAM_UNAVAILABLE')
  })

  it('answers format:"json" with a record that parses', async () => {
    const { upstream } = fakeUpstream({ '/explorer/assets': REGISTRY })
    const out = await tool('list_assets').handler({ limit: 2, format: 'json' }, ctxWith(upstream))
    const parsed = JSON.parse(JSON.stringify(out.json, null, 2))
    expect(parsed.registered).toBe(6)
    expect(parsed.assets).toHaveLength(2)
    expect(parsed.assets[0].decimals).toBe(12)
    expect(parsed.assets[0].url).toBe('https://explorer.test/asset/0')
  })

  it('keeps a long answer inside the text budget and says what it cut', async () => {
    const { upstream } = fakeUpstream({ '/explorer/assets': REGISTRY })
    const out = await tool('list_assets').handler({ limit: 6 }, ctxWith(upstream, 700))
    expect(out.markdown.length).toBeLessThanOrEqual(700)
    expect(out.markdown).toContain('Truncated')
  })
})
