import type { ClickHouseClient } from '../db/client.ts'
import { cached, cachedSwr } from './cache.ts'
import { MM_MARKETS, assetIdFromMmAddress, currentPriceAssetId, currentPriceOf, displayDescriptor, type ExplorerAsset } from './explorerAssets.ts'
import { accountRef, cutoffHeightForWindow, ensurePrices, indexedRawHead, priceIsOracleFallback, type AccountRef } from './explorerService.ts'
import { iso } from './isoTimestamp.ts'

/** A unix-seconds instant on the wire (isoS() takes milliseconds). */
const isoS = (sec: number): string => iso(sec * 1000)
import { makeGrain } from './historyGrain.ts'
import { queryOHLCV, type OHLCVInterval } from './ohlcvService.ts'
import { decodePegSource } from './poolService.ts'
import { currentStableswapShareState } from './stableswapSharePools.ts'
import { SUBSTRATE_RPC_URL } from './substrateRpc.ts'
import {
  CADENCE_SPAN_SEC, DAY_SEC, EMA_PERIODS, ORACLE_TOPICS, RETIRED_AFTER_SEC,
  abiWord, bytecodeIsConstant, cadenceStats, countSince, decodeAssetSourceUpdated, decodeEmaPeriods, sourceAscii,
  decodeOracleAdapterAddress, decodeOracleUpdate, decodePriceUpdated, decodeUpdaterAddressChange, emaPriceDecimal,
  feedStatus, ratioDecimal, staleAfterSec, toInt256, unitsDecimal, wordAddress,
  type CadenceStats, type EmaPeriod, type EmaRatio, type FeedStatus,
} from './oracleDecode.ts'

// The explorer's oracle surface (/oracles, /oracle/:feed): which prices Hydration
// takes from outside or from its own oracles, who delivers them, whether they are
// fresh, and whether they agree with the market. Three sources, each read the
// cheapest way that is exact:
//
//  * LIVE STATE — every money market's AaveOracle (getSourceOfAsset /
//    getAssetPrice per reserve) and every source behind it (latestRoundData,
//    latestAnswer, description, decimals, owner and the getters that name an
//    adapter's inputs) at ONE pinned block. node-full eth_call, so it runs as a
//    coordinated background-refresher task (`oracle-state`, backgroundRefresh.ts)
//    into memory and never on a request path.
//  * DELIVERY HISTORY — every DIA `OracleUpdate`, Chainlink-style `PriceUpdated`,
//    AaveOracle `AssetSourceUpdated` and DIA `UpdaterAddressChange` log, from the
//    MV-fed `oracle_feed_logs` (clickhouse/schema 001/003: those four topic0s, any
//    contract, block-keyed). The whole history is a few tens of MiB, read once in
//    LOG_WINDOW_BLOCKS windows into an in-process ledger, then only the tail above
//    a settled floor.
//  * EMA ORACLE — `EmaOracle.OracleUpdated`, from the MV-fed `ema_oracle_updates`
//    (pair-keyed; Short/Day ratios as floats for all history, the exact n/d of every
//    period for the last 40 days). The ledger holds EMA_WINDOW_SEC (30 days) of
//    per-pair update times and hourly Short/Day samples, read from the narrow
//    columns, and the exact rows of each pair's newest EMA_RECENT_UPDATES; longer
//    charts (12M / All) read the float columns per pair on request.
//
// What is TRUE about the adapters, and how each is shown (all verified on chain):
//  * DIA adapters ("X/USD Oracle") read a DIA key on every call: roundId is the
//    current block and updatedAt is the key's own DIA timestamp — so their
//    freshness is the DIA key's update history, never the round.
//  * Composite adapters (vDOT, GDOT, GETH, 3-Pool, GSOL, HEURC, stHDX) have no
//    rounds; they name a ratio source and a USD source and answer their product,
//    which the read re-checks (`verified`), so the components shown are the ones
//    the price is actually made of.
//  * The MMOracle 0xaafd… (pool 690's vDOT peg) answers an EMA rate times a
//    discount feed; its own updatedAt is frozen by design, so its freshness is the
//    EMA pair's (Bifrost's XCM pushes).
//  * A source whose bytecode can only return a constant is Fixed; a push feed that
//    has published exactly one value is Fixed too ("never updated since …").

let client: ClickHouseClient
// Every read carries its tag as log_comment, so system.query_log attributes it
// (a leading SQL comment is not always kept in the logged text).
function tagged(c: ClickHouseClient): ClickHouseClient {
  return new Proxy(c, {
    get(target, prop, recv) {
      if (prop !== 'query') return Reflect.get(target, prop, recv)
      return (params: Parameters<ClickHouseClient['query']>[0]) => {
        const tag = /--\s*(oracles:[a-z-]+)/.exec(String((params as { query?: string }).query ?? ''))?.[1]
        return target.query(tag ? { ...params, clickhouse_settings: { ...(params as { clickhouse_settings?: object }).clickhouse_settings, log_comment: tag } } as typeof params : params)
      }
    },
  })
}
export function initOracleService(c: ClickHouseClient): void {
  client = tagged(c)
  // The history loads are ClickHouse-only and take a while on a cold process;
  // start them off the boot path, they serve whatever they hold meanwhile.
  void ensureLogLedger().catch(err => console.error('[oracles] log ledger load failed', err))
  setTimeout(() => {
    void (async () => {
      await ensureEmaLedger()
      await emaInit
      await ledgerInit
      // Build the overview once off-request, so the first reader gets a warm copy.
      await getOraclesOverview()
    })().catch(err => console.error('[oracles] EMA ledger load / overview prewarm failed', err))
  }, 5_000).unref?.()
}

// ── constants ────────────────────────────────────────────────────────────────

const SEL = {
  addressesProvider: '0x0542975c', // Pool.ADDRESSES_PROVIDER()
  getReservesList: '0xd1946dbc', // Pool.getReservesList()
  getPriceOracle: '0xfca513a8', // PoolAddressesProvider.getPriceOracle()
  baseCurrencyUnit: '0x8c89b64f', // AaveOracle.BASE_CURRENCY_UNIT()
  getFallbackOracle: '0x6210308c', // AaveOracle.getFallbackOracle()
  getAssetPrice: '0xb3596f07', // AaveOracle.getAssetPrice(address)
  getSourceOfAsset: '0x92bf2be0', // AaveOracle.getSourceOfAsset(address)
  latestRoundData: '0xfeaf968c',
  latestAnswer: '0x50d25bcd',
  latestTimestamp: '0x8205bf6a',
  description: '0x7284e416',
  decimals: '0x313ce567',
  owner: '0x8da5cb5b',
  // The adapters are unverified; these getters were identified by what they
  // return (and the composites' answer is re-checked against them below):
  diaOracle: '0x7d07db3c', // DIA adapter → the DIA oracle contract it reads
  diaKey: '0x06f94331', // DIA adapter → the key it reads ("DOT/USD")
  compositeRatio: '0xe94cb14e', // composite adapter → its ratio source (an EMA adapter)
  compositeUsd: '0x4bec3090', // composite adapter → its USD source
  mmOracleEma: '0xbf7ff2c8', // MMOracle → its EMA adapter
  mmOracleDiscount: '0x9fc65b10', // MMOracle → its discount feed
} as const

const PROBE_SELECTORS = [
  SEL.latestRoundData, SEL.latestAnswer, SEL.latestTimestamp, SEL.description, SEL.decimals, SEL.owner,
  SEL.diaOracle, SEL.diaKey, SEL.compositeRatio, SEL.compositeUsd, SEL.mmOracleEma, SEL.mmOracleDiscount,
] as const

// oracle_feed_logs holds ~185k rows over ~15M blocks, the densest stretch ~10k per 1M
// blocks, so a 2M-block window stays far under the client's 100k-row guard.
const LOG_WINDOW_BLOCKS = 2_000_000
const TAIL_CHUNK_BLOCKS = 200_000
const REORG_MARGIN_BLOCKS = 600
const TAIL_MIN_INTERVAL_MS = 15_000
export const EMA_WINDOW_SEC = 30 * DAY_SEC
// The EMA tail's block window: ~42k blocks and ~30k updates a day (2 s blocks), so a full
// window is ~43k rows.
const EMA_WINDOW_BLOCKS = 60_000
export const EMA_RECENT_UPDATES = 500
const SNAPSHOT_MAX_AGE_MS = 20 * 60_000
const PAGE_SIZE = 25

const EMA_SOURCE_LABELS: Record<string, string> = {
  omnipool: 'Omnipool', stablesw: 'Stableswap', hydraxyk: 'XYK', uniswpv3: 'Uniswap v3', bifrosto: 'Bifrost', gigahdxs: 'GigaHDX',
}
/** A source's name; one of eight zero bytes has none and is named by its id. */
export const emaSourceLabel = (s: string): string => EMA_SOURCE_LABELS[s] ?? (s ? s : 'Source 0x0000000000000000')

const lc = (a: string) => a.toLowerCase()
const evmAccount = (h160: string): AccountRef => accountRef('0x45544800' + lc(h160).slice(2) + '0'.repeat(16))

// ── RPC ──────────────────────────────────────────────────────────────────────

export interface RpcCall { method: string; params: unknown[] }
/** Batched JSON-RPC; an error, revert or unanswered call is null, never a value. */
export type RpcBatch = (calls: RpcCall[]) => Promise<(string | null)[]>

async function rpcBatch(calls: RpcCall[]): Promise<(string | null)[]> {
  const out: (string | null)[] = calls.map(() => null)
  for (let start = 0; start < calls.length; start += 50) {
    const chunk = calls.slice(start, start + 50)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    try {
      const res = await fetch(SUBSTRATE_RPC_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify(chunk.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method, params: c.params }))),
      })
      if (!res.ok) continue
      const json = await res.json() as unknown
      for (const item of Array.isArray(json) ? json : []) {
        const { id, result } = (item ?? {}) as { id?: unknown; result?: unknown }
        if (!Number.isInteger(id) || (id as number) < 0 || (id as number) >= chunk.length) continue
        if (typeof result === 'string' && /^0x[0-9a-f]*$/i.test(result)) out[start + (id as number)] = result
      }
    } catch { /* chunk stays null */ } finally { clearTimeout(timer) }
  }
  return out
}

const arg = (address: string) => lc(address).slice(2).padStart(64, '0')
const addrOf = (hex: string | null): string | null => {
  const a = wordAddress(hex ? abiWord(hex, 0) : null)
  return a && a !== '0x0000000000000000000000000000000000000000' ? a : null
}
function abiStringReturn(hex: string | null): string | null {
  if (!hex) return null
  const off = abiWord(hex, 0)
  if (off == null) return null
  const h = hex.slice(2)
  const o = Number(off) * 2
  if (!Number.isSafeInteger(o) || o + 64 > h.length) return null
  const len = Number(BigInt('0x' + h.slice(o, o + 64)))
  if (!Number.isSafeInteger(len) || len > 128 || o + 64 + len * 2 > h.length) return null
  const s = Buffer.from(h.slice(o + 64, o + 64 + len * 2), 'hex').toString('utf8')
  return s.length ? s : null
}

// ── live state (refresher) ───────────────────────────────────────────────────

export interface SourceRead {
  address: string
  description: string | null
  decimals: number | null
  owner: string | null
  round: { roundId: string; answer: string; updatedAt: number } | null
  /** latestAnswer as a signed integer string (the source's own decimals). */
  answer: string | null
  latestTimestamp: number | null
  dia: { oracle: string; key: string } | null
  composite: { ratio: string; usd: string; verified: boolean } | null
  mmOracle: { ema: string; discount: string; verified: boolean } | null
  /** Runtime EMA adapter (0x000001…): decoded from the address itself. */
  ema: { period: EmaPeriod | null; source: string; assetA: number; assetB: number } | null
  constant: boolean
}

export interface MarketRead {
  key: string
  label: string
  pool: string
  oracle: string | null
  fallbackOracle: string | null
  /** BASE_CURRENCY_UNIT as a string ("100000000" = USD at 8 decimals). */
  baseUnit: string | null
  reserves: { address: string; assetId: number | null; price: string | null; source: string | null }[]
}

export interface OracleSnapshot {
  readAtMs: number
  block: number | null
  markets: MarketRead[]
  sources: Map<string, SourceRead>
}

let snapshot: OracleSnapshot | null = null
const codeCache = new Map<string, { constant: boolean; at: number }>()
const CODE_TTL_MS = 3_600_000

/** The answer of `a × b / 10^dec` agrees with `answer` to one base unit (the adapters truncate). */
function productMatches(answer: string | null, a: string | null, b: string | null, dec: number): boolean {
  if (answer == null || a == null || b == null) return false
  const prod = (BigInt(a) * BigInt(b)) / 10n ** BigInt(dec)
  const diff = prod - BigInt(answer)
  return diff >= -1n && diff <= 1n
}

/**
 * Read every market's oracle plumbing and every source behind it at one block.
 * `extraSources` adds sources nothing in a market names (stableswap peg sources,
 * the push feeds the log ledger knows) so their live answer is read too.
 */
