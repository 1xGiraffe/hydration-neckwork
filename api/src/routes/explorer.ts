import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  getStats, getRecentBlocks, getBlock, getRecentExtrinsics, getExtrinsic, getExtrinsicAt,
  getExtrinsicActivity, getBlockActivity,
  getHolders, getAddress, getAddressHistory, search, getAssets, getAccounts, getDcaSchedule, getDcaScheduleIdAt, getDcaExecution,
  getRecentEvents, getEventAt, getTradeDetail, getTradeDetailByEvent, getRecentActivity, getMoneyMarket, getAssetDetail, getAssetActivity, getDailyActivity, getDailyAccounts, getListCounts, getTag,
  getAddressActivity, getAddressExtrinsics, getAddressEvents, getAddressTabCounts, getTagTabCounts,
  getAddressActivityCountAtMin, getTagActivityCountAtMin,
  getAddressValueEvents, getTagValueEvents,
  getTagActivity, getTagExtrinsics, getTagEvents,
  getAddressVotes, getTagVotes,
  type EventListFilters,
  type ExtrinsicListFilters,
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
const activityCountQuery = z.object({ min: z.coerce.number().min(0).max(1e12) })
// Activity builders classify several indexed sources together. Keep offset pages
// bounded; account/tag last-page navigation uses the independently bounded tail
// mode instead of allocating every preceding semantic row in Node.
const MAX_ACTIVITY_OFFSET = 10_000
const MAX_ACTIVITY_TAIL = 6_000
const activityOffsetSchema = z.coerce.number().int().min(0).max(MAX_ACTIVITY_OFFSET).optional()
const tailSchema = z.coerce.number().int().min(0).max(MAX_ACTIVITY_TAIL).optional()
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

function tailParam(query: Record<string, unknown>): number | undefined | null {
  if (query.tail == null || query.tail === '') return undefined
  const parsed = tailSchema.safeParse(query.tail)
  return parsed.success ? parsed.data : null
}

function activityOffsetParam(query: Record<string, unknown>): number | null {
  const parsed = activityOffsetSchema.safeParse(query.offset)
  return parsed.success ? parsed.data ?? 0 : null
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
    const offset = activityOffsetParam(q)
    if (offset == null) return reply.status(400).send({ error: `Activity offset must be between 0 and ${MAX_ACTIVITY_OFFSET}` })
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
    const tail = tailParam(q)
    const offset = tail == null ? activityOffsetParam(q) : 0
    if (tail === null || offset == null) return reply.status(400).send({ error: `Activity offset/tail exceeds the supported ${MAX_ACTIVITY_OFFSET}/${MAX_ACTIVITY_TAIL} row window` })
    const rows = await getTagActivity(params.data.tagId, activityTypeParam(q), limitParam(q, 40), offset, textParam(q, 'action', 32), valueFilters(q), dateParam(q, 'from'), dateParam(q, 'to'), tail)
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
    const offset = activityOffsetParam(q)
    if (offset == null) return reply.status(400).send({ error: `Votes offset must be between 0 and ${MAX_ACTIVITY_OFFSET}` })
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
    const tail = tailParam(q)
    const offset = tail == null ? activityOffsetParam(q) : 0
    if (tail === null || offset == null) return reply.status(400).send({ error: `Activity offset/tail exceeds the supported ${MAX_ACTIVITY_OFFSET}/${MAX_ACTIVITY_TAIL} row window` })
    const rows = await getAddressActivity(params.data.address, activityTypeParam(q), limitParam(q, 40), offset, textParam(q, 'action', 32), valueFilters(q), dateParam(q, 'from'), dateParam(q, 'to'), tail)
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
    const offset = activityOffsetParam(q)
    if (offset == null) return reply.status(400).send({ error: `Votes offset must be between 0 and ${MAX_ACTIVITY_OFFSET}` })
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

  // Activity row count under a value filter (the smol threshold / custom $-min),
  // powering exact last-page jumps while the filter hides rows. `activity` is
  // null until the value-aware activity index finishes its backfill.
  fastify.get('/explorer/address/:address/activity-count', async (req, reply) => {
    const params = analyzableAddressParam.safeParse(req.params)
    const query = activityCountQuery.safeParse(req.query)
    if (!params.success || !query.success) return reply.status(400).send({ error: 'Invalid request' })
    // null covers both "index not ready" and "unknown address" — the pager
    // simply has no total in either case.
    return { activity: await getAddressActivityCountAtMin(params.data.address, query.data.min) }
  })

  fastify.get('/explorer/tag/:tagId/activity-count', async (req, reply) => {
    const params = tagParam.safeParse(req.params)
    const query = activityCountQuery.safeParse(req.query)
    if (!params.success || !query.success) return reply.status(400).send({ error: 'Invalid request' })
    return { activity: await getTagActivityCountAtMin(params.data.tagId, query.data.min) }
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
