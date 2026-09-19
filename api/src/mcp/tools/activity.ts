/**
 * `get_activity` — the classified feed, global or scoped.
 *
 * The feed is the explorer's reading of what each user DID: one economic action
 * per row, with the plumbing legs suppressed, every amount scaled by its own
 * asset's decimals and valued in USD. This tool routes the scope to the right
 * upstream path, enforces the per-category offset ceilings BEFORE the call so
 * an agent learns the bound instead of receiving a raw 400, and says in the
 * answer exactly which filters were applied — because two of them (`action`
 * and `token`) fall back silently upstream and an empty page is otherwise
 * indistinguishable from a quiet chain.
 */

import { z } from 'zod'
import { formatParam } from '../toolTypes.ts'
import type { ToolDefinition, ToolError } from '../toolTypes.ts'
import type { ActivityRow } from '../types.ts'
import { invalidArgument, toolErrorFromUpstream } from '../errors.ts'
import { budget, h2, joinBlocks, note } from '../format/md.ts'
import {
  ACTIVITY_ACTIONS, ACTIVITY_ROW_TYPES, ACTIVITY_TYPES, ACTIVITY_TYPE_NOTES,
  TYPES_WITH_ACTIONS, actionsForType, activityLine, describeActivityFilters, unconfirmedNote,
} from '../format/activity.ts'
import { RE_HASH64, addressNotFound, callHint, failure, output, parseInput, parseCoordinate, resolveAssetToken, settle } from './shared.ts'

const DEFAULT_LIMIT = 25

/* ============ offset ceilings ============ */

/**
 * The bounds the upstream enforces with a 400 (catalogue § 0). They exist
 * because a deep page of a classified feed cannot be located by SQL offset
 * alone — the classification runs in Node over a window — so past the bound the
 * route refuses rather than silently serving page one.
 */
const MAX_GLOBAL_WIDE_OFFSET = 2_500
const MAX_GLOBAL_NARROW_OFFSET = 250_000
const MAX_WINDOWED_SCOPED_OFFSET = 900_000
const MAX_LOCATED_SCOPED_OFFSET = 5_000_000

/** The global feed's wide categories; everything else there is narrow. */
const WIDE_TYPES = new Set(['all', 'transfer', 'trade', 'dca', 'liquidity', 'mm', 'xcm'])
/**
 * Types an account/tag feed can LOCATE by offset rather than by window.
 *
 * Mirrors `EXACTLY_COUNTABLE_ACTIVITY_TYPES` upstream, read through the same two
 * translations the route applies before it tests membership: `stake` is aliased
 * to the row type `staking`, and `dca` is normalized to `trade`. Leaving `dca`
 * out refused, with a 900,000 ceiling, deep pages the upstream serves to
 * 5,000,000 — a bound the caller cannot check and would have believed.
 * `xcswap` is the one query type that is genuinely not countable.
 */
const COUNTABLE_TYPES = new Set(['all', 'transfer', 'trade', 'dca', 'liquidity', 'mm', 'xcm', 'vote', 'stake', 'bond', 'intent', 'otc'])

type Scope = 'global' | 'account' | 'tag' | 'asset' | 'block' | 'extrinsic'

/**
 * `YYYY-MM-DD` AND a day that exists. The schema's regex cannot tell the two
 * apart, and the upstream's own guard (`isCalendarDay` in routes/explorer.ts)
 * refuses the difference with a 400 that reads as a format complaint.
 */
