import type { FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import { requireUser } from '../services/userAuthService.ts'
import { noStore, withUserErrors } from './user.ts'
import {
  channelsFor, getChannel, createWebPushChannel, deleteChannel,
  rulesFor, createRule, findEquivalentRule, updateRule, deleteRule,
  queryInbox, unreadCount, markInboxRead, clearInbox,
  type InboxRow, type NotificationChannel, type NotificationRule, type TelegramConfig, type WebPushConfig,
} from '../notifications/notificationStore.ts'
import { NOTIFICATION_KINDS, describeRule, KIND_LABELS, type NotificationKind } from '../notifications/notificationRules.ts'
import { activityTargetOf, resolveActivityTarget } from '../notifications/ruleTargets.ts'
import { assetDescriptor } from '../services/explorerAssets.ts'
import { accountRef, resolveDisplayAccountId } from '../services/explorerService.ts'
import { normalizeAddress } from '../services/addressIdentity.ts'
import { renderNotification, text } from '../notifications/render.ts'
import { sendToChannel, vapidPublicKey, webPushConfigured, telegramConfigured } from '../notifications/delivery.ts'
import { createTelegramLink, telegramLinkStatus, telegramBotUsername } from '../notifications/telegramBot.ts'

// Per-account notification management. Everything lives under
// /user/notifications/ so the nginx uncached /api/user/ location and this
// plugin's no-store stamping cover it without a second rule.
//
// A channel's config is a credential (a push endpoint plus its keys, or a
// Telegram chat id) and never leaves the server: a webpush channel is
// described by its endpoint's HOST alone, a telegram channel by its @username.

function channelRef(c: NotificationChannel) {
  return {
    id: c.channelId,
    kind: c.kind,
    label: c.label,
    verified: c.verified,
    ...(c.kind === 'webpush' ? { endpointHost: endpointHost((c.config as WebPushConfig).endpoint) } : {}),
    ...(c.kind === 'telegram' ? { username: (c.config as TelegramConfig).username } : {}),
  }
}
function endpointHost(endpoint: string): string {
  try { return new URL(endpoint).host } catch { return '' }
}

// The summary names assets by ticker, from the shared asset registry — a rules
// list that said "asset 0" would be the only surface in the explorer that does.
//
// A tag target additionally ships its RESOLVED presentation (name, member
// count, icon, colour), because the params alone carry only ids: the client has
// the system tag directory and its own tag map, but resolving a rule from them
// would duplicate the server's own visibility rule. The block is absent for an
// address rule, and for a tag the owner can no longer see — which is exactly
// how a rule that has gone quiet renders as having gone quiet.
function ruleRef(r: NotificationRule) {
  const target = activityTargetOf(r.kind, r.params)
  const resolved = target ? resolveActivityTarget(r.accountId, target) : null
  return {
    id: r.ruleId,
    kind: r.kind,
    kindLabel: KIND_LABELS[r.kind],
    name: r.name,
    summary: describeRule(r.kind, r.params, assetId => assetDescriptor(assetId).symbol, t => resolveActivityTarget(r.accountId, t)),
    params: r.params,
    channels: r.channels,
    muted: r.muted,
    cooldownS: r.cooldownS,
    ...(resolved
      ? { targetLabel: resolved.name, targetMemberCount: resolved.memberCount, targetIcon: resolved.icon, targetColor: resolved.color }
      : {}),
    // An ADDRESS target resolves to nothing above — there is no tag to name — so
    // it ships the account itself, resolved exactly as every other surface
    // resolves one. Without it the rules list had no way to draw the account and
    // fell back to the bare truncated address baked into the rule's name.
    ...(addressTargetOf(r) ? { targetAccount: addressRefOf(addressTargetOf(r)!) } : {}),
  }
}

// The address a rule watches, whichever kind carries one. `activityTargetOf`
// answers for the two kinds the EVALUATOR groups by; a liquidation rule targets
// an account too and its row deserves the same pill.
function addressTargetOf(r: NotificationRule): string | null {
  const activity = activityTargetOf(r.kind, r.params)
  if (activity?.kind === 'address') return activity.address
  if (r.kind !== 'liquidation') return null
  const t = (r.params as { target?: { kind?: string; address?: string } }).target
  return t?.kind === 'address' && typeof t.address === 'string' ? t.address : null
}

// The account behind an address target, or null for an address that no longer
// parses. `resolveDisplayAccountId` first, so the ref is keyed the same way the
// explorer keys one — an EVM account and its substrate form are one account, and
// the emoji is derived from that id rather than from whichever form was typed.
function addressRefOf(address: string) {
  const n = normalizeAddress(address)
  return n ? accountRef(resolveDisplayAccountId(n.accountId)) : null
}

// `notificationId` is the deterministic dedup identity; the client only ever
// needs it as an opaque row id (mark-read), so it ships as `id`.
function inboxRef(r: InboxRow) {
  return {
    id: r.notificationId, ruleId: r.ruleId, kind: r.kind, kindLabel: KIND_LABELS[r.kind as NotificationKind] ?? r.kind,
    title: r.title, body: r.body, url: r.url, blockHeight: r.blockHeight, read: r.read, createdAt: r.createdAt,
  }
}

const webPushBody = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2048),
    keys: z.object({ p256dh: z.string().min(8).max(256), auth: z.string().min(8).max(256) }),
  }),
  label: z.string().max(64).optional(),
})
const createRuleBody = z.object({
  kind: z.enum(NOTIFICATION_KINDS),
  params: z.unknown(),
  name: z.string().max(64).optional(),
  channels: z.array(z.string().uuid()).max(20).optional(),
  cooldownS: z.number().int().min(0).max(86_400).optional(),
})
const patchRuleBody = z.object({
  muted: z.boolean().optional(),
  name: z.string().max(64).optional(),
  params: z.unknown().optional(),
  channels: z.array(z.string().uuid()).max(20).optional(),
  cooldownS: z.number().int().min(0).max(86_400).optional(),
})
const readBody = z.object({ ids: z.array(z.string().max(128)).max(500).optional() })
const idParam = z.object({ id: z.string().min(1).max(128) })
const codeParam = z.object({ code: z.string().regex(/^[0-9a-f]{8,64}$/) })
const inboxQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
})