export async function readOracleState(extraSources: string[], rpc: RpcBatch = rpcBatch, nowMs = Date.now()): Promise<OracleSnapshot | null> {
  const [blockHex] = await rpc([{ method: 'eth_blockNumber', params: [] }])
  if (!blockHex) return null
  const tag = blockHex
  const call = (to: string, data: string): RpcCall => ({ method: 'eth_call', params: [{ to, data }, tag] })

  const plumbing = await rpc(MM_MARKETS.flatMap(m => [call(m.poolProxy, SEL.addressesProvider), call(m.poolProxy, SEL.getReservesList)]))
  const providers = MM_MARKETS.map((_, i) => addrOf(plumbing[2 * i]))
  const reserveLists = MM_MARKETS.map((_, i) => decodeAddressList(plumbing[2 * i + 1]))
  const oracleHex = await rpc(providers.map(p => call(p ?? MM_MARKETS[0].poolProxy, SEL.getPriceOracle)))
  const oracles = providers.map((p, i) => (p ? addrOf(oracleHex[i]) : null))

  const marketCalls: RpcCall[] = []
  MM_MARKETS.forEach((_, i) => {
    const o = oracles[i]
    if (!o) return
    marketCalls.push(call(o, SEL.baseCurrencyUnit), call(o, SEL.getFallbackOracle))
    for (const r of reserveLists[i]) marketCalls.push(call(o, SEL.getAssetPrice + arg(r)), call(o, SEL.getSourceOfAsset + arg(r)))
  })
  const marketRes = await rpc(marketCalls)
  let cursor = 0
  const markets: MarketRead[] = MM_MARKETS.map((m, i) => {
    const o = oracles[i]
    if (!o) return { key: m.key, label: m.label, pool: m.poolProxy, oracle: null, fallbackOracle: null, baseUnit: null, reserves: [] }
    const unit = abiWord(marketRes[cursor] ?? '0x', 0)
    const fallback = addrOf(marketRes[cursor + 1])
    cursor += 2
    const reserves = reserveLists[i].map(r => {
      const price = abiWord(marketRes[cursor] ?? '0x', 0)
      const source = addrOf(marketRes[cursor + 1])
      cursor += 2
      return { address: r, assetId: assetIdFromMmAddress(r), price: price == null ? null : price.toString(), source }
    })
    return { key: m.key, label: m.label, pool: m.poolProxy, oracle: o, fallbackOracle: fallback, baseUnit: unit == null ? null : unit.toString(), reserves }
  })

  // Probe every source, then the inputs the probes name, until nothing new appears.
  const sources = new Map<string, SourceRead>()
  let pending = [...new Set([...markets.flatMap(m => m.reserves.map(r => r.source)), ...extraSources].filter((a): a is string => !!a).map(lc))]
  for (let round = 0; round < 4 && pending.length; round++) {
    const probes = await rpc(pending.flatMap(a => PROBE_SELECTORS.map(s => call(a, s))))
    const next: string[] = []
    pending.forEach((address, i) => {
      const r = (k: number) => probes[i * PROBE_SELECTORS.length + k]
      const lrd = r(0)
      const roundId = lrd ? abiWord(lrd, 0) : null
      const roundAnswer = lrd ? abiWord(lrd, 1) : null
      const roundUpdated = lrd ? abiWord(lrd, 3) : null
      const dec = r(4) ? abiWord(r(4)!, 0) : null
      const latest = r(1) ? abiWord(r(1)!, 0) : null
      const diaOracle = addrOf(r(6)), diaKey = abiStringReturn(r(7))
      const ratio = addrOf(r(8)), usd = addrOf(r(9)), mmEma = addrOf(r(10)), discount = addrOf(r(11))
      const read: SourceRead = {
        address,
        description: abiStringReturn(r(3)),
        decimals: dec != null && dec < 78n ? Number(dec) : null,
        owner: addrOf(r(5)),
        round: roundId != null && roundAnswer != null && roundUpdated != null
          ? { roundId: roundId.toString(), answer: toInt256(roundAnswer).toString(), updatedAt: Number(roundUpdated) } : null,
        answer: latest == null ? null : toInt256(latest).toString(),
        latestTimestamp: r(2) ? Number(abiWord(r(2)!, 0) ?? 0n) || null : null,
        dia: diaOracle && diaKey ? { oracle: diaOracle, key: diaKey } : null,
        composite: ratio && usd ? { ratio, usd, verified: false } : null,
        mmOracle: mmEma && discount ? { ema: mmEma, discount, verified: false } : null,
        ema: decodeOracleAdapterAddress(address),
        constant: false,
      }
      sources.set(address, read)
      for (const c of [ratio, usd, mmEma, discount]) if (c && !sources.has(c) && !pending.includes(c)) next.push(c)
    })
    pending = [...new Set(next)]
  }
  // Re-check every composite against its inputs at the same block.
  for (const s of sources.values()) {
    const dec = s.decimals ?? 8
    if (s.composite) s.composite.verified = productMatches(s.answer, sources.get(s.composite.ratio)?.answer ?? null, sources.get(s.composite.usd)?.answer ?? null, dec)
    if (s.mmOracle) s.mmOracle.verified = productMatches(s.round?.answer ?? s.answer, sources.get(s.mmOracle.ema)?.answer ?? null, sources.get(s.mmOracle.discount)?.round?.answer ?? sources.get(s.mmOracle.discount)?.answer ?? null, dec)
  }
  // A source with no rounds, no named inputs and no EMA pair: is its code a constant?
  const needCode = [...sources.values()].filter(s => !s.round && !s.dia && !s.composite && !s.mmOracle && !s.ema)
    .filter(s => { const c = codeCache.get(s.address); return !c || nowMs - c.at > CODE_TTL_MS })
  if (needCode.length) {
    const codes = await rpc(needCode.map(s => ({ method: 'eth_getCode', params: [s.address, tag] })))
    needCode.forEach((s, i) => { if (codes[i]) codeCache.set(s.address, { constant: bytecodeIsConstant(codes[i]!), at: nowMs }) })
  }
  for (const s of sources.values()) s.constant = codeCache.get(s.address)?.constant ?? false
  return { readAtMs: nowMs, block: Number(BigInt(blockHex)), markets, sources }
}

function decodeAddressList(hex: string | null): string[] {
  if (!hex) return []
  const len = abiWord(hex, 1)
  if (len == null || len > 1000n) return []
  const out: string[] = []
  for (let i = 0; i < Number(len); i++) {
    const a = wordAddress(abiWord(hex, 2 + i))
    if (!a) return []
    out.push(a)
  }
  return out
}

/** Background-refresher task `oracle-state`: one pinned read of every market's oracle and source. */
export async function refreshOracleState(): Promise<void> {
  if (!client) return
  // The push feeds the live read probes come from the log history, so the first read
  // waits for it (seconds, off a narrow table) rather than describing them a cycle late.
  await ensureLogLedger().catch(() => null)
  await ledgerInit?.catch(() => null)
  const [ledger, pegs] = await Promise.all([
    ensureLogLedger().catch(() => null),
    currentPegSources().catch(() => []),
  ])
  const extra = new Set<string>()
  for (const p of pegs) if (p.source.kind === 'mmOracle' && p.source.address) extra.add(lc(p.source.address))
  for (const c of ledger?.pushContracts ?? []) extra.add(c)
  for (const ch of ledger?.sourceChanges ?? []) extra.add(ch.source)
  const next = await readOracleState([...extra])
  if (!next) return
  const first = !currentOracleSnapshot()
  snapshot = next
  // The first live read of a process: build the overview now rather than on a reader's request.
  if (first) void getOraclesOverview().catch(err => console.error('[oracles] overview prewarm failed', err))
}

export function currentOracleSnapshot(nowMs = Date.now()): OracleSnapshot | null {
  return snapshot && nowMs - snapshot.readAtMs <= SNAPSHOT_MAX_AGE_MS ? snapshot : null
}

/** Test seam. */
export function setOracleSnapshotForTest(s: OracleSnapshot | null): void { snapshot = s }

// ── log ledger (ClickHouse) ──────────────────────────────────────────────────

interface LogRow {
  b: number; e: number; x: number | null; t: number; c: string
  topic: string
  key?: string; value?: bigint; reportedAt?: number; round?: bigint | null
  asset?: string; source?: string; updater?: string
}

interface LogLedgerState {
  rows: Map<string, LogRow>
  /** Contracts read, by topic. */
  contracts: Map<string, Set<string>>
  loadedUpTo: number
  historyComplete: boolean
  version: number
}

const ledger: LogLedgerState = { rows: new Map(), contracts: new Map(), loadedUpTo: 0, historyComplete: false, version: 0 }
let ledgerInit: Promise<void> | null = null
let ledgerTail: Promise<void> | null = null
let ledgerTailAt = 0

function addLogRow(r: { block_height: number; event_index: number; extrinsic_index: number | null; t: number; contract_address: string; topic0: string; data: string; topics?: string[] }): void {
  const c = lc(r.contract_address)
  const base: LogRow = { b: Number(r.block_height), e: Number(r.event_index), x: r.extrinsic_index == null ? null : Number(r.extrinsic_index), t: Number(r.t), c, topic: r.topic0 }
  if (r.topic0 === ORACLE_TOPICS.oracleUpdate) {
    const d = decodeOracleUpdate(r.data)
    if (!d) return
    Object.assign(base, { key: d.key, value: d.value, reportedAt: d.timestamp })
  } else if (r.topic0 === ORACLE_TOPICS.priceUpdated) {
    const d = decodePriceUpdated(r.topics ?? [], r.data)
    if (!d) return
    Object.assign(base, { value: d.answer, reportedAt: d.timestamp, round: d.roundId })
  } else if (r.topic0 === ORACLE_TOPICS.assetSourceUpdated) {
    const d = decodeAssetSourceUpdated(r.topics ?? [])
    if (!d) return
    Object.assign(base, { asset: d.asset, source: d.source })
  } else if (r.topic0 === ORACLE_TOPICS.updaterAddressChange) {
    const u = decodeUpdaterAddressChange(r.data)
    if (!u) return
    Object.assign(base, { updater: u })
  } else return
  ledger.rows.set(`${base.b}:${base.e}`, base)
  let set = ledger.contracts.get(r.topic0)
  if (!set) ledger.contracts.set(r.topic0, set = new Set())
  set.add(c)
}

const LOG_COLUMNS = 'block_height, event_index, extrinsic_index, toUnixTimestamp(block_timestamp) AS t, contract_address, topic0, data, topics'

/** The whole history, in block windows (block-first key: each window is a key range). Replays dedupe by (block, event) in the ledger. */
async function loadLogHistory(head: number): Promise<void> {
  for (let lo = 0; lo < head; lo += LOG_WINDOW_BLOCKS) {
    const hi = Math.min(head, lo + LOG_WINDOW_BLOCKS)
    const r = await client.query({
      query: `-- oracles:history
        SELECT ${LOG_COLUMNS} FROM price_data.oracle_feed_logs
        WHERE block_height > {lo:UInt32} AND block_height <= {hi:UInt32}`,
      query_params: { lo, hi }, format: 'JSONEachRow',
    })
    const rows = await r.json<Parameters<typeof addLogRow>[0]>()
    for (const row of rows) addLogRow(row)
    if (rows.length) ledger.version++
  }
}

/** Every new feed log above the settled floor (a key range). */
async function readLogTail(head: number): Promise<void> {
  const floor = Math.max(0, ledger.loadedUpTo - REORG_MARGIN_BLOCKS)
  for (let lo = floor; lo < head; lo += TAIL_CHUNK_BLOCKS) {
    const hi = Math.min(head, lo + TAIL_CHUNK_BLOCKS)
    const r = await client.query({
      query: `-- oracles:tail
        SELECT ${LOG_COLUMNS} FROM price_data.oracle_feed_logs
        WHERE block_height > {lo:UInt32} AND block_height <= {hi:UInt32}`,
      query_params: { lo, hi }, format: 'JSONEachRow',
    })
    const rows = await r.json<Parameters<typeof addLogRow>[0]>()
    for (const row of rows) addLogRow(row)
    if (rows.length) ledger.version++
  }
  ledger.loadedUpTo = Math.max(ledger.loadedUpTo, head)
}

export interface LedgerView {
  version: number
  historyComplete: boolean
  feeds: Map<string, FeedSeries>
  pushContracts: string[]
  sourceChanges: { oracle: string; asset: string; source: string; b: number; e: number; x: number | null; t: number }[]
  updaterChanges: { contract: string; updater: string; b: number; e: number; x: number | null; t: number }[]
}

export interface FeedSeries {
  feedId: string
  kind: 'dia' | 'push'
  contract: string
  key: string | null
  /** Ascending by (block, event). */
  b: number[]; e: number[]; x: (number | null)[]; t: number[]; v: bigint[]; reported: number[]
}

let viewMemo: LedgerView | null = null

