import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AssetIcon } from '../ui'
import type { AssetRef } from '../../types'
import { aprText, type YieldRow } from './yieldFormat'

// A rate with its composition on hover, focus or tap — the explorer's reading
// of the Hydration UI's APR tooltip. The trigger shows the total (and the
// reward assets' icons); the card lists every component, grouped, and a
// one-line note on what the figure is and is not.
//
// The card is `position: fixed`, placed from the trigger's rect, so a table's
// scroll container never clips it. It stays keyboard reachable (the trigger is
// a button), closes on Escape, blur and pointer-leave, and a click (a tap on a
// phone, which also focuses and hovers) opens it rather than toggling it shut;
// a click inside a clickable row does not navigate the row.
export function YieldHover({ total, rows, icons, note, title, emptyText = '—' }: {
  total: number | null
  rows: YieldRow[]
  /** Reward assets shown beside the total, like the Hydration UI's incentive icons. */
  icons?: AssetRef[]
  note?: ReactNode
  title?: string
  emptyText?: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const id = useId()
  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect()
    if (!r) return
    const width = Math.min(300, window.innerWidth - 24)
    const left = Math.max(12, Math.min(r.right - width, window.innerWidth - width - 12))
    const above = r.bottom + 260 > window.innerHeight && r.top > 260
    setPos({ left, top: above ? r.top - 6 : r.bottom + 6, above })
  }, [])
  useEffect(() => {
    if (!open) return
    place()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    // A scroll moves the card with its trigger: focusing an off-screen trigger
    // (smooth-)scrolls it into view, which must not close what the focus just
    // opened — a focused trigger closes on blur. Otherwise it closes once the
    // trigger leaves the viewport.
    const onScroll = () => {
      const r = btn.current?.getBoundingClientRect()
      const focused = !!btn.current && document.activeElement === btn.current
      if (!r || (!focused && (r.bottom < 0 || r.top > window.innerHeight))) setOpen(false)
      else place()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onScroll, true) }
  }, [open, place])
  if (!rows.length) return <span className="mono muted">{total == null ? emptyText : aprText(total)}</span>
  return (
    <span className="yh" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button ref={btn} type="button" className="yh-trigger" aria-describedby={open ? id : undefined} aria-expanded={open}
        onClick={e => { e.stopPropagation(); setOpen(true) }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        {icons && icons.length > 0 && <span className="yh-icons">{icons.slice(0, 4).map(a => <AssetIcon key={a.assetId} assetId={a.assetId} iconAssetId={a.iconAssetId} iconAssetIds={a.iconAssetIds} symbol={a.symbol} size={14} parachainId={a.parachainId} origin={a.origin} />)}</span>}
        <span className="mono">{aprText(total)}</span>
      </button>
      {/* Portalled to <body>: an animated ancestor keeps a transform (the page's
          fade-in fill), which would make `position: fixed` relative to it and
          let a phone table's clipped cells hide the card. React still treats it
          as the trigger's child, so hover and clicks stay inside the widget. */}
      {open && pos && createPortal(
        <span role="tooltip" id={id} className={`yh-card${pos.above ? ' above' : ''}`} style={{ left: pos.left, top: pos.top }} onClick={e => e.stopPropagation()}>
          {title && <span className="yh-title">{title}</span>}
          {rows.map((r, i) => {
            const head = r.group && r.group !== rows[i - 1]?.group ? <span className="yh-group">{r.group}</span> : null
            return (
              <span key={r.key} style={{ display: 'contents' }}>
                {head}
                <span className="yh-row">
                  <span className="yh-lab">
                    {r.asset && <AssetIcon assetId={r.asset.assetId} iconAssetId={r.asset.iconAssetId} iconAssetIds={r.asset.iconAssetIds} symbol={r.asset.symbol} size={14} parachainId={r.asset.parachainId} origin={r.asset.origin} />}
                    <span>{r.label}</span>
                    {r.note && <span className="yh-note">{r.note}</span>}
                  </span>
                  <span className="mono">{aprText(r.pct)}</span>
                </span>
              </span>
            )
          })}
          <span className="yh-row yh-total"><span>Total</span><span className="mono">{aprText(total)}</span></span>
          {note && <span className="yh-foot">{note}</span>}
        </span>,
        document.body,
      )}
    </span>
  )
}
