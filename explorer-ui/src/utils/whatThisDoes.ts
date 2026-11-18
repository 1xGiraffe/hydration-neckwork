// "What this does": a deterministic, plain-words reading of a referendum's decoded
// call — one template per call we can state exactly, and an honest fallback
// ("Calls Pallet.method") for everything else, with the full decoded tree right
// below it on the page. No guessing: a template says only what the arguments say
// (an amount with no stated asset is not called HDX).
//
// A summary is a tree of lines; each line is a list of parts the page renders
// (plain text, an account, an asset id, a referendum, an amount).

export type SummaryPart =
  | { t: 'text'; v: string }
  | { t: 'account'; v: string }
  | { t: 'asset'; id: number }
  | { t: 'ref'; index: number }
  | { t: 'amount'; raw: string; decimals: number; symbol: string }
  | { t: 'code'; v: string }
  /** An amount of a registry asset, in its own units: the page reads the asset's decimals and symbol. */
  | { t: 'assetAmount'; id: number; raw: string }
  /** An EVM call: the page names the function from the contract's verified ABI when it can. */
  | { t: 'evm'; target: string; input: string }

export interface SummaryLine { parts: SummaryPart[]; children?: SummaryLine[] }

interface DecodedCall { pallet: string; method: string; args: Record<string, unknown> }

const MAX_DEPTH = 4
const MAX_BATCH_LINES = 24
const HDX_DECIMALS = 12

const text = (v: string): SummaryPart => ({ t: 'text', v })
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isAccount = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$|^0x[0-9a-fA-F]{40}$/.test(v)
const intOf = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isSafeInteger(n) ? n : null
}
const rawOf = (v: unknown): string | null => (typeof v === 'string' && /^\d+$/.test(v) ? v : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : null)

/** A nested call as the decoder writes it: `{__kind: Pallet, value: {...args, __kind: method}}`. */
export function nestedCall(v: unknown): DecodedCall | null {
  if (!isRecord(v) || typeof v.__kind !== 'string' || !isRecord(v.value) || typeof v.value.__kind !== 'string') return null
  const { __kind: method, ...args } = v.value
  return { pallet: v.__kind, method: method as string, args }
}

function humanMethod(pallet: string, method: string): string {
  return `${pallet}.${method}`
}

function account(v: unknown): SummaryPart {
  return isAccount(v) ? { t: 'account', v } : text('an account')
}

// Calls that move funds. Whatever the summary leaves out (past MAX_DEPTH, or after the
// first MAX_BATCH_LINES of a batch), these are still named: a transfer is never hidden.
const MOVES_FUNDS = new Set([
  'Tokens.transfer', 'Tokens.transfer_all', 'Tokens.transfer_keep_alive', 'Tokens.force_transfer',
  'Currencies.transfer', 'Currencies.transfer_native_currency',
  'Balances.transfer', 'Balances.transfer_allow_death', 'Balances.transfer_keep_alive', 'Balances.transfer_all', 'Balances.force_transfer',
  'Treasury.spend', 'Treasury.spend_local',
  'EVM.call',
])
const MAX_SURFACED = 10
const MAX_WALK = 5_000

/** Every call nested anywhere in a value (an argument, a list of calls, a wrapper's `call`), in order. */
function nestedCalls(v: unknown, out: DecodedCall[], budget: { left: number }): void {
  if (budget.left <= 0 || v == null || typeof v !== 'object') return
  budget.left--
  const call = nestedCall(v)
  if (call) { out.push(call); for (const a of Object.values(call.args)) nestedCalls(a, out, budget); return }
  for (const x of Array.isArray(v) ? v : Object.values(v)) nestedCalls(x, out, budget)
}

/** The fund-moving calls inside what the summary cut, as lines of their own. */
function surfacedTransfers(cut: unknown[]): SummaryLine[] {
  const all: DecodedCall[] = []
  for (const c of cut) nestedCalls(c, all, { left: MAX_WALK })
  const moving = all.filter(c => MOVES_FUNDS.has(`${c.pallet}.${c.method}`))
  const out = moving.slice(0, MAX_SURFACED).map(c => {
    const l = summarizeCall(c, MAX_DEPTH)
    return { parts: [text('Inside: '), ...lowerFirst(l.parts)] }
  })
  if (moving.length > MAX_SURFACED) out.push({ parts: [text(`…and ${moving.length - MAX_SURFACED} more transfers inside (see the full call below)`)] })
  return out
}

/** "3 more nested calls, see the full call below", and the transfers among them. */
function cutLines(cut: unknown[]): SummaryLine[] {
  const all: DecodedCall[] = []
  for (const c of cut) nestedCalls(c, all, { left: MAX_WALK })
  if (!all.length) return []
  return [{ parts: [text(`${all.length} more nested ${all.length === 1 ? 'call' : 'calls'}, see the full call below`)] }, ...surfacedTransfers(cut)]
}

