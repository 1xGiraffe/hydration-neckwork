// Pure reconstruction logic for the two on-behalf extrinsic projections:
//
//   proxy_call_activity        one row per Proxy.proxy / Proxy.proxy_announced
//                              call (any nesting depth), keyed by the proxied
//                              ("real") account
//   multisig_operation_activity one row per multisig OPERATION at its latest
//                              state (pending / executed / cancelled), keyed by
//                              the derived multisig account
//
// The derivation jobs in derivations/jobs.ts load deduplicated raw rows and
// feed them through these functions; keeping them pure lets the lifecycle
// walk and the call-tree matching be unit-tested without ClickHouse.

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

export interface ProxyCallSource {
  block: number
  extrinsic: number
  callAddress: string
  ts: number // unix seconds
  proxyCallName: string // 'Proxy.proxy' | 'Proxy.proxy_announced'
  realAccount: string // lowercase 0x-hex pubkey from args_json.real
}

export interface ExtrinsicCallRow {
  block: number
  extrinsic: number
  callAddress: string
  callName: string
  success: number | null
}

export interface ProxyCallActivityRow {
  real_account: string
  block_height: number
  extrinsic_index: number
  call_address: string
  block_timestamp: number // unix seconds; job converts on insert
  proxy_call_name: string
  inner_call_name: string // '' = inner call never dispatched (e.g. failed extrinsic)
  inner_success: number | null
  run_id: number
}

export function buildProxyCallRows(proxies: ProxyCallSource[], calls: ExtrinsicCallRow[], runId: number): ProxyCallActivityRow[] {
  const byAddress = new Map<string, ExtrinsicCallRow>()
  for (const c of calls) byAddress.set(`${c.block}:${c.extrinsic}:${c.callAddress}`, c)
  const rows: ProxyCallActivityRow[] = []
  for (const p of proxies) {
    if (!ACCOUNT_RE.test(p.realAccount)) continue
    const child = byAddress.get(`${p.block}:${p.extrinsic}:${proxyChildAddress(p.callAddress)}`)
    rows.push({
      real_account: p.realAccount,
      block_height: p.block,
      extrinsic_index: p.extrinsic,
      call_address: p.callAddress,
      block_timestamp: p.ts,
      proxy_call_name: p.proxyCallName,
      inner_call_name: child?.callName ?? '',
      inner_success: child?.success ?? null,
      run_id: runId,
    })
  }
  return rows
}

// ─────────────────────── multisig_operation_activity ───────────────────────

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
  anchor_block_height: number
  anchor_extrinsic_index: number
  anchor_timestamp: number
  inner_call_name: string // '' = only the call hash is known
  inner_success: number | null // dispatch result when executed; null otherwise
  run_id: number
}

interface OpState {
  row: MultisigOperationRow
  // extrinsics this op's events touched, with the acting signatory — the
  // derive-check needs the actor paired with each candidate extrinsic.
  touchpoints: { block: number; extrinsic: number; actor: string }[]
}

export function buildMultisigOperations(events: MultisigLifecycleEvent[], calls: MultisigCallInfo[], runId: number): MultisigOperationRow[] {
  const callsByExtrinsic = new Map<string, MultisigCallInfo[]>()
  for (const c of calls) {
    const key = `${c.block}:${c.extrinsic}`
    const list = callsByExtrinsic.get(key) ?? []
    list.push(c)
    callsByExtrinsic.set(key, list)
  }

  const ops = new Map<string, OpState>()
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
          anchor_block_height: ev.kind === 'new' ? ev.block : tpH,
          anchor_extrinsic_index: ev.kind === 'new' ? ev.extrinsic : tpI,
          anchor_timestamp: ev.ts,
          inner_call_name: '', inner_success: null, run_id: runId,
        },
        touchpoints: [],
      }
      ops.set(key, op)
    }
    op.touchpoints.push({ block: ev.block, extrinsic: ev.extrinsic, actor: ev.actor })
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

  // Attach call-derived facts (threshold, member count, inner call). A call
  // belongs to an op only when createKeyMulti over {event actor} ∪
  // otherSignatories at the call's threshold reproduces the op's multisig —
  // the same authoritative pairing refreshMultisigs uses. Anchor extrinsic
  // first so the executing as_multi (which carries the call body) wins.
  for (const op of ops.values()) {
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

  // as_multi_threshold_1 dispatches immediately and emits no Multisig events —
  // each call is its own executed operation, addressed via createKeyMulti at
  // threshold 1. The runtime call hash is not recomputable from decoded JSON;
  // the inner call name is always known (the child was dispatched), so the
  // hash stays empty.
  const rows = [...ops.values()].map(o => o.row)
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
      anchor_block_height: c.block, anchor_extrinsic_index: c.extrinsic, anchor_timestamp: c.ts,
      inner_call_name: c.innerCallName ?? '',
      inner_success: c.innerSuccess ?? c.callSuccess ?? null,
      run_id: runId,
    })
  }
  return rows
}
