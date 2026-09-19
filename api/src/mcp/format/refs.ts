/**
 * Entities, named — and the canonical Explorer URL for each.
 *
 * Every link builder here mirrors one entry of `explorer-ui/src/router.tsx`'s
 * `paths` object. That object is the only definition of the site's URL shape, so
 * these must not drift from it: a link an agent hands a human has to open the
 * page the figures came from. The tests pin each builder against the `paths`
 * entry it copies.
 */

import type { AccountRef, AssetRef } from '../types.ts'

const DASH = '—'

/* ============ assets ============ */

/**
 * A cross-chain destination is not a registry asset: its `assetId` is a
 * NEGATIVE sentinel (-1, -2, …) minted per destination so the asset list can
 * carry it. That number routes nowhere — a destination is addressed by its
 * platform slug (`xcDestination.platform`, e.g. `near`, `zec`) — so no label
 * here ever prints it.
 */
export const isCrossChainDestination = (a: AssetRef | null | undefined): boolean =>
  a != null && a.assetId < 0

/** The short form: just the symbol, which is what a feed line wants. */
export function assetLabel(a: AssetRef | null | undefined): string {
  if (!a) return DASH
  if (a.symbol) return a.symbol
  return isCrossChainDestination(a) ? 'cross-chain asset' : `#${a.assetId}`
}

/**
 * The disambiguating form, for a surface where the id matters — `HDX (#0)`.
 * Symbols are not unique on Hydration (aDOT over DOT, a bond over its
 * underlying), so anywhere an agent might act on the id, print the id.
 */
export function assetLabelWithId(a: AssetRef | null | undefined): string {
  if (!a) return DASH
  if (isCrossChainDestination(a)) return `${assetLabel(a)} (cross-chain)`
  return a.symbol ? `${a.symbol} (#${a.assetId})` : `#${a.assetId}`
}

/**
 * Two asset labels that can be told apart.
 *
 * Symbols are NOT unique here — four assets call themselves USDC — so a pair
 * whose legs print the same symbol reads as one asset traded for itself
 * (`USDC → USDC`). When the symbols collide but the ids differ, both legs carry
 * their id; otherwise the short form is kept, because an id on every row costs
 * space it does not earn.
 */
export function assetPairLabels(
  a: AssetRef | null | undefined,
  b: AssetRef | null | undefined,
): [string, string] {
  const collides = a != null && b != null
    && a.assetId !== b.assetId
    && (a.symbol ?? '') !== '' && a.symbol === b.symbol
  return collides ? [assetLabelWithId(a), assetLabelWithId(b)] : [assetLabel(a), assetLabel(b)]
}

/* ============ accounts ============ */

/**
 * `F.shortAddr`'s rule: keep 6 leading characters and the last 5.
 *
 * (The `ShortAddr` COMPONENT the explorer renders beside an account keeps 6 only
 * for an `0x` address and 4 for an SS58, as `notifications/render.ts` does. The
 * longer head is kept here because an agent reads the text without the page's
 * copy affordance beside it; the trailing 5 — the characters that disambiguate
 * two accounts — are identical either way.)
 */
