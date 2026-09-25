import { describe, expect, it } from 'vitest'
import { searchTools } from '../../src/mcp/tools/search.ts'
import { inspectEntityTools } from '../../src/mcp/tools/inspectEntity.ts'
import { activityTools } from '../../src/mcp/tools/activity.ts'
import { UpstreamError } from '../../src/mcp/upstream.ts'
import type { UpstreamClient } from '../../src/mcp/upstream.ts'
import type { ToolContext, ToolDefinition, ToolOutput } from '../../src/mcp/toolTypes.ts'
import { formatUsd } from '../../src/mcp/format/units.ts'

/**
 * The three entry-point tools, against inlined fixtures.
 *
 * What is pinned here is what an agent would state WRONGLY if it broke: which
 * route an identifier resolves to, the three activity traps, the offset bounds
 * that would otherwise arrive as a raw 400, the not-indexed / never-existed
 * split an agent acts on differently, and the two renderings that are never
 * allowed to leak — a raw AccountId32 as a name, and an unscaled integer as an
 * amount. Nothing here touches the network: the upstream client is a fake that
 * also records every path the tools built.
 */

const search = searchTools[0]
const inspect = inspectEntityTools[0]
const activity = activityTools[0]

type Query = Record<string, string | number | boolean | null | undefined> | undefined

/** A 404 fixture, with the body the explorer sends on a coordinate miss. */
class Miss {
  constructor(readonly status: number, readonly body: unknown) {}
}

interface Fake {
  upstream: UpstreamClient
  calls: { path: string; query: Query }[]
  paths: () => string[]
}

function fake(routes: Record<string, unknown> | ((path: string, query: Query) => unknown)): Fake {
  const calls: { path: string; query: Query }[] = []
  const upstream: UpstreamClient = {
    async get<T>(path: string, query?: Query): Promise<T> {
      calls.push({ path, query })
      const entry = typeof routes === 'function' ? routes(path, query) : routes[path]
      if (entry === undefined) throw new UpstreamError('not found', 404, { error: 'not found' }, path)
      if (entry instanceof Miss) throw new UpstreamError('not found', entry.status, entry.body, path)
      return entry as T
    },
  }
  return { upstream, calls, paths: () => calls.map(c => c.path) }
}

const ctx = (f: Fake): ToolContext => ({
  upstream: f.upstream,
  explorerBaseUrl: 'https://explorer.test',
  publicUrl: 'https://mcp.test',
  maxTextChars: 24_000,
})

const call = (tool: ToolDefinition, input: Record<string, unknown>, f: Fake): Promise<ToolOutput> =>
  tool.handler(input, ctx(f))

/* ============ fixtures ============ */

const SS58 = '13b6hRRYPHTxFzs9prvL2YGHQepvd4YhdDb9Tc7khySp3hMN'
const H160 = '0xdee629af973ebf5bf261ace12ffd1900ac715f5e'
const V3_POOL = '0x5c6208a3c316a801f8996750aa7b6f45fc988548'
const HASH = '0xdc773062b3cee9f8c89da28610cf091c80c0da0f0ce5457f762d1b6db75453f9'
// The public key of the actor below. It is a key, not an address, and no
// rendering may ever print it.
const ACCOUNT_ID = '0xdeadbeef00000000000000000000000000000000000000000000000000000001'
// 1.2345 HDX in planck. Printed unscaled it would read as a trillion tokens.
const RAW_AMOUNT = '1234500000000'

const HDX = { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12 }
const ACTOR = { accountId: ACCOUNT_ID, address: SS58, emoji: '🌻' }

const TRANSFER_ROW = {
  type: 'transfer' as const,
  blockHeight: 100, timestamp: '2026-09-18 10:00:00', eventIndex: 7, extrinsicIndex: 2,
  who: ACTOR, to: null, asset: HDX, assetIn: null, assetOut: null,
  amount: RAW_AMOUNT, amountIn: null, amountOut: null, valueUsd: 9.53,
}
const DCA_ROW = {
  type: 'trade' as const, dca: true, dcaScheduleId: 30104,
  blockHeight: 101, timestamp: '2026-09-18 10:00:12', eventIndex: 18, extrinsicIndex: null,
  who: ACTOR, to: null, asset: null,
  assetIn: HDX, assetOut: { assetId: 222, symbol: 'HOLLAR', decimals: 18 },
  amount: null, amountIn: RAW_AMOUNT, amountOut: '7570000000000000000', valueUsd: 7.57,
}
const PLAIN_SWAP_ROW = {
  ...DCA_ROW, dca: false, dcaScheduleId: undefined, blockHeight: 102, eventIndex: 19,
}
const MEMPOOL_ROW = {
  type: 'trade' as const, mempool: true, finalized: false, hash: HASH,
  // The pool layer has no coordinates yet: these zeroes are placeholders.
  blockHeight: 0, timestamp: '2026-09-18 10:00:30', eventIndex: 0, extrinsicIndex: 0,
  who: ACTOR, to: null, asset: null, assetIn: HDX, assetOut: { assetId: 222, symbol: 'HOLLAR', decimals: 18 },
  amount: null, amountIn: RAW_AMOUNT, amountOut: '7570000000000000000', valueUsd: 7.57,
}

