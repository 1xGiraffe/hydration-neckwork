import { describe, expect, it } from 'vitest'
import { closingNetEvent, groupSwapRows, onBehalfActor, routeGroups, routeStartAfter, tradeRowKey, type RawSwapEventRow } from '../src/services/explorerService.ts'

// A swap event as the read model returns it — the feed reads them newest-first, so
// within an extrinsic the rows arrive in DESCENDING event order.
function ev(eventIndex: number, name: string, assetIn: number, assetOut: number, who = '0xuser', extrinsic: number | null = 3): RawSwapEventRow {
  return {
    block_height: 100, ts: '2026-07-28 16:26:00', event_index: eventIndex, extrinsic_index: extrinsic,
    event_name: name, who, asset_in: assetIn, asset_out: assetOut, amount_in: '1000', amount_out: '900',
  }
}
const ROUTER = '0x6d6f646c726f7574657265780000000000000000000000000000000000000000'
const keysOf = (rows: RawSwapEventRow[]) => groupSwapRows(rows).order
const groupsOf = (rows: RawSwapEventRow[]) => {
  const { groups, order } = groupSwapRows(rows)
  return order.map(k => groups.get(k)!.map(r => r.event_index))
}

// The router emits a route's hop events as it executes them and then its net
// summary, so a net event closes the run of hops before it. One extrinsic can
// dispatch several routes, and each one is a trade of its own.
describe('swap rows group per route, not per extrinsic', () => {
  it('keeps one route with its hops as a single trade', () => {
    const rows = [ev(137, 'Router.Executed', 5, 10, ''), ev(135, 'XYK.SellExecuted', 25, 10), ev(129, 'XYK.SellExecuted', 5, 25)]
    expect(groupsOf(rows)).toEqual([[137, 135, 129]])
  })

  // Hydration 13357986-3: a proxied multisig batch dispatching two Router.sells.
  // Grouping by extrinsic kept one and dropped the other — a $79.7k HUSDT swap that
  // appeared on no surface at all.
  it('splits a batch dispatching two routes into two trades', () => {
    const rows = [ev(67, 'Router.Executed', 1110, 222, ''), ev(42, 'Router.Executed', 1111, 222, '')]
    expect(groupsOf(rows)).toEqual([[67], [42]])
  })

  // Each hop belongs to the first net event at or after it, so a route never steals
  // the hops of the route before it.
  it('assigns every hop to the route that closes it', () => {
    const rows = [
      ev(145, 'Router.Executed', 10, 102, ''),
      ev(137, 'Router.Executed', 5, 10, ''),
      ev(135, 'XYK.SellExecuted', 25, 10),
      ev(129, 'XYK.SellExecuted', 5, 25),
    ]
    expect(groupsOf(rows)).toEqual([[145], [137, 135, 129]])
  })

  // A direct pool swap after the last route has no net event to close it, so it
  // stands alone rather than being folded into the route before it.
  it('keeps a trailing direct swap as its own trade', () => {
    const rows = [
      ev(157, 'Omnipool.SellExecuted', 102, 5),
      ev(145, 'Router.Executed', 10, 102, ''),
      ev(137, 'Router.Executed', 5, 10, ''),
      ev(135, 'XYK.SellExecuted', 25, 10),
      ev(129, 'XYK.SellExecuted', 5, 25),
    ]
    // The real arbitrage triangle from block 13,269,... : three trades, not one.
    expect(groupsOf(rows)).toEqual([[157], [145], [137, 135, 129]])
  })

  it('groups pallet-internal swaps by their own event, as before', () => {
    const rows = [ev(9, 'Omnipool.SellExecuted', 5, 10, ROUTER, null), ev(4, 'Omnipool.SellExecuted', 10, 5, ROUTER, null)]
    expect(keysOf(rows)).toEqual(['100:e9', '100:e4'])
  })

  // The feed's newest-first order must survive: groups appear in the order their
  // first row was seen, so a page's rows stay sorted as the query returned them.
  it('preserves the order the rows arrived in', () => {
    const rows = [ev(67, 'Router.Executed', 1110, 222, ''), ev(42, 'Router.Executed', 1111, 222, '')]
    expect(keysOf(rows)).toEqual(['100:x3:r67', '100:x3:r42'])
  })
})

// A swap dispatched through a proxy or a multisig moves the funds of the account the
// call ran AS, not of the signatory who submitted it. Hydration 13357986-3 was
// credited to a multisig signatory while the $341k account whose funds moved showed
// nothing.
describe('on-behalf attribution picks the account the call ran as', () => {
  it('prefers the innermost proxy, whose account owns the funds', () => {
    // Multisig.as_multi → Proxy.proxy(real=X): the batch executes with X's origin.
    expect(onBehalfActor({ proxies: [{ callAddress: '0', account: '0xreal' }], multisig: '0xms' })).toBe('0xreal')
    // Nested proxies: the deepest one is the origin the calls finally ran under.
    expect(onBehalfActor({ proxies: [{ callAddress: 'root', account: '0xouter' }, { callAddress: '0.0', account: '0xinner' }] })).toBe('0xinner')
  })

  it('falls back to the multisig when nothing was proxied', () => {
    expect(onBehalfActor({ multisig: '0xms' })).toBe('0xms')
  })

  it('reports nothing for an ordinary signed extrinsic', () => {
    expect(onBehalfActor({})).toBeUndefined()
    expect(onBehalfActor({ proxies: [] })).toBeUndefined()
  })

  it('ignores a blank account rather than attributing to it', () => {
    expect(onBehalfActor({ proxies: [{ callAddress: 'root', account: '' }], multisig: '0xms' })).toBe('0xms')
    expect(onBehalfActor({ multisig: '' })).toBeUndefined()
  })
})

