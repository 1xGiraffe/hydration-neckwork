import { useState } from 'react'
import { useBlock, useBlockActivity, useStats } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, navigate } from '../router'
import { Crumbs, F, AddrPill, CallPill, StatusBadge, FinalizedBadge, JsonView, SkeletonRows, EmptyRow, Dash } from '../components/ui'
import { ActivityTable } from '../components/ActivityTable'
import { estimateBlockCountdown } from '../utils/blockCountdown'

// Hydration targets ~6s blocks, so the ETA of a not-yet-produced block is the
// observed head timestamp plus (height − head) × 6s.
const BLOCK_SEC = 6

function FutureBlock({ height, head, headTime, now }: { height: number; head: number; headTime?: string; now: number }) {
  const remaining = height - head
  const timing = estimateBlockCountdown(height, head, headTime, now, BLOCK_SEC)
  const secondsUntil = timing?.secondsUntil ?? Math.max(0, remaining * BLOCK_SEC)
  const eta = timing ? new Date(timing.etaMs) : null
  // F.datetime formats a UTC indexer-style timestamp string ("YYYY-MM-DD HH:MM:SS").
  const etaIso = eta?.toISOString().slice(0, 19).replace('T', ' ')
  const etaFull = eta?.toUTCString()
  const fmt = (s: number) => {
    if (s <= 0) return 'due now'
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
    if (d > 0) return `${d}d ${h}h ${m}m`
    if (h > 0) return `${h}h ${m}m ${sec}s`
    if (m > 0) return `${m}m ${sec}s`
    return `${sec}s`
  }
  return (
    <div className="detail-card">
      <div className="dl">
        <div className="dt">Status</div>
        <div className="dd"><span className="badge pending"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>Future block</span></div>
        <div className="dt">Target height</div><div className="dd"><span className="num">{F.int(height)}</span></div>
        <div className="dt">Current head</div><div className="dd"><Link to={paths.block(head)} className="num">{F.int(head)}</Link></div>
        <div className="dt">Blocks remaining</div><div className="dd num">{F.int(remaining)}</div>
        <div className="dt">Countdown</div><div className="dd mono" title={`~${secondsUntil}s at ~${BLOCK_SEC}s/block`}>{fmt(secondsUntil)}</div>
        <div className="dt">Estimated time</div><div className="dd mono" title={etaFull}>{etaIso ? <>{etaIso} UTC <span className="muted">(est.)</span></> : <Dash />}</div>
      </div>
      <div style={{ padding: '14px 16px 4px', color: 'var(--text-medium)', fontSize: 13 }}>
        This block has not been produced yet. The estimate assumes Hydration's ~{BLOCK_SEC}s block time and updates live.
      </div>
    </div>
  )
}