function buildView(): LedgerView {
  if (viewMemo && viewMemo.version === ledger.version && viewMemo.historyComplete === ledger.historyComplete) return viewMemo
  const rows = [...ledger.rows.values()].sort((a, b) => a.b - b.b || a.e - b.e)
  const feeds = new Map<string, FeedSeries>()
  const sourceChanges: LedgerView['sourceChanges'] = []
  const updaterChanges: LedgerView['updaterChanges'] = []
  for (const r of rows) {
    if (r.topic === ORACLE_TOPICS.oracleUpdate || r.topic === ORACLE_TOPICS.priceUpdated) {
      const dia = r.topic === ORACLE_TOPICS.oracleUpdate
      const id = dia ? diaFeedId(r.c, r.key!) : r.c
      let f = feeds.get(id)
      if (!f) feeds.set(id, f = { feedId: id, kind: dia ? 'dia' : 'push', contract: r.c, key: dia ? r.key! : null, b: [], e: [], x: [], t: [], v: [], reported: [] })
      f.b.push(r.b); f.e.push(r.e); f.x.push(r.x); f.t.push(r.t); f.v.push(r.value!); f.reported.push(r.reportedAt ?? r.t)
    } else if (r.topic === ORACLE_TOPICS.assetSourceUpdated) {
      sourceChanges.push({ oracle: r.c, asset: r.asset!, source: r.source!, b: r.b, e: r.e, x: r.x, t: r.t })
    } else if (r.topic === ORACLE_TOPICS.updaterAddressChange) {
      updaterChanges.push({ contract: r.c, updater: r.updater!, b: r.b, e: r.e, x: r.x, t: r.t })
    }
  }
  const pushContracts = [...feeds.values()].filter(f => f.kind === 'push').map(f => f.contract)
  viewMemo = { version: ledger.version, historyComplete: ledger.historyComplete, feeds, pushContracts, sourceChanges, updaterChanges }
  return viewMemo
}

/**
 * The ledger as it now stands. The first call starts the history load (served
 * partially, `historyComplete: false`, until it finishes); every call at most
 * TAIL_MIN_INTERVAL_MS apart reads the tail.
 */
export async function ensureLogLedger(): Promise<LedgerView> {
  if (!client) return buildView()
  if (!ledgerInit) {
    ledgerInit = (async () => {
      const head = await indexedRawHead()
      ledger.loadedUpTo = head
      try {
        await loadLogHistory(head)
        ledger.historyComplete = true
      } catch (err) {
        ledgerInit = null // retried on the next call
        throw err
      } finally {
        ledger.version++
      }
    })()
    void ledgerInit.catch(err => console.error('[oracles] log history load failed', err))
  }
  // The tail starts where the init pass pinned the head; before that there is no floor to read above.
  if (ledger.loadedUpTo > 0 && Date.now() - ledgerTailAt >= TAIL_MIN_INTERVAL_MS && !ledgerTail) {
    ledgerTailAt = Date.now()
    ledgerTail = (async () => {
      await readLogTail(await indexedRawHead())
      if (ledger.historyComplete && await belowFloorChanged('logs')) await loadLogHistory(ledger.loadedUpTo)
    })()
      .catch(err => console.error('[oracles] log tail read failed', err))
      .finally(() => { ledgerTail = null })
    await ledgerTail
  }
  return buildView()
}

// ── below-floor probes ───────────────────────────────────────────────────────

/**
 * The tails read only above a settled floor, so a row inserted BELOW it — a backfilled
 * or replayed range — would never reach a ledger. Every FLOOR_PROBE_MS the newest
 * ingest time of the rows below each floor is read (one narrow column; a version bump
 * only ever raises it) and a ledger whose figure rose is reloaded. The first probe
 * after a load sets the baseline.
 */
export const FLOOR_PROBE_MS = 300_000
const floorProbe: Record<'logs' | 'ema', { at: number; seen: number | null }> = { logs: { at: 0, seen: null }, ema: { at: 0, seen: null } }

async function belowFloorChanged(which: 'logs' | 'ema'): Promise<boolean> {
  const p = floorProbe[which]
  if (Date.now() - p.at < FLOOR_PROBE_MS) return false
  p.at = Date.now()
  const floor = which === 'logs' ? Math.max(0, ledger.loadedUpTo - REORG_MARGIN_BLOCKS) : Math.max(0, ema.maxBlock - REORG_MARGIN_BLOCKS)
  const r = await client.query({
    query: which === 'logs'
      ? `-- oracles:floor-probe
        SELECT toUnixTimestamp(max(ingested_at)) AS m FROM price_data.oracle_feed_logs WHERE block_height <= {floor:UInt32}`
      : `-- oracles:floor-probe
        SELECT toUnixTimestamp(max(ingested_at)) AS m FROM price_data.ema_oracle_updates
        WHERE block_height > {from:UInt32} AND block_height <= {floor:UInt32}`,
    query_params: { floor, from: ema.coveredFromBlock }, format: 'JSONEachRow',
  })
  const m = Number((await r.json<{ m: number }>())[0]?.m ?? 0)
  const changed = p.seen != null && m > p.seen
  p.seen = m
  return changed
}

/** Forget the probe baselines (a fresh load sets them again). */
function resetFloorProbe(which: 'logs' | 'ema'): void { floorProbe[which] = { at: 0, seen: null } }

export function diaFeedId(contract: string, key: string): string {
  return `dia:${lc(contract)}:${key}`
}

// ── EVM transaction index (pushers) ─────────────────────────────────────────

interface TxRow { from: string; to: string }
let txIndex: { at: number; rows: Map<string, TxRow> } | null = null
const olderTx = new Map<string, TxRow | null>()

/** The EVM transactions behind the feed updates: the last 32 days by partition, older blocks once. */
async function txIndexFor(view: LedgerView): Promise<Map<string, TxRow | null>> {
  if (!txIndex || Date.now() - txIndex.at > 120_000) {
    const res = await client.query({
      query: `-- oracles:txs
        SELECT block_height AS b, extrinsic_index AS x, from_address AS f, to_address AS t
        FROM price_data.evm_executed WHERE block_timestamp >= now() - INTERVAL 32 DAY AND extrinsic_index IS NOT NULL`,
      format: 'JSONEachRow',
    })
    const rows = new Map<string, TxRow>()
    for (const r of await res.json<{ b: number; x: number; f: string; t: string }>()) rows.set(`${r.b}:${r.x}`, { from: lc(r.f), to: lc(r.t) })
    txIndex = { at: Date.now(), rows }
  }
  // Older updates (a retired feed's last ones, a feed's first): read once, kept.
  const cutoff = Date.now() / 1000 - 31 * DAY_SEC
  const want: number[] = []
  for (const f of view.feeds.values()) {
    const n = f.t.length
    for (let i = Math.max(0, n - 20); i < n; i++) if (f.t[i] < cutoff && f.x[i] != null && !olderTx.has(`${f.b[i]}:${f.x[i]}`)) want.push(f.b[i])
  }
  if (want.length) {
    const blocks = [...new Set(want)]
    const res = await client.query({
      query: `-- oracles:txs-old
        SELECT block_height AS b, extrinsic_index AS x, from_address AS f, to_address AS t
        FROM price_data.evm_executed WHERE block_height IN {blocks:Array(UInt32)} AND extrinsic_index IS NOT NULL`,
      query_params: { blocks }, format: 'JSONEachRow',
    })
    const got = new Map<string, TxRow>()
    for (const r of await res.json<{ b: number; x: number; f: string; t: string }>()) got.set(`${r.b}:${r.x}`, { from: lc(r.f), to: lc(r.t) })
    for (const f of view.feeds.values()) {
      const n = f.t.length
      for (let i = Math.max(0, n - 20); i < n; i++) {
        const k = `${f.b[i]}:${f.x[i]}`
        if (f.t[i] < cutoff && f.x[i] != null && !olderTx.has(k)) olderTx.set(k, got.get(k) ?? null)
      }
    }
  }
  const out = new Map<string, TxRow | null>(olderTx)
  for (const [k, v] of txIndex.rows) out.set(k, v)
  return out
}

// ── EMA ledger (ClickHouse) ──────────────────────────────────────────────────

/** One update: its exact n/d per period when read (`prices`), its Short/Day ratios (raw units) always. */
interface EmaRow { b: number; e: number; t: number; prices: Partial<Record<EmaPeriod, EmaRatio>>; short: number | null; day: number | null }
interface EmaPairState {
  /** The source as the table stores it (8-byte hex) and as a name. */
  sourceHex: string
  source: string; a: number; b: number
  /** Update block times in the window, unsorted while loading (sorted on read). */
  times: number[]
  timesSorted: boolean
  /** Per hour (start, unix s): the newest update in it. */
  hourly: Map<number, EmaRow>
  recent: EmaRow[]
}
interface EmaLedgerState {
  pairs: Map<string, EmaPairState>
  maxBlock: number
  coveredFromBlock: number
  coveredFromSec: number
  complete: boolean
  seenTail: Set<string>
  /** The highest block a read has covered (the head at its start). */
  readUpTo: number
  version: number
}
const freshEma = (): EmaLedgerState => ({ pairs: new Map(), maxBlock: 0, coveredFromBlock: 0, coveredFromSec: 0, complete: false, seenTail: new Set(), readUpTo: 0, version: 0 })
// The served ledger. A load builds a fresh one and swaps it in whole once it has
// finished, so a load that fails half way leaves nothing behind for a retry to add twice.
let ema: EmaLedgerState = freshEma()
let emaInit: Promise<void> | null = null
let emaTail: Promise<void> | null = null
let emaTailAt = 0

/** An EMA pair's id: the pallet stores a pair in ascending id order, so the id is too (an adapter names it either way round). */
export const emaFeedId = (source: string, a: number, b: number) => `ema:${source}:${Math.min(a, b)}-${Math.max(a, b)}`

interface EmaTableRow { source: string; asset_a: number; asset_b: number; block_height: number; event_index: number; t: number; short_ratio: number; day_ratio: number; updates?: string }

/** A ratio column: 0 is the table's "absent" (an event without that period, a zero denominator). */
const ratioOrNull = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null }

function addEmaRow(row: EmaTableRow, dedupe: boolean, st: EmaLedgerState = ema): void {
  const b = Number(row.block_height), e = Number(row.event_index), t = Number(row.t)
  if (dedupe) {
    const k = `${b}:${e}`
    if (st.seenTail.has(k)) return
    st.seenTail.add(k)
  }
  const source = sourceAscii(row.source)
  const a = Number(row.asset_a), bb = Number(row.asset_b)
  const id = emaFeedId(source, a, bb)
  let p = st.pairs.get(id)
  if (!p) st.pairs.set(id, p = { sourceHex: row.source, source, a, b: bb, times: [], timesSorted: true, hourly: new Map(), recent: [] })
  const er: EmaRow = { b, e, t, prices: row.updates ? decodeEmaPeriods(row.updates) : {}, short: ratioOrNull(row.short_ratio), day: ratioOrNull(row.day_ratio) }
  if (p.times.length && t < p.times[p.times.length - 1]) p.timesSorted = false
  p.times.push(t)
  const hour = t - (t % 3600)
  const cur = p.hourly.get(hour)
  if (!cur || cur.b < b || (cur.b === b && cur.e < e)) p.hourly.set(hour, er)
  p.recent.push(er)
  if (b > st.maxBlock) st.maxBlock = b
}

function trimEma(nowSec: number, st: EmaLedgerState = ema): void {
  const floor = nowSec - EMA_WINDOW_SEC - DAY_SEC
  for (const p of st.pairs.values()) {
    if (!p.timesSorted) { p.times.sort((x, y) => x - y); p.timesSorted = true }
    if (p.times.length && p.times[0] < floor) p.times = p.times.slice(p.times.length - countSince(p.times, floor))
    for (const h of p.hourly.keys()) if (h < floor) p.hourly.delete(h)
    p.recent.sort((x, y) => x.b - y.b || x.e - y.e)
    if (p.recent.length > EMA_RECENT_UPDATES) p.recent = p.recent.slice(-EMA_RECENT_UPDATES)
  }
  if (st.seenTail.size > 50_000) {
    const keep = st.maxBlock - 2 * REORG_MARGIN_BLOCKS
    for (const k of st.seenTail) if (Number(k.split(':')[0]) < keep) st.seenTail.delete(k)
  }
}

const EMA_LIGHT_COLUMNS = 'source, asset_a, asset_b, block_height, event_index, toUnixTimestamp(block_timestamp) AS t, short_ratio, day_ratio'

/** Rows per read of one pair: well under the client's 100k-row guard (the busiest pair holds ~150k in 30 days). */
export const EMA_PAGE_ROWS = 50_000

/**
 * One pair's updates in (floor, head] from the narrow columns (no exact values): times
 * and hourly samples. A key-prefix read (the table is pair-first) paged by a
 * (block_height, event_index) keyset, ascending, so no answer passes the row guard
 * however busy the pair. FINAL: a backfilled range can overlap the MV's own rows until
 * they merge.
 */
