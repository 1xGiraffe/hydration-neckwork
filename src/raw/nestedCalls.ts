import { evmAccountForm, toJsonString } from './json.js'
import type { RawCallRow, RawParserWarningRow } from './types.js'

// Synthetic nested call rows for the wrappers the upstream processor does NOT
// decompose. Subsquid's call parser unwraps Utility batches, Proxy, Multisig and
// Sudo into their own `raw_calls` rows, but three Hydration-relevant wrappers keep
// their inner call invisible to every `call_name`-keyed read model:
//
//   - `Ethereum.transact` whose EVM action calls the dispatch precompile
//     (0x…0401) with a SCALE-encoded RuntimeCall as calldata,
//   - `MultiTransactionPayment.dispatch_permit` targeting the same precompile
//     (the Hydration app's gasless path — the dominant EVM-account channel),
//   - `Dispatcher.dispatch_*`, whose inner call is decoded JSON inside
//     `args_json` but never a row of its own.
//
// A ConvictionVoting.vote sent through any of these emits its normal events but
// produced no vote call row, so the voter was invisible on every account-level
// governance surface. Synthesizing the inner call as a real `raw_calls` row fixes
// every downstream consumer at once (the governance/evm/proxy/multisig MVs and
// all `call_name` filters), instead of teaching each reader about each wrapper.
//
// Invariants that keep the raw layer honest:
//   - Identifiable: synthetic rows carry a non-numeric address segment ('evm' for
//     calldata-decoded dispatches, 'inner' for calls lifted from decoded args).
//     Subsquid addresses are 'root' or dot-joined integers, so the namespaces
//     cannot collide and a replayed range replaces synthetic rows under the same
//     `(block_height, extrinsic_index, call_address)` key it wrote before.
//   - No double counting: a wrapper that already has decomposed child rows is
//     skipped, and the wrapper's own row is stored unchanged either way — the
//     synthetic row only ADDS the inner call under an address of its own.
//   - Honest success: an EVM dispatch reverts invisibly to the extrinsic
//     (`Ethereum.transact` stays successful while the inner call failed), so the
//     inner row's success comes from the Ethereum.Executed exit reason.
//     `dispatch_permit` propagates the inner dispatch error to the extrinsic
//     (verified: every successful permit vote has its Voted event), so there the
//     extrinsic's own success is the truth. Where per-item success is genuinely
//     unknowable (items of a non-atomic inner batch, an inner Proxy.proxy whose
//     result only its event knows), success is NULL — explicitly unknown, never
//     guessed.

export const DISPATCH_PRECOMPILE = '0x0000000000000000000000000000000000000401'

// The dispatched call in the same normalized-JSON convention `raw_calls` stores:
// enums as {__kind, …}, big integers as strings, bytes as 0x-hex.
export interface DecodedRuntimeCall {
  name: string
  args: unknown
}

export type RuntimeCallDecoder = (hex: string) => DecodedRuntimeCall

export interface EvmExecution {
  from: string | null
  exitKind: string | null
}

export interface NestedCallSynthesisInput {
  // Every raw_calls row of one block, as serialized for insertion.
  rows: RawCallRow[]
  // Ethereum.Executed per extrinsic: sender H160 and exitReason.__kind.
  evmExecutionByExtrinsic: Map<number, EvmExecution>
  // SCALE decoder bound to the block's own runtime.
  decodeCall: RuntimeCallDecoder
}

export interface NestedCallSynthesisResult {
  rows: RawCallRow[]
  warnings: RawParserWarningRow[]
}

// Wrappers whose inner call keeps the outer signed origin.
const ORIGIN_PRESERVING_DISPATCHER_CALLS = new Set([
  'Dispatcher.dispatch_with_extra_gas',
  'Dispatcher.dispatch_with_fee_payer',
])

const BATCH_CALLS = new Set(['Utility.batch', 'Utility.batch_all', 'Utility.force_batch'])

