import { describe, expect, it } from 'vitest'
import {
  decodeAddressArray,
  decodeAddressWord,
  decodeReserveTokens,
  decodeUint256Array,
  encodeGetAssetsPrices,
  isPriceStep,
  MM_SELECTORS,
  MoneyMarketPriceTracker,
  oraclePriceRows,
  priceStepThresholdFromEnvironment,
  priceSteps,
  readMarketPrices,
  resolveMarketOracleConfig,
  type MarketOracleConfig,
} from '../../src/raw/moneyMarketPrices.ts'
import type { EthCall } from '../../src/raw/moneyMarket.ts'

const POOL = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const PROVIDER = '0xf3ba4d1b50f78301bdd7eaea9b67822a15fca691'
const ORACLE = '0xad33c0f0c42c5a0eaa65b5895d2bdb20cb6e8760'
const CONFIGURATOR = '0xe64c38e2fa00dfe4f1d0b92f75b8e44ebdf292e4'
const DOT = '0x0000000000000000000000000000000100000005'
const USDT = '0x000000000000000000000000000000010000000a'
const A_DOT = '0x02639ec01313c8775fae74f2dad1118c8a8a86da'
const V_DOT = '0x34321cb7334807eb718b3e1ddfaeb0c6c0403f1a'
const A_USDT = '0xc64980e4eaf9a1151bd21712b9946b81e41e2b92'
const V_USDT = '0x32a8090e20748e530670ff520c4abc903db7e127'

const word = (v: bigint | string) => (typeof v === 'string' ? v.replace(/^0x/, '') : v.toString(16)).padStart(64, '0')
const addressResult = (a: string) => `0x${word(a)}`
const arrayResult = (items: Array<bigint | string>) => `0x${word(32n)}${word(BigInt(items.length))}${items.map(word).join('')}`
const reserveData = (aToken: string, vDebt: string) => `0x${[0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n].map(word).join('')}${word(aToken)}${word(0n)}${word(vDebt)}${[0n, 0n, 0n, 0n].map(word).join('')}`

describe('ABI helpers', () => {
  it('encodes getAssetsPrices(address[]) and decodes the arrays it and getReservesList return', () => {
    expect(encodeGetAssetsPrices([DOT])).toBe(`${MM_SELECTORS.getAssetsPrices}${word(32n)}${word(1n)}${word(DOT)}`)
    expect(decodeAddressArray(arrayResult([DOT, USDT]))).toEqual([DOT, USDT])
    expect(decodeUint256Array(arrayResult([5n, 7n]))).toEqual([5n, 7n])
    expect(decodeUint256Array('0x')).toBeNull()
    expect(decodeUint256Array(null)).toBeNull()
  })

  it('reads an address word, treating the zero address as none', () => {
    expect(decodeAddressWord(addressResult(ORACLE))).toBe(ORACLE)
    expect(decodeAddressWord(`0x${word(0n)}`)).toBeNull()
  })

  it('takes the aToken and variable-debt token from words 8 and 10 of getReserveData', () => {
    expect(decodeReserveTokens(reserveData(A_DOT, V_DOT))).toEqual({ aToken: A_DOT, variableDebt: V_DOT })
    expect(decodeReserveTokens(`0x${word(1n)}`)).toBeNull()
  })
})

