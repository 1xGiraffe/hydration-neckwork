import { describe, expect, it, vi } from 'vitest'
import {
  buildMmIncentiveRows, decodeAllUserRewards, getAllUserRewardsCall, makeEthCall, mmIncentiveChecksumFields, spanningRewards,
  type MmIncentiveInputs,
} from '../src/services/mmIncentiveService.ts'

// The mm-incentives refresher publishes the chain's getAllUserRewards and reconciles
// the log arithmetic beside it. These pin the ABI handling, the reconciliation and the
// sub-ED flag; the live numbers (7,500 of 7,528 pairs reconciled at block 15,003,410)
// were measured against the archive node.

const W = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0')
const addr = (a: string) => a.slice(2).padStart(64, '0')
const GDOT = '0x0000000000000000000000000000000100000045'
const PRIME = '0x000000000000000000000000000000010000002b'
const A690 = '0x34d5ffb83d14d82f87aaf2f13be895a3c814c2ad'
const A110 = '0x35774c305aaf441a102d47988d35f0f5428471b3'
const USER = '0x4a9ab52a6f688ede97c23d946f7e8ef4f1e47a47'

describe('getAllUserRewards ABI', () => {
  it('encodes (address[] assets, address user) with the dynamic array after the head', () => {
    const call = getAllUserRewardsCall([A690, A110], USER)
    expect(call.to).toBe('0x7472a3d0891df2401d981a5954d07e364f05060f')
    expect(call.data).toBe(`0x4c0369c3${W(64)}${addr(USER)}${W(2)}${addr(A690)}${addr(A110)}`)
  })

  // A real return (block 14,980,000, holder 0x4a9ab52a…): PRIME 20114210 and GDOT
  // 21010653307925270, HDX/BNC zero.
  it('decodes (address[] rewardsList, uint256[] amounts) by reward address', () => {
    const hex = '0x' + W(64) + W(224) + W(4)
      + addr(GDOT) + addr('0x000000000000000000000000000000010000000e') + addr('0x0000000000000000000000000000000100000000') + addr(PRIME)
      + W(4) + W(21010653307925270n) + W(0) + W(0) + W(20114210)
    const out = decodeAllUserRewards(hex)
    expect(out.get(GDOT)).toBe(21010653307925270n)
    expect(out.get(PRIME)).toBe(20114210n)
    expect(out.size).toBe(4)
  })
})

