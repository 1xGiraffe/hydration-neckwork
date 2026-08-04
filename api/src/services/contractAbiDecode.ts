import { keccakAsHex } from '@polkadot/util-crypto'
import { cached } from './cache.ts'
import { getContractAbiPayload, verifiedContractInfo } from './contractVerificationService.ts'

// Read-time ABI decoding for detail surfaces (§9). A verified contract's ABI is
// compiled into selector/topic0 indexes once per (address, verifiedAt) and then
// applied to rows a page has already fetched — never the other way around: no
// query is issued to find something to decode, and raw tables are never
// rewritten, so a corrected ABI retroactively fixes display with no reindex.
//
// Decoding is strict: an unsupported parameter type or malformed payload yields
// an explicit `decoded:false`, never a partially guessed argument list. The
// hashing matches src/raw/evmLogs.ts (keccakAsHex over the canonical
// signature); the two known-constant vectors in tests pin that equivalence.

export interface AbiParamNode {
  name: string
  type: string
  components?: AbiParamNode[]
  indexed?: boolean
}

export interface AbiFunctionEntry {
  name: string
  signature: string
  selector: string
  inputs: AbiParamNode[]
}

export interface AbiEventEntry {
  name: string
  signature: string
  topic0: string
  inputs: AbiParamNode[]
}

export interface AbiIndexes {
  functionsBySelector: Map<string, AbiFunctionEntry>
  eventsByTopic0: Map<string, AbiEventEntry>
}

export interface DecodedParam {
  name: string
  type: string
  value: unknown
  indexed?: boolean
  // An indexed dynamic value only exists on chain as its keccak hash; the hash
  // is shown rather than pretending the preimage is known.
  hashed?: boolean
}

export type DecodedCall =
  | { decoded: true; name: string; signature: string; selector: string; params: DecodedParam[] }
  | { decoded: false; selector: string | null }

export type DecodedLog =
  | { decoded: true; name: string; signature: string; params: DecodedParam[]; decodedBy: 'verified-abi' }
  | { decoded: false }

// --- index construction -----------------------------------------------------

function paramNode(raw: unknown): AbiParamNode | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.type !== 'string' || r.type === '') return null
  const node: AbiParamNode = {
    name: typeof r.name === 'string' ? r.name : '',
    type: r.type,
    ...(r.indexed === true ? { indexed: true } : {}),
  }
  if (baseType(r.type) === 'tuple') {
    if (!Array.isArray(r.components)) return null
    const components = r.components.map(paramNode)
    if (components.some(c => c == null)) return null
    node.components = components as AbiParamNode[]
  }
  return node
}

function baseType(type: string): string {
  return type.replace(/(\[\d*\])+$/, '')
}

function arraySuffix(type: string): string {
  const m = type.match(/(\[\d*\])+$/)
  return m ? m[0] : ''
}

// Canonical type string for signature hashing: tuple → parenthesized component
// list, `uint`/`int` aliases expanded. solc emits canonical types already; the
// aliases only appear in hand-written ABI json.
function canonicalType(node: AbiParamNode): string {
  const suffix = arraySuffix(node.type)
  const base = baseType(node.type)
  if (base === 'tuple') {
    return `(${(node.components ?? []).map(canonicalType).join(',')})${suffix}`
  }
  if (base === 'uint') return `uint256${suffix}`
  if (base === 'int') return `int256${suffix}`
  return `${base}${suffix}`
}