export function shortAddress(s: string | null | undefined): string {
  if (!s) return DASH
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-5)}` : s
}

/** A hash is not an address: the explorer elides one to 8 leading + 6 trailing. */
export function shortHash(s: string | null | undefined): string {
  if (!s) return DASH
  return s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s
}

/**
 * A `modl`-prefixed pallet account spells its PalletId in ASCII:
 * `0x6d6f646c70792f7472737279…` is the Treasury's `py/trsry`. Reading it back
 * names accounts that carry no identity and no tag at all.
 */
export function moduleName(accountId: string | null | undefined): string | null {
  if (!accountId || !accountId.startsWith('0x6d6f646c')) return null
  const hex = accountId.slice(10)
  let s = ''
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16)
    if (code >= 32 && code <= 126) s += String.fromCharCode(code)
    else break
  }
  return s.replace(/[^\x20-\x7e]+$/, '').trim() || null
}

const looksLikeAccountId32 = (s: string) => /^0x[0-9a-fA-F]{64}$/.test(s)

/**
 * The best name this account has, for an agent reading one line.
 *
 * Precedence: on-chain identity display (with `✓` when a registrar judged it),
 * system tag name, self-set profile name, pallet-account name, verified contract
 * name, then the shortened address. The account's identity emoji leads the
 * label when there is one, exactly as the account pill renders it.
 *
 * (The explorer's own pill and the notification renderer put the SYSTEM TAG
 * first; here the on-chain identity leads, because an agent is more often asked
 * "who is this" than "which protocol pot is this". The set of names is the same
 * one the page shows either way.)
 *
 * A raw AccountId32 is never the label: it is a public key, not an address
 * (AGENTS.md § Explorer semantics). Handed one as a bare string with no ref to
 * resolve it, this says so with an `id ` prefix rather than passing it off as an
 * address.
 */
export function accountLabel(
  a: AccountRef | string | null | undefined,
  opts: { withAddress?: boolean } = {},
): string {
  if (a == null) return DASH
  if (typeof a === 'string') {
    if (!a) return DASH
    const mod = moduleName(a)
    if (mod) return `⚙️ ${mod}`
    return looksLikeAccountId32(a) ? `id ${shortHash(a)}` : shortAddress(a)
  }
  const short = shortAddress(a.address)
  const identity = a.identity?.display?.trim()
  const pallet = moduleName(a.accountId)
  let named: string | null = null
  let emoji = a.emoji
  if (identity) named = a.identity?.verified ? `${identity} ✓` : identity
  else if (a.tag?.name) named = a.tag.name
  else if (a.profile?.name) named = a.profile.name
  else if (pallet) { named = pallet; emoji = '⚙️' }
  // Contract names are not unique — the address tail disambiguates two.
  else if (a.contractName) named = `${a.contractName}·${(a.address ?? '').slice(-3)}`
  const head = emoji ? `${emoji} ` : ''
  if (!named) return `${head}${short}`
  return opts.withAddress ? `${head}${named} (${short})` : `${head}${named}`
}

/**
 * The counterparty of a cross-chain leg, in the DESTINATION chain's own format —
 * a NEAR account name, a Zcash transparent address. None of the SS58/H160
 * plumbing applies: a readable name is shown whole, anything longer is elided.
 */
export function shortForeignAddress(s: string | null | undefined): string {
  if (!s) return DASH
  return s.length <= 20 ? s : `${s.slice(0, 8)}…${s.slice(-4)}`
}

/* ============ canonical URLs ============ */

/** Trailing slashes off, so `${base}${path}` never doubles one. */
const origin = (base: string): string => (base || '').replace(/\/+$/, '')
const url = (base: string, path: string): string => `${origin(base)}${path}`

export const accountUrl = (base: string, address: string): string =>
  url(base, `/account/${encodeURIComponent(address)}`)

/** A deployed contract's detail page IS its account page — there is no /contract route. */
export const contractUrl = (base: string, address: string): string => accountUrl(base, address)

export const blockUrl = (base: string, height: number | string): string =>
  url(base, `/block/${height}`)

/** `id` is either the 64-hex hash or the `height-index` coordinate form. */
export const extrinsicUrl = (base: string, id: string): string =>
  url(base, `/extrinsic/${id}`)

export const extrinsicAtUrl = (base: string, height: number, index: number): string =>
  url(base, `/extrinsic/${height}-${index}`)

export const eventUrl = (base: string, height: number, eventIndex: number): string =>
  url(base, `/event/${height}-${eventIndex}`)

/**
 * One activity row's detail page: `/<slug>/<id>`. The slug names the action
 * (`swap`, `transfer`, `borrow`, `vote`, …) and the id is either the row's
 * coordinates in its block (`<height>-e<eventIndex>` for an event-indexed row,
 * `<height>-<extrinsicIndex>` otherwise) or the id of the longer thing it
 * belongs to — see `activityUrlFor` in ./activity.ts, which picks both.
 */
export const activityUrl = (base: string, slug: string, id: string): string =>
  url(base, `/${slug}/${id}`)

/** A trade's page is the swap slug's. Event-indexed rows carry the `e` marker. */
export const tradeUrl = (base: string, height: number, index: number, opts: { event?: boolean } = {}): string =>
  activityUrl(base, 'swap', `${height}-${opts.event ? 'e' : ''}${index}`)

/** A DCA row links to its SCHEDULE — the standing order, not one fill. */
export const dcaScheduleUrl = (base: string, scheduleId: number | string): string =>
  url(base, `/dca/${scheduleId}`)

/** One execution of that schedule, addressed by the event it emitted. */
export const dcaExecutionUrl = (base: string, height: number, eventIndex: number): string =>
  url(base, `/dca/${height}-e${eventIndex}`)

/** An ICE intent's order page. The id is the u128 as a decimal string, never a number. */
export const intentUrl = (base: string, intentId: string): string =>
  url(base, `/intent/${intentId}`)

/** Democracy and OpenGov both index from 0, so the pallet is part of the identity. */
export const referendumUrl = (base: string, pallet: 'opengov' | 'democracy', index: number | string): string =>
  url(base, `/referendum/${pallet}/${index}`)

export const poolUrl = (base: string, poolId: number | string): string =>
  url(base, `/pool/${poolId}`)

/** A concentrated-liquidity pool is addressed by its contract, lower-cased. */
export const v3PoolUrl = (base: string, address: string): string =>
  url(base, `/pool/${address.toLowerCase()}`)

export const assetUrl = (base: string, assetId: number | string): string =>
  url(base, `/asset/${assetId}`)

export const holdersUrl = (base: string, assetId: number | string): string =>
  url(base, `/holders/${assetId}`)

export const tagUrl = (base: string, tagId: string): string =>
  url(base, `/tag/${encodeURIComponent(tagId)}`)

/** A cross-chain destination — not a registry asset, so not an id route. */
export const xcDestinationUrl = (base: string, slug: string): string =>
  url(base, `/asset/xc/${encodeURIComponent(slug)}`)

/** A markdown link. Brackets in the label would break it, so they are escaped. */
export const explorerLink = (label: string, href: string): string =>
  `[${label.replace(/\[/g, '\\[').replace(/\]/g, '\\]')}](${href})`
