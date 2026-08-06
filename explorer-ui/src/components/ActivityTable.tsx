/* eslint-disable react-refresh/only-export-components -- activity table exports slug/id/label helpers alongside its components */
import { Link, paths } from '../router'
import type { ActivitySlug } from '../router'
import { F, AddrPill, AssetChip, rowNav, Ago, AccountEmoji, ShortAddr, TagIcon, tagMemberSuffix, VoteSideBadge, TableSkeleton, Dash, EmptyRow, ErrorRow, pendingRows, LiveAnchor, ContractGlyph } from './ui'
import { useNewRows } from '../hooks/useNewRows'
import { activityBadge } from './activityColors'
import { resolveTag, useTagMapVersion } from '../userTags'
import type { ActivityRow } from '../types'

// Chain badge for cross-chain (XCM) destinations — full network names, brand
// gradients for the frequent chains, neutral gray for the rest.
//
// Polkadot and its AssetHub take the near-black of Polkadot's own brand, cast
// faintly violet and blue to tell the relay from its system chain. Black also keeps
// them off the accent the local badge owns: Polkadot's brand pink sat about two
// degrees of hue from it, close enough that a relay badge and a Hydration badge read
// as one chip at 9px. A warm counterparty is fine — Mythos red clears the accent by
// forty degrees — but nothing here should sit that close to it again.
const CHAIN_COLORS: Record<string, [string, string]> = {
  Polkadot: ['#3d3540', '#141014'],
  AssetHub: ['#333f4e', '#121820'],
  Mythos: ['#e0332b', '#9d1a14'],
  Moonbeam: ['#53cbc9', '#0fb6b0'],
  Astar: ['#1b6dff', '#0a45c9'],
  Bifrost: ['#5a25f0', '#3a10b0'],
  Interlay: ['#f19135', '#d4731a'],
  Ethereum: ['#627EEA', '#3c54b8'],
  Acala: ['#e40c5b', '#a80943'],
  Solana: ['#9945FF', '#5c1fd1'],
  Centrifuge: ['#1253fa', '#0b36ad'],
  Phala: ['#c4f142', '#96c214'],
  Unique: ['#00bfff', '#0087b4'],
  KILT: ['#8c145a', '#5e0d3c'],
}
export function ChainBadge({ chain }: { chain: string }) {
  const c = CHAIN_COLORS[chain] ?? ['#666', '#444']
  return <span className="chain-badge" style={{ background: `linear-gradient(135deg,${c[0]},${c[1]})` }} title={chain}>{chain || '?'}</span>
}
// The local end of a cross-chain hop. Every hop has Hydration at one end, and
// naming it is what makes the arrow's direction readable — a row saying only
// "AssetHub → USDC 55" leaves the reader to work out which side the asset landed
// on. It takes the brand accent from the theme rather than a per-chain brand pair,
// so the one chain that is always us never reads as just another counterparty.
export function HydrationBadge() {
  return <span className="chain-badge chain-badge-local" title="Hydration">Hydration</span>
}
// The external-explorer label follows the link target — cross-chain accounts
// live on Subscan for substrate chains, Solscan/Etherscan for Solana/Ethereum.
// Every explorer a bridged journey can reach, so a Base link never says "Subscan".
// Ordered longest-suffix first where hosts nest (optimistic.etherscan.io).
const EXPLORER_SITES: [string, string][] = [
  ['optimistic.etherscan.io', 'Etherscan'],
  ['solscan.io', 'Solscan'],
  ['etherscan.io', 'Etherscan'],
  ['basescan.org', 'Basescan'],
  ['arbiscan.io', 'Arbiscan'],
  ['bscscan.com', 'BscScan'],
  ['polygonscan.com', 'Polygonscan'],
  ['suiscan.xyz', 'Suiscan'],
]
export function explorerSiteName(url: string): string {
  try {
    const host = new URL(url).hostname
    for (const [suffix, name] of EXPLORER_SITES) if (host.endsWith(suffix)) return name
  } catch { /* fall through */ }
  return 'Subscan'
}
export function ExternalAccountPill({ account }: { account: NonNullable<ActivityRow['destAccount']> }) {
  useTagMapVersion()   // re-render when the viewer's tag map changes
  // Prefer the server-resolved canonical accountId: for an AccountId32 it
  // already equals `raw`, but for a bound-EVM AccountKey20 `raw` is the bare
  // H160, not the accountId user tags/avatars are keyed by — using `raw` there
  // silently failed to match either. Fall back to `raw`/`address` only for a
  // response that predates this field (old cache entry or test fixture).
  const iconSeed = account.accountId || account.raw || account.address
  const resolved = resolveTag({ accountId: iconSeed, tag: account.tag ?? null })
  const identity = account.identity
  const profile = account.profile
  // Same pubkey, same Hydration tag/identity/profile, even on another chain —
  // priority resolved tag > profile name > identity, mirroring AddrPill's name
  // precedence and classes (the "tag"/"profile-name" class + small ✓ for a
  // verified on-chain identity, never on a self-set name). The short address
  // keeps showing via the pill's title when a name takes its place in the body.
  const name = resolved
    ? <><span className="tag" style={resolved.color ? { color: resolved.color } : undefined}>{resolved.name}</span>{tagMemberSuffix(resolved, account.address)}</>
    : profile?.name
      ? <span className="tag profile-name">{profile.name}</span>
      : identity?.display
        ? <>
          <span className="tag">{identity.display}</span>
          {identity.verified && <span className="id-verified" title="Verified identity">✓</span>}
        </>
        // A verified contract's name, with the address tail that says which of
        // the same-named contracts this is — mirroring AddrPill exactly.
        : account.contractName
          ? <><span className="tag">{account.contractName}</span><span className="tag-member-suffix mono">·{account.address.slice(-3)}</span></>
          : null
  const body = <>
    {resolved
      ? <TagIcon icon={resolved.icon} title={resolved.name} />
      : <AccountEmoji account={{ accountId: iconSeed, emoji: account.emoji, emojiName: account.emojiName, emojiUrl: account.emojiUrl, profile: account.profile }} />}
    {name ?? <span className="a mono"><ShortAddr addr={account.address} /></span>}
    <ContractGlyph show={account.isContract} />
  </>
  if (!account.subscanUrl) return <span className="addr-pill" title={account.address}>{body}</span>
  const site = explorerSiteName(account.subscanUrl)
  return <a className="addr-pill ext-account" href={account.subscanUrl} target="_blank" rel="noopener" title={`${account.address} · opens ${site}`} data-no-hover="true">{body}<span className="ext-site">{site}</span></a>
}

