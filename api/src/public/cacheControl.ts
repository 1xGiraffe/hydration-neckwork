import type { FastifyInstance } from 'fastify'

// Explicit HTTP caching for the public surface, aligned with each endpoint's
// internal freshness window (spec: "Caching"). The nginx sidecar keys its
// micro-cache on the request URI and honors these headers for entry lifetime, so
// N clients polling the same endpoint collapse to at most one upstream request
// per max-age — the same mechanism the explorer's proxy uses.
//
// First match wins, so more specific patterns come first.
//
// EVERY TTL HERE IS WALL CLOCK and none of them changes with the chain's block
// time, so a move from 6 s to 2 s blocks leaves this table correct as written.
// What it does change is what a TTL BUYS: the short entries (`/v1/status` 3 s,
// `/dexscreener/latest-block` 3 s, `/v1/trades` 3 s) are sized to be inside one
// block today, and at 2 s they span one to two blocks instead — a poller sees the
// head advance in steps rather than continuously. Tightening them is a
// migration-day decision with a measurable cost (each is a per-block recompute on
// a `liveFeedTag`-style key), so the values are left as they are and the choice is
// recorded here rather than pre-empted: revisit the sub-10 s entries when the
// cadence actually changes, and leave the rest, which are sized against a
// consumer's poll interval or a computation's cost and are cadence-independent.
export const PUBLIC_CACHE_CONTROL: Array<[RegExp, number]> = [
  [/^\/rest\/service\/(health|metadata)$/, 5],
  [/^\/v1\/status$/, 3],
  [/^\/v1\/assets$/, 300],
  [/^\/v1\/accounts\/balances$/, 3],
  [/^\/v1\/accounts\/[^/]+\/balance-history$/, 60],
  [/^\/v1\/accounts\/[^/]+\/money-market-events$/, 5],
  // The fees page's drop-in. Its consumer polls with a one-hour staleTime and the
  // underlying money-market history view costs ~1.1 s whatever the window, so a
  // 5-minute shared entry collapses a page load's seven parallel streams and every
  // repeat visit onto one computation each.
  [/^\/api\/v1\/fees\/charts$/, 300],
  // The two other inherited facades, matching the TTLs their incumbents held in
  // Redis: the homepage stats are a 10-minute figure whose 30-day volume fold and
  // Ocelloids call are both far too heavy to repeat per visitor, and the lending
  // caps are watched while a borrow is placed.
  [/^\/hydration-web\/v1\/stats$/, 600],
  [/^\/lending\/v1\/caps$/, 60],
  // Anchored to the routes that exist rather than left as prefixes: a future
  // /v1/trades-export or /v1/dca/schedules/:id/foo must fall through to the
  // no-store default and declare its own freshness, not inherit these.
  [/^\/v1\/trades(\/routed)?$/, 3],
  // A transaction toast polls one extrinsic hash until it is final, so the entry
  // must expire inside a poll interval or the toast shows a stale "pending" for
  // longer than the block it is waiting for. Both extrinsic shapes — hash and
  // (blockHeight, index) — share the TTL because they answer the same question.
  [/^\/v1\/extrinsics\/[^/]+(\/[^/]+)?$/, 10],
  // An OTC order row is watched while a fill is expected; 5 s is the same "watch
  // it change" budget the money-market event feed takes.
  [/^\/v1\/otc\/orders\/[^/]+$/, 5],
  // The staking streams move once per reward accrual (~every 1,200 blocks), so a
  // minute is well inside one update and collapses a dashboard's re-reads.
  [/^\/v1\/staking\/events$/, 60],
  // The GIGAHDX rate moves when a reward pool is allocated (~daily) and drifts
  // only with its windows otherwise, so five shared minutes cost nothing in
  // freshness and collapse every dashboard onto one computation.
  [/^\/v1\/staking\/gigahdx\/apr$/, 300],
  [/^\/v1\/dca\/schedules(\/count|\/[^/]+\/executions)?$/, 3],
  [/^\/v1\/prices\/pair$/, 5],
  [/^\/v1\/pools\/[^/]+\/volumes$/, 60],
  [/^\/v1\/pools\/[^/]+\/yield$/, 600],
  // The DexScreener adapter. Its poller wants the head almost live, treats asset
  // and pair metadata as near-static, and re-reads a block window only while it
  // catches up — so the event TTL is short enough that a repeated window is
  // fresh and long enough that a backfilling crawler collapses onto the sidecar.
  [/^\/dexscreener\/latest-block$/, 3],
  [/^\/dexscreener\/(asset|pair)$/, 60],
  [/^\/dexscreener\/events$/, 15],
  [/^\/v1\/stats\/platform$/, 60],
  // The CoinGecko facade. Tickers match the incumbent feed's 10-minute Redis TTL
  // in spirit but far tighter, because the value is computed on demand here; the
  // supply figures move slowly and are polled per token.
  [/^\/coingecko\/v1\/tickers$/, 60],
  [/^\/coingecko\/v1\/totalsupply\/[^/]+$/, 300],
  // The DefiLlama facade. The rolling total tracks the 24h window's own
  // freshness; a backfill range is closed calendar days that cannot change, so
  // it is held for an hour — the endpoint's own chunk cache keeps a repeat
  // request free for a day beyond that.
  [/^\/defillama\/v1\/volume$/, 60],
  [/^\/defillama\/v1\/backfill$/, 3600],
  // Documentation surface, not data: the OpenAPI document and the Swagger UI
  // change only on deploy, and a short TTL keeps the sidecar from re-fetching
  // them per reader.
  [/^\/openapi\.json$/, 60],
  [/^\/docs/, 60],
  // Deliberately absent: /proxy/*. Those responses are cached in-process per
  // upstream, so they fall through to no-store and never enter a shared cache.
]

// `no-store` for every unmatched GET 200 is the deliberate default: a new route
// that forgets its entry above ships uncached instead of inheriting a neighbour's
// TTL. Error responses are never cached either — a 404/429/500 must not be held
// by the sidecar in front of a route that starts working.
//
// 304 carries the route's max-age like its 200 does: a revalidated response is
// the cache entry being refreshed, so labelling it `no-store` would tell the
// client to drop the very body it just confirmed is still current, turning every
// expiry into a full re-transfer.
const CACHEABLE_STATUS = new Set([200, 304])

export function registerCacheControl(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    if (reply.getHeader('cache-control')) return
    const path = req.url.split('?')[0]
    const rule = CACHEABLE_STATUS.has(reply.statusCode)
      ? PUBLIC_CACHE_CONTROL.find(([pattern]) => pattern.test(path))
      : undefined
    reply.header('cache-control', rule ? `public, max-age=${rule[1]}` : 'no-store')
  })
}
