import type { ToolError } from './toolTypes.ts'
import { UpstreamBusyError, UpstreamError, UpstreamPathRefused } from './upstream.ts'

// The six codes a tool may report, as constructors, so a message shape is
// written once rather than at every call site.

export function invalidArgument(message: string): ToolError {
  return { code: 'INVALID_ARGUMENT', message }
}

export function notFound(message: string): ToolError {
  return { code: 'NOT_FOUND', message }
}

export function notYetIndexed(message: string): ToolError {
  return { code: 'NOT_YET_INDEXED', message }
}

export function upstreamUnavailable(message: string): ToolError {
  return { code: 'UPSTREAM_UNAVAILABLE', message }
}

export function tooLarge(message: string): ToolError {
  return { code: 'TOO_LARGE', message }
}

export function internalError(message: string): ToolError {
  return { code: 'INTERNAL_ERROR', message }
}

// Hydration's nominal slot time, which `/explorer/stats` publishes as
// `nominalBlockSec`. Only used to turn a block distance into the wait it
// implies. Pinned rather than read because this module is a pure mapping with
// no upstream client; a cadence change makes every number below wrong at once,
// which is why the three constants are derived from it rather than written out.
const BLOCK_SECONDS = 2
// How far above the index head a block may be and still be explained by
// finality alone. raw-live follows the FINALIZED head, which trails the chain
// head by 35-65 seconds — 17 to 32 blocks at this cadence — so the window has
// to clear the top of that range rather than sit inside it, or a genuine early
// read 25 blocks out is told it is a wrong identifier.
const FINALITY_WINDOW_BLOCKS = Math.ceil(90 / BLOCK_SECONDS)
// And how far above it a height can still plausibly be a real block at all.
// `headBound` is the larger of the indexed head and the mempool's best height,
// so it tracks the chain's own head even while ingestion lags: a height hours
// above it names a block the chain has not produced. Two hours leaves room for
// a genuinely stalled pipeline before the answer flips from "wait" to "wrong".
const REACHABLE_WINDOW_BLOCKS = Math.ceil((2 * 60 * 60) / BLOCK_SECONDS)

// Refusals the explorer api raises as a 5xx although nothing is wrong with it:
// the request as written would have to walk more rows than the read path
// allows. Retrying is useless and expensive (the refusal itself costs 34-49s
// on the shared api), so these must reach the agent as "narrow the query".
const QUERY_TOO_BROAD_CODES: readonly string[] = ['ACTIVITY_QUERY_TOO_BROAD']

// The explorer routes addressed by block coordinates — the ones whose 404
// carries a lookup miss — and which path segment holds the height. Naming them
// is what keeps `/explorer/referendum/opengov/410`, `/explorer/asset/5` and
// `/explorer/dca/30104` out: those numbers are not block heights.
const COORDINATE_HEIGHT_SEGMENT: Readonly<Record<string, number>> = {
  block: 2,
  event: 2,
  extrinsic: 2,
  'extrinsic-at': 2,
  trade: 2,
  'trade-event': 2,
  'dca-at': 2,
}

/**
 * The block height a failed coordinate lookup was asking about.
 *
 * Read off the path the client already carries, so the distance check below
 * works for every coordinate route without a call site having to remember to
 * pass it.
 */
