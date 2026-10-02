// Pure decoding and cadence arithmetic for the explorer's oracle surface
// (services/oracleService.ts). No I/O: every function here is a deterministic
// map from chain bytes / indexed rows to values, so the tests pin them directly.
//
// Integer discipline: feed answers, DIA values and EMA rationals stay bigint until
// they are rendered as a decimal STRING here; nothing routes a price through a
// float on the way to the wire.

/** topic0 of every log the oracle ledger reads, by event. */
export const ORACLE_TOPICS = {
  // DIA OracleUpdate(string key, uint128 value, uint128 timestamp) — nothing indexed.
  oracleUpdate: '0xa7fc99ed7617309ee23f63ae90196a1e490d362e6f6a547a59bc809ee2291782',
  // Chainlink-style PriceUpdated(uint80 indexed roundId, int256 answer, uint256 timestamp).
  priceUpdated: '0x7d8cee5d1217e47a14a662098e84a7758580aaf78f430c07c543249234e867bf',
  // AaveOracle AssetSourceUpdated(address indexed asset, address indexed source).
  assetSourceUpdated: '0x22c5b7b2d8561d39f7f210b6b326a1aa69f15311163082308ac4877db6339dc1',
  // DIA UpdaterAddressChange(address newUpdater) — nothing indexed.
  updaterAddressChange: '0x121e958a4cadf7f8dadefa22cc019700365240223668418faebed197da07089f',
} as const

const hexBody = (hex: string): string => (hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex)

/** The `index`-th 32-byte word of ABI data as an unsigned bigint; null when the data is too short. */
export function abiWord(data: string, index: number): bigint | null {
  const h = hexBody(data)
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length < 64 * (index + 1)) return null
  return BigInt('0x' + h.slice(64 * index, 64 * (index + 1)))
}

/** A 32-byte word read as a two's-complement int256. */
export function toInt256(word: bigint): bigint {
  return word >= 1n << 255n ? word - (1n << 256n) : word
}

/** The low 20 bytes of a word / topic as a lowercase 0x address. */
export function wordAddress(word: bigint | null): string | null {
  if (word == null) return null
  return '0x' + (word & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')
}

function topicAddress(topic: string | undefined): string | null {
  if (!topic) return null
  const h = hexBody(topic)
  if (!/^[0-9a-fA-F]{64}$/.test(h)) return null
  return wordAddress(BigInt('0x' + h))
}

/** A dynamic `string` at byte `offset` of ABI data. */
function abiString(data: string, offsetWord: bigint | null): string | null {
  if (offsetWord == null) return null
  const h = hexBody(data)
  const off = Number(offsetWord) * 2
  if (!Number.isSafeInteger(off) || off + 64 > h.length) return null
  const len = Number(BigInt('0x' + h.slice(off, off + 64)))
  if (!Number.isSafeInteger(len) || len > 256 || off + 64 + len * 2 > h.length) return null
  const bytes = h.slice(off + 64, off + 64 + len * 2)
  let out = ''
  for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16))
  return out
}

export interface DiaUpdate { key: string; value: bigint; timestamp: number }
/** DIA `OracleUpdate(string key, uint128 value, uint128 timestamp)`: the value is in the key's 8-decimal base unit. */
export function decodeOracleUpdate(data: string): DiaUpdate | null {
  const key = abiString(data, abiWord(data, 0))
  const value = abiWord(data, 1)
  const ts = abiWord(data, 2)
  if (key == null || !key.length || value == null || ts == null) return null
  return { key, value, timestamp: Number(ts) }
}

export interface PushUpdate { roundId: bigint | null; answer: bigint; timestamp: number }
/**
 * `PriceUpdated(uint80 indexed roundId, int256 answer, uint256 timestamp)`: the
 * round is topic 1 (null when the caller did not read the topics — the answer and
 * its timestamp are the data).
 */
export function decodePriceUpdated(topics: readonly string[], data: string): PushUpdate | null {
  const t1 = topics[1] ? hexBody(topics[1]) : ''
  const round = /^[0-9a-fA-F]{1,64}$/.test(t1) ? BigInt('0x' + t1) : null
  const answer = abiWord(data, 0)
  const ts = abiWord(data, 1)
  if (answer == null || ts == null) return null
  return { roundId: round, answer: toInt256(answer), timestamp: Number(ts) }
}

