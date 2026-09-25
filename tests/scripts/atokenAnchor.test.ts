import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  MM_LOGS_FROM, SEL, anchorForContract, blockTag, makeEthCallBatch, parseUint, scaledCall, unionCandidates, verificationSample, verifyAnchors,
  type AnchorRow, type EthCall, type EthCallRequest,
} from '../../src/scripts/atokenAnchor.ts'

// The aToken / variable-debt anchor must be the chain's own scaled balance at B0,
// read with scaledBalanceOf / scaledTotalSupply — never balanceOf · RAY / index,
// which is not an inverse of balanceOf's half-up rayMul.

const B0 = 8_200_000
const ADOT = '0x02639ec01313c8775fae74f2dad1118c8a8a86da'
const VDEBT = '0x02759d14d0d4f452b9c76f5a230750e8857d36f2'
const HOLDER = '0xba189d4f166ad6e387dd42c40f60fdd49ed7bec1'
const OTHER = '0x1111111111111111111111111111111111111111'

const word = (v: bigint) => '0x' + v.toString(16).padStart(64, '0')

/** A fake archive node: scaled balances per (contract, holder|'') per block; '0x' for no code. */
function fakeChain(state: Record<number, Record<string, Record<string, bigint>>>) {
  const seen: { calls: EthCallRequest[]; block: string }[] = []
  const ethCall: EthCall = async (calls, block) => {
    seen.push({ calls, block })
    const height = parseInt(block, 16)
    return calls.map(c => {
      const contract = state[height]?.[c.to]
      if (!contract) return '0x'
      if (c.data === `0x${SEL.scaledTotalSupply}`) return word(contract[''] ?? 0n)
      expect(c.data.startsWith(`0x${SEL.scaledBalanceOf}`)).toBe(true)
      const holder = '0x' + c.data.slice(10 + 24)
      return word(contract[holder] ?? 0n)
    })
  }
  return { ethCall, seen }
}

