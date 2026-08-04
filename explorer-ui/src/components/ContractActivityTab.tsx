import { useContractTransactions, useContractEvents } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { Link, paths, setQuery, useQueryValue } from '../router'
import { F, AddrPill, Ago, Dash, EmptyRow, JsonView, Pager, ParamsTable, StatusBadge, TableSkeleton, pendingRows, rowNav } from './ui'
import { useExpandableRow } from '../hooks/useExpandableRow'
import { EvmLogView } from './EvmDecoded'
import { offeredPages } from '../utils/activityPaging'
import type { ContractEventRow, ContractTxRow } from '../types'

// The Contract tab's Transactions and Events sub-tabs (§9): the contract's own
// Ethereum transactions (evm_executed) and EVM logs (raw_evm_logs), with
// decoded method chips and named events where the verified ABI answers, and
// honest selectors/topics where it does not. Pages under their own ?cpage=
// param so they never collide with the account page's ?page.

const PAGE = 25
const chipStyle = { color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' } as const

function usePage(): number {
  const raw = useQueryValue('cpage', '0')
  const page = Number.parseInt(raw, 10)
  return Number.isSafeInteger(page) && page > 0 ? page : 0
}
const onPage = (p: number) => setQuery({ cpage: p > 0 ? String(p) : null })

function MethodChip({ method }: { method: ContractTxRow['method'] }) {
  if (!method.name && !method.selector) return <Dash />
  return (
    <span className="pill-badge mono" style={chipStyle} title={method.signature ?? (method.name ? undefined : 'Selector not in the verified ABI')}>
      {method.name ?? method.selector}
    </span>
  )
}

function TxRow({ tx, now }: { tx: ContractTxRow; now: number }) {
  const extId = tx.extrinsicIndex != null ? `${tx.blockHeight}-${tx.extrinsicIndex}` : null
  return (
    <tr {...(extId ? rowNav(paths.extrinsic(extId)) : {})} className={extId ? 'clickable' : undefined}>
      <td data-label="Extrinsic" className="mono">
        {extId
          ? <Link to={paths.extrinsic(extId)} className="hash">{extId}</Link>
          : <span title={tx.txHash}>{F.shortHash(tx.txHash)}</span>}
      </td>
      <td data-label="Method"><MethodChip method={tx.method} /></td>
      <td data-label="From">{tx.from ? <AddrPill account={tx.from} noCopy /> : <Dash />}</td>
      <td data-label="Result" className="r"><StatusBadge ok={tx.success} compact /></td>
      <td data-label="Time" className="r mono muted"><Ago ts={tx.timestamp} now={now} /></td>
    </tr>
  )
}

export function ContractTransactionsView({ address }: { address: string }) {
  const now = useNow()
  const page = usePage()
  const { data, isLoading, isPlaceholderData } = useContractTransactions(address, page * PAGE, PAGE)
  const rows = data?.transactions ?? []
  const pages = offeredPages({ page, rowsOnPage: rows.length, rowCount: data ? Math.max(data.total, 1) : undefined, pageSize: PAGE })
  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <table className="tbl">
        <thead><tr><th>Extrinsic</th><th>Method</th><th>From</th><th className="r">Result</th><th className="r">Time</th></tr></thead>
        <tbody {...pendingRows(isPlaceholderData)}>
          {isLoading && !data ? <TableSkeleton cols={5} mobileCols={4} rows={10} />
            : !rows.length ? <EmptyRow cols={5}>No transactions</EmptyRow>
              : rows.map(tx => <TxRow key={`${tx.blockHeight}-${tx.extrinsicIndex ?? tx.txHash}`} tx={tx} now={now} />)}
        </tbody>
      </table>
      <Pager page={page} totalPages={pages.totalPages} hasNext={pages.hasNext} note={pages.note} onPage={onPage} />
    </div>
  )
}

function EventChip({ e }: { e: ContractEventRow }) {
  if (e.name) {
    return (
      <span className="pill-badge" style={chipStyle} title={e.evmDecoded?.signature ?? (e.decodedBy === 'ingest' ? 'Decoded at ingest' : undefined)}>
        {e.name}
      </span>
    )
  }
  const topic0 = e.topics[0]
  return topic0 ? <span className="mono muted" title={topic0}>{F.shortHash(topic0)}</span> : <Dash />
}

function EventRowItem({ e, now }: { e: ContractEventRow; now: number }) {
  const { open, toggle, onKeyDown } = useExpandableRow()
  const id = `${e.blockHeight}-${e.eventIndex}`
  const extId = e.extrinsicIndex != null ? `${e.blockHeight}-${e.extrinsicIndex}` : null
  return (
    <>
      <tr
        className={`exp-host${open ? ' open' : ''}`}
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onKeyDown}
        style={{ cursor: 'pointer' }}
      >
        <td data-label="Event" className="mono"><Link to={paths.eventAt(e.blockHeight, e.eventIndex)} className="hash" onClick={ev => ev.stopPropagation()}>{id}</Link></td>
        <td data-label="Name"><EventChip e={e} /></td>
        <td data-label="Extrinsic" className="mono">{extId ? <Link to={paths.extrinsic(extId)} className="hash" onClick={ev => ev.stopPropagation()}>{extId}</Link> : <Dash />}</td>
        <td data-label="Time" className="r mono muted"><Ago ts={e.timestamp} now={now} /></td>
        <td className="r exp-toggle col-hide-mobile"><button className={`exp-btn${open ? ' open' : ''}`} onClick={event => { event.stopPropagation(); toggle() }} aria-label={`${open ? 'Collapse' : 'Expand'} event ${id}`} aria-expanded={open}>▸</button></td>
      </tr>
      {open && (
        <tr className="exp-row"><td colSpan={5}>
          <div className="exp">
            {e.evmDecoded
              ? <EvmLogView decoded={e.evmDecoded} />
              : e.args && Object.keys(e.args).length > 0
                ? <><div className="exp-h">{e.name}</div><ParamsTable args={e.args} /></>
                : <JsonView value={{ topics: e.topics, data: e.data }} />}
          </div>
        </td></tr>
      )}
    </>
  )
}

export function ContractEventsView({ address }: { address: string }) {
  const now = useNow()
  const page = usePage()
  const { data, isLoading, isPlaceholderData } = useContractEvents(address, page * PAGE, PAGE)
  const rows = data?.events ?? []
  const pages = offeredPages({ page, rowsOnPage: rows.length, rowCount: data ? Math.max(data.total, 1) : undefined, pageSize: PAGE })
  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <table className="tbl">
        <thead><tr><th>Event</th><th>Name</th><th>Extrinsic</th><th className="r">Time</th><th className="col-hide-mobile" /></tr></thead>
        <tbody {...pendingRows(isPlaceholderData)}>
          {isLoading && !data ? <TableSkeleton cols={5} mobileCols={4} rows={10} />
            : !rows.length ? <EmptyRow cols={5}>No events</EmptyRow>
              : rows.map(e => <EventRowItem key={`${e.blockHeight}-${e.eventIndex}`} e={e} now={now} />)}
        </tbody>
      </table>
      <Pager page={page} totalPages={pages.totalPages} hasNext={pages.hasNext} note={pages.note} onPage={onPage} />
    </div>
  )
}