export function buildAbiIndexes(abiJson: unknown): AbiIndexes {
  const functionsBySelector = new Map<string, AbiFunctionEntry>()
  const eventsByTopic0 = new Map<string, AbiEventEntry>()
  if (Array.isArray(abiJson)) {
    for (const raw of abiJson) {
      if (raw == null || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      if ((item.type !== 'function' && item.type !== 'event') || typeof item.name !== 'string' || !item.name) continue
      if (!Array.isArray(item.inputs)) continue
      const inputs = item.inputs.map(paramNode)
      if (inputs.some(i => i == null)) continue
      const nodes = inputs as AbiParamNode[]
      const signature = `${item.name}(${nodes.map(canonicalType).join(',')})`
      const hash = keccakAsHex(signature).toLowerCase()
      if (item.type === 'function') {
        const selector = hash.slice(0, 10)
        if (!functionsBySelector.has(selector)) {
          functionsBySelector.set(selector, { name: item.name, signature, selector, inputs: nodes })
        }
      } else if (item.anonymous !== true) {
        // An anonymous event has no signature topic — it can never be matched
        // by topic0, so indexing it would only ever produce wrong matches.
        if (!eventsByTopic0.has(hash)) {
          eventsByTopic0.set(hash, { name: item.name, signature, topic0: hash, inputs: nodes })
        }
      }
    }
  }
  return { functionsBySelector, eventsByTopic0 }
}

// --- strict ABI value decoding ----------------------------------------------
//
// `body` is the argument area as bare hex (no 0x). Every read is bounds-checked
// and any violation throws DecodeError, which the public entry points turn into
// `decoded:false` — a wrong length, a wild offset, or an unsupported type must
// fail the whole decode rather than yield a plausible partial result.

class DecodeError extends Error {}

const ELEMENTARY = /^(address|bool|string|bytes|bytes([1-9]|[12][0-9]|3[0-2])|(u?int)(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256))$/

function isDynamic(node: AbiParamNode): boolean {
  const suffix = arraySuffix(node.type)
  if (suffix.endsWith('[]')) return true
  if (suffix !== '') return isDynamic({ ...node, type: node.type.slice(0, node.type.length - suffix.match(/\[\d*\]$/)![0].length) })
  const base = baseType(node.type)
  if (base === 'string' || base === 'bytes') return true
  if (base === 'tuple') return (node.components ?? []).some(isDynamic)
  return false
}

// Size of one element's slot in its enclosing head area, in hex chars.
function headSize(node: AbiParamNode): number {
  if (isDynamic(node)) return 64
  const suffix = arraySuffix(node.type)
  if (suffix !== '') {
    const m = node.type.match(/\[(\d+)\]$/)
    const count = Number(m![1])
    const element = { ...node, type: node.type.slice(0, node.type.length - m![0].length) }
    return count * headSize(element)
  }
  if (baseType(node.type) === 'tuple') {
    return (node.components ?? []).reduce((sum, c) => sum + headSize(c), 0)
  }
  return 64
}

function wordAt(body: string, at: number): string {
  if (at < 0 || at + 64 > body.length) throw new DecodeError('word out of bounds')
  return body.slice(at, at + 64)
}

function numberFromWord(word: string): number {
  const value = BigInt(`0x${word}`)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new DecodeError('offset overflow')
  return Number(value)
}

function decodeElementary(type: string, word: string): unknown {
  if (!ELEMENTARY.test(type)) throw new DecodeError(`unsupported type ${type}`)
  if (type === 'address') return `0x${word.slice(24)}`.toLowerCase()
  if (type === 'bool') return BigInt(`0x${word}`) !== 0n
  if (type.startsWith('bytes')) {
    const n = Number(type.slice(5))
    return `0x${word.slice(0, n * 2)}`.toLowerCase()
  }
  const bits = BigInt(type.replace(/^u?int/, ''))
  const masked = BigInt(`0x${word}`) & ((1n << bits) - 1n)
  if (type.startsWith('uint')) return masked.toString()
  const signBit = 1n << (bits - 1n)
  return ((masked & signBit) === 0n ? masked : masked - (1n << bits)).toString()
}

function utf8OrHex(hex: string): string {
  const raw = Buffer.from(hex, 'hex')
  const text = raw.toString('utf8')
  // A lossy round-trip means the bytes were not UTF-8; show them honestly.
  return Buffer.from(text, 'utf8').equals(raw) ? text : `0x${hex}`
}

function elementNode(node: AbiParamNode): AbiParamNode {
  const m = node.type.match(/\[\d*\]$/)
  return { ...node, type: node.type.slice(0, node.type.length - m![0].length) }
}

function decodeValue(node: AbiParamNode, body: string, at: number): unknown {
  const suffix = arraySuffix(node.type)
  if (suffix.endsWith('[]')) {
    const length = numberFromWord(wordAt(body, at))
    if (length * 64 > body.length) throw new DecodeError('array length out of bounds')
    return decodeFrame(Array.from({ length }, () => elementNode(node)), body, at + 64).map(p => p.value)
  }
  if (suffix !== '') {
    const count = Number(node.type.match(/\[(\d+)\]$/)![1])
    const element = elementNode(node)
    if (isDynamic(node)) {
      return decodeFrame(Array.from({ length: count }, () => element), body, at).map(p => p.value)
    }
    const size = headSize(element)
    return Array.from({ length: count }, (_, i) => decodeValue(element, body, at + i * size))
  }
  const base = baseType(node.type)
  if (base === 'tuple') {
    const components = node.components ?? []
    const params = decodeFrame(components, body, at)
    if (components.length && components.every(c => c.name)) {
      return Object.fromEntries(params.map(p => [p.name, p.value]))
    }
    return params.map(p => p.value)
  }
  if (base === 'string' || base === 'bytes') {
    const length = numberFromWord(wordAt(body, at))
    const start = at + 64
    if (start + length * 2 > body.length) throw new DecodeError('bytes out of bounds')
    const hex = body.slice(start, start + length * 2).toLowerCase()
    return base === 'string' ? utf8OrHex(hex) : `0x${hex}`
  }
  return decodeElementary(base, wordAt(body, at))
}

// One head area (top-level arguments, a tuple, or a dynamic array's elements):
// static values inline, dynamic values behind an offset relative to the frame.
function decodeFrame(nodes: AbiParamNode[], body: string, frameStart: number): { name: string; value: unknown }[] {
  const out: { name: string; value: unknown }[] = []
  let cursor = frameStart
  for (const node of nodes) {
    if (isDynamic(node)) {
      // ABI offsets are byte offsets; the cursor walks hex characters.
      const offset = numberFromWord(wordAt(body, cursor)) * 2
      out.push({ name: node.name, value: decodeValue(node, body, frameStart + offset) })
      cursor += 64
    } else {
      out.push({ name: node.name, value: decodeValue(node, body, cursor) })
      cursor += headSize(node)
    }
  }
  return out
}

function namedParams(nodes: AbiParamNode[], values: { name: string; value: unknown }[]): DecodedParam[] {
  return values.map((v, i) => ({
    name: v.name || `arg${i}`,
    type: canonicalType(nodes[i]),
    value: v.value,
  }))
}

// --- public decode entry points ---------------------------------------------

export function decodeFunctionInput(indexes: AbiIndexes | null, input: string): DecodedCall {
  const hex = typeof input === 'string' ? input.toLowerCase() : ''
  if (!/^0x[0-9a-f]*$/.test(hex) || hex.length < 10 || hex.length % 2 !== 0) {
    return { decoded: false, selector: null }
  }
  const selector = hex.slice(0, 10)
  const entry = indexes?.functionsBySelector.get(selector)
  if (!entry) return { decoded: false, selector }
  const body = hex.slice(10)
  try {
    const values = decodeFrame(entry.inputs, body, 0)
    return {
      decoded: true,
      name: entry.name,
      signature: entry.signature,
      selector,
      params: namedParams(entry.inputs, values),
    }
  } catch {
    return { decoded: false, selector }
  }
}

export function decodeEventLog(indexes: AbiIndexes | null, topics: string[], data: string): DecodedLog {
  const topic0 = typeof topics[0] === 'string' ? topics[0].toLowerCase() : null
  const entry = topic0 ? indexes?.eventsByTopic0.get(topic0) : null
  if (!entry) return { decoded: false }
  const indexed = entry.inputs.filter(i => i.indexed)
  if (topics.length - 1 !== indexed.length) return { decoded: false }
  const dataHex = typeof data === 'string' ? data.toLowerCase() : ''
  if (!/^0x[0-9a-f]*$/.test(dataHex) || dataHex.length % 2 !== 0) return { decoded: false }
  try {
    const nonIndexed = entry.inputs.filter(i => !i.indexed)
    const dataValues = decodeFrame(nonIndexed, dataHex.slice(2), 0)
    const params: DecodedParam[] = []
    let topicIndex = 1
    let dataIndex = 0
    for (const [position, node] of entry.inputs.entries()) {
      if (!node.indexed) {
        const v = dataValues[dataIndex++]
        params.push({ name: v.name || `arg${position}`, type: canonicalType(node), value: v.value })
        continue
      }
      const topic = topics[topicIndex++]
      if (typeof topic !== 'string' || !/^0x[0-9a-f]{64}$/.test(topic.toLowerCase())) throw new DecodeError('malformed topic')
      const base = baseType(node.type)
      const dynamic = isDynamic(node) || base === 'tuple'
      params.push({
        name: node.name || `arg${position}`,
        type: canonicalType(node),
        value: dynamic ? topic.toLowerCase() : decodeElementary(base, topic.toLowerCase().slice(2)),
        indexed: true,
        ...(dynamic ? { hashed: true } : {}),
      })
    }
    return { decoded: true, name: entry.name, signature: entry.signature, params, decodedBy: 'verified-abi' }
  } catch {
    return { decoded: false }
  }
}

// --- extrinsic call-site collection -------------------------------------------

export interface EvmCallSite {
  target: string
  input: string
}

const H160_RE = /^0x[0-9a-fA-F]{40}$/
const HEX_RE = /^0x[0-9a-fA-F]*$/

// More sites than any indexed extrinsic carries; a hostile batch-of-batches
// stops here instead of turning one detail request into hundreds of decodes.
const MAX_CALL_SITES = 25

// Every EVM call an extrinsic performs, top-level or buried: a bare `EVM.call`,
// an `Ethereum.transact` with a Call action (a Create has no target yet), and
// `EVM.call` nodes nested in wrapper call trees (batch/proxy/multisig/
// dispatcher). Like dcaScheduleFromCallArgs, nested calls are matched by their
// own SCALE-JSON shape — {__kind:'EVM', value:{__kind:'call', …}} — not by a
// list of wrapper names, and the walk is depth-bounded because this runs on a
// request path. A nested Ethereum.transact is not collected: its origin check
// makes it undispatchable from a wrapper, so there is nothing real to decode.
export function collectEvmCalls(callName: string, callArgs: unknown): EvmCallSite[] {
  const sites: EvmCallSite[] = []
  const push = (target: unknown, input: unknown) => {
    if (sites.length >= MAX_CALL_SITES) return
    if (typeof target !== 'string' || !H160_RE.test(target)) return
    if (typeof input !== 'string' || !HEX_RE.test(input) || input.length % 2 !== 0) return
    sites.push({ target: target.toLowerCase(), input: input.toLowerCase() })
  }
  if (callArgs == null || typeof callArgs !== 'object' || Array.isArray(callArgs)) return sites
  const args = callArgs as Record<string, unknown>

  if (callName === 'EVM.call') push(args.target, args.input)
  if (callName === 'Ethereum.transact') {
    const tx = (args.transaction as Record<string, unknown> | undefined)?.value as Record<string, unknown> | undefined
    const action = tx?.action as Record<string, unknown> | undefined
    if (action?.__kind === 'Call') push(action.value, tx?.input)
  }

  const walk = (node: unknown, depth: number): void => {
    if (node == null || typeof node !== 'object' || depth > 12 || sites.length >= MAX_CALL_SITES) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    const obj = node as Record<string, unknown>
    if (obj.__kind === 'EVM' && obj.value != null && typeof obj.value === 'object') {
      const inner = obj.value as Record<string, unknown>
      if (inner.__kind === 'call') {
        push(inner.target, inner.input)
        return
      }
    }
    for (const value of Object.values(obj)) walk(value, depth + 1)
  }
  walk(args, 0)
  return sites
}

export interface DecodedEvmCall {
  target: string
  contractName: string | null
  call: DecodedCall
}

// Decode entries only exist for targets with a verified ABI — for anything
// else the raw args already say all that is known. A verified target whose
// arguments cannot be decoded still gets its selector-only fallback entry.
export async function decodeEvmCallSites(callName: string, callArgs: unknown): Promise<DecodedEvmCall[]> {
  const out: DecodedEvmCall[] = []
  for (const site of collectEvmCalls(callName, callArgs)) {
    const indexes = await getContractAbiIndexes(site.target)
    if (!indexes) continue
    out.push({
      target: site.target,
      contractName: verifiedContractInfo(site.target)?.name || null,
      call: decodeFunctionInput(indexes, site.input),
    })
  }
  return out
}

// --- event-row decoration ------------------------------------------------------

export type EvmLogDecode = Extract<DecodedLog, { decoded: true }>

// The log carried by an EVM.Log event's args_json: `{log:{address,topics,data}}`
// as raw_events stores it (with tolerance for a flat shape, mirroring
// src/raw/evmLogs.ts's parseRawEvmLog).
export function evmLogFromEventArgs(args: unknown): { address: string; topics: string[]; data: string } | null {
  if (args == null || typeof args !== 'object') return null
  const outer = args as Record<string, unknown>
  const log = (outer.log != null && typeof outer.log === 'object' ? outer.log : outer) as Record<string, unknown>
  const { address, topics, data } = log
  if (typeof address !== 'string' || !H160_RE.test(address)) return null
  if (!Array.isArray(topics) || !topics.every(t => typeof t === 'string')) return null
  if (typeof data !== 'string') return null
  return { address: address.toLowerCase(), topics: topics as string[], data }
}

export async function decodeEvmLogArgs(args: unknown): Promise<EvmLogDecode | null> {
  const log = evmLogFromEventArgs(args)
  if (!log) return null
  const indexes = await getContractAbiIndexes(log.address)
  if (!indexes) return null
  const decoded = decodeEventLog(indexes, log.topics, log.data)
  return decoded.decoded ? decoded : null
}

// Decorate already-fetched event rows in place: EVM.Log rows whose contract has
// a verified ABI gain `evmDecoded`; everything else is left untouched. In-memory
// except for each contract's single cached ABI read.
export async function attachEvmLogDecodes<T extends { name: string; args: unknown; evmDecoded?: EvmLogDecode }>(rows: T[]): Promise<void> {
  for (const row of rows) {
    if (row.name !== 'EVM.Log') continue
    const decoded = await decodeEvmLogArgs(row.args)
    if (decoded) row.evmDecoded = decoded
  }
}

// --- per-contract cached indexes ---------------------------------------------

// Only bytecode-matched or externally attested ABIs may drive decoding labelled
// "verified" (§4.1) — a manually uploaded ABI is neither.
function decodeEligible(source: string): boolean {
  return source === 'verified' || source === 'import:blockscout'
}

// The cache key carries `verifiedAt`: a re-verification rotates the key instead
// of needing an eviction API (same pattern as the ABI/sources payload caches).
// Warm hits cost zero ClickHouse reads — the single primary-key ABI fetch runs
// at most once per (address, verifiedAt) per hour.
export async function getContractAbiIndexes(address: string): Promise<AbiIndexes | null> {
  const addr = address.toLowerCase()
  const info = verifiedContractInfo(addr)
  if (!info?.abiPresent || !decodeEligible(info.source)) return null
  return cached(`contract:abi-index:${addr}:${info.verifiedAt}`, 3_600_000, async () => {
    const payload = await getContractAbiPayload(addr)
    return payload ? buildAbiIndexes(payload.abi) : null
  })
}
