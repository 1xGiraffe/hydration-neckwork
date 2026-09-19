/**
 * `search` — one string to the entities it could be.
 *
 * The upstream does the resolving: `/explorer/search?q=` probes every kind of
 * identifier the chain has and appends the hits in RESOLUTION order, exact
 * lookups first. There is no cross-kind ranking pass, so this tool preserves
 * that order inside each kind and never invents one across kinds; what it adds
 * is the identifier to pass on and the canonical page for each hit.
 */

import { z } from 'zod'
import { formatParam } from '../toolTypes.ts'
import type { ToolDefinition } from '../toolTypes.ts'
import { h3, joinBlocks, note } from '../format/md.ts'
import { explorerLink } from '../format/refs.ts'
import type { EntityKind } from './shared.ts'
import { KIND_HEADING, callHint, failure, output, parseInput, preferredHit, runSearch, settle, viewSearchHits } from './shared.ts'

const DEFAULT_LIMIT = 10

const SHAPE = {
  query: z.string().min(1).max(128).describe('What to resolve: a block height or hash, an extrinsic hash or `height-index`, an address in any form, an asset symbol or name, a pool name, a tag name, a referendum index or title, an on-chain identity, an account emoji name, or the 2-6 character code an account pill shows.'),
  limit: z.number().int().min(1).max(25).optional().describe(`How many hits to show, in upstream resolution order (default ${DEFAULT_LIMIT}, max 25).`),
  format: formatParam,
}
const DESCRIPTION = `Resolve a name, number, symbol, address or fragment to the Hydration entities it could be, and hand back the exact identifier each one is addressed by.

Reach for this when you do NOT yet know what a string is, or when you hold only a fragment: part of an address, a tag name, a word from a referendum title, an on-chain identity, an account's emoji name. If you already hold a complete identifier and want the record itself, call inspect_entity instead — it detects and renders in one step, and calling search first only costs a round trip.

What it resolves: block heights and block hashes; extrinsic hashes, EVM transaction hashes and \`height-index\` coordinates; accounts in every form (Hydration SS58, any other SS58 prefix, raw AccountId32, EVM H160) plus fuzzy account lookups by identity display, verified contract name, emoji name and the short account-pill code; asset symbols and names; pool names, pool share-token ids and Uniswap-v3 pool contracts; system tag names; referendum indices and titles across both the OpenGov and the Democracy pallet; and cross-chain destinations (assets reachable only by selling into another chain).

Read the results as candidates, not as a ranking. Hits are grouped by kind; the order inside a group is the upstream's resolution order, with exact lookups first, and there is NO ranking pass across kinds — a tag group printed above an asset group does not mean the tag matched better. Each line carries the identifier to pass to inspect_entity as \`identifier\`, plus the canonical Explorer URL you can hand a human.

Two identifiers are ambiguous by nature and the answer says so rather than choosing: a bare number can be a block height, an asset id, a pool id and a referendum index at once, and a 0x + 64 hex string can be a block hash, an extrinsic hash, an EVM transaction hash or an AccountId32.

An empty result is not an error. The upstream never rejects a query — a string it cannot resolve simply returns nothing — so an empty answer means this chain knows no entity by that name. Check for a typo, or try a shorter fragment.`

