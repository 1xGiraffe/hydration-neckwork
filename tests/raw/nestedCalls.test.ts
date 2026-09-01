import { describe, expect, it } from 'vitest'
import {
  DISPATCH_PRECOMPILE,
  hasDecomposedChildren,
  liftRuntimeCallEnum,
  synthesizeNestedCallRows,
  type DecodedRuntimeCall,
  type EvmExecution,
  type NestedCallSynthesisInput,
} from '../../src/raw/nestedCalls.js'
import type { RawCallRow } from '../../src/raw/types.js'

const H160 = '0xa58ab483a5606e752f327f1f3263ca08c405f255'
const EVM_ACCOUNT = '0x45544800a58ab483a5606e752f327f1f3263ca08c405f2550000000000000000'

const VOTE_CALL: DecodedRuntimeCall = {
  name: 'ConvictionVoting.vote',
  args: { pollIndex: 396, vote: { __kind: 'Standard', vote: 131, balance: '14121744475276197' } },
}

function callRow(overrides: Partial<RawCallRow>): RawCallRow {
  return {
    block_height: 13922399,
    block_timestamp: '2026-08-20 10:00:00',
    extrinsic_index: 2,
    call_address: 'root',
    parent_call_address: null,
    call_name: '',
    origin_json: null,
    args_json: '{}',
    success: 1,
    error_json: null,
    ingest_source: 'sqd',
    ...overrides,
  }
}

function transactRow(input: string, overrides: Partial<RawCallRow> = {}): RawCallRow {
  return callRow({
    call_name: 'Ethereum.transact',
    args_json: JSON.stringify({
      transaction: { __kind: 'Legacy', value: { nonce: '230', action: { __kind: 'Call', value: DISPATCH_PRECOMPILE }, input } },
    }),
    ...overrides,
  })
}

function permitRow(data: string, overrides: Partial<RawCallRow> = {}): RawCallRow {
  return callRow({
    call_name: 'MultiTransactionPayment.dispatch_permit',
    origin_json: JSON.stringify({ __kind: 'system', value: { __kind: 'Signed', value: '0xabc0' } }),
    args_json: JSON.stringify({ from: H160, to: DISPATCH_PRECOMPILE, data }),
    ...overrides,
  })
}

function run(rows: RawCallRow[], overrides: Partial<NestedCallSynthesisInput> = {}) {
  return synthesizeNestedCallRows({
    rows,
    evmExecutionByExtrinsic: new Map<number, EvmExecution>([[2, { from: H160, exitKind: 'Succeed' }]]),
    decodeCall: () => VOTE_CALL,
    ...overrides,
  })
}

