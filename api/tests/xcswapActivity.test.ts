import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'
import {
  activityTypeMatchesFamily, adoptOrphanXcswapLegs, initExplorerService, suppressXcswapPlumbingRows, xcswapRowFromOrder,
  XCSWAP_EMITTER_ACCOUNT, type ActivityRow,
} from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// A cross-chain swap is ONE user action carried out by two on-chain legs: the
// Router sells the caller's asset for WETH, and the NTT rail settles that WETH to
// Ethereum. Both used to render as rows of their own — the trade attributed to the
// caller, the bridge to the contract — so a single swap read as two unrelated
// events, and its dollar value was counted twice.

const row = (r: Partial<ActivityRow>): ActivityRow => ({
  blockHeight: 100, timestamp: '2026-09-10T12:04:36.000Z', eventIndex: 1, extrinsicIndex: 2,
  who: null, to: null, asset: null, assetIn: null, assetOut: null,
  amount: null, amountIn: null, amountOut: null, valueUsd: null,
  ...r,
} as ActivityRow)

const aUSDC = { assetId: 1003, symbol: 'aUSDC', decimals: 6 } as NonNullable<ActivityRow['assetIn']>
const WETH = { assetId: 20, symbol: 'WETH', decimals: 18 } as NonNullable<ActivityRow['assetIn']>

const swap = row({ type: 'xcswap', assetIn: aUSDC, amountIn: '2000000', xcswapDestSymbol: 'ZEC' })
// The Router sell the emitter dispatched: same extrinsic, same asset in, same amount in.
const routerLeg = row({ type: 'trade', assetIn: aUSDC, amountIn: '2000000', assetOut: WETH, amountOut: '808316798348126' })
// The NTT settlement, whose actor is the emitter contract.
const bridgeLeg = row({ type: 'xcm', who: { accountId: XCSWAP_EMITTER_ACCOUNT } as NonNullable<ActivityRow['who']>, xcmDir: 'out', asset: WETH, amount: '808310000000000' })

