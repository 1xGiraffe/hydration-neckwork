// Pure reconstruction logic for the two on-behalf extrinsic surfaces,
// reused at request time from MV-fed tables (no more derivation jobs):
//
//   proxy_call_activity        one row per Proxy.proxy / Proxy.proxy_announced
//                              call (any nesting depth), keyed by the proxied
//                              ("real") account. The MV records the call row
//                              itself; the dispatched child's name/success is
//                              resolved per request via resolveProxyInner,
//                              bounded to the page's candidate anchors.
//   multisig operations        reconstructed per request from an account's
//                              multisig_event_activity rows via
//                              buildMultisigOperations, then enriched with
//                              call-derived facts (threshold, member count,
//                              inner call) via enrichMultisigOperations,
//                              bounded to the page's candidates. as_multi_
//                              threshold_1 calls (no lifecycle events) are
//                              synthesized separately by threshold1Operations
//                              from a snapshot refreshed alongside the shared
//                              proxy/multisig directory.
//
// Keeping this pure lets the lifecycle walk and the call-tree matching be
// unit-tested without ClickHouse.

import { deriveMultisigAccountId } from './proxyMultisigService.ts'

const ACCOUNT_RE = /^0x[0-9a-f]{64}$/

// SQD call addresses form a path tree: the extrinsic's top call is 'root',
// its children are '0', '1', …, and children of a non-root call A are 'A.0',
// 'A.1', …. Proxy.proxy and Multisig.as_multi wrap exactly one inner call, so
// the dispatched child (when it exists — child rows are only recorded for
// dispatched calls) always sits at index 0 under the wrapper.
export function proxyChildAddress(callAddress: string): string {
  return callAddress === 'root' ? '0' : `${callAddress}.0`
}

// ───────────────────────── proxy_call_activity ─────────────────────────

export interface ExtrinsicCallRow {
  block: number
  extrinsic: number
  callAddress: string
  callName: string
  success: number | null
}

export interface ProxyInnerInfo {
  innerCallName: string
  innerSuccess: number | null
}

export function resolveProxyInner(
  anchors: { block: number; extrinsic: number; callAddress: string }[],
  calls: ExtrinsicCallRow[],
): Map<string, ProxyInnerInfo> {
  const byAddress = new Map<string, ExtrinsicCallRow>()
  for (const c of calls) byAddress.set(`${c.block}:${c.extrinsic}:${c.callAddress}`, c)
  const result = new Map<string, ProxyInnerInfo>()
  for (const a of anchors) {
    const child = byAddress.get(`${a.block}:${a.extrinsic}:${proxyChildAddress(a.callAddress)}`)
    if (!child) continue
    result.set(`${a.block}:${a.extrinsic}:${a.callAddress}`, { innerCallName: child.callName, innerSuccess: child.success })
  }
  return result
}

// ─────────────────────── multisig operations ───────────────────────

export interface MultisigLifecycleEvent {
  kind: 'new' | 'approval' | 'executed' | 'cancelled'
  multisig: string
  callHash: string
  // Operation timepoint (the NewMultisig's block/extrinsic position). null on
  // 'new' events — their own position IS the timepoint.
  timepointHeight: number | null
  timepointIndex: number | null
  actor: string // approving / cancelling signatory
  block: number
  extrinsic: number
  eventIndex: number
  ts: number
  ok: boolean | null // 'executed' only: result.__kind === 'Ok'
}

export interface MultisigCallInfo {
  block: number
  extrinsic: number
  callAddress: string
  callName: string // Multisig.as_multi | approve_as_multi | as_multi_threshold_1 | cancel_as_multi
  threshold: number | null // from args; null on as_multi_threshold_1 (implicit 1)
  otherSignatories: string[]
  originAccount: string | null // signed origin of the call; extrinsic signer as fallback
  callSuccess: number | null
  innerCallName: string | null // dispatched child call, when present
  innerSuccess: number | null
  ts: number
}