function isCalendarDay(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false
  const parsed = new Date(`${raw}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw
}

interface Ceiling { max: number; label: string; advice: string }

function ceilingFor(scope: Scope, type: string, windowed: boolean): Ceiling | null {
  if (scope === 'block' || scope === 'extrinsic') return null
  if (scope === 'global' || scope === 'asset') {
    return WIDE_TYPES.has(type)
      ? { max: MAX_GLOBAL_WIDE_OFFSET, label: `the global feed's wide categories (${[...WIDE_TYPES].join(', ')})`, advice: 'Narrow to one of the rarer types (vote, stake, otc, bond, intent, xcswap) to reach 250,000, or move the window with `from`/`to` instead of paging deeper, or scope the read to an account or a tag.' }
      : { max: MAX_GLOBAL_NARROW_OFFSET, label: 'the global feed\'s narrow categories', advice: 'Move the window with `from`/`to` instead of paging deeper, or scope the read to an account or a tag.' }
  }
  return windowed
    ? { max: MAX_WINDOWED_SCOPED_OFFSET, label: 'a windowed account/tag feed (a `minUsd` or `identity` filter is set)', advice: 'Drop `minUsd` and `identity` and use a countable `type` to reach the located ceiling of 5,000,000, or move the window with `from`/`to`.' }
    : { max: MAX_LOCATED_SCOPED_OFFSET, label: 'a located account/tag feed', advice: 'Move the window with `from`/`to` rather than paging deeper.' }
}

/* ============ schema ============ */

const SHAPE = {
  scope: z.enum(['global', 'account', 'tag', 'asset', 'block', 'extrinsic']).optional().describe('Optional, and normally inferred from whichever target you set. Pass it only to state the intent explicitly; it must agree with the target.'),
  account: z.string().min(1).max(128).optional().describe('An address in any form (SS58 of any prefix, AccountId32, EVM H160). Rows are scoped to the account\'s whole RELATED set — its proxies, its bound EVM account, the multisigs it belongs to.'),
  tag: z.string().min(1).max(64).optional().describe('A system tag id (e.g. `treasury`). Rows are every tagged member\'s activity.'),
  asset: z.string().min(1).max(64).optional().describe('An asset id or symbol. This is a SCOPE SWITCH, not a filter: it moves the read to that asset\'s FULL history instead of the recent global window (and costs up to ~40 s on a cold read). To filter a feed by asset without changing the scope, use `token` instead.'),
  block: z.number().int().min(0).optional().describe('A block height. Returns that block\'s whole classified activity, unpaged; the other filters do not apply.'),
  extrinsic: z.string().min(1).max(128).optional().describe('An extrinsic hash or a `height-index` coordinate. Returns the activity that one extrinsic produced; the other filters do not apply.'),
  type: z.enum(ACTIVITY_TYPES).optional().describe(`Activity family (default all). One of: ${ACTIVITY_TYPES.join(', ')}. Read the traps in this description first — type=dca does NOT narrow to DCA (it selects the trade family, rows typed "trade"), and type=trade is a family that also returns otc, intent and xcswap rows.`),
  action: z.string().min(1).max(32).optional().describe('Sub-filter within a type; the accepted values are listed per type in this description. An unrecognised value is NOT an error upstream — it silently matches nothing.'),
  token: z.string().min(1).max(64).optional().describe('An asset symbol or id the row must reference. Matches every asset the source event touched, including nested pool assets and both legs of a pair. An unknown token silently returns nothing.'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Inclusive lower day bound, `YYYY-MM-DD`.'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Inclusive upper day bound, `YYYY-MM-DD`.'),
  minUsd: z.number().optional().describe('Floor on the row\'s own value. In USD unless `unit` is `token`, in which case it is a floor on the token amount.'),
  minRevenueUsd: z.number().optional().describe('Floor on the PROTOCOL REVENUE of the row\'s extrinsic, always in USD — a different quantity from the row\'s own value.'),
  unit: z.enum(['usd', 'token']).optional().describe('What `minUsd` means (default usd).'),
  identity: z.enum(['named', 'unnamed']).optional().describe('Keep only rows whose actor the explorer can name (`named`) or cannot (`unnamed`).'),
  limit: z.number().int().min(1).max(100).optional().describe(`Rows per page (default ${DEFAULT_LIMIT}, max 100).`),
  offset: z.number().int().min(0).optional().describe('Rows to skip. Hard-capped per category — see the ceilings in this description; the tool refuses past them and says how to narrow.'),
  format: formatParam,
}
const ACTION_TABLE = Object.entries(ACTIVITY_ACTIONS)
  .map(([type, actions]) => `  - type=${type}: ${actions.join(', ')}`)
  .join('\n')