// Row label + category color both live in activityColors, so the coding stays
// one edit wide across every surface that shows an activity.
const badge = activityBadge

const MM_SLUG: Record<string, ActivitySlug> = {
  Supply: 'lend', Withdraw: 'withdraw', Borrow: 'borrow', Repay: 'repay',
  LiquidationCall: 'liquidate', Liquidate: 'liquidate',
  ClaimRewards: 'claim-rewards',
}
// Canonical detail-page slug for a activity row — mirrors badge() labels.
export function activitySlug(r: ActivityRow): ActivitySlug {
  switch (r.type) {
    case 'trade': return r.dca ? 'dca' : 'swap'
    case 'dca': return 'dca'
    case 'xcm': return 'cross-chain'
    case 'liquidity': return r.liqAction === 'Remove' ? 'remove-liquidity' : r.liqAction === 'Create' ? 'create-pool' : r.liqAction === 'Destroy' ? 'destroy-pool' : r.liqAction === 'Claim' ? 'claim-rewards' : 'add-liquidity'
    case 'mm': return MM_SLUG[r.mmAction ?? ''] ?? 'lend'
    case 'staking': return 'staking'
    case 'vote': return 'vote'
    case 'otc': return r.otcAction === 'Pull' ? 'otc-pull' : r.otcAction === 'Fill' ? 'otc-fill' : 'otc-place'
    default: return 'transfer'
  }
}
export function activityId(r: ActivityRow, dcaExecutionLink = false): string | null {
  // DCA rows link to their owning SCHEDULE page, not a single fill — except on
  // the schedule page itself, where each row IS one execution and links to its
  // own execution detail (/dca/<block>-e<eventIndex>).
  if (!dcaExecutionLink && (r.type === 'dca' || r.dca) && r.dcaScheduleId != null) return String(r.dcaScheduleId)
  if (r.eventIndex != null) return `${r.blockHeight}-e${r.eventIndex}`
  if (r.extrinsicIndex != null) return `${r.blockHeight}-${r.extrinsicIndex}`
  return null
}
// A slug names a URL, and `claim-rewards` is the URL of BOTH reward claims (see
// SLUG_TYPES), so its label stays the family-neutral one — which claim a row is
// comes from its badge and its Action row, and those name the position it pays out.
const SLUG_LABEL: Record<ActivitySlug, string> = {
  swap: 'Swap', dca: 'DCA', transfer: 'Transfer', 'cross-chain': 'Cross-chain',
  'add-liquidity': 'Add liquidity', 'remove-liquidity': 'Remove liquidity', 'create-pool': 'Create pool', 'destroy-pool': 'Destroy pool', 'claim-rewards': 'Claim rewards',
  lend: 'Lend', withdraw: 'Withdraw', borrow: 'Borrow', repay: 'Repay',
  liquidate: 'Liquidate', staking: 'Staking', vote: 'Vote',
  'otc-place': 'OTC place', 'otc-pull': 'OTC pull', 'otc-fill': 'OTC fill',
}
export function activityLabel(slug: ActivitySlug): string { return SLUG_LABEL[slug] }

