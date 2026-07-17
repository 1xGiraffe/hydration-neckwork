import { useEffect, useRef, useState } from 'react'
import { useAddressSummary, useAsset, useExtrinsic, useBlock, useTagSummary, useTrade, useStats } from '../hooks/useExplorerData'
import { F, AssetIcon, AddrPill, CallPill, StatusBadge, FinalizedBadge, AccountEmoji, emojiName, moduleName, TagIcon, TokenIconRow } from './ui'
import type { AssetRef } from '../types'

// Global hover preview cards for account (.addr-pill), tag (/tag/… links),
// asset (.asset-chip), trade ([data-activity] with slug swap|dca / /swap/…,
// /dca/…), extrinsic (a.hash / [data-ext] → /extrinsic/…) and block
// (/block/…) links. Each card mirrors the basic-info block of its detail page.
// Mounted once in App.
type Target = { kind: 'account' | 'tag' | 'asset' | 'trade' | 'extrinsic' | 'block'; id: string; left: number; top: number; bottom: number }
const SELECTOR = '.addr-pill:not([data-no-hover]), .asset-chip, a.hash, a[href*="/swap/"], a[href*="/dca/"], a[href*="/block/"], [data-activity], [data-ext]'
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

function parseTarget(el: Element): Omit<Target, 'left' | 'top' | 'bottom'> | null {
  if (el.closest('[data-no-hover]')) return null
  const act = el.getAttribute('data-activity')
  if (act) {
    const [slug, id] = act.split('/')
    if (slug === 'swap' || slug === 'dca') return { kind: 'trade', id }
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
  const am = href.match(/\/account\/([^?#]+)$/); if (am) return { kind: 'account', id: decodeURIComponent(am[1]) }
  const tm = href.match(/\/tag\/([^?#]+)$/); if (tm) return { kind: 'tag', id: decodeURIComponent(tm[1]) }
  const sm = href.match(/\/asset\/(\d+)$/); if (sm) return { kind: 'asset', id: sm[1] }
  const trm = href.match(/\/(?:trade|swap|dca)\/([^?#]+)$/); if (trm) return { kind: 'trade', id: decodeURIComponent(trm[1]) }
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
      {target.kind === 'account' ? <AccountHover id={target.id} />
        : target.kind === 'tag' ? <TagHover id={target.id} />
        : target.kind === 'asset' ? <AssetHover id={Number(target.id)} />
        : target.kind === 'trade' ? <TradeHover id={target.id} />
        : target.kind === 'block' ? <BlockHover id={Number(target.id)} />
        : <ExtrinsicHover id={target.id} />}
    </div>
  )
}

// Compact account card: display name (tag / identity / pallet / emoji name) and
// the value. No address — the pill being hovered already shows it.
function AccountHover({ id }: { id: string }) {
  const { data } = useAddressSummary(id)
  if (!data) return <div className="hc-sub mono">Loading…</div>
  const mod = moduleName(data.accountId)
  const debtUsd = data.moneyMarket.reduce((s, p) => s + Number(p.totalDebtBase) / 1e8, 0)
  const topAssets = data.topAssets
  const tag = data.tag
  const ident = data.identity
  const title = tag ? tag.name : ident?.display ? ident.display : mod ? mod : (data.emojiName ?? emojiName(data.emoji) ?? 'Account')
  return (
    <>
      <div className="hc-head">
        {tag
          ? <TagIcon icon={tag.icon} color={tag.color} size={24} title={tag.name} />
          : mod ? <span className="hc-emoji">⚙️</span>
            : <AccountEmoji account={data} className="hc-emoji" />}
        <div style={{ minWidth: 0 }}>
          <div className="hc-title">{title}
            {tag ? <span className="em" style={{ color: tag.color }}> · tag</span>
              : ident?.verified && <span className="id-verified" title="Verified identity" style={{ marginLeft: 5 }}>✓</span>}</div>
        </div>
      </div>
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
        <TagIcon icon={data.icon} color={data.color} size={24} title={data.name} />
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
      <div className="hc-route">
        <div className="hc-route-title"><span>Route</span><span className="mono">{hops.length} hop{hops.length === 1 ? '' : 's'}</span></div>
        {hops.map((h, i) => (
          <div className="hc-hop" key={`${h.pool}-${h.assetIn.assetId}-${h.assetOut.assetId}-${i}`}>
            <span className="badge" style={{ background: 'var(--sky-soft)', color: 'var(--sky)' }}>{h.pool}{h.poolId != null ? ` #${h.poolId}` : ''}</span>
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
