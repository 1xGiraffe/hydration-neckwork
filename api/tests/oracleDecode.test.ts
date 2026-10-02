import { describe, expect, it } from 'vitest'
import {
  CADENCE_SPAN_SEC, DAY_SEC, FALLBACK_HEARTBEAT_SEC, ORACLE_TOPICS,
  bytecodeIsConstant, cadenceStats, countSince, decodeAssetSourceUpdated, decodeEmaOracleUpdated, decodeOracleAdapterAddress,
  decodeEmaPeriods, decodeOracleUpdate, decodePriceUpdated, decodeUpdaterAddressChange, emaPriceDecimal, feedStatus, parseEmaAssets,
  ratioDecimal, sourceAscii, staleAfterSec, unitsDecimal,
} from '../src/services/oracleDecode.ts'

// Fixtures are real chain rows (raw_evm_logs / raw_events), so the decoders are
// pinned against what the indexer actually stores.

describe('DIA OracleUpdate', () => {
  it('decodes key, 8-decimal value and DIA timestamp from the data', () => {
    const data = '0x0000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000044261ec66000000000000000000000000000000000000000000000000000000006abfeee00000000000000000000000000000000000000000000000000000000000000008414156452f555344000000000000000000000000000000000000000000000000'
    const d = decodeOracleUpdate(data)!
    expect(d.key).toBe('AAVE/USD')
    expect(d.value).toBe(18293582950n)
    expect(d.timestamp).toBe(1790963424)
    expect(unitsDecimal(d.value, 8)).toBe('182.9358295')
  })
  it('refuses truncated data instead of guessing', () => {
    expect(decodeOracleUpdate('0x0000000000000000000000000000000000000000000000000000000000000060')).toBeNull()
  })
})

describe('Chainlink-style PriceUpdated', () => {
  const topics = [ORACLE_TOPICS.priceUpdated, '0x0000000000000000000000000000000000000000000000000000000000000613']
  const data = '0x00000000000000000000000000000000000000000000000000000002d0db5f19000000000000000000000000000000000000000000000000000000006abfc594'
  it('reads the round from topic 1 and answer/timestamp from the data', () => {
    const d = decodePriceUpdated(topics, data)!
    expect(d.roundId).toBe(1555n)
    expect(d.answer).toBe(12093972249n)
    expect(d.timestamp).toBe(1790952852)
  })
  it('keeps the answer when the topics were not read', () => {
    expect(decodePriceUpdated([], data)).toEqual({ roundId: null, answer: 12093972249n, timestamp: 1790952852 })
  })
  it('reads the answer as a signed int256', () => {
    const neg = '0x' + 'f'.repeat(63) + 'f' + '0'.repeat(56) + '6abfc594'
    expect(decodePriceUpdated(topics, neg)!.answer).toBe(-1n)
  })
})

describe('AaveOracle AssetSourceUpdated and DIA UpdaterAddressChange', () => {
  it('takes the asset from topic 1 and the source from topic 2', () => {
    expect(decodeAssetSourceUpdated([
      ORACLE_TOPICS.assetSourceUpdated,
      '0x000000000000000000000000000000000000000000000000000000010000002e',
      '0x00000000000000000000000080faac4da72fccabda5b276d9a931252d6242caf',
    ])).toEqual({ asset: '0x000000000000000000000000000000010000002e', source: '0x80faac4da72fccabda5b276d9a931252d6242caf' })
    expect(decodeAssetSourceUpdated([ORACLE_TOPICS.assetSourceUpdated])).toBeNull()
  })
  it('reads the new updater from the data word', () => {
    expect(decodeUpdaterAddressChange('0x000000000000000000000000e15fe4fe12389f8335ed679fc5e6e0b69eef460d')).toBe('0xe15fe4fe12389f8335ed679fc5e6e0b69eef460d')
  })
})

