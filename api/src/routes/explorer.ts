import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { getReferenda, getReferendum, parseReferendumPallet } from '../services/governanceService.ts'
import { extrinsicEncoded } from '../services/extrinsicBytes.ts'
import {
  getStats, getRecentBlocks, getBlock, getRecentExtrinsics, getExtrinsic, getExtrinsicAt,
  getExtrinsicActivity, getBlockActivity,
  getHolders, getAddress, getAddressHistory, search, getAssets, getAccounts, getDcaSchedule, getDcaScheduleIdAt, getDcaExecution,
  getRecentEvents, getEventAt, getTradeDetail, getTradeDetailByEvent, getRecentActivity, getGlobalActivityTotal, getMoneyMarket, getAssetDetail, getAssetActivity, getDailyActivity, getDailyAccounts, getListCounts, getTag,
  getAddressActivity, getAddressExtrinsics, getAddressEvents, getAddressTabCounts, getTagTabCounts,
  getAddressListTotal, getTagListTotal,
  getAddressValueEvents, getTagValueEvents,
  getTagActivity, getTagExtrinsics, getTagEvents,
  getAddressVotes, getTagVotes,
  isLocatedActivityRequest,
  type EventListFilters,
  type ExtrinsicListFilters,
  type ScopedListQuery,
  type ScopedListTab,
  type ValueListFilters,
} from '../services/explorerService.ts'
import { getHdxDashboard } from '../services/hdxService.ts'
import { getHollarDashboard } from '../services/hollarService.ts'
import { ACCOUNT_AFFINITY_BUSY_CODE, getCloseAccounts, getCloseAccountsForTag } from '../services/accountAffinityService.ts'

// The wire vocabulary the explorer sends. 'stake' is the URL/product word; the
// activity builders below still speak the row type 'staking', so it is translated
// once here rather than in the eight places the service branches on it.
const activityTypes = ['all', 'transfer', 'trade', 'dca', 'liquidity', 'mm', 'xcm', 'stake', 'vote', 'otc']
const ACTIVITY_TYPE_ALIASES: Record<string, string> = { stake: 'staking' }
const uint32Param = z.coerce.number().int().min(0).max(0xffff_ffff)

// Public list endpoints never render more than 100 rows at once. A modest hard
// cap prevents a single request from multiplying the feed candidate scans.
const limitSchema = z.coerce.number().int().min(1).max(250).optional()
const accountSortSchema = z.enum(['value', 'supplied', 'borrowed', 'health', 'identity', 'activity', 'volume', 'liquidation'])
const addressParam = z.object({ address: z.string().min(1).max(128) })
const analyzableAddressParam = z.object({ address: z.string().min(3).max(128) })
const tagParam = z.object({ tagId: z.string().min(1).max(64) })
// The multi-source categories assemble one candidate window per source, classify
// it and page in Node, so their cost grows with depth and the window they need
// grows with it too. This is the deepest offset every one of them was measured to
// answer, with and without the page's default $10 floor — at offset 2500: trade
// 0.3/0.8s, mm 1.5/1.8s, liquidity 1.2/4.7s, transfer 1.9/6.6s, xcm 3.3/8.1s,
// all 10.0/9.9s. At 5000 the merged and trade feeds already refuse (their windows
// widen past the candidate ceiling), so pages past this one were advertised and
// then answered 503 — 10,000 offered four times the pages the feed can serve.
const MAX_ACTIVITY_OFFSET = 2_500
// A single bound across every category either starves the cheap tabs or lets the
// expensive ones time out. The deep set is the categories the feed pages in SQL
// from one small source — vote_activity 121,092 rows, staking_activity 192,060,
// otc_activity 4,473 — so a deep offset cannot explode no matter how far it is
// pushed: measured at offset 190,000, vote 0.11s, staking 1.26s, otc 0.19s.
//
// This is what withheld /activity?tab=vote&page=490: the vote feed is 4,844 pages of
// 25 and 92% of them sat behind a cap that costs it 51ms to serve.
const MAX_NARROW_ACTIVITY_OFFSET = 250_000
const NARROW_ACTIVITY_TYPES = new Set(['vote', 'staking', 'otc'])
const maxActivityOffsetFor = (type: string) =>
  NARROW_ACTIVITY_TYPES.has(type) ? MAX_NARROW_ACTIVITY_OFFSET : MAX_ACTIVITY_OFFSET