describe('synthesizeNestedCallRows', () => {
  it('synthesizes the dispatched call of a permit at an identifiable address with the EVM signed origin', () => {
    const { rows, warnings } = run([permitRow('0x2400')])
    expect(warnings).toEqual([])
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.call_address).toBe('root.evm')
    expect(row.parent_call_address).toBe('root')
    expect(row.call_name).toBe('ConvictionVoting.vote')
    expect(row.success).toBe(1)
    expect(JSON.parse(row.origin_json!)).toEqual({ __kind: 'system', value: { __kind: 'Signed', value: EVM_ACCOUNT } })
    expect(JSON.parse(row.args_json)).toEqual(VOTE_CALL.args)
    // Replay safety: the address is deterministic, so a re-derived range replaces
    // the same (block, extrinsic, call_address) key instead of adding a sibling.
    expect(run([permitRow('0x2400')]).rows).toEqual(rows)
  })

  it('propagates the permit wrapper success to the inner call (the permit path surfaces inner failure)', () => {
    expect(run([permitRow('0x2400', { success: 0 })]).rows[0].success).toBe(0)
    expect(run([permitRow('0x2400', { success: null })]).rows[0].success).toBeNull()
  })

  it('gates an Ethereum.transact inner call on the EVM exit reason, not the extrinsic result', () => {
    const succeed = run([transactRow('0x2400')])
    expect(succeed.rows[0].success).toBe(1)
    expect(JSON.parse(succeed.rows[0].origin_json!).value.value).toBe(EVM_ACCOUNT)

    const reverted = run([transactRow('0x2400')], {
      evmExecutionByExtrinsic: new Map([[2, { from: H160, exitKind: 'Revert' }]]),
    })
    expect(reverted.rows[0].success).toBe(0)

    const unknown = run([transactRow('0x2400')], {
      evmExecutionByExtrinsic: new Map(),
    })
    expect(unknown.rows[0].success).toBeNull()
    expect(unknown.rows[0].origin_json).toBeNull()
  })

  it('does not synthesize for EVM calls that are not dispatch-precompile targets', () => {
    const plainEvm = callRow({
      call_name: 'Ethereum.transact',
      args_json: JSON.stringify({
        transaction: { __kind: 'Legacy', value: { action: { __kind: 'Call', value: '0x1b02e051683b5cfac5929c25e84adb26ecf87b38' }, input: '0x00' } },
      }),
    })
    const plainPermit = callRow({
      call_name: 'MultiTransactionPayment.dispatch_permit',
      args_json: JSON.stringify({ from: H160, to: '0x1b02e051683b5cfac5929c25e84adb26ecf87b38', data: '0x00' }),
    })
    const create = callRow({
      call_name: 'Ethereum.transact',
      args_json: JSON.stringify({ transaction: { __kind: 'Legacy', value: { action: { __kind: 'Create' }, input: '0x00' } } }),
    })
    expect(run([plainEvm, plainPermit, create]).rows).toEqual([])
  })

  it('lifts a Dispatcher inner call, keeping the origin only for origin-preserving wrappers', () => {
    const origin = JSON.stringify({ __kind: 'system', value: { __kind: 'Signed', value: '0xd2777e' } })
    const inner = { __kind: 'Router', value: { __kind: 'sell', assetIn: 5, assetOut: 0, amountIn: '10' } }

    const preserved = run([callRow({ call_name: 'Dispatcher.dispatch_with_extra_gas', origin_json: origin, args_json: JSON.stringify({ call: inner, extraGas: '100000' }) })])
    expect(preserved.rows).toHaveLength(1)
    expect(preserved.rows[0].call_address).toBe('root.inner')
    expect(preserved.rows[0].call_name).toBe('Router.sell')
    expect(preserved.rows[0].origin_json).toBe(origin)
    expect(preserved.rows[0].success).toBe(1)
    expect(JSON.parse(preserved.rows[0].args_json)).toEqual({ assetIn: 5, assetOut: 0, amountIn: '10' })

    // dispatch_as_* runs under an origin this module cannot know — explicit null.
    const treasury = run([callRow({ call_name: 'Dispatcher.dispatch_as_treasury', origin_json: origin, args_json: JSON.stringify({ call: inner }) })])
    expect(treasury.rows[0].origin_json).toBeNull()
  })

  it('expands an inner batch with per-item atomicity semantics', () => {
    const item = { __kind: 'ConvictionVoting', value: { __kind: 'vote', pollIndex: 7, vote: { __kind: 'Standard', vote: 129, balance: '5' } } }
    const batchOf = (kind: string) => ({ name: `Utility.${kind}`, args: { calls: [item, item] } })

    const atomic = run([permitRow('0x0d02')], { decodeCall: () => batchOf('batch_all') })
    expect(atomic.rows.map(r => [r.call_address, r.call_name, r.success])).toEqual([
      ['root.evm', 'Utility.batch_all', 1],
      ['root.evm.0', 'ConvictionVoting.vote', 1],
      ['root.evm.1', 'ConvictionVoting.vote', 1],
    ])
    expect(atomic.rows[1].parent_call_address).toBe('root.evm')
    // Batch items keep the dispatch origin.
    expect(JSON.parse(atomic.rows[1].origin_json!).value.value).toBe(EVM_ACCOUNT)

    // Non-atomic batches keep going (or stop) per item; without the per-item
    // events the outcome is explicitly unknown, never inherited.
    for (const kind of ['batch', 'force_batch']) {
      const loose = run([permitRow('0x0d00')], { decodeCall: () => batchOf(kind) })
      expect(loose.rows.map(r => r.success)).toEqual([1, null, null])
    }
  })

  it('marks an inner Proxy.proxy result unknown and re-attributes its origin to the real account', () => {
    const proxied = {
      name: 'Proxy.proxy',
      args: { real: { __kind: 'Id', value: '0xfeed' }, call: { __kind: 'ConvictionVoting', value: { __kind: 'remove_vote', index: 3 } } },
    }
    const { rows } = run([permitRow('0x2a00')], { decodeCall: () => proxied })
    expect(rows.map(r => [r.call_address, r.call_name])).toEqual([
      ['root.evm', 'Proxy.proxy'],
      ['root.evm.inner', 'ConvictionVoting.remove_vote'],
    ])
    expect(rows[1].success).toBeNull()
    expect(JSON.parse(rows[1].origin_json!).value.value).toBe('0xfeed')
  })

  it('synthesizes an EVM.call dispatch with explicitly unknown success', () => {
    const row = callRow({
      call_name: 'EVM.call',
      args_json: JSON.stringify({ source: H160, target: DISPATCH_PRECOMPILE, input: '0x2400', value: '0' }),
    })
    const { rows } = run([row])
    expect(rows).toHaveLength(1)
    expect(rows[0].call_address).toBe('root.evm')
    expect(rows[0].call_name).toBe('ConvictionVoting.vote')
    // pallet_evm reports the result only through its own events; the extrinsic
    // succeeds even when the call reverted, so the outcome is unknown, not 1.
    expect(rows[0].success).toBeNull()
    expect(JSON.parse(rows[0].origin_json!).value.value).toBe(EVM_ACCOUNT)
    expect(run([callRow({ call_name: 'EVM.call', args_json: JSON.stringify({ source: H160, target: DISPATCH_PRECOMPILE, input: '0x2400' }), success: 0 })]).rows[0].success).toBe(0)

    // An EVM.call nested inside a Dispatcher expands one level deeper.
    const dispatcher = callRow({
      call_name: 'Dispatcher.dispatch_evm_call',
      args_json: JSON.stringify({ call: { __kind: 'EVM', value: { __kind: 'call', source: H160, target: DISPATCH_PRECOMPILE, input: '0x2400' } } }),
    })
    expect(run([dispatcher]).rows.map(r => [r.call_address, r.call_name])).toEqual([
      ['root.inner', 'EVM.call'],
      ['root.inner.evm', 'ConvictionVoting.vote'],
    ])
  })

  it('skips a wrapper the processor already decomposed, without disturbing other wrappers in the extrinsic', () => {
    const decomposedChild = callRow({ call_address: '0', call_name: 'ConvictionVoting.vote' })
    expect(run([permitRow('0x2400'), decomposedChild]).rows).toEqual([])

    // A decomposed batch child that is ITSELF an undecomposed wrapper still
    // synthesizes below its own address.
    const nestedPermit = permitRow('0x2400', { call_address: '1', parent_call_address: null })
    const batchRoot = callRow({ call_name: 'Utility.batch_all', args_json: '{"calls":[]}' })
    const { rows } = run([batchRoot, decomposedChild, nestedPermit])
    expect(rows.map(r => r.call_address)).toEqual(['1.evm'])
  })

  it('warns only when a successfully dispatched payload fails to decode', () => {
    const boom = () => { throw new Error('unexpected byte') }
    const succeeded = run([permitRow('0xffff')], { decodeCall: boom })
    expect(succeeded.rows).toEqual([])
    expect(succeeded.warnings).toHaveLength(1)
    expect(succeeded.warnings[0].warning_code).toBe('evm_dispatch_undecodable')
    expect(succeeded.warnings[0].parser).toBe('nested_calls')

    // A failed EVM execution with garbage calldata is noise, not a signal.
    const reverted = run([transactRow('0xffff')], {
      decodeCall: boom,
      evmExecutionByExtrinsic: new Map([[2, { from: H160, exitKind: 'Error' }]]),
    })
    expect(reverted.warnings).toEqual([])
  })

  it('never collides with processor addresses: every synthetic address contains a non-numeric segment', () => {
    const item = { __kind: 'Utility', value: { __kind: 'batch_all', calls: [{ __kind: 'ConvictionVoting', value: { __kind: 'vote', pollIndex: 1, vote: {} } }] } }
    const { rows } = run([permitRow('0x0d02')], { decodeCall: () => liftRuntimeCallEnum(item)! })
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(row.call_address.split('.').some(segment => !/^\d+$/.test(segment) && segment !== 'root')).toBe(true)
    }
  })
})

