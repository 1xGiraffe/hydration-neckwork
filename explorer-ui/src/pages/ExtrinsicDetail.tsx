import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useEvmReceipt, useExtrinsic, useExtrinsicActivity, useStats } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, navigate, redirect } from '../router'
import { Crumbs, F, AddrPill, CallPill, FeeAmount, StatusBadge, MempoolResultBadge, FinalizedBadge, FailureReasonRow, Copy, CopyTextButton, JsonView, ParamsTable, SkeletonRows, AwaitingBlockCard } from '../components/ui'
import { blockOf } from '../utils/activityIds'
import { useAwaitingBlock } from '../hooks/useAwaitingBlock'
import { api } from '../api/explorer'
import { ActivityTable, PoolChip } from '../components/ActivityTable'
import { EvmCallCard, EvmLogView } from '../components/EvmDecoded'
import { evmTransactionEnvelope } from '../utils/evmDecoded'
import type { EvmTransactionFacts } from '../types'

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

// The Ethereum-native facts of an EVM transaction, on the extrinsic page that IS
// that transaction's page (the contract Transactions tab already links every
// transaction here, and a hash resolves to the same extrinsic id). The substrate
// `Extrinsic hash` row above stays exactly where it is: both hashes are real and
// name different things, so the page labels them rather than choosing.
//
// Gas is the one part nothing indexes, so it arrives from the receipt separately
// and the rows simply do not appear until it does — never a zero or a placeholder
// standing in for a number nobody has.
function EvmTxRows({ tx, callArgs }: { tx?: EvmTransactionFacts; callArgs: unknown }) {
  const { data: receipt } = useEvmReceipt(tx?.txHash)
  const envelope = evmTransactionEnvelope(callArgs)
  // Both gas rows live or die with the receipt: gas accounting is a single fact
  // about what the transaction cost, and stating the limit the sender signed while
  // the amount actually burned is unknown reads as an answer where there is none
  // (the limit is on the Parameters tab either way). Within the group, a node that
  // reports no effective price falls back to the ceiling the sender signed, labelled
  // as that — a Legacy `gasPrice` and an EIP1559 `maxFeePerGas` are not the same claim.
  const gasUsed = receipt?.gasUsed ?? null
  const gasLimit = receipt ? envelope?.gasLimit ?? null : null
  const usedShare = gasUsed != null && gasLimit != null && Number(gasLimit) > 0 ? Number(gasUsed) / Number(gasLimit) : null
  const gasPrice = receipt ? receipt.effectiveGasPrice ?? envelope?.gasPrice?.value ?? null : null
  const gasPriceSource = receipt?.effectiveGasPrice ? 'effective' : envelope?.gasPrice?.field ?? null
  return <>
    {tx && <>
      <div className="dt">EVM tx hash</div>
      <div className="dd mono wrap-anywhere">{tx.txHash} <Copy text={tx.txHash} /></div>
    </>}
    {envelope?.kind && <><div className="dt">Tx type</div><div className="dd mono">{envelope.kind}</div></>}
    {envelope?.nonce != null && <><div className="dt">Nonce</div><div className="dd mono">{F.preciseAmount(envelope.nonce, 0)}</div></>}
    {envelope?.value != null && <>
      <div className="dt">Value</div>
      {/* Named, not bare: the EVM's native currency here is WETH (asset 20, 18
          decimals), verified against every non-zero-value transaction in the
          chain's history — all 68 move currency 20 in exactly these raw units.
          An unlabelled figure reads as HDX, which is both the wrong asset and
          12-decimal, so the number would be misread by six orders of magnitude. */}
      <div className="dd mono" title={F.preciseAmount(envelope.value, 18)}>{F.amount(envelope.value, 18)} WETH</div>
    </>}
    {gasUsed != null && <>
      <div className="dt">Gas</div>
      <div className="dd mono">
        {F.preciseAmount(gasUsed, 0)}{gasLimit != null && <> / {F.preciseAmount(gasLimit, 0)}</>}
        {usedShare != null && <span className="muted"> · {F.share(usedShare)} of limit</span>}
      </div>
    </>}
    {gasPrice != null && <>
      <div className="dt">Gas price</div>
      <div className="dd mono">{F.preciseAmount(gasPrice, 0)} wei{gasPriceSource && <span className="muted"> · {gasPriceSource}</span>}</div>
    </>}
    {tx?.exitKind && <>
      <div className="dt">Exit</div>
      <div className="dd mono wrap-anywhere">
        {tx.exitKind}{tx.exitDetail && ` · ${tx.exitDetail}`}
        {/* Returned data — on a revert this is the reason the contract gave, which
            no other explorer surface carries. */}
        {tx.extraData && <> <span className="muted">returned</span> {tx.extraData} <Copy text={tx.extraData} /></>}
      </div>
    </>}
  </>
}