/** AaveOracle `AssetSourceUpdated(address indexed asset, address indexed source)`. */
export function decodeAssetSourceUpdated(topics: readonly string[]): { asset: string; source: string } | null {
  const asset = topicAddress(topics[1])
  const source = topicAddress(topics[2])
  return asset && source ? { asset, source } : null
}

/** DIA `UpdaterAddressChange(address newUpdater)`. */
export function decodeUpdaterAddressChange(data: string): string | null {
  return wordAddress(abiWord(data, 0))
}

// ── EmaOracle ───────────────────────────────────────────────────────────────

export const EMA_PERIODS = ['LastBlock', 'Short', 'TenMinutes', 'Hour', 'Day', 'Week'] as const
export type EmaPeriod = typeof EMA_PERIODS[number]

/** An 8-byte source id ("0x6f6d6e69706f6f6c") as its ASCII name ("omnipool"). */
export function sourceAscii(hex: string): string {
  const h = hexBody(hex)
  let out = ''
  for (let i = 0; i + 1 < h.length; i += 2) {
    const c = parseInt(h.slice(i, i + 2), 16)
    if (c >= 32 && c < 127) out += String.fromCharCode(c)
  }
  return out
}

/**
 * EmaOracle's `assets` pair. The decoder hands a pair of ids that both fit in a
 * byte over as a hex byte string ("0x050f" = [5, 15]) and any other pair as a
 * JSON array; both forms name the same (asset_a, asset_b).
 */
export function parseEmaAssets(raw: unknown): [number, number] | null {
  if (Array.isArray(raw) && raw.length === 2) {
    const a = Number(raw[0]), b = Number(raw[1])
    return Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 0 && b >= 0 ? [a, b] : null
  }
  if (typeof raw === 'string' && /^0x[0-9a-fA-F]{4}$/.test(raw)) {
    return [parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16)]
  }
  return null
}

export interface EmaRatio { n: bigint; d: bigint }
export interface EmaUpdate {
  source: string
  assetA: number
  assetB: number
  /** n/d per period: raw units of asset A per raw unit of asset B. */
  prices: Partial<Record<EmaPeriod, EmaRatio>>
}

/** `EmaOracle.OracleUpdated { source, assets, updates: [[{__kind: period}, {n, d}], …] }`. */
export function decodeEmaOracleUpdated(args: unknown): EmaUpdate | null {
  let a = args
  if (typeof a === 'string') {
    try { a = JSON.parse(a) } catch { return null }
  }
  const o = (a ?? {}) as { source?: unknown; assets?: unknown; updates?: unknown }
  if (typeof o.source !== 'string') return null
  const pair = parseEmaAssets(o.assets)
  if (!pair) return null
  return { source: sourceAscii(o.source), assetA: pair[0], assetB: pair[1], prices: decodeEmaPeriods(o.updates) }
}

/** The event's `updates` — `[[{__kind: period}, {n, d}], …]`, as JSON text or parsed — as n/d per period; a malformed entry is left out. */
export function decodeEmaPeriods(raw: unknown): Partial<Record<EmaPeriod, EmaRatio>> {
  let list = raw
  if (typeof list === 'string') {
    try { list = JSON.parse(list) } catch { return {} }
  }
  const prices: Partial<Record<EmaPeriod, EmaRatio>> = {}
  for (const u of Array.isArray(list) ? list : []) {
    if (!Array.isArray(u) || u.length !== 2) continue
    const kind = (u[0] as { __kind?: unknown } | null)?.__kind
    const r = u[1] as { n?: unknown; d?: unknown } | null
    if (typeof kind !== 'string' || !(EMA_PERIODS as readonly string[]).includes(kind)) continue
    try {
      const n = BigInt(String(r?.n)), d = BigInt(String(r?.d))
      if (d > 0n && n >= 0n) prices[kind as EmaPeriod] = { n, d }
    } catch { /* malformed ratio: period left out */ }
  }
  return prices
}

