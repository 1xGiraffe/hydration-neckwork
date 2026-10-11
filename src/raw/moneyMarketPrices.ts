// Money-market oracle prices per block, for the raw indexer's price-step trigger.
//
// Each isolated market (core, GIGAHDX, BIL) prices its reserves through the
// AaveOracle its PoolAddressesProvider names. A health factor moves between a
// holder's own actions when a reserve price moves; the oracle is a DIA push (a
// step function), so a step is visible as a difference between one block's
// getAssetsPrices and the previous block's. Per block and market this module
// reads getAssetsPrices(reserves) at the block, compares it with block b − 1 and
// names the reserves that moved by at least RAW_MM_PRICE_STEP_BP basis points.
//
// Pure function of chain state: the comparison is always against block b − 1, so
// a range worker reads b − 1 itself at its first block (and after any gap) and
// every worker that processes a block finds the same steps — a replay writes the
// same reads. The market's configuration (oracle, reserve list, each reserve's
// aToken and variable-debt token, the PoolConfigurator) is resolved once per
// worker and again at any block carrying a PoolConfigurator or
// PoolAddressesProvider log of that market.

import type { EthCall, EthCallBatch } from './moneyMarket.js'
import type { ReserveTokens } from './moneyMarketSnapshot.js'

export const MM_SELECTORS = {
  addressesProvider: '0x0542975c', // ADDRESSES_PROVIDER()
  getPriceOracle: '0xfca513a8', // getPriceOracle()
  getPoolConfigurator: '0x631adfca', // getPoolConfigurator()
  getReservesList: '0xd1946dbc', // getReservesList()
  getReserveData: '0x35ea6a75', // getReserveData(address)
  getAssetsPrices: '0x9d23d9f2', // getAssetsPrices(address[])
  getAssetPrice: '0xb3596f07', // getAssetPrice(address)
} as const

const pad32 = (hex: string): string => hex.toLowerCase().replace(/^0x/, '').padStart(64, '0')

export function encodeAddressArg(selector: string, address: string): string {
  return `${selector}${pad32(address)}`
}

export function encodeGetAssetsPrices(reserves: readonly string[]): string {
  return `${MM_SELECTORS.getAssetsPrices}${pad32('20')}${pad32(reserves.length.toString(16))}${reserves.map(pad32).join('')}`
}

function words(result: string | null | undefined): string[] | null {
  if (typeof result !== 'string' || !result.startsWith('0x')) return null
  const body = result.slice(2)
  if (body.length === 0 || body.length % 64 !== 0) return null
  const out: string[] = []
  for (let i = 0; i < body.length; i += 64) out.push(body.slice(i, i + 64))
  return out
}

/** The address in a single-word return (null for anything else or the zero address). */
export function decodeAddressWord(result: string | null | undefined): string | null {
  const w = words(result)
  if (w == null || w.length < 1) return null
  const address = `0x${w[0].slice(24)}`
  return /^0x0{40}$/.test(address) ? null : address
}

function decodeDynamicArray(result: string | null | undefined): string[] | null {
  const w = words(result)
  if (w == null || w.length < 2) return null
  const offset = Number(BigInt(`0x${w[0]}`))
  if (offset % 32 !== 0) return null
  const at = offset / 32
  if (at >= w.length) return null
  const count = Number(BigInt(`0x${w[at]}`))
  if (!Number.isSafeInteger(count) || at + 1 + count > w.length) return null
  return w.slice(at + 1, at + 1 + count)
}

/** address[] (getReservesList). */
export function decodeAddressArray(result: string | null | undefined): string[] | null {
  return decodeDynamicArray(result)?.map(word => `0x${word.slice(24)}`) ?? null
}

/** uint256[] (getAssetsPrices). */
export function decodeUint256Array(result: string | null | undefined): bigint[] | null {
  return decodeDynamicArray(result)?.map(word => BigInt(`0x${word}`)) ?? null
}

/** uint256 (getAssetPrice). */
export function decodeUint256(result: string | null | undefined): bigint | null {
  const w = words(result)
  return w == null || w.length !== 1 ? null : BigInt(`0x${w[0]}`)
}

/**
 * getReserveData's aToken and variable-debt token: Aave v3's ReserveData is
 * (configuration, liquidityIndex, currentLiquidityRate, variableBorrowIndex,
 * currentVariableBorrowRate, currentStableBorrowRate, lastUpdateTimestamp, id,
 * aTokenAddress, stableDebtTokenAddress, variableDebtTokenAddress, …) — words 8
 * and 10 (verified against atoken_reserve_map on all three markets).
 */