const DESCRIPTION = `The classified Hydration activity feed: what people actually DID, one economic action per row, with the internal plumbing legs suppressed, every amount scaled and named, valued in USD, and linked to its own Explorer page.

This is the tool for "what happened" — recently, in a block, in one extrinsic, to one account, to one tag, or over one asset's whole history. It is NOT a raw event or extrinsic log: a DCA execution is one trade line rather than four transfer events, and a router swap is one swap rather than its hops. For the interpreted record of a single thing you already identified, use inspect_entity; for an account's balance sheet, use get_account.

SCOPE is chosen by whichever target you set, and you may set at most one: nothing = the recent global feed; \`account\` = that address's feed (scoped to its whole related set — proxies, bound EVM account, multisigs); \`tag\` = every member of a system tag; \`block\` = that block's whole activity, unpaged; \`extrinsic\` = what one extrinsic produced. \`asset\` is different and worth stating plainly: it is a SCOPE SWITCH, not a filter — it moves the read to that asset's FULL history rather than the recent window, and is expensive on a cold read. To filter a feed by asset while keeping the scope, pass \`token\` instead.

TYPE vocabulary (default \`all\`): ${ACTIVITY_TYPES.join(', ')}.

ACTION requires a TYPE and is validated here before the call. Upstream it is not a filter on its own — with no \`type\` the server ignores it and answers the unfiltered feed — and an unrecognised value is not an error either: scoped it returns an empty page, while on the global feed it walks the whole candidate set for about 45 seconds and then answers 503. So an \`action\` without a \`type\`, on a type that takes none, or outside its type's list is refused immediately with the accepted values:
${ACTION_TABLE}

${ACTIVITY_TYPE_NOTES} For DCA fills only, pass \`type=trade, action=dca\`, or keep the rows flagged \`dca\`. A ROW's own \`type\` is one of ${ACTIVITY_ROW_TYPES.join(', ')} — not the query vocabulary above.

Two more things that will make you state something false. Rows marked **unconfirmed** are not facts yet, and they come in TWO kinds that must not be quoted the same way: a transaction-pool row has no block at all (its height is a zero placeholder, never printed here, and its amounts are a dry-run projection), while a row above the finalized head is already in a real block whose height IS genuine and quotable — what is provisional there is only whether that block survives. The answer states which kind it carried. And this surface carries NO total row count (the upstream only counts votes), so never present a page count or "N results found" — page with \`offset\` until a page comes back short.

OFFSET CEILINGS, enforced here before the call: 2,500 on the global feed's wide categories (all, transfer, trade, dca, liquidity, mm, xcm); 250,000 on its narrow ones (vote, stake, otc, bond, intent, xcswap); 900,000 on an account or tag feed that carries a \`minUsd\` or \`identity\` filter; 5,000,000 on one that does not. Past a ceiling, move the window with \`from\`/\`to\` rather than paging deeper.`

/* ============ handler ============ */

