// The allow-listed upstream passthrough table behind /proxy/*.
//
// This exists for host compatibility: a consumer pointed at the Hydration data
// lake reaches third-party APIs through its proxy handlers
// (`indexers/liquidity-pools/src/apiSupport/api/rest/proxyApiHandlers/` in
// galacticcouncil/hydration-data-lake), so the same request paths must reach the
// same upstreams here. Each entry below records the data-lake handler it mirrors.
//
// Two properties this table is shaped to guarantee, which the data-lake handlers
// only partly had:
//   * A request path is a whole-string match against an anchored pattern whose
//     character classes admit no '.', '@', '%' or '/', so no allow-listed path
//     can be extended, traversed out of, or used to move the target host. The
//     upstream URL is BUILT from the pattern's capture groups rather than by
//     concatenating caller-supplied text onto a base.
//   * Nothing in the request except the path and the query string reaches the
//     upstream. Every upstream here is read-only, keyless and called
//     anonymously — no credential of ours and none of the caller's is ever sent.

export type ProxyUpstreamName = 'defillama' | 'kamino' | 'subsquare'

export interface ProxyUpstream {
  name: ProxyUpstreamName
  // Upstream origin and path, as a template: `{1}`…`{n}` interpolate the capture
  // groups of the matched `allow` entry, in order. The whole upstream path comes
  // from the template — nothing from the request is appended to it, which is what
  // keeps an allow-listed prefix from being a prefix of something else. Defillama
  // puts a path segment in the HOSTNAME (`yields/…` -> yields.llama.fi), exactly
  // as the data-lake handler does, so a plain string prefix could not express it.
  base: string
  // Path allow-list, relative to `/proxy/<name>/` and matched against the whole
  // remaining path. Every pattern's capture-group count equals the template's
  // placeholder count (pinned by tests/public/proxy.test.ts).
  allow: RegExp[]
  ttlMs: number
  // One line for the published OpenAPI description.
  docs: string
}

// Upstream calls are bounded: a hung third party must not hold a public request
// open, and the in-process cache means a timeout costs one caller, not all of them.
export const UPSTREAM_TIMEOUT_MS = 10_000

export const PROXY_UPSTREAMS: ProxyUpstream[] = [
  {
    // data-lake: resources/defillama.ts — `https://${apiName}.llama.fi/${path}`,
    // with allowedQueriesDefillama = yields/chart/##any##,
    // api/v2/historicalChainTvl/HydraDX and api/summary/dexs/hydration-dex.
    name: 'defillama',
    base: 'https://{1}.llama.fi/{2}',
    allow: [
      // Pool APY/TVL history by DefiLlama pool uuid — what the UI's yield charts read.
      /^(yields)\/(chart\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
      /^(api)\/(v2\/historicalChainTvl\/HydraDX)$/,
      /^(api)\/(summary\/dexs\/hydration-dex)$/,
    ],
    ttlMs: 600_000,
    docs: 'DefiLlama yield charts for a pool uuid, Hydration chain TVL history, and the hydration-dex volume summary.',
  },
  {
    // data-lake: resources/kamino.ts —
    // `https://api.kamino.finance/${apiName}/${section}/${query}` with
    // allowedQueriesKamino = { yields }. Narrowed to the history endpoint the
    // yields view actually calls.
    name: 'kamino',
    base: 'https://api.kamino.finance/{1}',
    allow: [/^(yields\/[0-9A-Za-z]+\/history)$/],
    ttlMs: 600_000,
    docs: 'Kamino yield history for one yield source (`yields/<source>/history`).',
  },
  {
    // data-lake: resources/subsquare.ts —
    // `https://hydration-api.subsquare.io/users/${address}/${apiName}/${section}`
    // with allowedQueriesSubsquare = referenda/votes. `gov2/referendums` is the
    // referendum list the design spec adds; the data-lake handler's fixed
    // users/<address>/… shape cannot express it.
    name: 'subsquare',
    base: 'https://hydration-api.subsquare.io/{1}',
    allow: [
      /^(users\/[0-9A-Za-z]+\/referenda\/votes)$/,
      /^(gov2\/referendums)$/,
    ],
    ttlMs: 60_000,
    docs: "A voter's OpenGov vote history and the referendum list from Subsquare's Hydration API.",
  },
]

export function proxyUpstream(name: string): ProxyUpstream | undefined {
  return PROXY_UPSTREAMS.find(upstream => upstream.name === name)
}

// The upstream URL for a request path, or null when the path is not allow-listed.
// `search` is the raw query string (with or without its leading '?'); it is
// re-encoded through the URL parser, so it can neither open a fragment nor carry
// anything that changes the target's origin or path.
export function proxyTargetUrl(upstream: ProxyUpstream, relPath: string, search: string): string | null {
  const path = relPath.replace(/^\/+/, '')
  const match = matchAllow(upstream, path)
  if (!match) return null

  const target = upstream.base.replace(/\{(\d+)\}/g, (_, index: string) => match[Number(index)] ?? '')
  // Both invariants hold by construction for the table above; asserting them
  // keeps a future entry with a mismatched template from producing a URL with a
  // literal '{2}' in it, or an http:// upstream.
  if (target.includes('{') || !target.startsWith('https://')) return null

  const url = new URL(target)
  const query = search.replace(/^\?/, '').split('#')[0]
  if (query) url.search = query
  return url.toString()
}

function matchAllow(upstream: ProxyUpstream, path: string): RegExpExecArray | null {
  for (const pattern of upstream.allow) {
    const match = pattern.exec(path)
    if (match) return match
  }
  return null
}
