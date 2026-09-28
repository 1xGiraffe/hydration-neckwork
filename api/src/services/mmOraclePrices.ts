import { SUBSTRATE_RPC_URL } from './substrateRpc.ts'
import { CORE_MM_MARKET, assetIdFromMmAddress } from './explorerAssets.ts'

// The primary money market's OWN oracle price for its reserves, as the fallback
// current price of a reserve asset no Hydration venue prices any more.
//
// A reserve can outlive its market: WBTC (Wormhole, asset 19) has had no pool
// route since block 12,969,935, so the explorer's price map has no entry for it,
// and aWBTC (its aToken, priced through the alias) shows every supplier at $0 —
// while the market itself keeps valuing that collateral off a live DIA
// "WBTC/USD" push feed through AaveOracle. That feed IS a price for the asset: it
// is what the pool liquidates against. It is used only where no DEX price exists
// (`withMmOraclePrices` never replaces an entry), only from the primary market
// (the isolated markets price their own collateral — stHDX off a lagging feed —
// and must not leak into the shared map), and only while its source's own
// `latestRoundData` says it was updated within MM_ORACLE_MAX_AGE_SEC; a source
// that cannot state its age (a runtime precompile, a reverted call) is unknown,
// and unknown stays unpriced.
//
// Read by the coordinated background refresher (backgroundRefresh.ts) into
// memory — never on a request path. Three batched round trips per cycle.

/** Oldest `updatedAt` accepted. The WBTC feed's longest gap over 2026-09-22..28 was ~17.6 h. */
export const MM_ORACLE_MAX_AGE_SEC = 36 * 3600

export interface MmOraclePrice {
  /** USD price, the oracle's 8-decimal base unit rendered as a decimal string. */
  priceRaw: string
  price: number
  /** Unix seconds of the source's last update. */
  updatedAt: number
}

const SEL = {
  addressesProvider: '0x0542975c', // Pool.ADDRESSES_PROVIDER()
  getPriceOracle: '0xfca513a8', // PoolAddressesProvider.getPriceOracle()
  getReservesList: '0xd1946dbc', // Pool.getReservesList()
  baseCurrency: '0xe19f4700', // AaveOracle.BASE_CURRENCY()
  baseCurrencyUnit: '0x8c89b64f', // AaveOracle.BASE_CURRENCY_UNIT()
  getAssetPrice: '0xb3596f07', // AaveOracle.getAssetPrice(address)
  getSourceOfAsset: '0x92bf2be0', // AaveOracle.getSourceOfAsset(address)
  latestRoundData: '0xfeaf968c', // source.latestRoundData()
}

const USD_BASE_UNIT = 100_000_000n

type Call = { to: string; data: string }
/** Batched eth_call; a call that reverts or goes unanswered is null, never zero. */
export type TolerantEthCall = (calls: Call[]) => Promise<(string | null)[]>

