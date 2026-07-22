import { useEffect } from 'react'
import { useBlockActivity, useExtrinsic, useStats } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, redirect, ACTIVITY_SLUG_TAB, type ActivitySlug } from '../router'
import { activityLabel, canonicalTarget, parseId, SLUG_TYPES, ActivityDesc, ChainBadge, ExternalAccountPill, explorerSiteName } from '../components/ActivityTable'
import { Crumbs, F, AddrPill, AssetChip, StatusBadge, FinalizedBadge, CallPill, SkeletonRows } from '../components/ui'

export function ActivityDetailPage({ slug, id }: { slug: ActivitySlug; id: string }) {
  const label = activityLabel(slug)
  useDocumentTitle(`${label} ${id}`)
  const ref = parseId(id)
  const { data: rows, isLoading, isError } = useBlockActivity(ref?.height ?? null)
  const row = rows?.find(r =>
    SLUG_TYPES[slug].includes(r.type)
    && (ref!.eventIndex != null ? r.eventIndex === ref!.eventIndex : r.extrinsicIndex === ref!.extrinsicIndex))
  const extId = row?.extrinsicIndex != null ? `${row.blockHeight}-${row.extrinsicIndex}` : null
  const { data: ext } = useExtrinsic(extId)
  const { data: stats } = useStats(!!row)

  // Canonicalize slug and id form once the row is known (replaceState — links
  // survive reclassification, and extrinsic-form ids upgrade to event form).
  useEffect(() => {
    if (!row) return
    const target = canonicalTarget(row, slug, id)
    if (target) redirect(target)
  }, [row, slug, id])

  const eventId = row?.eventIndex != null ? `${row.blockHeight}-${row.eventIndex}` : null
  const voteSub = row?.type === 'vote' ? [row.voteSide, row.voteRef ? `Ref ${row.voteRef}` : null].filter(Boolean).join(' · ') : ''
  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Activity', to: `/activity?tab=${ACTIVITY_SLUG_TAB[slug]}` }, { label: id }]} />
        <div className="page-title">{label} <span className="num">{id}</span>
          {row?.type === 'xcm' && <span className="sub">{row.xcmDir === 'in' ? `in from ${row.fromChain ?? '?'}` : `out to ${row.destChain ?? '?'}`}</span>}
          {row?.type === 'mm' && row.mmMarket && <span className="sub">{row.mmMarket}</span>}
          {row?.type === 'staking' && row.stakingAction && <span className="sub">{row.stakingAction}</span>}
          {row?.type === 'vote' && voteSub && <span className="sub">{voteSub}</span>}
          {row?.type === 'otc' && row.otcOrderId != null && <span className="sub">order #{row.otcOrderId}</span>}
        </div>
      </div>

      {!ref ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Invalid activity id</div>
        : isError || (rows && !row) ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>No {label.toLowerCase()} activity found at {id}</div>
        : isLoading || !row ? <div className="detail-card"><SkeletonRows /></div> : (
          <div className="detail-card"><div className="dl">
            <div className="dt">Activity</div><div className="dd"><ActivityDesc r={row} /></div>
            <div className="dt">Value</div><div className="dd mono">{F.usd(row.valueUsd)}</div>
            {row.who && <><div className="dt">Account</div><div className="dd"><AddrPill account={row.who} /></div></>}
            {row.type === 'transfer' && row.to && <><div className="dt">To</div><div className="dd"><AddrPill account={row.to} /></div></>}
            {row.type === 'xcm' && row.xcmDir === 'in' && row.fromTxUrl && <><div className="dt">Origin transaction</div><div className="dd"><a className="ext-link" href={row.fromTxUrl} target="_blank" rel="noopener">{explorerSiteName(row.fromTxUrl)} ↗</a></div></>}
            {row.type === 'xcm' && row.xcmDir !== 'in' && row.destChain && <>
              <div className="dt">Destination</div><div className="dd"><ChainBadge chain={row.destChain} />{row.destAccount && <span style={{ marginLeft: 8 }}><ExternalAccountPill account={row.destAccount} /></span>}</div>
              {row.fromTxUrl && <><div className="dt">Origin transaction</div><div className="dd"><a className="ext-link" href={row.fromTxUrl} target="_blank" rel="noopener">{explorerSiteName(row.fromTxUrl)} ↗</a></div></>}
            </>}
            {row.type === 'xcm' && row.messageId && <><div className="dt">Message ID</div><div className="dd mono" style={{ overflowWrap: 'anywhere' }}>{row.messageId}</div></>}
            {row.type === 'xcm' && row.bridge && <><div className="dt">Bridge</div><div className="dd">{row.bridge}</div></>}
            {row.type === 'mm' && <><div className="dt">Action</div><div className="dd">{row.mmAction === 'ClaimRewards' ? 'Claim rewards' : row.mmAction ?? '—'}</div></>}
            {row.type === 'liquidity' && <><div className="dt">Action</div><div className="dd">{row.liqAction === 'Remove' ? 'Remove liquidity' : row.liqAction === 'Create' ? 'Create pool' : row.liqAction === 'Claim' ? 'Claim rewards' : 'Add liquidity'}</div></>}
            {row.type === 'staking' && <><div className="dt">Action</div><div className="dd">{row.stakingAction ?? '—'}</div></>}
            {row.type === 'vote' && <>
              {row.voteRef && <><div className="dt">Referendum</div><div className="dd mono">{row.voteRef}</div></>}
              <div className="dt">Side</div><div className="dd">{row.voteSide ?? '—'}{row.voteConviction ? <span className="muted" style={{ marginLeft: 8 }}>{row.voteConviction}</span> : null}</div>
            </>}
            {row.type === 'otc' && <>
              <div className="dt">Order ID</div><div className="dd mono">#{row.otcOrderId}</div>
              <div className="dt">Action</div><div className="dd">{row.otcAction ?? '—'}</div>
              {row.otcAction === 'Place' && <><div className="dt">Partially fillable</div><div className="dd">{row.otcPartiallyFillable ? 'Yes' : 'No'}</div></>}
              {row.otcAction === 'Fill' && <><div className="dt">Partial fill</div><div className="dd">{row.otcPartial ? 'Yes' : 'No'}</div></>}
              {row.otcAction === 'Fill' && row.otcFee != null && row.assetOut && <><div className="dt">Fee</div><div className="dd mono">{F.exact(row.otcFee, row.assetOut.decimals)} <AssetChip asset={row.assetOut} /></div></>}
            </>}
            {row.dca && row.dcaStatus === 'failed' && <><div className="dt">Result</div><div className="dd"><StatusBadge ok={false} /></div></>}
            <div className="dt">Timestamp</div><div className="dd mono">{F.datetime(row.timestamp)}</div>
            <div className="dt">Block</div><div className="dd mono"><Link to={paths.block(row.blockHeight)} className="hash">{F.int(row.blockHeight)}</Link> <FinalizedBadge finalized={row.blockHeight <= (stats?.finalizedBlock ?? -1)} /></div>
            {extId && <><div className="dt">Extrinsic</div><div className="dd mono"><Link to={paths.extrinsic(extId)} className="hash">{extId}</Link></div></>}
            {eventId && <><div className="dt">Event</div><div className="dd mono"><Link to={paths.event(eventId)} className="hash">{eventId}</Link></div></>}
            {ext && <>
              <div className="dt">Call</div><div className="dd"><CallPill name={ext.callName} /></div>
              <div className="dt">Result</div><div className="dd"><StatusBadge ok={ext.success} /></div>
              {ext.fee && <><div className="dt">Fee</div><div className="dd mono">{F.exact(ext.fee, 12)} HDX</div></>}
            </>}
          </div></div>
        )}
    </div>
  )
}
