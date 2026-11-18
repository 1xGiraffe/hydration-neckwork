// The pure parts of the proposal wizard (/governance/propose): which track a call
// belongs on, what its preimage deposit is, whether the dry-run's new referendum is
// the one a batched decision deposit names, and the decoded call in the shape the
// referendum page's "What it does" and call tree read. No chain client and no React:
// the chain side is vote/proposeChain.ts, loaded only when a call is built.

export const ONE_HDX = 10n ** 12n

/**
 * Track id → the origin a referendum on it dispatches from: Root for track 0, else the
 * runtime's custom origin named by the track (`root` → System Root,
 * `treasurer` → Origins::Treasurer — the runtime's `track_for`, one origin per track).
 */
export function originOfTrack(name: string): { kind: 'root' } | { kind: 'origin'; name: string } {
  if (name === 'root') return { kind: 'root' }
  return { kind: 'origin', name: name.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('') }
}

/**
 * How much one treasury spend each origin may approve (the runtime's `Spender`
 * EnsureOrigin: Tipper 50,000 HDX, Spender 2,222,222 HDX, Treasurer 50,000,000 HDX;
 * Root has no limit). A spend above an origin's limit is refused when the referendum
 * is enacted, not when it is submitted.
 */
export const SPEND_LIMITS: { track: string; max: bigint | null }[] = [
  { track: 'tipper', max: 50_000n * ONE_HDX },
  { track: 'spender', max: 2_222_222n * ONE_HDX },
  { track: 'treasurer', max: 50_000_000n * ONE_HDX },
  { track: 'root', max: null },
]

/** The smallest track whose origin may approve a spend of this amount (planck). */
export function suggestSpendTrack(amount: bigint): string {
  return SPEND_LIMITS.find(l => l.max == null || amount <= l.max)!.track
}

/** Whether a track's origin may approve a spend of this amount; null for a track that cannot spend at all. */
export function trackCanSpend(track: string, amount: bigint): boolean | null {
  const l = SPEND_LIMITS.find(x => x.track === track)
  if (!l) return null
  return l.max == null || amount <= l.max
}

/**
 * The deposit noting a preimage holds (pallet-preimage's HoldConsideration priced by
 * the runtime's LinearStoragePrice: `deposit(2, 64)` base plus `deposit(0, 1)` per
 * byte — 401.92 HDX + 0.03 HDX a byte). Returned when the preimage is unnoted.
 */
export const PREIMAGE_BASE_DEPOSIT = 401_920_000_000_000n
export const PREIMAGE_BYTE_DEPOSIT = 30_000_000_000n
export function preimageDeposit(len: number): bigint {
  return PREIMAGE_BASE_DEPOSIT + PREIMAGE_BYTE_DEPOSIT * BigInt(Math.max(0, Math.floor(len)))
}

/** What noting the preimage holds now: nothing when it is stored, or already requested (the pallet takes no deposit for a requested preimage). */
export function depositToNote(len: number, status: { noted: boolean; requested: boolean }): bigint {
  return status.noted || status.requested ? 0n : preimageDeposit(len)
}

/** The referenda pallet's submission deposit (Referenda::SubmissionDeposit, 100 HDX). */
export const SUBMISSION_DEPOSIT = 100n * ONE_HDX

interface EventLike { pallet: string; name: string; data: unknown }

/** The index a run's Referenda.Submitted names, or null when it submitted nothing. */
export function submittedIndex(events: readonly EventLike[] | null | undefined): number | null {
  const e = (events ?? []).find(x => x.pallet === 'Referenda' && x.name === 'Submitted')
  const i = (e?.data as { index?: unknown } | null)?.index
  return i != null && Number.isInteger(Number(i)) ? Number(i) : null
}

// ---- the decoded call, in the api's shape ----

/** The referendum page's call shape (the api's decode of `referendum_proposals`). */
export interface ApiCall { pallet: string; callName: string; args: Record<string, unknown>; encoded: string | null; byteLength: number; decodeError: string | null }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array)

/** "SpendLocal" → "spend_local" (dedot names calls in PascalCase, the api in snake_case). */
export function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase()
}

function hexOfBytes(b: Uint8Array): string {
  return `0x${Array.from(b, x => x.toString(16).padStart(2, '0')).join('')}`
}

interface DedotCall { pallet: string; palletCall: string | { name: string; params?: Record<string, unknown> } }
const isDedotCall = (v: unknown): v is DedotCall => isRecord(v) && typeof v.pallet === 'string' && (typeof v.palletCall === 'string' || (isRecord(v.palletCall) && typeof v.palletCall.name === 'string'))

/**
 * A value as the api's decoder writes it: amounts as decimal strings, accounts as hex
 * (`accountHex` turns an SS58 address into its account id, null for anything else),
 * nested calls as `{__kind: Pallet, value: {__kind: method, ...args}}`, enum variants as
 * `{__kind, value}`, None as null.
 */
export function apiValue(v: unknown, accountHex: (s: string) => string | null): unknown {
  if (v === undefined || v === null) return null
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'string') return accountHex(v) ?? v
  if (v instanceof Uint8Array) return hexOfBytes(v)
  if (Array.isArray(v)) return v.map(x => apiValue(x, accountHex))
  if (isDedotCall(v)) {
    const pc = v.palletCall
    const name = typeof pc === 'string' ? pc : pc.name
    const params = typeof pc === 'string' ? {} : pc.params ?? {}
    return { __kind: v.pallet, value: { __kind: snakeCase(name), ...Object.fromEntries(Object.entries(params).map(([k, x]) => [k, apiValue(x, accountHex)])) } }
  }
  if (isRecord(v)) {
    // dedot decodes an AccountId32 (and an H160) as an object holding its bytes in `raw`.
    if (Object.keys(v).length === 1 && typeof v.raw === 'string' && /^0x[0-9a-fA-F]+$/.test(v.raw)) return v.raw.toLowerCase()
    if (typeof v.type === 'string' && Object.keys(v).every(k => k === 'type' || k === 'value')) {
      return 'value' in v ? { __kind: v.type, value: apiValue(v.value, accountHex) } : { __kind: v.type }
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, apiValue(x, accountHex)]))
  }
  return v
}