const BLOCK = {
  height: 100, timestamp: '2026-09-18 10:00:00', hash: '0xaaa1', parentHash: '0xaaa0',
  stateRoot: null, extrinsicsRoot: null, author: null, specVersion: 443,
  extrinsicCount: 1, eventCount: 3, eventsShown: 3,
  extrinsics: [{ blockHeight: 100, index: 2, hash: HASH, timestamp: '2026-09-18 10:00:00', signer: ACTOR, success: true, callName: 'Router.sell', fee: RAW_AMOUNT }],
  events: [],
}
const EXTRINSIC = {
  blockHeight: 100, index: 2, hash: HASH, timestamp: '2026-09-18 10:00:00',
  signer: ACTOR, success: true, callName: 'Router.sell', fee: RAW_AMOUNT, tip: null,
  version: 4, errorReason: null, callArgs: {},
  events: [{ eventIndex: 7, name: 'Router.Executed' }, { eventIndex: 8, name: 'System.ExtrinsicSuccess' }],
}
const ADDRESS = {
  input: SS58, kind: 'substrate', accountId: ACCOUNT_ID, emoji: '🌻', evmAddress: null,
  ss58: '7LBeyvXwbcZk6hMNtQLppK248DqT5cDVWUVRDfdisquXn4M5', ss58Polkadot: SS58,
  tag: null, identity: null, relatedAccountIds: [ACCOUNT_ID], aliases: [],
  balances: [{ asset: HDX, total: RAW_AMOUNT, free: RAW_AMOUNT, reserved: '0', lastBlock: 100, valueUsd: 9.53 }],
  topAssets: [], portfolioUsd: 9.53, moneyMarket: [],
}

/* ============ search ============ */

describe('search', () => {
  it('groups hits by kind and hands back the identifier to inspect', async () => {
    const f = fake({ '/explorer/search': [
      { type: 'tag', value: 'treasury', label: 'Treasury' },
      { type: 'asset', value: '0', label: 'HDX', desc: 'Hydration', asset: HDX },
      { type: 'address', value: ACCOUNT_ID, label: SS58, emoji: '🌻' },
    ] })
    const out = await call(search, { query: 'treasury' }, f)
    expect(out.markdown).toContain('### Tags')
    expect(out.markdown).toContain('### Assets')
    expect(out.markdown).toContain('`treasury`')
    expect(out.markdown).toContain('https://explorer.test/asset/0')
    // The closing pointer names the call that opens the FIRST hit.
    expect(out.markdown).toContain('`inspect_entity {"identifier":"treasury","kind":"tag"}`')
  })

  it('builds a referendum URL from pallet and index, never from the title key', async () => {
    const f = fake({ '/explorer/search': [
      { type: 'referendum', value: 'opengov:410', label: 'Reduce the weight cap', pallet: 'opengov', index: 410, status: 'ongoing' },
    ] })
    const out = await call(search, { query: '410' }, f)
    expect(out.markdown).toContain('https://explorer.test/referendum/opengov/410')
    expect(out.markdown).not.toContain('/referendum/opengov:410')
    expect(out.markdown).toContain('`opengov/410`')
  })

  it('never prints a cross-chain destination\'s negative sentinel asset id', async () => {
    const f = fake({ '/explorer/search': [
      { type: 'xcDestination', value: 'zec', label: 'ZEC', desc: 'Zcash · cross-chain destination', asset: { assetId: -2, symbol: 'ZEC', decimals: 8 } },
    ] })
    const out = await call(search, { query: 'zec' }, f)
    expect(out.markdown).toContain('https://explorer.test/asset/xc/zec')
    expect(out.markdown).not.toContain('-2')
    expect(JSON.stringify(out.json)).not.toContain('"assetId"')
  })

  it('answers an unresolvable query with the kinds it does resolve, not an error', async () => {
    const f = fake({ '/explorer/search': [] })
    const out = await call(search, { query: 'zzz' }, f)
    expect(out.errors).toBeUndefined()
    expect(out.markdown).toContain('No Hydration entity matches')
    expect(out.markdown).toContain('asset symbols and names')
  })

  it('trims in resolution order and says how many it dropped', async () => {
    const hits = Array.from({ length: 9 }, (_, i) => ({ type: 'tag', value: `t${i}`, label: `Tag ${i}` }))
    const f = fake({ '/explorer/search': hits })
    const out = await call(search, { query: 'tag', limit: 3 }, f)
    expect(out.markdown).toContain('6 more not shown')
    expect(out.markdown).toContain('Tag 0')
    expect(out.markdown).not.toContain('Tag 3')
  })
})

/* ============ inspect_entity detection ============ */