describe('EmaOracle.OracleUpdated', () => {
  it('reads the hex-byte asset pair and the JSON-array pair alike', () => {
    expect(parseEmaAssets('0x050f')).toEqual([5, 15])
    expect(parseEmaAssets('0x01de')).toEqual([1, 222])
    expect(parseEmaAssets([15, 690])).toEqual([15, 690])
    expect(parseEmaAssets('0x05')).toBeNull()
    expect(parseEmaAssets([1])).toBeNull()
  })
  it('decodes source, pair and every period ratio', () => {
    const u = decodeEmaOracleUpdated('{"source":"0x626966726f73746f","assets":"0x050f","updates":[[{"__kind":"LastBlock"},{"n":"82033684351695483","d":"49342770835127231"}],[{"__kind":"Short"},{"n":"185644649971847417027078541729883763845","d":"111664147389217578486305266190497405641"}],[{"__kind":"TenMinutes"},{"n":"185644649971847417007243500984272962256","d":"111664147389217578486305266190497405641"}],[{"__kind":"Day"},{"n":"243672483790155150980275367257619047429","d":"146571958346016116905825019814923101766"}]]}')!
    expect(u.source).toBe('bifrosto')
    expect([u.assetA, u.assetB]).toEqual([5, 15])
    expect(Object.keys(u.prices)).toEqual(['LastBlock', 'Short', 'TenMinutes', 'Day'])
    // 1 vDOT (B, 10 dec) = n/d DOT (A, 10 dec): the 0xaafd MMOracle answers 1.66252691.
    expect(emaPriceDecimal(u.prices.LastBlock!, 10, 10, 8)).toBe('1.66252691')
  })
  it('applies the decimals difference: n/d is raw A per raw B', () => {
    // Omnipool [1 H2O (12 dec), 222 HOLLAR (18 dec)]: 1 HOLLAR ≈ 0.1666 H2O.
    const r = { n: 386859209637670944n, d: 2321410787222649602935359n }
    expect(emaPriceDecimal(r, 12, 18, 6)).toBe('0.166648')
    // and the other way round a negative shift divides.
    expect(emaPriceDecimal({ n: 3n, d: 1n }, 12, 10, 4)).toBe('0.03')
  })
  it('skips a period it does not know or a ratio with a zero denominator', () => {
    const u = decodeEmaOracleUpdated({ source: '0x6f6d6e69706f6f6c', assets: [0, 1], updates: [[{ __kind: 'Fortnight' }, { n: '1', d: '1' }], [{ __kind: 'Short' }, { n: '1', d: '0' }]] })!
    expect(u.source).toBe('omnipool')
    expect(u.prices).toEqual({})
  })
  it('reads the table’s stored updates JSON alone, the Feb-2026 three-period form included', () => {
    const p = decodeEmaPeriods('[[{"__kind":"LastBlock"},{"n":"3","d":"2"}],[{"__kind":"Short"},{"n":"5","d":"4"}],[{"__kind":"TenMinutes"},{"n":"7","d":"8"}]]')
    expect(Object.keys(p)).toEqual(['LastBlock', 'Short', 'TenMinutes'])
    expect(p.Short).toEqual({ n: 5n, d: 4n })
    expect(decodeEmaPeriods('')).toEqual({})
    expect(decodeEmaPeriods('not json')).toEqual({})
  })
  it('names a source id', () => {
    expect(sourceAscii('0x756e697377707633')).toBe('uniswpv3')
  })
})

describe('runtime oracle adapter addresses', () => {
  it('decodes period, source and pair', () => {
    expect(decodeOracleAdapterAddress('0x00000102737461626c657377000000de0000006e')).toEqual({ period: 'TenMinutes', source: 'stablesw', assetA: 222, assetB: 110 })
    expect(decodeOracleAdapterAddress('0x00000100626966726f73746f000000050000000f')).toEqual({ period: 'LastBlock', source: 'bifrosto', assetA: 5, assetB: 15 })
    expect(decodeOracleAdapterAddress('0x2ffa376e0a84606e4ccb3738071312a34cebad6c')).toBeNull()
  })
})

describe('bytecodeIsConstant', () => {
  it('accepts code that only returns a pushed value, even with 0x54 inside push data', () => {
    // PUSH4 0x54545454 POP PUSH1 0x01 PUSH1 0x00 MSTORE PUSH1 0x20 PUSH1 0x00 RETURN
    expect(bytecodeIsConstant('0x6354545454506001600052602060' + '00f3')).toBe(true)
  })
  it('reads past Solidity metadata: the HOLLAR $1 adapter is a constant', () => {
    // The live 0x6096…34f8 runtime code: decimals() 8, latestAnswer() 1e8, and CBOR metadata whose bytes are not opcodes.
    const hollar = '0x6080604052348015600f57600080fd5b5060043610603c5760003560e01c8063313ce56714604157806350d25bcd146055578063abe30b30146068575b600080fd5b604051600881526020015b60405180910390f35b6305f5e1005b604051908152602001604c565b605b6305f5e1008156fea26469706673582212204533d05e4ca7ecd8bbe7b301679b70f04ff3508237c5efaf6c374a067c799cfc64736f6c634300080a0033'
    expect(bytecodeIsConstant(hollar)).toBe(true)
  })
  it('refuses code that reads storage or calls out', () => {
    expect(bytecodeIsConstant('0x60005460005260206000f3')).toBe(false) // SLOAD
    expect(bytecodeIsConstant('0x6000600060006000600073000000000000000000000000000000000000000161fffffa')).toBe(false) // STATICCALL
    expect(bytecodeIsConstant('0x')).toBe(false)
  })
})