describe('suppressXcswapPlumbingRows', () => {
  it('folds the Router sell and the NTT settlement behind the swap', () => {
    const out = suppressXcswapPlumbingRows([swap, routerLeg, bridgeLeg])
    expect(out.map(r => r.type)).toEqual(['xcswap'])
  })

  // There is deliberately no surface that keeps these legs. The extrinsic and block pages
  // used to, on the ICE pot's `keepPot` switch, and it read as an unrelated fee swap plus
  // a Wormhole send by a contract — neither naming the destination nor the asset bought.
  // An ICE settlement trade is a distinct on-chain action by a distinct actor and still
  // takes keepPot; these two are mechanics of the row beside them and never do.
  it('folds the legs on every surface, with no opt-out', () => {
    expect(suppressXcswapPlumbingRows([swap, routerLeg, bridgeLeg]).map(r => r.type)).toEqual(['xcswap'])
    expect(suppressXcswapPlumbingRows.length, 'a keepPot-style escape hatch came back').toBe(1)
    const fold = explorerService.slice(explorerService.indexOf('async function suppressActivityPlumbing'))
    expect(fold.slice(0, 600)).toContain('suppressXcswapPlumbingRows(await adoptOrphanXcswapLegs(suppressIcePotSettlementTrades(')
    // The ICE pot keeps its switch; only the xcswap call lost one.
    expect(fold.slice(0, 600)).toContain('suppressSubordinateActivityRows(rows), opts.keepPot)')
  })

  // keepPot keeps the legs BESIDE the swap — it cannot put the swap there. A cross-chain
  // swap is the one activity with no event of its own in raw_events (the order is
  // reconstructed off-chain), so the extrinsic page, which builds from events, has to
  // read it separately. It did not, and rendered the two legs with the action they serve
  // missing: /extrinsic/14326094-3 showed a fee swap and a Wormhole send but no swap.
  it('sources the swap row on the extrinsic page, so the legs have one to fold into', () => {
    const build = explorerService.slice(explorerService.indexOf('export async function getExtrinsicActivity'))
    const body = build.slice(0, build.indexOf('export async function getBlockActivity'))
    const push = body.indexOf('xcswapRowsAt(height, index)')
    // The CALL, not the several comments that name it earlier in this function.
    const suppress = body.indexOf('await suppressActivityPlumbing(rows.filter')
    expect(suppress, 'the extrinsic page folding call moved').toBeGreaterThan(-1)
    expect(push, 'the extrinsic page never reads the xcswap source').toBeGreaterThan(-1)
    // Pushed into the row set BEFORE the page folds plumbing. The fold is keyed on the
    // swap row itself, so a swap added afterwards would leave both legs standing.
    expect(push).toBeLessThan(suppress)
    // The page still keeps the ICE pot's settlement trades; only the swap legs go.
    expect(body.slice(suppress)).toContain('keepPot: true')
  })

  // The block page is composed from the extrinsic page, so it inherits the same row
  // rather than needing its own reader — asserted so a refactor that stops composing
  // them has to make the block page's own source explicit.
  it('lets the block page inherit the swap through the extrinsic page', () => {
    const block = explorerService.slice(explorerService.indexOf('export async function getBlockActivity'))
    expect(block.slice(0, 2000)).toContain('getExtrinsicActivity(height, i)')
  })

  it('leaves rows alone when no swap is in the page', () => {
    const out = suppressXcswapPlumbingRows([routerLeg, bridgeLeg])
    expect(out).toHaveLength(2)
  })

  it('keeps an unrelated trade batched into the same extrinsic', () => {
    // The leg is matched on the ORDER'S OWN (asset in, amount in), not on "a trade
    // in this extrinsic": a batch that placed an order alongside a different swap
    // must keep the different one, or the fold eats a real trade.
    const unrelated = row({ type: 'trade', assetIn: aUSDC, amountIn: '5000000', assetOut: WETH, amountOut: '1' })
    const out = suppressXcswapPlumbingRows([swap, routerLeg, unrelated])
    expect(out.map(r => r.amountIn)).toEqual(['2000000', '5000000'])
    expect(out.map(r => r.type)).toEqual(['xcswap', 'trade'])
  })

  it('keeps a bridge leg from another extrinsic, and one the emitter did not send', () => {
    const otherExtrinsic = row({ ...bridgeLeg, extrinsicIndex: 7 })
    const someoneElse = row({ type: 'xcm', who: { accountId: `0x${'ab'.repeat(32)}` } as NonNullable<ActivityRow['who']>, asset: WETH, amount: '1' })
    const out = suppressXcswapPlumbingRows([swap, otherExtrinsic, someoneElse])
    expect(out).toHaveLength(3)
  })

  it('never folds a leg that cannot be tied to an extrinsic', () => {
    // A row with no extrinsic index has no identity to match on; folding it would
    // be guessing which order it belonged to.
    const looseLeg = row({ ...routerLeg, extrinsicIndex: null })
    const out = suppressXcswapPlumbingRows([swap, looseLeg])
    expect(out).toHaveLength(2)
  })

  it('folds across several swaps in one page without crossing them', () => {
    const second = row({ blockHeight: 200, type: 'xcswap', assetIn: aUSDC, amountIn: '3000000' })
    const secondLeg = row({ blockHeight: 200, type: 'trade', assetIn: aUSDC, amountIn: '3000000', assetOut: WETH, amountOut: '2' })
    // Same amount as the first swap, but a block it was never placed in.
    const strayLeg = row({ blockHeight: 300, type: 'trade', assetIn: aUSDC, amountIn: '2000000', assetOut: WETH, amountOut: '3' })
    const out = suppressXcswapPlumbingRows([swap, routerLeg, second, secondLeg, strayLeg])
    expect(out.map(r => `${r.type}@${r.blockHeight}`)).toEqual(['xcswap@100', 'xcswap@200', 'trade@300'])
  })
})