describe('inspect_entity detection', () => {
  it('reads a bare number as a block and names the other readings it has', async () => {
    const f = fake({
      '/explorer/search': [
        { type: 'block', value: '100' },
        { type: 'pool', value: '100', label: '2-Pool', poolKind: 'stableswap', tvlUsd: 1000 },
        { type: 'referendum', value: 'opengov:100', label: 'A referendum', pallet: 'opengov', index: 100, status: 'executed' },
      ],
      '/explorer/asset/100': { asset: { assetId: 100, symbol: '#100', name: null, decimals: 12, price: null, amountUsd: 0 }, holderCount: 0, dcaCount: 0, totalUsd: 0, priceSeries: [] },
      '/explorer/block/100': BLOCK,
      '/explorer/block/100/activity': [TRANSFER_ROW],
    })
    const out = await call(inspect, { identifier: '100' }, f)
    expect(f.paths()).toContain('/explorer/block/100')
    expect(out.markdown).toContain('## Block 100')
    expect(out.markdown).toContain('also resolves as')
    expect(out.markdown).toContain('"identifier":"100","kind":"pool"')
    expect(out.markdown).toContain('"identifier":"opengov/100","kind":"referendum"')
  })

  it('offers a real registry asset as a candidate and reads it under kind:asset', async () => {
    const asset = { asset: { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, price: 0.0077, change24h: 0.05, type: 'Native', amountUsd: 1e6 }, holderCount: 60620, dcaCount: 7, limitOrderCount: 0, totalUsd: 1e6, priceSeries: [] }
    const f = fake({ '/explorer/asset/0': asset, '/explorer/search': [] })
    const out = await call(inspect, { identifier: '0', kind: 'asset' }, f)
    expect(out.markdown).toContain('## Asset HDX (#0)')
    // The shared USD renderer, not a hand-rolled `$` + formatNumber: the same
    // price has to read identically here, in list_assets and in the network
    // status, or an agent sees two prices for one asset.
    // Spelled out rather than computed with the renderer under test: a shared
    // helper on both sides of the assertion moves together and proves nothing.
    expect(out.markdown).toContain('$0.0\u208177')
    expect(formatUsd(0.0077), 'the subscript-zero form is the shared renderer\u2019s').toBe('$0.0\u208177')
    expect(out.markdown).not.toContain('$0.0077')
  })

  it('says an unknown asset id is absent rather than rendering the null shell as fact', async () => {
    const shell = { asset: { assetId: 999999, symbol: '#999999', name: null, decimals: 12, price: null, amountUsd: 0 }, holderCount: 0, dcaCount: 0, totalUsd: 0, priceSeries: [] }
    const f = fake({ '/explorer/asset/999999': shell })
    const out = await call(inspect, { identifier: '999999', kind: 'asset' }, f)
    expect(out.markdown).toContain('is in the Hydration registry')
    expect(out.errors?.[0].code).toBe('NOT_FOUND')
  })

  it('reads height-index as an extrinsic, and as an event or a trade when kind says so', async () => {
    const routes = {
      '/explorer/extrinsic-at/100/2': EXTRINSIC,
      '/explorer/extrinsic-at/100/2/activity': [TRANSFER_ROW],
      '/explorer/event/100/2': { blockHeight: 100, eventIndex: 2, extrinsicIndex: null, timestamp: '2026-09-18 10:00:00', name: 'Omnipool.SellExecuted', phase: 'Finalization', extrinsic: null, args: { x: 1 } },
      '/explorer/trade/100/2': {
        blockHeight: 100, timestamp: '2026-09-18 10:00:00', extrinsicIndex: 2, eventIndex: 7, hash: HASH,
        success: true, who: ACTOR, venue: 'Omnipool', direction: 'Sell', assetIn: HDX,
        assetOut: { assetId: 222, symbol: 'HOLLAR', decimals: 18 }, amountIn: RAW_AMOUNT,
        amountOut: '7570000000000000000', valueUsd: 7.57, executionPrice: 0.00757, limit: null,
        extrinsicFee: RAW_AMOUNT, extrinsicTip: null, route: [],
      },
    }
    const asExtrinsic = fake(routes)
    expect((await call(inspect, { identifier: '100-2' }, asExtrinsic)).markdown).toContain('## Extrinsic Router.sell')

    const asEvent = fake(routes)
    expect((await call(inspect, { identifier: '100-2', kind: 'event' }, asEvent)).markdown).toContain('## Event Omnipool.SellExecuted')
    expect(asEvent.paths()).toContain('/explorer/event/100/2')

    const asTrade = fake(routes)
    expect((await call(inspect, { identifier: '100-2', kind: 'trade' }, asTrade)).markdown).toContain('## Trade — Sell HDX → HOLLAR')
  })

  it('resolves 0x + 64 hex through search: block hash, extrinsic hash, then AccountId32', async () => {
    const asBlock = fake({
      '/explorer/search': [{ type: 'block', value: '100' }],
      '/explorer/block/100': BLOCK, '/explorer/block/100/activity': [],
    })
    await call(inspect, { identifier: HASH }, asBlock)
    expect(asBlock.paths()).toContain('/explorer/block/100')

    const asExtrinsic = fake({
      '/explorer/search': [{ type: 'extrinsic', value: HASH }],
      [`/explorer/extrinsic/${HASH}`]: EXTRINSIC, [`/explorer/extrinsic/${HASH}/activity`]: [],
    })
    await call(inspect, { identifier: HASH }, asExtrinsic)
    expect(asExtrinsic.paths()).toContain(`/explorer/extrinsic/${HASH}`)

    // A 64-hex the upstream resolves to no hash is an AccountId32, and the
    // account reading is the compact one (`summary=1`).
    const asAccount = fake({
      '/explorer/search': [{ type: 'address', value: ACCOUNT_ID, label: SS58 }],
      [`/explorer/address/${ACCOUNT_ID}`]: ADDRESS,
    })
    await call(inspect, { identifier: ACCOUNT_ID }, asAccount)
    expect(asAccount.calls.find(c => c.path.startsWith('/explorer/address/'))?.query).toEqual({ summary: 1 })
  })

  it('reads an SS58 address as an account and an H160 as a contract', async () => {
    const asAccount = fake({ [`/explorer/address/${SS58}`]: ADDRESS })
    const account = await call(inspect, { identifier: SS58 }, asAccount)
    expect(account.markdown).toContain('## Account')
    expect(account.markdown).toContain('get_account')

    // `summary=1` drops the contract block, so an EVM address is read in full.
    const asContract = fake({
      '/explorer/search': [{ type: 'address', value: `0x45544800${H160.slice(2)}`, label: H160 }],
      [`/explorer/address/${H160}`]: {
        ...ADDRESS, evmAddress: H160,
        contract: { address: H160, verification: { status: 'verified', name: 'DIAOracleV2', compilerVersion: 'v0.8.19' }, codeSize: 3371, txCount: 60951 },
      },
    })
    const contract = await call(inspect, { identifier: H160 }, asContract)
    expect(contract.markdown).toContain('## Contract DIAOracleV2')
    expect(asContract.calls.find(c => c.path.startsWith('/explorer/address/'))?.query).toBeUndefined()
  })

  it('reads an H160 that is a Uniswap-v3 pool as the pool, with the account named as the other reading', async () => {
    const f = fake({
      '/explorer/search': [
        { type: 'pool', value: V3_POOL, label: 'aDOT / HOLLAR 0.3%', poolKind: 'uniswapv3', tvlUsd: 10755 },
        { type: 'address', value: `0x45544800${V3_POOL.slice(2)}`, label: V3_POOL },
      ],
      [`/explorer/pool/v3/${V3_POOL}`]: {
        kind: 'uniswapv3', address: V3_POOL, name: 'aDOT / HOLLAR 0.3%', feeTier: '0.3%',
        token0: { assetId: 1001, symbol: 'aDOT', decimals: 10 }, token1: { assetId: 222, symbol: 'HOLLAR', decimals: 18 },
        tvlUsd: 10755, swaps: 1071,
      },
    })
    const out = await call(inspect, { identifier: V3_POOL }, f)
    expect(out.markdown).toContain('## Pool aDOT / HOLLAR 0.3%')
    expect(out.markdown).toContain('"kind":"account"')
  })

  it('reads a bare symbol as the asset rather than the tag search lists first', async () => {
    const f = fake({
      // Resolution order puts tags before assets; an exact symbol still wins.
      '/explorer/search': [
        { type: 'tag', value: 'hdx-kraken-lp', label: 'HDX Kraken LP' },
        { type: 'asset', value: '0', label: 'HDX', desc: 'Hydration', asset: HDX },
      ],
      '/explorer/asset/0': { asset: { ...HDX, price: 0.0077, amountUsd: 1e6, type: 'Native' }, holderCount: 60620, dcaCount: 0, totalUsd: 1e6, priceSeries: [] },
    })
    const out = await call(inspect, { identifier: 'HDX' }, f)
    expect(out.markdown).toContain('## Asset HDX (#0)')
    expect(out.markdown).toContain('"identifier":"hdx-kraken-lp","kind":"tag"')
  })

  it('reads a pallet-qualified referendum, and always sends summary=1 for a tag', async () => {
    const asReferendum = fake({
      '/explorer/referendum/opengov/410': {
        pallet: 'opengov', index: 410, title: 'Reduce the weight cap', proposer: null, subsquareUrl: 'https://s.test/410',
        track: 1, proposalHash: null, proposalCall: null, status: 'ongoing', enactment: null,
        submittedAt: null, concludedAt: null, asset: HDX, onChainTally: null,
        directTally: { ayes: '0', nays: '0', rawAyes: '0', rawNays: '0', support: '0', ayeVoters: 0, nayVoters: 0, splitVoters: 0, voters: 0 },
        indirectTally: null, voters: [], votesShown: 0, votesTotal: 0, timeline: [], trackInfo: null,
        liveTally: { ayes: '1000000000000000', nays: '0', support: '500000000000000', electorate: null },
      },
    })
    const referendum = await call(inspect, { identifier: 'opengov/410' }, asReferendum)
    expect(referendum.markdown).toContain('## Referendum opengov #410')
    // The support definition is not the intuitive one and must travel with it.
    expect(referendum.markdown).toContain('AYE PLUS ABSTAIN')

    const asTag = fake({ '/explorer/tag/treasury': { tagId: 'treasury', name: 'Treasury', color: '', note: '', icon: '', members: [], balances: [], topAssets: [], portfolioUsd: 1, moneyMarket: [] } })
    await call(inspect, { identifier: 'treasury', kind: 'tag' }, asTag)
    expect(asTag.calls[0].query).toEqual({ summary: 1 })
  })

  it('reads an intent, a DCA schedule and one DCA execution', async () => {
    const asIntent = fake({ '/explorer/intent/33008562192747753225502851072109': {
      order: { intentId: '33008562192747753225502851072109', seq: 109, kind: 'swap', amountIn: RAW_AMOUNT, amountOut: '7570000000000000000', partial: true, blockHeight: 100, extrinsicIndex: 2, timestamp: '2026-09-18 10:00:00' },
      owner: ACTOR, assetIn: HDX, assetOut: { assetId: 222, symbol: 'HOLLAR', decimals: 18 },
      status: 'filled', filledIn: RAW_AMOUNT, filledOut: '7570000000000000000', fills: [], fillsTotal: 29,
      dca: null, limitPriceOutPerIn: '0.007575000000',
    } })
    expect((await call(inspect, { identifier: '33008562192747753225502851072109', kind: 'intent' }, asIntent)).markdown).toContain('## ICE intent #109')

    const asSchedule = fake({
      '/explorer/dca/30104': {
        scheduleId: 30104, who: ACTOR, createdAt: null, assetIn: HDX, assetOut: { assetId: 222, symbol: 'HOLLAR', decimals: 18 },
        direction: 'Sell', amountPer: RAW_AMOUNT, totalAmount: '0', amountPerUsd: 5.96, budgetUsd: null,
        period: 30, periodSeconds: 66, maxRetries: null, slippagePermill: null, minAmountOut: null, maxAmountIn: null,
        route: [], nextExecutionBlock: 200, fundingBalance: RAW_AMOUNT, status: 'active',
        executions: { count: 194000, failed: 83, attempts: 194083, totalIn: RAW_AMOUNT, totalOut: '7570000000000000000' },
        rows: [DCA_ROW],
      },
      '/explorer/stats': { headBlock: 100, finalizedBlock: 99, headTime: '2026-09-18 10:00:00', avgBlockSec: 2.7, nominalBlockSec: 2, transfers24h: 1, extrinsics24h: 1, activeAccounts24h: 1, hdxPrice: 0.0077 },
    })
    const schedule = await call(inspect, { identifier: '30104', kind: 'dca' }, asSchedule)
    expect(schedule.markdown).toContain('## DCA schedule #30104')
    // A zero total is an open-ended schedule, not a zero budget.
    expect(schedule.markdown).toContain('open-ended')

    // Reached by a swap leg's index (18): the API answers with the execution event
    // that follows it (19), and THAT is the identity the Explorer link carries.
    const asExecution = fake({ '/explorer/dca/exec/100/18': {
      scheduleId: 30104, status: 'executed', who: ACTOR, blockHeight: 100, timestamp: '2026-09-18 10:00:00',
      eventIndex: 19, extrinsicIndex: null, assetIn: HDX, assetOut: { assetId: 222, symbol: 'HOLLAR', decimals: 18 },
      amountIn: RAW_AMOUNT, amountOut: '7570000000000000000', valueUsd: 5.96, executionPrice: 6.13, period: 30, failureReason: null,
    } })
    const execution = await call(inspect, { identifier: '100-18', kind: 'dca' }, asExecution)
    expect(execution.markdown).toContain('DCA execution — schedule #30104')
    expect(execution.markdown).toContain('https://explorer.test/dca/100-e19')
    expect(execution.markdown).not.toContain('/dca/100-e18')
  })

  it('reads a cross-chain destination without ever naming its sentinel id', async () => {
    const f = fake({ '/explorer/xc-destination/zec': {
      destination: { platform: 'zec', oneClickId: 'zec', symbol: 'ZEC', name: 'Zcash', decimals: 8, chain: 'zec', chainName: 'Zcash', origin: { ecosystem: 'zcash', chainId: 'zec', assetId: 'ZEC' } },
      referencePrice: 1470, referenceSource: 'kraken', swapCount: 18, settledCount: 17,
      soldUsd: 60.7, deliveredUsd: 50.5, recipientCount: 4, firstAt: null, lastAt: null, soldAssets: [], recent: [],
    } })
    const out = await call(inspect, { identifier: 'zec', kind: 'xc-destination' }, f)
    expect(out.markdown).toContain('## Cross-chain destination ZEC (Zcash)')
    expect(out.markdown).toContain('never what a swap actually got')
  })

  it('refuses a kind the identifier cannot satisfy, before any upstream call', async () => {
    const f = fake({})
    const out = await call(inspect, { identifier: 'not-a-number', kind: 'block' }, f)
    expect(out.errors?.[0].code).toBe('INVALID_ARGUMENT')
    expect(f.calls).toHaveLength(0)
  })
})

