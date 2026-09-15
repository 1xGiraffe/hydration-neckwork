import { describe, expect, it } from 'vitest'
import { decodeAggregate3, encodeAggregate3, MULTICALL3_ADDRESS } from '../src/services/wormholeNtt.ts'

// The origin-chain passes used to send one JSON-RPC eth_call per read, which the
// provider bills per method however well they are batched into one HTTP request.
// Multicall3 folds a whole pass into ONE eth_call, so these two functions carry
// the entire saving — and a layout slip here silently reads the wrong contract,
// which the backing monitor would publish as a deficit. The vectors below are
// written from the ABI spec by hand, not from the implementation.

const AAAA = '0x' + 'aa'.repeat(20)
const BBBB = '0x' + 'bb'.repeat(20)
const word = (hex: string) => hex.padStart(64, '0')

describe('encodeAggregate3', () => {
  it('lays out a two-call batch exactly as the ABI specifies', () => {
    // balanceOf(0xcc…cc): a 4-byte selector plus one word = 36 bytes of calldata.
    const balanceOf = '0x70a08231' + word('cc'.repeat(20))
    // isPaused(): the bare selector, 4 bytes.
    const isPaused = '0xb187bd26'

    const expected = '0x82ad56cb'
      + word('20')              // offset to the array
      + word('2')               // array length
      + word('40')              // offset of element 0, from the end of the length word
      + word('100')             // offset of element 1 (0x40 + 0xc0)
      // element 0: (address, bool, bytes)
      + word('aa'.repeat(20))   // target
      + word('1')               // allowFailure
      + word('60')              // offset to the bytes member, within the struct
      + word('24')              // 36 bytes of calldata
      + '70a08231' + word('cc'.repeat(20)) + '00'.repeat(28)
      // element 1
      + word('bb'.repeat(20))
      + word('1')
      + word('60')
      + word('4')
      + 'b187bd26' + '00'.repeat(28)

    expect(encodeAggregate3([{ to: AAAA, data: balanceOf }, { to: BBBB, data: isPaused }])).toBe(expected)
  })

  it('addresses the canonical Multicall3 deployment', () => {
    // Same address on every chain it is deployed to; verified live on Ethereum
    // and Base (identical 3,808-byte code) before this was written.
    expect(MULTICALL3_ADDRESS.toLowerCase()).toBe('0xca11bde05977b3631167028862be2a173976ca11')
  })
})

describe('decodeAggregate3', () => {
  // (bool success, bytes returnData)[] — two results, the second reverted.
  const twoResults = '0x'
    + word('20')      // offset to the array
    + word('2')       // length
    + word('40')      // offset of result 0
    + word('c0')      // offset of result 1
    + word('1')       // success
    + word('40')      // offset to returnData within the struct
    + word('20')      // 32 bytes
    + word('7b')      // the value: 123
    + word('0')       // success = false
    + word('40')
    + word('0')       // empty returnData

  it('returns each call’s return data in order', () => {
    expect(decodeAggregate3(twoResults, 2)).toEqual(['0x' + word('7b'), null])
  })

  it('reads a reverted call as unread rather than as zero', () => {
    // The whole point: a failed leg must not decode to 0, which the custody
    // reader would treat as an emptied vault.
    expect(decodeAggregate3(twoResults, 2)?.[1]).toBeNull()
  })

  it('rejects an answer that does not hold the expected number of results', () => {
    expect(decodeAggregate3(twoResults, 3)).toBeNull()
  })

  it('is null for a missing, empty or truncated answer', () => {
    expect(decodeAggregate3(null, 1)).toBeNull()
    expect(decodeAggregate3('0x', 1)).toBeNull()
    expect(decodeAggregate3(twoResults.slice(0, 200), 2)).toBeNull()
  })
})