export function decodeReserveTokens(result: string | null | undefined): { aToken: string; variableDebt: string } | null {
  const w = words(result)
  if (w == null || w.length < 11) return null
  return { aToken: `0x${w[8].slice(24)}`, variableDebt: `0x${w[10].slice(24)}` }
}

// ───────────────────────── the step rule ─────────────────────────

/**
 * RAW_MM_PRICE_STEP_BP as hundredths of a basis point (an integer, so the rule is
 * integer arithmetic): default 1 bp = 100. Accepts a decimal ("0.5").
 */
export function priceStepThresholdFromEnvironment(raw = process.env.RAW_MM_PRICE_STEP_BP): bigint {
  const text = raw?.trim()
  if (!text) return 100n
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error(`RAW_MM_PRICE_STEP_BP must be a non-negative number of basis points (≤ 2 decimals), got "${raw}"`)
  const [whole, frac = ''] = text.split('.')
  const value = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'))
  if (value <= 0n) throw new Error('RAW_MM_PRICE_STEP_BP must be greater than zero')
  return value
}

/**
 * A step: |next − prev| ≥ threshold × prev, threshold in hundredths of a bp
 * (|Δ| · 1,000,000 ≥ threshold · prev). A price appearing from or falling to zero
 * is a step; an unknown side (a failed read) is not.
 */
export function isPriceStep(prev: bigint | undefined, next: bigint | undefined, thresholdBp100: bigint): boolean {
  if (prev == null || next == null || prev === next) return false
  if (prev === 0n || next === 0n) return true
  const diff = next > prev ? next - prev : prev - next
  return diff * 1_000_000n >= thresholdBp100 * prev
}

/** The reserves (sorted) whose price stepped between two reads. */
export function priceSteps(prev: ReadonlyMap<string, bigint>, next: ReadonlyMap<string, bigint>, thresholdBp100: bigint): string[] {
  const out: string[] = []
  for (const [reserve, price] of next) if (isPriceStep(prev.get(reserve), price, thresholdBp100)) out.push(reserve)
  return out.sort()
}

// ───────────────────────── market configuration ─────────────────────────

export interface MarketOracleConfig {
  key: string
  pool: string
  provider: string
  oracle: string
  configurator: string | null
  reserves: string[]
  reserveTokens: ReserveTokens[]
  resolvedAt: number
}

/** Contracts whose logs re-resolve a market (its PoolConfigurator and PoolAddressesProvider). */
export function configContracts(config: MarketOracleConfig): string[] {
  return [config.provider, ...(config.configurator ? [config.configurator] : [])]
}

/**
 * Resolve a market at `blockHeight`: provider → oracle and configurator, the
 * reserve list, and each reserve's aToken / variable-debt token. Throws when the
 * pool, provider or oracle cannot be read (a market not deployed yet).
 */
export async function resolveMarketOracleConfig(
  market: { key: string; pool: string },
  blockHeight: number,
  call: EthCallBatch,
): Promise<MarketOracleConfig> {
  const pool = market.pool.toLowerCase()
  const [providerRaw, reservesRaw] = await call([
    { to: pool, data: MM_SELECTORS.addressesProvider },
    { to: pool, data: MM_SELECTORS.getReservesList },
  ], blockHeight)
  const provider = decodeAddressWord(providerRaw)
  const reserves = decodeAddressArray(reservesRaw)
  if (provider == null || reserves == null) throw new Error(`money market ${market.key}: pool ${pool} unreadable at block ${blockHeight}`)
  const [oracleRaw, configuratorRaw, ...reserveData] = await call([
    { to: provider, data: MM_SELECTORS.getPriceOracle },
    { to: provider, data: MM_SELECTORS.getPoolConfigurator },
    ...reserves.map(reserve => ({ to: pool, data: encodeAddressArg(MM_SELECTORS.getReserveData, reserve) })),
  ], blockHeight)
  const oracle = decodeAddressWord(oracleRaw)
  if (oracle == null) throw new Error(`money market ${market.key}: provider ${provider} names no price oracle at block ${blockHeight}`)
  const reserveTokens: ReserveTokens[] = []
  reserves.forEach((reserve, index) => {
    const tokens = decodeReserveTokens(reserveData[index])
    if (tokens == null) throw new Error(`money market ${market.key}: getReserveData(${reserve}) unreadable at block ${blockHeight}`)
    reserveTokens.push({ reserve, tokens: [tokens.aToken, tokens.variableDebt] })
  })
  return { key: market.key, pool, provider, oracle, configurator: decodeAddressWord(configuratorRaw), reserves, reserveTokens, resolvedAt: blockHeight }
}