/* ============ the two 404s ============ */

describe('a miss that can be retried and a miss that cannot', () => {
  const missBody = (blockIndexed: boolean) => new Miss(404, { error: 'not found', blockIndexed, headBound: 14_745_000 })

  it('calls a block above the index head NOT_YET_INDEXED and says to retry', async () => {
    const f = fake({ '/explorer/block/14746000': missBody(false), '/explorer/block/14746000/activity': missBody(false), '/explorer/search': [], '/explorer/asset/14746000': { asset: { assetId: 14746000, symbol: '#14746000', name: null, decimals: 12, price: null, amountUsd: 0 }, holderCount: 0, dcaCount: 0, totalUsd: 0, priceSeries: [] } })
    const out = await call(inspect, { identifier: '14746000' }, f)
    expect(out.errors?.[0].code).toBe('NOT_YET_INDEXED')
    expect(out.errors?.[0].message).toContain('retry')
  })

  it('calls a row inside an indexed block NOT_FOUND and does not suggest retrying', async () => {
    const f = fake({ '/explorer/extrinsic-at/100/99': missBody(true), '/explorer/extrinsic-at/100/99/activity': missBody(true) })
    const out = await call(inspect, { identifier: '100-99' }, f)
    expect(out.errors?.[0].code).toBe('NOT_FOUND')
    expect(out.errors?.[0].message).not.toContain('retry')
  })
})

