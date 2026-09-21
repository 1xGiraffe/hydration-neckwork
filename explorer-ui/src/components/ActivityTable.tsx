/* eslint-disable react-refresh/only-export-components -- activity table exports slug/id/label helpers alongside its components */
import { useMemo } from 'react'
import { Link, paths } from '../router'
import type { ActivitySlug } from '../router'
import { F, Amt, Usd, AddrPill, AssetChip, AssetAmount, AssetIcon, rowNav, Ago, Waiting, AccountEmoji, ShortAddr, TagIcon, tagMemberSuffix, VoteSideBadge, TableSkeleton, Dash, EmptyRow, ErrorRow, pendingRows, LiveAnchor, ContractGlyph } from './ui'
import { useNewRows } from '../hooks/useNewRows'
import { LIQ_LABELS, activityBadge, BOND_LABELS, intentLabel } from './activityColors'
import { parseUtcTimestamp } from '../utils/time'
import { fmtDuration } from '../utils/dca'
import { resolveTag, useTagMapVersion } from '../userTags'
import { convictionLabel, voteSubjectLabel } from '../utils/voteRows'
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
  NEAR: ['#00c586', '#00875c'],
  Zcash: ['#b8860b', '#7a5a08'],
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
// live on Subscan for substrate chains, Orb/Etherscan for Solana/Ethereum.
// Every explorer a bridged journey can reach, so a Base link never says "Subscan".
// Ordered longest-suffix first where hosts nest (optimistic.etherscan.io).
const EXPLORER_SITES: [string, string][] = [
  ['optimistic.etherscan.io', 'Etherscan'],
  ['nearblocks.io', 'NearBlocks'],
  ['neuroweb.ai', 'NeuroWeb'],
  ['blockchair.com', 'Blockchair'],
  ['orbmarkets.io', 'Orb'],
  ['robinscan.io', 'Robinscan'],
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
    case 'liquidity': return r.liqAction === 'Remove' ? 'remove-liquidity' : r.liqAction === 'Create' ? 'create-pool' : r.liqAction === 'Destroy' ? 'destroy-pool' : r.liqAction === 'Claim' ? 'claim-rewards' : r.liqAction === 'ClaimReferral' ? 'claim-referral-rewards' : r.liqAction === 'CollectFees' ? 'collect-fees' : r.liqAction === 'Rebalance' ? 'rebalance' : 'add-liquidity'
    case 'mm': return MM_SLUG[r.mmAction ?? ''] ?? 'lend'
    case 'staking': return 'staking'
    case 'bond': return r.bondAction === 'Redeem' ? 'bond-redeem' : 'bond-issue'
    // A partial fill is a fill: one slug covers both (the badge tells them apart).
    case 'intent': return r.intentAction === 'Place' ? 'intent-place' : r.intentAction === 'Cancel' ? 'intent-cancel' : r.intentAction === 'Expire' ? 'intent-expire' : r.intentAction === 'DcaTrade' ? 'intent-dca-trade' : 'intent-fill'
    case 'vote': return 'vote'
    case 'otc': return r.otcAction === 'Pull' ? 'otc-pull' : r.otcAction === 'Fill' ? 'otc-fill' : 'otc-place'
    default: return 'transfer'
  }
}
// The coordinates a row occupies in its block — the id every activity detail page is
// addressed by. activityId() prefers a row's HOME over these for the families whose
// rows are one step of a longer thing.
// A destination-chain address (a NEAR account name, a Zcash transparent address).
// Not an SS58 or an H160, so none of the account plumbing applies: a NEAR name is
// already human-readable and is shown whole, anything else is elided in the middle
// the way AddrPill elides a hash.
export function shortForeignAddress(address: string): string {
  if (address.length <= 20) return address
  return `${address.slice(0, 8)}…${address.slice(-4)}`
}
// A destination-chain address, with the tail tinted exactly as ShortAddr tints a
// Hydration one — the last three characters are what a reader compares when two
// addresses share a prefix, and a NEAR implicit account is 64 hex of prefix.
//
// Only when the address is actually TRUNCATED. A NEAR account can be named
// (`crypthor.near`), which is shown whole, and tinting the final letters of a
// word disambiguates nothing — it just reads as a typo.
export function ForeignAddr({ address }: { address: string }) {
  const short = shortForeignAddress(address)
  if (short === address) return <>{address}</>
  return <>{short.slice(0, -3)}<span className="last3">{short.slice(-3)}</span></>
}