export type MultisigTimelineAction = 'initiated' | 'approved' | 'executed' | 'cancelled'

export interface MultisigOperationRow {
  multisig: string
  call_hash: string
  timepoint_height: number
  timepoint_index: number
  state: 'pending' | 'executed' | 'cancelled'
  threshold: number // 0 = unknown (no call matched the derive-check)
  signatories: number // total member count; 0 = unknown
  approvals: number
  actor: string // initiator while pending; executor / canceller when terminal
  initiator: string // signatory whose NewMultisig created the operation ('' if never seen)
  timeline_actors: string[] // chronological, parallel with timeline_actions/timeline_ts
  timeline_actions: MultisigTimelineAction[]
  timeline_ts: number[]
  timeline_blocks: number[]
  timeline_extrinsics: number[]
  anchor_block_height: number
  anchor_extrinsic_index: number
  anchor_timestamp: number
  inner_call_name: string // '' = only the call hash is known
  inner_success: number | null // dispatch result when executed; null otherwise
}

export interface MultisigOperationState {
  row: MultisigOperationRow
  // extrinsics this op's events touched, with the acting signatory — the
  // derive-check needs the actor paired with each candidate extrinsic.
  touchpoints: { block: number; extrinsic: number; actor: string }[]
}

export function buildMultisigOperations(events: MultisigLifecycleEvent[]): MultisigOperationState[] {
  const ops = new Map<string, MultisigOperationState>()
  const sorted = [...events].sort((a, b) => a.block - b.block || a.eventIndex - b.eventIndex)
  for (const ev of sorted) {
    const tpH = ev.kind === 'new' ? ev.block : ev.timepointHeight
    const tpI = ev.kind === 'new' ? ev.extrinsic : ev.timepointIndex
    if (tpH == null || tpI == null) continue // malformed event — no operation identity
    const key = `${ev.multisig}:${ev.callHash}:${tpH}:${tpI}`
    let op = ops.get(key)
    if (!op) {
      op = {
        row: {
          multisig: ev.multisig, call_hash: ev.callHash,
          timepoint_height: tpH, timepoint_index: tpI,
          state: 'pending', threshold: 0, signatories: 0, approvals: 0,
          actor: ev.actor,
          initiator: ev.kind === 'new' ? ev.actor : '',
          timeline_actors: [], timeline_actions: [], timeline_ts: [],
          timeline_blocks: [], timeline_extrinsics: [],
          anchor_block_height: ev.kind === 'new' ? ev.block : tpH,
          anchor_extrinsic_index: ev.kind === 'new' ? ev.extrinsic : tpI,
          anchor_timestamp: ev.ts,
          inner_call_name: '', inner_success: null,
        },
        touchpoints: [],
      }
      ops.set(key, op)
    }
    op.touchpoints.push({ block: ev.block, extrinsic: ev.extrinsic, actor: ev.actor })
    if (!op.row.initiator && ev.kind === 'new') op.row.initiator = ev.actor
    op.row.timeline_actors.push(ev.actor)
    op.row.timeline_actions.push(ev.kind === 'new' ? 'initiated' : ev.kind === 'approval' ? 'approved' : ev.kind)
    op.row.timeline_ts.push(ev.ts)
    op.row.timeline_blocks.push(ev.block)
    op.row.timeline_extrinsics.push(ev.extrinsic)
    if (ev.kind === 'new' || ev.kind === 'approval' || ev.kind === 'executed') op.row.approvals += 1
    if (ev.kind === 'executed') {
      op.row.state = 'executed'
      op.row.actor = ev.actor
      op.row.anchor_block_height = ev.block
      op.row.anchor_extrinsic_index = ev.extrinsic
      op.row.anchor_timestamp = ev.ts
      op.row.inner_success = ev.ok == null ? null : ev.ok ? 1 : 0
    } else if (ev.kind === 'cancelled') {
      op.row.state = 'cancelled'
      op.row.actor = ev.actor
      op.row.anchor_block_height = ev.block
      op.row.anchor_extrinsic_index = ev.extrinsic
      op.row.anchor_timestamp = ev.ts
    }
  }

  return [...ops.values()]
}