export async function notificationRoutes(fastify: FastifyInstance) {
  // Scoped to this plugin's encapsulation context — other routes unaffected.
  await fastify.register(rateLimit, { max: 120, timeWindow: '1 minute' })

  fastify.get('/user/notifications/overview', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    return {
      channels: channelsFor(accountId).map(channelRef),
      rules: rulesFor(accountId).map(ruleRef),
      unread: await unreadCount(accountId),
      vapidPublicKey: webPushConfigured() ? vapidPublicKey() : '',
      telegramBot: telegramConfigured() ? telegramBotUsername() : '',
    }
  })

  // Without VAPID keys the server cannot sign a push, so accepting a
  // subscription would store a credential it can never use.
  fastify.post('/user/notifications/channels/webpush', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    if (!webPushConfigured()) return reply.status(503).send({ error: 'Web Push is not configured on this deployment' })
    const body = webPushBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid push subscription' })
    return withUserErrors(reply, async () => {
      const channel = await createWebPushChannel(
        accountId,
        { endpoint: body.data.subscription.endpoint, p256dh: body.data.subscription.keys.p256dh, auth: body.data.subscription.keys.auth },
        body.data.label ?? '',
      )
      return channelRef(channel)
    })
  })

  fastify.post('/user/notifications/channels/telegram/link', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    if (!telegramConfigured()) return reply.status(503).send({ error: 'Telegram is not configured on this deployment' })
    const link = createTelegramLink(accountId)
    if (!link) return reply.status(503).send({ error: 'Too many pending link codes — try again shortly' })
    return link
  })

  fastify.get('/user/notifications/channels/telegram/link/:code', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const params = codeParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid link code' })
    return { status: telegramLinkStatus(params.data.code, accountId) }
  })

  fastify.delete('/user/notifications/channels/:id', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const params = idParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid channel id' })
    return withUserErrors(reply, async () => {
      await deleteChannel(accountId, params.data.id)
      return { ok: true }
    })
  })

  // A real send through the real renderer — the point is to prove the whole
  // path (formatting included), not just that the channel row exists.
  fastify.post('/user/notifications/channels/:id/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const params = idParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid channel id' })
    const channel = getChannel(params.data.id)
    if (!channel || channel.accountId !== accountId) return reply.status(404).send({ error: 'Channel not found' })
    if (channel.kind === 'webpush' && !webPushConfigured()) return reply.status(503).send({ error: 'Web Push is not configured on this deployment' })
    if (channel.kind === 'telegram' && !telegramConfigured()) return reply.status(503).send({ error: 'Telegram is not configured on this deployment' })
    const rendered = renderNotification({
      title: [text('Test alert')],
      body: [[text('Your Hydration Explorer alerts are working.')]],
      path: '/notifications',
    })
    // Fire-and-forget like every other send: the reply says the test was
    // dispatched, and a failing channel surfaces as an unverified channel.
    void sendToChannel(channel, rendered, 'test').catch(() => {})
    return { ok: true }
  })

  fastify.post('/user/notifications/rules', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const body = createRuleBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid alert' })
    return withUserErrors(reply, async () => {
      // Creating is idempotent: the same subscribe affordance is reachable from
      // several surfaces, and pressing it twice must return the rule the account
      // already has (muted or not) rather than a duplicate that then delivers
      // every match twice. `existing` lets the UI say "you already have this"
      // instead of "created".
      const existing = findEquivalentRule(accountId, body.data.kind, body.data.params)
      if (existing) return { ...ruleRef(existing), existing: true }
      return ruleRef(await createRule(accountId, body.data))
    })
  })

  fastify.patch('/user/notifications/rules/:id', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const params = idParam.safeParse(req.params)
    const body = patchRuleBody.safeParse(req.body)
    if (!params.success || !body.success) return reply.status(400).send({ error: 'Invalid alert update' })
    // `params: undefined` and "no params key" are the same request over JSON,
    // so only forward the keys the caller actually sent.
    const patch = Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined))
    return withUserErrors(reply, async () => ruleRef(await updateRule(accountId, params.data.id, patch)))
  })

  fastify.delete('/user/notifications/rules/:id', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const params = idParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid alert id' })
    return withUserErrors(reply, async () => {
      await deleteRule(accountId, params.data.id)
      return { ok: true }
    })
  })

  fastify.get('/user/notifications/inbox', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const query = inboxQuery.safeParse(req.query ?? {})
    if (!query.success) return reply.status(400).send({ error: 'Invalid inbox query' })
    const { rows, total, unread } = await queryInbox(accountId, query.data.limit, query.data.offset)
    return { rows: rows.map(inboxRef), unread, total }
  })

  fastify.post('/user/notifications/inbox/read', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const body = readBody.safeParse(req.body ?? {})
    if (!body.success) return reply.status(400).send({ error: 'Invalid read request' })
    const marked = await markInboxRead(accountId, body.data.ids)
    return { ok: true, marked, unread: await unreadCount(accountId) }
  })

  // Emptying the history. The RULES are untouched — they keep firing, and the
  // next match lands in an inbox that is empty rather than in one that has been
  // switched off. Nothing that was already delivered can be delivered again
  // afterwards: the dedup seed at boot reads soft-deleted rows too.
  fastify.post('/user/notifications/inbox/clear', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const cleared = await clearInbox(accountId)
    return { ok: true, cleared, unread: 0 }
  })
}
