import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/explorer'
import { useAddressSummary, useAsset, useExtrinsic, useBlock, useTagSummary, useTrade, useStats, useDcaSchedule, useDcaExecution } from '../hooks/useExplorerData'
import { useListTagSummary } from '../hooks/useUser'
import { F, AssetIcon, AssetChip, AssetAmount, AddrPill, CallPill, StatusBadge, FinalizedBadge, AccountEmoji, emojiName, moduleName, TagIcon, TokenIconRow, UserTagPill } from './ui'
import { ayeSharePct, selectTally } from '../utils/referendumVotes'
import { dcaCadence, dcaProgress, fmtDuration } from '../utils/dca'
import { resolveTag, allAssociations, useTagMapVersion, listForTag, tagMapStatus, looksLikeUserTagId } from '../userTags'
import type { AssetRef } from '../types'

// Global hover preview cards for account (.addr-pill), tag (/tag/… links),
// asset (.asset-chip), trade ([data-activity] with slug swap / /swap/…), DCA
// schedule and execution (slug dca / /dca/…), extrinsic (a.hash / [data-ext] →
// /extrinsic/…) and block (/block/…) links. Each card mirrors the basic-info
// block of its detail page. Mounted once in App.
type VoteContext = { side: string; conviction: string; weighted: string }
type Target = {
  kind: 'account' | 'tag' | 'list-tag' | 'asset' | 'trade' | 'dca-schedule' | 'dca-exec' | 'extrinsic' | 'block' | 'referendum'
  id: string
  listId?: string   // 'list-tag' only
  vote?: VoteContext
  left: number; top: number; bottom: number
}
const SELECTOR = '.addr-pill:not([data-no-hover]), .asset-chip, a.hash, a[href*="/swap/"], a[href*="/dca/"], a[href*="/block/"], a[href*="/referendum/"], [data-activity], [data-ext]'
const HOVER_DWELL_MS = 180

function ProfileMetrics({ portfolioUsd, debtUsd, tradingVolumeUsd, liquidationVolumeUsd, topAssets }: {
  portfolioUsd: number
  debtUsd: number
  tradingVolumeUsd?: number | null
  liquidationVolumeUsd?: number | null
  topAssets?: { asset: AssetRef; valueUsd: number }[]
}) {
  return (
    <>
      <div className="hc-row"><span>Value</span><span className="mono">{F.usd(portfolioUsd - debtUsd)}</span></div>
      {topAssets && topAssets.length > 0 && <div className="hc-row"><span>Holdings</span><TokenIconRow assets={topAssets} size={18} /></div>}
      {(tradingVolumeUsd ?? 0) > 0 && <div className="hc-row"><span>Trading volume</span><span className="mono">{F.usd(tradingVolumeUsd)}</span></div>}
      {(liquidationVolumeUsd ?? 0) > 0 && <div className="hc-row"><span>Liquidation volume</span><span className="mono">{F.usd(liquidationVolumeUsd)}</span></div>}
    </>
  )
}

// DCA ids come in two shapes: a bare schedule id (feed rows link to the
// schedule) and <block>-e<eventIndex> (schedule-page rows link to one
// execution). Neither resolves through the trade endpoints.
function dcaKind(id: string): Target['kind'] {
  return /^\d+-e\d+$/.test(id) ? 'dca-exec' : 'dca-schedule'
}

// A vote bubble is an account pill that also knows how that account voted, so the
// card can add the side, conviction and weighted power to the usual account rows.
function voteContext(el: Element): VoteContext | undefined {
  const host = el.closest('[data-vote-side]')
  if (!host) return undefined
  return {
    side: host.getAttribute('data-vote-side') ?? '',
    conviction: host.getAttribute('data-vote-conviction') ?? '',
    weighted: host.getAttribute('data-vote-weighted') ?? '',
  }
}