function coordinateId(r: ActivityRow): string | null {
  if (r.eventIndex != null) return `${r.blockHeight}-e${r.eventIndex}`
  if (r.extrinsicIndex != null) return `${r.blockHeight}-${r.extrinsicIndex}`
  return null
}
export function activityId(r: ActivityRow, dcaExecutionLink = false): string | null {
  // DCA rows link to their owning SCHEDULE page, not a single fill — except on
  // the schedule, block and extrinsic pages, where a row IS one execution and
  // links to its own execution detail (/dca/<block>-e<eventIndex>), which in
  // turn links to the schedule.
  if (!dcaExecutionLink && (r.type === 'dca' || r.dca) && r.dcaScheduleId != null) return String(r.dcaScheduleId)
  // An intent row follows the same rule: its ORDER page from a feed (the full u128 id,
  // a decimal string), its own event on the block and extrinsic pages. Without an
  // order id it takes the coordinates — /intent-fill/<h>-e<i> resolves like any slug.
  if (r.type === 'intent' && !dcaExecutionLink && r.intentId != null) return r.intentId
  return coordinateId(r)
}
// Where a row's link goes, for the id activityId() chose. Coordinates live under the
// row's slug (/otc-fill/<h>-e<i>, /intent-fill/<h>-e<i>) and a DCA schedule id under
// /dca; an intent's ORDER id is the one id with a page elsewhere, /intent/<id>. It is
// recognised by VALUE, not by the row's type — an intent row handed its coordinates
// must land on its slug page, never on /intent/<h>-e<i>.
export function activityHref(r: ActivityRow, id: string): string {
  // A cross-chain swap has no detail page of its own: what there is to see is the
  // extrinsic that placed it, which carries the Router legs, the NTT settlement and
  // the order's own log. Without this it fell through activitySlug's default and
  // linked to /transfer/<coords>, which resolves to nothing.
  if (r.type === 'xcswap' && r.extrinsicIndex != null) return paths.extrinsicAt(r.blockHeight, r.extrinsicIndex)
  return r.type === 'intent' && id === r.intentId ? paths.intent(id) : paths.activityDetail(activitySlug(r), id)
}
// A slug names a URL, and `claim-rewards` is the URL of BOTH reward claims (see
// SLUG_TYPES), so its label stays the family-neutral one — which claim a row is
// comes from its badge and its Action row, and those name the position it pays out.
const SLUG_LABEL: Record<ActivitySlug, string> = {
  swap: 'Swap', dca: 'DCA', transfer: 'Transfer', 'cross-chain': 'Cross-chain',
  'add-liquidity': 'Add liquidity', 'remove-liquidity': 'Remove liquidity', 'create-pool': 'Create pool', 'destroy-pool': 'Destroy pool', 'claim-rewards': 'Claim rewards', 'claim-referral-rewards': 'Claim referral rewards',
  'collect-fees': LIQ_LABELS.CollectFees, rebalance: LIQ_LABELS.Rebalance,
  lend: 'Lend', withdraw: 'Withdraw', borrow: 'Borrow', repay: 'Repay',
  liquidate: 'Liquidate', staking: 'Staking', vote: 'Vote',
  'otc-place': 'OTC place', 'otc-pull': 'OTC pull', 'otc-fill': 'OTC fill',
  'bond-issue': BOND_LABELS.Issue, 'bond-redeem': BOND_LABELS.Redeem,
  'intent-place': intentLabel('swap', 'Place'), 'intent-fill': intentLabel('swap', 'Fill'), 'intent-cancel': intentLabel('swap', 'Cancel'), 'intent-expire': intentLabel('swap', 'Expire'),
  'intent-dca-trade': intentLabel('dca', 'DcaTrade'),
}
export function activityLabel(slug: ActivitySlug): string { return SLUG_LABEL[slug] }

