import { useEffect, useRef, useState, Fragment, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useExtrinsic } from '../hooks/useExplorerData'
import { Link, paths } from '../router'
import { F, AddrPill, CallPill, StatusBadge, JsonView, Ago, ExpandedRowSkeleton, Dash } from './ui'
import { failureReasonText, type ExtrinsicSummary, type ExtrinsicOrigin, type EventRow } from '../types'

// Expandable extrinsic / event rows shared by the list pages (Extrinsics, Events)
// and the account detail tabs. Kept here so the markup stays identical everywhere.

const HOVER_DWELL_MS = 180
const HOVER_HIDE_MS = 160
const HOVER_FLIP_THRESHOLD = 240

// Origin marker for extrinsics executed on behalf of the viewed account.
// Proxy explains itself in a plain one-line tooltip; multisig gets a rich
// hover card (see MultisigBadge) listing the operation state and the full
// approval timeline, since approvers and the executor aren't otherwise
// visible without opening the row.
function OriginBadge({ origin }: { origin: ExtrinsicOrigin }) {
  if (origin.kind === 'proxy') {
    return <span className="pill-badge" title="Executed on behalf of this account by a proxy" style={{ color: 'var(--sky)', background: 'color-mix(in srgb, var(--sky) 15%, transparent)' }}>proxy</span>
  }
  return <MultisigBadge origin={origin} />
}

// Executed multisigs show threshold/members ("2/3"); pending ones show
// progress ("1/3"). Colors follow ProxyTypeBadge's pill-badge pattern. The
// hover card mirrors HoverCard.tsx's dwell/hide timers and bottom-flip, but
// anchors to this badge's own rect instead of the globally tracked pointer
// target. It renders the shared `.hovercard` class, so it inherits that
// component's styling and the global listener's nested-card suppression —
// hovering an AddrPill inside this card never also pops the account card.
function MultisigBadge({ origin }: { origin: ExtrinsicOrigin }) {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const badgeRef = useRef<HTMLSpanElement>(null)
  const showTimer = useRef<number | undefined>(undefined)
  const hideTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => {
    window.clearTimeout(showTimer.current)
    window.clearTimeout(hideTimer.current)
  }, [])
  const show = () => {
    window.clearTimeout(hideTimer.current)
    showTimer.current = window.setTimeout(() => {
      if (badgeRef.current) setRect(badgeRef.current.getBoundingClientRect())
    }, HOVER_DWELL_MS)
  }
  const hide = () => {
    window.clearTimeout(showTimer.current)
    hideTimer.current = window.setTimeout(() => setRect(null), HOVER_HIDE_MS)
  }
  const state = origin.state ?? 'executed'
  const col = state === 'cancelled' ? 'var(--red)' : state === 'pending' ? 'var(--amber)' : 'var(--sky)'
  const mark = state === 'cancelled' ? '✕' : state === 'pending' ? '⏳' : '✓'
  const k = state === 'pending' ? origin.approvals : origin.threshold
  const kn = k && origin.signatories ? ` ${k}/${origin.signatories}` : ''
  return (
    <span ref={badgeRef} className="pill-badge" onMouseEnter={show} onMouseLeave={hide}
      style={{ color: col, background: `color-mix(in srgb, ${col} 15%, transparent)` }}>
      multisig{kn} {mark}
      {rect && (
        <MultisigHoverCard
          origin={origin}
          rect={rect}
          onMouseEnter={() => window.clearTimeout(hideTimer.current)}
          onMouseLeave={hide}
          onClose={() => setRect(null)}
        />
      )}
    </span>
  )
}