function lines(calls: unknown[], depth: number): SummaryLine[] {
  const out: SummaryLine[] = []
  for (const c of calls.slice(0, MAX_BATCH_LINES)) {
    const call = nestedCall(c)
    out.push(call ? summarizeCall(call, depth + 1) : { parts: [text('An undecoded call')] })
  }
  if (calls.length > MAX_BATCH_LINES) {
    out.push({ parts: [text(`…and ${calls.length - MAX_BATCH_LINES} more calls (see the full call below)`)] })
    out.push(...surfacedTransfers(calls.slice(MAX_BATCH_LINES)))
  }
  return out
}

function wrapped(prefix: SummaryPart[], inner: unknown, depth: number): SummaryLine {
  const call = nestedCall(inner)
  if (!call) return { parts: [...prefix, text('runs a call')] }
  if (depth >= MAX_DEPTH) {
    const below = Object.values(call.args)
    return { parts: [...prefix, text(`calls ${humanMethod(call.pallet, call.method)}`)], children: [...(MOVES_FUNDS.has(`${call.pallet}.${call.method}`) ? [summarizeCall(call, MAX_DEPTH)] : []), ...cutLines(below)] }
  }
  const sub = summarizeCall(call, depth + 1)
  return { parts: [...prefix, ...lowerFirst(sub.parts)], children: sub.children }
}

function lowerFirst(parts: SummaryPart[]): SummaryPart[] {
  const [first, ...rest] = parts
  if (first?.t !== 'text') return parts
  return [text(first.v.charAt(0).toLowerCase() + first.v.slice(1)), ...rest]
}