// Nesting inside a single extrinsic is shallow in practice (dispatch → batch →
// call); the bound stops a hand-crafted batch-of-batches from walking unbounded.
const MAX_SYNTHETIC_DEPTH = 8

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function signedOriginJson(accountId32: string | null): string | null {
  if (accountId32 == null) return null
  return toJsonString({ __kind: 'system', value: { __kind: 'Signed', value: accountId32 } })
}

// MultiAddress or plain AccountId32, as stored in normalized args.
function accountFromAddressArg(value: unknown): string | null {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  return record != null && typeof record.value === 'string' ? record.value : null
}

// {__kind: 'Pallet', value: {__kind: 'call', …args}} → {name, args}. FRAME call
// arguments are always named, so the args are the value object minus its variant
// tag; a no-argument call yields {}.
export function liftRuntimeCallEnum(node: unknown): DecodedRuntimeCall | null {
  const outer = asRecord(node)
  if (outer == null || typeof outer.__kind !== 'string') return null
  const inner = asRecord(outer.value)
  if (inner == null || typeof inner.__kind !== 'string') return null
  const { __kind, ...args } = inner
  return { name: `${outer.__kind}.${String(__kind)}`, args }
}

// True when subsquid already decomposed this wrapper: any same-extrinsic row whose
// address is a child of the wrapper's ('root' parents single-segment addresses,
// 'a.b' parents 'a.b.…').
export function hasDecomposedChildren(sameExtrinsicAddresses: string[], wrapperAddress: string): boolean {
  if (wrapperAddress === 'root') {
    return sameExtrinsicAddresses.some(address => address !== 'root' && !address.includes('.'))
  }
  const prefix = `${wrapperAddress}.`
  return sameExtrinsicAddresses.some(address => address.startsWith(prefix))
}

interface SyntheticNode {
  call: DecodedRuntimeCall
  address: string
  parentAddress: string
  originJson: string | null
  success: number | null
}

export function synthesizeNestedCallRows(input: NestedCallSynthesisInput): NestedCallSynthesisResult {
  const out: RawCallRow[] = []
  const warnings: RawParserWarningRow[] = []

  const addressesByExtrinsic = new Map<number, string[]>()
  for (const row of input.rows) {
    if (row.extrinsic_index == null) continue
    const list = addressesByExtrinsic.get(row.extrinsic_index)
    if (list == null) addressesByExtrinsic.set(row.extrinsic_index, [row.call_address])
    else list.push(row.call_address)
  }

  for (const row of input.rows) {
    if (row.extrinsic_index == null) continue
    const seed = dispatchedCallFromRow(row, input, warnings)
    if (seed == null) continue
    if (hasDecomposedChildren(addressesByExtrinsic.get(row.extrinsic_index) ?? [], row.call_address)) continue
    emitSubtree(seed, row, input, out, warnings, 0)
  }

  return { rows: out, warnings }
}

