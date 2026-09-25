import type { ActiveDca, OpenLimitOrder, OrderHistoryRow, PositionScope } from '../../types'
import { ActiveDcaTable, LimitOrdersTable, dcaAggregates } from '../AccountSections'
import { AddrPill, AssetAmount, AssetIcon, Dash, EmptyRow, ErrorRow, F, MomentLink, Num, Pager, TableSkeleton, Usd, rowNav } from '../ui'
import { Link, paths, setQuery, useQuery } from '../../router'
import { useOrderHistory } from '../../hooks/usePositions'
import { ORDER_KIND_FILTERS, ORDER_KIND_LABEL, ORDER_STATUS_TONE, orderAvgPrice, orderHandle, parseOrderKind, parseOrderPage } from './ordersFormat'

const HISTORY_PAGE = 25

// Orders tab: what the holder has working now (DCA schedules and intents,
// resting limit orders), then every finished order, paged.
export function OrdersTab({ scope, activeDcas, openLimitOrders, showOwner, headBlock, headTime, now, blockSec }: {
  scope: PositionScope
  activeDcas: ActiveDca[]
  openLimitOrders: OpenLimitOrder[]
  /** Tags: name the member behind each order. */
  showOwner?: boolean
  headBlock: number
  headTime?: string
  now: number
  blockSec?: number
}) {
  const hasActive = activeDcas.length > 0 || openLimitOrders.length > 0
  return (
    <>
      {hasActive
        ? <OrdersKpis activeDcas={activeDcas} openLimitOrders={openLimitOrders} blockSec={blockSec} />
        : <p className="ord-none">No active DCA or limit orders right now.</p>}
      <ActiveDcaTable dcas={activeDcas} headBlock={headBlock} headTime={headTime} now={now} blockSec={blockSec} showOwner={showOwner} totals />
      <LimitOrdersTable orders={openLimitOrders} now={now} showOwner={showOwner} />
      <OrderHistory scope={scope} showOwner={showOwner} now={now} />
    </>
  )
}

// One line over the working orders: how many, the combined daily rate and what
// is still to spend (the same aggregate the DCA table's totals row states), and
// what the resting limit orders hold at today's prices. Orders with no price
// stay out of the dollar figures and are counted aloud instead.
function OrdersKpis({ activeDcas, openLimitOrders, blockSec }: { activeDcas: ActiveDca[]; openLimitOrders: OpenLimitOrder[]; blockSec?: number }) {
  const agg = dcaAggregates(activeDcas, blockSec)
  const dcaUnpriced = agg.orders - agg.pricedOrders
  const resting = openLimitOrders.reduce((s, o) => s + (o.valueUsd ?? 0), 0)
  const limitUnpriced = openLimitOrders.filter(o => o.valueUsd == null).length
  return (
    <div className="ord-kpis" role="group" aria-label="Active orders">
      {agg.orders > 0 && <>
        <div className="ord-kpi"><span className="k">DCA orders</span><span className="v">{F.int(agg.orders)}</span></div>
        <div className="ord-kpi" title="Combined spend rate over the next day, capped by what each order can still fund">
          <span className="k">Rate</span>
          <span className="v">{agg.perDayUsd > 0 ? <>≈ <Usd v={agg.perDayUsd} /><span className="u">/day</span></> : '—'}</span>
        </div>
        <div className="ord-kpi" title={dcaUnpriced > 0 ? `${dcaUnpriced} unpriced ${dcaUnpriced === 1 ? 'order is' : 'orders are'} not included` : 'Still to spend across the active DCA orders, at today’s prices'}>
          <span className="k">Left to spend</span>
          <span className="v">{agg.pricedOrders > 0
            ? <>≈ <Usd v={agg.leftUsd} />{dcaUnpriced > 0 && <span className="u"> +{dcaUnpriced} unpriced</span>}</>
            : <span className="u">unpriced</span>}</span>
        </div>
      </>}
      {agg.orders > 0 && openLimitOrders.length > 0 && <span className="ord-kpi-sep" aria-hidden="true" />}
      {openLimitOrders.length > 0 && <>
        <div className="ord-kpi"><span className="k">Limit orders</span><span className="v">{F.int(openLimitOrders.length)}</span></div>
        <div className="ord-kpi" title={limitUnpriced > 0 ? `${limitUnpriced} unpriced ${limitUnpriced === 1 ? 'order is' : 'orders are'} not included` : 'What the open limit orders still have resting, at today’s prices'}>
          <span className="k">Resting</span>
          <span className="v">{limitUnpriced < openLimitOrders.length
            ? <><Usd v={resting} />{limitUnpriced > 0 && <span className="u"> +{limitUnpriced} unpriced</span>}</>
            : <span className="u">unpriced</span>}</span>
        </div>
      </>}
    </div>
  )
}

