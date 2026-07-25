import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { getReferenda, getReferendum, parseReferendumPallet } from '../services/governanceService.ts'
import { extrinsicEncoded } from '../services/extrinsicBytes.ts'
import {
  getStats, getRecentBlocks, getBlock, getRecentExtrinsics, getExtrinsic, getExtrinsicAt,
  getExtrinsicActivity, getBlockActivity,
  getHolders, getAddress, getAddressHistory, search, getAssets, getAccounts, getDcaSchedule, getDcaScheduleIdAt, getDcaExecution,
  getRecentEvents, getEventAt, getTradeDetail, getTradeDetailByEvent, getRecentActivity, getMoneyMarket, getAssetDetail, getAssetActivity, getDailyActivity, getDailyAccounts, getListCounts, getTag,
  getAddressActivity, getAddressExtrinsics, getAddressEvents, getAddressTabCounts, getTagTabCounts,
  getAddressListTotal, getTagListTotal,
  getAddressValueEvents, getTagValueEvents,
  getTagActivity, getTagExtrinsics, getTagEvents,
  getAddressVotes, getTagVotes,
  type EventListFilters,
  type ExtrinsicListFilters,
  type ScopedListQuery,
  type ScopedListTab,
  type ValueListFilters,
} from '../services/explorerService.ts'
import { getHdxDashboard } from '../services/hdxService.ts'
import { getHollarDashboard } from '../services/hollarService.ts'
import { ACCOUNT_AFFINITY_BUSY_CODE, getCloseAccounts, getCloseAccountsForTag } from '../services/accountAffinityService.ts'

const activityTypes = ['all', 'transfer', 'trade', 'dca', 'liquidity', 'mm', 'xcm', 'staking', 'vote', 'otc']
const uint32Param = z.coerce.number().int().min(0).max(0xffff_ffff)

// Public list endpoints never render more than 100 rows at once. A modest hard
// cap prevents a single request from multiplying the feed candidate scans.
const limitSchema = z.coerce.number().int().min(1).max(250).optional()
const accountSortSchema = z.enum(['value', 'supplied', 'borrowed', 'health', 'identity', 'activity', 'volume', 'liquidation'])
const addressParam = z.object({ address: z.string().min(1).max(128) })
const analyzableAddressParam = z.object({ address: z.string().min(3).max(128) })
const tagParam = z.object({ tagId: z.string().min(1).max(64) })
// Activity builders classify several indexed sources together. Keep offset pages
// bounded so one request cannot allocate every preceding semantic row in Node.
const MAX_ACTIVITY_OFFSET = 10_000
// A single bound across every category either starves the cheap tabs or lets the
// expensive ones time out. Measured warm at /explorer/activity?limit=25&offset=10000:
//   otc 0.007s  staking 0.027s  vote 0.051s  trade 0.093s  liquidity 0.267s
//   dca 0.319s  mm 0.413s  all 1.153s  transfer 4.233s  xcm 37.806s
// The deep set is the categories whose whole feed is reachable because the source
// itself is small — vote_activity 121,078 rows, staking_activity 192,006, otc_activity
// 4,473 — so a deep offset cannot explode no matter how far it is pushed. The wide
// feeds read multi-million-row sources (transfer_activity 78.5M, xcm 55.8M), where the
// cost does grow with depth, and keep the conservative bound.
//
// This is what withheld /activity?tab=vote&page=490: the vote feed is 4,843 pages of
// 25 and 92% of them sat behind a cap that costs it 51ms to serve.
const MAX_NARROW_ACTIVITY_OFFSET = 250_000
const NARROW_ACTIVITY_TYPES = new Set(['vote', 'staking', 'otc'])
const maxActivityOffsetFor = (type: string) =>
  NARROW_ACTIVITY_TYPES.has(type) ? MAX_NARROW_ACTIVITY_OFFSET : MAX_ACTIVITY_OFFSET