describe('the price-step rule', () => {
  it('defaults to 1 bp, accepts decimals and refuses nonsense', () => {
    expect(priceStepThresholdFromEnvironment(undefined)).toBe(100n)
    expect(priceStepThresholdFromEnvironment('0.5')).toBe(50n)
    expect(priceStepThresholdFromEnvironment('2')).toBe(200n)
    expect(() => priceStepThresholdFromEnvironment('-1')).toThrow()
    expect(() => priceStepThresholdFromEnvironment('0')).toThrow()
    expect(() => priceStepThresholdFromEnvironment('1bp')).toThrow()
  })

  it('is a step at exactly the threshold and not below it', () => {
    expect(isPriceStep(1_000_000n, 1_000_100n, 100n)).toBe(true) // +1 bp
    expect(isPriceStep(1_000_000n, 999_900n, 100n)).toBe(true) // −1 bp
    expect(isPriceStep(1_000_000n, 1_000_099n, 100n)).toBe(false)
    expect(isPriceStep(1_000_000n, 1_000_000n, 100n)).toBe(false)
  })

  it('treats a price appearing or vanishing as a step and an unknown side as none', () => {
    expect(isPriceStep(0n, 5n, 100n)).toBe(true)
    expect(isPriceStep(5n, 0n, 100n)).toBe(true)
    expect(isPriceStep(undefined, 5n, 100n)).toBe(false)
    expect(isPriceStep(5n, undefined, 100n)).toBe(false)
  })

  it('names the stepped reserves, sorted', () => {
    const prev = new Map([[USDT, 100_000_000n], [DOT, 400_000_000n]])
    const next = new Map([[USDT, 100_000_001n], [DOT, 404_000_000n]])
    expect(priceSteps(prev, next, 100n)).toEqual([DOT])
  })
})

// A scripted chain: per block, the oracle's prices; the market's configuration.
function fakeChain(pricesAt: (block: number) => Record<string, bigint>, opts: { reserves?: string[]; batchFailsAt?: Set<number> } = {}) {
  const calls: Array<{ block: number; call: EthCall }> = []
  const reserves = () => opts.reserves ?? [DOT, USDT]
  const answer = (call: EthCall, block: number): string | null => {
    const to = call.to.toLowerCase()
    if (to === POOL && call.data === MM_SELECTORS.addressesProvider) return addressResult(PROVIDER)
    if (to === POOL && call.data === MM_SELECTORS.getReservesList) return arrayResult(reserves())
    if (to === POOL && call.data.startsWith(MM_SELECTORS.getReserveData)) {
      const reserve = `0x${call.data.slice(-40)}`
      return reserve === DOT ? reserveData(A_DOT, V_DOT) : reserveData(A_USDT, V_USDT)
    }
    if (to === PROVIDER && call.data === MM_SELECTORS.getPriceOracle) return addressResult(ORACLE)
    if (to === PROVIDER && call.data === MM_SELECTORS.getPoolConfigurator) return addressResult(CONFIGURATOR)
    if (to === ORACLE && call.data.startsWith(MM_SELECTORS.getAssetsPrices)) {
      if (opts.batchFailsAt?.has(block)) return null
      const prices = pricesAt(block)
      // AaveOracle reverts the whole batch when one source cannot answer.
      if (reserves().some(r => prices[r] == null)) return null
      return arrayResult(reserves().map(r => prices[r]))
    }
    if (to === ORACLE && call.data.startsWith(MM_SELECTORS.getAssetPrice)) {
      const price = pricesAt(block)[`0x${call.data.slice(-40)}`]
      return price == null ? null : `0x${word(price)}`
    }
    return null
  }
  return {
    calls,
    ethCall: async (batch: EthCall[], block: number) => batch.map(call => {
      calls.push({ block, call })
      return answer(call, block)
    }),
  }
}

describe('market configuration and prices', () => {
  it('resolves the oracle, configurator, reserves and their tokens from the pool', async () => {
    const chain = fakeChain(() => ({}))
    const config = await resolveMarketOracleConfig({ key: 'core', pool: POOL }, 10, chain.ethCall)
    expect(config).toEqual({
      key: 'core', pool: POOL, provider: PROVIDER, oracle: ORACLE, configurator: CONFIGURATOR, reserves: [DOT, USDT],
      reserveTokens: [{ reserve: DOT, tokens: [A_DOT, V_DOT] }, { reserve: USDT, tokens: [A_USDT, V_USDT] }],
      resolvedAt: 10,
    })
  })

  it('falls back to per-reserve getAssetPrice when the batch reverts, leaving an unanswered reserve unknown', async () => {
    const chain = fakeChain(() => ({ [DOT]: 7n }), { batchFailsAt: new Set([5]) })
    const config = await resolveMarketOracleConfig({ key: 'core', pool: POOL }, 5, chain.ethCall)
    const prices = await readMarketPrices([config], 5, chain.ethCall)
    expect(prices.get(POOL)).toEqual(new Map([[DOT, 7n]]))
  })
})

