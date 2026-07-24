/* eslint-disable react-refresh/only-export-components -- activity table exports slug/id/label helpers alongside its components */
import { paths } from '../router'
import type { ActivitySlug } from '../router'
import { F, AddrPill, AssetChip, rowNav, Ago, AccountEmoji, ShortAddr, TagIcon, VoteSideBadge, TableSkeleton, Dash } from './ui'
import { useNewRows } from '../hooks/useNewRows'
import type { ActivityRow } from '../types'

// Chain badge for cross-chain (XCM) destinations — full network names, brand
// gradients for the frequent chains, neutral gray for the rest.
const CHAIN_COLORS: Record<string, [string, string]> = {
  Polkadot: ['#e6007a', '#bc0566'],
  AssetHub: ['#2C89E9', '#1f5cab'],
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
// The external-explorer label follows the link target — cross-chain accounts
// live on Subscan for substrate chains, Solscan/Etherscan for Solana/Ethereum.
export function explorerSiteName(url: string): string {
  try {
    const host = new URL(url).hostname
    if (host.endsWith('solscan.io')) return 'Solscan'
    if (host.endsWith('etherscan.io')) return 'Etherscan'
  } catch { /* fall through */ }
  return 'Subscan'
}
export function ExternalAccountPill({ account }: { account: NonNullable<ActivityRow['destAccount']> }) {
  const iconSeed = account.raw || account.address
  const tag = account.tag
  const identity = account.identity
  // Same pubkey, same Hydration tag/identity, even on another chain — priority
  // tag > identity, mirroring AddrPill's name precedence and classes (the "tag"
  // class + small ✓ for a verified on-chain identity). The short address keeps
  // showing via the pill's title when a name takes its place in the body.
  const name = tag
    ? <span className="tag" style={{ color: tag.color }}>{tag.name}</span>
    : identity?.display
      ? <>
        <span className="tag">{identity.display}</span>
        {identity.verified && <span className="id-verified" title="Verified identity">✓</span>}
      </>
      : null
  const body = <>
    {tag
      ? <TagIcon icon={tag.icon} color={tag.color} title={tag.name} />
      : <AccountEmoji account={{ accountId: iconSeed, emoji: account.emoji, emojiName: account.emojiName, emojiUrl: account.emojiUrl }} />}
    {name ?? <span className="a mono"><ShortAddr addr={account.address} /></span>}
  </>
  if (!account.subscanUrl) return <span className="addr-pill" title={account.address}>{body}</span>
  const site = explorerSiteName(account.subscanUrl)
  return <a className="addr-pill ext-account" href={account.subscanUrl} target="_blank" rel="noopener" title={`${account.address} · opens ${site}`} data-no-hover="true">{body}<span className="ext-site">{site}</span></a>
}

function badge(r: ActivityRow): { label: string; col: string } {
  if (r.type === 'mm') {
    const a = r.mmAction || 'Supply'
    const liq = a === 'LiquidationCall' || a === 'Liquidate'
    return { label: liq ? 'Liquidate' : a === 'ClaimRewards' ? 'Claim rewards' : a, col: liq ? 'var(--red)' : (a === 'Borrow' || a === 'Withdraw') ? 'var(--amber)' : 'var(--green)' }
  }
  if (r.type === 'staking') {
    const a = r.stakingAction || 'Staking'
    const reward = /reward|payout/i.test(a)
    const out = /unstake|cancel/i.test(a)
    return { label: a, col: reward ? 'var(--green)' : out ? 'var(--amber)' : 'var(--lavender)' }
  }
  if (r.type === 'vote') return { label: r.voteAction || 'Vote', col: 'var(--sky)' }
  if (r.type === 'liquidity') return { label: r.liqAction === 'Remove' ? 'Remove liquidity' : r.liqAction === 'Create' ? 'Create pool' : r.liqAction === 'Claim' ? 'Claim rewards' : r.liqAction === 'Add' ? 'Add liquidity' : 'Liquidity', col: r.liqAction === 'Remove' ? 'var(--amber)' : 'var(--green)' }
  if (r.type === 'trade') return r.dca
    ? { label: r.dcaStatus === 'failed' ? 'DCA failed' : 'DCA', col: r.dcaStatus === 'failed' ? 'var(--red)' : 'var(--amber)' }
    : { label: 'Swap', col: 'var(--accent)' }
  if (r.type === 'otc') {
    const a = r.otcAction
    return { label: 'OTC ' + (a ?? 'order').toLowerCase(), col: a === 'Pull' ? 'var(--amber)' : a === 'Fill' ? 'var(--green)' : 'var(--sky)' }
  }
  const M: Record<string, [string, string]> = { transfer: ['Transfer', 'var(--sky)'], xcm: ['Cross-chain', 'var(--lavender)'], dca: [r.dcaStatus === 'failed' ? 'DCA failed' : 'DCA', r.dcaStatus === 'failed' ? 'var(--red)' : 'var(--amber)'] }
  const m = M[r.type] || ['Activity', 'var(--text-medium)']
  return { label: m[0], col: m[1] }
}

const MM_SLUG: Record<string, ActivitySlug> = {
  Supply: 'supply', Withdraw: 'withdraw', Borrow: 'borrow', Repay: 'repay',
  LiquidationCall: 'liquidate', Liquidate: 'liquidate',
  ClaimRewards: 'claim-rewards',
}
// Canonical detail-page slug for a activity row — mirrors badge() labels.
export function activitySlug(r: ActivityRow): ActivitySlug {
  switch (r.type) {
    case 'trade': return r.dca ? 'dca' : 'swap'
    case 'dca': return 'dca'
    case 'xcm': return 'cross-chain'
    case 'liquidity': return r.liqAction === 'Remove' ? 'remove-liquidity' : r.liqAction === 'Create' ? 'create-pool' : r.liqAction === 'Claim' ? 'claim-rewards' : 'add-liquidity'
    case 'mm': return MM_SLUG[r.mmAction ?? ''] ?? 'supply'
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
const SLUG_LABEL: Record<ActivitySlug, string> = {
  swap: 'Swap', dca: 'DCA', transfer: 'Transfer', 'cross-chain': 'Cross-chain',
  'add-liquidity': 'Add liquidity', 'remove-liquidity': 'Remove liquidity', 'create-pool': 'Create pool', 'claim-rewards': 'Claim rewards',
  supply: 'Supply', withdraw: 'Withdraw', borrow: 'Borrow', repay: 'Repay',
  liquidate: 'Liquidate', staking: 'Staking', vote: 'Vote',
  'otc-place': 'OTC place', 'otc-pull': 'OTC pull', 'otc-fill': 'OTC fill',
}
export function activityLabel(slug: ActivitySlug): string { return SLUG_LABEL[slug] }

// Coarse activity type(s) an id is matched against — action-level slugs of the
// same family are interchangeable at resolve time (slug is presentation).
export const SLUG_TYPES: Record<ActivitySlug, ActivityRow['type'][]> = {
  swap: ['trade', 'dca'], dca: ['trade', 'dca'], transfer: ['transfer'],
  'cross-chain': ['xcm'], 'add-liquidity': ['liquidity'], 'remove-liquidity': ['liquidity'], 'create-pool': ['liquidity'], 'claim-rewards': ['liquidity', 'mm'],
  supply: ['mm'], withdraw: ['mm'], borrow: ['mm'], repay: ['mm'], liquidate: ['mm'],
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

export function ActivityBadge({ r }: { r: ActivityRow }) {
  const { label, col } = badge(r)
  const supplementalMarket = r.type === 'mm' && r.mmMarketKey && r.mmMarketKey !== 'core' ? r.mmMarket : null
  const partial = r.type === 'otc' && r.otcPartial ? 'partial' : null
  return <span className="activity-badge-group"><span className="pill-badge" style={{ color: col, background: `color-mix(in srgb, ${col} 15%, transparent)` }}>{label}</span>{supplementalMarket && <span className="mm-activity-market">{supplementalMarket}</span>}{partial && <span className="mm-activity-market">{partial}</span>}</span>
}

export function ActivityDesc({ r }: { r: ActivityRow }) {
  if (r.type === 'xcm' && r.xcmDir === 'in' && r.asset) {
    // Inbound cross-chain: origin chain (+ source account when the crosschain
    // index resolved it), then the arrow, then the credited asset.
    return <span className="asset-flow"><ChainBadge chain={r.fromChain ?? ''} />{r.fromAccount && <ExternalAccountPill account={r.fromAccount} />} → <span className="trade-leg"><AssetChip asset={r.asset} /> <span className="mono">{F.amount(r.amount, r.asset.decimals)}</span></span></span>
  }
  if ((r.type === 'transfer' || r.type === 'xcm') && r.asset) {
    // Asset first, then the arrow, then the destination account.
    return <span className="asset-flow"><span className="trade-leg"><AssetChip asset={r.asset} /> <span className="mono">{F.amount(r.amount, r.asset.decimals)}</span></span> → {r.type === 'xcm' && r.destChain && <ChainBadge chain={r.destChain} />}{r.type === 'xcm' && r.destAccount ? <ExternalAccountPill account={r.destAccount} /> : r.to && <AddrPill account={r.to} noCopy />}</span>
  }
  if ((r.type === 'trade' || r.type === 'dca') && r.assetIn && r.assetOut) {
    return <span className="asset-flow"><span className="trade-leg"><AssetChip asset={r.assetIn} /> <span className="mono">{F.amount(r.amountIn, r.assetIn.decimals)}</span></span> → <span className="trade-leg"><AssetChip asset={r.assetOut} /> <span className="mono">{F.amount(r.amountOut, r.assetOut.decimals)}</span></span>{r.dcaStatus === 'failed' && <span className="muted">Failed attempt</span>}</span>
  }
  if (r.type === 'otc') {
    // Pull rows without an enriched leg pair (the Placed-by-orderId lookup
    // missed) render the order id alone — same fallback the design calls out.
    if (!r.assetIn || !r.assetOut) return <span className="asset-flow"><span className="muted">Order #{r.otcOrderId}</span></span>
    return <span className="asset-flow"><span className="trade-leg"><AssetChip asset={r.assetIn} /> <span className="mono">{F.amount(r.amountIn, r.assetIn.decimals)}</span></span> → <span className="trade-leg"><AssetChip asset={r.assetOut} /> <span className="mono">{F.amount(r.amountOut, r.assetOut.decimals)}</span></span> <span className="muted">#{r.otcOrderId}</span></span>
  }
  if (r.type === 'liquidity' && r.liqAction === 'Create' && r.assetIn && r.assetOut) {
    // Pool creation seeds two assets — show both legs side by side.
    return <span className="asset-flow"><span className="trade-leg"><AssetChip asset={r.assetIn} /> <span className="mono">{F.amount(r.amountIn, r.assetIn.decimals)}</span></span> + <span className="trade-leg"><AssetChip asset={r.assetOut} /> <span className="mono">{F.amount(r.amountOut, r.assetOut.decimals)}</span></span></span>
  }
  if ((r.type === 'mm' || r.type === 'liquidity' || r.type === 'staking') && r.asset) {
    return <span className="asset-flow"><span className="trade-leg"><AssetChip asset={r.asset} /> <span className="mono">{F.amount(r.amount, r.asset.decimals)}</span></span></span>
  }
  if (r.type === 'vote' && r.asset) {
    const ref = r.voteRef ? `Ref ${r.voteRef}` : 'Referendum'
    return <span className="asset-flow"><span className="trade-leg"><AssetChip asset={r.asset} /> <span className="mono">{F.amount(r.amount, r.asset.decimals)}</span></span> <span className="muted">{ref}</span><VoteSideBadge side={r.voteSide} />{r.voteConviction ? <span className="muted">{r.voteConviction}</span> : null}</span>
  }
  return null
}

// Stable identity for a activity row, for React keys + live new-row detection.
function activityKey(r: ActivityRow): string {
  return [r.type, r.blockHeight, r.extrinsicIndex ?? r.eventIndex ?? '', r.assetIn?.assetId ?? r.asset?.assetId ?? '',
    r.assetOut?.assetId ?? '', r.amountIn ?? r.amount ?? '', r.who?.accountId ?? '', r.mmMarketKey ?? ''].join('|')
}

export function ActivityTable({ rows, noActor, now, live, loading, dcaExecutionLinks }: { rows: ActivityRow[]; noActor?: boolean; now: number; live?: boolean; loading?: boolean; dcaExecutionLinks?: boolean }) {
  const cols = noActor ? 4 : 5
  // Deduped stable keys: same row → same key across renders (so prepended live rows
  // are detected as new without remounting the rest); duplicates get a suffix.
  const seen = new Map<string, number>()
  const keys = rows.map(r => { const b = activityKey(r); const n = seen.get(b) ?? 0; seen.set(b, n + 1); return n ? `${b}#${n}` : b })
  const fresh = useNewRows(keys, !!live)
  return (
    <div className="panel"><table className="tbl">
      <thead><tr><th>Type</th>{!noActor && <th>Account</th>}<th>Activity</th><th className="r">Value</th><th className="r">Time</th></tr></thead>
      <tbody>
        {loading && !rows.length ? <TableSkeleton cols={cols} /> : rows.length ? rows.map((r, i) => {
          const slug = activitySlug(r)
          const aid = activityId(r, dcaExecutionLinks)
          // De-emphasise low-/zero-value activity (null treated as low) so high-value rows stand out. Not hidden — just muted via the .dim class.
          const dim = r.valueUsd == null || r.valueUsd < 10
          const nav = aid ? rowNav(paths.activityDetail(slug, aid)) : null
          const k = keys[i]
          const className = [nav?.className, dim ? 'dim' : null, fresh.has(k) ? 'row-new' : null].filter(Boolean).join(' ') || undefined
          const showExt = slug !== 'swap' && slug !== 'dca' && r.extrinsicIndex != null
          return (
            <tr key={k} {...(nav ?? {})} className={className} {...(aid ? { 'data-activity': `${slug}/${aid}` } : {})} {...(showExt ? { 'data-ext': `${r.blockHeight}-${r.extrinsicIndex}` } : {})}>
              <td data-label="Type"><ActivityBadge r={r} /></td>
              {!noActor && <td data-label="Account">{r.who ? <AddrPill account={r.who} noCopy /> : <Dash />}</td>}
              <td data-label="Activity"><ActivityDesc r={r} /></td>
              <td data-label="Value" className="r mono">{r.valueUsd != null ? F.usd(r.valueUsd) : <Dash />}</td>
              <td data-label="Time" className="r mono muted"><Ago ts={r.timestamp} now={now} /></td>
            </tr>
          )
        }) : <tr><td colSpan={cols} style={{ textAlign: 'center', padding: 32, color: 'var(--text-low)' }}>No activity</td></tr>}
      </tbody>
    </table></div>
  )
}
