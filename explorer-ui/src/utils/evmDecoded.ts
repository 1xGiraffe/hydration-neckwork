import type { EvmDecodedParam } from '../types'

// The transaction an `Ethereum.transact` extrinsic submitted, as its call args
// carry it: `{transaction: {__kind: 'Legacy' | 'EIP1559', value: {nonce, gasLimit,
// value, …}}}`. Raw integers stay strings — a wei-scale gas price must not be
// routed through a JS number.
export interface EvmTransactionEnvelope {
  kind: string | null
  nonce: string | null
  value: string | null
  gasLimit: string | null
  // The price the sender signed, WITH the field it came from: `gasPrice` on a
  // Legacy transaction is the price paid, `maxFeePerGas` on an EIP1559 one is only
  // a ceiling, so a surface may not present the two alike.
  gasPrice: { field: 'gasPrice' | 'maxFeePerGas'; value: string } | null
}

// A non-negative integer field, tolerating either the string form the indexer
// normalises 128-bit values to or a plain JSON number.
function intField(o: Record<string, unknown>, key: string): string | null {
  const v = o[key]
  if (typeof v === 'string' && /^\d+$/.test(v)) return v
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v)
  return null
}

export function evmTransactionEnvelope(callArgs: unknown): EvmTransactionEnvelope | null {
  if (callArgs == null || typeof callArgs !== 'object') return null
  const tx = (callArgs as Record<string, unknown>).transaction
  if (tx == null || typeof tx !== 'object') return null
  const outer = tx as Record<string, unknown>
  const inner = (outer.value != null && typeof outer.value === 'object' ? outer.value : {}) as Record<string, unknown>
  const maxFee = intField(inner, 'maxFeePerGas')
  const gasPrice = intField(inner, 'gasPrice')
  return {
    kind: typeof outer.__kind === 'string' ? outer.__kind : null,
    nonce: intField(inner, 'nonce'),
    value: intField(inner, 'value'),
    gasLimit: intField(inner, 'gasLimit'),
    gasPrice: gasPrice != null ? { field: 'gasPrice', value: gasPrice }
      : maxFee != null ? { field: 'maxFeePerGas', value: maxFee }
      : null,
  }
}

// ParamsTable keys a Record, so duplicate or empty ABI names get positional
// suffixes rather than silently overwriting one another. A hashed indexed
// param is labelled as such — the preimage only exists on chain as its hash.
export function decodedParamsRecord(params: EvmDecodedParam[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  params.forEach((p, i) => {
    let key = p.name || `arg${i}`
    if (key in out) key = `${key}#${i}`
    out[key] = p.hashed && typeof p.value === 'string' ? `${p.value} (indexed hash)` : p.value
  })
  return out
}
