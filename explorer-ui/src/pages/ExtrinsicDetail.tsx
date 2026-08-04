import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useExtrinsic, useExtrinsicActivity, useStats } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, navigate, redirect } from '../router'
import { Crumbs, F, AddrPill, CallPill, StatusBadge, FinalizedBadge, FailureReasonRow, Copy, CopyTextButton, JsonView, ParamsTable, SkeletonRows } from '../components/ui'
import { api } from '../api/explorer'
import { ActivityTable } from '../components/ActivityTable'
import { EvmCallCard, EvmLogView } from '../components/EvmDecoded'

// Copies the extrinsic's SCALE bytes, fetched on demand: extrinsics are stored decoded,
// so the encoded form comes from the chain (see extrinsicBytes.ts — re-encoding from
// normalised args could produce subtly wrong bytes, which is worse than none). The button
// is enabled only once those bytes are in hand.
function CallDataCopy({ height, index }: { height: number; index: number }) {
  const { data } = useQuery({
    queryKey: ['extrinsic-encoded', height, index],
    queryFn: ({ signal }) => api.extrinsicEncoded(height, index, signal),
    staleTime: 3_600_000,
    retry: false,
  })
  if (!data?.encoded) return null
  return <CopyTextButton label="call data" text={data.encoded} />
}

export function ExtrinsicDetail({ id }: { id: string }) {
  const { data, isLoading, isError } = useExtrinsic(id)
  // Prefer the resolved height-index id; while a 0x-hash id loads, show the short hash.
  useDocumentTitle(`Extrinsic ${data ? `${data.blockHeight}-${data.index}` : id.startsWith('0x') ? F.shortAddr(id) : id}`)
  // "Next extrinsic" only asks whether index+1 exists in this block. Asking the
  // sibling directly answers it in ~1–3 kB and lands under the very query key that
  // page reads, so the arrow opens an already-loaded extrinsic; the block detail
  // this used to come from carries every extrinsic and event in the block (5–10 kB
  // compressed on a busy block) purely for that one chevron. A 404 on the block's
  // last extrinsic is the answer, and 4xx is never retried (see queryRetry).
  const next = useExtrinsic(data ? `${data.blockHeight}-${data.index + 1}` : null)
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
  const canGoNext = !!data && !!next.data

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Extrinsics', to: paths.extrinsics() }, { label: id }]} />
        <div className="detail-header">
          <div className="page-title">Extrinsic <span className="num">{id}</span></div>
          {/* Both arrows always occupy the strip, the unavailable one disabled:
              a block's first and last extrinsic otherwise moved the remaining
              arrow sideways, so the same control sat under a different pixel on
              every page of a walk. Rendering the strip before `data` resolves
              also keeps the title row's height stable — appearing only once the
              extrinsic loaded pushed the whole page down 50px (0.11 of layout
              shift) exactly when the reader started reading. */}
          <div className="nav-btns">
            <button type="button" disabled={!data || data.index === 0} onClick={() => data && navigate(paths.extrinsicAt(data.blockHeight, data.index - 1))} title={data && data.index > 0 ? 'Previous extrinsic' : 'First extrinsic in this block'} aria-label="Previous extrinsic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg></button>
            <button type="button" disabled={!canGoNext} onClick={() => canGoNext && navigate(paths.extrinsicAt(data!.blockHeight, data!.index + 1))} title={canGoNext ? 'Next extrinsic' : 'Last extrinsic in this block'} aria-label="Next extrinsic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6" /></svg></button>
          </div>
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
              <div className="dt">Module / Call</div><div className="dd"><CallPill name={data.callName} /> <CallDataCopy height={data.blockHeight} index={data.index} /></div>
              <div className="dt">Result</div><div className="dd"><StatusBadge ok={data.success} /></div>
              {!data.success && data.errorReason && <FailureReasonRow reason={data.errorReason} />}
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

            {tab === 'params' && (
              <>
                {data.evmCalls?.map((c, i) => <EvmCallCard key={`${c.target}-${i}`} decoded={c} />)}
                <ParamsTable args={args} />
              </>
            )}

            {tab === 'events' && (
              <div className="panel">
                {data.events.map(e => (
                  <div className="event-row" key={e.eventIndex}>
                    <div className="ei"><Link to={paths.eventAt(data.blockHeight, e.eventIndex)} className="hash">{e.eventIndex}</Link></div>
                    <div className="ec">
                      <div className="row gap6"><Link to={paths.eventAt(data.blockHeight, e.eventIndex)} className="hash"><CallPill name={e.name} /></Link>{e.decoded && <span className="badge" style={{ background: 'color-mix(in srgb, var(--neutral) 15%, transparent)', color: 'var(--neutral)' }}>decoded</span>}</div>
                      {e.evmDecoded
                        ? <EvmLogView decoded={e.evmDecoded} />
                        : e.args != null && typeof e.args === 'object' && Object.keys(e.args).length > 0 && <JsonView value={e.args} />}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'json' && (() => {
              const json = { block_height: data.blockHeight, extrinsic_index: data.index, extrinsic_hash: data.hash, call_name: data.callName, signer: data.signer?.address ?? null, success: data.success, fee: data.fee, tip: data.tip, call_args: data.callArgs }
              return <>
                <div className="json-copy-row"><CopyTextButton label="copy JSON" text={JSON.stringify(json, null, 2)} /></div>
                <JsonView value={json} />
              </>
            })()}
          </>
        )}
    </div>
  )
}