/* ============ get_activity ============ */

describe('get_activity', () => {
  it('teaches the three traps, the type vocabulary and the per-type actions', () => {
    const d = activity.description
    expect(d).toContain('type=dca returns rows whose own type is "trade"')
    expect(d).toContain('type=trade is a FAMILY')
    expect(d).toContain('silently returns an empty page')
    for (const type of ['transfer', 'liquidity', 'mm', 'xcm', 'stake', 'vote', 'otc', 'bond', 'intent', 'xcswap']) {
      expect(d, `the type vocabulary must name ${type}`).toContain(type)
    }
    // The action values exist in no schema an agent can read.
    expect(d).toContain('otc-place')
    expect(d).toContain('LiquidationCall')
    expect(d).toContain('GIGAHDX Unstake')
    // And the bound that would otherwise arrive as a raw 400.
    expect(d).toContain('2,500')
  })

  it('renders a DCA row and a plain swap from one type=dca page as what each is', async () => {
    const f = fake({ '/explorer/activity': [DCA_ROW, PLAIN_SWAP_ROW] })
    const out = await call(activity, { type: 'dca', limit: 5 }, f)
    // The family selection returns both; the rendering must not call the plain
    // swap a DCA execution.
    expect(out.markdown).toContain('DCA execution · schedule #30104')
    expect(out.markdown).toContain('· Swap ·')
    expect(f.calls[0].query).toMatchObject({ type: 'dca' })
  })

  it('names the silent token filter when a page comes back empty', async () => {
    const f = fake({ '/explorer/activity': [] })
    const out = await call(activity, { type: 'mm', token: 'NOPE' }, f)
    expect(out.markdown).toContain('No classified activity matched')
    expect(out.markdown).toContain('An unrecognised `token` matches nothing upstream')
  })

  it('refuses an unknown action before the call, because upstream it is not an error', async () => {
    // Measured against the live route: on the global feed `type=trade` with an
    // unknown action spends ~45 s and answers 503 ACTIVITY_QUERY_TOO_BROAD; at
    // account scope it answers an ordinary empty page. Both read as something
    // other than "that is not an action", and the first burns shared capacity.
    const f = fake({ '/explorer/activity': [] })
    const out = await call(activity, { type: 'mm', action: 'NoSuchAction' }, f)
    expect(f.calls).toHaveLength(0)
    expect(out.errors?.[0].code).toBe('INVALID_ARGUMENT')
    expect(out.errors?.[0].message).toContain('not an action of type=mm')
    // The valid list travels with the refusal, since an agent cannot discover it.
    for (const action of ['Supply', 'Withdraw', 'Borrow', 'Repay']) {
      expect(out.errors?.[0].message).toContain(action)
    }
    expect(out.markdown).toBe('')
  })

  it('refuses an action with no type, which the upstream would silently ignore', async () => {
    // /explorer/activity?limit=3&action=nonsense answers three ordinary
    // transfers: the filter is dropped server-side, and echoing it as applied
    // tells a model those three rows matched it.
    const f = fake({ '/explorer/activity': [TRANSFER_ROW] })
    const out = await call(activity, { action: 'swap', limit: 3 }, f)
    expect(f.calls).toHaveLength(0)
    expect(out.errors?.[0].code).toBe('INVALID_ARGUMENT')
    expect(out.errors?.[0].message).toContain('IGNORES it')
  })

  it('accepts an action that is real for the type, including the dca family alias', async () => {
    const f = fake({ '/explorer/activity': [DCA_ROW] })
    const out = await call(activity, { type: 'dca', action: 'dca', limit: 5 }, f)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].query).toMatchObject({ type: 'dca', action: 'dca' })
    expect(out.markdown).toContain('action=dca')
  })

  it('refuses an inverted date window instead of reporting an empty chain', async () => {
    const f = fake({ '/explorer/activity': [] })
    const out = await call(activity, { from: '2026-09-18', to: '2020-01-01' }, f)
    expect(f.calls).toHaveLength(0)
    expect(out.errors?.[0].code).toBe('INVALID_ARGUMENT')
    expect(out.errors?.[0].message).toContain('inverted')
  })

  it('encodes every interpolated path parameter, so a crafted target cannot re-route the read', async () => {
    // Raw, `13b6…?limit=1` lands on a different endpoint whose answer is not an
    // activity array — and the feed then reports one of the busiest accounts on
    // the chain as having done nothing.
    const f = fake({ [`/explorer/address/${encodeURIComponent(`${SS58}?limit=1`)}/activity`]: [TRANSFER_ROW] })
    const out = await call(activity, { account: `${SS58}?limit=1` }, f)
    expect(f.paths()[0]).toContain('%3Flimit%3D1')
    expect(out.markdown).not.toContain('No classified activity matched')

    const tagged = fake({ [`/explorer/tag/${encodeURIComponent('a/b')}/activity`]: [TRANSFER_ROW] })
    await call(activity, { tag: 'a/b' }, tagged)
    expect(tagged.paths()[0]).toBe('/explorer/tag/a%2Fb/activity')
  })

  it('treats a non-array upstream answer as a failed read, never as an empty feed', async () => {
    const f = fake({ '/explorer/activity': { error: 'not a feed' } })
    const out = await call(activity, { limit: 5 }, f)
    expect(out.errors?.[0].code).toBe('INTERNAL_ERROR')
    expect(out.markdown).toBe('')
  })

  it('never presents a total row count and never asks for one', async () => {
    const f = fake({ '/explorer/activity': [TRANSFER_ROW] })
    // A full page is what invites a page count; there is none to give.
    const out = await call(activity, { limit: 1 }, f)
    expect(f.paths()).not.toContain('/explorer/activity/count')
    // Every phrasing a total would arrive in. The narrow `N results` form was
    // wording no renderer here has ever emitted, so it could not have failed.
    expect(out.markdown).not.toMatch(/\b\d[\d,]* (results?|rows?|matches|total)\b/i)
    expect(out.markdown).not.toMatch(/\bof \d[\d,]*\b/)
    expect(out.markdown).not.toMatch(/\b(page|showing) \d+ of \d+/i)
    expect(out.markdown).toContain('There is no total row count')
  })

  it('marks an unconfirmed row and never prints its placeholder block height', async () => {
    const f = fake({ '/explorer/activity': [MEMPOOL_ROW] })
    const out = await call(activity, { limit: 5 }, f)
    expect(out.markdown).toContain('**unconfirmed**')
    expect(out.markdown).toContain('TRANSACTION POOL')
    expect(out.markdown).toContain('zero placeholder')
    expect(out.markdown).not.toMatch(/block 0\b/)
    // Its only address is its hash, so the link is the extrinsic's.
    expect(out.markdown).toContain(`https://explorer.test/extrinsic/${HASH}`)
  })

  it('does not claim a row above the finalized head lacks a block height', async () => {
    // `isUnconfirmed` covers two different things. A row in a real block above
    // the finalized head has a REAL, quotable height; only a mempool row has the
    // zero placeholder, and one sentence for both makes the feed state a falsehood.
    const ahead = { ...TRANSFER_ROW, finalized: false, mempool: false, blockHeight: 14_747_843 }
    const f = fake({ '/explorer/activity': [ahead] })
    const out = await call(activity, { limit: 5 }, f)
    expect(out.markdown).toContain('**unconfirmed**')
    expect(out.markdown).toContain('REAL block')
    expect(out.markdown).toContain('genuine')
    expect(out.markdown).not.toContain('placeholder')
  })

  it('repeats the type=dca trap beside the rows it renders as "Swap"', async () => {
    const f = fake({ '/explorer/activity': [DCA_ROW, PLAIN_SWAP_ROW] })
    const out = await call(activity, { type: 'dca', limit: 5 }, f)
    expect(out.markdown).toContain('TRADE family')
    expect(out.markdown).toContain('DCA execution')
  })

  it('rejects an argument nobody declared rather than answering another question', async () => {
    // Only reachable on the direct-handler path: the MCP SDK validates against
    // its own z.object(shape) first and STRIPS unknown keys before a handler
    // runs, so over the protocol the typo is already gone. Pinned here so the
    // in-process contract stays strict.
    const f = fake({ '/explorer/activity': [TRANSFER_ROW] })
    const out = await call(activity, { accountId: SS58, limit: 3 }, f)
    expect(f.calls).toHaveLength(0)
    expect(out.errors?.[0].code).toBe('INVALID_ARGUMENT')
  })

  it('refuses an offset past its category ceiling before calling upstream', async () => {
    const wide = fake({ '/explorer/activity': [] })
    const wideOut = await call(activity, { offset: 2501 }, wide)
    expect(wideOut.errors?.[0].code).toBe('INVALID_ARGUMENT')
    expect(wideOut.errors?.[0].message).toContain('2,500')
    expect(wide.calls).toHaveLength(0)

    // A narrow category reaches 250,000 on the same route.
    const narrow = fake({ '/explorer/activity': [] })
    expect((await call(activity, { type: 'vote', offset: 2501 }, narrow)).errors).toBeUndefined()

    // An account feed carrying a min/identity window stops at 900,000; without
    // one it is located and reaches 5,000,000.
    const windowed = fake({ [`/explorer/address/${SS58}/activity`]: [] })
    const windowedOut = await call(activity, { account: SS58, minUsd: 10, offset: 900_001 }, windowed)
    expect(windowedOut.errors?.[0].message).toContain('900,000')
    expect(windowed.calls).toHaveLength(0)

    const located = fake({ [`/explorer/address/${SS58}/activity`]: [] })
    expect((await call(activity, { account: SS58, offset: 900_001 }, located)).errors).toBeUndefined()
  })

  it('routes each scope to its own upstream path and pages block scope itself', async () => {
    const account = fake({ [`/explorer/address/${SS58}/activity`]: [TRANSFER_ROW] })
    await call(activity, { account: SS58 }, account)
    expect(account.paths()).toEqual([`/explorer/address/${SS58}/activity`])

    const tag = fake({ '/explorer/tag/treasury/activity': [TRANSFER_ROW] })
    await call(activity, { tag: 'treasury' }, tag)
    expect(tag.paths()).toEqual(['/explorer/tag/treasury/activity'])

    const extrinsic = fake({ '/explorer/extrinsic-at/100/2/activity': [TRANSFER_ROW] })
    await call(activity, { extrinsic: '100-2' }, extrinsic)
    expect(extrinsic.paths()).toEqual(['/explorer/extrinsic-at/100/2/activity'])

    // A block answers whole and unpaged, so the tool pages it in process.
    const block = fake({ '/explorer/block/100/activity': [TRANSFER_ROW, DCA_ROW, PLAIN_SWAP_ROW] })
    const blockOut = await call(activity, { block: 100, limit: 1, offset: 1 }, block)
    expect(block.calls[0].query).toEqual({})
    expect(blockOut.markdown).toContain('DCA execution')
    expect(blockOut.markdown).toContain('1 of this block\'s 3 classified rows are still unread')
  })

  it('treats asset as a scope switch and says so, resolving a symbol to an id', async () => {
    const f = fake((path) => {
      if (path === '/explorer/search') return [{ type: 'asset', value: '0', label: 'HDX', asset: HDX }]
      if (path === '/explorer/activity') return [TRANSFER_ROW]
      return undefined
    })
    const out = await call(activity, { asset: 'HDX', limit: 2 }, f)
    expect(f.calls.find(c => c.path === '/explorer/activity')?.query).toMatchObject({ asset: 0 })
    expect(out.markdown).toContain('scope switch rather than a filter')
    expect(out.markdown).toContain("asset's FULL history")
  })

  it('refuses two scope targets at once', async () => {
    const f = fake({})
    const out = await call(activity, { account: SS58, tag: 'treasury' }, f)
    expect(out.errors?.[0].code).toBe('INVALID_ARGUMENT')
    expect(f.calls).toHaveLength(0)
  })
})