// Positioned exactly like HoverCard.tsx's global card (fixed, flipped above
// the anchor when there's no room below, height-capped to the viewport) but
// anchored to the badge's own rect rather than a pointer-tracked target.
// Portalled to document.body: unlike HoverCard.tsx (which mounts at the App
// root, outside any wrapper), this card is authored inside row/panel
// ancestors, and a `.panel`/`.wrap` transform (even the identity matrix a
// reveal animation leaves behind) turns that ancestor into the containing
// block for `position: fixed`, resolving our viewport coordinates against it
// instead of the viewport. The portal escapes that regardless of ancestor
// styling; React still delivers events through the component tree, so the
// row's onClick toggle would otherwise still fire on a card click without
// the stopPropagation below.
function MultisigHoverCard({ origin, rect, onMouseEnter, onMouseLeave, onClose }: {
  origin: ExtrinsicOrigin
  rect: DOMRect
  onMouseEnter: () => void
  onMouseLeave: () => void
  onClose: () => void
}) {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  // Wider than the global HoverCards card (360): a timeline row packs an
  // AddrPill, an action link, and a timestamp on one line, which needs more
  // room than an account/asset summary before it wraps awkwardly.
  const cardWidth = Math.min(460, Math.max(0, viewportWidth - 24))
  const left = Math.max(12, Math.min(rect.left, viewportWidth - cardWidth - 12))
  const spaceBelow = viewportHeight - rect.bottom
  const placeAbove = spaceBelow < HOVER_FLIP_THRESHOLD && rect.top > spaceBelow
  const vStyle = placeAbove
    ? { bottom: Math.round(viewportHeight - rect.top + 8), maxHeight: Math.max(96, Math.round(rect.top - 16)) }
    : { top: Math.round(rect.bottom + 8), maxHeight: Math.max(96, Math.round(spaceBelow - 16)) }
  const state = origin.state ?? 'executed'
  return createPortal(
    <div className="hovercard" style={{ left, width: cardWidth, overflowY: 'auto', ...vStyle }}
      onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onClick={e => { e.stopPropagation(); onClose() }}>
      <div className="hc-title" style={{ marginBottom: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        Multisig operation · {state}{origin.threshold ? ` · ${origin.threshold}/${origin.signatories}` : ''}
      </div>
      {origin.timeline?.map((entry, i) => (
        <div key={`${entry.extrinsicId}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, whiteSpace: 'nowrap' }}>
          <AddrPill account={entry.account} noCopy />
          <Link to={paths.extrinsic(entry.extrinsicId)} className="hash" style={{ fontFamily: 'GeistMono', fontSize: 11 }}>{entry.action}</Link>
          <span className="muted" style={{ fontFamily: 'GeistMono', fontSize: 11 }}>· {entry.timestamp}</span>
        </div>
      ))}
    </div>,
    document.body,
  )
}

function ExpandPanel({ id, origin }: { id: string; origin?: ExtrinsicOrigin }) {
  const { data, isLoading } = useExtrinsic(id)
  if (isLoading || !data) return <ExpandedRowSkeleton />
  const args = (data.callArgs && typeof data.callArgs === 'object') ? data.callArgs as Record<string, unknown> : {}
  const entries = Object.entries(args).filter(([k]) => !k.startsWith('_'))
  return (
    <div className="exp">
      <div className="exp-cols">
        <div>
          <div className="exp-h">Parameters</div>
          {entries.length ? <div className="exp-kv">{entries.map(([k, v]) => <Fragment key={k}><div className="kk">{k}</div><div className="vv">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</div></Fragment>)}</div>
            : <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12 }}>no parameters</div>}
        </div>
        <div>
          <div className="exp-h">Events · {data.events.length}</div>
          <div className="exp-evs">{data.events.map(ev => <CallPill key={ev.eventIndex} name={ev.name} />)}</div>
        </div>
        {origin?.kind === 'multisig' && (
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="exp-h">Multisig operation · {origin.state ?? 'executed'}{origin.threshold ? ` · ${origin.threshold}/${origin.signatories}` : ''}</div>
            {origin.timeline?.map((entry, i) => (
              <div key={`${entry.action}-${entry.timestamp}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <AddrPill account={entry.account} noCopy />
                <Link to={paths.extrinsic(entry.extrinsicId)} className="hash" style={{ fontFamily: 'GeistMono', fontSize: 11 }}>{entry.action}</Link>
                <span className="muted" style={{ fontFamily: 'GeistMono', fontSize: 11 }}>· {entry.timestamp}</span>
              </div>
            ))}
          </div>
        )}
        {origin?.kind === 'proxy' && (
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="exp-h">Proxy</div>
            <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 11 }}>Executed via proxy — the signer is the delegate acting for this account</div>
          </div>
        )}
      </div>
      <Link to={paths.extrinsic(id)} className="hash">Open full detail →</Link>
    </div>
  )
}

function useExpandableRow() {
  const [open, setOpen] = useState(false)
  const toggle = () => setOpen(value => !value)
  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggle()
  }
  return { open, toggle, onKeyDown }
}