async function readEmaPair(pair: { source: string; asset_a: number; asset_b: number }, floor: number, head: number, st: EmaLedgerState): Promise<number> {
  let minT = Infinity
  let cb = floor, ce = -1
  for (;;) {
    const r = await client.query({
      query: `-- oracles:ema
        SELECT ${EMA_LIGHT_COLUMNS} FROM price_data.ema_oracle_updates FINAL
        WHERE source = {src:String} AND asset_a = {a:UInt32} AND asset_b = {b:UInt32}
          AND block_height >= {cb:UInt32} AND block_height <= {hi:UInt32} AND block_height > {floor:UInt32}
          AND (block_height > {cb:UInt32} OR event_index > {ce:Int64})
        ORDER BY block_height, event_index LIMIT {lim:UInt32}`,
      query_params: { src: pair.source, a: pair.asset_a, b: pair.asset_b, cb, ce, hi: head, floor, lim: EMA_PAGE_ROWS }, format: 'JSONEachRow',
    })
    const rows = await r.json<EmaTableRow>()
    for (const row of rows) {
      // Rows near the head are deduped against the tail's.
      addEmaRow(row, Number(row.block_height) > head - 2 * REORG_MARGIN_BLOCKS, st)
      if (Number(row.t) < minT) minT = Number(row.t)
    }
    if (rows.length < EMA_PAGE_ROWS) break
    const last = rows[rows.length - 1]
    cb = Number(last.block_height); ce = Number(last.event_index)
  }
  return minT
}

/**
 * The exact n/d of `rows` of one pair (those not read yet): one key-prefix read over
 * their block span. At load only each pair's newest row is filled (the overview's
 * price); a table page fills its own rows when it is asked for.
 */
async function fillEmaExact(p: EmaPairState, rows: EmaRow[]): Promise<void> {
  const missing = rows.filter(r => !Object.keys(r.prices).length)
  if (!missing.length) return
  const lo = Math.min(...missing.map(r => r.b)), hi = Math.max(...missing.map(r => r.b))
  const r = await client.query({
    query: `-- oracles:ema-exact
      SELECT block_height, event_index, updates FROM price_data.ema_oracle_updates FINAL
      WHERE source = {src:String} AND asset_a = {a:UInt32} AND asset_b = {b:UInt32}
        AND block_height >= {lo:UInt32} AND block_height <= {hi:UInt32}`,
    query_params: { src: p.sourceHex, a: p.a, b: p.b, lo, hi }, format: 'JSONEachRow',
  })
  const byKey = new Map<string, string>()
  for (const row of await r.json<{ block_height: number; event_index: number; updates: string }>()) byKey.set(`${row.block_height}:${row.event_index}`, row.updates)
  for (const row of missing) {
    const u = byKey.get(`${row.b}:${row.e}`)
    if (u) row.prices = decodeEmaPeriods(u)
  }
}

/** Every pair's newest row exactly, in one read keyed by the rows themselves (the overview's prices). */
async function fillEmaLatest(pairs: EmaPairState[]): Promise<void> {
  const lasts = pairs.map(p => ({ p, r: p.recent[p.recent.length - 1] })).filter(x => x.r && !Object.keys(x.r.prices).length && /^0x[0-9a-f]{16}$/.test(x.p.sourceHex))
  if (!lasts.length) return
  // Inlined: a tuple set in a parameter does not reach the primary-key analysis. Every part is validated above (hex source, integers).
  const keys = lasts.map(({ p, r }) => `('${p.sourceHex}',${Math.trunc(p.a)},${Math.trunc(p.b)},${Math.trunc(r.b)},${Math.trunc(r.e)})`).join(',')
  const res = await client.query({
    query: `-- oracles:ema-exact
      SELECT source, asset_a, asset_b, block_height, event_index, updates FROM price_data.ema_oracle_updates
      WHERE (source, asset_a, asset_b, block_height, event_index) IN (${keys})`,
    format: 'JSONEachRow',
  })
  const byKey = new Map<string, string>()
  for (const row of await res.json<{ source: string; asset_a: number; asset_b: number; block_height: number; event_index: number; updates: string }>()) {
    byKey.set(`${row.source}:${row.asset_a}:${row.asset_b}:${row.block_height}:${row.event_index}`, row.updates)
  }
  for (const { p, r } of lasts) {
    const u = byKey.get(`${p.sourceHex}:${p.a}:${p.b}:${r.b}:${r.e}`)
    if (u) r.prices = decodeEmaPeriods(u)
  }
}

/** Build a fresh ledger of the last 30 days and swap it in; on failure the served one is untouched and the next call retries. */
function loadEmaLedger(): Promise<void> {
  const run = (async () => {
    const st = freshEma()
    const head = await indexedRawHead()
    const floor = await cutoffHeightForWindow(EMA_WINDOW_SEC / 3600, head)
    st.maxBlock = head
    st.readUpTo = head
    // The pairs the window holds (three narrow columns over the window).
    const pr = await client.query({
      query: `-- oracles:ema-pairs
        SELECT source, asset_a, asset_b FROM price_data.ema_oracle_updates
        WHERE block_height > {floor:UInt32} AND block_height <= {head:UInt32}
        GROUP BY source, asset_a, asset_b`,
      query_params: { floor, head }, format: 'JSONEachRow',
    })
    for (const pair of await pr.json<{ source: string; asset_a: number; asset_b: number }>()) {
      const minT = await readEmaPair(pair, floor, head, st)
      if (Number.isFinite(minT) && (!st.coveredFromSec || minT < st.coveredFromSec)) st.coveredFromSec = minT
    }
    st.coveredFromBlock = floor
    trimEma(Date.now() / 1000, st)
    await fillEmaLatest([...st.pairs.values()])
    // The tail may have read above `head` meanwhile into the served ledger: carry those rows over.
    for (const [id, p] of ema.pairs) for (const r of p.recent) {
      if (r.b <= head) continue
      const k = `${r.b}:${r.e}`
      if (st.seenTail.has(k)) continue
      st.seenTail.add(k)
      let q = st.pairs.get(id)
      if (!q) st.pairs.set(id, q = { ...p, times: [], hourly: new Map(), recent: [], timesSorted: true })
      q.times.push(r.t); q.timesSorted = false
      const hour = r.t - (r.t % 3600)
      const cur = q.hourly.get(hour)
      if (!cur || cur.b < r.b || (cur.b === r.b && cur.e < r.e)) q.hourly.set(hour, r)
      q.recent.push(r)
      if (r.b > st.maxBlock) st.maxBlock = r.b
    }
    trimEma(Date.now() / 1000, st)
    st.complete = true
    st.version = ema.version + 1
    ema = st
  })()
  run.catch(err => { emaInit = null; console.error('[oracles] EMA load failed', err) })
  return run
}

/** The EMA ledger: the last 30 days on the first call (narrow columns, newest first, then each pair's exact newest rows), the tail on every call ≥15 s apart. */
export async function ensureEmaLedger(): Promise<void> {
  if (!client) return
  if (!emaInit) emaInit = loadEmaLedger()
  if (Date.now() - emaTailAt >= TAIL_MIN_INTERVAL_MS && !emaTail && ema.maxBlock > 0) {
    emaTailAt = Date.now()
    emaTail = (async () => {
      const head = await indexedRawHead()
      const from = Math.max(0, ema.maxBlock - REORG_MARGIN_BLOCKS)
      for (let lo = from; lo < head; lo += EMA_WINDOW_BLOCKS) {
        const r = await client.query({
          query: `-- oracles:ema-tail
            SELECT ${EMA_LIGHT_COLUMNS}, updates FROM price_data.ema_oracle_updates
            WHERE block_height > {lo:UInt32} AND block_height <= {hi:UInt32}`,
          query_params: { lo, hi: Math.min(head, lo + EMA_WINDOW_BLOCKS) }, format: 'JSONEachRow',
        })
        for (const row of await r.json<EmaTableRow>()) addEmaRow(row, true)
        ema.version++
      }
      ema.readUpTo = Math.max(ema.readUpTo, head)
      trimEma(Date.now() / 1000)
      if (ema.complete && await belowFloorChanged('ema')) { resetFloorProbe('ema'); emaInit = loadEmaLedger() }
    })().catch(err => console.error('[oracles] EMA tail failed', err)).finally(() => { emaTail = null })
    await emaTail
  }
}

/** A pair's Short/Day over any span, from the float columns: the newest update in each bucket (raw-unit ratios). */
async function emaBuckets(p: EmaPairState, range: FeedRange, fromSec: number, stepSec: number): Promise<{ t: number; short: number | null; day: number | null }[]> {
  // Keyed on the range, not its start (which moves every second): the bucket a window opens
  // in is carried in from before it by the reader, so a start up to 10 min old reads the same.
  return cached(`explorer:oracles:ema-buckets:${p.sourceHex}:${p.a}:${p.b}:${range}`, 600_000, async () => {
    const r = await client.query({
      query: `-- oracles:ema-long
        SELECT toUnixTimestamp(toStartOfInterval(block_timestamp, toIntervalSecond({step:UInt32}))) AS k,
               max(toUnixTimestamp(block_timestamp)) AS t,
               argMax(short_ratio, (block_height, event_index)) AS s, argMax(day_ratio, (block_height, event_index)) AS d
        FROM price_data.ema_oracle_updates
        WHERE source = {src:String} AND asset_a = {a:UInt32} AND asset_b = {b:UInt32} AND block_timestamp >= toDateTime({from:UInt32})
        GROUP BY k ORDER BY k`,
      query_params: { step: stepSec, src: p.sourceHex, a: p.a, b: p.b, from: Math.max(0, Math.floor(fromSec)) }, format: 'JSONEachRow',
    })
    return (await r.json<{ k: number; t: number; s: number; d: number }>()).map(x => ({ t: Number(x.t), short: ratioOrNull(x.s), day: ratioOrNull(x.d) }))
  })
}

function sortedTimes(p: EmaPairState): number[] {
  if (!p.timesSorted) { p.times.sort((x, y) => x - y); p.timesSorted = true }
  return p.times
}

// ── stableswap pegs ──────────────────────────────────────────────────────────

export interface PegSourceNow {
  poolId: number
  assetId: number
  source: { kind: 'oracle' | 'mmOracle' | 'value'; address?: string; oracleSource?: string; period?: string; oracleAsset?: number }
}

/** Each live pool asset's current peg source: its creation config, then every later update. */
async function currentPegSources(): Promise<PegSourceNow[]> {
  return cached('explorer:oracles:peg-sources', 300_000, async () => {
    const res = await client.query({
      query: `-- oracles:pegs
        SELECT pool_id, event_name, args_json FROM price_data.stableswap_pool_params FINAL
        WHERE event_name IN ('Stableswap.PoolCreated', 'Stableswap.PoolPegSourceUpdated', 'Stableswap.PoolDestroyed')
        ORDER BY block_height, event_index`,
      format: 'JSONEachRow',
    })
    const byPool = new Map<number, Map<number, PegSourceNow['source']>>()
    for (const r of await res.json<{ pool_id: number; event_name: string; args_json: string }>()) {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(r.args_json) } catch { continue }
      const pool = Number(r.pool_id)
      if (r.event_name === 'Stableswap.PoolDestroyed') { byPool.delete(pool); continue }
      const toSource = (raw: unknown): PegSourceNow['source'] | null => {
        const info = decodePegSource(raw)
        const rawObj = raw as { __kind?: string; value?: unknown[] } | null
        if (!info) return null
        if (info.kind === 'mmOracle') return { kind: 'mmOracle', address: lc(String(info.address ?? '')) }
        if (info.kind === 'oracle') {
          const v = Array.isArray(rawObj?.value) ? rawObj!.value : []
          return { kind: 'oracle', oracleSource: typeof v[0] === 'string' ? hexAscii(v[0] as string) : undefined, period: info.period, oracleAsset: Number(v[2]) }
        }
        return { kind: 'value' }
      }
      if (r.event_name === 'Stableswap.PoolCreated') {
        const peg = args.peg as { source?: unknown[] } | undefined
        if (!peg?.source) continue
        const ids = parseAssetsArg(args.assets)
        const m = new Map<number, PegSourceNow['source']>()
        peg.source.forEach((s, i) => { const src = toSource(s); if (src && ids[i] != null) m.set(ids[i], src) })
        byPool.set(pool, m)
      } else {
        const src = toSource(args.pegSource)
        if (src) (byPool.get(pool) ?? byPool.set(pool, new Map()).get(pool)!).set(Number(args.assetId), src)
      }
    }
    const out: PegSourceNow[] = []
    for (const [poolId, m] of byPool) for (const [assetId, source] of m) out.push({ poolId, assetId, source })
    return out
  })
}

function hexAscii(h: string): string {
  const s = h.replace(/^0x/, '')
  let out = ''
  for (let i = 0; i + 1 < s.length; i += 2) { const c = parseInt(s.slice(i, i + 2), 16); if (c >= 32 && c < 127) out += String.fromCharCode(c) }
  return out
}
function parseAssetsArg(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number)
  if (typeof raw === 'string' && /^0x([0-9a-f]{2})+$/i.test(raw)) {
    const out: number[] = []
    for (let i = 2; i < raw.length; i += 2) out.push(parseInt(raw.slice(i, i + 2), 16))
    return out
  }
  return []
}

/** Current pegs per pool: the shared current share-pool state (one snapshot read per block, kept by stableswapSharePools). */
async function currentPoolPegs(): Promise<Map<number, { assetIds: number[]; pegs: { num: bigint; den: bigint }[] | null }>> {
  const out = new Map<number, { assetIds: number[]; pegs: { num: bigint; den: bigint }[] | null }>()
  for (const p of (await currentStableswapShareState(client))?.pools ?? []) out.set(p.poolId, { assetIds: p.assetIds, pegs: p.pegs })
  return out
}

// ── wire shapes ──────────────────────────────────────────────────────────────