// Account and tag activity is bounded by the builder's candidate ceiling instead:
// it grows ONE window until the classified feed is complete, so the depth of a
// page only changes which slice of that window is returned — and it is the same
// window the exact row total is counted from. Every page a real total implies is
// therefore servable. The bound here only has to stay above any countable feed
// length: ten sources at the 90k candidate ceiling each.
const MAX_SCOPED_ACTIVITY_OFFSET = 900_000
const activityOffsetSchema = z.coerce.number().int().min(0).max(MAX_SCOPED_ACTIVITY_OFFSET).optional()
const dateRe = /^\d{4}-\d{2}-\d{2}$/
function dateParam(q: Record<string, unknown>, key: string): string | undefined {
  const v = q[key]
  if (typeof v !== 'string' || !dateRe.test(v)) return undefined
  const parsed = new Date(`${v}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v ? v : undefined
}
function offsetParam(q: Record<string, unknown>): number {
  const n = z.coerce.number().int().min(0).max(20_000_000).safeParse(q.offset)
  return n.success ? n.data : 0
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
  return typeof query.type === 'string' && activityTypes.includes(query.type) ? query.type : 'all'
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
  fastify.get('/explorer/stats', async () => getStats())

  fastify.get('/explorer/assets', async () => getAssets())

  fastify.get('/explorer/accounts', async (req) => {
    const q = req.query as Record<string, unknown>
    const limit = limitParam(q, 50)
    const offset = offsetParam(q)
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

  fastify.get('/explorer/counts', async () => getListCounts())

  fastify.get('/explorer/blocks', async (req) => {
    const q = req.query as Record<string, unknown>
    return getRecentBlocks(limitParam(q, 25), offsetParam(q))
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

  fastify.get('/explorer/extrinsics', async (req) => {
    const q = req.query as Record<string, unknown>
    const limit = limitParam(q, 25)
    const signedOnly = q.signedOnly === 'true' || q.signedOnly === '1'
    return getRecentExtrinsics(limit, signedOnly, dateParam(q, 'from'), dateParam(q, 'to'), offsetParam(q), extrinsicFilters(q))
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

  fastify.get('/explorer/referenda', async (req) => {
    const q = req.query as Record<string, unknown>
    return getReferenda(limitParam(q, 100), offsetParam(q))
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
    const detail = await getDcaSchedule(params.data.scheduleId, offsetParam(q), limitParam(q, 25))
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

  fastify.get('/explorer/events', async (req) => {
    const q = req.query as Record<string, unknown>
    return getRecentEvents(limitParam(q, 25), dateParam(q, 'from'), dateParam(q, 'to'), offsetParam(q), {
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
    return getHolders(params.data.assetId, limit, offsetParam(q))
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
    const offset = boundedActivityOffset(q, MAX_SCOPED_ACTIVITY_OFFSET)
    if (offset == null) return reply.status(400).send({ error: `Activity offset must be between 0 and ${MAX_SCOPED_ACTIVITY_OFFSET}` })
    const rows = await getTagActivity(params.data.tagId, activityType, limitParam(q, 40), offset, textParam(q, 'action', 32), valueFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
    if (!rows) return reply.status(404).send({ error: 'Tag not found' })
    return rows
  })

  fastify.get('/explorer/tag/:tagId/extrinsics', async (req, reply) => {
    const params = tagParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid tag id' })
    const q = req.query as Record<string, unknown>
    const rows = await getTagExtrinsics(params.data.tagId, limitParam(q, 25), offsetParam(q), extrinsicFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
    if (!rows) return reply.status(404).send({ error: 'Tag not found' })
    return rows
  })

  fastify.get('/explorer/tag/:tagId/events', async (req, reply) => {
    const params = tagParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid tag id' })
    const q = req.query as Record<string, unknown>
    const rows = await getTagEvents(params.data.tagId, limitParam(q, 25), offsetParam(q), eventFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
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
    const offset = boundedActivityOffset(q, MAX_SCOPED_ACTIVITY_OFFSET)
    if (offset == null) return reply.status(400).send({ error: `Activity offset must be between 0 and ${MAX_SCOPED_ACTIVITY_OFFSET}` })
    const rows = await getAddressActivity(params.data.address, activityType, limitParam(q, 40), offset, textParam(q, 'action', 32), valueFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
    if (!rows) return reply.status(404).send({ error: 'Address not recognized' })
    return rows
  })

  fastify.get('/explorer/address/:address/extrinsics', async (req, reply) => {
    const params = addressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    const q = req.query as Record<string, unknown>
    const rows = await getAddressExtrinsics(params.data.address, limitParam(q, 25), offsetParam(q), extrinsicFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
    if (!rows) return reply.status(404).send({ error: 'Address not recognized' })
    return rows
  })

  fastify.get('/explorer/address/:address/events', async (req, reply) => {
    const params = addressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    const q = req.query as Record<string, unknown>
    const rows = await getAddressEvents(params.data.address, limitParam(q, 25), offsetParam(q), eventFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
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

  // How many rows one of the detail page's lists holds under exactly the filters
  // it is showing — the total its pager numbers pages from. `total: null` means the
  // list is real but too deep to walk to its end, which the page states instead of
  // publishing an estimate.
  fastify.get('/explorer/address/:address/list-count', async (req, reply) => {
    const params = analyzableAddressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    const query = scopedListQuery(req.query as Record<string, unknown>)
    if (!query) return reply.status(400).send({ error: `List tab must be one of ${listTabSchema.options.join(', ')}` })
    const total = await getAddressListTotal(params.data.address, query)
    if (total === undefined) return reply.status(404).send({ error: 'Address not recognized' })
    return { total }
  })

  fastify.get('/explorer/tag/:tagId/list-count', async (req, reply) => {
    const params = tagParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid tag id' })
    const query = scopedListQuery(req.query as Record<string, unknown>)
    if (!query) return reply.status(400).send({ error: `List tab must be one of ${listTabSchema.options.join(', ')}` })
    const total = await getTagListTotal(params.data.tagId, query)
    if (total === undefined) return reply.status(404).send({ error: 'Tag not found' })
    return { total }
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