// Attach call-derived facts (threshold, member count, inner call). A call
// belongs to an op only when createKeyMulti over {event actor} ∪
// otherSignatories at the call's threshold reproduces the op's multisig —
// the same authoritative pairing refreshMultisigs uses. Anchor extrinsic
// first so the executing as_multi (which carries the call body) wins.
export function enrichMultisigOperations(states: MultisigOperationState[], calls: MultisigCallInfo[]): void {
  const callsByExtrinsic = new Map<string, MultisigCallInfo[]>()
  for (const c of calls) {
    const key = `${c.block}:${c.extrinsic}`
    const list = callsByExtrinsic.get(key) ?? []
    list.push(c)
    callsByExtrinsic.set(key, list)
  }

  for (const op of states) {
    const candidates = [...op.touchpoints].sort((a, b) =>
      Number(b.block === op.row.anchor_block_height && b.extrinsic === op.row.anchor_extrinsic_index)
      - Number(a.block === op.row.anchor_block_height && a.extrinsic === op.row.anchor_extrinsic_index))
    for (const tp of candidates) {
      const inExtrinsic = callsByExtrinsic.get(`${tp.block}:${tp.extrinsic}`) ?? []
      const match = inExtrinsic.find(c => {
        const threshold = c.callName === 'Multisig.as_multi_threshold_1' ? 1 : c.threshold
        if (!threshold || threshold < 1) return false
        const signatories = [...new Set([tp.actor, ...c.otherSignatories])].sort()
        return signatories.length >= threshold && deriveMultisigAccountId(signatories, threshold) === op.row.multisig
      })
      if (!match) continue
      const threshold = match.callName === 'Multisig.as_multi_threshold_1' ? 1 : match.threshold!
      op.row.threshold = threshold
      op.row.signatories = new Set([tp.actor, ...match.otherSignatories]).size
      if (tp.block === op.row.anchor_block_height && tp.extrinsic === op.row.anchor_extrinsic_index && match.innerCallName) {
        op.row.inner_call_name = match.innerCallName
      }
      break
    }
  }
}

// as_multi_threshold_1 dispatches immediately and emits no Multisig events —
// each call is its own executed operation, addressed via createKeyMulti at
// threshold 1. The runtime call hash is not recomputable from decoded JSON;
// the inner call name is always known (the child was dispatched), so the
// hash stays empty.
export function threshold1Operations(calls: MultisigCallInfo[]): MultisigOperationRow[] {
  const rows: MultisigOperationRow[] = []
  for (const c of calls) {
    if (c.callName !== 'Multisig.as_multi_threshold_1') continue
    if (!c.originAccount || !ACCOUNT_RE.test(c.originAccount)) continue
    const signatories = [...new Set([c.originAccount, ...c.otherSignatories])].sort()
    rows.push({
      multisig: deriveMultisigAccountId(signatories, 1),
      call_hash: '',
      timepoint_height: c.block, timepoint_index: c.extrinsic,
      state: 'executed', threshold: 1, signatories: signatories.length, approvals: 1,
      actor: c.originAccount,
      initiator: c.originAccount,
      timeline_actors: [c.originAccount], timeline_actions: ['executed'], timeline_ts: [c.ts],
      timeline_blocks: [c.block], timeline_extrinsics: [c.extrinsic],
      anchor_block_height: c.block, anchor_extrinsic_index: c.extrinsic, anchor_timestamp: c.ts,
      inner_call_name: c.innerCallName ?? '',
      inner_success: c.innerSuccess ?? c.callSuccess ?? null,
    })
  }
  return rows
}
