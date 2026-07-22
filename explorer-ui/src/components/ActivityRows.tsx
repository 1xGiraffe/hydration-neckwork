/* eslint-disable react-refresh/only-export-components -- exports the pure originTitle helper alongside its row components */
import { useState, Fragment, type KeyboardEvent } from 'react'
import { useExtrinsic } from '../hooks/useExplorerData'
import { Link, paths } from '../router'
import { F, AddrPill, CallPill, StatusBadge, JsonView, Ago, ExpandedRowSkeleton, Dash } from './ui'
import type { ExtrinsicSummary, ExtrinsicOrigin, EventRow } from '../types'

// Expandable extrinsic / event rows shared by the list pages (Extrinsics, Events)
// and the account detail tabs. Kept here so the markup stays identical everywhere.

// Multi-line hover summary for the origin badge. Proxy explains itself in one
// line; multisig lists the operation state then every timeline entry in order
// (initiated/approved/executed/cancelled) so approvers and the executor are
// visible without opening the row. '\n'-joined lines render as a multi-line
// native tooltip.
export function originTitle(origin: ExtrinsicOrigin): string {
  if (origin.kind === 'proxy') return 'Executed on behalf of this account by a proxy'
  const lines = [`Multisig operation · ${origin.state ?? 'executed'}`]
  for (const entry of origin.timeline ?? []) {
    const who = entry.account.identity?.display || `${entry.account.address.slice(0, 6)}…${entry.account.address.slice(-4)}`
    lines.push(`${entry.action} by ${who} · ${entry.timestamp}`)
  }
  return lines.join('\n')
}

// Origin marker for extrinsics executed on behalf of the viewed account.
// Executed multisigs show threshold/members ("2/3"); pending ones show
// progress ("1/3"). Colors follow ProxyTypeBadge's pill-badge pattern.
function OriginBadge({ origin }: { origin: ExtrinsicOrigin }) {
  const title = originTitle(origin)
  if (origin.kind === 'proxy') {
    return <span className="pill-badge" title={title} style={{ color: 'var(--sky)', background: 'color-mix(in srgb, var(--sky) 15%, transparent)' }}>proxy</span>
  }
  const state = origin.state ?? 'executed'
  const col = state === 'cancelled' ? 'var(--red)' : state === 'pending' ? 'var(--amber)' : 'var(--sky)'
  const mark = state === 'cancelled' ? '✕' : state === 'pending' ? '⏳' : '✓'
  const k = state === 'pending' ? origin.approvals : origin.threshold
  const kn = k && origin.signatories ? ` ${k}/${origin.signatories}` : ''
  return (
    <span className="pill-badge" title={title} style={{ color: col, background: `color-mix(in srgb, ${col} 15%, transparent)` }}>
      multisig{kn} {mark}
    </span>
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
          <div>
            <div className="exp-h">Multisig operation · {origin.state ?? 'executed'}{origin.threshold ? ` · ${origin.threshold}/${origin.signatories}` : ''}</div>
            {origin.timeline?.map((entry, i) => (
              <div key={`${entry.action}-${entry.timestamp}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <AddrPill account={entry.account} noCopy />
                <span className="muted" style={{ fontFamily: 'GeistMono', fontSize: 11 }}>{entry.action} · {entry.timestamp}</span>
              </div>
            ))}
          </div>
        )}
        {origin?.kind === 'proxy' && (
          <div>
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

export function ExtRow({ x, now, isNew, noSigner, showOrigin }: { x: ExtrinsicSummary; now: number; isNew?: boolean; noSigner?: boolean; showOrigin?: boolean }) {
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
        {!noSigner && <td data-label="Sender">{sender ? <AddrPill account={sender} noCopy /> : <span className="muted mono">— inherent</span>}</td>}
        {showOrigin && <td data-label="Origin">{x.origin ? <OriginBadge origin={x.origin} /> : <Dash />}</td>}
        <td data-label="Fee" className="r mono muted">{F.hdxFee(x.fee)}</td>
        <td data-label="Result" className="r">{showOrigin && x.origin?.state === 'pending'
          ? <span className="badge pending"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>Pending</span>
          : <StatusBadge ok={x.success} />}</td>
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