// Coarse activity type(s) an id is matched against — action-level slugs of the
// same family are interchangeable at resolve time (slug is presentation).
export const SLUG_TYPES: Record<ActivitySlug, ActivityRow['type'][]> = {
  swap: ['trade', 'dca'], dca: ['trade', 'dca'], transfer: ['transfer'],
  'cross-chain': ['xcm'], 'add-liquidity': ['liquidity'], 'remove-liquidity': ['liquidity'], 'create-pool': ['liquidity'], 'destroy-pool': ['liquidity'], 'claim-rewards': ['liquidity', 'mm'], 'claim-referral-rewards': ['liquidity'],
  'collect-fees': ['liquidity'], rebalance: ['liquidity'],
  lend: ['mm'], withdraw: ['mm'], borrow: ['mm'], repay: ['mm'], liquidate: ['mm'],
  staking: ['staking'], vote: ['vote'],
  'otc-place': ['otc'], 'otc-pull': ['otc'], 'otc-fill': ['otc'],
  'bond-issue': ['bond'], 'bond-redeem': ['bond'],
  'intent-place': ['intent'], 'intent-fill': ['intent'], 'intent-cancel': ['intent'], 'intent-expire': ['intent'], 'intent-dca-trade': ['intent'],
}

export { parseId } from '../utils/activityIds'

// Canonical URL for a resolved row, or null when the current slug+id are already canonical.
export function canonicalTarget(row: ActivityRow, slug: ActivitySlug, id: string): string | null {
  const canonicalSlug = activitySlug(row)
  // An intent row's activityId is its ORDER — the row link's target. This page is the
  // one event, addressed by coordinates like every other activity page.
  const canonicalId = (row.type === 'intent' ? coordinateId(row) : activityId(row)) ?? id
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
  // The reader arrived at one block's event, so an intent owner hands over to its own
  // event (coordinates under its slug, as an OTC fill does), not to the order page. A
  // DCA owner keeps handing over to its schedule, as before.
  const ownerId = activityId(owner, owner.type === 'intent')
  return ownerId
    ? activityHref(owner, ownerId)
    : paths.extrinsic(`${owner.blockHeight}-${owner.extrinsicIndex}`)
}

// The transaction-pool marker: the space invader says "still in memory, not
// on the chain yet" without spending a word or a chip's width on it. It
// bobs where nothing else in the row moves; the bob stops under
// prefers-reduced-motion (CSS).
export function PoolChip() {
  return <span className="pool-chip" role="img" aria-label="In the transaction pool" title="In the transaction pool — projected, not yet in any block">👾</span>
}

