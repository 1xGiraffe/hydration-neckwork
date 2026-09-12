import { describe, expect, it } from 'vitest'
import { suppressXcswapPlumbingRows, XCSWAP_EMITTER_ACCOUNT, type ActivityRow } from '../src/services/explorerService.ts'

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
const bridgeLeg = row({ type: 'xcm', who: { accountId: XCSWAP_EMITTER_ACCOUNT } as NonNullable<ActivityRow['who']>, asset: WETH, amount: '808310000000000' })

describe('suppressXcswapPlumbingRows', () => {
  it('folds the Router sell and the NTT settlement behind the swap', () => {
    const out = suppressXcswapPlumbingRows([swap, routerLeg, bridgeLeg])
    expect(out.map(r => r.type)).toEqual(['xcswap'])
  })

  it('keeps every leg on a surface that asks how the order executed', () => {
    // The block and extrinsic pages pass keepPot, exactly as they do for the ICE pot.
    expect(suppressXcswapPlumbingRows([swap, routerLeg, bridgeLeg], true)).toHaveLength(3)
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