// The one call a top-level undecomposed wrapper row dispatches, or null when the
// row is not such a wrapper (or the dispatch target is not the precompile).
function dispatchedCallFromRow(
  row: RawCallRow,
  input: NestedCallSynthesisInput,
  warnings: RawParserWarningRow[],
): SyntheticNode | null {
  let args: Record<string, unknown> | null
  try {
    args = asRecord(JSON.parse(row.args_json))
  } catch {
    return null
  }
  if (args == null) return null

  if (row.call_name === 'Ethereum.transact') {
    const transaction = asRecord(asRecord(args.transaction)?.value)
    const action = asRecord(transaction?.action)
    if (action?.__kind !== 'Call' || typeof action.value !== 'string') return null
    if (action.value.toLowerCase() !== DISPATCH_PRECOMPILE) return null
    const inputHex = transaction?.input
    if (typeof inputHex !== 'string') return null
    const execution = input.evmExecutionByExtrinsic.get(row.extrinsic_index ?? -1)
    const success = row.success !== 1
      ? row.success
      : execution?.exitKind == null ? null : (execution.exitKind === 'Succeed' ? 1 : 0)
    const call = decodeOrWarn(inputHex, row, input, warnings, success === 1)
    if (call == null) return null
    return {
      call,
      address: `${row.call_address}.evm`,
      parentAddress: row.call_address,
      originJson: signedOriginJson(evmAccountForm(execution?.from ?? null)),
      success,
    }
  }

  if (row.call_name === 'MultiTransactionPayment.dispatch_permit') {
    if (typeof args.to !== 'string' || args.to.toLowerCase() !== DISPATCH_PRECOMPILE) return null
    if (typeof args.data !== 'string') return null
    // The permit path propagates the inner dispatch result to the extrinsic, so
    // the wrapper's own success is the inner call's.
    const call = decodeOrWarn(args.data, row, input, warnings, row.success === 1)
    if (call == null) return null
    return {
      call,
      address: `${row.call_address}.evm`,
      parentAddress: row.call_address,
      originJson: signedOriginJson(evmAccountForm(args.from)),
      success: row.success,
    }
  }

  if (row.call_name.startsWith('Dispatcher.')) {
    const call = liftRuntimeCallEnum(args.call)
    if (call == null) return null
    return {
      call,
      address: `${row.call_address}.inner`,
      parentAddress: row.call_address,
      // dispatch_as_* wrappers dispatch under a DIFFERENT origin (treasury, aave
      // manager, …) this module cannot know; explicit null beats a wrong account.
      originJson: ORIGIN_PRESERVING_DISPATCHER_CALLS.has(row.call_name) ? row.origin_json : null,
      success: row.success,
    }
  }

  if (row.call_name === 'EVM.call') {
    return evmCallDispatchNode(args, row.call_address, row.success, row, input, warnings)
  }

  return null
}

// The substrate EVM.call extrinsic aimed at the dispatch precompile — the same
// SCALE payload as the Ethereum.transact path, reached without an EVM transaction.
// pallet_evm reports the execution result only through its EVM.Executed/
// EVM.ExecutedFailed events (the extrinsic succeeds even when the call reverted),
// which this module does not read, so the inner outcome is explicitly unknown
// unless the extrinsic itself failed.
function evmCallDispatchNode(
  args: Record<string, unknown>,
  address: string,
  parentSuccess: number | null,
  wrapperRow: RawCallRow,
  input: NestedCallSynthesisInput,
  warnings: RawParserWarningRow[],
): SyntheticNode | null {
  if (typeof args.target !== 'string' || args.target.toLowerCase() !== DISPATCH_PRECOMPILE) return null
  if (typeof args.input !== 'string') return null
  const call = decodeOrWarn(args.input, wrapperRow, input, warnings, false)
  if (call == null) return null
  return {
    call,
    address: `${address}.evm`,
    parentAddress: address,
    originJson: signedOriginJson(evmAccountForm(args.source)),
    success: parentSuccess === 0 ? 0 : null,
  }
}