// What the row does NOT say. `placeOrder` sells the caller's asset for WETH and
// bridges that WETH to an ETHEREUM deposit address, where a solver buys the
// destination asset. So the WETH is the last hop of a route — the Router sell
// that produces it is already folded away as plumbing — and it lands on neither
// the chain the caller started on nor the one the swap is going to. A row that
// names it invites the reader to think the swap delivered WETH to NEAR.
// A feed that loads the NTT leg but not the swap — the Cross-chain filter, the WETH
// page, the emitter's own account page — showed /extrinsic/14865831-2 as a Wormhole
// send by a proxy contract. The swap's row now stands in for the orphaned leg.
describe('adoptOrphanXcswapLegs', () => {
  const order = {
    block_height: 100, event_index: 7, extrinsic_index: 2, ts: '2026-09-10 12:04:36',
    transfer_sequence: '96', deposit_address: '0xe591373ec7f98038d13356415285e7aa8b48c0b1', caller: '0xb3bab5257a26eb6444f85706133bb2e06f422d2f',
    caller_account_id: '0x45544800b3bab5257a26eb6444f85706133bb2e06f422d2f0000000000000000', asset_in: 1003, amount_in: '2000000', eth_out: '808310000000000', max_relay_fee: '1',
  }
  const fakeClient = (queries: string[]) => ({
    query: async ({ query }: { query: string }) => {
      queries.push(query)
      return { json: async () => (query.includes('xcswap_orders') ? [order] : []) }
    },
  }) as unknown as ClickHouseClient

  it('stands the swap in for a leg loaded without it, and the fold then drops the leg', async () => {
    const queries: string[] = []
    initExplorerService(fakeClient(queries))
    const other = row({ type: 'transfer', blockHeight: 99, extrinsicIndex: 1 })
    const out = suppressXcswapPlumbingRows(await adoptOrphanXcswapLegs([bridgeLeg, other]))
    expect(out.map(r => r.type)).toEqual(['xcswap', 'transfer'])
    expect(out[0].who?.accountId).toBe(order.caller_account_id)
  })

  // The Cross-chain filter is where the leg is loaded without the swap, and it is
  // applied after the plumbing pass: an adopted swap the filter then dropped left
  // the swap missing from that feed altogether.
  it('keeps the adopted swap through the Cross-chain and the Trade filters alike', async () => {
    initExplorerService(fakeClient([]))
    const folded = suppressXcswapPlumbingRows(await adoptOrphanXcswapLegs([bridgeLeg]))
    expect(folded.filter(r => activityTypeMatchesFamily(r.type, 'xcm')).map(r => r.type)).toEqual(['xcswap'])
    expect(folded.filter(r => activityTypeMatchesFamily(r.type, 'trade')).map(r => r.type)).toEqual(['xcswap'])
    expect(folded.filter(r => activityTypeMatchesFamily(r.type, 'transfer'))).toEqual([])
  })

  // On an asset page the row shows only the asset sold, so a swap that sold
  // something else does not belong there; its WETH leg is the route's plumbing.
  it('adopts on an asset page only a swap that sold that asset, and drops the leg elsewhere', async () => {
    initExplorerService(fakeClient([]))
    const other = row({ type: 'transfer', blockHeight: 99, extrinsicIndex: 1 })
    expect((await adoptOrphanXcswapLegs([bridgeLeg, other], { assetId: WETH.assetId })).map(r => r.type)).toEqual(['transfer'])
    expect((await adoptOrphanXcswapLegs([bridgeLeg], { assetId: aUSDC.assetId })).map(r => r.type)).toEqual(['xcswap'])
  })

  it('reads nothing when the swap is already in the page or no leg is', async () => {
    const queries: string[] = []
    initExplorerService(fakeClient(queries))
    expect(await adoptOrphanXcswapLegs([swap, bridgeLeg])).toEqual([swap, bridgeLeg])
    expect(await adoptOrphanXcswapLegs([routerLeg])).toEqual([routerLeg])
    expect(queries.filter(q => q.includes('xcswap_orders'))).toEqual([])
  })
})

describe('xcswapRowFromOrder', () => {
  const order = {
    block_height: 14802880, event_index: 105, extrinsic_index: 2, ts: '2026-09-19 21:48:42',
    transfer_sequence: 92, deposit_address: '0xf9eab10f000959fa98a1779ddb95e5dc928a85a3',
    caller: '0x336f25787ee2bfb521e49eeb9b006abdc8397650',
    caller_account_id: '0x45544800336f25787ee2bfb521e49eeb9b006abdc83976500000000000000000',
    asset_in: 1000766, amount_in: '29742734',
    eth_out: '11298990000000000', max_relay_fee: '44986875212342',
  }

  it('states what was put in, and keeps the bridged WETH off the row', () => {
    const r = xcswapRowFromOrder(order, new Map(), null)
    expect(r.assetIn?.assetId).toBe(1000766)
    expect(r.amountIn).toBe('29742734')
    // The economic action is USDC in, destination asset out — never USDC → WETH.
    expect(r.assetOut).toBeNull()
    expect(r.amountOut).toBeNull()
    // Still carried for the detail surfaces that trace the bridge itself.
    expect(r.xcswapEthOut).toBe('11298990000000000')
  })

  it('references only the asset sold, like the route hops it already folds', () => {
    const r = xcswapRowFromOrder(order, new Map(), null)
    // A WETH filter no more returns these than it returns the other six hops.
    expect(r.assetRefs).toEqual([1000766])
  })

  it('leaves the destination unstated until the sweep resolves it', () => {
    const r = xcswapRowFromOrder(order, new Map(), null)
    // Never a guessed destination, and never a zero standing in for the amount.
    expect(r.xcswapDestSymbol).toBeNull()
    expect(r.xcswapDestAmount).toBeNull()
    expect(r.xcswapStatus).toBeNull()
  })
})