export function summarizeCall(call: DecodedCall, depth = 0): SummaryLine {
  const { pallet, method, args } = call
  const key = `${pallet}.${method}`
  switch (key) {
    case 'Utility.batch_all':
    case 'Utility.batch':
    case 'Utility.force_batch': {
      const calls = Array.isArray(args.calls) ? args.calls : []
      const mode = method === 'batch_all' ? 'all succeed or none do' : method === 'batch' ? 'stops at the first failure' : 'each runs even if another fails'
      return { parts: [text(`Runs ${calls.length} ${calls.length === 1 ? 'call' : 'calls'} together (${mode}):`)], children: depth < MAX_DEPTH ? lines(calls, depth) : cutLines(calls) }
    }
    case 'Whitelist.dispatch_whitelisted_call_with_preimage':
      return wrapped([text('Fast-tracked by the technical committee (whitelisted): ')], args.call, depth)
    case 'Whitelist.dispatch_whitelisted_call':
      return { parts: [text('Runs a call the technical committee whitelisted (hash '), { t: 'code', v: String(args.callHash ?? '').slice(0, 10) + '…' }, text(')')] }
    case 'Dispatcher.dispatch_as_treasury':
      return wrapped([text('As the treasury account, ')], args.call, depth)
    case 'Dispatcher.dispatch_as_aave_manager':
      return wrapped([text('As the money market’s admin, ')], args.call, depth)
    case 'Utility.dispatch_as':
      return wrapped([text('With a chosen origin, ')], args.call, depth)
    case 'Scheduler.schedule_after': {
      const after = intOf(args.after)
      return wrapped([text(after != null ? `${after.toLocaleString('en-US')} blocks later, ` : 'Later, ')], args.call, depth)
    }
    case 'Proxy.proxy':
      return wrapped([text('On behalf of '), account(args.real), text(' (as its proxy), ')], args.call, depth)
    case 'System.remark':
    case 'System.remark_with_event':
      return { parts: [text('Writes a note on chain; it changes nothing else')] }
    case 'System.authorize_upgrade':
    case 'ParachainSystem.authorize_upgrade':
      return { parts: [text('Authorizes a runtime upgrade to the code with hash '), { t: 'code', v: shortHex(args.codeHash) }, text(' — anyone can then apply it')] }
    case 'System.set_code':
      return { parts: [text('Replaces the chain’s runtime code')] }
    case 'Treasury.spend_local': {
      const raw = rawOf(args.amount)
      return raw
        ? { parts: [text('Pays '), { t: 'amount', raw, decimals: HDX_DECIMALS, symbol: 'HDX' }, text(' from the treasury to '), account(args.beneficiary)] }
        : { parts: [text('Pays HDX from the treasury to '), account(args.beneficiary)] }
    }
    case 'Treasury.spend': {
      // Hydration's treasury pays HDX only: its AssetKind is the unit type, so the call
      // carries no asset (an empty asset kind). Any other asset kind leaves the amount
      // without a unit, and then it is not stated.
      const kind = args.assetKind
      const unit = kind == null || (Array.isArray(kind) && !kind.length) || (typeof kind === 'object' && !Array.isArray(kind) && !Object.keys(kind).length)
      const raw = rawOf(args.amount)
      return unit && raw
        ? { parts: [text('Approves a treasury payout of '), { t: 'amount', raw, decimals: HDX_DECIMALS, symbol: 'HDX' }, text(' to '), account(args.beneficiary)] }
        : { parts: [text('Approves a treasury payout to '), account(args.beneficiary), text(' (amount and asset in the call below)')] }
    }
    case 'Referenda.cancel':
    case 'Referenda.kill': {
      const index = intOf(args.index)
      return { parts: [text(method === 'kill' ? 'Kills ' : 'Cancels '), index != null ? { t: 'ref', index } : text('a referendum'), text(method === 'kill' ? ' and slashes its deposits' : '; whoever placed its deposits can then reclaim them')] }
    }
    case 'Omnipool.set_asset_weight_cap': {
      const id = intOf(args.assetId ?? args.asset), cap = intOf(args.cap)
      return { parts: [text('Sets the Omnipool weight cap of '), id != null ? { t: 'asset', id } : text('an asset'), text(cap != null ? ` to ${(cap / 10_000).toLocaleString('en-US', { maximumFractionDigits: 4 })}% of the pool` : '')] }
    }
    case 'Omnipool.set_asset_tradable_state': {
      const id = intOf(args.assetId ?? args.asset)
      return { parts: [text('Changes what can be traded for '), id != null ? { t: 'asset', id } : text('an asset'), text(' in the Omnipool')] }
    }
    case 'Omnipool.add_token': {
      const id = intOf(args.asset ?? args.assetId)
      return { parts: [text('Adds '), id != null ? { t: 'asset', id } : text('an asset'), text(' to the Omnipool')] }
    }
    case 'Omnipool.set_tvl_cap':
      return { parts: [text('Changes the Omnipool’s total value cap')] }
    case 'TechnicalCommittee.set_members':
      return { parts: [text(`Replaces the technical committee’s members${Array.isArray(args.newMembers) ? ` (${args.newMembers.length} members)` : ''}`)] }
    case 'CollatorSelection.add_invulnerable':
      return { parts: [text('Adds '), account(args.who), text(' as an always-on (invulnerable) collator')] }
    case 'CollatorSelection.remove_invulnerable':
      return { parts: [text('Removes '), account(args.who), text(' from the always-on (invulnerable) collators')] }
    case 'Tokens.transfer':
    case 'Currencies.transfer':
    case 'Tokens.force_transfer': {
      const id = intOf(args.currencyId ?? args.currency_id)
      const raw = rawOf(args.amount)
      const what: SummaryPart[] = id != null && raw != null ? [{ t: 'assetAmount', id, raw }] : [id != null ? { t: 'asset', id } : text('tokens')]
      const from: SummaryPart[] = isAccount(args.source) ? [text(' from '), account(args.source)] : []
      return { parts: [text('Transfers '), ...what, ...from, text(' to '), account(args.dest)] }
    }
    case 'Balances.transfer':
    case 'Balances.transfer_allow_death':
    case 'Balances.transfer_keep_alive':
    case 'Balances.force_transfer': {
      // Balances is the native currency, HDX.
      const raw = rawOf(args.value ?? args.amount)
      const from: SummaryPart[] = isAccount(args.source) ? [text(' from '), account(args.source)] : []
      return { parts: [text('Transfers '), raw ? { t: 'amount', raw, decimals: HDX_DECIMALS, symbol: 'HDX' } : text('HDX'), ...from, text(' to '), account(args.dest)] }
    }
    case 'EVM.call':
      return typeof args.target === 'string' && typeof args.input === 'string'
        ? { parts: [text('Calls '), { t: 'evm', target: args.target, input: args.input }] }
        : { parts: [text('Calls the EVM contract '), account(args.target)] }
    case 'AssetRegistry.register':
      return { parts: [text('Registers a new asset')] }
    case 'AssetRegistry.update': {
      const id = intOf(args.assetId)
      return { parts: [text('Updates the registry entry of '), id != null ? { t: 'asset', id } : text('an asset')] }
    }
    case 'PolkadotXcm.send':
    case 'OrmlXcm.send_as_sovereign':
      return { parts: [text('Sends a cross-chain (XCM) message from Hydration')] }
    case 'Stableswap.update_amplification':
      return { parts: [text('Changes a stableswap pool’s amplification')] }
    default:
      return { parts: [text('Calls '), { t: 'code', v: humanMethod(pallet, method) }] }
  }
}

function shortHex(v: unknown): string {
  return typeof v === 'string' && v.length > 18 ? `${v.slice(0, 10)}…${v.slice(-6)}` : String(v ?? '')
}

/** The summary of a referendum's top-level call (the API's `proposalCall`), or null when it did not decode. */
export function summarizeProposal(call: { pallet: string; callName: string; args: unknown; decodeError: string | null } | null): SummaryLine | null {
  if (!call || call.decodeError || !call.pallet) return null
  return summarizeCall({ pallet: call.pallet, method: call.callName, args: isRecord(call.args) ? call.args : {} })
}