function parseTarget(el: Element): Omit<Target, 'left' | 'top' | 'bottom'> | null {
  if (el.closest('[data-no-hover]')) return null
  const act = el.getAttribute('data-activity')
  if (act) {
    const [slug, id] = act.split('/')
    if (slug === 'dca') return { kind: dcaKind(id), id }
    if (slug === 'swap') return { kind: 'trade', id }
    const ext = el.getAttribute('data-ext')
    return ext ? { kind: 'extrinsic', id: ext } : null
  }
  const ext = el.getAttribute('data-ext'); if (ext) return { kind: 'extrinsic', id: ext }
  const href = el.getAttribute('href') || ''
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href)
      if (url.origin !== window.location.origin) return null
    } catch { return null }
  }
  const rm = href.match(/\/referendum\/(opengov|democracy)\/(\d+)$/); if (rm) return { kind: 'referendum', id: `${rm[1]}/${rm[2]}` }
  const am = href.match(/\/account\/([^?#]+)$/); if (am) return { kind: 'account', id: decodeURIComponent(am[1]), vote: voteContext(el) }
  // A user tag's aggregate view now shares the system /tag/:id namespace —
  // disambiguate via the viewer's own tag-map, same as TagDetail's own routing.
  const tm = href.match(/\/tag\/([^?#]+)$/)
  if (tm) {
    const id = decodeURIComponent(tm[1])
    // While the map is still loading, a UUID-shaped id might yet turn out to
    // be a user tag — same ambiguity TagDetail's own routing waits out. Show
    // no card yet rather than guessing 'tag' (system) and hitting a lookup
    // that 404s forever on a real user-tag id (mirroring the bug TagDetail's
    // own skeleton exists to avoid, just for the hover card instead of the
    // page). 'error'/'anonymous' are terminal, same as a plain miss below.
    if (tagMapStatus() === 'loading' && looksLikeUserTagId(id)) return null
    const lib = listForTag(id)
    return lib ? { kind: 'list-tag', id, listId: lib.listId } : { kind: 'tag', id }
  }
  const sm = href.match(/\/asset\/(\d+)$/); if (sm) return { kind: 'asset', id: sm[1] }
  const dm = href.match(/\/dca\/([^?#]+)$/); if (dm) { const id = decodeURIComponent(dm[1]); return { kind: dcaKind(id), id } }
  const trm = href.match(/\/(?:trade|swap)\/([^?#]+)$/); if (trm) return { kind: 'trade', id: decodeURIComponent(trm[1]) }
  const xm = href.match(/\/extrinsic\/([^?#]+)$/); if (xm) return { kind: 'extrinsic', id: decodeURIComponent(xm[1]) }
  const bm = href.match(/\/block\/(\d+)(?:[?#]|$)/); if (bm) return { kind: 'block', id: bm[1] }
  return null
}

export function HoverCards() {
  const [target, setTarget] = useState<Target | null>(null)
  const showTimer = useRef<number | undefined>(undefined)
  const hideTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    function onOver(e: MouseEvent) {
      const t = e.target as HTMLElement
      if (t.closest('.hovercard')) return
      if (t.closest('[data-no-hover]')) return
      const el = t.closest(SELECTOR)
      if (!el) return
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return
      const parsed = parseTarget(el)
      if (!parsed) return
      window.clearTimeout(showTimer.current)
      window.clearTimeout(hideTimer.current)
      // Avoid full account/asset/detail requests when the pointer merely sweeps
      // across a table. Leaving before the dwell expires cancels the query wholly.
      showTimer.current = window.setTimeout(() => {
        if (!el.isConnected) return
        const r = el.getBoundingClientRect()
        setTarget({ ...parsed, left: r.left, top: r.top, bottom: r.bottom })
      }, HOVER_DWELL_MS)
    }
    function onOut(e: MouseEvent) {
      if ((e.target as HTMLElement).closest('[data-no-hover]')) return
      const el = (e.target as HTMLElement).closest(SELECTOR)
      if (!el) return
      if (e.relatedTarget instanceof Node && (el.contains(e.relatedTarget) || (e.relatedTarget as Element).closest?.('.hovercard'))) return
      window.clearTimeout(showTimer.current)
      hideTimer.current = window.setTimeout(() => setTarget(null), 160)
    }
    // Close the card as soon as navigation happens — clicking a link (incl. the
    // card's own "View …" link or a row) changes the route; without this the card
    // lingers over the next page until the mouse moves.
    const onNav = () => { window.clearTimeout(showTimer.current); window.clearTimeout(hideTimer.current); setTarget(null) }
    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', onOut)
    window.addEventListener('popstate', onNav)
    window.addEventListener('explorer:navigation', onNav)
    document.addEventListener('click', onNav, true)
    return () => {
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onOut)
      window.clearTimeout(showTimer.current)
      window.clearTimeout(hideTimer.current)
      window.removeEventListener('popstate', onNav)
      window.removeEventListener('explorer:navigation', onNav)
      document.removeEventListener('click', onNav, true)
    }
  }, [])

  if (!target) return null
  const W = 360
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 9999
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 9999
  const cardWidth = Math.min(W, Math.max(0, viewportWidth - 24))
  const left = Math.max(12, Math.min(target.left, viewportWidth - cardWidth - 12))
  // The card is `position: fixed` and placed in viewport coordinates, so it never
  // extends the document height. An absolutely-positioned card dropped below a
  // pill near the page bottom grew the page, which flip-flopped the layout and
  // made the card flicker. Flip above the anchor when there isn't room below, and
  // cap the height so the card always fits the viewport.
  const spaceBelow = viewportHeight - target.bottom
  const placeAbove = spaceBelow < 240 && target.top > spaceBelow
  const vStyle = placeAbove
    ? { bottom: Math.round(viewportHeight - target.top + 8), maxHeight: Math.max(96, Math.round(target.top - 16)) }
    : { top: Math.round(target.bottom + 8), maxHeight: Math.max(96, Math.round(spaceBelow - 16)) }
  return (
    <div className="hovercard" style={{ left, overflowY: 'auto', ...vStyle }}
      onMouseEnter={() => window.clearTimeout(hideTimer.current)}
      onMouseLeave={() => setTarget(null)}>
      {target.kind === 'account' ? <AccountHover id={target.id} vote={target.vote} />
        : target.kind === 'tag' ? <TagHover id={target.id} />
        : target.kind === 'list-tag' ? <ListTagHover listId={target.listId!} tagId={target.id} />
        : target.kind === 'asset' ? <AssetHover id={Number(target.id)} />
        : target.kind === 'trade' ? <TradeHover id={target.id} />
        : target.kind === 'dca-schedule' ? <DcaScheduleHover id={target.id} />
        : target.kind === 'dca-exec' ? <DcaExecutionHover id={target.id} />
        : target.kind === 'referendum' ? <ReferendumHover id={target.id} />
        : target.kind === 'block' ? <BlockHover id={Number(target.id)} />
        : <ExtrinsicHover id={target.id} />}
    </div>
  )
}

// Referendum card: what the vote was and where it stands. Asks for limit=1 because
// only the tallies and counts are shown here — the full voter list belongs to the
// page, and the endpoint caches its vote scan for a minute either way.
function ReferendumHover({ id }: { id: string }) {
  const [pallet, index] = id.split('/')
  const { data } = useQuery({
    queryKey: ['referendum-hover', pallet, index],
    queryFn: ({ signal }) => api.referendum(pallet as 'opengov' | 'democracy', Number(index), signal, 1),
    staleTime: 60_000,
  })
  if (!data) return <div className="hc-sub mono">Loading…</div>
  // Same selection and same BigInt share the page uses, so the card cannot say a
  // different percentage than the page it links to, and the AYE row still names its
  // source when the chain published no tally of its own (every Democracy referendum).
  const tally = selectTally(data)
  const ayePct = ayeSharePct(tally.ayes, tally.nays)
  return (
    <>
      <div className="hc-head">
        <span className="hc-emoji">🗳️</span>
        <div style={{ minWidth: 0 }}>
          <div className="hc-title">{data.title ?? `Referendum #${data.index}`}</div>
          <div className="hc-sub mono">{pallet === 'democracy' ? 'Democracy' : 'OpenGov'} #{data.index} · {data.status}{data.track != null ? ` · track ${data.track}` : ''}</div>
        </div>
      </div>
      {ayePct != null && <div className="tally-bar" style={{ marginBottom: 8 }}>
        <div className="tally-aye" style={{ width: `${ayePct}%` }} />
        <div className="tally-nay" style={{ width: `${100 - ayePct}%` }} />
      </div>}
      {ayePct != null && <div className="hc-row">
        <span>{tally.source === 'chain' ? 'AYE' : 'AYE (attributed)'}</span>
        <span className="mono">{ayePct.toFixed(1)}%</span>
      </div>}
      <div className="hc-row"><span>Voters</span><span className="mono">{F.int(data.directTally.voters)}</span></div>
      <div className="hc-row"><span>AYE / NAY</span><span className="mono">{F.int(data.directTally.ayeVoters)} / {F.int(data.directTally.nayVoters)}</span></div>
    </>
  )
}

// Compact account card: display name (priority tag / module / profile / identity
// / emoji name) and the value. No address — the pill being hovered already shows
// it. The associations row lists EVERY tag membership (not just the winner), so
// the card doubles as a quick "which of my lists is this in" lookup.
const MAX_HOVER_TAGS = 4
function AccountHover({ id, vote }: { id: string; vote?: VoteContext }) {
  useTagMapVersion()   // re-render when the viewer's tag map changes
  const { data } = useAddressSummary(id)
  if (!data) return <div className="hc-sub mono">Loading…</div>
  const mod = moduleName(data.accountId)
  const debtUsd = data.moneyMarket.reduce((s, p) => s + Number(p.totalDebtBase) / 1e8, 0)
  const topAssets = data.topAssets
  const resolved = resolveTag(data)
  const ident = data.identity
  const profile = data.profile
  const usingProfileName = !resolved && !mod && !!profile?.name
  const title = resolved?.name ?? mod ?? profile?.name ?? ident?.display ?? data.emojiName ?? emojiName(data.emoji) ?? 'Account'
  // The ✓ mark stays exclusive to a genuinely displayed, verified on-chain
  // identity — never the self-set profile name or a tag/module label.
  const showIdentityCheck = !resolved && !mod && !profile?.name && !!ident?.display && ident.verified
  const associations = allAssociations(data)
  return (
    <>
      <div className="hc-head">
        {resolved
          ? <TagIcon icon={resolved.icon} title={resolved.name} className="hc-emoji" />
          : mod ? <span className="hc-emoji">⚙️</span>
            : <AccountEmoji account={data} className="hc-emoji" />}
        <div style={{ minWidth: 0 }}>
          <div className="hc-title">{usingProfileName ? <span className="profile-name">{title}</span> : title}
            {resolved ? <span className="em" style={resolved.color ? { color: resolved.color } : undefined}> · tag</span>
              : showIdentityCheck && <span className="id-verified" title="Verified identity" style={{ marginLeft: 5 }}>✓</span>}</div>
        </div>
      </div>
      {associations.length > 0 && (
        <div className="hc-tags">
          {associations.slice(0, MAX_HOVER_TAGS).map(a => (
            <UserTagPill key={a.listId ?? `system-${a.id}`} tag={a} address={data.evmAddress ?? data.ss58Polkadot} noCopy />
          ))}
          {associations.length > MAX_HOVER_TAGS && <span className="hc-tags-more">+{associations.length - MAX_HOVER_TAGS}</span>}
        </div>
      )}
      {/* Same two facts the referendum's votes table keeps: the vote itself and the
          conviction-weighted votes it carries. */}
      {vote && <>
        <div className="hc-row"><span>Vote</span><span className="mono">{vote.side}{vote.conviction ? ` · ${vote.conviction}` : ''}</span></div>
        <div className="hc-row"><span>Votes</span><span className="mono">{vote.weighted}</span></div>
      </>}
      <ProfileMetrics {...data} debtUsd={debtUsd} topAssets={topAssets} />
    </>
  )
}

// Tag chips (grouped accounts): the tag identity plus the combined metrics of
// all member accounts — the same figures the tag detail header shows.
function TagHover({ id }: { id: string }) {
  const { data } = useTagSummary(id)
  if (!data) return <div className="hc-sub mono">Loading…</div>
  const debtUsd = data.moneyMarket.reduce((s, p) => s + Number(p.totalDebtBase) / 1e8, 0)
  const topAssets = data.topAssets
  return (
    <>
      <div className="hc-head">
        <TagIcon icon={data.icon} title={data.name} className="hc-emoji" />
        <div>
          <div className="hc-title">{data.name}<span className="em" style={{ color: data.color }}> · tag</span></div>
          <div className="hc-sub mono">{data.members.length} account{data.members.length === 1 ? '' : 's'}</div>
        </div>
      </div>
      <ProfileMetrics {...data} debtUsd={debtUsd} topAssets={topAssets} />
    </>
  )
}

// A list tag's own hover card — same shape as TagHover, over the aggregate
// view's authed summary. Logged out (or lacking permission) the query simply
// never resolves data, and the card reads as "Loading…" rather than crashing —
// this hovers a pill the viewer's own tag map already resolved for them, so in
// practice they always have access to what they're hovering.
function ListTagHover({ listId, tagId }: { listId: string; tagId: string }) {
  const { data } = useListTagSummary(listId, tagId)
  if (!data) return <div className="hc-sub mono">Loading…</div>
  const debtUsd = data.moneyMarket.reduce((s, p) => s + Number(p.totalDebtBase) / 1e8, 0)
  const topAssets = data.topAssets
  return (
    <>
      <div className="hc-head">
        <TagIcon icon={data.icon} title={data.name} className="hc-emoji" />
        <div>
          <div className="hc-title">{data.name}<span className="em" style={{ color: data.color }}> · tag</span></div>
          <div className="hc-sub mono">{data.members.length} account{data.members.length === 1 ? '' : 's'}</div>
        </div>
      </div>
      <ProfileMetrics {...data} debtUsd={debtUsd} topAssets={topAssets} />
    </>
  )
}

function AssetHover({ id }: { id: number }) {
  const { data } = useAsset(id)
  if (!data) return <div className="hc-sub mono">Loading…</div>
  const a = data.asset
  const ch = a.change24h
  return (
    <>
      <div className="hc-head">
        <AssetIcon assetId={a.assetId} iconAssetId={a.iconAssetId} symbol={a.symbol} size={28} parachainId={a.parachainId} origin={a.origin} />
        <div>
          <div className="hc-title">{a.symbol}</div>
          <div className="hc-sub">{a.name ?? `#${a.assetId}`}</div>
        </div>
      </div>
      <div className="hc-row"><span>Price</span><span className="mono">{F.priceUsd(a.price)}</span></div>
      <div className="hc-row"><span>24h</span><span className="mono" style={{ color: ch == null ? 'var(--text-low)' : ch >= 0 ? 'var(--green)' : 'var(--red)' }}>{F.pct(ch)}</span></div>
      <div className="hc-row"><span>Holders</span><span className="mono">{F.int(data.holderCount)}</span></div>
      <div className="hc-row"><span>Asset ID</span><span className="mono muted">#{a.assetId}</span></div>
    </>
  )
}

function TradeHover({ id }: { id: string }) {
  const { data } = useTrade(id)
  if (!data) return <div className="hc-sub mono">Loading…</div>
  const detailId = data.extrinsicIndex != null ? `${data.blockHeight}-${data.extrinsicIndex}` : data.eventIndex != null ? `${data.blockHeight}-e${data.eventIndex}` : id
  const hops = data.route.length ? data.route : [{ pool: data.venue, poolId: null, assetIn: data.assetIn, assetOut: data.assetOut }]
  return (
    <>
      <div className="hc-head">
        <span className="hc-emoji">T</span>
        <div>
          <div className="hc-title">Trade</div>
          <div className="hc-sub mono">{detailId} · {data.direction} via {data.venue}</div>
        </div>
      </div>
      <div className="hc-row"><span>Result</span><StatusBadge ok={data.success} /></div>
      {data.valueUsd != null && <div className="hc-row"><span>Value</span><span className="mono">{F.usd(data.valueUsd)}</span></div>}
      <div className="hc-route">
        <div className="hc-route-title"><span>Route</span><span className="mono">{hops.length} hop{hops.length === 1 ? '' : 's'}</span></div>
        {hops.map((h, i) => (
          <div className="hc-hop" key={`${h.pool}-${h.assetIn.assetId}-${h.assetOut.assetId}-${i}`}>
            <span className="badge" style={{ background: 'color-mix(in srgb, var(--cat-liquidity) 15%, transparent)', color: 'var(--cat-liquidity)' }}>{h.pool}{h.poolId != null ? ` #${h.poolId}` : ''}</span>
            <span className="hc-hop-assets">
              <span className="trade-leg"><AssetIcon assetId={h.assetIn.assetId} iconAssetId={h.assetIn.iconAssetId} symbol={h.assetIn.symbol} size={16} parachainId={h.assetIn.parachainId} origin={h.assetIn.origin} /><span className="mono">{h.assetIn.symbol}</span></span>
              <span className="muted">→</span>
              <span className="trade-leg"><AssetIcon assetId={h.assetOut.assetId} iconAssetId={h.assetOut.iconAssetId} symbol={h.assetOut.symbol} size={16} parachainId={h.assetOut.parachainId} origin={h.assetOut.origin} /><span className="mono">{h.assetOut.symbol}</span></span>
            </span>
          </div>
        ))}
      </div>
    </>
  )
}

// DCA feed rows link to their schedule: show the order (amount-per sits on the
// sold leg for Sell orders, the bought leg for Buy orders), cadence and totals —
// the schedule page's basic-info block in miniature.
function DcaScheduleHover({ id }: { id: string }) {
  const { data, isError } = useDcaSchedule(Number(id))
  if (isError) return <div className="hc-sub mono">DCA schedule not found</div>
  if (!data) return <div className="hc-sub mono">Loading…</div>
  return (
    <>
      <div className="hc-head">
        <span className="hc-emoji">⏱</span>
        <div>
          <div className="hc-title">DCA <span className="num">#{data.scheduleId}</span></div>
          <div className="hc-sub mono">{data.status}{data.statusReason ? ` · ${data.statusReason}` : ''}</div>
        </div>
      </div>
      <div className="hc-row"><span>Order</span><span className="asset-flow">
        {data.direction === 'Buy'
          ? <>buys <AssetAmount asset={data.assetOut} raw={data.amountPer} /> with <AssetChip asset={data.assetIn} /></>
          : <>sells <AssetAmount asset={data.assetIn} raw={data.amountPer} /> → <AssetChip asset={data.assetOut} /></>}
      </span></div>
      <div className="hc-row"><span>Every</span><span className="mono" title={`${F.int(data.period)} blocks`}>{fmtDuration(dcaCadence(data.periodSeconds, data.period).seconds)}</span></div>
      <div className="hc-row"><span>Budget</span>{data.totalAmount === '0'
        ? <span className="mono">open-ended</span>
        : <span>
          <AssetAmount asset={data.assetIn} raw={data.totalAmount} />
          {data.budgetUsd != null && <span className="mono muted"> · {F.usd(data.budgetUsd)}</span>}
        </span>}</div>
      {(() => {
        const { pct, projected } = dcaProgress(data.totalAmount, data.executions.totalIn, data.fundingBalance)
        return pct != null ? <div className="hc-row"><span>Filled</span><span className="mono">{projected ? '~' : ''}{Math.round(pct)}%</span></div> : null
      })()}
      <div className="hc-row"><span>Executed</span><span className="mono">{F.int(data.executions.count)} trade{data.executions.count === 1 ? '' : 's'}{data.executions.failed > 0 ? ` · ${F.int(data.executions.failed)} failed` : ''}</span></div>
      {data.who && <div className="hc-row"><span>Owner</span><AddrPill account={data.who} noCopy /></div>}
    </>
  )
}

// Schedule-page execution rows link to one attempt (/dca/<block>-e<index>):
// result, the traded (or intended) legs, value and the failure reason.
function DcaExecutionHover({ id }: { id: string }) {
  const m = /^(\d+)-e(\d+)$/.exec(id)
  const { data, isError } = useDcaExecution(Number(m?.[1] ?? 0), Number(m?.[2] ?? 0))
  if (isError) return <div className="hc-sub mono">No DCA execution at this event</div>
  if (!data) return <div className="hc-sub mono">Loading…</div>
  return (
    <>
      <div className="hc-head">
        <span className="hc-emoji">⏱</span>
        <div>
          <div className="hc-title">DCA execution</div>
          <div className="hc-sub mono">{id} · DCA #{data.scheduleId}</div>
        </div>
      </div>
      <div className="hc-row"><span>Result</span><StatusBadge ok={data.status === 'executed'} /></div>
      {data.failureReason && <div className="hc-row"><span>Reason</span><span className="mono">{data.failureReason.label}</span></div>}
      <div className="hc-row"><span>{data.status === 'failed' ? 'Attempted' : 'Swap'}</span><span className="asset-flow">
        <AssetAmount asset={data.assetIn} raw={data.amountIn} />
        {data.amountOut != null && <> → <AssetAmount asset={data.assetOut} raw={data.amountOut} /></>}
      </span></div>
      {data.valueUsd != null && <div className="hc-row"><span>Value</span><span className="mono">{F.usd(data.valueUsd)}</span></div>}
      <div className="hc-row"><span>Time</span><span className="mono">{F.datetime(data.timestamp)}</span></div>
    </>
  )
}

// Mirrors the extrinsic detail's basic-info block. The call name sits on its own
// full-width line (never wraps); the hash is shortened.
function ExtrinsicHover({ id }: { id: string }) {
  const { data } = useExtrinsic(id)
  if (!data) return <div className="hc-sub mono">Loading…</div>
  return (
    <>
      <div className="hc-head">
        <span className="hc-emoji">📄</span>
        <div>
          <div className="hc-title">Extrinsic</div>
          <div className="hc-sub mono">{data.blockHeight}-{data.index}</div>
        </div>
      </div>
      <div className="hc-call" title={data.callName}><CallPill name={data.callName} /></div>
      <div className="hc-row"><span>Time</span><span className="mono">{F.datetime(data.timestamp)}</span></div>
      <div className="hc-row"><span>Result</span><StatusBadge ok={data.success} /></div>
      <div className="hc-row"><span>Hash</span><span className="mono">{F.shortHash(data.hash)}</span></div>
      {data.signer && <div className="hc-row"><span>Signer</span><AddrPill account={data.signer} noCopy /></div>}
      <div className="hc-row"><span>Fee</span><span className="mono">{F.hdxFee(data.fee)}</span></div>
    </>
  )
}

// Mirrors the block detail's basic-info block; hash shortened.
function BlockHover({ id }: { id: number }) {
  const { data } = useBlock(id)
  const { data: stats } = useStats(!!data)
  if (!data) return <div className="hc-sub mono">Loading…</div>
  return (
    <>
      <div className="hc-head">
        <span className="hc-emoji">🧊</span>
        <div>
          <div className="hc-title">Block <span className="num">{F.int(data.height)}</span></div>
          <div className="hc-sub mono">{F.shortHash(data.hash)}</div>
        </div>
      </div>
      <div className="hc-row"><span>Status</span><FinalizedBadge finalized={data.height <= (stats?.finalizedBlock ?? -1)} /></div>
      <div className="hc-row"><span>Time</span><span className="mono">{F.datetime(data.timestamp)}</span></div>
      {data.author && <div className="hc-row"><span>Author</span><AddrPill account={data.author} noCopy /></div>}
      <div className="hc-row"><span>Spec</span><span className="mono">hydration/{data.specVersion}</span></div>
      <div className="hc-row"><span>Extrinsics</span><span className="mono">{F.int(data.extrinsicCount)}</span></div>
      <div className="hc-row"><span>Events</span><span className="mono">{F.int(data.eventCount)}</span></div>
    </>
  )
}
