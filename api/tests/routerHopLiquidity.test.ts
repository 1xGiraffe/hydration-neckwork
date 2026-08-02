import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isRouterHopLiquidity } from '../src/services/explorerService.ts'

const ROUTER_EXECUTOR = '0x6d6f646c726f7574657265780000000000000000000000000000000000000000'
const TRADER = '0xeab1aee04b7618d3dd4ffee6556118a09622d06b52a407aca3447ca446baa933'
const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// The router executes a route hop through a stablepool by calling the pool's
// add_liquidity / remove_liquidity_one_asset, so the hop emits a Stableswap liquidity
// event for a trade the user never framed as liquidity provision. Chain-wide, 1.38M of
// the 1.41M Stableswap liquidity events in signed extrinsics are such hops.
describe('router-hop liquidity classification', () => {
  // Block 4,370,574 extrinsic 2: Router.buy HDX(0) → USDT(10) over
  // [Omnipool 0→100, Stableswap(100) 100→10]. The second hop drains the 4-Pool and
  // emitted Stableswap.LiquidityRemoved attributed to the TRADER, which the explorer
  // rendered as a standalone /remove-liquidity activity next to the real trade.
  it('treats a legacy trader-attributed hop through an intermediate share as plumbing', () => {
    expect(isRouterHopLiquidity('Stableswap.LiquidityRemoved', TRADER, 100, new Set([0, 10]))).toBe(true)
  })

  // The 2025 router attributes the hop to its own executor account, so no route context
  // is needed — and none is available when the pool share is the route's own endpoint.
  it('treats a module-attributed hop as plumbing regardless of the route', () => {
    expect(isRouterHopLiquidity('Stableswap.LiquidityRemoved', ROUTER_EXECUTOR, 111, new Set([1111, 222]))).toBe(true)
    expect(isRouterHopLiquidity('Stableswap.LiquidityAdded', ROUTER_EXECUTOR, 4200, undefined)).toBe(true)
  })

  // A direct remove_liquidity_one_asset is row-wise identical to a legacy hop; only the
  // absence of a router summary on the extrinsic tells them apart.
  it('keeps a real liquidity action that no route accompanies', () => {
    expect(isRouterHopLiquidity('Stableswap.LiquidityRemoved', TRADER, 100, undefined)).toBe(false)
    expect(isRouterHopLiquidity('Stableswap.LiquidityAdded', TRADER, 690, undefined)).toBe(false)
  })

  // Buying GDOT with DOT really does add liquidity: the share token is where the route
  // ends, not something minted and burned inside it. dropShareRoutedTrades drops the
  // mirroring share-legged trade, so suppressing this row too would lose the activity.
  it('keeps an add/remove whose share token is a route endpoint', () => {
    // The route names GDOT (69); the pool emits the 2-Pool-GDOT (690) share.
    expect(isRouterHopLiquidity('Stableswap.LiquidityAdded', TRADER, 690, new Set([5, 69]))).toBe(false)
    expect(isRouterHopLiquidity('Stableswap.LiquidityRemoved', TRADER, 100, new Set([100, 10]))).toBe(false)
  })

  // Only Stableswap add/remove doubles as a swap primitive. No XYK liquidity event and
  // no module-attributed Omnipool one shares an extrinsic with a router summary.
  it('never reclassifies Omnipool or XYK liquidity', () => {
    for (const name of ['Omnipool.LiquidityAdded', 'Omnipool.LiquidityRemoved', 'XYK.LiquidityAdded', 'XYK.LiquidityRemoved', 'XYK.PoolCreated']) {
      expect(isRouterHopLiquidity(name, ROUTER_EXECUTOR, 100, new Set([0, 10])), name).toBe(false)
    }
  })

  // Symmetry is the invariant AGENTS.md names: a hop hidden on the global feed but shown
  // on the block/extrinsic page is exactly the bug this fixes. Every liquidity_activity
  // read that renders or counts rows must apply the shared builder before its LIMIT.
  it('is applied by every liquidity_activity read that renders or counts rows', () => {
    expect((explorerService.match(/routerHopLiquiditySql\(/g) ?? []).length).toBeGreaterThanOrEqual(7)
    // The block/extrinsic builder holds the block's events already and uses the mirror.
    expect(explorerService).toContain('isRouterHopLiquidity(r.event_name, r.who, r.asset_id')
  })

  // The suppression has to be a SQL predicate, not a filter over finished pages: with
  // ~98% of Stableswap liquidity rows being hops, post-filtering would empty the pages
  // and leave the tab counts describing rows the feed cannot serve.
  it('filters before the LIMIT in the SQL reads', () => {
    const at = explorerService.indexOf('function routerHopLiquiditySql')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))
    expect(body).toContain('joinSql')
    expect(body).toContain('predicateSql')
    expect(body).toContain('price_data.swap_activity')
  })
})