/** `computed`: a read-through adapter that names no inputs (uBIL's vault rate) — live by construction, with no history. */
export type SourceKind = 'dia' | 'push' | 'ema' | 'composite' | 'computed' | 'fixed' | 'unknown'
export type SourceStatus = FeedStatus | 'fixed' | 'unknown'

export interface OracleSourceRef {
  address: string
  kind: SourceKind
  label: string
  /** The /oracle/:feed id of the history behind it, when there is one. */
  feedId: string | null
  provider: string | null
  /** The source's own latest answer as a decimal string (its own decimals applied). */
  value: string | null
  /** When the value it reports last changed on chain; null for a constant or a read-through with no history. */
  updatedAt: string | null
  ageSec: number | null
  status: SourceStatus
  note: string | null
  components?: OracleSourceRef[]
}

/**
 * A reserve or pool peg that reads a feed. `via` is the adapter it reads it through;
 * `depth` how far down the source tree the feed sits: 0 when the consumer's own source
 * IS the feed or its direct adapter (DOT reads DOT/USD through the DIA adapter), 1 when
 * it is an input of a composite (vDOT reads DOT/USD as its USD leg).
 */
export type OracleConsumer =
  | { kind: 'reserve'; market: string; marketLabel: string; asset: ExplorerAsset; via: string | null; depth: number }
  | { kind: 'peg'; poolId: number; pool: ExplorerAsset; asset: ExplorerAsset; via: string | null; depth: number }

export interface OracleReserveRow {
  asset: ExplorerAsset
  reserve: string
  /** The AaveOracle's getAssetPrice in USD, exact decimal. */
  oraclePrice: string | null
  /** The explorer's own current price (venue pipeline); null when no venue prices it. */
  marketPrice: number | null
  /** Why there is no market price: the explorer values it at this very oracle. */
  marketNote: string | null
  deviationPct: number | null
  source: OracleSourceRef
}

export interface OracleMarket { key: string; label: string; oracle: string | null; fallbackOracle: string | null; reserves: OracleReserveRow[] }

export interface OraclePegRow {
  pool: ExplorerAsset
  poolAssets: ExplorerAsset[]
  asset: ExplorerAsset
  /** The peg multiplier now (num/den from the newest snapshot), decimal. */
  peg: string | null
  source: OracleSourceRef
}

export interface FeedCadence {
  updates24h: number; updates7d: number; updates30d: number
  medianIntervalSec: number | null
  longestGapSec: number | null
  staleAfterSec: number
}

export interface OracleFeedRow {
  feedId: string
  kind: 'dia' | 'push'
  pair: string
  provider: string
  contract: string
  decimals: number
  latestValue: string | null
  updatedAt: string | null
  ageSec: number | null
  status: FeedStatus
  cadence: FeedCadence
  allTimeUpdates: number
  firstUpdateAt: string | null
  pushers: { account: AccountRef; updates: number }[]
  relays: AccountRef[]
  consumers: OracleConsumer[]
}

export interface EmaPairRow {
  feedId: string
  assetA: ExplorerAsset
  assetB: ExplorerAsset
  /** 1 assetB = price assetA (Short period, decimals applied). */
  price: string | null
  updatedAt: string
  ageSec: number
  updates24h: number
  consumers: OracleConsumer[]
}

export interface EmaSourceRow {
  source: string
  label: string
  updates24h: number
  pairs24h: number
  pairs: number
  newestAt: string | null
  newestAgeSec: number | null
  daily: { date: string; count: number }[]
  pairRows: EmaPairRow[]
}

export type OracleChange =
  | { kind: 'asset-source'; market: string | null; marketLabel: string | null; oracle: string; asset: ExplorerAsset | null; assetAddress: string; from: OracleSourceLink | null; to: OracleSourceLink; blockHeight: number; extrinsicIndex: number | null; timestamp: string }
  | { kind: 'peg-source'; pool: ExplorerAsset; asset: ExplorerAsset; from: OracleSourceLink | null; to: OracleSourceLink; blockHeight: number; timestamp: string }
  | { kind: 'dia-updater'; contract: string; to: AccountRef; blockHeight: number; extrinsicIndex: number | null; timestamp: string }

export interface OracleSourceLink { address: string; label: string; feedId: string | null }

export interface OraclesOverview {
  asOf: { liveReadAt: string | null; liveBlock: number | null; indexedHead: number; now: string }
  /** How far each history reaches: the block its last tail read ended at (counts end there, not at the head). */
  history: { logsComplete: boolean; emaComplete: boolean; emaCoveredFrom: string | null; logsThroughBlock: number; emaThroughBlock: number }
  kpis: {
    liveFeeds: number
    /** Stale feeds something reads (a reserve, a peg, a composite). */
    staleFeeds: number
    /** Stale feeds nothing reads any more. */
    staleUnused: number
    stale: { feedId: string; pair: string; consumed: boolean }[]
    updates24h: number
    largestDeviation: { asset: ExplorerAsset; market: string; deviationPct: number } | null
  }
  markets: OracleMarket[]
  pegs: OraclePegRow[]
  feeds: OracleFeedRow[]
  ema: EmaSourceRow[]
  changes: OracleChange[]
  rules: { cadenceSpanSec: number; retiredAfterSec: number; minGraceSec: number; fallbackHeartbeatSec: number }
}

// ── assembly ─────────────────────────────────────────────────────────────────

interface Ctx {
  nowSec: number
  snap: OracleSnapshot | null
  view: LedgerView
  tx: Map<string, TxRow | null>
  feedRows: Map<string, OracleFeedRow>
  /** DIA (contract, key) → feed id, for adapters. */
  emaRows: Map<string, { pair: EmaPairState; stats: CadenceStats; status: FeedStatus; last: EmaRow | null }>
}

function provenanceOf(f: FeedSeries, tx: Map<string, TxRow | null>): { provider: string; pushers: Map<string, number>; relays: Set<string> } {
  if (f.kind === 'dia') {
    const pushers = new Map<string, number>()
    const n = f.t.length
    for (let i = Math.max(0, n - 200); i < n; i++) {
      const row = f.x[i] == null ? null : tx.get(`${f.b[i]}:${f.x[i]}`)
      if (row) pushers.set(row.from, (pushers.get(row.from) ?? 0) + 1)
    }
    return { provider: 'DIA', pushers, relays: new Set() }
  }
  const counts = { relay: 0, direct: 0, runtime: 0, call: 0 }
  const pushers = new Map<string, number>()
  const relays = new Set<string>()
  const n = f.t.length
  for (let i = Math.max(0, n - 50); i < n; i++) {
    if (f.x[i] == null) { counts.runtime++; continue }
    const row = tx.get(`${f.b[i]}:${f.x[i]}`)
    if (!row) { counts.call++; continue }
    pushers.set(row.from, (pushers.get(row.from) ?? 0) + 1)
    if (row.to === f.contract) counts.direct++
    else { counts.relay++; relays.add(row.to) }
  }
  const top = (Object.entries(counts) as [keyof typeof counts, number][]).sort((a, b) => b[1] - a[1])[0]
  const provider = !top || top[1] === 0 ? 'Unknown'
    : top[0] === 'relay' ? 'Relay' : top[0] === 'direct' ? 'Direct' : top[0] === 'runtime' ? 'XCM / scheduled call' : 'Substrate call'
  return { provider, pushers, relays }
}

function feedCadence(times: number[], nowSec: number): { stats: CadenceStats; cadence: FeedCadence } {
  const stats = cadenceStats(times)
  return {
    stats,
    cadence: {
      updates24h: countSince(times, nowSec - DAY_SEC),
      updates7d: countSince(times, nowSec - 7 * DAY_SEC),
      updates30d: countSince(times, nowSec - 30 * DAY_SEC),
      medianIntervalSec: stats.medianIntervalSec,
      longestGapSec: stats.longestGapSec,
      staleAfterSec: staleAfterSec(stats),
    },
  }
}

function feedDecimals(contract: string, snap: OracleSnapshot | null): number {
  // DIA keys and every aggregator on Hydration publish 8 decimals; a live read of the feed's own decimals() wins.
  return snap?.sources.get(contract)?.decimals ?? 8
}

