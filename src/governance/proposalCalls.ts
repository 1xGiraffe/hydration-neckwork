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

// Both pallets that store a proposal's bytes note them the same way, under different arg
// names: Preimage.note_preimage(bytes) for OpenGov, Democracy.note_preimage(encoded_
// proposal) for the referenda that predate the Preimage pallet. Each has an operational
// twin that differs only in its fee class.
const NOTE_PREIMAGE_PALLETS = new Set(['Preimage', 'Democracy'])
const NOTE_PREIMAGE_CALLS = new Set(['note_preimage', 'note_preimage_operational'])

function noteBytes(args: unknown): string | null {
  const o = args as { bytes?: unknown; encodedProposal?: unknown } | null
  if (typeof o?.bytes === 'string') return o.bytes
  return typeof o?.encodedProposal === 'string' ? o.encodedProposal : null
}

// Every preimage byte string one indexed call row offers, whether the call IS a
// note_preimage or merely WRAPS one.
//
// A preimage is usually noted by a plain note_preimage extrinsic, but it can also be
// batched — and for extrinsics the recovery pipeline re-ingested, the nested calls of a
// Utility.batch_all are not indexed as their own rows, only the batch itself. Referenda
// 34 and 62 are exactly that: their bytes exist nowhere but inside the batch's decoded
// args, which is why they had no proposal row at all. So the wrapper's args are walked at
// any depth for the same `{Preimage: {note_preimage, bytes}}` shape the call tree would
// have held.
export function preimageBytesFromCall(callName: string, args: unknown): string[] {
  const out: string[] = []
  const [pallet, call] = callName.split('.')
  if (NOTE_PREIMAGE_PALLETS.has(pallet) && NOTE_PREIMAGE_CALLS.has(call ?? '')) {
    const bytes = noteBytes(args)
    if (bytes) out.push(bytes)
  }
  collectNestedPreimageBytes(args, out)
  return out
}

function collectNestedPreimageBytes(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNestedPreimageBytes(item, out)
    return
  }
  if (value == null || typeof value !== 'object') return
  const node = value as Record<string, unknown>
  if (typeof node.__kind === 'string' && NOTE_PREIMAGE_PALLETS.has(node.__kind)) {
    const inner = node.value as Record<string, unknown> | undefined
    if (typeof inner?.__kind === 'string' && NOTE_PREIMAGE_CALLS.has(inner.__kind)) {
      const bytes = noteBytes(inner)
      if (bytes) { out.push(bytes); return }
    }
  }
  for (const item of Object.values(node)) collectNestedPreimageBytes(item, out)
}

// Which of the candidate byte strings IS the wanted preimage.
//
// A preimage's hash is its identity, so the answer is verified rather than assumed. One
// extrinsic can note SEVERAL preimages — 8 of the 620 Preimage.Noted events sit on such
// an extrinsic — and taking the first byte string found put a sibling proposal's call on
// referenda 33, 116, 167 and 339, which is worse than showing none.
export function selectPreimageBytes(candidates: string[], hash: string, digest: (bytes: string) => string): string | null {
  const wanted = hash.toLowerCase()
  for (const bytes of candidates) {
    if (!/^0x[0-9a-f]+$/i.test(bytes) || bytes.length <= 2) continue
    if (digest(bytes).toLowerCase() === wanted) return bytes
  }
  return null
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
