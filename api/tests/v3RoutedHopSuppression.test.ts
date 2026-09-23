import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { v3RoutedKey } from '../src/services/explorerService.ts'

const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// A v3 Swap log inside a Router route is that route's hop, not a second trade. The
// route already renders one row (swap_activity's Router.Executed), so admitting the
// log too shows one fill twice — and it did, for every route executed from a block
// HOOK rather than an extrinsic.
//
// Runtime 443's DCA intents settle in a hook: their events carry a null
// extrinsic_index, and so does the pool log. The suppression keyed on
// (block, extrinsic) and skipped any act without an extrinsic, so those hops were
// never even tested — the global feed showed the hop beside the route while the
// block page, which filters differently, showed only the route. That is the
// classification asymmetry AGENTS.md forbids across surfaces.
describe('v3 routed-hop suppression is null-safe', () => {
  it('keys a hookless act on a sentinel rather than dropping it', () => {
    expect(v3RoutedKey(14912059, 2)).toBe('14912059:2')
    // Null collapses onto the sentinel uniswap_v3_legs already uses, on BOTH sides
    // of the join: SQL's null never equals null, so an un-sentinelled tuple matches
    // nothing at all and every hop survives.
    expect(v3RoutedKey(14912059, null)).toBe('14912059:4294967295')
  })

  it('tests every swap act for being routed, not only the extrinsic-indexed ones', () => {
    // The bug was a filter, not a query: acts without an extrinsic never reached
    // the lookup, so no amount of fixing the SQL alone would have helped.
    expect(src).toContain("routedV3SwapExtrinsics(acts.filter(a => a.kind === 'swap').map(a => [a.blockHeight, a.extrinsicIndex]))")
    expect(src).not.toContain("a.kind === 'swap' && a.extrinsicIndex != null")
  })

  it('collapses null on the SQL side too, so the tuple can match a hookless route', () => {
    expect(src).toContain('(block_height, ifNull(extrinsic_index, ${NO_EXTRINSIC})) IN (${tuples})')
    expect(src).toContain('const NO_EXTRINSIC = 4294967295')
  })

  it('suppresses by the shared key on both sides of the comparison', () => {
    expect(src).toContain("if (a.kind === 'swap' && routed.has(v3RoutedKey(a.blockHeight, a.extrinsicIndex))) continue")
  })

  // The pool's own page is the one reading where a routed hop is NOT plumbing: it
  // is a swap in that pool whatever routed it. Suppressing it there emptied the
  // page of the only live v3 pool entirely.
  it('keeps routed hops on the pool page, and only there', () => {
    expect(src).toContain('const rows = await v3ActivityRows(acts, prices, true)')
    // The feed path keeps the default, so a hop stays suppressed everywhere else.
    expect(src).toContain('let rows = await v3ActivityRows(acts, prices)')
    expect(src).toContain('keepRoutedHops ? new Set<string>() : routedV3SwapExtrinsics(')
  })
})

// On the pool page a routed hop is kept, and it must name the account whose route
// it was. The pool's Swap log names only contracts — its recipient on a routed hop
// is the router's own account — so a row built from the log alone credited every
// swap in the pool to "Pallet Pot" (all 25 rows of it).
describe('a kept routed hop names its owner, not the router', () => {
  it('matches the owner off the Swapped3 leg the same hop emitted', () => {
    expect(src).toContain("JSONExtractString(args_json, 'swapper') AS swapper")
    expect(src).toContain("JSONExtractString(args_json, 'fillerType', '__kind') = 'UniswapV3'")
  })

  // Block + extrinsic is not enough: these routes run in a hook, so several share
  // one block with a null extrinsic. The input amount is what tells them apart —
  // the same key uniswap_v3_legs already matches on.
  it('keys on the input amount, not the block alone', () => {
    expect(src).toContain('out.set(`${v3RoutedKey(r.block_height, r.extrinsic_index)}:${r.amount_in}`, r.swapper)')
    expect(src).toContain('routedSwappers.get(`${v3RoutedKey(a.blockHeight, a.extrinsicIndex)}:${a.amountIn}`)')
  })

  it('prefers the route owner over the log recipient', () => {
    expect(src).toContain('const who = routedWho ?? a.whoAccountId ??')
  })

  // Everywhere but the pool page the hop is suppressed, so the lookup is wasted.
  it('only runs the lookup where routed hops are kept', () => {
    expect(src).toContain('keepRoutedHops ? routedV3Swappers(acts) : Promise.resolve(new Map<string, string>())')
  })
})