describe('exact decimals', () => {
  it('renders ratios without a float', () => {
    expect(ratioDecimal(1n, 3n, 6)).toBe('0.333333')
    expect(ratioDecimal(-5n, 2n, 2)).toBe('-2.5')
    expect(unitsDecimal(100000000n, 8)).toBe('1')
    expect(unitsDecimal(8458567231797n, 8)).toBe('84585.67231797')
  })
})

describe('cadence and the stale rule', () => {
  const series = (stepSec: number, n: number, end = 1_800_000_000) => Array.from({ length: n }, (_, i) => end - (n - 1 - i) * stepSec)

  it('judges a heartbeat-only feed at its heartbeat + grace, not at twice it', () => {
    const daily = series(DAY_SEC, 31)
    const stats = cadenceStats(daily)
    expect(stats).toEqual({ updates: 31, medianIntervalSec: DAY_SEC, longestGapSec: DAY_SEC })
    // USDC/USDT: stale 26.4H after the last update, not 48H.
    expect(staleAfterSec(stats)).toBe(DAY_SEC + Math.round(DAY_SEC * 0.1))
  })

  it('never lets two median intervals stretch the bound past heartbeat + grace', () => {
    // A 4H median under a 5H longest gap would read 8H by 2 × median; the bound is 5H + 30m.
    expect(staleAfterSec({ updates: 100, medianIntervalSec: 4 * 3600, longestGapSec: 5 * 3600 })).toBe(5 * 3600 + 1800)
    expect(staleAfterSec({ updates: 100, medianIntervalSec: 1000, longestGapSec: 2100 })).toBe(3000)
  })

  it('only counts the 30 days ending at the newest update', () => {
    const old = series(3600, 10, 1_800_000_000 - CADENCE_SPAN_SEC - 10 * 3600)
    const recent = series(600, 50)
    expect(cadenceStats([...old, ...recent]).updates).toBe(50)
    expect(cadenceStats([...old, ...recent]).longestGapSec).toBe(600)
  })

  it('falls back to a 24H heartbeat below three updates', () => {
    expect(staleAfterSec(cadenceStats([1, 2]))).toBe(FALLBACK_HEARTBEAT_SEC + Math.round(FALLBACK_HEARTBEAT_SEC * 0.1))
    expect(staleAfterSec(cadenceStats([]))).toBe(FALLBACK_HEARTBEAT_SEC + Math.round(FALLBACK_HEARTBEAT_SEC * 0.1))
  })

  it('never lets the grace fall under 15 minutes', () => {
    const fast = series(12, 100) // every 12 s
    expect(staleAfterSec(cadenceStats(fast))).toBe(12 + 900)
  })

  it('names static, retired, stale and live feeds', () => {
    const now = 1_800_000_000
    expect(feedStatus({ lastUpdateSec: now - 10, nowSec: now, allTimeUpdates: 1, staleAfter: 100 })).toBe('static')
    // Set twice by hand (the vDOT discount, the first apyUSD/USD) is still a value, not a stream.
    expect(feedStatus({ lastUpdateSec: now - 60 * DAY_SEC, nowSec: now, allTimeUpdates: 2, staleAfter: 100 })).toBe('static')
    expect(feedStatus({ lastUpdateSec: now - 31 * DAY_SEC, nowSec: now, allTimeUpdates: 500, staleAfter: 100 })).toBe('retired')
    expect(feedStatus({ lastUpdateSec: now - 101, nowSec: now, allTimeUpdates: 500, staleAfter: 100 })).toBe('stale')
    expect(feedStatus({ lastUpdateSec: now - 100, nowSec: now, allTimeUpdates: 500, staleAfter: 100 })).toBe('live')
  })

  it('counts updates since an instant by binary search', () => {
    expect(countSince([1, 2, 3, 4, 5], 3)).toBe(3)
    expect(countSince([1, 2, 3], 10)).toBe(0)
    expect(countSince([], 0)).toBe(0)
  })
})