/**
 * Every market's reserve prices at one block: one batched getAssetsPrices per
 * market. A market whose batch call fails (one reserve's source reverting reverts
 * them all) is re-read reserve by reserve with getAssetPrice; a reserve that still
 * fails is absent from its map (unknown — never a step). A market whose every
 * read failed maps to an Error.
 */
export async function readMarketPrices(
  configs: readonly MarketOracleConfig[],
  blockHeight: number,
  call: EthCallBatch,
): Promise<Map<string, Map<string, bigint> | Error>> {
  const out = new Map<string, Map<string, bigint> | Error>()
  const batch = await call(configs.map(c => ({ to: c.oracle, data: encodeGetAssetsPrices(c.reserves) })), blockHeight)
  const retry: MarketOracleConfig[] = []
  configs.forEach((config, index) => {
    const prices = decodeUint256Array(batch[index])
    if (prices == null || prices.length !== config.reserves.length) {
      retry.push(config)
      return
    }
    out.set(config.pool, new Map(config.reserves.map((reserve, i) => [reserve, prices[i]])))
  })
  if (retry.length > 0) {
    const calls: EthCall[] = retry.flatMap(c => c.reserves.map(reserve => ({ to: c.oracle, data: encodeAddressArg(MM_SELECTORS.getAssetPrice, reserve) })))
    const single = await call(calls, blockHeight)
    let k = 0
    for (const config of retry) {
      const prices = new Map<string, bigint>()
      for (const reserve of config.reserves) {
        const price = decodeUint256(single[k++])
        if (price != null) prices.set(reserve, price)
      }
      out.set(config.pool, prices.size > 0 ? prices : new Error(`money market ${config.key}: oracle ${config.oracle} answered no price at block ${blockHeight}`))
    }
  }
  return out
}

// ───────────────────────── the per-block tracker ─────────────────────────

/** One raw_money_market_oracle_prices row. */
export interface MoneyMarketOraclePriceRow {
  block_height: number
  block_timestamp: string
  pool_address: string
  reserve_address: string
  oracle_address: string
  price: string
  /** 1: the price differs from block b − 1's; 0: a baseline row (first resolve, cadence). */
  is_change: number
}

export interface PriceObservation {
  /** pool → stepped reserves (sorted). */
  steps: Map<string, string[]>
  /** Pools re-resolved at this block because of one of their configuration logs. */
  configChanged: Set<string>
  /** Pools whose price read failed at this block (no step can be stated). */
  failed: Map<string, string>
  prices: Map<string, Map<string, bigint>>
  /** Block b − 1's prices the steps were measured against. */
  previous: Map<string, Map<string, bigint>>
  /** Pools (re-)resolved at this block: their first block, or a configuration change. */
  resolved: Set<string>
  /** eth_calls this observation made. */
  calls: number
}

/**
 * Holds each market's configuration and the previous block's prices. observe()
 * per block, in order: re-resolves a market on its configuration logs, reads the
 * block's prices, reads b − 1's when the previous observation was not b − 1 (a
 * worker's first block, a gap, a re-resolved reserve list) and returns the steps.
 */
export class MoneyMarketPriceTracker {
  private configs = new Map<string, MarketOracleConfig>()
  private last: { height: number; prices: Map<string, Map<string, bigint>> } | null = null
  private calls = 0
  private readonly counted: EthCallBatch

  constructor(
    private readonly markets: ReadonlyArray<{ key: string; pool: string }>,
    call: EthCallBatch,
    private readonly thresholdBp100: bigint,
  ) {
    this.counted = async (batch, height) => {
      this.calls += batch.length
      return call(batch, height)
    }
  }

  configsResolved(): MarketOracleConfig[] {
    return [...this.configs.values()]
  }

