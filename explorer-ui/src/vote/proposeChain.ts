import { blake2AsHex, decodeAddress, hexToU8a, u8aToHex, xxhashAsHex } from 'dedot/utils'
import { client, describeDryRun, evmAccountId, toSs58 } from './chainWrite'
import { originOfTrack, toApiCall, utf8Hex, validFromBlock, type ApiCall, type CallDraft } from '../proposeLogic'
import { parseHdx } from './voteMath'

// The proposal wizard's chain side, loaded with the signing engine only once a call is
// built: the call's SCALE bytes from the live metadata (dedot), its preimage hash and
// length, what the chain already stores under that hash, and the next referendum
// number. Reads only — the one transaction is signed through the engine (chainWrite).

export interface BuiltCall {
  callHex: string
  /** blake2-256 of the bytes: the preimage hash a referendum names. */
  hash: string
  len: number
  decoded: ApiCall
  /** A spend template's beneficiary as the account the treasury pays (SS58), and its claimable block. */
  spend?: { amount: string; beneficiary: string; validFrom: number | null }
}

/** An SS58 address's account id (hex), or null for anything that is not one. */
export function accountHexOf(s: string): string | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(s)) return null
  try { return u8aToHex(decodeAddress(s)) } catch { return null }
}

/** The bytes of a call, decoded into the referendum page's shape. */
export async function describeCall(callHex: string): Promise<BuiltCall> {
  const c = await client()
  let decoded: unknown = null
  try { decoded = c.registry.findCodec(c.metadata.latest.extrinsic.callTypeId).tryDecode(callHex) } catch { decoded = null }
  return { callHex, hash: blake2AsHex(callHex, 256), len: (callHex.length - 2) / 2, decoded: toApiCall(decoded, callHex, accountHexOf) }
}

/**
 * A beneficiary as the account the treasury pays: an SS58 address as itself, an H160 as
 * the account it maps to on Hydration (EvmAccountsApi.account_id — the bound account,
 * else `ETH\0 ‖ h160 ‖ 0×8`).
 */
export async function resolveBeneficiary(input: string): Promise<{ accountId: string; address: string } | { error: string }> {
  const s = input.trim()
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    try { const id = await evmAccountId(s); return { accountId: id, address: toSs58(id) } } catch { return { error: 'The chain could not map this Ethereum address to an account.' } }
  }
  const id = accountHexOf(s)
  return id ? { accountId: id, address: toSs58(id) } : { error: 'Enter a Hydration (SS58) or Ethereum (0x…, 40 hex) address.' }
}

/** The call a template stands for, built against the live metadata. */
export async function buildTemplateCall(draft: CallDraft, ctx: { headBlock: number }): Promise<BuiltCall | { error: string }> {
  const c = await client()
  if (draft.kind === 'remark') {
    if (!draft.text.trim()) return { error: 'Write the remark.' }
    return describeCall(c.tx.system.remark(utf8Hex(draft.text)).callHex)
  }
  if (draft.kind === 'spend') {
    const amount = parseHdx(draft.amount)
    if (amount == null || amount <= 0n) return { error: 'Enter the amount in HDX.' }
    const who = await resolveBeneficiary(draft.beneficiary)
    if ('error' in who) return who
    // "Days from now" was fixed to a block when it was set; the head only bounds it.
    const vf = validFromBlock(draft.validFrom, ctx.headBlock)
    if ('error' in vf) return vf
    // Hydration's treasury pays HDX only (AssetKind = ()), so the asset kind is unit.
    const built = await describeCall(c.tx.treasury.spend([], amount, who.accountId, vf.block ?? undefined).callHex)
    return { ...built, spend: { amount: amount.toString(), beneficiary: who.address, validFrom: vf.block } }
  }
  if (draft.kind === 'hex') {
    const hex = draft.hex.trim()
    if (!/^0x([0-9a-fA-F]{2})+$/.test(hex)) return { error: 'Paste the call data as 0x-prefixed hex.' }
    const built = await describeCall(hex.toLowerCase())
    // A paste that does not decode as one whole call would be stored as a preimage nobody can enact.
    try {
      const codec = c.registry.findCodec(c.metadata.latest.extrinsic.callTypeId) as unknown as { tryDecode(i: string): unknown; tryEncode(v: unknown): Uint8Array }
      const reencoded = codec.tryEncode(codec.tryDecode(hex))
      if (u8aToHex(reencoded).toLowerCase() !== hex.toLowerCase()) return { error: 'This is not exactly one call for this runtime (it decodes to something shorter or different).' }
    } catch {
      return { error: 'This does not decode as a call for the current runtime.' }
    }
    return built
  }
  return { error: 'Read the preimage instead.' }
}

export interface PreimageInfo {
  hash: string
  /** Its bytes are stored on chain (a status with a known length and the bytes behind it). */
  noted: boolean
  /** Requested (by the scheduler or root): noting it then takes no deposit. */
  requested: boolean
  len: number | null
  /** The bytes, when stored. */
  callHex: string | null
  /** Who holds its deposit (SS58), when someone does: that account can unnote it until it is requested. */
  owner: string | null
}