describe('MoneyMarketPriceTracker', () => {
  const dotAt = (block: number) => ({ [DOT]: block >= 102 ? 404_000_000n : 400_000_000n, [USDT]: 100_000_000n })

  it('reads b − 1 at its first block, then compares block by block without re-reading', async () => {
    const chain = fakeChain(dotAt)
    const tracker = new MoneyMarketPriceTracker([{ key: 'core', pool: POOL }], chain.ethCall, 100n)
    const first = await tracker.observe(100, [])
    expect(first.steps.size).toBe(0)
    expect(first.resolved).toEqual(new Set([POOL]))
    expect(chain.calls.filter(c => c.call.data.startsWith(MM_SELECTORS.getAssetsPrices)).map(c => c.block)).toEqual([100, 99])
    chain.calls.length = 0
    expect((await tracker.observe(101, [])).steps.size).toBe(0)
    const step = await tracker.observe(102, [])
    expect(step.steps).toEqual(new Map([[POOL, [DOT]]]))
    expect(chain.calls.map(c => c.block)).toEqual([101, 102])
  })

  it('finds the same step whichever block a worker started on (b − 1 is read, never assumed)', async () => {
    const a = new MoneyMarketPriceTracker([{ key: 'core', pool: POOL }], fakeChain(dotAt).ethCall, 100n)
    await a.observe(101, [])
    const b = new MoneyMarketPriceTracker([{ key: 'core', pool: POOL }], fakeChain(dotAt).ethCall, 100n)
    expect((await a.observe(102, [])).steps).toEqual((await b.observe(102, [])).steps)
    // A gap re-reads b − 1 too.
    const gap = await a.observe(110, [])
    expect(gap.steps.size).toBe(0)
  })

  it('re-resolves a market on its configurator log and reports it as a config change', async () => {
    const chain = fakeChain(dotAt)
    const tracker = new MoneyMarketPriceTracker([{ key: 'core', pool: POOL }], chain.ethCall, 100n)
    await tracker.observe(100, [])
    chain.calls.length = 0
    const obs = await tracker.observe(101, [{ contract_address: CONFIGURATOR.toUpperCase().replace('0X', '0x') }])
    expect(obs.configChanged).toEqual(new Set([POOL]))
    expect(obs.resolved).toEqual(new Set([POOL]))
    expect(chain.calls.some(c => c.call.data === MM_SELECTORS.getReservesList && c.block === 101)).toBe(true)
    expect((await tracker.observe(102, [{ contract_address: '0x1111111111111111111111111111111111111111' }])).configChanged.size).toBe(0)
  })

  it('reports a market whose oracle answered nothing as failed, with no step', async () => {
    const chain = fakeChain(() => ({}))
    const tracker = new MoneyMarketPriceTracker([{ key: 'core', pool: POOL }], chain.ethCall, 100n)
    const obs = await tracker.observe(100, [])
    expect(obs.failed.has(POOL)).toBe(true)
    expect(obs.steps.size).toBe(0)
  })
})

describe('oracle price rows', () => {
  const config = { key: 'core', pool: POOL, provider: PROVIDER, oracle: ORACLE, configurator: CONFIGURATOR, reserves: [DOT, USDT], reserveTokens: [], resolvedAt: 1 } satisfies MarketOracleConfig
  const block = { height: 7, timestamp: '2026-10-10 10:00:00' }
  const prev = new Map([[POOL, new Map([[DOT, 1n], [USDT, 2n]])]])
  const now = new Map([[POOL, new Map([[DOT, 3n], [USDT, 2n]])]])

  it('writes a row for each price that differs from b − 1', () => {
    expect(oraclePriceRows(block, [config], prev, now, new Set())).toEqual([
      { block_height: 7, block_timestamp: block.timestamp, pool_address: POOL, reserve_address: DOT, oracle_address: ORACLE, price: '3', is_change: 1 },
    ])
  })

  it('writes every reserve on a baseline block, unmoved ones as is_change 0', () => {
    expect(oraclePriceRows(block, [config], prev, now, new Set([POOL])).map(r => [r.reserve_address, r.is_change])).toEqual([[DOT, 1], [USDT, 0]])
  })
})