function buildFeedRow(f: FeedSeries, ctx: Ctx): OracleFeedRow {
  const n = f.t.length
  const { cadence } = feedCadence(f.t, ctx.nowSec)
  const prov = provenanceOf(f, ctx.tx)
  const decimals = f.kind === 'dia' ? 8 : feedDecimals(f.contract, ctx.snap)
  const last = n ? n - 1 : -1
  const description = f.kind === 'push' ? ctx.snap?.sources.get(f.contract)?.description ?? null : null
  return {
    feedId: f.feedId,
    kind: f.kind,
    pair: f.kind === 'dia' ? f.key! : description ?? shortAddr(f.contract),
    provider: prov.provider,
    contract: f.contract,
    decimals,
    latestValue: last >= 0 ? unitsDecimal(f.v[last], decimals) : null,
    updatedAt: last >= 0 ? isoS(f.t[last]) : null,
    ageSec: last >= 0 ? Math.max(0, ctx.nowSec - f.t[last]) : null,
    status: feedStatus({ lastUpdateSec: last >= 0 ? f.t[last] : null, nowSec: ctx.nowSec, allTimeUpdates: n, staleAfter: cadence.staleAfterSec }),
    cadence,
    allTimeUpdates: n,
    firstUpdateAt: n ? isoS(f.t[0]) : null,
    pushers: [...prov.pushers].sort((a, b) => b[1] - a[1]).map(([a, k]) => ({ account: evmAccount(a), updates: k })),
    relays: [...prov.relays].map(evmAccount),
    consumers: [],
  }
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

function emaPairState(pair: EmaPairState, nowSec: number): { stats: CadenceStats; status: FeedStatus; last: EmaRow | null } {
  const times = sortedTimes(pair)
  const stats = cadenceStats(times)
  const last = pair.recent.length ? pair.recent[pair.recent.length - 1] : null
  // A pair seen in the window always has at least one update; the window is 30 days, so none is "retired" from here.
  const status = feedStatus({ lastUpdateSec: last?.t ?? null, nowSec, allTimeUpdates: Math.max(2, times.length), staleAfter: staleAfterSec(stats) })
  return { stats, status, last }
}

function emaLabel(source: string, a: number, b: number, period?: EmaPeriod | null): string {
  const sa = displayDescriptor(a).symbol, sb = displayDescriptor(b).symbol
  return `${emaSourceLabel(source)} ${sb}/${sa}${period ? ` · ${period}` : ''}`
}

/**
 * An EMA adapter's label. The adapter address names a pair (A, B) but not which way
 * round it answers — the stableswap and Bifrost adapters answer B in A, the GigaHDX one
 * A in B — so an orientation is stated only when the adapter's own answer matches the
 * pair's newest EMA update one way (within 1 %) and not the other; otherwise the pair is
 * named without one ("stHDX–HDX").
 */
export function adapterEmaLabel(info: { period: EmaPeriod | null; source: string; assetA: number; assetB: number }, answer: string | null, last: { short: number | null } | null): string {
  const da = displayDescriptor(info.assetA), db = displayDescriptor(info.assetB)
  const tail = info.period ? ` · ${info.period}` : ''
  const v = answer != null ? Number(answer) : NaN
  if (last?.short != null && Number.isFinite(v) && v > 0) {
    // The event's ratio is raw min-id per raw max-id: the max-id asset priced in the min-id one.
    const lo = Math.min(info.assetA, info.assetB)
    const dLo = displayDescriptor(lo).decimals, dHi = displayDescriptor(Math.max(info.assetA, info.assetB)).decimals
    const hiInLo = last.short * 10 ** (dHi - dLo)
    const bInA = info.assetA === lo ? hiInLo : 1 / hiInLo
    const near = (x: number) => Math.abs(v / x - 1) < 0.01
    if (near(bInA) && !near(1 / bInA)) return `${emaSourceLabel(info.source)} ${db.symbol}/${da.symbol}${tail}`
    if (near(1 / bInA) && !near(bInA)) return `${emaSourceLabel(info.source)} ${da.symbol}/${db.symbol}${tail}`
  }
  return `${emaSourceLabel(info.source)} ${da.symbol}–${db.symbol}${tail}`
}

function emaPrice(row: EmaRow | null, a: number, b: number, period: EmaPeriod = 'Short'): string | null {
  const r = row?.prices[period] ?? row?.prices.LastBlock
  if (!r) return null
  return emaPriceDecimal(r, displayDescriptor(a).decimals, displayDescriptor(b).decimals, 12)
}

/** Resolve a source address to what it is, recursively for its inputs. */
function sourceRef(address: string, ctx: Ctx, depth = 0): OracleSourceRef {
  const a = lc(address)
  const s = ctx.snap?.sources.get(a) ?? null
  const value = s?.answer != null ? unitsDecimal(BigInt(s.answer), s.decimals ?? 8) : s?.round ? unitsDecimal(BigInt(s.round.answer), s.decimals ?? 8) : null
  const base = { address: a, value, note: null as string | null }
  const emaInfo = s?.ema ?? decodeOracleAdapterAddress(a)
  if (emaInfo) {
    const id = emaFeedId(emaInfo.source, emaInfo.assetA, emaInfo.assetB)
    const er = ctx.emaRows.get(id)
    const lastT = er?.last?.t ?? null
    return {
      ...base, kind: 'ema', label: adapterEmaLabel(emaInfo, value, er?.last ?? null), feedId: er ? id : null, provider: emaSourceLabel(emaInfo.source),
      updatedAt: lastT != null ? isoS(lastT) : null, ageSec: lastT != null ? Math.max(0, ctx.nowSec - lastT) : null,
      status: er ? er.status : 'unknown',
      note: er ? null : emaInfo.source
        ? 'No EMA update for this pair in the window held (30 days), so its freshness cannot be stated.'
        : 'The adapter names an EMA source of eight zero bytes; no EmaOracle update carries that source, so its freshness cannot be stated.',
    }
  }
  if (!s) return { ...base, kind: 'unknown', label: shortAddr(a), feedId: null, provider: null, updatedAt: null, ageSec: null, status: 'unknown', note: 'Not read yet.' }
  if (s.dia) {
    const id = diaFeedId(s.dia.oracle, s.dia.key)
    const fr = ctx.feedRows.get(id)
    return {
      ...base, kind: 'dia', label: s.dia.key, feedId: id, provider: 'DIA',
      updatedAt: fr?.updatedAt ?? (s.round ? isoS(s.round.updatedAt) : null), ageSec: fr?.ageSec ?? null,
      status: fr?.status ?? 'unknown',
      note: 'Reads the DIA key on every call: its round is the current block, its updatedAt the key’s last DIA update.',
    }
  }
  if (s.mmOracle && depth < 3) {
    const comps = [sourceRef(s.mmOracle.ema, ctx, depth + 1), sourceRef(s.mmOracle.discount, ctx, depth + 1)]
    const frozen = s.round?.updatedAt ? isoS(s.round.updatedAt) : null
    return {
      ...base, kind: 'ema', label: `${comps[0].label} × ${comps[1].label}`, feedId: comps[0].feedId, provider: comps[0].provider,
      updatedAt: comps[0].updatedAt, ageSec: comps[0].ageSec, status: comps[0].status,
      note: `${s.mmOracle.verified ? 'Answers' : 'Names'} its EMA rate times a discount feed${s.mmOracle.verified ? '' : ' (the product did not re-check at this block)'}.${frozen ? ` Its own updatedAt is frozen at ${frozen.slice(0, 10)} by design, so its freshness is the EMA pair’s.` : ''}`,
      components: comps,
    }
  }
  if (s.composite && depth < 3) {
    const comps = [sourceRef(s.composite.ratio, ctx, depth + 1), sourceRef(s.composite.usd, ctx, depth + 1)]
    const oldest = comps.reduce<OracleSourceRef | null>((o, c) => (c.ageSec != null && (o?.ageSec == null || c.ageSec > o.ageSec) ? c : o), null)
    const worst = comps.some(c => c.status === 'stale') ? 'stale' : comps.some(c => c.status === 'retired') ? 'retired' : comps.every(c => c.status === 'live' || c.status === 'fixed') ? 'live' : 'unknown'
    return {
      ...base, kind: 'composite', label: `${comps[0].label} × ${comps[1].label}`, feedId: null, provider: null,
      updatedAt: oldest?.updatedAt ?? null, ageSec: oldest?.ageSec ?? null, status: worst,
      note: s.composite.verified ? 'Answers the product of its two inputs (re-checked at the read block); no rounds of its own.' : 'Names two inputs, but its answer did not re-check as their product at the read block.',
      components: comps,
    }
  }
  const pushFeed = ctx.feedRows.get(a)
  if (pushFeed) {
    if (pushFeed.status === 'static') {
      return {
        ...base, kind: 'fixed', label: pushFeed.pair, feedId: a, provider: pushFeed.provider,
        updatedAt: pushFeed.updatedAt, ageSec: pushFeed.ageSec, status: 'static',
        note: pushFeed.allTimeUpdates <= 1
          ? `Never updated since ${pushFeed.updatedAt?.slice(0, 10) ?? 'it was set'}: one value, published once.`
          : `Set ${pushFeed.allTimeUpdates} times, last on ${pushFeed.updatedAt?.slice(0, 10)}: a value set by hand, not a stream.`,
      }
    }
    return {
      ...base, kind: 'push', label: pushFeed.pair, feedId: a, provider: pushFeed.provider,
      updatedAt: pushFeed.updatedAt, ageSec: pushFeed.ageSec, status: pushFeed.status, note: null,
    }
  }
  if (s.constant) return { ...base, kind: 'fixed', label: 'Constant', feedId: null, provider: null, updatedAt: null, ageSec: null, status: 'fixed', note: 'Its code can only return a constant.' }
  if (s.round && ctx.snap?.block != null && Math.abs(Number(s.round.roundId) - ctx.snap.block) <= 5) {
    return {
      ...base, kind: 'computed', label: s.description ?? shortAddr(a), feedId: null, provider: null, updatedAt: null, ageSec: null, status: 'live',
      note: 'Computed on every call (its round is the current block) from inputs it does not name; it has no update history.',
    }
  }
  if (s.round) {
    return {
      ...base, kind: 'push', label: s.description ?? shortAddr(a), feedId: a, provider: null,
      updatedAt: isoS(s.round.updatedAt), ageSec: Math.max(0, ctx.nowSec - s.round.updatedAt), status: 'unknown',
      note: 'Reports rounds, but no update log of it is indexed.',
    }
  }
  return { ...base, kind: 'unknown', label: s.description ?? shortAddr(a), feedId: null, provider: null, updatedAt: null, ageSec: null, status: 'unknown', note: null }
}

/** Every feed id a source tree draws on, with the adapter that reads it. */
export function feedIdsOf(ref: OracleSourceRef, via: string | null = null, depth = 0, out: { feedId: string; via: string | null; depth: number }[] = []): { feedId: string; via: string | null; depth: number }[] {
  if (ref.feedId) out.push({ feedId: ref.feedId, via: via ?? (ref.feedId === ref.address ? null : ref.address), depth })
  for (const c of ref.components ?? []) feedIdsOf(c, via ?? ref.address, depth + 1, out)
  return out
}

async function buildContext(nowSec: number): Promise<Ctx> {
  const [view] = await Promise.all([ensureLogLedger(), ensureEmaLedger()])
  const tx = await txIndexFor(view)
  const snap = currentOracleSnapshot()
  const ctx: Ctx = { nowSec, snap, view, tx, feedRows: new Map(), emaRows: new Map() }
  for (const f of view.feeds.values()) ctx.feedRows.set(f.feedId, buildFeedRow(f, ctx))
  for (const [id, p] of ema.pairs) ctx.emaRows.set(id, { pair: p, ...emaPairState(p, nowSec) })
  return ctx
}

function attachConsumers(ctx: Ctx, consumersByFeed: Map<string, OracleConsumer[]>): void {
  for (const [id, list] of consumersByFeed) {
    const row = ctx.feedRows.get(id)
    if (row) row.consumers = list
  }
}

export async function getOraclesOverview(): Promise<OraclesOverview> {
  // Fresh 30 s, then served stale while one rebuild replaces it: every input is
  // in memory, so a rebuild is ~0.5 s of CPU a reader never waits on.
  // Keyed on whether a live read exists, so a copy built before the refresher's
  // first read (no markets) is never served once one has landed.
  return cachedSwr(`explorer:oracles:overview:${currentOracleSnapshot() ? 'live' : 'none'}`, 30_000, 600_000, async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const [ctx, prices, pegSources, pegsNow, head] = await Promise.all([
      buildContext(nowSec), ensurePrices(), currentPegSources().catch(() => [] as PegSourceNow[]), currentPoolPegs().catch(() => new Map()), indexedRawHead(),
    ])
    const consumersByFeed = new Map<string, OracleConsumer[]>()
    const addConsumer = (id: string, c: OracleConsumer) => {
      const l = consumersByFeed.get(id) ?? []
      const same = (x: OracleConsumer) => x.kind === c.kind && x.asset.assetId === c.asset.assetId
        && (x.kind === 'reserve' ? x.market === (c as typeof x).market : x.poolId === (c as typeof x).poolId)
      const i = l.findIndex(same)
      if (i < 0) l.push(c)
      else if (c.depth < l[i].depth) l[i] = c
      consumersByFeed.set(id, l)
    }
    // Markets.
    const markets: OracleMarket[] = (ctx.snap?.markets ?? MM_MARKETS.map(m => ({ key: m.key, label: m.label, pool: m.poolProxy, oracle: null, fallbackOracle: null, baseUnit: null, reserves: [] }))).map(m => {
      const usd = m.baseUnit === '100000000'
      const reserves: OracleReserveRow[] = m.reserves.map(r => {
        const asset = displayDescriptor(r.assetId ?? 0)
        const src = r.source ? sourceRef(r.source, ctx) : { address: '', kind: 'unknown' as const, label: '—', feedId: null, provider: null, value: null, updatedAt: null, ageSec: null, status: 'unknown' as const, note: 'No source set.' }
        const oraclePrice = usd && r.price != null ? unitsDecimal(BigInt(r.price), 8) : null
        const fallback = r.assetId != null && priceIsOracleFallback(r.assetId)
        const market = r.assetId != null && !fallback ? currentPriceOf(prices, r.assetId)?.price ?? null : null
        const op = oraclePrice != null ? Number(oraclePrice) : null
        for (const { feedId, via, depth } of feedIdsOf(src)) addConsumer(feedId, { kind: 'reserve', market: m.key, marketLabel: m.label, asset, via, depth })
        return {
          asset, reserve: r.address, oraclePrice, marketPrice: market,
          marketNote: fallback ? 'No venue prices it; the explorer values it at this oracle.' : market == null ? 'No market price.' : null,
          deviationPct: op != null && market != null && market > 0 ? ((op - market) / market) * 100 : null,
          source: src,
        }
      })
      return { key: m.key, label: m.label, oracle: m.oracle, fallbackOracle: m.fallbackOracle, reserves }
    })
    // Stableswap pegs read from an oracle.
    const pegs: OraclePegRow[] = []
    for (const p of pegSources) {
      if (p.source.kind === 'value') continue
      const now = pegsNow.get(p.poolId)
      if (!now) continue
      const idx = now.assetIds.indexOf(p.assetId)
      const peg = idx >= 0 && now.pegs ? ratioDecimal(now.pegs[idx].num, now.pegs[idx].den, 10) : null
      let src: OracleSourceRef
      if (p.source.kind === 'mmOracle' && p.source.address) src = sourceRef(p.source.address, ctx)
      else {
        const oa = p.source.oracleAsset ?? 0
        const [x, y] = oa < p.assetId ? [oa, p.assetId] : [p.assetId, oa]
        const id = emaFeedId(p.source.oracleSource ?? '', x, y)
        const er = ctx.emaRows.get(id)
        src = {
          address: '', kind: 'ema', label: emaLabel(p.source.oracleSource ?? '', x, y, (p.source.period as EmaPeriod) ?? null), feedId: id,
          provider: emaSourceLabel(p.source.oracleSource ?? ''), value: emaPrice(er?.last ?? null, x, y), updatedAt: er?.last ? isoS(er.last.t) : null,
          ageSec: er?.last ? nowSec - er.last.t : null, status: er?.status ?? 'unknown', note: null,
        }
      }
      const pool = displayDescriptor(p.poolId)
      const asset = displayDescriptor(p.assetId)
      for (const { feedId, via, depth } of feedIdsOf(src)) addConsumer(feedId, { kind: 'peg', poolId: p.poolId, pool, asset, via, depth })
      pegs.push({ pool, poolAssets: now.assetIds.map(displayDescriptor), asset, peg, source: src })
    }
    pegs.sort((a, b) => a.pool.assetId - b.pool.assetId)
    attachConsumers(ctx, consumersByFeed)

    const feeds = [...ctx.feedRows.values()].sort((a, b) => statusRank(a.status) - statusRank(b.status) || (a.kind === b.kind ? a.pair.localeCompare(b.pair) : a.kind === 'dia' ? -1 : 1))
    // EMA sources.
    const bySource = new Map<string, EmaPairRow[]>()
    const dailyBy = new Map<string, Map<string, number>>()
    for (const [id, er] of ctx.emaRows) {
      const p = er.pair
      const times = sortedTimes(p)
      const day = dailyBy.get(p.source) ?? new Map<string, number>()
      dailyBy.set(p.source, day)
      for (const t of times) {
        if (t < nowSec - 30 * DAY_SEC) continue
        const d = isoS(t - (t % DAY_SEC)).slice(0, 10)
        day.set(d, (day.get(d) ?? 0) + 1)
      }
      if (!er.last) continue
      const rows = bySource.get(p.source) ?? []
      rows.push({
        feedId: id, assetA: displayDescriptor(p.a), assetB: displayDescriptor(p.b), price: emaPrice(er.last, p.a, p.b),
        updatedAt: isoS(er.last.t), ageSec: Math.max(0, nowSec - er.last.t), updates24h: countSince(times, nowSec - DAY_SEC),
        consumers: consumersByFeed.get(id) ?? [],
      })
      bySource.set(p.source, rows)
    }
    const days: string[] = []
    for (let d = 29; d >= 0; d--) { const t = nowSec - d * DAY_SEC; days.push(isoS(t - (t % DAY_SEC)).slice(0, 10)) }
    const emaRows: EmaSourceRow[] = [...bySource].map(([source, rows]) => {
      const newest = rows.reduce((m, r) => (r.ageSec < m ? r.ageSec : m), Infinity)
      const day = dailyBy.get(source) ?? new Map()
      return {
        source, label: emaSourceLabel(source),
        updates24h: rows.reduce((s, r) => s + r.updates24h, 0),
        pairs24h: rows.filter(r => r.updates24h > 0).length,
        pairs: rows.length,
        newestAt: Number.isFinite(newest) ? isoS(nowSec - newest) : null,
        newestAgeSec: Number.isFinite(newest) ? newest : null,
        daily: days.map(date => ({ date, count: day.get(date) ?? 0 })),
        pairRows: rows.sort((a, b) => b.updates24h - a.updates24h || a.feedId.localeCompare(b.feedId)),
      }
    }).sort((a, b) => b.updates24h - a.updates24h)

    // Source changes, newest first.
    const pegChanges = await pegSourceChanges().catch(() => [] as PegChangeRaw[])
    const changes = [
      ...buildChanges(ctx),
      ...pegChanges.map((c): OracleChange => ({
        kind: 'peg-source', pool: displayDescriptor(c.poolId), asset: displayDescriptor(c.assetId),
        from: c.from ? pegLink(c.from, c.assetId, ctx) : null, to: pegLink(c.to, c.assetId, ctx), blockHeight: c.b, timestamp: isoS(c.t),
      })),
    ].sort((a, b) => b.blockHeight - a.blockHeight)

    const delivery = feeds.filter(f => f.status === 'live' || f.status === 'stale')
    const stale = feeds.filter(f => f.status === 'stale')
    const deviations = markets.flatMap(m => m.reserves.filter(r => r.deviationPct != null).map(r => ({ asset: r.asset, market: m.key, deviationPct: r.deviationPct! })))
    const largest = deviations.reduce<typeof deviations[number] | null>((best, d) => (!best || Math.abs(d.deviationPct) > Math.abs(best.deviationPct) ? d : best), null)
    return {
      asOf: { liveReadAt: ctx.snap ? isoS(Math.floor(ctx.snap.readAtMs / 1000)) : null, liveBlock: ctx.snap?.block ?? null, indexedHead: head, now: isoS(nowSec) },
      history: { logsComplete: ctx.view.historyComplete, emaComplete: ema.complete, emaCoveredFrom: ema.coveredFromSec ? isoS(ema.coveredFromSec) : null, logsThroughBlock: ledger.loadedUpTo, emaThroughBlock: ema.readUpTo },
      kpis: {
        liveFeeds: delivery.length - stale.length,
        staleFeeds: stale.filter(f => f.consumers.length > 0).length,
        staleUnused: stale.filter(f => f.consumers.length === 0).length,
        stale: stale.map(f => ({ feedId: f.feedId, pair: f.pair, consumed: f.consumers.length > 0 })),
        updates24h: delivery.reduce((s, f) => s + f.cadence.updates24h, 0),
        largestDeviation: largest,
      },
      markets, pegs, feeds, ema: emaRows, changes,
      rules: { cadenceSpanSec: CADENCE_SPAN_SEC, retiredAfterSec: RETIRED_AFTER_SEC, minGraceSec: 900, fallbackHeartbeatSec: DAY_SEC },
    }
  })
}