type Ticket = [unknown, unknown] | undefined | null
const ss58Of = (who: unknown): string | null => {
  if (typeof who === 'string') return who.startsWith('0x') ? toSs58(who) : who
  const raw = (who as { raw?: unknown } | null)?.raw
  return typeof raw === 'string' ? toSs58(raw) : null
}

/**
 * What the chain stores under a preimage hash: Preimage.RequestStatusFor, else the
 * older Preimage.StatusFor some entries still use (the pallet migrates one on its next
 * use). A Requested status without a length has no bytes behind it — it is not stored.
 */
export async function readPreimage(hash: string): Promise<PreimageInfo> {
  const c = await client()
  type Status = { type: string; value: { len?: number; maybeLen?: number; ticket?: Ticket; maybeTicket?: Ticket; deposit?: Ticket } }
  const [current, legacy] = await Promise.all([
    c.query.preimage.requestStatusFor(hash) as Promise<Status | undefined>,
    (c.query.preimage.statusFor?.(hash) ?? Promise.resolve(undefined)) as Promise<Status | undefined>,
  ])
  const status = current ?? legacy
  if (!status) return { hash, noted: false, requested: false, len: null, callHex: null, owner: null }
  const v = status.value
  const lenRaw = status.type === 'Unrequested' ? v.len : current ? v.maybeLen : v.len
  const len = lenRaw != null ? Number(lenRaw) : null
  const ticket = current ? (status.type === 'Unrequested' ? v.ticket : v.maybeTicket) : v.deposit
  const owner = ticket ? ss58Of(ticket[0]) : null
  let callHex: string | null = null
  if (len != null) {
    // Preimage.PreimageFor is keyed (hash, len) with the Identity hasher; read raw, since
    // dedot's storage helper does not take this tuple key. The value is a BoundedVec<u8>.
    const le = [0, 8, 16, 24].map(sh => ((len >>> sh) & 255).toString(16).padStart(2, '0')).join('')
    const key = `${xxhashAsHex('Preimage', 128)}${xxhashAsHex('PreimageFor', 128).slice(2)}${hash.slice(2).toLowerCase()}${le}`
    const raw = await c.rpc.state_getStorage(key) as string | null
    const bytes = raw ? vecBytes(hexToU8a(raw)) : null
    callHex = bytes && bytes.length === len && blake2AsHex(bytes, 256).toLowerCase() === hash.toLowerCase() ? u8aToHex(bytes) : null
  }
  return { hash, noted: len != null && callHex != null, requested: status.type === 'Requested', len, callHex, owner }
}

export interface OriginCheck { ok: boolean; code: string | null; message: string | null }

/**
 * Whether each track's origin may make this call now: the call itself dry-run
 * (DryRunApi.dry_run_call) with the origin a referendum on that track dispatches from
 * — Root, or Origins::<Track>. The chain checks the origin only at enactment, so this
 * is the one place a wrong track shows before the vote; state can still change by then.
 */
export async function checkTrackOrigins(callHex: string, tracks: string[]): Promise<Record<string, OriginCheck>> {
  const c = await client()
  const call = c.registry.findCodec(c.metadata.latest.extrinsic.callTypeId).tryDecode(callHex)
  const out: Record<string, OriginCheck> = {}
  await Promise.all(tracks.map(async name => {
    const o = originOfTrack(name)
    const origin = o.kind === 'root' ? { type: 'System', value: { type: 'Root' } } : { type: 'Origins', value: o.name }
    try {
      const r = await c.call.dryRunApi.dryRunCall(origin, call, 5) as { isOk?: boolean; value?: Parameters<typeof describeDryRun>[1] }
      if (!r?.isOk || !r.value) { out[name] = { ok: false, code: null, message: 'The node could not check this.' }; return }
      const d = describeDryRun(c, r.value)
      out[name] = { ok: d.ok, code: d.code, message: d.message }
    } catch (e) {
      out[name] = { ok: false, code: null, message: `The node could not check this: ${e instanceof Error ? e.message : String(e)}` }
    }
  }))
  return out
}

/** A SCALE Vec<u8>'s bytes (compact length prefix, then the bytes). */
function vecBytes(v: Uint8Array): Uint8Array | null {
  if (!v.length) return null
  const mode = v[0] & 3
  const [n, off] = mode === 0 ? [v[0] >> 2, 1] : mode === 1 ? [(v[0] | (v[1] << 8)) >> 2, 2] : mode === 2 ? [((v[0] | (v[1] << 8) | (v[2] << 16) | (v[3] << 24)) >>> 2), 4] : [-1, 0]
  return n >= 0 && off + n === v.length ? v.slice(off) : null
}

/** The number the next submitted referendum gets (Referenda.ReferendumCount). */
export async function nextReferendumIndex(): Promise<number> {
  const c = await client()
  return Number(await c.query.referenda.referendumCount())
}
