import { useEventAt, useStats } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths } from '../router'
import { Crumbs, AddrPill, CallPill, StatusBadge, FinalizedBadge, MomentLink, ParamsTable, SkeletonRows } from '../components/ui'
import { EvmLogView } from '../components/EvmDecoded'

export function EventDetail({ id }: { id: string }) {
  useDocumentTitle(`Event ${id}`)
  const validId = /^\d+-\d+$/.test(id)
  const { data, isLoading, isError } = useEventAt(validId ? id : null)
  const { data: stats } = useStats(!!data)
  const now = useNow()
  const args = (data?.args && typeof data.args === 'object') ? data.args as Record<string, unknown> : {}
  const extId = data?.extrinsicIndex != null ? `${data.blockHeight}-${data.extrinsicIndex}` : null

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Events', to: paths.events() }, { label: id }]} />
        <div className="detail-header">
          <div className="page-title">Event <span className="num">{id}</span></div>
        </div>
      </div>

      {!validId ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Invalid event id</div>
        : isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Event not found</div>
        : isLoading || !data ? <div className="detail-card"><SkeletonRows /></div> : (
          <>
            <div className="detail-card"><div className="dl">
              <div className="dt">Event ID</div><div className="dd mono">{data.blockHeight}-{data.eventIndex}</div>
              <div className="dt">Event</div><div className="dd"><CallPill name={data.name} />{data.decoded && <span className="badge" style={{ background: 'color-mix(in srgb, var(--neutral) 15%, transparent)', color: 'var(--neutral)', marginLeft: 6 }}>decoded</span>}</div>
              <div className="dt">Extrinsic</div><div className="dd">{extId ? <Link to={paths.extrinsic(extId)} className="hash mono">{extId}</Link> : <span className="muted mono">— system event</span>}</div>
              {/* A system event has no extrinsic, so its moment links to the block instead. */}
              <div className="dt">When</div><div className="dd mono"><MomentLink at={data} now={now} /> <FinalizedBadge finalized={data.blockHeight <= (stats?.finalizedBlock ?? -1)} /></div>
              <div className="dt">Phase</div><div className="dd mono">{data.phase}</div>
              {data.extrinsic && (
                <>
                  <div className="dt">Call</div><div className="dd"><CallPill name={data.extrinsic.callName} /></div>
                  {data.extrinsic.signer
                    ? <><div className="dt">Signer</div><div className="dd"><AddrPill account={data.extrinsic.signer} /></div></>
                    : null}
                  <div className="dt">Extrinsic result</div><div className="dd"><StatusBadge ok={data.extrinsic.success} /></div>
                </>
              )}
            </div></div>

            <div className="sec-title">Attributes</div>
            {data.evmDecoded ? <EvmLogView decoded={data.evmDecoded} /> : <ParamsTable args={args} />}
          </>
        )}
    </div>
  )
}