const EMPTY_TEXT = { all: 'No finished orders yet', dca: 'No finished DCA orders yet', limit: 'No finished limit orders yet' } as const

// Every finished order — completed, cancelled, terminated, migrated, filled,
// expired — newest end first, paged by the API over the full filtered set. The
// kind and the page live in the URL (`okind`, `opage`) so a link restores the view.
function OrderHistory({ scope, showOwner, now }: { scope: PositionScope; showOwner?: boolean; now: number }) {
  const qs = useQuery()
  const kind = parseOrderKind(qs.get('okind'))
  const page = parseOrderPage(qs.get('opage'))
  const q = useOrderHistory(scope, page * HISTORY_PAGE, kind, HISTORY_PAGE)
  const cols = showOwner ? 9 : 8
  const total = q.data?.total
  const totalPages = total != null ? Math.max(1, Math.ceil(total / HISTORY_PAGE)) : undefined
  return (
    <section className="ord-history" aria-label="Order history">
      <div className="sec-title-row">
        <div className="sec-title">Order history{total != null && kind === 'all' ? ` · ${F.int(total)}` : ''}</div>
        <div className="seg-bar ord-seg" role="group" aria-label="Order kind">
          {ORDER_KIND_FILTERS.map(c => (
            <button key={c.v} type="button" aria-pressed={kind === c.v} className={`seg-btn${kind === c.v ? ' active' : ''}`}
              onClick={() => setQuery({ okind: c.v === 'all' ? null : c.v, opage: null })}>{c.label}</button>
          ))}
        </div>
      </div>
      <div className="panel"><table className="tbl dca-tbl ord-tbl">
        <thead><tr>
          <th>Order</th>{showOwner && <th>Owner</th>}<th>Status</th>
          <th className="r">Sold</th><th className="r">Received</th><th className="r">Avg price</th>
          <th className="r">Trades</th><th className="r">Opened</th><th className="r">Ended</th>
        </tr></thead>
        <tbody>
          {q.isLoading ? <TableSkeleton cols={cols} rows={HISTORY_PAGE} />
            : q.isError && !q.data ? <ErrorRow cols={cols} title="Could not load the order history" error={q.error} onRetry={() => void q.refetch()} />
              : !q.data?.rows.length ? <EmptyRow cols={cols}>{EMPTY_TEXT[kind]}</EmptyRow>
                : q.data.rows.map(row => <OrderHistoryTr key={`${row.kind}/${row.id}`} row={row} showOwner={showOwner} now={now} />)}
        </tbody>
      </table></div>
      {totalPages != null && totalPages > 1 && (
        <Pager page={page} totalPages={totalPages} onPage={p => setQuery({ opage: p > 0 ? String(p) : null })} />
      )}
    </section>
  )
}

function orderPath(row: OrderHistoryRow): string {
  return row.kind === 'dca' ? paths.dcaSchedule(Number(row.id)) : paths.intent(row.id)
}

