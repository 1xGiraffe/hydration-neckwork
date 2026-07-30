import { describe, expect, it } from 'vitest'
import {
  proxyChildAddress,
  resolveProxyInner,
  buildMultisigOperations,
  enrichMultisigOperations,
  threshold1Operations,
  type ExtrinsicCallRow,
  type MultisigLifecycleEvent,
  type MultisigCallInfo,
} from '../src/services/onBehalfActivity.ts'
import { deriveMultisigAccountId } from '../src/services/proxyMultisigService.ts'

const SIG_A = `0x${'a1'.repeat(32)}`
const SIG_B = `0x${'b2'.repeat(32)}`
const SIG_C = `0x${'c3'.repeat(32)}`
// Authoritative multisig address for {SIG_A, SIG_B, SIG_C} @ threshold 2,
// exactly as the runtime derives it.
const MS_2OF3 = deriveMultisigAccountId([SIG_A, SIG_B, SIG_C].sort(), 2)
const HASH_1 = `0x${'11'.repeat(32)}`
const HASH_2 = `0x${'22'.repeat(32)}`

function call(over: Partial<ExtrinsicCallRow>): ExtrinsicCallRow {
  return { block: 100, extrinsic: 1, callAddress: '0', callName: 'Balances.transfer', success: 1, errorJson: null, ...over }
}
function msEvent(over: Partial<MultisigLifecycleEvent>): MultisigLifecycleEvent {
  return {
    kind: 'new', multisig: MS_2OF3, callHash: HASH_1, timepointHeight: null, timepointIndex: null,
    actor: SIG_A, block: 100, extrinsic: 2, eventIndex: 5, ts: 1000, ok: null, errorJson: null, ...over,
  }
}
function msCall(over: Partial<MultisigCallInfo>): MultisigCallInfo {
  return {
    block: 100, extrinsic: 2, callAddress: 'root', callName: 'Multisig.as_multi',
    threshold: 2, otherSignatories: [SIG_B, SIG_C], originAccount: SIG_A, callSuccess: 1,
    innerCallName: 'Omnipool.sell', innerSuccess: 1, innerErrorJson: null, ts: 1000, ...over,
  }
}

describe('proxyChildAddress', () => {
  it('maps root to 0 and nests dotted addresses', () => {
    expect(proxyChildAddress('root')).toBe('0')
    expect(proxyChildAddress('0')).toBe('0.0')
    expect(proxyChildAddress('1')).toBe('1.0')
    expect(proxyChildAddress('0.0')).toBe('0.0.0')
  })
})

describe('resolveProxyInner', () => {
  it('attaches the dispatched child call name and success', () => {
    const map = resolveProxyInner(
      [{ block: 100, extrinsic: 1, callAddress: 'root' }],
      [call({ callAddress: '0', callName: 'PolkadotXcm.transfer_assets', success: 1 })],
    )
    expect(map.get(`100:1:root`)).toEqual({ innerCallName: 'PolkadotXcm.transfer_assets', innerSuccess: 1, innerErrorJson: null })
  })

  it('attaches the dispatched child call error payload when the child failed', () => {
    const errorJson = '{"__kind":"Module","value":{"index":65,"error":"0x04000000"}}'
    const map = resolveProxyInner(
      [{ block: 100, extrinsic: 1, callAddress: 'root' }],
      [call({ callAddress: '0', callName: 'Omnipool.sell', success: 0, errorJson })],
    )
    expect(map.get(`100:1:root`)).toEqual({ innerCallName: 'Omnipool.sell', innerSuccess: 0, innerErrorJson: errorJson })
  })

  it('matches a batch-nested proxy to its own child, not the batch sibling', () => {
    const map = resolveProxyInner(
      [{ block: 100, extrinsic: 1, callAddress: '1' }],
      [
        call({ callAddress: '0', callName: 'System.remark' }),
        call({ callAddress: '1.0', callName: 'Omnipool.sell', success: 0 }),
      ],
    )
    expect(map.get(`100:1:1`)).toEqual({ innerCallName: 'Omnipool.sell', innerSuccess: 0, innerErrorJson: null })
  })

  it('has no entry when the inner call was never dispatched (failed extrinsic)', () => {
    const map = resolveProxyInner([{ block: 100, extrinsic: 1, callAddress: 'root' }], [])
    expect(map.has(`100:1:root`)).toBe(false)
  })
})