export const activityTools: ToolDefinition[] = [{
  name: 'get_activity',
  title: 'Hydration activity feed',
  description: DESCRIPTION,
  inputSchema: SHAPE,
  async handler(input, ctx) {
    const parsed = parseInput(SHAPE, input)
    if (!parsed.ok) return failure(parsed.error)
    const args = parsed.value
    const base = ctx.explorerBaseUrl
    const limit = args.limit ?? DEFAULT_LIMIT
    const offset = args.offset ?? 0
    const type = args.type ?? 'all'

    const targets = ([
      ['account', args.account], ['tag', args.tag], ['asset', args.asset],
      ['block', args.block], ['extrinsic', args.extrinsic],
    ] as const).filter(([, value]) => value !== undefined && value !== null)
    if (targets.length > 1) {
      return failure(invalidArgument(`set at most one scope target; received ${targets.map(([name]) => name).join(' and ')}. Scopes do not compose — to see one account's trades in one asset, scope to the account and pass \`token\` for the asset.`))
    }
    const scope: Scope = (targets[0]?.[0] as Scope) ?? 'global'
    if (args.scope && args.scope !== scope) {
      return failure(invalidArgument(`scope "${args.scope}" needs its own target: pass \`${args.scope}\`. The request set ${targets.length ? `\`${targets[0][0]}\`` : 'no target'}.`))
    }

    // The regex accepts `2026-02-30`; the calendar does not, and upstream that
    // is a 400 whose text ("expected YYYY-MM-DD") reads as a format complaint
    // about a correctly formatted string.
    for (const [key, value] of [['from', args.from], ['to', args.to]] as const) {
      if (value && !isCalendarDay(value)) {
        return failure(invalidArgument(
          `\`${key}\` ${value} is not a real calendar day. Both bounds are inclusive \`YYYY-MM-DD\` dates that must exist — check the month length.`,
        ))
      }
    }

    // An inverted window matches nothing at any scope, and the upstream answers
    // it with an ordinary empty page — indistinguishable from a quiet chain.
    if (args.from && args.to && args.from > args.to) {
      return failure(invalidArgument(
        `the window is inverted: \`from\` ${args.from} is later than \`to\` ${args.to}, so it selects no day at all. Both bounds are inclusive \`YYYY-MM-DD\` days and \`from\` must not be after \`to\`.`,
      ))
    }

    // `action` is validated HERE, against the documented per-type vocabulary,
    // because upstream it is not an error: scoped it returns an empty page, and
    // on the global feed the query walks the whole candidate set for ~45 s
    // before answering 503. Both outcomes read as "nothing happened" or "the
    // service is down" rather than "that is not an action", and the second one
    // spends shared upstream capacity on a typo.
    if (args.action != null) {
      if (!args.type || args.type === 'all') {
        return failure(invalidArgument(
          `\`action\` needs a \`type\`: with no type the upstream IGNORES it entirely and answers the unfiltered feed, so the rows would not be the ones you asked for. Types that take an action: ${TYPES_WITH_ACTIONS.join(', ')}.`,
        ))
      }
      const vocabulary = actionsForType(args.type)
      if (!vocabulary) {
        return failure(invalidArgument(
          `type=${args.type} takes no \`action\`. The types that do: ${TYPES_WITH_ACTIONS.join(', ')}. Drop \`action\`, or narrow with \`type\` alone.`,
        ))
      }
      if (!vocabulary.includes(args.action)) {
        return failure(invalidArgument(
          `"${args.action}" is not an action of type=${args.type}. Accepted: ${vocabulary.join(', ')}. (Upstream an unknown action is not rejected — it returns an empty page, or spends ~45 s and answers 503 on the global feed — so it is refused here instead.)`,
        ))
      }
    }

    // The ceiling is checked BEFORE the call so the agent learns the bound
    // rather than receiving the upstream's raw 400.
    const windowed = args.minUsd != null || args.identity != null || !COUNTABLE_TYPES.has(type)
    const ceiling = ceilingFor(scope, type, windowed)
    if (ceiling && offset > ceiling.max) {
      return failure(invalidArgument(
        `offset ${offset.toLocaleString('en-US')} is past the ${ceiling.max.toLocaleString('en-US')} ceiling for ${ceiling.label}. ${ceiling.advice}`,
      ))
    }

    const filters = {
      type: type === 'all' ? undefined : type,
      action: args.action,
      token: args.token,
      from: args.from,
      to: args.to,
      min: args.minUsd,
      minRevenue: args.minRevenueUsd,
      unit: args.unit,
      identity: args.identity,
    }

    let path: string
    let query: Record<string, string | number | undefined> = {}
    let scopeNote: string | null = null
    let assetLabel: string | null = null
    const errors: ToolError[] = []
    // Scoped and asset-scoped reads reach 30-38 s cold upstream and are
    // milliseconds warm, so they get the full budget rather than the default.
    const opts = { ttlMs: 5_000, timeoutMs: 60_000 }

    // Every interpolated parameter is encoded. Raw, an address carrying a `?`
    // or a `/` re-routes the request to a DIFFERENT upstream endpoint, whose
    // answer is not an activity array — and the feed then reports one of the
    // busiest accounts on the chain as having done nothing.
    if (scope === 'account') {
      path = `/explorer/address/${encodeURIComponent(args.account!)}/activity`
      query = { limit, offset, ...filters }
      // The upstream scopes this feed to the account's whole RELATED set, so a
      // row here may have been signed by a proxy, by the bound EVM account or by
      // a multisig the address belongs to. Said in the ANSWER, not only in the
      // parameter description: a reader quoting these rows would otherwise
      // attribute every one of them to the single address they asked about.
      scopeNote = `Rows cover ${args.account}'s whole RELATED account set — its proxies, its bound EVM account and the multisigs it belongs to — so an actor shown on a row need not be that address itself. ${callHint('get_account', { address: args.account })} lists the set.`
    } else if (scope === 'tag') {
      path = `/explorer/tag/${encodeURIComponent(args.tag!)}/activity`
      query = { limit, offset, ...filters }
      scopeNote = `Rows are every member of the \`${args.tag}\` tag, not one account: the actor on each line says which member acted.`
    } else if (scope === 'asset') {
      const resolved = await settle(resolveAssetToken(ctx.upstream, args.asset!), `asset ${args.asset}`)
      if (resolved.error) errors.push(resolved.error)
      if (!resolved.value) {
        return failure(invalidArgument(`no asset on Hydration matches ${JSON.stringify(args.asset)}. Pass a registry id, or find the symbol with ${callHint('list_assets', { query: args.asset })}.`))
      }
      assetLabel = resolved.value.chosen.label
      path = '/explorer/activity'
      query = { limit, offset, asset: resolved.value.chosen.assetId, ...filters }
      scopeNote = `Scoped to ${resolved.value.chosen.label}. \`asset\` is a scope switch rather than a filter: this reads the asset's FULL history, not the recent global window.`
        + (resolved.value.alternatives.length ? ` Other assets share that symbol: ${resolved.value.alternatives.map(a => a.label).join(', ')} — pass an id to be exact.` : '')
    } else if (scope === 'block') {
      path = `/explorer/block/${args.block}/activity`
      scopeNote = 'A block\'s activity is returned whole and unpaged, so `limit`/`offset` are applied here and the other filters do not apply.'
    } else if (scope === 'extrinsic') {
      const coord = parseCoordinate(args.extrinsic!)
      // A bare number is NOT an extrinsic identifier: `/explorer/extrinsic/123`
      // answers `Invalid extrinsic hash`, which contradicts the grammar this
      // tool documents. Refusing it here is what makes the two agree.
      if (!coord && !RE_HASH64.test(args.extrinsic!)) {
        return failure(invalidArgument(`\`extrinsic\` must be a 0x + 64 hex hash or a \`height-index\` coordinate, not ${JSON.stringify(args.extrinsic)}.`))
      }
      path = coord
        ? `/explorer/extrinsic-at/${coord.height}/${coord.index}/activity`
        : `/explorer/extrinsic/${encodeURIComponent(args.extrinsic!)}/activity`
      scopeNote = 'One extrinsic\'s activity is returned whole, so the other filters do not apply.'
    } else {
      path = '/explorer/activity'
      query = { limit, offset, ...filters }
    }

    let rows: ActivityRow[]
    try {
      rows = await ctx.upstream.get<ActivityRow[]>(path, query, opts)
    } catch (err) {
      // A 404 on the account feed is about the STRING, not about the account:
      // an address that never transacted still resolves, so the accepted forms
      // are the useful answer rather than "this account has no activity".
      return failure(scope === 'account'
        ? addressNotFound(err, args.account!, `The activity of ${args.account}`)
        : toolErrorFromUpstream(err, `${scope} activity`))
    }
    // The feed routes always answer an array. Anything else means the request
    // reached a different endpoint than intended, and treating it as an empty
    // page would report "nothing happened" for a read that never ran.
    if (!Array.isArray(rows)) {
      return failure({
        code: 'INTERNAL_ERROR',
        message: `the ${scope} activity read answered a ${typeof rows === 'object' ? 'record' : typeof rows} instead of a list of rows, so this is a failed read rather than an empty feed. Check the ${scope} identifier.`,
      })
    }

    const all = rows
    // Block and extrinsic scopes answer with the whole set; paging them is this
    // tool's job rather than the route's.
    const unpaged = scope === 'block' || scope === 'extrinsic'
    const page = unpaged ? all.slice(offset, offset + limit) : all.slice(0, limit)

    const describe = describeActivityFilters({
      scope,
      account: args.account ?? null,
      tag: args.tag ?? null,
      asset: assetLabel,
      block: args.block ?? null,
      extrinsic: args.extrinsic ?? null,
      type: args.type ?? null,
      action: args.action ?? null,
      token: args.token ?? null,
      from: args.from ?? null,
      to: args.to ?? null,
      minUsd: args.minUsd ?? null,
      minRevenueUsd: args.minRevenueUsd ?? null,
      unit: args.unit ?? null,
      identity: args.identity ?? null,
      limit,
      offset,
    })

    // The second measured trap, repeated beside the rows rather than left in a
    // description the caller read once: `type=trade` is a FAMILY. The rows that
    // come back are not all typed `trade`, so counting "trades" off this page
    // counts OTC fills, ICE intent fills and cross-chain swaps with them.
    const familyNote = args.type === 'trade'
      ? (() => {
        const kin = page.filter(r => r.type === 'otc' || r.type === 'intent' || r.type === 'xcswap')
        return '`type=trade` is a FAMILY filter: it also selects rows typed otc, intent and xcswap.'
          + (kin.length
            ? ` ${kin.length} of the ${page.length} rows on this page ${kin.length === 1 ? 'is' : 'are'} one of those rather than a plain swap.`
            : ' None of the rows on this page are, but a deeper page can be.')
          + ' Pass `type=otc`, `type=intent` or `type=xcswap` to select only that kind.'
      })()
      : null

    const unconfirmed = unconfirmedNote(page)
    const lines = page.map(row => `- ${activityLine(row, base)}`)

    const nextArgs: Record<string, unknown> = {
      ...Object.fromEntries(Object.entries({
        account: args.account, tag: args.tag, asset: args.asset, block: args.block, extrinsic: args.extrinsic,
        type: args.type, action: args.action, token: args.token, from: args.from, to: args.to,
        minUsd: args.minUsd, minRevenueUsd: args.minRevenueUsd, unit: args.unit, identity: args.identity,
      }).filter(([, v]) => v !== undefined)),
      limit,
      offset: offset + limit,
    }
    const hasMore = unpaged ? offset + limit < all.length : page.length === limit
    const pagingLine = hasMore
      ? `Next page: ${callHint('get_activity', nextArgs)}.`
        + (unpaged ? ` ${all.length - (offset + limit)} of this ${scope}'s ${all.length} classified rows are still unread.` : ' There is no total row count on this surface — page until a page comes back short.')
      : page.length
        ? '_This page came back short, so it is the end of the feed for these filters._'
        : null

    const markdown = joinBlocks(
      h2(`Activity — ${scope} scope`),
      describe,
      scopeNote ? note(scopeNote) : null,
      lines.length ? lines.join('\n') : '_No classified activity matched._',
      familyNote ? note(familyNote) : null,
      unconfirmed ? note(unconfirmed) : null,
      pagingLine,
    )

    // A page of 100 rows can approach the server's text cap. Trimming here, at
    // a line boundary and with the advice attached, keeps the answer's own tail
    // note ("N more rows") readable instead of letting the global cap cut the
    // markdown mid-table.
    const trimmed = budget(markdown, Math.max(1_000, ctx.maxTextChars - 1_000), 'Ask for a smaller `limit`, or narrow with `type`, `token` or a `from`/`to` window.')

    return output(ctx, trimmed, {
      scope,
      filters: { ...filters, asset: assetLabel ?? undefined },
      limit,
      offset,
      returned: page.length,
      hasMore,
      rows: page,
      ...(unpaged ? { scopeTotalRows: all.length } : {}),
    }, errors)
  },
}]
