import type { EvmDecodedParam } from '../types'

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