async function tolerantEthCall(calls: Call[]): Promise<(string | null)[]> {
  const out: (string | null)[] = calls.map(() => null)
  for (let start = 0; start < calls.length; start += 50) {
    const chunk = calls.slice(start, start + 50)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    try {
      const res = await fetch(SUBSTRATE_RPC_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify(chunk.map((c, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] }))),
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

const word = (hex: string | null, index: number): bigint | null => {
  if (!hex || hex.length < 2 + 64 * (index + 1)) return null
  return BigInt('0x' + hex.slice(2 + 64 * index, 2 + 64 * (index + 1)))
}
const addressWord = (hex: string | null): string | null => {
  const w = word(hex, 0)
  return w == null ? null : '0x' + w.toString(16).padStart(40, '0')
}
const arg = (address: string) => address.slice(2).toLowerCase().padStart(64, '0')

/** Decode an `address[]` return (offset, length, items). */
export function decodeAddressArray(hex: string | null): string[] {
  const length = word(hex, 1)
  if (length == null || length > 1000n) return []
  const out: string[] = []
  for (let i = 0; i < Number(length); i++) {
    const w = word(hex, 2 + i)
    if (w == null) return []
    out.push('0x' + w.toString(16).padStart(40, '0'))
  }
  return out
}

/** A base-unit (1e8) oracle answer as a decimal string, exactly. */
export function baseUnitToDecimal(value: bigint): string {
  const whole = value / USD_BASE_UNIT
  const frac = (value % USD_BASE_UNIT).toString().padStart(8, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

/**
 * The accepted prices out of one read: a positive `getAssetPrice` whose source
 * reported an update no older than `maxAgeSec` (and not from the future) at `nowSec`.
 */
export function acceptedOraclePrices(
  reads: { assetId: number | null; price: bigint | null; updatedAt: bigint | null }[],
  nowSec: number,
  maxAgeSec: number = MM_ORACLE_MAX_AGE_SEC,
): Map<number, MmOraclePrice> {
  const out = new Map<number, MmOraclePrice>()
  for (const r of reads) {
    if (r.assetId == null || r.price == null || r.price <= 0n || r.updatedAt == null) continue
    const updatedAt = Number(r.updatedAt)
    if (!(updatedAt > 0) || updatedAt > nowSec + 300 || nowSec - updatedAt > maxAgeSec) continue
    const priceRaw = baseUnitToDecimal(r.price)
    out.set(r.assetId, { priceRaw, price: Number(priceRaw), updatedAt })
  }
  return out
}

/**
 * Read every primary-market reserve's oracle price and its source's age. Null
 * when the market's plumbing cannot be read or its oracle is not quoted in USD
 * at 1e8 (then no reserve has a price we can state).
 */
export async function readMmOraclePrices(ethCall: TolerantEthCall = tolerantEthCall, nowSec = Math.floor(Date.now() / 1000)): Promise<Map<number, MmOraclePrice> | null> {
  const pool = CORE_MM_MARKET.poolProxy
  const [providerHex, reservesHex] = await ethCall([{ to: pool, data: SEL.addressesProvider }, { to: pool, data: SEL.getReservesList }])
  const provider = addressWord(providerHex)
  const reserves = decodeAddressArray(reservesHex)
  if (!provider || !reserves.length) return null
  const [oracleHex] = await ethCall([{ to: provider, data: SEL.getPriceOracle }])
  const oracle = addressWord(oracleHex)
  if (!oracle) return null
  const head = await ethCall([
    { to: oracle, data: SEL.baseCurrency },
    { to: oracle, data: SEL.baseCurrencyUnit },
    ...reserves.flatMap(r => [
      { to: oracle, data: SEL.getAssetPrice + arg(r) },
      { to: oracle, data: SEL.getSourceOfAsset + arg(r) },
    ]),
  ])
  // BASE_CURRENCY 0x0 is USD by Aave's convention; the unit fixes the decimals.
  if (word(head[0], 0) !== 0n || word(head[1], 0) !== USD_BASE_UNIT) return null
  const sources = reserves.map((_, i) => addressWord(head[3 + 2 * i]))
  const rounds = await ethCall(sources.map(s => ({ to: s ?? oracle, data: SEL.latestRoundData })))
  return acceptedOraclePrices(reserves.map((reserve, i) => ({
    assetId: assetIdFromMmAddress(reserve),
    price: word(head[2 + 2 * i], 0),
    // latestRoundData → (roundId, answer, startedAt, updatedAt, answeredInRound)
    updatedAt: sources[i] ? word(rounds[i], 3) : null,
  })), nowSec)
}

let snapshot = new Map<number, MmOraclePrice>()
let snapshotAt = 0
/** Refresher-held entries are dropped once the refresher stops renewing them. */
const SNAPSHOT_MAX_AGE_MS = 20 * 60_000

export async function refreshMmOraclePrices(): Promise<void> {
  const next = await readMmOraclePrices()
  if (!next) return
  snapshot = next
  snapshotAt = Date.now()
}

export function currentMmOraclePrices(nowMs = Date.now()): ReadonlyMap<number, MmOraclePrice> {
  return nowMs - snapshotAt <= SNAPSHOT_MAX_AGE_MS ? snapshot : new Map()
}

/**
 * Fill a current price map from the oracle for exactly the assets it lacks —
 * a DEX price always wins. Returns the ids it filled, so the caller can re-run
 * its alias pass (an aToken over a newly priced reserve).
 */
export function withMmOraclePrices<P extends { price: number; change24h: number; priceRaw?: string }>(
  map: Map<number, P>,
  oracle: ReadonlyMap<number, MmOraclePrice>,
  make: (entry: MmOraclePrice) => P,
): number[] {
  const filled: number[] = []
  for (const [assetId, entry] of oracle) {
    if (map.has(assetId)) continue
    map.set(assetId, make(entry))
    filled.push(assetId)
  }
  return filled
}

/** Test seam: install a snapshot directly. */
export function setMmOraclePricesForTest(entries: Map<number, MmOraclePrice>, atMs = Date.now()): void {
  snapshot = entries
  snapshotAt = atMs
}