// A WINDOWED account/tag activity request — one carrying a filter no count arm states,
// so it is still assembled by growing one candidate window until the classified feed
// ends or the ceiling is reached, and paged only from the rows above that window's
// frontier. Those are the same rows its published (partial) total counts, so the bound
// only has to stay above any length that total can reach: ten sources at the 90k
// candidate ceiling each.
const MAX_WINDOWED_ACTIVITY_OFFSET = 900_000
// A LOCATED request is not bounded by depth at all: SQL counts the feed and finds the
// ≤ limit blocks the page's ranks sit in, so the work is the feed's own size and an
// offset near the end costs what one near the start does. The bound only has to stay
// above any total this path publishes — the longest feeds indexed are the busiest
// trader's 1.22M merged activities (counted in 7.7s, pages 3.3s at every depth) and the
// routerex pallet's 1.70M liquidity rows (0.106s / 0.232s at offset 899,999).
const MAX_LOCATED_ACTIVITY_OFFSET = 5_000_000
const maxScopedActivityOffsetFor = (q: Record<string, unknown>, type: string) =>
  isLocatedActivityRequest(type, textParam(q, 'action', 32), valueFilters(q))
    ? MAX_LOCATED_ACTIVITY_OFFSET : MAX_WINDOWED_ACTIVITY_OFFSET
const activityOffsetSchema = z.coerce.number().int().min(0).max(MAX_LOCATED_ACTIVITY_OFFSET).optional()
const dateRe = /^\d{4}-\d{2}-\d{2}$/
function dateParam(q: Record<string, unknown>, key: string): string | undefined {
  const v = q[key]
  return typeof v === 'string' && isCalendarDay(v) ? v : undefined
}
// The plain SQL-paged lists (blocks, extrinsics, events, accounts, holders,
// referenda, DCA executions) page by ClickHouse LIMIT/OFFSET, whose cost is linear
// in the offset: skipping N rows still reads N rows of the projection. Measured on
// the events feed's own columns — offset 20M 2.4s, 50M 5.9s, 100M 11.0s — so the
// bound keeps a page inside the client's 20s execution budget with room to spare.
// Every block (13.3M) and signed extrinsic (4.5M) is reachable; the 302.9M-row
// events feed is not, which its pager states rather than offering the pages.
const MAX_LIST_OFFSET = 20_000_000
const listOffsetSchema = z.coerce.number().int().min(0).max(MAX_LIST_OFFSET).optional()
// null = out of range. Refused rather than quietly answered with page one, which
// is what an offset past the ceiling used to get: a stale or hand-edited page
// number served the newest rows under the reader's page number.
function offsetParam(q: Record<string, unknown>): number | null {
  const n = listOffsetSchema.safeParse(q.offset)
  return n.success ? n.data ?? 0 : null
}
function badOffset(reply: FastifyReply): FastifyReply {
  return reply.status(400).send({ error: `Offset must be between 0 and ${MAX_LIST_OFFSET}` })
}
function limitParam(q: Record<string, unknown>, fallback: number): number {
  const n = limitSchema.safeParse(q.limit)
  return n.success ? n.data ?? fallback : fallback
}
function textParam(q: Record<string, unknown>, key: string, max = 128): string | undefined {
  const v = q[key]
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined
}
function numParam(q: Record<string, unknown>, key: string): number | undefined {
  const n = z.coerce.number().finite().min(0).safeParse(q[key])
  return n.success ? n.data : undefined
}
function valueFilters(q: Record<string, unknown>): ValueListFilters {
  const unit = q.unit === 'token' ? 'token' : 'usd'
  return {
    token: textParam(q, 'token', 64),
    min: numParam(q, 'min'),
    unit,
  }
}