export const searchTools: ToolDefinition[] = [{
  name: 'search',
  title: 'Search Hydration entities',
  description: DESCRIPTION,
  inputSchema: SHAPE,
  async handler(input, ctx) {
    const parsed = parseInput(SHAPE, input)
    if (!parsed.ok) return failure(parsed.error)
    const { query } = parsed.value
    const limit = parsed.value.limit ?? DEFAULT_LIMIT
    const base = ctx.explorerBaseUrl

    const hits = await settle(runSearch(ctx.upstream, query), `search for ${JSON.stringify(query)}`)
    if (!hits.value) return failure(hits.error!)

    // Trim in resolution order FIRST, then group: the upstream's order is the
    // only ordering information there is, so the hits that survive a small
    // limit must be the ones it resolved first.
    const pairs = viewSearchHits(hits.value, base)
    const shownPairs = pairs.slice(0, limit)
    const shown = shownPairs.map(p => p.view)
    const omitted = pairs.length - shownPairs.length

    if (!shown.length) {
      const markdown = joinBlocks(
        `No Hydration entity matches ${JSON.stringify(query)}.`,
        'This search resolves: block heights and hashes · extrinsic hashes, EVM transaction hashes and `height-index` coordinates · accounts (SS58 of any prefix, AccountId32, EVM H160, on-chain identity, verified contract name, emoji name, account-pill code) · asset symbols and names · pool names, share-token ids and v3 pool contracts · system tag names · referendum indices and titles · cross-chain destinations.',
        note('The upstream does not reject a query, so this is an empty result rather than a rejected one — the string is simply not an identifier this chain knows. Try a shorter fragment, or a symbol.'),
      )
      return output(ctx, markdown, { query, limit, hits: [] })
    }

    const groups = new Map<EntityKind, typeof shown>()
    for (const view of shown) {
      const bucket = groups.get(view.kind)
      if (bucket) bucket.push(view)
      else groups.set(view.kind, [view])
    }

    const blocks = [...groups.entries()].map(([kind, rows]) => {
      const lines = rows.map(row => {
        const parts = [`**${row.label}**`]
        if (row.detail && row.detail !== row.label) parts.push(row.detail)
        // A label that IS the identifier (a coordinate, a slug) is not repeated.
        if (row.identifier !== row.label) parts.push(`\`${row.identifier}\``)
        if (row.url) parts.push(explorerLink('open', row.url))
        return `- ${parts.join(' · ')}`
      })
      return `${h3(KIND_HEADING[kind])}\n${lines.join('\n')}`
    })

    const top = shown[0]
    const head = `${shown.length} hit${shown.length === 1 ? '' : 's'} for ${JSON.stringify(query)}`
      + (omitted > 0 ? `, ${omitted} more not shown (raise \`limit\`, max 25)` : '')
      + '. Grouped by kind; order inside a group is the upstream resolution order, and there is no ranking across kinds.'

    // Several registered assets carrying the query as their symbol is the one
    // case where naming "the first hit" would mislead: the upstream's order is
    // resolution order, not value, so the first USDC hit is a dead Acala bridge
    // asset with a null price and no holders while the live one is further down.
    // `get_asset` already ranks an ambiguous symbol by value held, so the nudge
    // hands the question to it rather than picking.
    const lower = query.trim().toLowerCase()
    const sameSymbol = shown.filter(v => v.kind === 'asset' && v.label.toLowerCase().startsWith(`${lower} (#`))
    // Which hit the query actually NAMES, judged the way inspect_entity judges
    // it, so the two tools cannot send a caller to two different entities.
    // Naming "the first hit" is what sent them apart: for `HDX` the upstream
    // resolves the "HDX Kraken LP" tag first and the native token fourth, so a
    // nudge built on POSITION promoted a seven-member LP tag over the chain's
    // own currency while inspect_entity opened the token.
    const preferred = preferredHit(shownPairs, query)
    const best = preferred?.pair.view ?? top
    const openBest = callHint('inspect_entity', { identifier: best.identifier, kind: best.kind })
    const nudge = sameSymbol.length > 1
      ? `${sameSymbol.length} registered assets call themselves ${JSON.stringify(query)} and this list is in resolution order, not by size — ${callHint('get_asset', { asset: query })} ranks them by value held before choosing.`
      : preferred?.exact
        ? `**${best.label}** matches ${JSON.stringify(query)} exactly — its own name or id IS the query, where the rest merely contain it. Open it with ${openBest}.${best === top ? '' : ' It is not printed first because the groups above are in resolution order, which is not a ranking.'}`
        : `No hit is named exactly ${JSON.stringify(query)}, so every line above is a candidate rather than a match. The most specific kind the upstream resolved is **${best.label}** — open it with ${openBest}, or pick another line.`

    const markdown = joinBlocks(head, ...blocks, nudge)

    return output(ctx, markdown, {
      query,
      limit,
      shown: shown.length,
      omitted,
      hits: shown.map(v => ({ kind: v.kind, label: v.label, identifier: v.identifier, url: v.url, ...v.json })),
    })
  },
}]