/** `num / den` as an exact decimal string with at most `digits` fractional digits (truncated), trailing zeros dropped. */
export function ratioDecimal(num: bigint, den: bigint, digits = 18): string {
  if (den === 0n) return '0'
  const neg = (num < 0n) !== (den < 0n)
  const n = num < 0n ? -num : num
  const d = den < 0n ? -den : den
  const scaled = (n * 10n ** BigInt(digits)) / d
  const s = scaled.toString().padStart(digits + 1, '0')
  const whole = s.slice(0, s.length - digits)
  const frac = s.slice(s.length - digits).replace(/0+$/, '')
  return (neg && scaled !== 0n ? '-' : '') + whole + (frac ? '.' + frac : '')
}

/**
 * An EMA ratio as the price of ONE asset B in asset A, decimals applied:
 * n/d is raw A per raw B, so 1 B = n/d × 10^(decB − decA) A. Bifrost's [5, 15]
 * at n/d ≈ 1.6625 (both 10-decimal) reads "1 vDOT = 1.6625 DOT".
 */
export function emaPriceDecimal(r: EmaRatio, decA: number, decB: number, digits = 18): string {
  const shift = decB - decA
  return shift >= 0
    ? ratioDecimal(r.n * 10n ** BigInt(shift), r.d, digits)
    : ratioDecimal(r.n, r.d * 10n ** BigInt(-shift), digits)
}

/** A base-unit integer with `decimals` as an exact decimal string. */
export function unitsDecimal(value: bigint, decimals: number): string {
  return ratioDecimal(value, 10n ** BigInt(Math.max(0, decimals)), Math.max(0, decimals))
}

/**
 * Hydration's runtime oracle adapter address: 0x000001 · period byte · 8-byte
 * source · asset_a (u32 BE) · asset_b (u32 BE). The period byte indexes the EMA
 * periods in their declared order (00 LastBlock … 02 TenMinutes …).
 */
export function decodeOracleAdapterAddress(address: string): { period: EmaPeriod | null; source: string; assetA: number; assetB: number } | null {
  const h = hexBody(address).toLowerCase()
  if (!/^000001[0-9a-f]{34}$/.test(h)) return null
  const periodByte = parseInt(h.slice(6, 8), 16)
  return {
    period: EMA_PERIODS[periodByte] ?? null,
    source: sourceAscii(h.slice(8, 24)),
    assetA: parseInt(h.slice(24, 32), 16),
    assetB: parseInt(h.slice(32, 40), 16),
  }
}

/**
 * Whether runtime bytecode can only return a constant: it never reads storage,
 * calls out, or asks the environment for anything but the clock (TIMESTAMP and
 * NUMBER are allowed — an `updatedAt` of "now" is still a constant answer).
 * Walks the opcodes, skipping PUSH data, so a 0x54 byte inside an immediate is
 * not mistaken for SLOAD.
 */
export function bytecodeIsConstant(code: string): boolean {
  let h = hexBody(code)
  if (!h.length || h.length % 2) return false
  // Solidity appends CBOR metadata whose length is the last two bytes; it is
  // data, not code, and its bytes would read as opcodes.
  const metaLen = parseInt(h.slice(-4), 16)
  if (Number.isFinite(metaLen) && metaLen > 0 && (metaLen + 2) * 2 < h.length && h.slice(-(metaLen + 2) * 2, -(metaLen + 2) * 2 + 2) === 'a2') {
    h = h.slice(0, h.length - (metaLen + 2) * 2)
  }
  const banned = new Set([
    0x31, 0x32, 0x33, 0x3b, 0x3c, 0x3f, 0x40, 0x41, 0x44, 0x45, 0x46, 0x47, 0x48, // balance/origin/caller/extcode*/blockhash/coinbase/…
    0x54, 0x55, 0x5c, 0x5d, // SLOAD SSTORE TLOAD TSTORE
    0xf0, 0xf1, 0xf2, 0xf4, 0xf5, 0xfa, 0xff, // CREATE CALL CALLCODE DELEGATECALL CREATE2 STATICCALL SELFDESTRUCT
  ])
  for (let i = 0; i < h.length; i += 2) {
    const op = parseInt(h.slice(i, i + 2), 16)
    if (banned.has(op)) return false
    if (op >= 0x60 && op <= 0x7f) i += (op - 0x5f) * 2
  }
  return true
}

