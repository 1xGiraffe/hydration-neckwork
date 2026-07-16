import { useState, Fragment, type KeyboardEvent } from 'react'
import { useExtrinsic } from '../hooks/useExplorerData'
import { Link, paths } from '../router'
import { F, AddrPill, CallPill, StatusBadge, JsonView, Ago, ExpandedRowSkeleton, Dash } from './ui'
import type { ExtrinsicSummary, EventRow } from '../types'

// Expandable extrinsic / event rows shared by the list pages (Extrinsics, Events)
// and the account detail tabs. Kept here so the markup stays identical everywhere.

function ExpandPanel({ id }: { id: string }) {
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

export function ExtRow({ x, now, isNew, noSigner }: { x: ExtrinsicSummary; now: number; isNew?: boolean; noSigner?: boolean }) {
  const { open, toggle, onKeyDown } = useExpandableRow()
  const id = `${x.blockHeight}-${x.index}`
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
        <td data-label="Call"><CallPill name={x.callName} /></td>
        {!noSigner && <td data-label="Signer">{x.signer ? <AddrPill account={x.signer} noCopy /> : <span className="muted mono">— inherent</span>}</td>}
        <td data-label="Fee" className="r mono muted">{F.hdxFee(x.fee)}</td>
        <td data-label="Result" className="r"><StatusBadge ok={x.success} /></td>
        <td data-label="Time" className="r mono muted"><Ago ts={x.timestamp} now={now} /></td>
        <td className="r exp-toggle col-hide-mobile"><button className={`exp-btn${open ? ' open' : ''}`} onClick={event => { event.stopPropagation(); toggle() }} aria-label={`${open ? 'Collapse' : 'Expand'} extrinsic ${id}`} aria-expanded={open}>▸</button></td>
      </tr>
      {open && <tr className="exp-row"><td colSpan={noSigner ? 7 : 8}><ExpandPanel id={id} /></td></tr>}
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