/** A dedot-decoded call as the referendum page's ApiCall, so the wizard previews it with the page's own components. */
export function toApiCall(decoded: unknown, callHex: string, accountHex: (s: string) => string | null): ApiCall {
  const byteLength = Math.max(0, (callHex.length - 2) / 2)
  if (!isDedotCall(decoded)) return { pallet: '', callName: '', args: {}, encoded: callHex, byteLength, decodeError: 'The call could not be decoded with this runtime.' }
  const flat = apiValue(decoded, accountHex) as { __kind: string; value: Record<string, unknown> & { __kind: string } }
  const { __kind: callName, ...args } = flat.value
  return { pallet: flat.__kind, callName, args, encoded: callHex, byteLength, decodeError: null }
}

// ---- the draft ----

/**
 * When a spend becomes claimable. "Days from now" is turned into an absolute block the
 * moment the reader sets it (`block`), so the call — and its preimage hash — never
 * moves while the head advances.
 */
export type ValidFrom = { mode: 'now' } | { mode: 'days'; days: string; block: number | null } | { mode: 'block'; block: string }

/** The block a spend becomes claimable at (null: once enacted), or why there is none. */
export function validFromBlock(vf: ValidFrom, headBlock: number): { block: number | null } | { error: string } {
  if (vf.mode === 'now') return { block: null }
  const b = vf.mode === 'days' ? vf.block : /^\d+$/.test(vf.block) ? Number(vf.block) : NaN
  if (vf.mode === 'days' && (b == null || !(Number(vf.days) > 0))) return { error: 'Enter how many days from now it becomes claimable.' }
  if (b == null || !Number.isInteger(b) || b <= headBlock) return { error: 'The claimable block must be after the current one.' }
  return { block: b }
}

/** "Days from now" as an absolute block, fixed at the moment it is set. */
export function daysToBlock(days: string, headBlock: number, blocksPerDay: number): number | null {
  const d = Number(days)
  return Number.isFinite(d) && d > 0 && d <= 3650 ? headBlock + Math.round(d * blocksPerDay) : null
}
export type CallDraft =
  | { kind: 'spend'; amount: string; beneficiary: string; validFrom: ValidFrom }
  | { kind: 'remark'; text: string }
  | { kind: 'hex'; hex: string }
  | { kind: 'hash'; hash: string }

export type Enactment = { mode: 'after'; blocks: string } | { mode: 'at'; block: string }

export interface ProposeDraft {
  step: number
  title: string
  body: string
  /** The discussion this proposal grew out of, when the reader started from one. */
  discussion: { postId: string; title: string } | null
  call: CallDraft
  /** The track's runtime name; null follows the suggestion. */
  track: string | null
  enactment: Enactment
  /**
   * When the reader last handed this proposal to a wallet (ms), until its outcome is
   * known: a reload in between warns instead of offering a second submission.
   */
  signedAt: number | null
  /** The referendum this draft became, once its submission is final (the description is still to be published). */
  submitted: number | null
}

export const EMPTY_DRAFT: ProposeDraft = {
  step: 0, title: '', body: '', discussion: null,
  call: { kind: 'spend', amount: '', beneficiary: '', validFrom: { mode: 'now' } },
  track: null, enactment: { mode: 'after', blocks: '' }, signedAt: null, submitted: null,
}

export const DRAFT_KEY = 'explorer-propose-draft'

/** A stored draft, field by field (anything malformed falls back to the empty draft's). */
export function readDraft(raw: string | null): ProposeDraft {
  try {
    const v = raw ? JSON.parse(raw) as Partial<ProposeDraft> : {}
    const call = v.call && typeof v.call === 'object' && ['spend', 'remark', 'hex', 'hash'].includes((v.call as CallDraft).kind) ? v.call as CallDraft : EMPTY_DRAFT.call
    return {
      step: Number.isInteger(v.step) && v.step! >= 0 && v.step! <= 4 ? v.step! : 0,
      title: typeof v.title === 'string' ? v.title : '',
      body: typeof v.body === 'string' ? v.body : '',
      discussion: v.discussion && typeof v.discussion.postId === 'string' ? { postId: v.discussion.postId, title: String(v.discussion.title ?? '') } : null,
      call,
      track: typeof v.track === 'string' ? v.track : null,
      enactment: v.enactment && (v.enactment.mode === 'after' || v.enactment.mode === 'at') ? v.enactment : EMPTY_DRAFT.enactment,
      signedAt: Number.isFinite(v.signedAt) && v.signedAt! > 0 ? v.signedAt! : null,
      submitted: Number.isInteger(v.submitted) && v.submitted! >= 0 ? v.submitted! : null,
    }
  } catch { return EMPTY_DRAFT }
}

/** The line a description started from a discussion carries, so readers can find the conversation. */
export function discussionLine(d: { postId: string; title: string }): string {
  return `Discussed in [${d.title.replace(/[[\]]/g, '') || `discussion ${d.postId}`}](/discussions/${d.postId}).`
}

/** Bytes of a remark: UTF-8, as hex. */
export function utf8Hex(text: string): string {
  return hexOfBytes(new TextEncoder().encode(text))
}

export const HEX_RE = /^0x([0-9a-fA-F]{2})*$/
export const HASH_RE = /^0x[0-9a-fA-F]{64}$/
