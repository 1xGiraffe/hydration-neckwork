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
  TYPES_WITH_ACTIONS, actionsForType, activityLine, describeActivityFilters, foldIcePotTrades, unconfirmedNote,
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
const COUNTABLE_TYPES = new Set(['all', 'transfer', 'trade', 'dca', 'liquidity', 'mm', 'xcm', 'vote', 'stake', 'bond', 'juicer', 'bil', 'intent', 'otc'])

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
      ? { max: MAX_GLOBAL_WIDE_OFFSET, label: `the global feed's wide categories (${[...WIDE_TYPES].join(', ')})`, advice: 'Narrow to one of the rarer types (vote, stake, otc, bond, intent, xcswap, juicer, bil) to reach 250,000, or move the window with `from`/`to` instead of paging deeper, or scope the read to an account or a tag.' }
      : { max: MAX_GLOBAL_NARROW_OFFSET, label: 'the global feed\'s narrow categories', advice: 'Move the window with `from`/`to` instead of paging deeper, or scope the read to an account or a tag.' }
  }
  return windowed
    ? { max: MAX_WINDOWED_SCOPED_OFFSET, label: 'a windowed account/tag feed (a `minUsd` or `identity` filter is set)', advice: 'Drop `minUsd` and `identity` and use a countable `type` to reach the located ceiling of 5,000,000, or move the window with `from`/`to`.' }
    : { max: MAX_LOCATED_SCOPED_OFFSET, label: 'a located account/tag feed', advice: 'Move the window with `from`/`to` rather than paging deeper.' }
}

/* ============ schema ============ */

const SHAPE = {
  scope: z.enum(['global', 'account', 'tag', 'asset', 'block', 'extrinsic']).optional().describe('Normally inferred from the target you set; if passed it must agree with it.'),
  account: z.string().min(1).max(128).optional().describe('Any address form (SS58 any prefix, AccountId32, H160); scoped to its whole related set.'),
  tag: z.string().min(1).max(64).optional().describe('A system tag id (e.g. `treasury`): every member\'s activity.'),
  asset: z.string().min(1).max(64).optional().describe('Asset id or symbol. A SCOPE SWITCH to its FULL history (up to ~40 s cold), not a filter — use `token` to filter.'),
  block: z.number().int().min(0).optional().describe('A block height: its whole activity, unpaged; other filters do not apply.'),
  extrinsic: z.string().min(1).max(128).optional().describe('Extrinsic hash or `height-index`: its activity; other filters do not apply.'),
  type: z.enum(ACTIVITY_TYPES).optional().describe('Activity family (default all). type=dca does NOT narrow to DCA; type=trade is a family.'),
  action: z.string().min(1).max(32).optional().describe('Sub-filter within a type; values listed per type in the description.'),
  token: z.string().min(1).max(64).optional().describe('Symbol or id the row must reference: any asset the event touched, nested pool assets and both legs included. A Hydrated pool\'s product name (GDOT, HUSDT…) or wrapper id also matches its pool share\'s liquidity rows and routed trades; the share\'s own id names the share alone. An unknown token silently returns nothing.'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Inclusive lower day bound, `YYYY-MM-DD`.'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Inclusive upper day bound, `YYYY-MM-DD`.'),
  minUsd: z.number().optional().describe('Floor on the row\'s own value: USD, or token amount when `unit` is `token`.'),
  minRevenueUsd: z.number().optional().describe('Floor on the PROTOCOL REVENUE of the row\'s extrinsic, USD — not the row\'s value.'),
  unit: z.enum(['usd', 'token']).optional().describe('What `minUsd` means (default usd).'),
  identity: z.enum(['named', 'unnamed']).optional().describe('Only rows whose actor the explorer can (`named`) or cannot (`unnamed`) name.'),
  limit: z.number().int().min(1).max(100).optional().describe(`Rows per page (default ${DEFAULT_LIMIT}, max 100).`),
  offset: z.number().int().min(0).optional().describe('Rows to skip; capped per category (see OFFSET CEILINGS).'),
  format: formatParam,
}
const ACTION_TABLE = Object.entries(ACTIVITY_ACTIONS)
  .map(([type, actions]) => `  - type=${type}: ${actions.join(', ')}`)
  .join('\n')

const DESCRIPTION = `The classified Hydration activity feed: what people actually DID, one economic action per row (plumbing legs suppressed), amounts scaled and named, valued in USD, each linked to its Explorer page.

Use it for "what happened" — recently, in a block or extrinsic, to an account or tag, or over one asset's history. Not a raw event log: a DCA execution is one trade line, a router swap one swap. For one identified thing use inspect_entity; for a balance sheet, get_account.

SCOPE is whichever single target you set: none = recent global feed; \`account\` = that address's whole related set (proxies, bound EVM account, multisigs); \`tag\` = every tagged member; \`block\` = the whole block, unpaged; \`extrinsic\` = what one extrinsic produced. \`asset\` is a SCOPE SWITCH to that asset's FULL history (slow cold), not a filter — to filter by asset keep the scope and pass \`token\`.

TYPE vocabulary (default \`all\`): ${ACTIVITY_TYPES.join(', ')}.

ACTION needs a TYPE and is checked here, because upstream an action without a type is ignored and an unknown one silently returns an empty page (on the global feed ~45 s and a 503):
${ACTION_TABLE}
Liquidity \`Rebalance\`/\`Compound\` are a Gamma vault keeper's acts, credited to the keeper (a Compound's amount is the fees reinvested). Juicer harvest/rebalance is the vault's; unwind/settle/claim the request owner's. BIL settle/claim are the request controller's.

${ACTIVITY_TYPE_NOTES} For DCA fills only pass \`type=trade, action=dca\`. A ROW's own \`type\` is one of ${ACTIVITY_ROW_TYPES.join(', ')} — not the query vocabulary.

Rows marked **unconfirmed** are not facts yet, in TWO kinds: a transaction-pool row has no block (dry-run amounts; never invent a height), while a row above the finalized head sits in a real block whose height IS quotable — only its survival is provisional. There is NO total row count: never say "N results"; page with \`offset\` until a page comes back short.

OFFSET CEILINGS: 2,500 on the global feed's wide types (${[...WIDE_TYPES].join(', ')}), 250,000 on its others; 900,000 on an account or tag feed with \`minUsd\` or \`identity\`, else 5,000,000. Past one, move \`from\`/\`to\` instead.`

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

    // Block and extrinsic scopes answer with the whole set; paging them is this
    // tool's job rather than the route's. They also arrive with an ICE solution's
    // pot trades beside its fills, which every other feed has already folded.
    const unpaged = scope === 'block' || scope === 'extrinsic'
    const fold = unpaged ? foldIcePotTrades(rows) : { rows, folded: 0 }
    const all = fold.rows
    if (fold.folded > 0) {
      scopeNote = `${scopeNote ?? ''} ICE pot trades folded: ${fold.folded}. They are the pool trades that produced the intent fills listed here, not trades of their own (the extrinsic's explorer page lists them as the solution's routing).`.trim()
    }
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
