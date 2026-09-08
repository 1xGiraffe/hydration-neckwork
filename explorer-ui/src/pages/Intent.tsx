import { Fragment, useState } from 'react'
import { useIntentOrder, useStats } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths } from '../router'
import { Crumbs, F, AddrPill, AssetChip, AssetAmount, FeeAmount, ProgressRing, SkeletonRows, MomentLink, Pager, compactAmount } from '../components/ui'
import { ActivityTable } from '../components/ActivityTable'
import { intentLabel } from '../components/activityColors'
import { estimateBlockCountdown } from '../utils/blockCountdown'
import { blockSeconds, blockSpanSeconds, fmtDuration, fmtPermill } from '../utils/dca'
import type { IntentOrderDetail, IntentOrderStatus } from '../types'

const PAGE = 25

// An open order is live; a filled, completed or partially-filled one has been (or is
// being) met, so it wears the settled shade; a cancel is the owner's own quiet exit
// and an expiry is the order failing to find a match in time.
const STATUS_TONE: Record<IntentOrderStatus, string> = {
  open: 'var(--green)', 'partially-filled': 'var(--sky)', filled: 'var(--sky)', completed: 'var(--sky)',
  cancelled: 'var(--text-low)', expired: 'var(--red)',
}

// A share of a raw amount in another, to two decimals of a percent, by integer
// arithmetic: 128-bit amounts exist and Number would round them.
function ratioPct(part: string, whole: string): number | null {
  if (!/^\d+$/.test(part) || !/^\d+$/.test(whole)) return null
  const den = BigInt(whole)
  if (den === 0n) return null
  return Number((BigInt(part) * 10000n) / den) / 100
}

function isZero(raw: string | null | undefined): boolean {
  return raw == null || /^0*$/.test(raw)
}

// The deadline is wall-clock milliseconds, unlike every block-anchored moment on the
// page, so it is stated as the date it names and — while it is still ahead — how far.
function deadlineText(deadlineMs: number, now: number): string {
  const left = (deadlineMs - now) / 1000
  return left > 0 ? `in ${fmtDuration(left)}` : 'passed'
}
function deadlineDate(deadlineMs: number): string {
  return new Date(deadlineMs).toISOString().slice(0, 16).replace('T', ' · ')
}

function ExtrinsicRef({ at }: { at: { block: number; extrinsicIndex: number | null } }) {
  return at.extrinsicIndex != null
    ? <Link to={paths.extrinsicAt(at.block, at.extrinsicIndex)} className="hash">{F.int(at.block)}-{at.extrinsicIndex}</Link>
    : <Link to={paths.block(at.block)} className="hash">{F.int(at.block)}</Link>
}

// The order in one sentence, the way its owner would say it. A limit order names the
// least it must fetch; a DCA intent sells its budget in slices the pallet sizes, so it
// names the budget, what it buys, and how often.
function OrderLine({ data, cadence }: { data: IntentOrderDetail; cadence: number }) {
  const { order, assetIn, assetOut } = data
  if (order.kind === 'dca') {
    return (
      <div className="dca-order">
        sells <AssetAmount asset={assetIn} raw={order.budget ?? order.amountIn} /> → <AssetChip asset={assetOut} />
        {cadence > 0 && <span className="dca-every">every {fmtDuration(cadence)}</span>}
      </div>
    )
  }
  return (
    <div className="dca-order">
      sells <AssetAmount asset={assetIn} raw={order.amountIn} /> for ≥ <AssetAmount asset={assetOut} raw={order.amountOut} />
    </div>
  )
}