function decodeOrWarn(
  hex: string,
  row: RawCallRow,
  input: NestedCallSynthesisInput,
  warnings: RawParserWarningRow[],
  dispatchSucceeded: boolean,
): DecodedRuntimeCall | null {
  try {
    return input.decodeCall(hex)
  } catch (error) {
    // Arbitrary calldata can be sent at the precompile and fail in the EVM; that
    // is noise. Calldata the chain itself dispatched successfully but this module
    // cannot decode is a real signal (runtime-metadata mismatch), so it warns.
    if (dispatchSucceeded) {
      warnings.push({
        block_height: row.block_height,
        block_timestamp: row.block_timestamp,
        parser: 'nested_calls',
        source_kind: 'call',
        source_name: row.call_name,
        source_index: `${row.extrinsic_index ?? 'none'}:${row.call_address}`,
        warning_code: 'evm_dispatch_undecodable',
        warning: `successful dispatch-precompile call could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
        evidence_json: toJsonString({ call: row.call_name, data: hex }),
        ingest_source: row.ingest_source,
      })
    }
    return null
  }
}

function emitSubtree(
  node: SyntheticNode,
  wrapperRow: RawCallRow,
  input: NestedCallSynthesisInput,
  out: RawCallRow[],
  warnings: RawParserWarningRow[],
  depth: number,
): void {
  if (depth > MAX_SYNTHETIC_DEPTH) return
  out.push({
    block_height: wrapperRow.block_height,
    block_timestamp: wrapperRow.block_timestamp,
    extrinsic_index: wrapperRow.extrinsic_index,
    call_address: node.address,
    parent_call_address: node.parentAddress,
    call_name: node.call.name,
    origin_json: node.originJson,
    args_json: toJsonString(node.call.args ?? null),
    success: node.success,
    error_json: null,
    ingest_source: wrapperRow.ingest_source,
  })

  const args = asRecord(node.call.args)
  if (args == null) return

  if (BATCH_CALLS.has(node.call.name) && Array.isArray(args.calls)) {
    // batch_all is atomic — if the wrapper succeeded every item did. batch and
    // force_batch keep going (or stop) per item, and without their per-item
    // events the item outcome is unknowable here.
    const itemSuccess = node.call.name === 'Utility.batch_all' ? node.success : null
    args.calls.forEach((item, index) => {
      const call = liftRuntimeCallEnum(item)
      if (call == null) return
      emitSubtree(
        { call, address: `${node.address}.${index}`, parentAddress: node.address, originJson: node.originJson, success: itemSuccess },
        wrapperRow, input, out, warnings, depth + 1,
      )
    })
    return
  }

  if (node.call.name === 'Proxy.proxy' || node.call.name === 'Proxy.proxy_announced') {
    const call = liftRuntimeCallEnum(args.call)
    if (call == null) return
    // pallet_proxy returns Ok whatever the inner call did (the result lives on
    // the ProxyExecuted event), so the inner outcome is explicitly unknown.
    emitSubtree(
      { call, address: `${node.address}.inner`, parentAddress: node.address, originJson: signedOriginJson(accountFromAddressArg(args.real)), success: null },
      wrapperRow, input, out, warnings, depth + 1,
    )
    return
  }

  if (node.call.name === 'Utility.as_derivative') {
    const call = liftRuntimeCallEnum(args.call)
    if (call == null) return
    // The derivative sub-account origin is a hash this module does not derive.
    emitSubtree(
      { call, address: `${node.address}.inner`, parentAddress: node.address, originJson: null, success: node.success },
      wrapperRow, input, out, warnings, depth + 1,
    )
    return
  }

  if (node.call.name.startsWith('Dispatcher.')) {
    const call = liftRuntimeCallEnum(args.call)
    if (call == null) return
    emitSubtree(
      {
        call,
        address: `${node.address}.inner`,
        parentAddress: node.address,
        originJson: ORIGIN_PRESERVING_DISPATCHER_CALLS.has(node.call.name) ? node.originJson : null,
        success: node.success,
      },
      wrapperRow, input, out, warnings, depth + 1,
    )
    return
  }

  if (node.call.name === 'MultiTransactionPayment.dispatch_permit') {
    if (typeof args.to !== 'string' || args.to.toLowerCase() !== DISPATCH_PRECOMPILE) return
    if (typeof args.data !== 'string') return
    const call = decodeOrWarn(args.data, wrapperRow, input, warnings, node.success === 1)
    if (call == null) return
    emitSubtree(
      { call, address: `${node.address}.evm`, parentAddress: node.address, originJson: signedOriginJson(evmAccountForm(args.from)), success: node.success },
      wrapperRow, input, out, warnings, depth + 1,
    )
    return
  }

  if (node.call.name === 'EVM.call') {
    const child = evmCallDispatchNode(args, node.address, node.success, wrapperRow, input, warnings)
    if (child != null) emitSubtree(child, wrapperRow, input, out, warnings, depth + 1)
  }
}
