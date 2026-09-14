import { cachedFound } from './cache.ts'
import { rpc } from './substrateRpc.ts'

// The authentic bytes of one extrinsic.
//
// The indexer stores extrinsics DECODED (call name plus args) and never keeps their
// SCALE bytes, so the encoded form has to come from the chain. It is fetched rather than
// re-encoded from the decoded args on purpose: re-encoding would have to reproduce the
// runtime's exact type layout from values this codebase has already normalised (bytes to
// hex, 128-bit integers to decimal strings), and bytes that are subtly wrong are worse
// than none — someone could submit them.
//
// One targeted call per extrinsic viewed, and the ANSWER is cached for an hour: an
// extrinsic's bytes are immutable once the block exists, so a second look never re-asks.
// A null is never cached — an RPC timeout, or a block the node has not caught up to, must
// not silence the copy affordance for the rest of the hour after the node recovers.

interface SignedBlock { block?: { extrinsics?: unknown } }

// Null rather than an error when the node cannot answer: the copy affordance simply does
// not appear, instead of offering bytes that are absent or wrong.
export async function extrinsicEncoded(blockHeight: number, extrinsicIndex: number): Promise<string | null> {
  return cachedFound(`explorer:extrinsic-bytes:${blockHeight}:${extrinsicIndex}`, 3_600_000, async () => {
    const hash = await rpc<string>('chain_getBlockHash', [blockHeight])
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) return null
    const block = await rpc<SignedBlock>('chain_getBlock', [hash])
    const extrinsics = block?.block?.extrinsics
    if (!Array.isArray(extrinsics)) return null
    const value = extrinsics[extrinsicIndex]
    return typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? value : null
  })
}