// An ICE intent is an order the chain has yet to make — a limit order or a DCA — and
// this is every event of its life on one page: what it asked for, how much of that it
// has got, who placed it, the fills the solver settled it with, and the callbacks it
// queued. Modelled on the DCA schedule page, which the DCA intent replaced.
export function Intent({ intentId }: { intentId: string }) {
  const [page, setPage] = useState(0)
  const { data, isLoading, isError } = useIntentOrder(intentId, page * PAGE)
  const live = data?.status === 'open' || data?.status === 'partially-filled'
  const { data: stats } = useStats(!!live)
  const now = useNow()
  const kind = data ? intentLabel(data.order.kind, undefined) : 'Intent'
  const title = data ? `${kind} #${data.order.seq}` : 'Intent'
  useDocumentTitle(data ? title : null)

  // A limit order's progress is the share of what it sells that has gone; a DCA
  // intent's is the share of its budget spent. An unbudgeted DCA has no whole to be a
  // fraction of, so the ring counts its trades instead.
  const pct = data
    ? data.order.kind === 'dca'
      ? data.order.budget != null && !isZero(data.order.budget)
        ? ratioPct(data.dca?.remainingBudget != null ? (BigInt(data.order.budget) - BigInt(data.dca.remainingBudget)).toString() : data.filledIn, data.order.budget)
        : null
      : ratioPct(data.filledIn, data.order.amountIn)
    : null
  const cadence = data?.order.kind === 'dca' && data.order.period > 0 ? blockSpanSeconds(data.order.period, stats?.avgBlockSec) : 0
  const countdown = live && data?.dca?.nextEligibleBlock && stats?.headBlock
    ? estimateBlockCountdown(data.dca.nextEligibleBlock, stats.headBlock, stats.headTime, now, blockSeconds(stats.avgBlockSec))
    : null
  const nextDue = live && data?.dca?.nextEligibleBlock != null && stats?.headBlock != null && data.dca.nextEligibleBlock <= stats.headBlock

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Activity', to: paths.activity() + '?tab=trade' }, { label: title }]} />
        <div className="page-title">{title}
          {data && <span className="sub">{data.status}</span>}
        </div>
      </div>
      {isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Intent not found</div>
        : isLoading || !data ? <div className="detail-card"><SkeletonRows rows={5} /></div> : (
          <>
            <div className="detail-card dca-card">
              <div className="dca-hero">
                <ProgressRing
                  pct={pct} size={62} stroke={5}
                  label={pct != null
                    ? <span className="pr-pct">{Math.round(pct)}<span className="pr-unit">%</span></span>
                    : <span className="pr-runs mono">{F.int(data.fillsTotal)}×</span>}
                  title={pct == null ? 'No budget to measure against — the ring counts its trades'
                    : data.order.kind === 'dca' ? `${pct.toFixed(1)}% of the budget spent` : `${pct.toFixed(1)}% of the order filled`}
                />
                <div className="dca-hero-body">
                  <OrderLine data={data} cadence={cadence} />
                  <div className="dca-hero-facts">
                    <span className="dca-state" style={{ color: STATUS_TONE[data.status] }}>● {data.status}</span>
                    {data.order.partial && <span>partial fills</span>}
                    {data.order.deadlineMs != null && live && <span>expires <span className="mono">{deadlineText(data.order.deadlineMs, now)}</span></span>}
                    {countdown && <span>{countdown.secondsUntil > 0
                      ? <>next in <span className="mono">{fmtDuration(countdown.secondsUntil, { seconds: true })}</span></>
                      : <span title="Its eligible block is at the head — the trade is awaiting a solution">next trade due</span>}</span>}
                    <span className="muted"><span className="mono">{F.int(data.fillsTotal)}</span> {data.fillsTotal === 1 ? 'fill' : 'fills'}</span>
                  </div>
                </div>
              </div>

              <div className="dl">
                {/* The terms */}
                {data.order.kind === 'swap' && <>
                  <div className="dt">Limit</div>
                  <div className="dd">≥ <AssetAmount asset={data.assetOut} raw={data.order.amountOut} />
                    {data.limitPriceOutPerIn != null && Number.isFinite(Number(data.limitPriceOutPerIn)) && <span className="muted mono" title={`${data.limitPriceOutPerIn} ${data.assetOut.symbol} per ${data.assetIn.symbol}`}>
                      {' · '}{compactAmount(Number(data.limitPriceOutPerIn))} {data.assetOut.symbol} per {data.assetIn.symbol}
                    </span>}
                  </div>
                  <div className="dt">Partial fills</div>
                  <div className="dd">{data.order.partial
                    ? <>allowed{data.order.partialMin != null && !isZero(data.order.partialMin) && <span className="muted"> · at least <span className="mono">{F.amount(data.order.partialMin, data.assetIn.decimals)} {data.assetIn.symbol}</span> per fill</span>}</>
                    : <span className="muted">not allowed · settles in one fill or not at all</span>}
                  </div>
                </>}
                {data.order.kind === 'dca' && <>
                  {data.order.period > 0 && <>
                    <div className="dt">Every</div>
                    <div className="dd" title="Estimated from the chain’s current block time">
                      <span className="mono">~{fmtDuration(cadence)}</span>
                      <span className="muted mono dca-blocks">· {F.int(data.order.period)} blocks</span>
                    </div>
                  </>}
                  {/* The budget as placed, then what is still ahead of the order. The
                      per-trade slice is a separate row only when the API states one
                      apart from the budget. */}
                  {data.order.budget != null && <>
                    <div className="dt">Budget</div>
                    <div className="dd"><AssetAmount asset={data.assetIn} raw={data.order.budget} />
                      {data.dca?.remainingBudget != null && <span className="muted mono" title="Left of the budget — what this intent still has to spend">
                        {' · '}{F.amount(data.dca.remainingBudget, data.assetIn.decimals)} {data.assetIn.symbol} left
                      </span>}
                    </div>
                  </>}
                  {data.order.budget != null && data.order.amountIn !== data.order.budget && !isZero(data.order.amountIn) && <>
                    <div className="dt">Per trade</div>
                    <div className="dd"><AssetAmount asset={data.assetIn} raw={data.order.amountIn} />
                      {!isZero(data.order.amountOut) && <> → ≥ <AssetAmount asset={data.assetOut} raw={data.order.amountOut} /></>}
                    </div>
                  </>}
                </>}
                {data.order.slippagePpm > 0 && <>
                  <div className="dt">Slippage</div>
                  <div className="dd"><span className="mono">{fmtPermill(data.order.slippagePpm)}</span>
                    <span className="muted"> · tolerated when a fill settles</span>
                  </div>
                </>}
                {/* A term of the order, live or settled — so "Deadline", not "Expires",
                    which would read as a verdict on an order that was filled in time. */}
                {data.order.deadlineMs != null && <>
                  <div className="dt">Deadline</div>
                  <div className="dd mono">{deadlineText(data.order.deadlineMs, now)}
                    <span className="muted"> · {deadlineDate(data.order.deadlineMs)}</span>
                  </div>
                </>}

                {/* Where it stands */}
                <div className="dt">Filled</div>
                <div className="dd"><span className="asset-flow"><AssetAmount asset={data.assetIn} raw={data.filledIn} /> → <AssetAmount asset={data.assetOut} raw={data.filledOut} /></span>
                  <span className="muted mono"> · {F.int(data.fillsTotal)} {data.fillsTotal === 1 ? 'fill' : 'fills'}</span>
                </div>
                {data.dca?.lastExecutionBlock != null && <>
                  <div className="dt">Last trade</div>
                  <div className="dd mono">block <Link to={paths.block(data.dca.lastExecutionBlock)} className="hash">{F.int(data.dca.lastExecutionBlock)}</Link></div>
                </>}
                {data.dca?.nextEligibleBlock != null && live && <>
                  <div className="dt">Next trade</div>
                  <div className="dd"><span className="mono">{countdown
                    ? countdown.secondsUntil > 0 ? `in ${fmtDuration(countdown.secondsUntil, { seconds: true })}` : 'due'
                    : nextDue ? 'due' : 'eligible'}</span>
                    <span className="muted mono dca-blocks"> · from block <Link to={paths.block(data.dca.nextEligibleBlock)} className="hash">{F.int(data.dca.nextEligibleBlock)}</Link></span>
                    {countdown && countdown.secondsUntil > 0 && <span className="muted"> · ~{new Date(countdown.etaMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>}
                  </div>
                </>}
                {data.order.forwardContract && <>
                  <div className="dt">Forwarded to</div>
                  <div className="dd mono wrap-anywhere"><Link to={paths.account(data.order.forwardContract)} className="hash">{F.shortAddr(data.order.forwardContract)}</Link>
                    <span className="muted"> · the contract each fill is delivered to</span>
                  </div>
                </>}

                {/* Who and when */}
                <div className="dt">Owner</div><div className="dd">{data.owner ? <AddrPill account={data.owner} /> : '—'}</div>
                <div className="dt">Placed</div>
                <div className="dd mono"><MomentLink at={{ blockHeight: data.order.blockHeight, extrinsicIndex: data.order.extrinsicIndex, timestamp: data.order.timestamp }} now={now} />
                  <span className="muted"> · {data.order.timestamp.slice(0, 16).replace(' ', ' · ')}</span>
                </div>
                {data.migratedFrom != null && <>
                  <div className="dt">Migrated from</div>
                  <div className="dd"><Link to={paths.dcaSchedule(data.migratedFrom)} className="hash">DCA schedule #{F.int(data.migratedFrom)}</Link>
                    <span className="muted"> · runtime 443 moved live schedules onto ICE intents</span>
                  </div>
                </>}
                <div className="dt">Submitted in</div>
                <div className="dd mono"><ExtrinsicRef at={data.links.submission} /></div>
                {data.links.solutions.length > 0 && <>
                  <div className="dt">Settled in</div>
                  <div className="dd mono">{data.links.solutions.map((s, i) => (
                    <Fragment key={`${s.block}-${s.extrinsicIndex ?? 'b'}`}>{i > 0 && <span className="muted"> · </span>}<ExtrinsicRef at={s} /></Fragment>
                  ))}
                    <span className="muted"> · {data.links.solutions.length === 1 ? 'the solution' : 'the solutions'} that filled it</span>
                  </div>
                </>}
              </div>
            </div>

            <div className="sec-title" style={{ marginTop: 22 }}>Fills <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}>· newest first</span></div>
            {/* Each fill is one event, so a row links to its own page — the rule the DCA
                schedule page follows — never back to this order. */}
            <ActivityTable rows={data.fills} now={now} noActor dcaExecutionLinks />
            <Pager page={page} totalPages={Math.max(1, Math.ceil(data.fillsTotal / PAGE))} hasNext={(page + 1) * PAGE < data.fillsTotal} onPage={setPage} />

            {data.callbacks.length > 0 && <>
              <div className="sec-title" style={{ marginTop: 22 }}>Callbacks</div>
              <div className="panel"><table className="tbl">
                <thead><tr><th>Queue</th><th>Queued</th><th className="r">Fee</th><th>Result</th></tr></thead>
                <tbody>
                  {data.callbacks.map(c => (
                    <tr key={c.queueId}>
                      <td className="mono" data-label="Queue" title={c.queueId}>{F.shortHash(c.queueId)}</td>
                      <td className="mono" data-label="Queued"><MomentLink at={{ blockHeight: c.queuedAt.block, extrinsicIndex: c.queuedAt.extrinsicIndex, timestamp: c.queuedAt.timestamp }} now={now} /></td>
                      {/* `LazyExecutor.Queued.fees` is `pallet_transaction_payment::compute_fee`
                          output — the same quantity as `TransactionFeePaid.actualFee`, always
                          HDX-denominated regardless of the asset debited. */}
                      <td className="r mono" data-label="Fee"><FeeAmount hdxRaw={c.fees} /></td>
                      <td data-label="Result">{c.executed
                        ? <>{c.executed.result === 'ok'
                          ? <span style={{ color: 'var(--green)' }}>executed</span>
                          : <span style={{ color: 'var(--red)' }}>failed{c.executed.error && <span className="muted"> · {c.executed.error}</span>}</span>}
                          <span className="muted mono"> · block <Link to={paths.block(c.executed.block)} className="hash">{F.int(c.executed.block)}</Link></span></>
                        : <span className="muted">queued — not executed yet</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </>}
          </>
        )}
    </div>
  )
}