// Conviction beside the side badge. It carries its own word because on a
// narrow screen the row wraps and the multiplier lands alone on a line, where
// a bare "6x" reads as a stray number rather than as how hard someone voted.
export function ConvictionTag({ conviction }: { conviction: string | null | undefined }) {
  const label = convictionLabel(conviction)
  if (!label) return null
  return <span className="muted conviction-tag" title="Conviction — the lock multiplier applied to this vote">{label}</span>
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

// When a limit order stops standing — future-facing where Ago is past-facing. Once
// the moment has passed the phrase says only that: whether the order filled or
// expired first is the order page's to tell.
function IntentDeadline({ iso, now }: { iso: string; now: number }) {
  const t = parseUtcTimestamp(iso)
  if (!Number.isFinite(t)) return null
  const left = (t - now) / 1000
  return <span className="muted" title={F.datetime(iso)}>{left > 0 ? `expires in ${fmtDuration(left)}` : 'deadline passed'}</span>
}

// One row's activity, as a phrase. `headed` marks a surface whose page HEADER
// already states the row's context — the detail pages do, a list row has no header
// above it — so there the phrase drops the facts the header repeats and keeps only
// what it alone carries (the assets and amounts).
// `now` is the caller's shared clock (the one its Ago column ticks on); it drives the
// one relative phrase here, an order's deadline, so every row on a surface agrees.
export function ActivityDesc({ r, headed, now }: { r: ActivityRow; headed?: boolean; now: number }) {
  // A hop's two ends ARE its phrase, so cross-chain is the one family that keeps
  // them on a headed surface too. Naming one end in a page subtitle is not the same
  // as drawing the journey: this page's Activity row used to read "AAVE 30.4" and
  // say nothing about where it came from or landed. So both xcm branches below
  // ignore `headed` for the chain badges, and the detail page reads like its row.
  if (r.type === 'xcm' && r.xcmDir === 'in' && r.asset) {
    // Inbound: origin chain (+ source account when the crosschain index resolved
    // it), then the arrow, then the chain it landed on with the asset it credited.
    const origin = <><ChainBadge chain={r.fromChain ?? ''} />{r.fromAccount && <ExternalAccountPill account={r.fromAccount} />}</>
    return <span className="asset-flow">{origin} → <HydrationBadge /><AssetAmount asset={r.asset} raw={r.amount} /></span>
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
    return <span className="asset-flow">{local}<AssetAmount asset={r.asset} raw={r.amount} />{dest ? <> → {dest}</> : null}</span>
  }
  if ((r.type === 'trade' || r.type === 'dca') && r.assetIn && r.assetOut) {
    return <span className="asset-flow"><AssetAmount asset={r.assetIn} raw={r.amountIn} /> → <AssetAmount asset={r.assetOut} raw={r.amountOut} />{r.dcaStatus === 'failed' && <span className="muted">Failed attempt</span>}</span>
  }
  if (r.type === 'xcswap' && r.assetIn) {
    // Read as the cross-chain hop above: each side is its chain, then what sits
    // on it. Hydration's side is the asset sold; the far side is the chain it
    // settles on, the asset delivered there and the account that receives it.
    //
    // The delivered asset is not a registry asset, so it has no asset id — but
    // it has an origin, which is all AssetIcon needs to resolve artwork, and the
    // recipient's emoji derives from its own address exactly as every other
    // account's does. A NEAR account is named (`crypthor.near`) or a 64-hex
    // implicit one; both are addresses, neither is an identity we resolved.
    const sold = <><HydrationBadge /><AssetAmount asset={r.assetIn} raw={r.amountIn} /></>
    const chainName = r.xcswapDestChainName ?? r.xcswapDestChain
    // The badge carries the proof when there is one: the transaction that paid
    // the recipient, on that chain's own explorer.
    const chain = chainName
      ? (r.xcswapDestTxUrl
        ? <a href={r.xcswapDestTxUrl} target="_blank" rel="noopener" data-no-hover="true"
             title={`Settling transaction on ${chainName}`}><ChainBadge chain={chainName} /></a>
        : <ChainBadge chain={chainName} />)
      : null
    const delivered = r.xcswapDestSymbol
      ? <span className="trade-leg">
        {r.xcswapDestOrigin && <AssetIcon assetId={0} symbol={r.xcswapDestSymbol} origin={r.xcswapDestOrigin} />}
        {' '}<span className="mono">{r.xcswapDestAmount && r.xcswapDestDecimals != null ? <><Amt raw={r.xcswapDestAmount} dec={r.xcswapDestDecimals} />{' '}</> : null}{r.xcswapDestSymbol}</span>
      </span>
      : <span className="muted">bridging out</span>
    // The same pill ExternalAccountPill gives an XCM counterparty: emoji, the
    // address, then the explorer that opens it.
    const recipient = !headed && r.xcswapRecipient
      ? (r.xcswapRecipientUrl
        ? <a className="addr-pill ext-account" href={r.xcswapRecipientUrl} target="_blank" rel="noopener"
             title={`${r.xcswapRecipient} · opens ${explorerSiteName(r.xcswapRecipientUrl)}`} data-no-hover="true">
          <AccountEmoji account={{ accountId: r.xcswapRecipient }} />
          <span className="a mono"><ForeignAddr address={r.xcswapRecipient} /></span>
          <span className="ext-site">{explorerSiteName(r.xcswapRecipientUrl)}</span>
        </a>
        : <span className="addr-pill" title={r.xcswapRecipient}>
          <AccountEmoji account={{ accountId: r.xcswapRecipient }} />
          <span className="a mono"><ForeignAddr address={r.xcswapRecipient} /></span>
        </span>)
      : null
    return <span className="asset-flow">{sold} → {chain}{delivered}{recipient}
      {!headed && r.xcswapStatus === 'REFUNDED' && <span className="muted">refunded</span>}
      {/* The badge names the action, so the row has to name the OUTCOME: without
          this, an order whose destination never arrives reads exactly like one
          that settled. Shown whenever the sweep has not seen a delivery — an
          unresolved order included, which is the state a fresh order is in. */}
      {!headed && r.xcswapStatus !== 'SUCCESS' && r.xcswapStatus !== 'REFUNDED' && r.xcswapStatus !== 'FAILED'
        && <span className="muted">awaiting delivery</span>}
    </span>
  }
  if (r.type === 'intent' && r.assetIn && r.assetOut) {
    // A fill — or a DCA intent's trade — moved value and reads like a swap. A
    // placement states the limit: what is sold, and the least it must fetch, with the
    // terms that bound it. A cancel or expiry restates that limit as what was left
    // standing. The short #seq is the order's handle in a list; a headed page carries
    // it (and the terms) as labelled rows instead.
    const traded = r.intentAction === 'Fill' || r.intentAction === 'PartialFill' || r.intentAction === 'DcaTrade'
    const seq = headed || r.intentSeq == null ? null : <span className="muted">#{r.intentSeq}</span>
    if (traded) {
      return <span className="asset-flow"><AssetAmount asset={r.assetIn} raw={r.amountIn} /> → <AssetAmount asset={r.assetOut} raw={r.amountOut} />
        {!headed && r.intentAction === 'DcaTrade' && r.intentRemainingBudget != null && <span className="muted"><Amt raw={r.intentRemainingBudget} dec={r.assetIn.decimals} /> {r.assetIn.symbol} left</span>}
        {seq}</span>
    }
    // A DCA intent sells its budget in slices the pallet sizes, so its placement names
    // the whole budget and the asset it buys — there is no single limit to state.
    const limit = r.intentKind === 'dca'
      ? <><AssetAmount asset={r.assetIn} raw={r.amountIn} /> → <AssetChip asset={r.assetOut} /></>
      : <>sell <AssetAmount asset={r.assetIn} raw={r.amountIn} /> for ≥ <AssetAmount asset={r.assetOut} raw={r.amountOut} /></>
    return <span className="asset-flow">{limit}
      {!headed && r.intentPartial && <span className="muted">partial fills</span>}
      {!headed && r.intentDeadline && <IntentDeadline iso={r.intentDeadline} now={now} />}
      {seq}</span>
  }
  if (r.type === 'otc') {
    // A fill has two accounts. The Account column carries the taker who called
    // it, so the maker whose order it consumed goes where a transfer's
    // recipient goes — the trailing pill — and the row reads the same way:
    // actor on the left, counterparty at the end.
    const maker = r.to ? <AddrPill account={r.to} noCopy /> : null
    // Pull rows without an enriched leg pair (the Placed-by-orderId lookup
    // missed) render the order id alone — same fallback the design calls out.
    // Kept even when headed: with no legs the order id is all this phrase has to say.
    if (!r.assetIn || !r.assetOut) return <span className="asset-flow"><span className="muted">Order #{r.otcOrderId}</span>{maker}</span>
    return <span className="asset-flow"><AssetAmount asset={r.assetIn} raw={r.amountIn} /> → <AssetAmount asset={r.assetOut} raw={r.amountOut} />{headed ? null : <span className="muted">#{r.otcOrderId}</span>}{maker}</span>
  }
  if (r.type === 'liquidity' && r.assetIn && r.assetOut) {
    // Pool creation seeds two assets, and a concentrated-liquidity position or vault
    // act moves both tokens — show both legs side by side.
    return <span className="asset-flow"><AssetAmount asset={r.assetIn} raw={r.amountIn} /> + <AssetAmount asset={r.assetOut} raw={r.amountOut} /></span>
  }
  if ((r.type === 'mm' || r.type === 'liquidity' || r.type === 'staking' || r.type === 'bond') && r.asset) {
    return <span className="asset-flow"><AssetAmount asset={r.asset} raw={r.amount} /></span>
  }
  if (r.type === 'vote' && r.asset) {
    const locked = <AssetAmount asset={r.asset} raw={r.amount} />
    // Headed, the referendum, the side and the conviction are all in the page title's
    // own subtitle, so the locked capital is the one fact left to state; the
    // referendum stays reachable through that page's Referendum row.
    if (headed) return <span className="asset-flow">{locked}</span>
    // A referendum's title says what the vote was about; "Ref 255" does not. The
    // title comes from SubSquare and may not be fetched yet, so the index is the
    // fallback rather than a placeholder. Only ConvictionVoting/Democracy rows have a
    // referendum page — Council/TC votes carry a proposal hash instead, which is why
    // the label is shared with the votes table (see voteSubjectLabel).
    // The index identifies the referendum, the title says what it is: show the index
    // muted ahead of a plain link on the title, which carries the referendum hover
    // card. A hash is not an index, so a motion leads with its label alone.
    return <span className="asset-flow vote-flow">{locked}
      {r.voteRef && r.voteRefPallet && <span className="muted mono ref-num">#{r.voteRef}</span>}
      {r.voteRefPallet && r.voteRef
        ? <Link to={paths.referendum(r.voteRefPallet, r.voteRef)} className="ref-link">{r.voteRefTitle ?? 'Referendum'}</Link>
        : <span className="muted">{voteSubjectLabel(r.voteRef, r.voteRefPallet, r.voteRefTitle)}</span>}
      <VoteSideBadge side={r.voteSide} /><ConvictionTag conviction={r.voteConviction} /></span>
  }
  return null
}

// Stable identity for a activity row, for React keys + live new-row detection.
function activityKey(r: ActivityRow): string {
  // A mempool row's only identity is its transaction hash (block coordinates
  // are 0 placeholders) — and its amounts stay IN the key, so a re-projection
  // that changes the numbers reads as a new row and flashes.
  return [r.type, r.blockHeight, r.hash ?? '', r.extrinsicIndex ?? r.eventIndex ?? '', r.assetIn?.assetId ?? r.asset?.assetId ?? '',
    r.assetOut?.assetId ?? '', r.amountIn ?? r.amount ?? '', r.who?.accountId ?? '', r.mmMarketKey ?? ''].join('|')
}

// `pageSize` sizes the loading skeleton, so a paged feed reserves the height it is
// about to fill and the pager beneath it does not jump. Unpaged surfaces (a block's
// or extrinsic's own activity) show whatever the record holds and leave it unset.
export function ActivityTable({ rows, noActor, now, live, anchorRef, loading, pending, error, onRetry, dcaExecutionLinks, pageSize }: { rows: ActivityRow[]; noActor?: boolean; now: number; live?: boolean; anchorRef?: (el: HTMLElement | null) => void; loading?: boolean; pending?: boolean; error?: unknown; onRetry?: () => void; dcaExecutionLinks?: boolean; pageSize?: number }) {
  // Type · [Account] · Activity · Protocol revenue · Value · Time — the span the
  // skeleton, empty and error rows must cover for the full table width.
  const cols = noActor ? 5 : 6
  // Deduped stable keys: same row → same key across renders (so prepended live rows
  // are detected as new without remounting the rest); duplicates get a suffix.
  // Memoized on the rows because the surrounding pages re-render on the 1 Hz
  // clock, and only a new page of rows can change the answer.
  const keys = useMemo(() => {
    const seen = new Map<string, number>()
    return rows.map(r => { const b = activityKey(r); const n = seen.get(b) ?? 0; seen.set(b, n + 1); return n ? `${b}#${n}` : b })
  }, [rows])
  const fresh = useNewRows(keys, !!live)
  return (
    <div className="panel"><LiveAnchor anchorRef={anchorRef} /><table className="tbl">
      <thead><tr><th>Type</th>{!noActor && <th>Account</th>}<th>Activity</th><th className="r" title="Protocol revenue this extrinsic generated">Revenue</th><th className="r">Value</th><th className="r">Time</th></tr></thead>
      <tbody {...pendingRows(pending)}>
        {loading && !rows.length ? <TableSkeleton cols={cols} rows={pageSize} />
          : error && !rows.length ? <ErrorRow cols={cols} title="Couldn’t load activity" error={error} onRetry={onRetry} />
            : !rows.length ? <EmptyRow cols={cols}>No activity</EmptyRow>
              : rows.map((r, i) => {
                const slug = activitySlug(r)
                const aid = activityId(r, dcaExecutionLinks)
                // De-emphasise low-/zero-value activity (null treated as low) so high-value rows stand out. Not hidden — just muted via the .dim class.
                const dim = r.valueUsd == null || r.valueUsd < 10
                // Mempool rows are dry-run PROJECTIONS of transactions no block
                // holds yet — specially marked (not dimmed like unfinalized: the
                // point is to stand out), non-navigable, replaced by their
                // unfinalized row on inclusion. Their hash link is the one
                // navigation that already works.
                const mempool = r.mempool === true
                // Unfinalized rows ARE navigable: the block, extrinsic, trade and
                // activity detail lookups all answer from the same pending layer
                // this row came from, so the page opens (marked unfinalized) and
                // upgrades itself when the block settles. A row with no
                // coordinates to link — a hook-phase swap — still has no target.
                const unfinalized = r.finalized === false && !mempool
                const nav = aid && !mempool ? rowNav(activityHref(r, aid)) : null
                const k = keys[i]
                const className = [nav?.className, dim ? 'dim' : null, fresh.has(k) ? 'row-new' : null, unfinalized ? 'unfinalized' : null, mempool ? 'mempool' : null].filter(Boolean).join(' ') || undefined
                const title = mempool ? 'In the transaction pool — the outcome shown is a dry-run projection, not yet in any block'
                  : unfinalized ? 'Awaiting finality — may still reorganize' : undefined
                const showExt = slug !== 'swap' && slug !== 'dca' && r.extrinsicIndex != null && !mempool
                return (
                  <tr key={k} {...(nav ?? {})} className={className} title={title} {...(aid && !mempool ? { 'data-activity': `${slug}/${aid}` } : {})} {...(showExt ? { 'data-ext': `${r.blockHeight}-${r.extrinsicIndex}` } : {})}>
                    <td data-label="Type"><ActivityBadge r={r} /></td>
                    {!noActor && <td data-label="Account">{r.who ? <AddrPill account={r.who} noCopy /> : <Dash />}</td>}
                    <td data-label="Activity"><ActivityDesc r={r} now={now} /></td>
                    {/* A dash is "not booked yet", never "$0": the revenue model trails
                        the head, and the field is only present once the block is booked. */}
                    <td data-label="Protocol revenue" className="r mono muted">{r.revenue ? <Usd v={r.revenue.protocolUsd} /> : <Dash />}</td>
                    <td data-label="Value" className="r mono">{r.valueUsd != null ? <Usd v={r.valueUsd} /> : <Dash />}</td>
                    <td data-label="Time" className="r mono muted">{mempool ? <><PoolChip /><Waiting ts={r.timestamp} now={now} /></> : <Ago ts={r.timestamp} now={now} />}</td>
                  </tr>
                )
              })}
      </tbody>
    </table></div>
  )
}
