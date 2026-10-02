import { describe, expect, it } from 'vitest'
import { readOracleState, type RpcCall } from '../src/services/oracleService.ts'
import { CORE_MM_MARKET } from '../src/services/explorerAssets.ts'

// The live read classifies each source by what the chain answers, never by a
// list: a DIA adapter names its oracle and key, a composite names two inputs and
// must answer their product at the same block, a constant's code can only return
// a constant, and an EMA adapter is decoded from its address.

const w = (v: bigint | number) => '0x' + BigInt(v).toString(16).padStart(64, '0')
const addrWord = (a: string) => '0x' + a.slice(2).padStart(64, '0')
const strRet = (s: string) => {
  const hex = Buffer.from(s).toString('hex')
  return '0x' + (32n).toString(16).padStart(64, '0') + BigInt(s.length).toString(16).padStart(64, '0') + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')
}
const lrd = (round: bigint, answer: bigint, updated: number) => '0x' + [round, answer, BigInt(updated), BigInt(updated), round].map(x => x.toString(16).padStart(64, '0')).join('')
const list = (as: string[]) => '0x' + (32n).toString(16).padStart(64, '0') + BigInt(as.length).toString(16).padStart(64, '0') + as.map(a => a.slice(2).padStart(64, '0')).join('')

const PROVIDER = '0x' + '11'.repeat(20)
const ORACLE = '0xad33c0f0c42c5a0eaa65b5895d2bdb20cb6e8760'
const DOT = '0x0000000000000000000000000000000100000005'
const VDOT = '0x000000000000000000000000000000010000000f'
const HOLLAR = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const DOT_ADAPTER = '0xfbca0a6dc5b74c042df23025d99ef0f1fcac6702'
const DIA = '0xdee629af973ebf5bf261ace12ffd1900ac715f5e'
const VDOT_COMPOSITE = '0x2ffa376e0a84606e4ccb3738071312a34cebad6c'
const EMA = '0x00000102626966726f73746f000000050000000f'
const CONST = '0x6096c9d71f7c06024578a62f4b608a1bb06834f8'
const BLOCK = 15_311_627

function fakeRpc(compositeAnswer: bigint) {
  const answers: Record<string, Record<string, string>> = {
    [CORE_MM_MARKET.poolProxy]: { '0x0542975c': addrWord(PROVIDER), '0xd1946dbc': list([DOT, VDOT, HOLLAR]) },
    [PROVIDER]: { '0xfca513a8': addrWord(ORACLE) },
    [ORACLE]: {
      '0x8c89b64f': w(100_000_000), '0x6210308c': w(0),
      ['0xb3596f07' + DOT.slice(2).padStart(64, '0')]: w(118_446_611), ['0x92bf2be0' + DOT.slice(2).padStart(64, '0')]: addrWord(DOT_ADAPTER),
      ['0xb3596f07' + VDOT.slice(2).padStart(64, '0')]: w(compositeAnswer), ['0x92bf2be0' + VDOT.slice(2).padStart(64, '0')]: addrWord(VDOT_COMPOSITE),
      ['0xb3596f07' + HOLLAR.slice(2).padStart(64, '0')]: w(100_000_000), ['0x92bf2be0' + HOLLAR.slice(2).padStart(64, '0')]: addrWord(CONST),
    },
    [DOT_ADAPTER]: { '0xfeaf968c': lrd(BigInt(BLOCK), 118_446_611n, 1_790_965_338), '0x50d25bcd': w(118_446_611), '0x313ce567': w(8), '0x7284e416': strRet('DOT/USD Oracle'), '0x7d07db3c': addrWord(DIA), '0x06f94331': strRet('DOT/USD') },
    [VDOT_COMPOSITE]: { '0x50d25bcd': w(compositeAnswer), '0x313ce567': w(8), '0xe94cb14e': addrWord(EMA), '0x4bec3090': addrWord(DOT_ADAPTER) },
    [EMA]: { '0x50d25bcd': w(166_252_691), '0x313ce567': w(8) },
    [CONST]: { '0x50d25bcd': w(100_000_000), '0x313ce567': w(8) },
  }
  return async (calls: RpcCall[]) => calls.map(c => {
    if (c.method === 'eth_blockNumber') return '0x' + BLOCK.toString(16)
    if (c.method === 'eth_getCode') return c.params[0] === CONST ? '0x6305f5e10060005260206000f3' : '0x60005460005260206000f3'
    const { to, data } = c.params[0] as { to: string; data: string }
    return answers[to]?.[data] ?? null
  })
}

describe('readOracleState', () => {
  it('reads each reserve’s price and source, and classifies every source by what it answers', async () => {
    // 1.66252691 × 1.18446611 = 1.96920678 (truncated to 1e8)
    const snap = (await readOracleState([], fakeRpc(196_920_678n), 1_790_965_900_000))!
    expect(snap.block).toBe(BLOCK)
    const core = snap.markets.find(m => m.key === 'core')!
    expect(core.oracle).toBe(ORACLE)
    expect(core.baseUnit).toBe('100000000')
    expect(core.fallbackOracle).toBeNull()
    expect(core.reserves.map(r => [r.assetId, r.price, r.source])).toEqual([[5, '118446611', DOT_ADAPTER], [15, '196920678', VDOT_COMPOSITE], [222, '100000000', CONST]])

    const dia = snap.sources.get(DOT_ADAPTER)!
    expect(dia.dia).toEqual({ oracle: DIA, key: 'DOT/USD' })
    expect(dia.round).toEqual({ roundId: String(BLOCK), answer: '118446611', updatedAt: 1_790_965_338 })

    const comp = snap.sources.get(VDOT_COMPOSITE)!
    expect(comp.composite).toEqual({ ratio: EMA, usd: DOT_ADAPTER, verified: true })
    // The composite's inputs were probed too, though no market names them directly.
    expect(snap.sources.get(EMA)!.ema).toEqual({ period: 'TenMinutes', source: 'bifrosto', assetA: 5, assetB: 15 })
    expect(snap.sources.get(CONST)!.constant).toBe(true)
  })

  it('does not vouch for a composite whose answer is not the product of its inputs', async () => {
    const snap = (await readOracleState([], fakeRpc(200_000_000n), 1_790_965_900_000))!
    expect(snap.sources.get(VDOT_COMPOSITE)!.composite?.verified).toBe(false)
  })

  it('reads nothing without a block to pin to', async () => {
    expect(await readOracleState([], async calls => calls.map(() => null))).toBeNull()
  })
})