export function ExtRow({ x, now, isNew, noSigner, showOrigin, senderLabel }: { x: ExtrinsicSummary; now: number; isNew?: boolean; noSigner?: boolean; showOrigin?: boolean; senderLabel?: boolean }) {
  const { open, toggle, onKeyDown } = useExpandableRow()
  const id = `${x.blockHeight}-${x.index}`
  const cols = 7 + (noSigner ? 0 : 1) + (showOrigin ? 1 : 0)
  // The action's sender: a multisig operation's initiator (the person who
  // proposed it) rather than the anchor/executing signer, when known.
  const sender = showOrigin && x.origin?.kind === 'multisig' && x.origin.initiator ? x.origin.initiator : x.signer
  return (
    <>
      <tr
        className={`exp-host${open ? ' open' : ''}${isNew ? ' row-new' : ''}`}
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onKeyDown}
        style={{ cursor: 'pointer' }}
      >
        <td data-label="Extrinsic" className="mono"><Link to={paths.extrinsic(id)} className="hash" onClick={e => e.stopPropagation()}>{id}</Link></td>
        <td data-label="Block" className="mono"><Link to={paths.block(x.blockHeight)} className="hash" onClick={e => e.stopPropagation()}>{F.int(x.blockHeight)}</Link></td>
        <td data-label="Call">{showOrigin && x.origin?.callHash
          ? <span className="mono muted" title={`Call hash ${x.origin.callHash} — call body not published on-chain`}>{F.shortHash(x.origin.callHash)}</span>
          : <CallPill name={x.callName} />}</td>
        {!noSigner && <td data-label={senderLabel ? 'Sender' : 'Signer'}>{sender ? <AddrPill account={sender} noCopy /> : <span className="muted mono">— inherent</span>}</td>}
        {showOrigin && <td data-label="Origin">{x.origin ? <OriginBadge origin={x.origin} /> : <Dash />}</td>}
        <td data-label="Fee" className="r mono muted">{F.hdxFee(x.fee)}</td>
        <td data-label="Result" className="r">{showOrigin && x.origin?.state === 'pending'
          ? <span className="badge pending"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>Pending</span>
          : <StatusBadge ok={x.success} reason={failureReasonText(x.errorReason)} />}</td>
        <td data-label="Time" className="r mono muted"><Ago ts={x.timestamp} now={now} /></td>
        <td className="r exp-toggle col-hide-mobile"><button className={`exp-btn${open ? ' open' : ''}`} onClick={event => { event.stopPropagation(); toggle() }} aria-label={`${open ? 'Collapse' : 'Expand'} extrinsic ${id}`} aria-expanded={open}>▸</button></td>
      </tr>
      {open && <tr className="exp-row"><td colSpan={cols}><ExpandPanel id={id} origin={showOrigin ? x.origin : undefined} /></td></tr>}
    </>
  )
}

export function EvRow({ e, now, isNew }: { e: EventRow; now: number; isNew?: boolean }) {
  const { open, toggle, onKeyDown } = useExpandableRow()
  const id = `${e.blockHeight}-${e.eventIndex}`
  const extId = e.extrinsicIndex != null ? `${e.blockHeight}-${e.extrinsicIndex}` : null
  const args = e.args && typeof e.args === 'object' ? e.args as Record<string, unknown> : {}
  const hasArgs = Object.keys(args).length > 0
  return (
    <>
      <tr
        className={`exp-host${open ? ' open' : ''}${isNew ? ' row-new' : ''}`}
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onKeyDown}
        style={{ cursor: 'pointer' }}
      >
        <td data-label="ID" className="mono"><Link to={paths.eventAt(e.blockHeight, e.eventIndex)} className="hash" onClick={ev => ev.stopPropagation()}>{id}</Link></td>
        <td data-label="Block" className="mono"><Link to={paths.block(e.blockHeight)} className="hash" onClick={ev => ev.stopPropagation()}>{F.int(e.blockHeight)}</Link></td>
        <td data-label="Extrinsic" className="mono">{extId ? <Link to={paths.extrinsic(extId)} className="hash" onClick={ev => ev.stopPropagation()}>{extId}</Link> : <Dash />}</td>
        <td data-label="Event"><CallPill name={e.name} />{e.decoded && <span className="badge" style={{ background: 'var(--lavender-soft)', color: 'var(--lavender)', marginLeft: 6 }}>decoded</span>}</td>
        <td data-label="Time" className="r mono muted"><Ago ts={e.timestamp} now={now} /></td>
        <td className="r exp-toggle col-hide-mobile"><button className={`exp-btn${open ? ' open' : ''}`} onClick={event => { event.stopPropagation(); toggle() }} aria-label={`${open ? 'Collapse' : 'Expand'} event ${id}`} aria-expanded={open}>▸</button></td>
      </tr>
      {open && (
        <tr className="exp-row"><td colSpan={6}>
          <div className="exp">
            <div className="exp-h">{e.name}</div>
            {hasArgs ? <JsonView value={args} /> : <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12 }}>no parameters</div>}
            {extId ? <Link to={paths.extrinsic(extId)} className="hash">Open extrinsic →</Link> : <span className="muted" style={{ fontFamily: 'GeistMono', fontSize: 11 }}>System event · no extrinsic</span>}
          </div>
        </td></tr>
      )}
    </>
  )
}