/* ============ what a rendering may never contain ============ */

describe('renderings state only what is true', () => {
  it('scales every amount and never prints a raw integer or an AccountId32', async () => {
    const f = fake({ '/explorer/activity': [TRANSFER_ROW, DCA_ROW, MEMPOOL_ROW] })
    const out = await call(activity, { limit: 5 }, f)
    expect(out.markdown).toContain('1.23 HDX')
    expect(out.markdown, 'a raw integer amount would read as a trillion tokens').not.toContain(RAW_AMOUNT)
    expect(out.markdown, 'an AccountId32 is a public key, not an address').not.toContain(ACCOUNT_ID)
    expect(out.markdown).toContain('13b6hR…p3hMN')
  })

  it('scales an account reading the same way', async () => {
    const f = fake({ [`/explorer/address/${SS58}`]: ADDRESS })
    const out = await call(inspect, { identifier: SS58 }, f)
    expect(out.markdown).toContain('1.23')
    expect(out.markdown).not.toContain(RAW_AMOUNT)
    expect(out.markdown).not.toContain(ACCOUNT_ID)
  })

  it('answers every tool with a json record that round-trips', async () => {
    const activityFake = fake({ '/explorer/activity': [TRANSFER_ROW] })
    const searchFake = fake({ '/explorer/search': [{ type: 'asset', value: '0', label: 'HDX', asset: HDX }] })
    const inspectFake = fake({ [`/explorer/address/${SS58}`]: ADDRESS })

    for (const out of [
      await call(activity, {}, activityFake),
      await call(search, { query: 'HDX' }, searchFake),
      await call(inspect, { identifier: SS58 }, inspectFake),
    ]) {
      const round = JSON.parse(JSON.stringify(out.json))
      expect(round).toBeTypeOf('object')
      expect(round).not.toBeNull()
    }
  })
})