describe('hasDecomposedChildren', () => {
  it('detects children of root as single-segment addresses', () => {
    expect(hasDecomposedChildren(['root', '0'], 'root')).toBe(true)
    expect(hasDecomposedChildren(['root'], 'root')).toBe(false)
    // A grandchild alone does not make the root "decomposed" — but subsquid never
    // emits one without its parent, so the single-segment rule is the invariant.
    expect(hasDecomposedChildren(['root', '0.1'], 'root')).toBe(false)
  })

  it('detects children of a nested wrapper by address prefix', () => {
    expect(hasDecomposedChildren(['root', '0', '0.0'], '0')).toBe(true)
    expect(hasDecomposedChildren(['root', '0', '1'], '0')).toBe(false)
  })
})

describe('liftRuntimeCallEnum', () => {
  it('lifts pallet/call variant pairs into qualified names with named args', () => {
    expect(liftRuntimeCallEnum({ __kind: 'ConvictionVoting', value: { __kind: 'vote', pollIndex: 9 } }))
      .toEqual({ name: 'ConvictionVoting.vote', args: { pollIndex: 9 } })
    expect(liftRuntimeCallEnum({ __kind: 'System', value: { __kind: 'remark' } }))
      .toEqual({ name: 'System.remark', args: {} })
  })

  it('rejects shapes that are not a runtime call enum', () => {
    expect(liftRuntimeCallEnum(null)).toBeNull()
    expect(liftRuntimeCallEnum('0x00')).toBeNull()
    expect(liftRuntimeCallEnum({ __kind: 'ConvictionVoting' })).toBeNull()
    expect(liftRuntimeCallEnum({ value: { __kind: 'vote' } })).toBeNull()
  })
})