describe('buildMultisigOperations / enrichMultisigOperations', () => {
  it('reconstructs an initiate → approve → execute operation as one executed row', () => {
    const events = [
      msEvent({ kind: 'new', block: 100, extrinsic: 2, eventIndex: 5 }),
      msEvent({ kind: 'executed', actor: SIG_B, block: 110, extrinsic: 3, eventIndex: 9, ts: 1100, timepointHeight: 100, timepointIndex: 2, ok: true }),
    ]
    const calls = [
      msCall({ block: 100, extrinsic: 2, callName: 'Multisig.approve_as_multi', innerCallName: null, innerSuccess: null, originAccount: SIG_A }),
      msCall({ block: 110, extrinsic: 3, originAccount: SIG_B, otherSignatories: [SIG_A, SIG_C] }),
    ]
    const states = buildMultisigOperations(events)
    enrichMultisigOperations(states, calls)
    const [op] = states.map(s => s.row)
    expect(op).toMatchObject({
      multisig: MS_2OF3, call_hash: HASH_1, timepoint_height: 100, timepoint_index: 2,
      state: 'executed', threshold: 2, signatories: 3, approvals: 2, actor: SIG_B,
      anchor_block_height: 110, anchor_extrinsic_index: 3, anchor_timestamp: 1100,
      inner_call_name: 'Omnipool.sell', inner_success: 1, inner_error_json: null,
      initiator: SIG_A,
      timeline_actors: [SIG_A, SIG_B], timeline_actions: ['initiated', 'executed'], timeline_ts: [1000, 1100],
      timeline_blocks: [100, 110], timeline_extrinsics: [2, 3],
    })
  })

  it('records a failed inner dispatch from the executed event result', () => {
    const errorJson = '{"__kind":"Module","value":{"index":65,"error":"0x04000000"}}'
    const events = [
      msEvent({ kind: 'new' }),
      msEvent({ kind: 'executed', actor: SIG_B, block: 110, extrinsic: 3, eventIndex: 9, timepointHeight: 100, timepointIndex: 2, ok: false, errorJson }),
    ]
    const states = buildMultisigOperations(events)
    enrichMultisigOperations(states, [msCall({ block: 110, extrinsic: 3, originAccount: SIG_B, innerSuccess: 0 })])
    const [op] = states.map(s => s.row)
    expect(op.state).toBe('executed')
    expect(op.inner_success).toBe(0)
    expect(op.inner_error_json).toBe(errorJson)
  })

  it('keeps a not-yet-approved operation pending, anchored at the initiating extrinsic', () => {
    const events = [
      msEvent({ kind: 'new' }),
      msEvent({ kind: 'approval', actor: SIG_C, block: 105, extrinsic: 4, eventIndex: 2, timepointHeight: 100, timepointIndex: 2 }),
    ]
    const states = buildMultisigOperations(events)
    enrichMultisigOperations(states, [msCall({ threshold: 3, otherSignatories: [SIG_B, SIG_C] })])
    const [op] = states.map(s => s.row)
    expect(op).toMatchObject({
      state: 'pending', approvals: 2, actor: SIG_A, anchor_block_height: 100, anchor_extrinsic_index: 2,
      initiator: SIG_A, timeline_actions: ['initiated', 'approved'], timeline_actors: [SIG_A, SIG_C],
    })
    // threshold/signatories resolve only via the derive-check; {A,B,C}@3 is a
    // different address than MS_2OF3, so they stay unknown (0) here.
    expect(op.threshold).toBe(0)
  })

  it('marks a cancelled operation, anchored at the cancelling extrinsic', () => {
    const events = [
      msEvent({ kind: 'new' }),
      msEvent({ kind: 'cancelled', actor: SIG_A, block: 120, extrinsic: 6, eventIndex: 3, ts: 1200, timepointHeight: 100, timepointIndex: 2 }),
    ]
    const [op] = buildMultisigOperations(events).map(s => s.row)
    expect(op).toMatchObject({
      state: 'cancelled', actor: SIG_A, anchor_block_height: 120, anchor_extrinsic_index: 6, inner_success: null,
      initiator: SIG_A, timeline_actions: ['initiated', 'cancelled'],
    })
  })

  it('resolves threshold and member count via the createKeyMulti derive-check', () => {
    const events = [
      msEvent({ kind: 'new' }),
      msEvent({ kind: 'executed', actor: SIG_B, block: 110, extrinsic: 3, eventIndex: 9, timepointHeight: 100, timepointIndex: 2, ok: true }),
    ]
    // Same extrinsic also holds an unrelated multisig call (batch): wrong
    // signatory set → derive-check must skip it and match the right one.
    const calls = [
      msCall({ block: 110, extrinsic: 3, callAddress: '0', otherSignatories: [SIG_C], originAccount: SIG_B, innerCallName: 'System.remark' }),
      msCall({ block: 110, extrinsic: 3, callAddress: '1', otherSignatories: [SIG_A, SIG_C], originAccount: SIG_B }),
    ]
    const states = buildMultisigOperations(events)
    enrichMultisigOperations(states, calls)
    const [op] = states.map(s => s.row)
    expect(op.threshold).toBe(2)
    expect(op.signatories).toBe(3)
    expect(op.inner_call_name).toBe('Omnipool.sell')
  })

  it('treats the same call hash at a new timepoint as a distinct operation', () => {
    const events = [
      msEvent({ kind: 'new', block: 100, extrinsic: 2 }),
      msEvent({ kind: 'executed', actor: SIG_B, block: 110, extrinsic: 3, eventIndex: 9, timepointHeight: 100, timepointIndex: 2, ok: true }),
      msEvent({ kind: 'new', block: 200, extrinsic: 5, eventIndex: 1, ts: 2000 }),
    ]
    const ops = buildMultisigOperations(events).map(s => s.row)
    expect(ops).toHaveLength(2)
    expect(ops.map(o => o.state).sort()).toEqual(['executed', 'pending'])
  })

  it('conserves operations: initiated = executed + cancelled + pending', () => {
    const events = [
      msEvent({ kind: 'new', callHash: HASH_1, block: 100, extrinsic: 2 }),
      msEvent({ kind: 'executed', callHash: HASH_1, actor: SIG_B, block: 101, extrinsic: 1, eventIndex: 1, timepointHeight: 100, timepointIndex: 2, ok: true }),
      msEvent({ kind: 'new', callHash: HASH_2, block: 102, extrinsic: 3, eventIndex: 0 }),
      msEvent({ kind: 'cancelled', callHash: HASH_2, actor: SIG_A, block: 103, extrinsic: 1, eventIndex: 1, timepointHeight: 102, timepointIndex: 3 }),
      msEvent({ kind: 'new', callHash: `0x${'33'.repeat(32)}`, block: 104, extrinsic: 4, eventIndex: 0 }),
    ]
    const ops = buildMultisigOperations(events).map(s => s.row)
    const byState = { pending: 0, executed: 0, cancelled: 0 }
    for (const op of ops) byState[op.state]++
    expect(ops).toHaveLength(3)
    expect(byState).toEqual({ pending: 1, executed: 1, cancelled: 1 })
  })

  it('leaves initiator empty when the founding NewMultisig was never observed', () => {
    const events = [
      msEvent({ kind: 'approval', actor: SIG_C, block: 105, extrinsic: 4, eventIndex: 2, timepointHeight: 100, timepointIndex: 2 }),
      msEvent({ kind: 'executed', actor: SIG_B, block: 110, extrinsic: 3, eventIndex: 9, timepointHeight: 100, timepointIndex: 2, ok: true }),
    ]
    const [op] = buildMultisigOperations(events).map(s => s.row)
    expect(op.initiator).toBe('')
    expect(op.timeline_actions).toEqual(['approved', 'executed'])
  })
})