describe('buildMmIncentiveRows', () => {
  const base = (over: Partial<MmIncentiveInputs> = {}): MmIncentiveInputs => ({
    block: 14_980_000,
    candidates: [USER],
    programmes: [{ asset: A690, reward: GDOT }, { asset: A110, reward: PRIME }],
    chain: new Map([[USER, new Map([[GDOT, 21010653307925270n], [PRIME, 20114210n]])]]),
    // The verified A110 case: index 14216, user 14208, scaled such that pending = 8782.
    assetIndex: new Map([[`${A690}|${GDOT}`, 30952175087072233n + 1000n], [`${A110}|${PRIME}`, 14216n]]),
    decimals: new Map([[A690, 18], [A110, 18]]),
    scaled: new Map([[`${USER}|${A690}`, 21010653307925270n * 10n ** 18n / 1000n], [`${USER}|${A110}`, 8782n * 10n ** 18n / 8n]]),
    accrued: new Map([[`${USER}|${PRIME}`, 19067104n + 1038324n]]),
    userIndex: new Map([[`${USER}|${A690}|${GDOT}`, 30952175087072233n], [`${USER}|${A110}|${PRIME}`, 14208n]]),
    eds: new Map([[69, 10n ** 16n], [43, 10n ** 6n]]),
    marketOf: () => 'core',
    ...over,
  })

  it('publishes the chain\'s claimable and marks the pair reconciled when the arithmetic agrees to the unit', () => {
    const { rows, reconciledPairs, unreconciled } = buildMmIncentiveRows(base())
    const totals = rows.filter(r => r.assetAddress === '')
    expect(totals.map(r => [r.rewardAssetId, r.claimableRaw, r.modelRaw, r.reconciled])).toEqual([
      [43, 20114210n, 20114210n, true],
      [69, 21010653307925270n, 21010653307925270n, true],
    ])
    expect(reconciledPairs).toBe(2)
    expect(unreconciled).toEqual([])
    // One leg per incentivized aToken the holder has a balance on, keyed by the ETH form.
    const legs = rows.filter(r => r.assetAddress !== '')
    expect(legs.map(l => [l.assetAddress, l.pendingRaw])).toEqual([[A110, 8782n], [A690, 21010653307925270n]])
    expect(rows.every(r => r.accountId === `0x45544800${USER.slice(2)}0000000000000000`)).toBe(true)
  })

  it('still publishes the chain\'s number when the arithmetic disagrees, flagged unreconciled', () => {
    const { rows, unreconciled } = buildMmIncentiveRows(base({ accrued: new Map() }))
    const prime = rows.find(r => r.assetAddress === '' && r.rewardAssetId === 43)!
    expect(prime.claimableRaw).toBe(20114210n)
    expect(prime.modelRaw).toBe(8782n)
    expect(prime.reconciled).toBe(false)
    expect(unreconciled).toEqual([{ holder: USER, reward: PRIME, chain: '20114210', model: '8782' }])
  })

  it('states no model for a negative accrual or an index that went backwards', () => {
    const neg = buildMmIncentiveRows(base({ accrued: new Map([[`${USER}|${PRIME}`, -5n]]) }))
    expect(neg.unreconciled.find(u => u.reward === PRIME)?.model).toBeNull()
    const back = buildMmIncentiveRows(base({ assetIndex: new Map([[`${A690}|${GDOT}`, 1n], [`${A110}|${PRIME}`, 14216n]]) }))
    expect(back.unreconciled.find(u => u.reward === GDOT)?.model).toBeNull()
    expect(back.rows.find(r => r.assetAddress === '' && r.rewardAssetId === 69)!.modelRaw).toBe(0n)
  })

  // A claimAllRewards including an amount below the reward asset's ED reverts until the
  // account holds it; the reward is owed and counted, and flagged.
  it('flags 0 < claimable < ED and keeps the amount', () => {
    const { rows } = buildMmIncentiveRows(base({ eds: new Map([[69, 10n ** 17n], [43, 10n ** 6n]]) }))
    const gdot = rows.find(r => r.assetAddress === '' && r.rewardAssetId === 69)!
    expect(gdot.belowEd).toBe(true)
    expect(gdot.claimableRaw).toBe(21010653307925270n)
    expect(rows.find(r => r.assetAddress === '' && r.rewardAssetId === 43)!.belowEd).toBe(false)
  })

  // A reward incentivizing aTokens of two isolated markets is owed per market:
  // beside the pair total, one row per market with the chain's claimable over that
  // market's aTokens alone and that market's pending legs.
  it('files a reward spanning markets under each market from the per-market chain figures', () => {
    const A_BIL = '0x52e1311e26610e6662a1e5b5bd113130b6815213'
    const marketOf = (a: string) => (a === A_BIL ? 'bil' : 'core')
    const programmes = [{ asset: A690, reward: GDOT }, { asset: A_BIL, reward: GDOT }, { asset: A110, reward: PRIME }]
    expect(spanningRewards(programmes, marketOf)).toEqual(new Map([[GDOT, ['bil', 'core']]]))
    const inp = base({
      programmes,
      marketOf,
      assetIndex: new Map([...base().assetIndex, [`${A_BIL}|${GDOT}`, 10n]]),
      chainByMarket: new Map([[USER, new Map([
        ['bil', new Map([[GDOT, 0n], [PRIME, 0n]])],
        ['core', new Map([[GDOT, 21010653307925270n], [PRIME, 20114210n]])],
      ])]]),
    })
    const { rows } = buildMmIncentiveRows(inp)
    const gdot = rows.filter(r => r.rewardAssetId === 69 && !/^0x/.test(r.assetAddress))
    // The '' total, then core only: nothing is owed or pending on the BIL market.
    expect(gdot.map(r => [r.assetAddress, r.marketKey, r.claimableRaw, r.pendingRaw])).toEqual([
      ['', 'core', 21010653307925270n, 21010653307925270n],
      ['market:core', 'core', 21010653307925270n, 21010653307925270n],
    ])
    // A pair within one market has no per-market rows.
    expect(rows.some(r => r.rewardAssetId === 43 && r.assetAddress.startsWith('market:'))).toBe(false)
    // Without the per-market figures the cycle refuses rather than guessing a split.
    expect(() => buildMmIncentiveRows({ ...inp, chainByMarket: undefined })).toThrow(/per-market/)
  })

  it('writes no row for a holder owed nothing', () => {
    const { rows } = buildMmIncentiveRows(base({ chain: new Map(), scaled: new Map(), accrued: new Map() }))
    expect(rows).toEqual([])
  })

  it('checksums every published column', () => {
    const [row] = buildMmIncentiveRows(base()).rows
    const fields = mmIncentiveChecksumFields(row).trim().split('|')
    expect(fields).toHaveLength(16)
    expect(mmIncentiveChecksumFields({ ...row, belowEd: !row.belowEd })).not.toBe(mmIncentiveChecksumFields(row))
  })
})

describe('makeEthCall', () => {
  const ok = (results: string[]) => new Response(JSON.stringify(results.map((result, id) => ({ jsonrpc: '2.0', id, result }))))
  it('returns one result per call, in order, across batches of 50', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Array<{ id: number; params: [{ data: string }] }>
      return ok(body.map(b => b.params[0].data))
    })
    const call = makeEthCall('http://node', fetchImpl as never)
    const calls = Array.from({ length: 120 }, (_, i) => ({ to: '0x1', data: `0x${i}` }))
    expect(await call(calls, '0x10')).toEqual(calls.map(c => c.data))
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  // An unread balance is not a zero one: a per-item error aborts the cycle.
  it('throws when any call in a batch has no result', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ jsonrpc: '2.0', id: 0, error: { message: 'reverted' } }])))
    await expect(makeEthCall('http://node', fetchImpl as never)([{ to: '0x1', data: '0x' }], 'latest')).rejects.toThrow('reverted')
  })
})
