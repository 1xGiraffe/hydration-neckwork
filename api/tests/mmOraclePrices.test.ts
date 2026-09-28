import { describe, expect, it } from 'vitest'
import {
  MM_ORACLE_MAX_AGE_SEC,
  acceptedOraclePrices,
  baseUnitToDecimal,
  decodeAddressArray,
  readMmOraclePrices,
  withMmOraclePrices,
  type TolerantEthCall,
} from '../src/services/mmOraclePrices.ts'

const NOW = 1_790_580_000
const w = (v: bigint | number | string) => (typeof v === 'string' ? v.slice(2) : BigInt(v).toString(16)).padStart(64, '0')

describe('money-market oracle fallback prices', () => {
  it('renders the 1e8 base unit exactly', () => {
    expect(baseUnitToDecimal(8294341046190n)).toBe('82943.4104619')
    expect(baseUnitToDecimal(100000000n)).toBe('1')
    expect(baseUnitToDecimal(5n)).toBe('0.00000005')
  })

  it('accepts only a positive price whose source states a fresh update', () => {
    const got = acceptedOraclePrices([
      { assetId: 19, price: 8294341046190n, updatedAt: BigInt(NOW - 3600) },
      { assetId: 5, price: 121648147n, updatedAt: BigInt(NOW - MM_ORACLE_MAX_AGE_SEC - 1) }, // stale
      { assetId: 10, price: 100000000n, updatedAt: null }, // source cannot state its age
      { assetId: 15, price: 0n, updatedAt: BigInt(NOW) }, // no price
      { assetId: null, price: 1n, updatedAt: BigInt(NOW) }, // unknown reserve
      { assetId: 16, price: 1n, updatedAt: BigInt(NOW + 3600) }, // from the future
    ], NOW)
    expect([...got.keys()]).toEqual([19])
    expect(got.get(19)).toEqual({ priceRaw: '82943.4104619', price: 82943.4104619, updatedAt: NOW - 3600 })
  })

  it('fills only assets the map lacks — a DEX price always wins', () => {
    const map = new Map([[5, { price: 1.22, change24h: 0.01, priceRaw: '1.22' }]])
    const oracle = new Map([
      [5, { priceRaw: '1.2164', price: 1.2164, updatedAt: NOW }],
      [19, { priceRaw: '82943.41', price: 82943.41, updatedAt: NOW }],
    ])
    const filled = withMmOraclePrices(map, oracle, e => ({ price: e.price, priceRaw: e.priceRaw, change24h: 0 }))
    expect(filled).toEqual([19])
    expect(map.get(5)?.price).toBe(1.22)
    expect(map.get(19)).toEqual({ price: 82943.41, priceRaw: '82943.41', change24h: 0 })
  })

  it('decodes an address[] return', () => {
    const hex = '0x' + w(32) + w(2) + w('0x0000000000000000000000000000000100000013') + w('0x0000000000000000000000000000000100000005')
    expect(decodeAddressArray(hex)).toEqual(['0x0000000000000000000000000000000100000013', '0x0000000000000000000000000000000100000005'])
    expect(decodeAddressArray(null)).toEqual([])
  })

  it('reads the market plumbing and refuses an oracle not quoted in USD at 1e8', async () => {
    const provider = '0x' + 'aa'.repeat(20)
    const oracle = '0x' + 'bb'.repeat(20)
    const source = '0x' + 'cc'.repeat(20)
    const wbtc = '0x0000000000000000000000000000000100000013'
    const make = (unit: bigint): TolerantEthCall => async calls => calls.map(c => {
      switch (c.data.slice(0, 10)) {
        case '0x0542975c': return '0x' + w(provider)
        case '0xd1946dbc': return '0x' + w(32) + w(1) + w(wbtc)
        case '0xfca513a8': return '0x' + w(oracle)
        case '0xe19f4700': return '0x' + w(0)
        case '0x8c89b64f': return '0x' + w(unit)
        case '0xb3596f07': return '0x' + w(8294341046190n)
        case '0x92bf2be0': return '0x' + w(source)
        case '0xfeaf968c': return '0x' + w(1) + w(8294341046190n) + w(NOW - 60) + w(NOW - 60) + w(1)
        default: return null
      }
    })
    const got = await readMmOraclePrices(make(100000000n), NOW)
    expect(got?.get(19)?.priceRaw).toBe('82943.4104619')
    expect(await readMmOraclePrices(make(10n ** 18n), NOW)).toBeNull()
  })
})
