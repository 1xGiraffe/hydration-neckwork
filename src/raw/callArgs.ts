// ParachainSystem.set_validation_data is the relay-parent inherent every single
// block carries, and its decoded args are almost entirely the relay-chain storage
// proof: data.relayChainState.trieNodes measured 95.4% of the payload at block 2M,
// 97.6% at 10M and 96.9% at 13.3M, growing to ~95 KiB per block. That one call name
// is therefore 98.5-99.9% of every byte in raw_calls.args_json (474 GiB
// uncompressed, 31 GiB compressed) and, identically, of raw_extrinsics.call_args_json.
//
// The proof exists so a relay-chain validator can re-execute the candidate. It says
// nothing about Hydration that is not already indexed, no consumer in this
// repository reads it, and everything an explorer can render about the inherent —
// the relay parent header, the DMP/HRMP messages, the relay parent descendants, the
// collator peer id — lives in the other 3-5%. Storing it also made every unrelated
// read of raw_calls more expensive: a call_name predicate does not prune granules,
// so args_json was decompressed for every row of every granule a query touched.
//
// The proof is replaced rather than deleted, so a reader sees an explicit omission
// with the node count instead of having to guess whether the block carried a proof
// at all. This mirrors the args_omitted marker balance.ts writes for oversized
// account lists.
export const RELAY_PROOF_CALL_NAME = 'ParachainSystem.set_validation_data'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

// Returns args with the relay-chain storage proof replaced by a count marker, or
// the original reference when this is not the inherent or the proof is not where it
// is expected — a runtime upgrade that reshapes the call must fall through to
// storing the args verbatim rather than silently dropping something else. The copy
// is shallow along the touched path only: the same decoded args object is also read
// by the XCM extractor and the snapshot builder, so it must not be mutated.
export function withoutRelayChainProof(callName: string | null | undefined, args: unknown): unknown {
  if (callName !== RELAY_PROOF_CALL_NAME) return args
  const outer = asRecord(args)
  const data = asRecord(outer?.data)
  const relayChainState = asRecord(data?.relayChainState)
  const trieNodes = relayChainState?.trieNodes
  if (outer == null || data == null || relayChainState == null || !Array.isArray(trieNodes)) return args
  return {
    ...outer,
    data: {
      ...data,
      relayChainState: { trieNodeCount: trieNodes.length, trieNodesOmitted: true },
    },
  }
}