describe('scaled reads', () => {
  it('uses scaledTotalSupply for the total row and scaledBalanceOf for a holder', () => {
    expect(SEL.scaledBalanceOf).toBe('1da24f3e')
    expect(SEL.scaledTotalSupply).toBe('b1bf962d')
    expect(scaledCall(ADOT, '')).toEqual({ to: ADOT, data: '0xb1bf962d' })
    expect(scaledCall(ADOT, HOLDER.toUpperCase().replace('0X', '0x'))).toEqual({ to: ADOT, data: `0x1da24f3e000000000000000000000000${HOLDER.slice(2)}` })
  })

  it('treats an empty return as no answer, not zero', () => {
    expect(parseUint('0x')).toBeNull()
    expect(parseUint(word(0n))).toBe(0n)
    expect(parseUint('0x63a12edc1759')).toBe(109543927060313n)
  })

  it('never reads balanceOf or divides by an index', () => {
    const source = readFileSync(new URL('../../src/scripts/snapshot-atoken-anchors.ts', import.meta.url), 'utf8')
      + readFileSync(new URL('../../src/scripts/atokenAnchor.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('70a08231')   // balanceOf
    expect(source).not.toContain('18160ddd')   // totalSupply
    expect(source).not.toMatch(/\*\s*RAY\)\s*\/\s*index/)
  })
})

describe('anchorForContract', () => {
  it('stores the chain scaled values at B0 verbatim and skips zero/empty', async () => {
    const { ethCall, seen } = fakeChain({ [B0]: { [ADOT]: { '': 147187126603907355n, [HOLDER]: 109543927060313n, [OTHER]: 0n } } })
    const rows = await anchorForContract(ADOT, [HOLDER, OTHER], B0, ethCall)
    expect(rows).toEqual([
      { contract_address: ADOT, holder: '', scaled_balance: '147187126603907355', anchor_block: B0 },
      { contract_address: ADOT, holder: HOLDER, scaled_balance: '109543927060313', anchor_block: B0 },
    ])
    expect(seen.map(s => s.block)).toEqual([blockTag(B0)])
  })

  it('yields nothing for a contract with no code at B0', async () => {
    const { ethCall } = fakeChain({ [B0]: {} })
    expect(await anchorForContract(VDEBT, [HOLDER], B0, ethCall)).toEqual([])
  })
})

describe('verification', () => {
  const rows: AnchorRow[] = [
    { contract_address: VDEBT, holder: '', scaled_balance: '5', anchor_block: B0 },
    ...Array.from({ length: 10 }, (_, i) => ({ contract_address: ADOT, holder: '0x' + String(i).repeat(40), scaled_balance: String(i + 1), anchor_block: B0 })),
    { contract_address: ADOT, holder: '', scaled_balance: '55', anchor_block: B0 },
  ]

  it('samples every total row plus an even spread of holder rows', () => {
    const s = verificationSample(rows, 3)
    expect(s.filter(r => r.holder === '')).toHaveLength(2)
    expect(s.filter(r => r.holder !== '').map(r => r.scaled_balance)).toEqual(['1', '4', '7'])
    expect(verificationSample(rows, 100)).toHaveLength(12)
    expect(verificationSample(rows, 0)).toHaveLength(2)
  })

  it('flags anchors that differ from the chain and passes equal ones', async () => {
    const state: Record<string, bigint> = { '': 55n }
    rows.filter(r => r.contract_address === ADOT && r.holder).forEach(r => { state[r.holder] = BigInt(r.scaled_balance) })
    state['0x' + '3'.repeat(40)] = 999n
    const { ethCall } = fakeChain({ [B0]: { [ADOT]: state, [VDEBT]: { '': 5n } } })
    const v = await verifyAnchors(rows, ethCall)
    expect(v.checked).toBe(12)
    expect(v.matched).toBe(11)
    expect(v.mismatches).toEqual([{ contract_address: ADOT, holder: '0x' + '3'.repeat(40), anchor: '4', chain: '999', anchor_block: B0 }])
  })
})

// A missing balance is indistinguishable from a zero one. A reader that returned
// null for a dropped chunk or a per-item JSON-RPC error would skip a holder and
// publish a short anchor — after which the table is non-empty, so no later cycle
// recomputes it. It has to be all or nothing.
describe('makeEthCallBatch', () => {
  const noSleep = async () => {}
  function rpc(handler: (body: { id: number; params: [EthCallRequest, string] }[]) => unknown) {
    return vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const out = handler(body)
      return { ok: true, status: 200, json: async () => out } as Response
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>
  }

  it('chunks, maps results back by id and passes the block through', async () => {
    const f = rpc(body => body.map(b => ({ id: b.id, result: word(BigInt(parseInt(b.params[0].data.slice(2), 16))) })).reverse())
    const call = makeEthCallBatch('http://node', f, { chunk: 2, sleep: noSleep })
    const calls = [1, 2, 3, 4, 5].map(i => ({ to: ADOT, data: '0x' + i.toString(16) }))
    const out = await call(calls, blockTag(B0))
    expect(out.map(h => BigInt(h))).toEqual([1n, 2n, 3n, 4n, 5n])
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3)
    const firstBody = JSON.parse(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body))
    expect(firstBody[0].params[1]).toBe('0x7d1f40')
  })

  it('keeps an empty return as a result', async () => {
    const call = makeEthCallBatch('http://node', rpc(body => body.map(b => ({ id: b.id, result: '0x' }))), { sleep: noSleep })
    expect(await call([{ to: ADOT, data: '0x' }], 'latest')).toEqual(['0x'])
  })

  it('throws on a per-item JSON-RPC error after retrying', async () => {
    const f = rpc(body => body.map(b => (b.id === 0 ? { id: 0, error: { message: 'boom' } } : { id: b.id, result: '0x1' })))
    const call = makeEthCallBatch('http://node', f, { attempts: 3, sleep: noSleep })
    await expect(call([{ to: ADOT, data: '0x' }, { to: ADOT, data: '0x' }], 'latest')).rejects.toThrow(/failed after retries: 1\/2 calls errored, first: boom/)
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3)
  })

  it('throws instead of leaving a slot unfilled', async () => {
    const call = makeEthCallBatch('http://node', rpc(() => [{ id: 0, result: '0x1' }]), { sleep: noSleep })
    await expect(call([{ to: ADOT, data: '0x' }, { to: ADOT, data: '0x' }], 'latest')).rejects.toThrow(/returned no result for request 1/)
  })

  it('throws on HTTP failure', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 502, json: async () => [] }) as unknown as Response) as unknown as typeof fetch
    const call = makeEthCallBatch('http://node', f, { attempts: 2, sleep: noSleep })
    await expect(call([{ to: ADOT, data: '0x' }], 'latest')).rejects.toThrow(/HTTP 502/)
  })
})

describe('candidate holders', () => {
  it('unions every source, normalised, without the zero address, counting each', () => {
    const u = unionCandidates({
      logs: [HOLDER.toUpperCase().replace('0X', '0x'), '0x0000000000000000000000000000000000000000', 'bogus'],
      accruals: [OTHER, HOLDER],
      incentive: [],
    })
    expect(u.holders).toEqual([OTHER, HOLDER].sort())
    expect(u.counts).toEqual({ logs: 1, accruals: 2, incentive: 0 })
  })
})

describe('the capture gate', () => {
  it('waits for raw coverage from just below the first money-market log', () => {
    // The aToken implementation's Initialized is the first money-market log (6,382,885);
    // the RewardsController's logs (from 7,346,897) fall inside the same window.
    expect(MM_LOGS_FROM).toBeLessThan(6_382_885)
    expect(MM_LOGS_FROM).toBeGreaterThan(6_300_000)
    const script = readFileSync(new URL('../../src/scripts/snapshot-atoken-anchors.ts', import.meta.url), 'utf8')
    expect(script).toContain('missingRawCoverage(MM_LOGS_FROM, B0')
    // The one-shot mode goes through the same decision as the loop.
    expect(script).toMatch(/atokenAnchorDecision\(\{ anchorRowCount, logGaps \}/)
  })

  it('offers no in-place patch modes: an anchor is only ever captured whole', () => {
    const script = readFileSync(new URL('../../src/scripts/snapshot-atoken-anchors.ts', import.meta.url), 'utf8')
    expect(script).not.toMatch(/hasFlag\('(recapture|add-missing)'\)/)
  })
})