// A link to a batch's second swap must open that swap, not its neighbour's. The
// detail slices one route out using the same boundaries the feed groups on, so the
// two can never disagree about where a route begins and ends.
describe('a route can be addressed inside a batch', () => {
  const nets = [42, 67]

  it('resolves an event to the route that closes it', () => {
    expect(closingNetEvent(nets, 42)).toBe(42)
    expect(closingNetEvent(nets, 30)).toBe(42)   // a hop before the first route
    expect(closingNetEvent(nets, 43)).toBe(67)
    expect(closingNetEvent(nets, 67)).toBe(67)
    expect(closingNetEvent(nets, 68)).toBeUndefined()  // trailing, no route closes it
  })

  it('starts a route after the one before it', () => {
    expect(routeStartAfter(nets, 42)).toBe(-1)
    expect(routeStartAfter(nets, 67)).toBe(42)
    expect(routeStartAfter([], 42)).toBe(-1)
  })

  // Hydration 13357986-3: /swap/13357986-e67 answered with event 42's HUSDT trade.
  it('slices the second route to its own events', () => {
    const inRoute = (idx: number) => idx > routeStartAfter(nets, 67) && idx <= 67
    expect([42, 58, 65, 67].filter(inRoute)).toEqual([58, 65, 67])
    const inFirst = (idx: number) => idx > routeStartAfter(nets, 42) && idx <= 42
    expect([33, 40, 42, 58, 67].filter(inFirst)).toEqual([33, 40, 42])
  })
})

// The surfaces that read one extrinsic's events — the extrinsic page, the block page —
// split its routes with the same rule the feed groups by, so a route is the same thing
// everywhere. They had their own copy that kept only the first route.
describe('one extrinsic\'s events split into its routes', () => {
  const e = (event_index: number, event_name: string) => ({ event_index, event_name })

  it('splits a two-route batch and keeps each route with its own hops', () => {
    const groups = routeGroups([
      e(33, 'XYK.SellExecuted'), e(42, 'Router.Executed'),
      e(58, 'XYK.SellExecuted'), e(67, 'Router.Executed'),
    ])
    expect(groups.map(g => g.map(x => x.event_index))).toEqual([[33, 42], [58, 67]])
  })

  it('keeps a single route whole', () => {
    const groups = routeGroups([e(129, 'XYK.SellExecuted'), e(135, 'XYK.SellExecuted'), e(137, 'Router.Executed')])
    expect(groups.map(g => g.map(x => x.event_index))).toEqual([[129, 135, 137]])
  })

  it('gives a trailing direct swap its own route', () => {
    const groups = routeGroups([e(137, 'Router.Executed'), e(157, 'Omnipool.SellExecuted')])
    expect(groups.map(g => g.map(x => x.event_index))).toEqual([[137], [157]])
  })

  it('is order-independent, since callers read events either way round', () => {
    const desc = routeGroups([e(67, 'Router.Executed'), e(58, 'XYK.SellExecuted'), e(42, 'Router.Executed')])
    expect(desc.map(g => g.map(x => x.event_index))).toEqual([[42], [58, 67]])
  })

  it('returns nothing for no events', () => {
    expect(routeGroups([])).toEqual([])
  })
})

// The deep USD-min fetch walks successive windows and dedups the rows it assembles.
// That key identified a trade by its EXTRINSIC, so the second route of a batch was
// deduped away again — /activity?min=5000 showed one of two $80k swaps.
//
// A route closed by a net event is identified by that event: stable however the
// fetch windows fall. A trailing run has no such anchor, and its representative
// shifts when a window splits the extrinsic, so it stays keyed per extrinsic —
// preferring one row over a duplicate, which is what the old key got right.
describe('the deep-fetch dedup key identifies a route', () => {
  const key = (o: { blockHeight: number; extrinsicIndex: number | null; eventIndex: number; venue: string }) => tradeRowKey(o)

  it('separates two routes of one extrinsic', () => {
    const a = key({ blockHeight: 100, extrinsicIndex: 3, eventIndex: 42, venue: 'Router' })
    const b = key({ blockHeight: 100, extrinsicIndex: 3, eventIndex: 67, venue: 'Router' })
    expect(a).not.toBe(b)
  })

  it('keeps one identity for a route however the window falls', () => {
    expect(key({ blockHeight: 100, extrinsicIndex: 3, eventIndex: 42, venue: 'Router' }))
      .toBe(key({ blockHeight: 100, extrinsicIndex: 3, eventIndex: 42, venue: 'Router' }))
  })

  it('collapses a trailing run per extrinsic, so a shifting rep cannot duplicate it', () => {
    const first = key({ blockHeight: 100, extrinsicIndex: 3, eventIndex: 51, venue: 'Omnipool' })
    const shifted = key({ blockHeight: 100, extrinsicIndex: 3, eventIndex: 49, venue: 'Omnipool' })
    expect(first).toBe(shifted)
  })

  it('keys a pallet-internal swap by its own event', () => {
    expect(key({ blockHeight: 100, extrinsicIndex: null, eventIndex: 9, venue: 'Omnipool' })).toBe('100:e9')
  })
})