// Coarse activity type(s) an id is matched against — action-level slugs of the
// same family are interchangeable at resolve time (slug is presentation).
export const SLUG_TYPES: Record<ActivitySlug, ActivityRow['type'][]> = {
  swap: ['trade', 'dca'], dca: ['trade', 'dca'], transfer: ['transfer'],
  'cross-chain': ['xcm'], 'add-liquidity': ['liquidity'], 'remove-liquidity': ['liquidity'], 'create-pool': ['liquidity'], 'destroy-pool': ['liquidity'], 'claim-rewards': ['liquidity', 'mm'],
  lend: ['mm'], withdraw: ['mm'], borrow: ['mm'], repay: ['mm'], liquidate: ['mm'],
  staking: ['staking'], vote: ['vote'],
  'otc-place': ['otc'], 'otc-pull': ['otc'], 'otc-fill': ['otc'],
}

export function parseId(id: string): { height: number; eventIndex: number | null; extrinsicIndex: number | null } | null {
  const m = /^(\d+)-(e)?(\d+)$/.exec(id)
  if (!m) return null
  return { height: Number(m[1]), eventIndex: m[2] ? Number(m[3]) : null, extrinsicIndex: m[2] ? null : Number(m[3]) }
}

// Canonical URL for a resolved row, or null when the current slug+id are already canonical.
export function canonicalTarget(row: ActivityRow, slug: ActivitySlug, id: string): string | null {
  const canonicalSlug = activitySlug(row)
  const canonicalId = activityId(row) ?? id
  return canonicalSlug !== slug || canonicalId !== id ? paths.activityDetail(canonicalSlug, canonicalId) : null
}

// Where an event that is NOT an activity of its own belongs: the activity whose
// extrinsic it is part of. The transfer legs and fee withdrawals of an OTC fill, a
// swap or a money-market call are that action's plumbing — real events, deliberately
// not rendered as rows — so an id naming one resolves to no row at all.
//
// Only an extrinsic with exactly ONE activity hands over unambiguously. A batch
// holding several would make the choice arbitrary, so it returns null and the caller
// says so instead, pointing at the extrinsic that lists them all.
export function subordinateActivityTarget(rows: ActivityRow[], extrinsicIndex: number | null | undefined): string | null {
  if (extrinsicIndex == null) return null
  const owners = rows.filter(r => r.extrinsicIndex === extrinsicIndex)
  if (owners.length !== 1) return null
  const owner = owners[0]
  const ownerId = activityId(owner)
  return ownerId
    ? paths.activityDetail(activitySlug(owner), ownerId)
    : paths.extrinsic(`${owner.blockHeight}-${owner.extrinsicIndex}`)
}