  /** Resolve every market not resolved yet (and every market named) at `blockHeight`. */
  async resolve(blockHeight: number, pools: Iterable<string> = []): Promise<{ resolved: string[]; failed: Map<string, string> }> {
    const want = new Set([...pools].map(p => p.toLowerCase()))
    const resolved: string[] = []
    const failed = new Map<string, string>()
    for (const market of this.markets) {
      const pool = market.pool.toLowerCase()
      if (this.configs.has(pool) && !want.has(pool)) continue
      try {
        this.configs.set(pool, await resolveMarketOracleConfig(market, blockHeight, this.counted))
        resolved.push(pool)
      } catch (error) {
        failed.set(pool, error instanceof Error ? error.message : String(error))
      }
    }
    return { resolved, failed }
  }

  /** The pools whose configuration contracts emitted any of these logs. */
  configLogPools(logs: Iterable<{ contract_address: string }>): Set<string> {
    const byContract = new Map<string, string>()
    for (const config of this.configs.values()) for (const c of configContracts(config)) byContract.set(c, config.pool)
    const out = new Set<string>()
    for (const log of logs) {
      const pool = byContract.get(log.contract_address.toLowerCase())
      if (pool != null) out.add(pool)
    }
    return out
  }

  async observe(blockHeight: number, logs: Iterable<{ contract_address: string }>): Promise<PriceObservation> {
    const before = this.calls
    const configChanged = this.configLogPools(logs)
    const { resolved, failed: resolveFailed } = await this.resolve(blockHeight, configChanged)
    const configs = [...this.configs.values()]
    const current = await readMarketPrices(configs, blockHeight, this.counted)
    let previous = this.last?.height === blockHeight - 1 ? this.last.prices : null
    const resolvedNow = new Set(resolved)
    // b − 1 is read when it is not held (a first block, a gap) or a market was just
    // re-resolved (its reserve list may have grown): only the markets lacking it.
    const needPrevious = configs.filter(c => previous?.get(c.pool) == null || resolvedNow.has(c.pool))
    if (needPrevious.length > 0 && blockHeight > 0) {
      const read = await readMarketPrices(needPrevious, blockHeight - 1, this.counted)
      const merged = new Map(previous ?? [])
      for (const [pool, prices] of read) if (!(prices instanceof Error)) merged.set(pool, prices)
      previous = merged
    }
    const steps = new Map<string, string[]>()
    const prices = new Map<string, Map<string, bigint>>()
    const failed = new Map(resolveFailed)
    for (const config of configs) {
      const now = current.get(config.pool)
      if (now == null || now instanceof Error) {
        failed.set(config.pool, now instanceof Error ? now.message : 'no price read')
        continue
      }
      prices.set(config.pool, now)
      const stepped = priceSteps(previous?.get(config.pool) ?? new Map(), now, this.thresholdBp100)
      if (stepped.length > 0) steps.set(config.pool, stepped)
    }
    this.last = { height: blockHeight, prices }
    // A failed market keeps no previous prices: the next block re-reads its b − 1.
    return {
      steps,
      configChanged,
      failed,
      prices,
      previous: new Map(previous ?? []),
      resolved: resolvedNow,
      calls: this.calls - before,
    }
  }
}

/**
 * The oracle-price rows of one observation: a row for every reserve whose price
 * differs from b − 1's (`is_change` 1), and — when `baseline` (a market's first
 * resolve, a configuration change, the cadence block) — every reserve's price
 * (`is_change` 0 where it did not move), so argMax(≤ B) is always resolvable within
 * one cadence interval.
 */
export function oraclePriceRows(
  block: { height: number; timestamp: string },
  configs: readonly MarketOracleConfig[],
  previous: ReadonlyMap<string, ReadonlyMap<string, bigint>> | null,
  current: ReadonlyMap<string, ReadonlyMap<string, bigint>>,
  baselinePools: ReadonlySet<string>,
): MoneyMarketOraclePriceRow[] {
  const rows: MoneyMarketOraclePriceRow[] = []
  for (const config of configs) {
    const now = current.get(config.pool)
    if (now == null) continue
    const before = previous?.get(config.pool)
    for (const reserve of [...now.keys()].sort()) {
      const price = now.get(reserve)!
      const prior = before?.get(reserve)
      const changed = prior != null && prior !== price
      if (!changed && !baselinePools.has(config.pool)) continue
      rows.push({
        block_height: block.height,
        block_timestamp: block.timestamp,
        pool_address: config.pool,
        reserve_address: reserve,
        oracle_address: config.oracle,
        price: price.toString(),
        is_change: changed ? 1 : 0,
      })
    }
  }
  return rows
}