function blockHeightFromPath(path: string): number | undefined {
  const segments = path.split(/[?#]/, 1)[0].split('/').filter(Boolean)
  if (segments[0] !== 'explorer') return undefined
  // `/explorer/dca/exec/<height>/<index>` is the one coordinate route that
  // takes a second word before the height.
  const at = segments[1] === 'dca' && segments[2] === 'exec' ? 3 : COORDINATE_HEIGHT_SEGMENT[segments[1] ?? '']
  if (at === undefined) return undefined
  // `/explorer/extrinsic/14746890-3` addresses the extrinsic by `height-index`.
  const head = (segments[at] ?? '').split('-')[0]
  if (!/^\d+$/.test(head)) return undefined
  const height = Number(head)
  return Number.isSafeInteger(height) ? height : undefined
}

function humanDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`
  if (seconds < 10_800) return `${Math.round(seconds / 60)} minutes`
  if (seconds < 172_800) return `${Math.round(seconds / 3_600)} hours`
  if (seconds < 63_115_200) return `${Math.round(seconds / 86_400)} days`
  return `${Math.round(seconds / 31_557_600)} years`
}

/**
 * The upstream's own sentence, when it is safe to repeat to an anonymous agent.
 *
 * The explorer api registers no error handler of its own, so a fault it does
 * not catch answers with fastify's default 500 body — whose `message` is the
 * raw `err.message`. For a ClickHouse failure that carries the cluster host and
 * port, the server version, table names and sometimes the SQL; none of it is
 * the client's business, and this endpoint is open. The hand-written refusals
 * that are worth repeating ("Activity offset must be between 0 and 2500 for
 * type 'all'", "narrow the filters or date range") are all one short line of
 * prose, so that is the shape this admits: anything longer, wrapped, or
 * carrying a stack frame, a filesystem path or a `host:port` is dropped and the
 * status code stands on its own.
 */
const UNSAFE_DETAIL = /(^|\s)at [\w$.<>[\]]+ ?\(|\/(home|app|usr|opt|etc|var|root)\/|node_modules|[a-z][\w.-]*:\d{2,5}(\b|$)|DB::Exception|\bCode: \d+|\b(getaddrinfo|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ETIMEDOUT|EPIPE)\b/i

function safeDetail(message: string | undefined): string | null {
  const flat = (message ?? '').trim()
  if (!flat || flat.length > 240) return null
  if (/[\n\r]/.test(flat)) return null
  return UNSAFE_DETAIL.test(flat) ? null : flat
}

/** What a tool knows about the failed read that the error itself does not carry. */
export interface UpstreamErrorContext {
  // The block height the call was asking about, when the path does not name it.
  blockHeight?: number
}

/**
 * The 404 split, made to scale with how far ahead the identifier is.
 *
 * The explorer answers a coordinate miss with `blockIndexed`/`headBound`
 * (describeLookupMiss), because a client cannot otherwise tell the two misses
 * apart. `blockIndexed: false` alone is not enough advice though: a block a few
 * heights above the index head is 35-65 seconds of finality away and worth
 * waiting for, while one thousands of heights above it is a wrong identifier —
 * telling an agent to "retry shortly" for a block days in the future sends it
 * into a loop that can never succeed.
 */
function lookupMiss(err: UpstreamError, what: string, ctx?: UpstreamErrorContext): ToolError {
  const head = err.headBound
  const height = ctx?.blockHeight ?? blockHeightFromPath(err.path)

  if (err.blockIndexed !== false) {
    return notFound(`${what} does not exist.${typeof head === 'number' ? ` The block it names is already indexed (index head ${head.toLocaleString('en-US')}), so this is a bad identifier rather than an early read.` : ''}`)
  }
  if (typeof head !== 'number' || typeof height !== 'number' || height <= head) {
    return notYetIndexed(`${what} is not indexed yet.${typeof head === 'number' ? ` The index reaches block ${head.toLocaleString('en-US')}.` : ''} The index follows the finalized head, which trails it by roughly 35-65 seconds — retry shortly.`)
  }

  const ahead = height - head
  if (ahead <= FINALITY_WINDOW_BLOCKS) {
    return notYetIndexed(`${what} is not indexed yet: it is ${ahead} block${ahead === 1 ? '' : 's'} above the index head (${head.toLocaleString('en-US')}), which is inside the finality window — the index follows the finalized head, and that trails the chain by roughly 35-65 seconds. Retry shortly.`)
  }
  if (ahead <= REACHABLE_WINDOW_BLOCKS) {
    // Past finality but still a height the index could reach. The wait is the
    // number that matters: "retry shortly" would be a lie at this distance.
    return notYetIndexed(`${what} is not indexed yet: it is ${ahead.toLocaleString('en-US')} blocks above the index head (${head.toLocaleString('en-US')}), about ${humanDuration(ahead * BLOCK_SECONDS)} of chain — far past the 35-65 second finality window. Check the height first; if it is right, retrying makes sense only after roughly that long.`)
  }
  // Far past the finality window the honest reading is a wrong identifier: the
  // index would need the stated time to reach that height, which no retry loop
  // is going to wait out.
  return notFound(`${what} is ${ahead.toLocaleString('en-US')} blocks above the index head (${head.toLocaleString('en-US')}), about ${humanDuration(ahead * BLOCK_SECONDS)} of chain beyond it. That is far past the 35-65 second finality window, so this is a wrong identifier rather than an early read — check the height. Retrying will not help.`)
}

/**
 * Maps an upstream failure onto the tool error an agent can act on.
 *
 * The distinctions that matter, in order: work this server shed before it
 * asked (retry in seconds), a request the explorer refused because it was too
 * broad (change the query, never retry), a coordinate miss (see lookupMiss),
 * and a genuine outage.
 */
export function toolErrorFromUpstream(err: unknown, what: string, ctx?: UpstreamErrorContext): ToolError {
  if (err instanceof UpstreamPathRefused) {
    // Bounded on purpose: the guard's own message names neither the path nor
    // the allow-list, and this must not reconstruct either.
    return invalidArgument(`${what} could not be read: ${err.message}. Check the identifier — an address, hash, symbol or number, not a URL or path.`)
  }
  if (!(err instanceof UpstreamError)) {
    const detail = safeDetail(err instanceof Error ? err.message : String(err))
    return internalError(detail
      ? `${what} could not be read: ${detail}`
      : `${what} could not be read: this MCP server hit an unexpected fault while asking.`)
  }
  if (err instanceof UpstreamBusyError) {
    return upstreamUnavailable(`${what} could not be read: this MCP server is at its limit of in-flight reads against the Hydration explorer API and shed the request rather than queue it. Nothing is wrong with the data — retry in a few seconds, or ask for less at once.`)
  }
  if (err.status === 0) {
    const transport = safeDetail(err.message)
    return upstreamUnavailable(`${what} could not be read: the Hydration explorer API did not answer${transport ? ` (${transport})` : ''}.`)
  }
  if (err.status === 404) return lookupMiss(err, what, ctx)
  // A 2xx whose body was not JSON. The status says nothing useful here, so the
  // sentence has to; the body itself is the upstream's own and never repeated.
  if (err.status < 400) {
    return upstreamUnavailable(`${what} could not be read: the Hydration explorer API answered ${err.status} with a body this server could not read as JSON. That is a fault on the Hydration side rather than in the request — retry once before giving up.`)
  }

  const refusedAsTooBroad = (err.upstreamCode && QUERY_TOO_BROAD_CODES.includes(err.upstreamCode))
    || err.status === 413
    // The same refusal reaching us without its code, for instance through a
    // proxy that rewrote the body.
    || /too many candidate rows|narrow the filters|too broad/i.test(err.message)
  // Every branch below repeats the upstream's own sentence, so every one of
  // them takes it through safeDetail first.
  const detail = safeDetail(err.message)
  if (refusedAsTooBroad) {
    return tooLarge(`${what} was refused as too broad by the Hydration explorer API${detail ? `: ${detail}` : ''}. This is a limit on the query, not an outage: narrow it — a tighter date range, a specific account or asset, a smaller limit — rather than retrying the same request.`)
  }
  if (err.status >= 400 && err.status < 500 && err.status !== 429) {
    return invalidArgument(detail
      ? `${what} was refused by the Hydration explorer API: ${detail}`
      : `${what} was refused by the Hydration explorer API (HTTP ${err.status}). Check the identifier and the filters.`)
  }
  // 429 and 5xx: transient by nature. The upstream's own sentence travels with
  // it, because the status code alone does not say what happened — unless the
  // body carried nothing or said something only an operator may read, in which
  // case the status IS the message.
  const said = !detail || err.message === `upstream responded ${err.status}` ? '' : ` (${detail})`
  return upstreamUnavailable(`${what} could not be read: the Hydration explorer API responded ${err.status}${said}. This usually clears on its own — retry once before giving up.`)
}
