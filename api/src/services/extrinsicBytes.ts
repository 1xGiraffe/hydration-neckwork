import { cached } from './cache.ts'
import { SUBSTRATE_RPC_URL } from './substrateRpc.ts'

// The authentic bytes of one extrinsic.
//
// The indexer stores extrinsics DECODED (call name plus args) and never keeps their
// SCALE bytes, so the encoded form has to come from the chain. It is fetched rather than
// re-encoded from the decoded args on purpose: re-encoding would have to reproduce the
// runtime's exact type layout from values this codebase has already normalised (bytes to
// hex, 128-bit integers to decimal strings), and bytes that are subtly wrong are worse
// than none — someone could submit them.
//
// One targeted call per extrinsic viewed, cached for an hour: an extrinsic's bytes are
// immutable once the block exists, so a second look never re-asks.
const RPC_TIMEOUT_MS = 8_000

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
  try {
    const res = await fetch(SUBSTRATE_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (!res.ok) return null
    const body = await res.json() as { result?: T; error?: unknown }
    return body.error != null ? null : (body.result ?? null)
  } catch { return null } finally { clearTimeout(timer) }
}

interface SignedBlock { block?: { extrinsics?: unknown } }

// Null rather than an error when the node cannot answer: the copy affordance simply does
// not appear, instead of offering bytes that are absent or wrong.
export async function extrinsicEncoded(blockHeight: number, extrinsicIndex: number): Promise<string | null> {
  return cached(`explorer:extrinsic-bytes:${blockHeight}:${extrinsicIndex}`, 3_600_000, async () => {
    const hash = await rpc<string>('chain_getBlockHash', [blockHeight])
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) return null
    const block = await rpc<SignedBlock>('chain_getBlock', [hash])
    const extrinsics = block?.block?.extrinsics
    if (!Array.isArray(extrinsics)) return null
    const value = extrinsics[extrinsicIndex]
    return typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? value : null
  })
}