export function ExtrinsicDetail({ id }: { id: string }) {
  const { data, isLoading, isError, failureReason } = useExtrinsic(id)
  const awaiting = useAwaitingBlock(blockOf(id), isError || failureReason != null, failureReason)
  // A transaction still in the pool has no block coordinates — its hash stays
  // the page's identity, and the 2.5s pending poll below walks it through
  // pool → unfinalized → finalized in place, without a refresh.
  const inPool = data?.mempool === true
  // Prefer the resolved height-index id; while a 0x-hash id loads, show the short hash.
  useDocumentTitle(`Extrinsic ${data && !inPool ? `${data.blockHeight}-${data.index}` : id.startsWith('0x') ? F.shortAddr(id) : id}`)
  // "Next extrinsic" only asks whether index+1 exists in this block. Asking the
  // sibling directly answers it in ~1–3 kB and lands under the very query key that
  // page reads, so the arrow opens an already-loaded extrinsic; the block detail
  // this used to come from carries every extrinsic and event in the block (5–10 kB
  // compressed on a busy block) purely for that one chevron. A 404 on the block's
  // last extrinsic is the answer, and 4xx is never retried (see queryRetry).
  const next = useExtrinsic(data && !inPool ? `${data.blockHeight}-${data.index + 1}` : null)
  const { data: stats } = useStats(!!data)
  const activity = useExtrinsicActivity(id, !!data)
  const now = useNow()
  const [tab, setTab] = useState<'activity' | 'params' | 'events' | 'json'>('activity')

  useEffect(() => {
    // In the pool the 0-0 coordinates are placeholders, not an address — stay
    // on the hash URL until a block gives the extrinsic a real id.
    if (!data || data.mempool) return
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

      {awaiting ? <AwaitingBlockCard height={blockOf(id)} />
        : isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Extrinsic not found</div>
        : isLoading || !data ? <div className="detail-card"><SkeletonRows /></div> : (
          <>
            <div className="detail-card"><div className="dl">
              <div className="dt">Extrinsic ID</div><div className="dd mono">{inPool ? <span className="muted">not yet in a block</span> : <>{data.blockHeight}-{data.index}</>}</div>
              <div className="dt">Block</div><div className="dd mono">{inPool ? <PoolChip /> : <><Link to={paths.block(data.blockHeight)} className="hash">{F.int(data.blockHeight)}</Link> <FinalizedBadge finalized={data.finalized !== false && data.blockHeight <= (stats?.finalizedBlock ?? -1)} /></>}</div>
              <div className="dt">{inPool ? 'First seen' : 'Timestamp'}</div><div className="dd mono">{F.datetime(data.timestamp)}{inPool && <span className="muted"> · waiting {F.waiting(data.timestamp, now)}</span>}</div>
              <div className="dt">Extrinsic hash</div><div className="dd mono wrap-anywhere">{data.hash} <Copy text={data.hash} /></div>
              <div className="dt">Module / Call</div><div className="dd"><CallPill name={data.callName} /> {!inPool && <CallDataCopy height={data.blockHeight} index={data.index} />}</div>
              <div className="dt">Result</div><div className="dd">{inPool ? <MempoolResultBadge includability={data.includability} reason={data.unincludableReason} projected={data.projected} /> : <StatusBadge ok={data.success} />}</div>
              {/* A nonce can be spent once, so this transaction is finished:
                  the replacement is the one to watch, and it is one click away. */}
              {data.replacedBy && <>
                <div className="dt">Replaced by</div>
                <div className="dd mono wrap-anywhere">
                  <Link to={paths.extrinsic(data.replacedBy)} className="hash">{F.shortHash(data.replacedBy)}</Link>
                  <span className="muted"> · same nonce, so this one can no longer be included</span>
                </div>
              </>}
              {!data.success && data.errorReason && <FailureReasonRow reason={data.errorReason} />}
              {data.signer
                ? <><div className="dt">Signer</div><div className="dd"><AddrPill account={data.signer} /></div>
                  <div className="dt">Fee</div><div className="dd mono"><FeeAmount payment={data.feePayment} hdxRaw={data.fee} /></div>
                  <div className="dt">Tip</div><div className="dd mono"><FeeAmount payment={data.feePayment} hdxRaw={data.tip} part="tip" /></div></>
                : <><div className="dt">Type</div><div className="dd"><span className="badge pending" style={{ background: 'var(--panel)', color: 'var(--text-medium)' }}>Inherent</span></div></>}
              {data.callName === 'Ethereum.transact' && <EvmTxRows tx={data.evmTx} callArgs={data.callArgs} />}
            </div></div>

            <div className="tabs">
              <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Activity {activityRows.length > 0 && <span className="cnt">{activityRows.length}</span>}</button>
              <button className={tab === 'params' ? 'active' : ''} onClick={() => setTab('params')}>Parameters</button>
              <button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>{inPool ? 'Projected events' : 'Events'} <span className="cnt">{data.events.length}</span></button>
              <button className={tab === 'json' ? 'active' : ''} onClick={() => setTab('json')}>Raw JSON</button>
            </div>

            {tab === 'activity' && <ActivityTable rows={activityRows} now={now} loading={activity.isFetching && !activityRows.length} dcaExecutionLinks />}

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
                    <div className="ei">{inPool ? <span className="muted mono">{e.eventIndex}</span> : <Link to={paths.eventAt(data.blockHeight, e.eventIndex)} className="hash">{e.eventIndex}</Link>}</div>
                    <div className="ec">
                      <div className="row gap6">{inPool ? <CallPill name={e.name} /> : <Link to={paths.eventAt(data.blockHeight, e.eventIndex)} className="hash"><CallPill name={e.name} /></Link>}{e.decoded && <span className="badge" style={{ background: 'color-mix(in srgb, var(--neutral) 15%, transparent)', color: 'var(--neutral)' }}>decoded</span>}</div>
                      {e.evmDecoded
                        ? <EvmLogView decoded={e.evmDecoded} />
                        : e.args != null && typeof e.args === 'object' && Object.keys(e.args).length > 0 && <JsonView value={e.args} />}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'json' && (() => {
              const json = {
                block_height: data.blockHeight, extrinsic_index: data.index, extrinsic_hash: data.hash,
                call_name: data.callName, signer: data.signer?.address ?? null, success: data.success,
                fee: data.fee, tip: data.tip,
                // `fee`/`tip` are the HDX-equivalent the chain computed; this is what
                // was actually debited, when that was a different asset.
                ...(data.feePayment ? {
                  fee_asset: data.feePayment.asset.symbol,
                  fee_asset_id: data.feePayment.asset.assetId,
                  fee_paid: data.feePayment.amount,
                  tip_paid: data.feePayment.tipAmount,
                } : {}),
                call_args: data.callArgs,
              }
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