function activityTypeParam(query: Record<string, unknown>): string {
  const t = typeof query.type === 'string' && activityTypes.includes(query.type) ? query.type : 'all'
  return ACTIVITY_TYPE_ALIASES[t] ?? t
}

// A supplied filter the server cannot honour used to be dropped in silence: an
// unrecognized `type` fell back to `all` and answered with the UNFILTERED total
// under the caller's own filtered parameters, and a malformed `min`/`unit`/`from`/
// `to` simply vanished. Silently widening a request is a wrong answer wearing the
// caller's query string — strictly worse than refusing it — so every shared list
// filter is validated once, here, for every route this plugin owns.
//
// Only a value that was SUPPLIED and cannot be honoured is an error; an absent or
// empty parameter still means "unfiltered", which is what the UI sends when it
// clears a chip. The parsers below are the exact acceptance rules the readers
// (`activityTypeParam`, `valueFilters`, `dateParam`) apply, so a value that passes
// here is a value that reaches ClickHouse.
const FILTER_PARAM_RULES: { key: string; accepts: (raw: string) => boolean; expected: string }[] = [
  { key: 'type', accepts: raw => activityTypes.includes(raw), expected: activityTypes.join(', ') },
  { key: 'unit', accepts: raw => raw === 'usd' || raw === 'token', expected: 'usd, token' },
  // Any finite number is honourable: a negative floor selects every row, which is
  // exactly what `numParam` already resolves it to. Only a value that is not a
  // number at all would silently disappear.
  { key: 'min', accepts: raw => z.coerce.number().finite().safeParse(raw).success, expected: 'a number' },
  { key: 'from', accepts: raw => isCalendarDay(raw), expected: 'YYYY-MM-DD' },
  { key: 'to', accepts: raw => isCalendarDay(raw), expected: 'YYYY-MM-DD' },
]