describe('threshold1Operations', () => {
  it('emits as_multi_threshold_1 dispatches as executed ops with a derived address', () => {
    const t1 = msCall({
      block: 300, extrinsic: 1, callName: 'Multisig.as_multi_threshold_1', threshold: null,
      otherSignatories: [SIG_B], originAccount: SIG_A, innerCallName: 'Proxy.proxy', innerSuccess: 1, ts: 3000,
    })
    const [op] = threshold1Operations([t1])
    expect(op).toMatchObject({
      multisig: deriveMultisigAccountId([SIG_A, SIG_B].sort(), 1),
      state: 'executed', threshold: 1, signatories: 2, approvals: 1,
      anchor_block_height: 300, anchor_extrinsic_index: 1, call_hash: '',
      inner_call_name: 'Proxy.proxy', inner_success: 1, inner_error_json: null,
      initiator: SIG_A, timeline_actors: [SIG_A], timeline_actions: ['executed'], timeline_ts: [3000],
      timeline_blocks: [300], timeline_extrinsics: [1],
    })
  })

  it('sets inner_error_json from the child call error payload when the inner dispatch failed', () => {
    const errorJson = '{"__kind":"Module","value":{"index":65,"error":"0x04000000"}}'
    const t1 = msCall({
      block: 300, extrinsic: 1, callName: 'Multisig.as_multi_threshold_1', threshold: null,
      otherSignatories: [SIG_B], originAccount: SIG_A, innerCallName: 'Omnipool.sell', innerSuccess: 0,
      innerErrorJson: errorJson, ts: 3000,
    })
    const [op] = threshold1Operations([t1])
    expect(op.inner_error_json).toBe(errorJson)
  })
})
