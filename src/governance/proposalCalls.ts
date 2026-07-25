// Referendum proposal calls.
//
// A referendum's proposal is stored on chain as a preimage: the referendum names a
// hash, and the SCALE-encoded call lives in a Preimage.note_preimage extrinsic. The
// bytes are meaningless without runtime metadata, so decoding happens in the indexer
// (which has a Runtime) rather than in the API (which does not).
//
// Everything here is pure so the normalisation and the shape of the result can be
// tested without a chain connection; the RPC and the decoding live in
// src/scripts/decode-referendum-proposals.ts.

export interface DecodedProposalCall {
  pallet: string
  callName: string
  args: unknown
}

// A subsquid DecodedCall is { __kind: 'Pallet', value: { __kind: 'call_name', ...args } }.
// Flatten it into the pallet/call/args triple every consumer actually wants, keeping the
// arg names the runtime gave them.
export function flattenDecodedCall(decoded: unknown): DecodedProposalCall | null {
  if (!decoded || typeof decoded !== 'object') return null
  const outer = decoded as { __kind?: unknown; value?: unknown }
  if (typeof outer.__kind !== 'string') return null
  const pallet = outer.__kind
  const inner = outer.value
  if (!inner || typeof inner !== 'object') return { pallet, callName: '', args: {} }
  const { __kind: callName, ...args } = inner as { __kind?: unknown } & Record<string, unknown>
  return {
    pallet,
    callName: typeof callName === 'string' ? callName : '',
    args,
  }
}

// Decoded args arrive with Uint8Array/bigint values that JSON cannot carry, so they are
// normalised once here: bytes become 0x-hex, bigints become decimal strings (never
// numbers — a 128-bit balance would lose its low digits as a double).
export function jsonSafeArgs(value: unknown, depth = 0): unknown {
  if (depth > 12) return '…'
  if (value == null) return null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`
  if (Array.isArray(value)) return value.map(item => jsonSafeArgs(item, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = jsonSafeArgs(item, depth + 1)
    return out
  }
  return String(value)
}

// A referendum's proposal is only worth decoding once: the hash IS the content, so a
// hash already decoded never needs revisiting, and one preimage can back several
// referenda (or be noted twice, as ref 368's was at blocks 11,209,920 and 13,238,023).
export function proposalsNeedingDecode(
  wanted: { hash: string; notedBlock: number }[],
  decoded: Set<string>,
  max: number,
): { hash: string; notedBlock: number }[] {
  const seen = new Set<string>()
  const out: { hash: string; notedBlock: number }[] = []
  // Newest first: the referenda anyone is reading are the recent ones.
  for (const row of [...wanted].sort((a, b) => b.notedBlock - a.notedBlock)) {
    if (decoded.has(row.hash) || seen.has(row.hash)) continue
    seen.add(row.hash)
    out.push(row)
    if (out.length >= max) break
  }
  return out
}
