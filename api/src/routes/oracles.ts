import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { FEED_RANGES, getOracleFeed, getOracleFeedUpdates, getOraclesOverview, parseFeedParam } from '../services/oracleService.ts'

// The oracle surface (services/oracleService.ts states what each figure is and
// where it is read from). Every route answers from memory — the refresher's
// pinned live read and the in-process ledgers — so none of them reads chain state
// or a raw table on the request path.

const page = z.coerce.number().int().min(0).max(100_000).default(0)

/**
 * The feed id and whether the updates page was asked for. A DIA key carries a
 * slash ("DOT/USD") that arrives as a path separator however the client encoded
 * it (nginx decodes %2F before proxying), so the id is the whole rest of the path.
 */
export function splitFeedPath(rest: string): { feed: string; updates: boolean } {
  let r = rest
  try { if (/%[0-9a-f]{2}/i.test(r)) r = decodeURIComponent(r) } catch { /* keep as sent */ }
  const updates = r.endsWith('/updates')
  return { feed: updates ? r.slice(0, -'/updates'.length) : r, updates }
}

export async function oracleRoutes(fastify: FastifyInstance) {
  // Every money market's oracle price per reserve, the stableswap pegs read from
  // an oracle, every delivery feed with its cadence and status, the EMA oracle
  // per source, and the source-change timeline.
  fastify.get('/explorer/oracles', async () => getOraclesOverview())

  // One feed — `dia:<contract>:<KEY>`, `ema:<source>:<a>-<b>`, or an EVM address
  // (a push feed, or an adapter: a DIA adapter answers with its key's feed) — or,
  // with a trailing `/updates`, one page of its updates (newest first, 25 a page).
  fastify.get('/explorer/oracle/*', async (req, reply) => {
    const { feed, updates } = splitFeedPath((req.params as { '*'?: string })['*'] ?? '')
    if (!parseFeedParam(feed)) return reply.status(400).send({ error: 'Invalid feed: an EVM address, dia:<contract>:<KEY> or ema:<source>:<a>-<b>' })
    if (updates) {
      const q = z.object({ page }).safeParse(req.query)
      if (!q.success) return reply.status(400).send({ error: 'Invalid page' })
      return (await getOracleFeedUpdates(feed, q.data.page)) ?? reply.status(404).send({ error: 'Feed not found' })
    }
    const q = z.object({ range: z.enum(FEED_RANGES).default('30d'), page }).safeParse(req.query)
    if (!q.success) return reply.status(400).send({ error: `Invalid query: range one of ${FEED_RANGES.join(', ')}, page ≥ 0` })
    return (await getOracleFeed(feed, q.data.range, q.data.page)) ?? reply.status(404).send({ error: 'Feed not found' })
  })
}
