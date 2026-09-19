// MCP-server-only knobs, kept out of the shared src/config.ts on purpose: the
// mcp tree is a total import leaf (api/tests/mcp/isolation.test.ts) and nothing
// outside it needs these. Parsed once at import; a malformed value fails the
// boot loudly rather than silently running on a default, which is the data
// tree's idiom (src/data/config.ts).

function parsePositiveInt(value: string | undefined, name: string, fallback: number): number {
  const raw = value?.trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer, received ${JSON.stringify(value)}`)
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} out of range: ${JSON.stringify(value)}`)
  return parsed
}

function parseNonNegativeInt(value: string | undefined, name: string, fallback: number): number {
  const raw = value?.trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer, received ${JSON.stringify(value)}`)
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} out of range: ${JSON.stringify(value)}`)
  return parsed
}

function parsePort(value: string | undefined, name: string, fallback: number): number {
  const port = parsePositiveInt(value, name, fallback)
  if (port > 65_535) throw new Error(`${name} must be a TCP port (1-65535), received ${JSON.stringify(value)}`)
  return port
}

// Every absolute URL this service hands out or calls is built by concatenation,
// so a trailing slash would produce `//path`. Normalize once, here, and reject a
// value that is not an http(s) origin rather than discovering it at the first
// upstream call.
function parseUrl(value: string | undefined, name: string, fallback: string): string {
  const raw = value?.trim() || fallback
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL, received ${JSON.stringify(value)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must be an absolute http(s) URL, received ${JSON.stringify(value)}`)
  }
  return raw.replace(/\/+$/, '')
}

// Comma-separated bearer keys. Empty means the endpoint is open, which is the
// default posture (spec § 2 "Auth and abuse control"): the tools read public
// chain data only. A key shorter than 16 characters is refused because the
// comparison is constant-time but the key space would not be.
function parseAccessKeys(value: string | undefined): string[] {
  const out: string[] = []
  for (const entry of (value ?? '').split(',')) {
    const key = entry.trim()
    if (!key) continue
    if (key.length < 16) throw new Error('MCP_ACCESS_KEYS entries must be at least 16 characters')
    out.push(key)
  }
  return out
}

export const mcpConfig = {
  port: parsePort(process.env.MCP_PORT, 'MCP_PORT', 3000),
  host: process.env.MCP_HOST?.trim() || '0.0.0.0',
  // This service's own origin: the getting-started page's snippets, /mcp.json
  // and /llms.txt all name it, so it must be the address an agent can reach.
  publicUrl: parseUrl(process.env.MCP_PUBLIC_URL, 'MCP_PUBLIC_URL', 'https://hydration-mcp.neckwork.net'),
  // The explorer api inside the compose network. Its in-process caches are
  // already warm for the UI, which is the whole reason this server reads HTTP
  // instead of ClickHouse.
  explorerApiUrl: parseUrl(process.env.EXPLORER_API_URL, 'EXPLORER_API_URL', 'http://hydration-neckwork-api:3000'),
  // Where the canonical links in every rendered answer point, so an agent can
  // hand a human the page the number came from.
  explorerPublicUrl: parseUrl(process.env.EXPLORER_PUBLIC_URL, 'EXPLORER_PUBLIC_URL', 'https://hydration-explorer.neckwork.net'),
  accessKeys: parseAccessKeys(process.env.MCP_ACCESS_KEYS),
  // Cold scoped activity measured 38s upstream and milliseconds warm, so the
  // budget is sized for the cold call rather than the typical one.
  upstreamTimeoutMs: parsePositiveInt(process.env.MCP_UPSTREAM_TIMEOUT_MS, 'MCP_UPSTREAM_TIMEOUT_MS', 60_000),
  // In-flight upstream requests across all agents. The explorer api applies no
  // rate limiting and no per-caller isolation, so this is what keeps an agent
  // burst from contending with the live UI. Raising it is the wrong lever: a
  // burst of 30 concurrent reads moved the live Explorer's own activity p50
  // from 338ms to 2,278ms, so the brake belongs on agent work, not on the UI.
  maxUpstreamConcurrency: parsePositiveInt(process.env.MCP_MAX_UPSTREAM_CONCURRENCY, 'MCP_MAX_UPSTREAM_CONCURRENCY', 6),
  // How long a call may wait for one of those slots before it is shed with a
  // "busy, retry" rather than silently spending its answer time in a queue.
  // Short on purpose: an agent is better served by a fast refusal it can act on
  // than by an answer that arrives after a minute of someone else's work.
  upstreamQueueTimeoutMs: parsePositiveInt(process.env.MCP_UPSTREAM_QUEUE_TIMEOUT_MS, 'MCP_UPSTREAM_QUEUE_TIMEOUT_MS', 5_000),
  // How many calls may wait at once, so a burst cannot grow an unbounded queue.
  upstreamQueueDepth: parsePositiveInt(process.env.MCP_UPSTREAM_QUEUE_DEPTH, 'MCP_UPSTREAM_QUEUE_DEPTH', 64),
  // Slots reserved for the cheap lane (chain status and the like), so a
  // millisecond read still answers in milliseconds while the heavy lane is
  // saturated. Taken out of maxUpstreamConcurrency, never added to it.
  upstreamCheapLaneSlots: parseNonNegativeInt(process.env.MCP_UPSTREAM_CHEAP_LANE_SLOTS, 'MCP_UPSTREAM_CHEAP_LANE_SLOTS', 2),
  // Default per-URL response cache TTL; a tool overrides it per call where the
  // upstream's own cache-control says the resource moves slower.
  cacheTtlMs: parseNonNegativeInt(process.env.MCP_CACHE_TTL_MS, 'MCP_CACHE_TTL_MS', 10_000),
  // Hard cap on one rendered answer. A tool renders to fit; this is the last
  // guard so a pathological record cannot blow out a context window.
  maxTextChars: parsePositiveInt(process.env.MCP_MAX_TEXT_CHARS, 'MCP_MAX_TEXT_CHARS', 24_000),
} as const