// A real calendar day, not merely the shape of one: `2025-02-30` matches the regex
// but round-trips to March, and `dateParam` drops it. Same rule, one definition.
function isCalendarDay(raw: string): boolean {
  if (!dateRe.test(raw)) return false
  const parsed = new Date(`${raw}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw
}

// null = every supplied filter is usable.
export function unusableFilterParam(query: Record<string, unknown>): { key: string; expected: string } | null {
  for (const rule of FILTER_PARAM_RULES) {
    const raw = query[rule.key]
    if (raw == null || raw === '') continue
    if (typeof raw !== 'string' || !rule.accepts(raw)) return { key: rule.key, expected: rule.expected }
  }
  return null
}

// null = out of range for this feed. The bound depends on the category, so callers
// that know their type pass it; the rest get the conservative wide-feed bound.
function activityOffsetParam(query: Record<string, unknown>, type = 'all'): number | null {
  return boundedActivityOffset(query, maxActivityOffsetFor(type))
}

function boundedActivityOffset(query: Record<string, unknown>, max: number): number | null {
  const parsed = activityOffsetSchema.safeParse(query.offset)
  if (!parsed.success) return null
  const offset = parsed.data ?? 0
  return offset <= max ? offset : null
}

// The list a detail-page pager is sizing itself against.
const listTabSchema = z.enum(['activity', 'extrinsics', 'events', 'votes'])
function scopedListQuery(q: Record<string, unknown>): ScopedListQuery | null {
  const tab = listTabSchema.safeParse(q.tab)
  if (!tab.success) return null
  return {
    tab: tab.data satisfies ScopedListTab,
    type: activityTypeParam(q),
    action: textParam(q, 'action', 32),
    value: valueFilters(q),
    extrinsic: extrinsicFilters(q),
    event: eventFilters(q),
    from: dateParam(q, 'from'),
    to: dateParam(q, 'to'),
  }
}

function extrinsicFilters(query: Record<string, unknown>): ExtrinsicListFilters {
  const result = query.result === 'success' || query.result === 'failed' ? query.result : undefined
  const origin = query.origin === 'signed' || query.origin === 'proxy' || query.origin === 'multisig' ? query.origin : undefined
  return { call: textParam(query, 'call', 128), result, origin }
}

function eventFilters(query: Record<string, unknown>): EventListFilters {
  return { event: textParam(query, 'event', 128) }
}

async function closeAccountsResponse<T>(reply: FastifyReply, load: () => Promise<T | null>, notFoundError: string): Promise<T | FastifyReply> {
  try {
    const result = await load()
    return result ?? reply.status(404).send({ error: notFoundError })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === ACCOUNT_AFFINITY_BUSY_CODE) {
      reply.header('Retry-After', '5')
      return reply.status(503).send({ error: 'Close-account analysis is busy; retry shortly' })
    }
    throw error
  }
}

export async function explorerRoutes(fastify: FastifyInstance) {
  // Refuse a filter this plugin cannot honour before any route reads it, so no
  // response can carry the caller's filter parameters over a wider answer.
  fastify.addHook('preHandler', async (req, reply) => {
    const bad = unusableFilterParam(req.query as Record<string, unknown>)
    if (bad) return reply.status(400).send({ error: `Invalid ${bad.key}; expected ${bad.expected}` })
  })

  fastify.get('/explorer/stats', async () => getStats())

  fastify.get('/explorer/assets', async () => getAssets())

  fastify.get('/explorer/accounts', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    const limit = limitParam(q, 50)
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    const sort = accountSortSchema.safeParse(q.sort)
    return getAccounts(offset, limit, sort.success ? sort.data : 'value')
  })

  fastify.get('/explorer/daily/:scope', async (req, reply) => {
    const params = z.object({ scope: z.enum(['extrinsics', 'events', 'activity']) }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid scope' })
    // Optional filters so the chart can mirror the activity page's tab + filters.
    const q = z.object({ type: z.string().max(20).optional(), action: z.string().max(40).optional(), token: z.string().max(40).optional() }).safeParse(req.query)
    return getDailyActivity(params.data.scope, q.success ? q.data : {})
  })

  fastify.get('/explorer/accounts-daily', async () => getDailyAccounts())

  // Row totals for the Blocks/Extrinsics/Events pagers, plus the deepest offset
  // those lists serve, so a pager numbers only pages it can actually fetch instead
  // of dividing a 302.9M-row total by the page size and offering the rest.
  fastify.get('/explorer/counts', async () => ({ ...await getListCounts(), maxOffset: MAX_LIST_OFFSET }))

  fastify.get('/explorer/blocks', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    return getRecentBlocks(limitParam(q, 25), offset)
  })

  fastify.get('/explorer/block/:height', async (req, reply) => {
    const params = z.object({ height: uint32Param }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid block height' })
    const block = await getBlock(params.data.height)
    if (!block) return reply.status(404).send({ error: 'Block not found' })
    return block
  })

  fastify.get('/explorer/block/:height/activity', async (req, reply) => {
    const params = z.object({ height: uint32Param }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid block height' })
    const block = await getBlock(params.data.height)
    if (!block) return reply.status(404).send({ error: 'Block not found' })
    return getBlockActivity(params.data.height)
  })

  fastify.get('/explorer/extrinsics', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    const limit = limitParam(q, 25)
    const signedOnly = q.signedOnly === 'true' || q.signedOnly === '1'
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    return getRecentExtrinsics(limit, signedOnly, dateParam(q, 'from'), dateParam(q, 'to'), offset, extrinsicFilters(q))
  })

  // Referendum detail. Hydration has voted through two pallets that both index from
  // 0 (Democracy 0-206, OpenGov 0-369), so the pallet is part of the identity — an
  // index alone would show two different referenda under one URL.
  fastify.get('/explorer/referendum/:pallet/:index', async (req, reply) => {
    const params = z.object({ pallet: z.string(), index: uint32Param }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid referendum reference' })
    const pallet = parseReferendumPallet(params.data.pallet)
    if (!pallet) return reply.status(400).send({ error: "Referendum pallet must be 'opengov' or 'democracy'" })
    const limit = limitParam(req.query as Record<string, unknown>, 500)
    const detail = await getReferendum(pallet, params.data.index, limit)
    if (!detail) return reply.status(404).send({ error: 'Referendum not found' })
    return detail
  })

  fastify.get('/explorer/referenda', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    return getReferenda(limitParam(q, 100), offset)
  })

  fastify.get('/explorer/extrinsic/:hash', async (req, reply) => {
    const params = z.object({ hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid extrinsic hash' })
    const ext = await getExtrinsic(params.data.hash)
    if (!ext) return reply.status(404).send({ error: 'Extrinsic not found' })
    return ext
  })

  fastify.get('/explorer/extrinsic/:hash/activity', async (req, reply) => {
    const params = z.object({ hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid extrinsic hash' })
    const ext = await getExtrinsic(params.data.hash)
    if (!ext) return reply.status(404).send({ error: 'Extrinsic not found' })
    return getExtrinsicActivity(ext.blockHeight, ext.index)
  })

  // Design routes extrinsics as height-index (#/extrinsic/12345-2).
  fastify.get('/explorer/dca/:scheduleId', async (req, reply) => {
    // Schedule ids start at 0 on-chain.
    const params = z.object({ scheduleId: z.coerce.number().int().nonnegative() }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid schedule id' })
    const q = req.query as Record<string, unknown>
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    const detail = await getDcaSchedule(params.data.scheduleId, offset, limitParam(q, 25))
    if (!detail) return reply.status(404).send({ error: 'DCA schedule not found' })
    return detail
  })

  // A single DCA execution, addressed by its execution event (block + event
  // index). Reached from the schedule page's per-execution rows.
  fastify.get('/explorer/dca/exec/:height/:index', async (req, reply) => {
    const params = z.object({ height: uint32Param, index: uint32Param }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid execution reference' })
    const detail = await getDcaExecution(params.data.height, params.data.index)
    if (!detail) return reply.status(404).send({ error: 'DCA execution not found' })
    return detail
  })

  fastify.get('/explorer/dca-at/:height/:index', async (req, reply) => {
    const params = z.object({ height: uint32Param, index: uint32Param }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid reference' })
    const kind = (req.query as Record<string, unknown>).kind === 'extrinsic' ? 'extrinsic' : 'event'
    const scheduleId = await getDcaScheduleIdAt(params.data.height, params.data.index, kind)
    if (scheduleId == null) return reply.status(404).send({ error: 'No DCA execution there' })
    return { scheduleId }
  })

  fastify.get('/explorer/extrinsic-at/:height/:index', async (req, reply) => {
    const params = z.object({ height: uint32Param, index: uint32Param }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid extrinsic id' })
    const ext = await getExtrinsicAt(params.data.height, params.data.index)
    if (!ext) return reply.status(404).send({ error: 'Extrinsic not found' })
    return ext
  })

  // The extrinsic's own SCALE bytes. Not indexed (extrinsics are stored decoded), so
  // they come from the chain — one targeted lookup, cached, and only when a reader asks
  // for the encoded form. 404 rather than a guess when the node cannot answer.
  fastify.get('/explorer/extrinsic-at/:height/:index/encoded', async (req, reply) => {
    const params = z.object({ height: uint32Param, index: uint32Param }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid extrinsic reference' })
    const encoded = await extrinsicEncoded(params.data.height, params.data.index)
    if (!encoded) return reply.status(404).send({ error: 'Encoded extrinsic unavailable' })
    return { encoded }
  })

  fastify.get('/explorer/extrinsic-at/:height/:index/activity', async (req, reply) => {
    const params = z.object({ height: uint32Param, index: uint32Param }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid extrinsic id' })
    const ext = await getExtrinsicAt(params.data.height, params.data.index)
    if (!ext) return reply.status(404).send({ error: 'Extrinsic not found' })
    return getExtrinsicActivity(params.data.height, params.data.index)
  })

  // Trade detail (route + slippage) for the swap events of one extrinsic.
  fastify.get('/explorer/trade/:height/:index', async (req, reply) => {
    const params = z.object({ height: uint32Param, index: uint32Param }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid trade id' })
    const trade = await getTradeDetail(params.data.height, params.data.index)
    if (!trade) return reply.status(404).send({ error: 'Trade not found' })
    return trade
  })

  // Trade detail for pallet/block-hook swap events that do not belong to an
  // extrinsic. Identified by block_height + event_index (/trade/12345-e67).
  fastify.get('/explorer/trade-event/:height/:index', async (req, reply) => {
    const params = z.object({ height: uint32Param, index: uint32Param }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid trade event id' })
    const trade = await getTradeDetailByEvent(params.data.height, params.data.index)
    if (!trade) return reply.status(404).send({ error: 'Trade not found' })
    return trade
  })

  fastify.get('/explorer/events', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    return getRecentEvents(limitParam(q, 25), dateParam(q, 'from'), dateParam(q, 'to'), offset, {
      event: textParam(q, 'event', 128),
    })
  })

  // Events are identified by block_height + event_index (#/event/12345-2).
  fastify.get('/explorer/event/:height/:index', async (req, reply) => {
    const params = z.object({ height: uint32Param, index: uint32Param }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid event id' })
    const ev = await getEventAt(params.data.height, params.data.index)
    if (!ev) return reply.status(404).send({ error: 'Event not found' })
    return ev
  })

  // One activity endpoint for the global feed AND asset-scoped activities: with
  // `asset` set, the asset-scoped builder serves the same filters over the
  // asset's full history (the global feed only carries a recent window).
  fastify.get('/explorer/activity', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    const type = activityTypeParam(q)
    const offset = activityOffsetParam(q, type)
    if (offset == null) return reply.status(400).send({ error: `Activity offset must be between 0 and ${maxActivityOffsetFor(type)} for type '${type}'` })
    const asset = z.coerce.number().int().min(0).max(0xffff_ffff).optional().safeParse(q.asset)
    if (asset.success && asset.data != null) {
      return getAssetActivity(asset.data, type, limitParam(q, 40), offset, textParam(q, 'action', 32), valueFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
    }
    return getRecentActivity(limitParam(q, 25), dateParam(q, 'from'), dateParam(q, 'to'), offset, type, valueFilters(q), textParam(q, 'action', 32))
  })

  // What the Activity page's pager needs to offer only real pages: how long the
  // chain-wide feed is under exactly the filters shown, and how deep it can be
  // paged. `total: null` means this category cannot be counted without classifying
  // chain-wide history (see getGlobalActivityTotal), and the pager then walks it by
  // `maxOffset` and the last full page rather than numbering pages it cannot reach.
  // `maxOffset` is the same bound the feed endpoint enforces, so no offered page
  // can answer 400.
  fastify.get('/explorer/activity/count', async (req) => {
    const q = req.query as Record<string, unknown>
    const type = activityTypeParam(q)
    const total = await getGlobalActivityTotal(type, textParam(q, 'action', 32), valueFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
    return { ...total, maxOffset: maxActivityOffsetFor(type) }
  })

  fastify.get('/explorer/money-market', async (req) => {
    const limit = limitParam(req.query as Record<string, unknown>, 50)
    return getMoneyMarket(limit)
  })

  fastify.get('/explorer/asset/:assetId', async (req, reply) => {
    const params = z.object({ assetId: uint32Param }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid asset id' })
    return getAssetDetail(params.data.assetId)
  })

  fastify.get('/explorer/holders/:assetId', async (req, reply) => {
    const params = z.object({ assetId: uint32Param }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid asset id' })
    const q = req.query as Record<string, unknown>
    const limit = limitParam(q, 100)
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    return getHolders(params.data.assetId, limit, offset)
  })

  fastify.get('/explorer/tag/:tagId', async (req, reply) => {
    const params = tagParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid tag id' })
    const tag = await getTag(params.data.tagId, { summary: (req.query as { summary?: string })?.summary === '1' })
    if (!tag) return reply.status(404).send({ error: 'Tag not found' })
    return tag
  })

  fastify.get('/explorer/tag/:tagId/close-accounts', async (req, reply) => {
    const params = tagParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid tag id' })
    return closeAccountsResponse(reply, () => getCloseAccountsForTag(params.data.tagId), 'Tag not found')
  })

  fastify.get('/explorer/tag/:tagId/activity', async (req, reply) => {
    const params = tagParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid tag id' })
    const q = req.query as Record<string, unknown>
    const activityType = activityTypeParam(q)
    const maxOffset = maxScopedActivityOffsetFor(q, activityType)
    const offset = boundedActivityOffset(q, maxOffset)
    if (offset == null) return reply.status(400).send({ error: `Activity offset must be between 0 and ${maxOffset}` })
    const rows = await getTagActivity(params.data.tagId, activityType, limitParam(q, 40), offset, textParam(q, 'action', 32), valueFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
    if (!rows) return reply.status(404).send({ error: 'Tag not found' })
    return rows
  })

  fastify.get('/explorer/tag/:tagId/extrinsics', async (req, reply) => {
    const params = tagParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid tag id' })
    const q = req.query as Record<string, unknown>
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    const rows = await getTagExtrinsics(params.data.tagId, limitParam(q, 25), offset, extrinsicFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
    if (!rows) return reply.status(404).send({ error: 'Tag not found' })
    return rows
  })

  fastify.get('/explorer/tag/:tagId/events', async (req, reply) => {
    const params = tagParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid tag id' })
    const q = req.query as Record<string, unknown>
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    const rows = await getTagEvents(params.data.tagId, limitParam(q, 25), offset, eventFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
    if (!rows) return reply.status(404).send({ error: 'Tag not found' })
    return rows
  })

  fastify.get('/explorer/tag/:tagId/votes', async (req, reply) => {
    const params = tagParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid tag id' })
    const q = req.query as Record<string, unknown>
    const offset = activityOffsetParam(q, 'vote')
    if (offset == null) return reply.status(400).send({ error: `Votes offset must be between 0 and ${maxActivityOffsetFor('vote')}` })
    const rows = await getTagVotes(params.data.tagId, limitParam(q, 25), offset, dateParam(q, 'from'), dateParam(q, 'to'))
    if (!rows) return reply.status(404).send({ error: 'Tag not found' })
    return rows
  })

  fastify.get('/explorer/address/:address', async (req, reply) => {
    const params = addressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    const detail = await getAddress(params.data.address, { summary: (req.query as { summary?: string })?.summary === '1' })
    if (!detail) return reply.status(404).send({ error: 'Address not recognized' })
    return detail
  })

  fastify.get('/explorer/address/:address/close-accounts', async (req, reply) => {
    const params = analyzableAddressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    return closeAccountsResponse(reply, () => getCloseAccounts(params.data.address), 'Address not recognized')
  })

  fastify.get('/explorer/address/:address/history', async (req, reply) => {
    const params = addressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    const history = await getAddressHistory(params.data.address)
    if (!history) return reply.status(404).send({ error: 'Address not recognized' })
    return history
  })

  fastify.get('/explorer/address/:address/activity', async (req, reply) => {
    const params = addressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    const q = req.query as Record<string, unknown>
    const activityType = activityTypeParam(q)
    const maxOffset = maxScopedActivityOffsetFor(q, activityType)
    const offset = boundedActivityOffset(q, maxOffset)
    if (offset == null) return reply.status(400).send({ error: `Activity offset must be between 0 and ${maxOffset}` })
    const rows = await getAddressActivity(params.data.address, activityType, limitParam(q, 40), offset, textParam(q, 'action', 32), valueFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
    if (!rows) return reply.status(404).send({ error: 'Address not recognized' })
    return rows
  })

  fastify.get('/explorer/address/:address/extrinsics', async (req, reply) => {
    const params = addressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    const q = req.query as Record<string, unknown>
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    const rows = await getAddressExtrinsics(params.data.address, limitParam(q, 25), offset, extrinsicFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
    if (!rows) return reply.status(404).send({ error: 'Address not recognized' })
    return rows
  })

  fastify.get('/explorer/address/:address/events', async (req, reply) => {
    const params = addressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    const q = req.query as Record<string, unknown>
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    const rows = await getAddressEvents(params.data.address, limitParam(q, 25), offset, eventFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
    if (!rows) return reply.status(404).send({ error: 'Address not recognized' })
    return rows
  })

  fastify.get('/explorer/address/:address/votes', async (req, reply) => {
    const params = addressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    const q = req.query as Record<string, unknown>
    const offset = activityOffsetParam(q, 'vote')
    if (offset == null) return reply.status(400).send({ error: `Votes offset must be between 0 and ${maxActivityOffsetFor('vote')}` })
    const rows = await getAddressVotes(params.data.address, limitParam(q, 25), offset, dateParam(q, 'from'), dateParam(q, 'to'))
    if (!rows) return reply.status(404).send({ error: 'Address not recognized' })
    return rows
  })

  fastify.get('/explorer/address/:address/counts', async (req, reply) => {
    const params = analyzableAddressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    const counts = await getAddressTabCounts(params.data.address)
    if (!counts) return reply.status(404).send({ error: 'Address not recognized' })
    return counts
  })

  fastify.get('/explorer/tag/:tagId/counts', async (req, reply) => {
    const params = tagParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid tag' })
    const counts = await getTagTabCounts(params.data.tagId)
    if (!counts) return reply.status(404).send({ error: 'Tag not found' })
    return counts
  })

  // How many rows one of the detail page's lists holds under exactly the filters it
  // is showing — the total its pager numbers pages from. `complete: false` means the
  // total is exact for the newest rows it covers but the list runs deeper than one
  // candidate window reaches, which the page states rather than implying the list
  // ends at the last page it can offer. `total: null` means no prefix could be
  // established at all.
  fastify.get('/explorer/address/:address/list-count', async (req, reply) => {
    const params = analyzableAddressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    const query = scopedListQuery(req.query as Record<string, unknown>)
    if (!query) return reply.status(400).send({ error: `List tab must be one of ${listTabSchema.options.join(', ')}` })
    const total = await getAddressListTotal(params.data.address, query)
    if (total === undefined) return reply.status(404).send({ error: 'Address not recognized' })
    return total
  })

  fastify.get('/explorer/tag/:tagId/list-count', async (req, reply) => {
    const params = tagParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid tag id' })
    const query = scopedListQuery(req.query as Record<string, unknown>)
    if (!query) return reply.status(400).send({ error: `List tab must be one of ${listTabSchema.options.join(', ')}` })
    const total = await getTagListTotal(params.data.tagId, query)
    if (total === undefined) return reply.status(404).send({ error: 'Tag not found' })
    return total
  })

  // Largest value-changing events (big transfers/swaps/liquidations) for the
  // value-history chart's markers. Optional from/to day bounds; the default is
  // the account's full indexed range — the same span the chart draws.
  fastify.get('/explorer/address/:address/value-events', async (req, reply) => {
    const params = addressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    const q = req.query as Record<string, unknown>
    const rows = await getAddressValueEvents(params.data.address, dateParam(q, 'from'), dateParam(q, 'to'))
    if (!rows) return reply.status(404).send({ error: 'Address not recognized' })
    return rows
  })

  fastify.get('/explorer/tag/:tagId/value-events', async (req, reply) => {
    const params = tagParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid tag id' })
    const q = req.query as Record<string, unknown>
    const rows = await getTagValueEvents(params.data.tagId, dateParam(q, 'from'), dateParam(q, 'to'))
    if (!rows) return reply.status(404).send({ error: 'Tag not found' })
    return rows
  })

  fastify.get('/explorer/hdx', async () => {
    return getHdxDashboard()
  })

  fastify.get('/explorer/hollar', async () => {
    return getHollarDashboard()
  })

  fastify.get('/explorer/search', async (req) => {
    const q = z.object({ q: z.string().min(1).max(128) }).safeParse(req.query)
    if (!q.success) return []
    return search(q.data.q)
  })
}
