import type { FastifyInstance } from 'fastify'

// Explicit HTTP caching for the Data API. Same mechanism as the public
// surface's cacheControl.ts — first match wins, unmatched routes deliberately
// ship no-store, only 200/304 carry a TTL — with one deliberate difference:
// authenticated responses are `private, max-age=N`. There is NO nginx
// micro-cache in front of this service (a shared cache keyed on the URI alone
// is unsafe for authenticated responses, and per-user metering must see every
// request), so `private` tells any shared cache on the path the same thing;
// the response caches that DO collapse repeat work are the in-process ones,
// shared across users because all data here is public — the token is metering,
// not access control.
//
// The three unauthenticated surfaces (/v1/status, the OpenAPI document, the
// docs portal) are `public` and edge-cacheable.
type Visibility = 'public' | 'private'

export const DATA_CACHE_CONTROL: Array<[RegExp, number, Visibility]> = [
  [/^\/v1\/status$/, 3, 'public'],
  [/^\/openapi\.json$/, 60, 'public'],
  [/^\/docs/, 60, 'public'],

  // Chain core. Feeds track the head (3 s ≈ one block today); point reads are
  // immutable once indexed, so their TTL is only bounding cache churn.
  [/^\/v1\/blocks$/, 3, 'private'],
  [/^\/v1\/blocks\/[^/]+\/extrinsics$/, 10, 'private'],
  [/^\/v1\/blocks\/[^/]+\/events$/, 10, 'private'],
  [/^\/v1\/blocks\/[^/]+$/, 10, 'private'],
  [/^\/v1\/extrinsics$/, 3, 'private'],
  [/^\/v1\/extrinsics\/[^/]+\/events$/, 10, 'private'],
  [/^\/v1\/extrinsics\/[^/]+$/, 10, 'private'],
  [/^\/v1\/events$/, 3, 'private'],
  [/^\/v1\/events\/[^/]+$/, 10, 'private'],

  // Accounts. The live feeds poll-follow an account, so they take the same
  // short budget the explorer's own account feeds run on; the slow-moving
  // summaries and monthly fee folds hold longer.
  [/^\/v1\/accounts\/[^/]+\/balances\/history$/, 60, 'private'],
  [/^\/v1\/accounts\/[^/]+\/liquidity\/positions$/, 10, 'private'],
  [/^\/v1\/accounts\/[^/]+\/otc\/fills$/, 5, 'private'],
  [/^\/v1\/accounts\/[^/]+\/(balances|events|extrinsics|transfers|trades|dca|otc|liquidity|xcm|money-market)$/, 5, 'private'],
  [/^\/v1\/accounts\/[^/]+\/(staking|votes|liquidations)$/, 10, 'private'],
  [/^\/v1\/accounts\/[^/]+\/fees$/, 60, 'private'],
  [/^\/v1\/accounts\/[^/]+$/, 10, 'private'],

  // Assets & prices.
  [/^\/v1\/assets$/, 300, 'private'],
  [/^\/v1\/assets\/[^/]+\/price$/, 5, 'private'],
  [/^\/v1\/assets\/[^/]+\/candles$/, 10, 'private'],
  [/^\/v1\/assets\/[^/]+\/(transfers|swaps)$/, 5, 'private'],
  [/^\/v1\/assets\/[^/]+\/holders$/, 60, 'private'],
  [/^\/v1\/assets\/[^/]+$/, 60, 'private'],

  // Pools & trades.
  [/^\/v1\/pools$/, 10, 'private'],
  [/^\/v1\/pools\/(omnipool|stableswap|xyk)\/[^/]+\/history$/, 30, 'private'],
  [/^\/v1\/pools\/[^/]+\/[^/]+\/trades$/, 3, 'private'],
  [/^\/v1\/pools\/[^/]+\/[^/]+\/volumes$/, 60, 'private'],
  [/^\/v1\/trades$/, 3, 'private'],
  [/^\/v1\/dca\/schedules(\/[^/]+(\/executions)?)?$/, 5, 'private'],
  [/^\/v1\/otc\/orders(\/[^/]+(\/events)?)?$/, 5, 'private'],

  // Governance, staking, XCM, EVM.
  [/^\/v1\/governance\/referenda$/, 30, 'private'],
  [/^\/v1\/governance\/referenda\/[^/]+\/[^/]+(\/votes)?$/, 10, 'private'],
  [/^\/v1\/governance\/votes$/, 10, 'private'],
  [/^\/v1\/staking\/events$/, 60, 'private'],
  [/^\/v1\/xcm\/transfers$/, 5, 'private'],
  [/^\/v1\/evm\/transactions\/[^/]+$/, 10, 'private'],
  [/^\/v1\/evm\/contracts\/[^/]+\/logs$/, 5, 'private'],
  [/^\/v1\/evm\/contracts\/[^/]+\/abi$/, 300, 'private'],
  [/^\/v1\/evm\/contracts\/[^/]+$/, 60, 'private'],

  // Aggregates: all computed over closed windows or cached heavies.
  [/^\/v1\/stats\/(volume)$/, 60, 'private'],
  [/^\/v1\/stats\/(revenue|active-accounts|tvl)$/, 300, 'private'],
]

const CACHEABLE_STATUS = new Set([200, 304])

export function registerCacheControl(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    if (reply.getHeader('cache-control')) return
    const path = req.url.split('?')[0]
    const rule = CACHEABLE_STATUS.has(reply.statusCode)
      ? DATA_CACHE_CONTROL.find(([pattern]) => pattern.test(path))
      : undefined
    reply.header('cache-control', rule ? `${rule[2]}, max-age=${rule[1]}` : 'no-store')
  })
}
