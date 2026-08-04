// Pure ABI-shape helpers, deliberately free of viem so the Read tab can render
// its function list without waiting on the lazy codec chunk (abiCodec.ts pulls
// viem; this file must never import it).

// One ABI entry as the verified-contract payload carries it. Structural rather
// than viem's Abi type so unvalidated JSON from the API can be narrowed cheaply.
export interface AbiParam {
  name?: string
  type: string
  components?: AbiParam[]
}
export interface AbiFunctionItem {
  type: string
  name: string
  stateMutability?: string
  inputs: AbiParam[]
  outputs: AbiParam[]
}

// The Read tab's function list: view/pure functions in ABI order.
export function readFunctions(abi: unknown): AbiFunctionItem[] {
  if (!Array.isArray(abi)) return []
  return abi.filter((item): item is AbiFunctionItem => {
    const f = item as AbiFunctionItem
    return !!f && f.type === 'function' && (f.stateMutability === 'view' || f.stateMutability === 'pure') && typeof f.name === 'string'
  }).map(f => ({ ...f, inputs: f.inputs ?? [], outputs: f.outputs ?? [] }))
}

// Human-readable signature for a function row header: `balanceOf(address)`.
export function functionSignature(fn: AbiFunctionItem): string {
  return `${fn.name}(${fn.inputs.map(i => i.type).join(', ')})`
}