export function ActivityBadge({ r }: { r: ActivityRow }) {
  const { label, col } = badge(r)
  const supplementalMarket = r.type === 'mm' && r.mmMarketKey && r.mmMarketKey !== 'core' ? r.mmMarket : null
  const partial = r.type === 'otc' && r.otcPartial ? 'partial' : null
  // Branded supplemental markets wear their own filled chip: GIGAHDX its brand
  // black, BIL the green-and-yellow of the Brazilian receivables behind it.
  const marketClass = supplementalMarket === 'GIGAHDX' ? ' mm-market-gigahdx'
    : supplementalMarket === 'BIL' ? ' mm-market-bil' : ''
  return <span className="activity-badge-group"><span className="pill-badge" style={{ color: col, background: `color-mix(in srgb, ${col} 15%, transparent)` }}>{label}</span>{supplementalMarket && <span className={`mm-activity-market${marketClass}`}>{supplementalMarket}</span>}{partial && <span className="mm-activity-market">{partial}</span>}</span>
}

// One row's activity, as a phrase. `headed` marks a surface whose page HEADER
// already states the row's context — the detail pages do, a list row has no header
// above it — so there the phrase drops the facts the header repeats and keeps only
// what it alone carries (the assets and amounts).
export function ActivityDesc({ r, headed }: { r: ActivityRow; headed?: boolean }) {
  // A hop's two ends ARE its phrase, so cross-chain is the one family that keeps
  // them on a headed surface too. Naming one end in a page subtitle is not the same
  // as drawing the journey: this page's Activity row used to read "AAVE 30.4" and
  // say nothing about where it came from or landed. So both xcm branches below
  // ignore `headed` for the chain badges, and the detail page reads like its row.
  if (r.type === 'xcm' && r.xcmDir === 'in' && r.asset) {
    // Inbound: origin chain (+ source account when the crosschain index resolved
    // it), then the arrow, then the chain it landed on with the asset it credited.
    const origin = <><ChainBadge chain={r.fromChain ?? ''} />{r.fromAccount && <ExternalAccountPill account={r.fromAccount} />}</>
    return <span className="asset-flow">{origin} → <HydrationBadge /><span className="trade-leg"><AssetChip asset={r.asset} /> <span className="mono">{F.amount(r.amount, r.asset.decimals)}</span></span></span>
  }
  if ((r.type === 'transfer' || r.type === 'xcm') && r.asset) {
    // Asset first, then the arrow, then the destination chain and account. A
    // Wormhole NTT send is type 'xcm' like every other outbound hop — its burn
    // leg never reaches this branch as a transfer.
    const destChain = r.type === 'xcm' && r.destChain ? <ChainBadge chain={r.destChain} /> : null
    const destAccount = r.type === 'xcm'
      ? (r.destAccount ? <ExternalAccountPill account={r.destAccount} /> : null)
      : (r.to ? <AddrPill account={r.to} noCopy /> : null)
    const dest = destChain || destAccount ? <>{destChain}{destAccount}</> : null
    // Outbound needs the chain it left as much as inbound needs the one it reached,
    // and the asset sits beside it either way — it is the Hydration balance that
    // moved. A local badge only earns its place opposite a counterparty, so a plain
    // local transfer and an outbound hop with nothing left to point at both skip it.
    const local = r.type === 'xcm' && dest ? <HydrationBadge /> : null
    return <span className="asset-flow">{local}<span className="trade-leg"><AssetChip asset={r.asset} /> <span className="mono">{F.amount(r.amount, r.asset.decimals)}</span></span>{dest ? <> → {dest}</> : null}</span>
  }
  if ((r.type === 'trade' || r.type === 'dca') && r.assetIn && r.assetOut) {
    return <span className="asset-flow"><span className="trade-leg"><AssetChip asset={r.assetIn} /> <span className="mono">{F.amount(r.amountIn, r.assetIn.decimals)}</span></span> → <span className="trade-leg"><AssetChip asset={r.assetOut} /> <span className="mono">{F.amount(r.amountOut, r.assetOut.decimals)}</span></span>{r.dcaStatus === 'failed' && <span className="muted">Failed attempt</span>}</span>
  }
  if (r.type === 'otc') {
    // Pull rows without an enriched leg pair (the Placed-by-orderId lookup
    // missed) render the order id alone — same fallback the design calls out.
    // Kept even when headed: with no legs the order id is all this phrase has to say.
    if (!r.assetIn || !r.assetOut) return <span className="asset-flow"><span className="muted">Order #{r.otcOrderId}</span></span>
    return <span className="asset-flow"><span className="trade-leg"><AssetChip asset={r.assetIn} /> <span className="mono">{F.amount(r.amountIn, r.assetIn.decimals)}</span></span> → <span className="trade-leg"><AssetChip asset={r.assetOut} /> <span className="mono">{F.amount(r.amountOut, r.assetOut.decimals)}</span></span>{headed ? null : <span className="muted">#{r.otcOrderId}</span>}</span>
  }
  if (r.type === 'liquidity' && r.liqAction === 'Create' && r.assetIn && r.assetOut) {
    // Pool creation seeds two assets — show both legs side by side.
    return <span className="asset-flow"><span className="trade-leg"><AssetChip asset={r.assetIn} /> <span className="mono">{F.amount(r.amountIn, r.assetIn.decimals)}</span></span> + <span className="trade-leg"><AssetChip asset={r.assetOut} /> <span className="mono">{F.amount(r.amountOut, r.assetOut.decimals)}</span></span></span>
  }
  if ((r.type === 'mm' || r.type === 'liquidity' || r.type === 'staking') && r.asset) {
    return <span className="asset-flow"><span className="trade-leg"><AssetChip asset={r.asset} /> <span className="mono">{F.amount(r.amount, r.asset.decimals)}</span></span></span>
  }
  if (r.type === 'vote' && r.asset) {
    const locked = <span className="trade-leg"><AssetChip asset={r.asset} /> <span className="mono">{F.amount(r.amount, r.asset.decimals)}</span></span>
    // Headed, the referendum, the side and the conviction are all in the page title's
    // own subtitle, so the locked capital is the one fact left to state; the
    // referendum stays reachable through that page's Referendum row.
    if (headed) return <span className="asset-flow">{locked}</span>
    // A referendum's title says what the vote was about; "Ref 255" does not. The
    // title comes from SubSquare and may not be fetched yet, so the index is the
    // fallback rather than a placeholder. Only ConvictionVoting/Democracy rows have a
    // referendum page — Council/TC votes carry a proposal hash instead.
    // The index identifies the referendum, the title says what it is: show the index
    // muted ahead of a plain link on the title, which carries the referendum hover card.
    const label = r.voteRefTitle ?? (r.voteRef ? `Referendum #${r.voteRef}` : 'Referendum')
    return <span className="asset-flow">{locked}
      {r.voteRef && <span className="muted mono ref-num">#{r.voteRef}</span>}
      {r.voteRefPallet && r.voteRef
        ? <Link to={paths.referendum(r.voteRefPallet, r.voteRef)} className="ref-link">{r.voteRefTitle ?? 'Referendum'}</Link>
        : <span className="muted">{label}</span>}
      <VoteSideBadge side={r.voteSide} />{r.voteConviction ? <span className="muted">{r.voteConviction}</span> : null}</span>
  }
  return null
}

// Stable identity for a activity row, for React keys + live new-row detection.
function activityKey(r: ActivityRow): string {
  return [r.type, r.blockHeight, r.extrinsicIndex ?? r.eventIndex ?? '', r.assetIn?.assetId ?? r.asset?.assetId ?? '',
    r.assetOut?.assetId ?? '', r.amountIn ?? r.amount ?? '', r.who?.accountId ?? '', r.mmMarketKey ?? ''].join('|')
}

// `pageSize` sizes the loading skeleton, so a paged feed reserves the height it is
// about to fill and the pager beneath it does not jump. Unpaged surfaces (a block's
// or extrinsic's own activity) show whatever the record holds and leave it unset.
export function ActivityTable({ rows, noActor, now, live, anchorRef, loading, pending, error, onRetry, dcaExecutionLinks, pageSize }: { rows: ActivityRow[]; noActor?: boolean; now: number; live?: boolean; anchorRef?: (el: HTMLElement | null) => void; loading?: boolean; pending?: boolean; error?: unknown; onRetry?: () => void; dcaExecutionLinks?: boolean; pageSize?: number }) {
  const cols = noActor ? 4 : 5
  // Deduped stable keys: same row → same key across renders (so prepended live rows
  // are detected as new without remounting the rest); duplicates get a suffix.
  const seen = new Map<string, number>()
  const keys = rows.map(r => { const b = activityKey(r); const n = seen.get(b) ?? 0; seen.set(b, n + 1); return n ? `${b}#${n}` : b })
  const fresh = useNewRows(keys, !!live)
  return (
    <div className="panel"><LiveAnchor anchorRef={anchorRef} /><table className="tbl">
      <thead><tr><th>Type</th>{!noActor && <th>Account</th>}<th>Activity</th><th className="r">Value</th><th className="r">Time</th></tr></thead>
      <tbody {...pendingRows(pending)}>
        {loading && !rows.length ? <TableSkeleton cols={cols} rows={pageSize} />
          : error && !rows.length ? <ErrorRow cols={cols} title="Couldn’t load activity" error={error} onRetry={onRetry} />
            : !rows.length ? <EmptyRow cols={cols}>No activity</EmptyRow>
              : rows.map((r, i) => {
                const slug = activitySlug(r)
                const aid = activityId(r, dcaExecutionLinks)
                // De-emphasise low-/zero-value activity (null treated as low) so high-value rows stand out. Not hidden — just muted via the .dim class.
                const dim = r.valueUsd == null || r.valueUsd < 10
                // Unfinalized rows have no detail page yet (the classifier runs
                // at finality) — dimmed and non-navigable until then.
                const unfinalized = r.finalized === false
                const nav = aid && !unfinalized ? rowNav(paths.activityDetail(slug, aid)) : null
                const k = keys[i]
                const className = [nav?.className, dim ? 'dim' : null, fresh.has(k) ? 'row-new' : null, unfinalized ? 'unfinalized' : null].filter(Boolean).join(' ') || undefined
                const showExt = slug !== 'swap' && slug !== 'dca' && r.extrinsicIndex != null
                return (
                  <tr key={k} {...(nav ?? {})} className={className} title={unfinalized ? 'Awaiting finality — may still reorganize' : undefined} {...(aid && !unfinalized ? { 'data-activity': `${slug}/${aid}` } : {})} {...(showExt ? { 'data-ext': `${r.blockHeight}-${r.extrinsicIndex}` } : {})}>
                    <td data-label="Type"><ActivityBadge r={r} /></td>
                    {!noActor && <td data-label="Account">{r.who ? <AddrPill account={r.who} noCopy /> : <Dash />}</td>}
                    <td data-label="Activity"><ActivityDesc r={r} /></td>
                    <td data-label="Value" className="r mono">{r.valueUsd != null ? F.usd(r.valueUsd) : <Dash />}</td>
                    <td data-label="Time" className="r mono muted"><Ago ts={r.timestamp} now={now} /></td>
                  </tr>
                )
              })}
      </tbody>
    </table></div>
  )
}