export function BlockDetail({ height }: { height: number }) {
  useDocumentTitle(`Block #${height.toLocaleString('en-US')}`)
  const { data: stats } = useStats()
  const headBlock = stats?.headBlock ?? 0
  const isFuture = headBlock > 0 && height > headBlock
  const now = useNow(1000)
  // Future blocks short-circuit before the API fetch: the backend can't serve a
  // not-yet-indexed height, so we render a live countdown instead.
  const { data, isLoading, isError } = useBlock(isFuture ? null : height)
  const activity = useBlockActivity(data ? height : null)
  const [tab, setTab] = useState<'activity' | 'exts' | 'events'>('activity')
  const activityRows = activity.data ?? []

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Blocks', to: paths.blocks() }, { label: F.int(height) }]} />
        <div className="detail-header">
          <div className="page-title">Block <span className="num">{F.int(height)}</span></div>
          <div className="nav-btns">
            <button type="button" onClick={() => navigate(paths.block(height - 1))} title="Previous block" aria-label="Previous block"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg></button>
            <button type="button" onClick={() => navigate(paths.block(height + 1))} title="Next block" aria-label="Next block"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6" /></svg></button>
          </div>
        </div>
      </div>

      {isFuture ? <FutureBlock height={height} head={headBlock} headTime={stats?.headTime} now={now} />
        : isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Block not found</div>
        : isLoading || !data ? <div className="detail-card"><SkeletonRows /></div> : (
          <>
            <div className="detail-card"><div className="dl">
              <div className="dt">Block height</div><div className="dd"><span className="num">{F.int(data.height)}</span></div>
              <div className="dt">Status</div><div className="dd"><FinalizedBadge finalized={data.height <= (stats?.finalizedBlock ?? -1)} /></div>
              <div className="dt">Timestamp</div><div className="dd"><span className="mono">{F.datetime(data.timestamp)}</span></div>
              <div className="dt">Block hash</div><div className="dd"><span className="mono wrap-anywhere">{data.hash}</span></div>
              <div className="dt">Parent hash</div><div className="dd"><Link to={paths.block(data.height - 1)} className="hash wrap-anywhere">{data.parentHash}</Link></div>
              <div className="dt">State root</div><div className="dd mono wrap-anywhere muted">{data.stateRoot ?? '—'}</div>
              <div className="dt">Extrinsics root</div><div className="dd mono wrap-anywhere muted">{data.extrinsicsRoot ?? '—'}</div>
              <div className="dt">Author</div><div className="dd">{data.author ? <AddrPill account={data.author} noCopy /> : <Dash />}</div>
              <div className="dt">Spec version</div><div className="dd mono">hydration/{data.specVersion}</div>
              <div className="dt">Extrinsics</div><div className="dd num">{data.extrinsicCount}</div>
              <div className="dt">Events</div><div className="dd num">{data.eventCount}</div>
            </div></div>

            <div className="tabs">
              <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Activity {activityRows.length > 0 && <span className="cnt">{activityRows.length}</span>}</button>
              <button className={tab === 'exts' ? 'active' : ''} onClick={() => setTab('exts')}>Extrinsics <span className="cnt">{data.extrinsics.length}</span></button>
              <button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>Events <span className="cnt">{data.eventCount}</span></button>
            </div>

            {tab === 'activity' && <ActivityTable rows={activityRows} now={now} loading={activity.isFetching && !activityRows.length} />}

            {tab === 'exts' && (
              <div className="panel"><table className="tbl">
                <thead><tr><th>ID</th><th>Hash</th><th>Call</th><th>Signer</th><th className="r">Result</th></tr></thead>
                <tbody>
                  {data.extrinsics.length ? data.extrinsics.map(x => (
                    <tr key={x.index}>
                      <td data-label="ID" className="mono"><Link to={paths.extrinsic(`${data.height}-${x.index}`)} className="hash">{data.height}-{x.index}</Link></td>
                      <td data-label="Hash" className="mono"><Link to={paths.extrinsic(`${data.height}-${x.index}`)} className="hash">{F.shortHash(x.hash)}</Link></td>
                      <td data-label="Call"><CallPill name={x.callName} /></td>
                      <td data-label="Signer">{x.signer ? <AddrPill account={x.signer} noCopy /> : <span className="muted mono">— inherent</span>}</td>
                      <td data-label="Result" className="r"><StatusBadge ok={x.success} /></td>
                    </tr>
                  )) : <EmptyRow cols={5}>No extrinsics</EmptyRow>}
                </tbody>
              </table></div>
            )}

            {tab === 'events' && (
              <div className="panel">
                {data.events.length ? data.events.map(e => (
                  <div className="event-row" key={e.eventIndex}>
                    <div className="ei"><Link to={paths.eventAt(data.height, e.eventIndex)} className="hash">{e.eventIndex}</Link></div>
                    <div className="ec">
                      <div className="row gap6"><Link to={paths.eventAt(data.height, e.eventIndex)} className="hash"><CallPill name={e.name} /></Link>{e.extrinsicIndex != null && <span className="muted mono" style={{ fontSize: 11 }}>extrinsic {data.height}-{e.extrinsicIndex}</span>}</div>
                      {e.args != null && typeof e.args === 'object' && Object.keys(e.args).length > 0 && <JsonView value={e.args} />}
                    </div>
                  </div>
                )) : <EmptyRow cols={1}>No events</EmptyRow>}
              </div>
            )}
          </>
        )}
    </div>
  )
}