const statusRank = (s: FeedStatus) => (s === 'stale' ? 0 : s === 'live' ? 1 : s === 'static' ? 2 : 3)

function sourceLink(address: string, ctx: Ctx): OracleSourceLink {
  const r = sourceRef(address, ctx)
  return { address: r.address, label: r.label, feedId: r.feedId ?? (r.kind === 'composite' || r.kind === 'computed' || r.kind === 'fixed' ? r.address : null) }
}

function buildChanges(ctx: Ctx): OracleChange[] {
  const out: OracleChange[] = []
  const marketByOracle = new Map((ctx.snap?.markets ?? []).filter(m => m.oracle).map(m => [m.oracle!, m]))
  const prev = new Map<string, string>()
  for (const c of ctx.view.sourceChanges) {
    const k = `${c.oracle}:${c.asset}`
    const before = prev.get(k) ?? null
    prev.set(k, c.source)
    if (before === c.source) continue
    const m = marketByOracle.get(c.oracle)
    const id = assetIdFromMmAddress(c.asset)
    out.push({
      kind: 'asset-source', market: m?.key ?? null, marketLabel: m?.label ?? null, oracle: c.oracle,
      asset: id != null ? displayDescriptor(id) : null, assetAddress: c.asset,
      from: before ? sourceLink(before, ctx) : null, to: sourceLink(c.source, ctx),
      blockHeight: c.b, extrinsicIndex: c.x, timestamp: isoS(c.t),
    })
  }
  for (const u of ctx.view.updaterChanges) {
    out.push({ kind: 'dia-updater', contract: u.contract, to: evmAccount(u.updater), blockHeight: u.b, extrinsicIndex: u.x, timestamp: isoS(u.t) })
  }
  return out
}

interface PegChangeRaw { poolId: number; assetId: number; from: string | null; to: string; b: number; t: number }

/**
 * Every change of a pool asset's peg source, oldest first: the source each pool
 * was created with counts only when it is an oracle (a constant leg is no
 * change), every later PoolPegSourceUpdated counts. A source is "constant", an
 * MMOracle address, or `ema:<source>:<period>:<asset>`.
 */
async function pegSourceChanges(): Promise<PegChangeRaw[]> {
  return cached('explorer:oracles:peg-changes', 300_000, async () => {
    const res = await client.query({
      query: `-- oracles:peg-changes
        SELECT pool_id, block_height, toUnixTimestamp(block_timestamp) AS t, event_name, args_json FROM price_data.stableswap_pool_params FINAL
        WHERE event_name IN ('Stableswap.PoolCreated', 'Stableswap.PoolPegSourceUpdated')
        ORDER BY block_height, event_index`,
      format: 'JSONEachRow',
    })
    const prev = new Map<string, string>()
    const out: PegChangeRaw[] = []
    const describe = (raw: unknown): string | null => {
      const info = decodePegSource(raw)
      if (!info) return null
      if (info.kind === 'value') return 'constant'
      if (info.kind === 'mmOracle') return lc(String(info.address ?? ''))
      const v = (raw as { value?: unknown[] }).value ?? []
      return `ema:${hexAscii(String(v[0] ?? ''))}:${info.period ?? ''}:${Number(v[2])}`
    }
    for (const r of await res.json<{ pool_id: number; block_height: number; t: number; event_name: string; args_json: string }>()) {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(r.args_json) } catch { continue }
      const entries: [number, unknown][] = []
      if (r.event_name === 'Stableswap.PoolCreated') {
        const peg = args.peg as { source?: unknown[] } | undefined
        if (!peg?.source) continue
        const ids = parseAssetsArg(args.assets)
        peg.source.forEach((s, i) => { if (ids[i] != null) entries.push([ids[i], s]) })
      } else entries.push([Number(args.assetId), args.pegSource])
      for (const [assetId, raw] of entries) {
        const to = describe(raw)
        if (!to) continue
        const k = `${r.pool_id}:${assetId}`
        const from = prev.get(k) ?? null
        prev.set(k, to)
        if (r.event_name === 'Stableswap.PoolCreated' && to === 'constant') continue
        out.push({ poolId: Number(r.pool_id), assetId, from, to, b: Number(r.block_height), t: Number(r.t) })
      }
    }
    return out
  })
}

function pegLink(desc: string, poolAsset: number, ctx: Ctx): OracleSourceLink {
  if (desc === 'constant') return { address: '', label: 'Constant', feedId: null }
  if (desc.startsWith('ema:')) {
    const [, src, period, asset] = desc.split(':')
    const oa = Number(asset)
    const [x, y] = oa < poolAsset ? [oa, poolAsset] : [poolAsset, oa]
    return { address: '', label: emaLabel(src, x, y, (period as EmaPeriod) || null), feedId: emaFeedId(src, x, y) }
  }
  return sourceLink(desc, ctx)
}

// ── feed detail ──────────────────────────────────────────────────────────────

export const FEED_RANGES = ['7d', '30d', '12m', 'all'] as const
export type FeedRange = typeof FEED_RANGES[number]
const RANGE_SPEC: Record<FeedRange, { spanSec: number | null; stepSec: number; candle: OHLCVInterval }> = {
  '7d': { spanSec: 7 * DAY_SEC, stepSec: 3600, candle: '1h' },
  '30d': { spanSec: 30 * DAY_SEC, stepSec: 4 * 3600, candle: '4h' },
  '12m': { spanSec: 365 * DAY_SEC, stepSec: DAY_SEC, candle: '1d' },
  all: { spanSec: null, stepSec: DAY_SEC, candle: '1d' },
}

export interface FeedChart { range: FeedRange; stepSec: number; buckets: string[]; series: { key: string; label: string; values: (number | null)[] }[] }

export interface FeedUpdateRow {
  blockHeight: number; eventIndex: number; extrinsicIndex: number | null; timestamp: string
  value: string
  /** Change from the previous update, percent. */
  changePct: number | null
  intervalSec: number | null
  /** The feed's own timestamp for the value (DIA's / the round's). */
  reportedAt: string | null
  pusher: AccountRef | null
}
export interface EmaUpdateRow { blockHeight: number; eventIndex: number; timestamp: string; prices: { period: EmaPeriod; value: string }[] }
export interface UpdatesPage<T> { rows: T[]; total: number; page: number; pageSize: number; complete: boolean }

export interface OracleFeedDetail {
  feedId: string
  kind: 'dia' | 'push' | 'ema' | 'source'
  label: string
  provider: string | null
  contract: string | null
  key: string | null
  decimals: number | null
  latestValue: string | null
  updatedAt: string | null
  ageSec: number | null
  reportedAt: string | null
  status: SourceStatus
  cadence: FeedCadence | null
  allTimeUpdates: number | null
  firstUpdateAt: string | null
  pushers: { account: AccountRef; updates: number }[]
  relays: AccountRef[]
  consumers: OracleConsumer[]
  /** What the feed prices, in what: the market overlay's legs. */
  subject: { asset: ExplorerAsset; quote: ExplorerAsset | null } | null
  source: OracleSourceRef | null
  ema: { source: string; sourceLabel: string; assetA: ExplorerAsset; assetB: ExplorerAsset; prices: { period: EmaPeriod; value: string }[]; coveredFrom: string | null; complete: boolean } | null
  chart: FeedChart | null
  updates: UpdatesPage<FeedUpdateRow> | UpdatesPage<EmaUpdateRow>
  historyComplete: boolean
}

/** Normalise a :feed parameter; null when it names nothing this surface knows how to read. */
export function parseFeedParam(raw: string): { kind: 'address'; address: string } | { kind: 'dia'; contract: string; key: string } | { kind: 'ema'; source: string; a: number; b: number } | null {
  const s = raw.trim()
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { kind: 'address', address: lc(s) }
  const dia = /^dia:(0x[0-9a-fA-F]{40}):(.{1,64})$/.exec(s)
  if (dia) return { kind: 'dia', contract: lc(dia[1]), key: dia[2] }
  const e = /^ema:([a-z0-9]{1,8}):(\d{1,10})-(\d{1,10})$/.exec(s)
  if (e) return { kind: 'ema', source: e[1], a: Number(e[2]), b: Number(e[3]) }
  return null
}

/**
 * What a feed prices, in what — the market overlay's legs — one candidate per consumer,
 * nearest first: a consumer that reads the feed directly (depth 0) names the asset the
 * feed IS a price of; one that reads it as a composite's input names something else
 * (GETH reads ETH/USD), so it only comes after. A reserve is priced in USD; a peg in the
 * pool's other leg (HOLLAR is the dollar). Candles exist for an asset's price id, not for
 * an aToken over it (aETH, aSOL), so both legs resolve through currentPriceAssetId.
 */
export function feedSubjects(consumers: OracleConsumer[], pools: Map<number, { assetIds: number[] }>): { asset: ExplorerAsset; quote: ExplorerAsset | null }[] {
  const out: { asset: ExplorerAsset; quote: ExplorerAsset | null }[] = []
  const seen = new Set<string>()
  for (const c of [...consumers].sort((x, y) => x.depth - y.depth)) {
    let subject: { asset: ExplorerAsset; quote: ExplorerAsset | null }
    const asset = displayDescriptor(currentPriceAssetId(c.asset.assetId))
    if (c.kind === 'reserve') subject = { asset, quote: null }
    else {
      const other = pools.get(c.poolId)?.assetIds.find(id => id !== c.asset.assetId)
      subject = { asset, quote: other == null || other === HOLLAR_ID ? null : displayDescriptor(currentPriceAssetId(other)) }
    }
    const k = `${subject.asset.assetId}:${subject.quote?.assetId ?? ''}`
    if (!seen.has(k)) { seen.add(k); out.push(subject) }
  }
  return out
}
const HOLLAR_ID = 222