// ── cadence & staleness ─────────────────────────────────────────────────────

export const DAY_SEC = 86_400
/** The span a feed's cadence is judged over: its last 30 days of updates. */
export const CADENCE_SPAN_SEC = 30 * DAY_SEC
/** A feed with no update for this long is retired, not stale. */
export const RETIRED_AFTER_SEC = 30 * DAY_SEC
/** Below this many updates in the span there is no cadence to judge by; the 24H heartbeat fallback applies. */
export const MIN_CADENCE_UPDATES = 3
export const FALLBACK_HEARTBEAT_SEC = DAY_SEC
export const MIN_GRACE_SEC = 900

export interface CadenceStats {
  /** Updates in the span (the 30 days ending at the newest update). */
  updates: number
  /** Median interval between consecutive updates in the span. */
  medianIntervalSec: number | null
  /** Longest interval between two consecutive updates in the span — the wait the feed has shown it makes. */
  longestGapSec: number | null
}

/** Cadence over the 30 days ending at the newest of `timestamps` (unix seconds, any order). */
export function cadenceStats(timestamps: readonly number[]): CadenceStats {
  if (!timestamps.length) return { updates: 0, medianIntervalSec: null, longestGapSec: null }
  const sorted = [...timestamps].sort((a, b) => a - b)
  const last = sorted[sorted.length - 1]
  const span = sorted.filter(t => t >= last - CADENCE_SPAN_SEC)
  const gaps: number[] = []
  for (let i = 1; i < span.length; i++) gaps.push(span[i] - span[i - 1])
  if (!gaps.length) return { updates: span.length, medianIntervalSec: null, longestGapSec: null }
  const g = [...gaps].sort((a, b) => a - b)
  const mid = Math.floor(g.length / 2)
  const median = g.length % 2 ? g[mid] : (g[mid - 1] + g[mid]) / 2
  return { updates: span.length, medianIntervalSec: median, longestGapSec: g[g.length - 1] }
}

/**
 * How old a feed's newest update may be before the feed is STALE: its heartbeat plus a
 * grace. The heartbeat is the longest gap it showed over its last 30 days of updates —
 * a deviation feed's quiet-market wait, a heartbeat feed's beat (DIA's 24H) — and the
 * grace is max(15 min, 10 % of it). Two median intervals are never the bound: the median
 * never exceeds the longest gap, so 2 × median could only pass heartbeat + grace for a
 * feed whose median IS its heartbeat (USDC/USDT's exact 24H), and would let it go 48H.
 * With fewer than three updates in that span there is no cadence: the heartbeat is 24H.
 */
export function staleAfterSec(stats: CadenceStats): number {
  const heartbeat = stats.updates >= MIN_CADENCE_UPDATES && stats.longestGapSec != null ? stats.longestGapSec : FALLBACK_HEARTBEAT_SEC
  return heartbeat + Math.max(MIN_GRACE_SEC, Math.round(heartbeat * 0.1))
}

export type FeedStatus = 'live' | 'stale' | 'retired' | 'static'

/**
 * A delivery feed's state. STATIC: it has published fewer than three values in
 * its whole life — a value set by hand (a constant installed as a feed, a
 * parameter changed once), not a stream, so it has no cadence to fall behind.
 * RETIRED: no update for 30 days. STALE: older than its own staleAfterSec.
 * Otherwise LIVE.
 */
export function feedStatus(input: { lastUpdateSec: number | null; nowSec: number; allTimeUpdates: number; staleAfter: number }): FeedStatus {
  if (input.lastUpdateSec == null || input.allTimeUpdates < MIN_CADENCE_UPDATES) return 'static'
  const age = input.nowSec - input.lastUpdateSec
  if (age > RETIRED_AFTER_SEC) return 'retired'
  return age > input.staleAfter ? 'stale' : 'live'
}

/** Count of `timestamps` (ascending) at or after `fromSec`. */
export function countSince(ascending: readonly number[], fromSec: number): number {
  let lo = 0, hi = ascending.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ascending[mid] < fromSec) lo = mid + 1
    else hi = mid
  }
  return ascending.length - lo
}