function OrderHistoryTr({ row, showOwner, now }: { row: OrderHistoryRow; showOwner?: boolean; now: number }) {
  const { assetIn, assetOut } = row
  const price = orderAvgPrice(row.soldAmount, row.receivedAmount, assetIn.decimals, assetOut.decimals)
  const open = row.budgetAmount === '0'
  return (
    <tr {...rowNav(orderPath(row))} data-order-history={`${row.kind}/${row.id}`}>
      <td data-label="Order">
        <span className="asset-flow">
          <span className="trade-leg"><AssetIcon assetId={assetIn.assetId} iconAssetId={assetIn.iconAssetId} iconAssetIds={assetIn.iconAssetIds} symbol={assetIn.symbol} size={20} parachainId={assetIn.parachainId} origin={assetIn.origin} /> <span className="mono">{assetIn.symbol}</span></span>
          {' → '}
          <span className="trade-leg"><AssetIcon assetId={assetOut.assetId} iconAssetId={assetOut.iconAssetId} iconAssetIds={assetOut.iconAssetIds} symbol={assetOut.symbol} size={20} parachainId={assetOut.parachainId} origin={assetOut.origin} /> <span className="mono">{assetOut.symbol}</span></span>
        </span>
        <span className="dca-sub ord-id">
          <span className={`dca-kind ord-kind-${row.kind}`}>{ORDER_KIND_LABEL[row.kind]}</span>
          <span className="mono muted">{orderHandle(row)}</span>
          {row.direction === 'Buy' && <span className="muted">buy</span>}
        </span>
      </td>
      {showOwner && <td data-label="Owner">{row.who ? <AddrPill account={row.who} noCopy /> : <Dash />}</td>}
      <td data-label="Status">
        <span className="dca-state ord-state" style={{ color: ORDER_STATUS_TONE[row.status] }} title={row.statusReason ?? undefined}>● {row.status}</span>
        {row.status === 'migrated' && row.migratedToIntentId
          ? <span className="dca-sub muted">to <Link to={paths.intent(row.migratedToIntentId)} className="hash" title={`Intent ${row.migratedToIntentId}`}>intent</Link></span>
          : row.statusReason && <span className="dca-sub mono muted ord-reason" title={row.statusReason}>{row.statusReason}</span>}
      </td>
      <td data-label="Sold" className="r">
        {row.soldAmount === '0' ? <Dash /> : <AssetAmount asset={assetIn} raw={row.soldAmount} />}
        <span className="dca-sub mono muted" title="Each trade valued at its own time">
          {row.soldUsd != null ? <Usd v={row.soldUsd} /> : row.trades > 0 ? 'unpriced' : row.soldAmount === '0' ? 'nothing traded' : open ? 'open-ended' : ''}
        </span>
      </td>
      <td data-label="Received" className="r">{row.receivedAmount === '0' ? <Dash /> : <AssetAmount asset={assetOut} raw={row.receivedAmount} />}</td>
      <td data-label="Avg price" className="r mono">
        {price != null
          ? <span title={`${price} ${assetOut.symbol} per ${assetIn.symbol}, over the order’s whole life`}>
            <Num v={Number(price)} /> <span className="muted">{assetOut.symbol}</span>
            <span className="dca-sub mono muted">per {assetIn.symbol}</span>
          </span>
          : <Dash />}
      </td>
      <td data-label="Trades" className="r mono">
        {F.int(row.trades)}
        {row.failedTrades > 0 && <span className="dca-sub mono muted" title="Attempts the DCA pallet made that did not trade">{F.int(row.failedTrades)} failed</span>}
      </td>
      <td data-label="Opened" className="r mono"><MomentLink at={{ blockHeight: row.openedBlock, extrinsicIndex: row.openedIndex, timestamp: row.openedAt }} now={now} /></td>
      <td data-label="Ended" className="r mono"><MomentLink at={{ blockHeight: row.endedBlock, extrinsicIndex: null, timestamp: row.endedAt }} now={now} /></td>
    </tr>
  )
}