async function marketSeries(subject: NonNullable<OracleFeedDetail['subject']>, grid: string[], spec: typeof RANGE_SPEC[FeedRange], fromSec: number, toSec: number): Promise<(number | null)[] | null> {
  const load = (assetId: number) => cached(`explorer:oracles:candles:${assetId}:${spec.candle}:${Math.floor(toSec / 600)}`, 600_000, async () => {
    const rows = await queryOHLCV(client, { assetId, startTime: new Date(fromSec * 1000), endTime: new Date(toSec * 1000), interval: spec.candle, tag: 'oracles:candles' })
    const m = new Map<string, number>()
    const grain = makeGrain(spec.stepSec)
    for (const r of rows) {
      const ts = String(r.interval_start)
      const sec = Math.floor(Date.parse(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z') / 1000)
      if (!Number.isFinite(sec)) continue
      const v = Number(r.close)
      if (Number.isFinite(v) && v > 0) m.set(grain.keyOf(sec), v)
    }
    return m
  })
  try {
    const [a, q] = await Promise.all([load(subject.asset.assetId), subject.quote ? load(subject.quote.assetId) : Promise.resolve(null)])
    const values = grid.map(k => {
      const va = a.get(k)
      if (va == null) return null
      if (!q) return va
      const vq = q.get(k)
      return vq ? va / vq : null
    })
    // A subject with no candle in the window is no overlay: the caller tries the next one.
    return values.some(v => v != null) ? values : null
  } catch {
    return null
  }
}

function stepValues(times: number[], values: number[], grid: string[], stepSec: number): (number | null)[] {
  const out: (number | null)[] = []
  let j = 0
  let cur: number | null = null
  for (const k of grid) {
    const end = Math.floor(Date.parse(k.length === 10 ? `${k}T00:00:00Z` : k.replace(' ', 'T') + 'Z') / 1000) + stepSec
    while (j < times.length && times[j] < end) { cur = values[j]; j++ }
    out.push(cur)
  }
  return out
}

/** A feed's detail: header, cadence, consumers, the chart for `range` and one page of updates. Cached 30 s per (feed, range, page). */
export async function getOracleFeed(rawFeed: string, range: FeedRange, page = 0): Promise<OracleFeedDetail | null> {
  const parsed = parseFeedParam(rawFeed)
  if (!parsed) return null
  const key = parsed.kind === 'address' ? parsed.address : parsed.kind === 'dia' ? diaFeedId(parsed.contract, parsed.key) : emaFeedId(parsed.source, parsed.a, parsed.b)
  return cachedSwr(`explorer:oracles:feed:${key}:${range}:${page}`, 30_000, 600_000, () => buildOracleFeed(parsed, range, page))
}

async function buildOracleFeed(parsed: NonNullable<ReturnType<typeof parseFeedParam>>, range: FeedRange, page: number): Promise<OracleFeedDetail | null> {
  const nowSec = Math.floor(Date.now() / 1000)
  const overview = await getOraclesOverview()
  const ctx = await buildContext(nowSec)
  // Consumers come from the overview's wiring so both pages agree.
  const consumersOf = (id: string): OracleConsumer[] => overview.feeds.find(f => f.feedId === id)?.consumers
    ?? overview.ema.flatMap(s => s.pairRows).find(r => r.feedId === id)?.consumers ?? []
  const pools = await currentPoolPegs().catch(() => new Map())

  if (parsed.kind === 'ema') {
    const id = emaFeedId(parsed.source, parsed.a, parsed.b)
    const er = ctx.emaRows.get(id)
    if (!er) return null
    const p = er.pair
    const times = sortedTimes(p)
    const { cadence } = feedCadence(times, nowSec)
    // 7D / 30D from the ledger's hourly samples; 12M / All from the table's float columns.
    const long = range === '12m' || range === 'all'
    const chartRange: FeedRange = long ? range : range === '7d' ? '7d' : '30d'
    const spec = RANGE_SPEC[chartRange]
    const decA = displayDescriptor(p.a).decimals, decB = displayDescriptor(p.b).decimals
    const scale = 10 ** (decB - decA)
    const pts = long
      ? await emaBuckets(p, chartRange, spec.spanSec == null ? 0 : nowSec - spec.spanSec - spec.stepSec, spec.stepSec)
      : [...p.hourly.entries()].sort((x, y) => x[0] - y[0]).map(([, r]) => ({ t: r.t, short: r.short, day: r.day }))
    const from = spec.spanSec == null ? (pts[0]?.t ?? nowSec - 30 * DAY_SEC) : nowSec - spec.spanSec
    const grain = makeGrain(spec.stepSec)
    const grid = grain.grid(from, nowSec)
    const series = (k: 'short' | 'day') => stepValues(pts.map(x => x.t), pts.map(x => (x[k] == null ? NaN : x[k]! * scale)), grid, spec.stepSec)
      .map(v => (v != null && Number.isFinite(v) ? v : null))
    const short = series('short')
    const day = series('day')
    const rows = [...p.recent].reverse()
    const pageSlice = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
    await fillEmaExact(p, pageSlice)
    const pageRows = pageSlice.map(r => ({
      blockHeight: r.b, eventIndex: r.e, timestamp: isoS(r.t),
      prices: EMA_PERIODS.filter(k => r.prices[k]).map(k => ({ period: k, value: emaPriceDecimal(r.prices[k]!, decA, decB, 12) })),
    }))
    const last = er.last
    return {
      feedId: id, kind: 'ema', label: emaLabel(p.source, p.a, p.b), provider: emaSourceLabel(p.source), contract: null, key: null, decimals: null,
      latestValue: emaPrice(last, p.a, p.b), updatedAt: last ? isoS(last.t) : null, ageSec: last ? nowSec - last.t : null, reportedAt: null,
      status: er.status, cadence, allTimeUpdates: null, firstUpdateAt: null, pushers: [], relays: [], consumers: consumersOf(id),
      subject: null, source: null,
      ema: {
        source: p.source, sourceLabel: emaSourceLabel(p.source), assetA: displayDescriptor(p.a), assetB: displayDescriptor(p.b),
        prices: last ? EMA_PERIODS.filter(k => last.prices[k]).map(k => ({ period: k, value: emaPriceDecimal(last.prices[k]!, decA, decB, 12) })) : [],
        coveredFrom: ema.coveredFromSec ? isoS(ema.coveredFromSec) : null, complete: ema.complete,
      },
      chart: { range: chartRange, stepSec: spec.stepSec, buckets: grid, series: [{ key: 'short', label: 'Short', values: short }, { key: 'day', label: 'Day', values: day }] },
      updates: { rows: pageRows, total: rows.length, page, pageSize: PAGE_SIZE, complete: false },
      historyComplete: ema.complete,
    }
  }

  // An address that is an adapter of a DIA key resolves to the key's feed.
  let feedId: string | null = null
  let sourceOnly: OracleSourceRef | null = null
  if (parsed.kind === 'dia') feedId = diaFeedId(parsed.contract, parsed.key)
  else {
    const s = ctx.snap?.sources.get(parsed.address)
    if (ctx.feedRows.has(parsed.address)) feedId = parsed.address
    else if (s?.dia) feedId = diaFeedId(s.dia.oracle, s.dia.key)
    else if (s || decodeOracleAdapterAddress(parsed.address)) sourceOnly = sourceRef(parsed.address, ctx)
    else return null
  }
  if (sourceOnly) {
    const consumers = overviewConsumersOfAddress(overview, sourceOnly.address)
    return {
      feedId: sourceOnly.address, kind: 'source', label: sourceOnly.label, provider: sourceOnly.provider, contract: sourceOnly.address, key: null,
      decimals: ctx.snap?.sources.get(sourceOnly.address)?.decimals ?? null, latestValue: sourceOnly.value, updatedAt: sourceOnly.updatedAt,
      ageSec: sourceOnly.ageSec, reportedAt: null, status: sourceOnly.status, cadence: null, allTimeUpdates: null, firstUpdateAt: null,
      pushers: [], relays: [], consumers, subject: null, source: sourceOnly, ema: null, chart: null,
      updates: { rows: [], total: 0, page: 0, pageSize: PAGE_SIZE, complete: true }, historyComplete: true,
    }
  }
  const series = feedId ? ctx.view.feeds.get(feedId) : undefined
  const row = feedId ? ctx.feedRows.get(feedId) : undefined
  if (!series || !row) return null
  const consumers = consumersOf(series.feedId)
  const subjects = feedSubjects(consumers, pools)
  const spec = RANGE_SPEC[range]
  const first = series.t[0]
  const from = spec.spanSec == null ? first : Math.max(first - spec.stepSec, nowSec - spec.spanSec)
  const step = spec.spanSec == null && (nowSec - first) / spec.stepSec > 700 ? 2 * DAY_SEC : spec.stepSec
  const grid = makeGrain(step).grid(from, nowSec)
  const dec = row.decimals
  const values = series.v.map(v => Number(unitsDecimal(v, dec)))
  const value = stepValues(series.t, values, grid, step)
  // The nearest consumer whose legs have candles in this window; none → no overlay.
  let subject: { asset: ExplorerAsset; quote: ExplorerAsset | null } | null = null
  let market: (number | null)[] | null = null
  for (const cand of subjects) {
    market = await marketSeries(cand, grid, { ...spec, stepSec: step }, from, nowSec)
    if (market) { subject = cand; break }
  }
  const label = subject ? (subject.quote ? `Market ${subject.asset.symbol}/${subject.quote.symbol}` : `Market ${subject.asset.symbol}`) : 'Market'
  const n = series.t.length
  const updates: FeedUpdateRow[] = []
  for (let i = n - 1 - page * PAGE_SIZE; i >= 0 && updates.length < PAGE_SIZE; i--) {
    const prevV = i > 0 ? series.v[i - 1] : null
    const tx = series.x[i] == null ? null : ctx.tx.get(`${series.b[i]}:${series.x[i]}`)
    updates.push({
      blockHeight: series.b[i], eventIndex: series.e[i], extrinsicIndex: series.x[i], timestamp: isoS(series.t[i]),
      value: unitsDecimal(series.v[i], dec),
      changePct: prevV != null && prevV !== 0n ? Number(((series.v[i] - prevV) * 1_000_000n) / prevV) / 10_000 : null,
      intervalSec: i > 0 ? series.t[i] - series.t[i - 1] : null,
      reportedAt: series.reported[i] ? isoS(series.reported[i]) : null,
      pusher: tx ? evmAccount(tx.from) : null,
    })
  }
  const live = ctx.snap?.sources.get(series.contract)
  return {
    feedId: series.feedId, kind: series.kind, label: row.pair, provider: row.provider, contract: series.contract, key: series.key,
    decimals: dec, latestValue: row.latestValue, updatedAt: row.updatedAt, ageSec: row.ageSec,
    reportedAt: n ? isoS(series.reported[n - 1]) : null,
    status: n <= 1 ? 'static' : row.status, cadence: row.cadence, allTimeUpdates: n, firstUpdateAt: row.firstUpdateAt,
    pushers: row.pushers, relays: row.relays, consumers, subject,
    source: series.kind === 'push' && live ? sourceRef(series.contract, ctx) : null,
    ema: null,
    chart: { range, stepSec: step, buckets: grid, series: [{ key: 'value', label: row.pair, values: value }, ...(market ? [{ key: 'market', label, values: market }] : [])] },
    updates: { rows: updates, total: n, page, pageSize: PAGE_SIZE, complete: ctx.view.historyComplete },
    historyComplete: ctx.view.historyComplete,
  }
}

function overviewConsumersOfAddress(o: OraclesOverview, address: string): OracleConsumer[] {
  const out: OracleConsumer[] = []
  for (const m of o.markets) for (const r of m.reserves) if (r.source.address === address || r.source.components?.some(c => c.address === address)) out.push({ kind: 'reserve', market: m.key, marketLabel: m.label, asset: r.asset, via: r.source.address === address ? null : r.source.address, depth: r.source.address === address ? 0 : 1 })
  for (const p of o.pegs) if (p.source.address === address || p.source.components?.some(c => c.address === address)) out.push({ kind: 'peg', poolId: p.pool.assetId, pool: p.pool, asset: p.asset, via: p.source.address === address ? null : p.source.address, depth: p.source.address === address ? 0 : 1 })
  return out
}

/** One page of a feed's updates (newest first) without the chart. */
export async function getOracleFeedUpdates(rawFeed: string, page: number): Promise<OracleFeedDetail['updates'] | null> {
  const d = await getOracleFeed(rawFeed, '7d', page)
  return d?.updates ?? null
}

/** Test seams for the ledgers. */
export const __testing = {
  addLogRow,
  addEmaRow,
  trimEma,
  buildView,
  emaBuckets,
  setClient(c: ClickHouseClient): void { client = tagged(c) },
  emaInit: () => emaInit,
  reset(): void {
    ledger.rows.clear(); ledger.contracts.clear(); ledger.loadedUpTo = 0; ledger.historyComplete = false; ledger.version++
    ema = freshEma(); emaInit = null; emaTail = null; emaTailAt = 0
    resetFloorProbe('logs'); resetFloorProbe('ema')
    viewMemo = null; snapshot = null
  },
  emaPairs: () => ema.pairs,
  emaComplete: () => ema.complete,
}
