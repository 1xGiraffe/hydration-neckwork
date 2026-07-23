import { useEffect, useState } from 'react'
import { useBlock, useExtrinsic, useExtrinsicActivity, useStats } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, navigate, redirect } from '../router'
import { Crumbs, F, AddrPill, CallPill, StatusBadge, FinalizedBadge, Copy, JsonView, ParamsTable, SkeletonRows } from '../components/ui'
import { ActivityTable } from '../components/ActivityTable'

export function ExtrinsicDetail({ id }: { id: string }) {
  const { data, isLoading, isError } = useExtrinsic(id)
  // Prefer the resolved height-index id; while a 0x-hash id loads, show the short hash.
  useDocumentTitle(`Extrinsic ${data ? `${data.blockHeight}-${data.index}` : id.startsWith('0x') ? F.shortAddr(id) : id}`)
  const block = useBlock(data?.blockHeight ?? null)
  const { data: stats } = useStats(!!data)
  const activity = useExtrinsicActivity(id, !!data)
  const now = useNow()
  const [tab, setTab] = useState<'activity' | 'params' | 'events' | 'json'>('activity')

  useEffect(() => {
    if (!data) return
    const canonicalId = `${data.blockHeight}-${data.index}`
    if (id !== canonicalId) redirect(`${paths.extrinsicAt(data.blockHeight, data.index)}${window.location.search}`)
  }, [data, id])

  const args = (data?.callArgs && typeof data.callArgs === 'object') ? data.callArgs as Record<string, unknown> : {}
  const activityRows = activity.data ?? []
  const canGoNext = !!data && !!block.data && data.index + 1 < block.data.extrinsicCount

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Extrinsics', to: paths.extrinsics() }, { label: id }]} />
        <div className="detail-header">
          <div className="page-title">Extrinsic <span className="num">{id}</span></div>
          {data && (
            <div className="nav-btns">
              {data.index > 0 && <button type="button" onClick={() => navigate(paths.extrinsicAt(data.blockHeight, data.index - 1))} title="Previous extrinsic" aria-label="Previous extrinsic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg></button>}
              {canGoNext && <button type="button" onClick={() => navigate(paths.extrinsicAt(data.blockHeight, data.index + 1))} title="Next extrinsic" aria-label="Next extrinsic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6" /></svg></button>}
            </div>
          )}
        </div>
      </div>

      {isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Extrinsic not found</div>
        : isLoading || !data ? <div className="detail-card"><SkeletonRows /></div> : (
          <>
            <div className="detail-card"><div className="dl">
              <div className="dt">Extrinsic ID</div><div className="dd mono">{data.blockHeight}-{data.index}</div>
              <div className="dt">Block</div><div className="dd mono"><Link to={paths.block(data.blockHeight)} className="hash">{F.int(data.blockHeight)}</Link> <FinalizedBadge finalized={data.blockHeight <= (stats?.finalizedBlock ?? -1)} /></div>
              <div className="dt">Timestamp</div><div className="dd mono">{F.datetime(data.timestamp)}</div>
              <div className="dt">Extrinsic hash</div><div className="dd mono wrap-anywhere">{data.hash} <Copy text={data.hash} /></div>
              <div className="dt">Module / Call</div><div className="dd"><CallPill name={data.callName} /></div>
              <div className="dt">Result</div><div className="dd"><StatusBadge ok={data.success} /></div>
              {!data.success && data.errorReason && <>
                <div className="dt">Failure reason</div>
                <div className="dd">
                  <span className="mono">{data.errorReason.label}</span>
                  {data.errorReason.docs && <div className="muted" style={{ marginTop: 4 }}>{data.errorReason.docs}</div>}
                </div>
              </>}
              {data.signer
                ? <><div className="dt">Signer</div><div className="dd"><AddrPill account={data.signer} /></div>
                  <div className="dt">Fee</div><div className="dd mono">{F.hdxFee(data.fee)}</div>
                  <div className="dt">Tip</div><div className="dd mono">{F.hdxFee(data.tip)}</div></>
                : <><div className="dt">Type</div><div className="dd"><span className="badge pending" style={{ background: 'var(--panel)', color: 'var(--text-medium)' }}>Inherent</span></div></>}
            </div></div>

            <div className="tabs">
              <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Activity {activityRows.length > 0 && <span className="cnt">{activityRows.length}</span>}</button>
              <button className={tab === 'params' ? 'active' : ''} onClick={() => setTab('params')}>Parameters</button>
              <button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>Events <span className="cnt">{data.events.length}</span></button>
              <button className={tab === 'json' ? 'active' : ''} onClick={() => setTab('json')}>Raw JSON</button>
            </div>

            {tab === 'activity' && <ActivityTable rows={activityRows} now={now} loading={activity.isFetching && !activityRows.length} />}

            {tab === 'params' && <ParamsTable args={args} />}

            {tab === 'events' && (
              <div className="panel">
                {data.events.map(e => (
                  <div className="event-row" key={e.eventIndex}>
                    <div className="ei"><Link to={paths.eventAt(data.blockHeight, e.eventIndex)} className="hash">{e.eventIndex}</Link></div>
                    <div className="ec">
                      <div className="row gap6"><Link to={paths.eventAt(data.blockHeight, e.eventIndex)} className="hash"><CallPill name={e.name} /></Link>{e.decoded && <span className="badge" style={{ background: 'var(--lavender-soft)', color: 'var(--lavender)' }}>decoded</span>}</div>
                      {e.args != null && typeof e.args === 'object' && Object.keys(e.args).length > 0 && <JsonView value={e.args} />}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'json' && <JsonView value={{ block_height: data.blockHeight, extrinsic_index: data.index, extrinsic_hash: data.hash, call_name: data.callName, signer: data.signer?.address ?? null, success: data.success, fee: data.fee, tip: data.tip, call_args: data.callArgs }} />}
          </>
        )}
    </div>
  )
}
