import { useMemo, useState } from 'react'
import { useAccountRevenueBreakdown, useTagRevenueBreakdown } from '../hooks/useExplorerData'
import { useListTagRevenueBreakdown } from '../hooks/useUser'
import { AssetChip, ChartSkeleton, F } from './ui'
import { ShareBar } from './HdxCharts'
import type { ShareSegment } from './HdxCharts'
import { ChartTooltipRow as TipRow } from './DashboardPrimitives'
import { REVENUE_STREAM_COLOR, REVENUE_STREAM_LABEL } from './revenueColors'
import type { RevenueBreakdown, RevenueBreakdownStream, RevenueStream } from '../types'

type RevenueScope =
  | { kind: 'account'; address: string }
  | { kind: 'tag'; tagId: string }
  | { kind: 'list-tag'; listId: string; tagId: string }

const streamLabel = (stream: string) => REVENUE_STREAM_LABEL[stream as RevenueStream] ?? stream
const streamColor = (stream: string) => REVENUE_STREAM_COLOR[stream as RevenueStream] ?? 'var(--text-low)'

// The Protocol Revenue tab: where the revenue this account (or tag) generated
// came from. First level mirrors the /revenue page's Breakdown — the same share
// bar and stream table, same colors and labels — and each stream row expands
// into its per-asset composition (the assets whose trades, liquidations or
// fees produced it), the tail folded into one line.
export function RevenueBreakdownTab({ scope }: { scope: RevenueScope }) {
  const account = useAccountRevenueBreakdown(scope.kind === 'account' ? scope.address : null)
  const tag = useTagRevenueBreakdown(scope.kind === 'tag' ? scope.tagId : null)
  const listTag = useListTagRevenueBreakdown(
    scope.kind === 'list-tag' ? scope.listId : null,
    scope.kind === 'list-tag' ? scope.tagId : null,
  )
  const query = scope.kind === 'account' ? account : scope.kind === 'tag' ? tag : listTag
  const data: RevenueBreakdown | undefined = query.data

  // The largest stream WITH a second level starts open — the first paint reads
  // as a single-level summary with the dominant composition already visible;
  // everything else is one tap away. (The largest stream outright is often
  // single-asset — HOLLAR interest — where there is nothing to open.)
  // null = "no interaction yet", so the default can follow the data.
  const [toggled, setToggled] = useState<Set<string> | null>(null)
  const expanded = useMemo(() => {
    if (toggled) return toggled
    const first = data?.streams.find(s => s.assets.length > 1 || s.otherCount > 0)
    return new Set(first ? [first.stream] : [])
  }, [toggled, data])
  const toggle = (stream: string) => {
    const next = new Set(expanded)
    if (next.has(stream)) next.delete(stream)
    else next.add(stream)
    setToggled(next)
  }

  const segments: ShareSegment[] = useMemo(() => (data?.streams ?? []).map(s => ({
    key: s.stream,
    label: streamLabel(s.stream),
    color: streamColor(s.stream),
    value: s.usd,
    tip: <TipRow color={streamColor(s.stream)} label={streamLabel(s.stream)} value={`${F.usd(s.usd)} · ${data!.totalUsd > 0 ? ((s.usd / data!.totalUsd) * 100).toFixed(1) : '0.0'}%`} />,
  })), [data])

  if (query.isError) return <div className="pf-card"><div className="rev-empty">Couldn’t load the revenue breakdown.</div></div>
  if (!data) return <div className="pf-card"><ChartSkeleton /></div>
  if (!data.streams.length) return <div className="pf-card"><div className="rev-empty">No protocol revenue recorded from this {scope.kind === 'account' ? 'account' : 'tag'} yet.</div></div>

  return (
    <>
      <div className="pf-card">
        <div className="revbd-total">
          <span className="k">Protocol revenue, all time</span>
          <span className="v mono">{F.usd(data.totalUsd)}</span>
        </div>
        <ShareBar segments={segments} />
        <table className="tbl rev-breakdown-tbl">
          <thead>
            <tr><th>Stream</th><th className="num">Revenue</th><th className="num">Share</th></tr>
          </thead>
          <tbody>
            {data.streams.map(s => (
              <StreamRows key={s.stream} stream={s} totalUsd={data.totalUsd} open={expanded.has(s.stream)} onToggle={() => toggle(s.stream)} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="rev-note">
        What the protocol earned from this {scope.kind === 'account' ? 'account’s' : 'tag’s'} usage — trade fees,
        liquidations, borrow interest and network fees — valued at event time, broken down by the asset each
        fee was collected in. Same figures as the <a href="/revenue">Revenue</a> page, at the account grain.
      </p>
    </>
  )
}

function StreamRows({ stream, totalUsd, open, onToggle }: { stream: RevenueBreakdownStream; totalUsd: number; open: boolean; onToggle: () => void }) {
  const color = streamColor(stream.stream)
  // A single-asset stream (HOLLAR interest, the H2O protocol fee) has no second
  // level worth a chevron: its one asset line says everything the row already
  // does. It still renders expanded content-free.
  const expandable = stream.assets.length > 1 || stream.otherCount > 0
  return (
    <>
      <tr className={`revbd-stream${expandable ? ' expandable' : ''}`} onClick={expandable ? onToggle : undefined} aria-expanded={expandable ? open : undefined}>
        <td data-label="Stream">
          <span className="rev-dot" style={{ background: color, marginRight: 8 }} />
          {streamLabel(stream.stream)}
          {expandable && <span className="revbd-chev" aria-hidden="true">{open ? '▾' : '▸'}</span>}
        </td>
        <td className="num mono" data-label="Revenue">{F.usd(stream.usd)}</td>
        <td className="num mono" data-label="Share">{totalUsd > 0 ? ((stream.usd / totalUsd) * 100).toFixed(1) : '0.0'}%</td>
      </tr>
      {expandable && open && stream.assets.map(a => (
        <tr className="revbd-asset" key={a.asset.assetId}>
          <td data-label="Asset">
            <span className="revbd-asset-cell">
              <AssetChip asset={a.asset} />
              <span className="revbd-assetbar" aria-hidden="true">
                <span style={{ width: `${stream.usd > 0 ? Math.min(100, (a.usd / stream.usd) * 100) : 0}%`, background: color }} />
              </span>
            </span>
          </td>
          <td className="num mono" data-label="Revenue">{F.usd(a.usd)}</td>
          <td className="num mono muted" data-label="Share">{stream.usd > 0 ? ((a.usd / stream.usd) * 100).toFixed(1) : '0.0'}%</td>
        </tr>
      ))}
      {expandable && open && stream.otherCount > 0 && (
        <tr className="revbd-asset revbd-other">
          <td data-label="Asset"><span className="muted">{stream.otherCount} more {stream.otherCount === 1 ? 'asset' : 'assets'}</span></td>
          <td className="num mono" data-label="Revenue">{F.usd(stream.otherUsd)}</td>
          <td className="num mono muted" data-label="Share">{stream.usd > 0 ? ((stream.otherUsd / stream.usd) * 100).toFixed(1) : '0.0'}%</td>
        </tr>
      )}
    </>
  )
}
