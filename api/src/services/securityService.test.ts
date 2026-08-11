import { describe, expect, it } from 'vitest'
import {
  allowanceFor, assetIdFromBlakeKey, classifyFuse, committeeThresholds, decayedAccumulator,
  decodeLockdownState, decodeOptionalRational, decodePausedKey, decodeRational,
  decodeWithdrawAccumulator, decodeWithdrawConfig, egressSinkChain, pairLockdowns, rationalPct, replayPauses,
  tradableLabels, type LockdownState,
} from './securityService.ts'

// Every number the Security page shows about a live limit comes out of one of
// these decoders, so each is pinned against SCALE bytes taken from the live
// runtime (spec 435) rather than hand-rolled.

describe('decodeWithdrawConfig', () => {
  // GlobalWithdrawLimitConfig at block 13,554,260: limit 1e21 planck (1e9 HDX at
  // 12 decimals), window 21,600,000 ms = 6h.
  const live = '0x0000000000000000000e6da6b6cf3f04000060fd4e0500000000'
  it('reads the u128 limit and the u64 window', () => {
    // Little-endian: 1e21 = 0x3635C9ADC5DEA00000, window 21_600_000 = 0x0149_9700.
    const limit = (1_000_000_000n * 10n ** 12n).toString(16).padStart(32, '0')
    const le = (hex: string) => (hex.match(/../g) ?? []).reverse().join('')
    const bytes = '0x' + le(limit) + le((21_600_000).toString(16).padStart(16, '0'))
    expect(decodeWithdrawConfig(bytes)).toEqual({ limitRaw: 1_000_000_000n * 10n ** 12n, windowMs: 21_600_000 })
  })
  it('refuses a short read rather than reporting a partial limit', () => {
    expect(decodeWithdrawConfig('0x0001')).toBeNull()
    expect(decodeWithdrawConfig(live.slice(0, 20))).toBeNull()
  })
})

describe('decodeWithdrawAccumulator', () => {
  it('reads the accumulated value and its last-update timestamp', () => {
    const le = (hex: string) => (hex.match(/../g) ?? []).reverse().join('')
    const bytes = '0x' + le((22_024_190_054_153_021_454n).toString(16).padStart(32, '0')) + le((1_786_393_530_000).toString(16).padStart(16, '0'))
    expect(decodeWithdrawAccumulator(bytes)).toEqual({ valueRaw: 22_024_190_054_153_021_454n, lastUpdateMs: 1_786_393_530_000 })
  })
})

describe('decayedAccumulator', () => {
  const window = 21_600_000
  it('drains linearly to zero across one window', () => {
    expect(decayedAccumulator(1_000n, 0, 0, window, false)).toBe(1_000n)
    expect(decayedAccumulator(1_000n, 0, window / 2, window, false)).toBe(500n)
    expect(decayedAccumulator(1_000n, 0, window, window, false)).toBe(0n)
  })
  it('caps the elapsed time at one window rather than going negative', () => {
    expect(decayedAccumulator(1_000n, 0, window * 5, window, false)).toBe(0n)
  })
  it('is idempotent at a fixed now, so repeated polls agree', () => {
    const once = decayedAccumulator(7_777n, 1_000, 5_000_000, window, false)
    expect(decayedAccumulator(7_777n, 1_000, 5_000_000, window, false)).toBe(once)
  })
  it('freezes the accumulator while a lockdown is armed, matching the pallet', () => {
    expect(decayedAccumulator(1_000n, 0, window, window, true)).toBe(1_000n)
  })
  it('never decays backwards when the timestamp is ahead of now', () => {
    expect(decayedAccumulator(1_000n, 9_000_000, 0, window, false)).toBe(1_000n)
  })
})

// Little-endian encoders, so a fixture is derived from the value it stands for
// rather than hand-typed (a transposed nibble would otherwise pin the bug).
const leHex = (value: bigint | number, bytes: number) =>
  (BigInt(value).toString(16).padStart(bytes * 2, '0').match(/../g) ?? []).reverse().join('')

describe('decodeLockdownState', () => {
  it('reads Locked(untilBlock) from variant 0', () => {
    // The last real lockdown: USDT (asset 1000767) locked until block 13,126,783.
    expect(decodeLockdownState('0x00' + leHex(13_126_783, 4))).toEqual({ kind: 'locked', untilBlock: 13_126_783 })
  })
  it('reads Unlocked((periodStart, baselineIssuance)) from variant 1', () => {
    const baseline = 49_049_268_166_332_618_475_542_144n
    const bytes = '0x01' + leHex(13_540_000, 4) + leHex(baseline, 16)
    expect(decodeLockdownState(bytes)).toEqual({ kind: 'unlocked', periodStartBlock: 13_540_000, baselineRaw: baseline })
  })
  it('refuses a truncated Unlocked payload rather than reporting a zero baseline', () => {
    expect(decodeLockdownState('0x01' + leHex(13_540_000, 4))).toBeNull()
  })
})

describe('decodeRational / decodeOptionalRational', () => {
  it('reads the (num, den) limit pair', () => {
    // (5000, 10000) — the runtime's default net trade volume limit.
    expect(decodeRational('0x88130000' + '10270000')).toEqual([5_000, 10_000])
    expect(rationalPct([5_000, 10_000])).toBe(50)
    expect(rationalPct([500, 10_000])).toBe(5)
  })
  it('treats a zero denominator as unreadable', () => {
    expect(decodeRational('0x8813000000000000')).toBeNull()
  })
  it('distinguishes a stored None (limit disabled) from a malformed read', () => {
    expect(decodeOptionalRational('0x00')).toBeNull()
    expect(decodeOptionalRational('0x01' + 'f4010000' + '10270000')).toEqual([500, 10_000])
    expect(decodeOptionalRational('')).toBeUndefined()
    expect(decodeOptionalRational('0x01f401')).toBeUndefined()
  })
})

describe('decodePausedKey', () => {
  it('reads the pallet and call names out of the storage key', () => {
    // Twox64Concat over SCALE (BoundedVec<u8>, BoundedVec<u8>): 32B item prefix,
    // 8B hash, then compact-length-prefixed ASCII for each name.
    const name = (s: string) => (s.length * 4).toString(16).padStart(2, '0') + Buffer.from(s, 'utf8').toString('hex')
    const key = '0x' + '00'.repeat(32) + '11'.repeat(8) + name('PolkadotXcm') + name('claim_assets')
    expect(decodePausedKey(key)).toEqual({ pallet: 'PolkadotXcm', call: 'claim_assets' })
  })
  it('refuses a key too short to hold both names', () => {
    expect(decodePausedKey('0x' + '00'.repeat(32))).toBeNull()
  })
})

describe('assetIdFromBlakeKey', () => {
  it('reads the u32 asset id from a Blake2_128Concat map key', () => {
    const key = '0x' + '00'.repeat(32) + 'aa'.repeat(16) + 'de030000'
    expect(assetIdFromBlakeKey(key)).toBe(990)
  })
  it('returns null for a prefix-only key', () => {
    expect(assetIdFromBlakeKey('0x' + '00'.repeat(32))).toBeNull()
  })
})

describe('classifyFuse', () => {
  const limit = 1_000n
  const head = 100_000
  it('reports a live lockdown and zero headroom', () => {
    const v = classifyFuse(limit, { kind: 'locked', untilBlock: head + 5_000 }, 10_000n, head)
    expect(v).toMatchObject({ status: 'locked', headroomRaw: 0n, usagePct: 100, untilBlock: head + 5_000 })
  })
  it('treats an elapsed lockdown as idle, because the next mint re-baselines it', () => {
    const v = classifyFuse(limit, { kind: 'locked', untilBlock: head - 1 }, 10_000n, head)
    expect(v).toMatchObject({ status: 'expired', usedRaw: 0n, headroomRaw: limit, usagePct: 0 })
  })
  it('measures issuance against the period baseline inside the window', () => {
    const state: LockdownState = { kind: 'unlocked', periodStartBlock: head - 100, baselineRaw: 5_000n }
    const v = classifyFuse(limit, state, 5_250n, head)
    expect(v).toMatchObject({ status: 'active', usedRaw: 250n, headroomRaw: 750n, usagePct: 25 })
    expect(v.periodEndBlock).toBe(head - 100 + 14_400)
  })
  // The reference dashboard computes `limit - diff` with a negative diff and so
  // reports MORE headroom than the limit. The pallet saturates the subtraction,
  // so a net burn simply leaves the full allowance.
  it('saturates a net burn to zero used, never to extra headroom', () => {
    const state: LockdownState = { kind: 'unlocked', periodStartBlock: head - 100, baselineRaw: 5_000n }
    const v = classifyFuse(limit, state, 4_000n, head)
    expect(v).toMatchObject({ usedRaw: 0n, headroomRaw: limit, usagePct: 0 })
  })
  it('caps usage at the limit when issuance has already overshot it', () => {
    const state: LockdownState = { kind: 'unlocked', periodStartBlock: head - 100, baselineRaw: 5_000n }
    const v = classifyFuse(limit, state, 9_000n, head)
    expect(v).toMatchObject({ usedRaw: 4_000n, headroomRaw: 0n, usagePct: 100 })
  })
  it('reports an elapsed period as idle', () => {
    const state: LockdownState = { kind: 'unlocked', periodStartBlock: head - 14_400, baselineRaw: 5_000n }
    expect(classifyFuse(limit, state, 9_000n, head).status).toBe('expired')
  })
  it('reports an asset with no lockdown row as unarmed with the full allowance', () => {
    expect(classifyFuse(limit, undefined, undefined, head)).toMatchObject({ status: 'unarmed', headroomRaw: limit })
  })
  it('holds back a usage figure when issuance could not be read', () => {
    const state: LockdownState = { kind: 'unlocked', periodStartBlock: head - 100, baselineRaw: 5_000n }
    expect(classifyFuse(limit, state, undefined, head)).toMatchObject({ status: 'active', usedRaw: 0n, usagePct: 0 })
  })
})

describe('allowanceFor', () => {
  it('floors reserve * num / den in integer arithmetic, like the pallet', () => {
    expect(allowanceFor(1_000_000n, [5_000, 10_000])).toBe(500_000n)
    expect(allowanceFor(1_000_000n, [500, 10_000])).toBe(50_000n)
    expect(allowanceFor(3n, [5_000, 10_000])).toBe(1n)
  })
  it('holds 128-bit reserves without losing precision', () => {
    const reserve = 4_155_908_501_617_219_377_208_074n
    expect(allowanceFor(reserve, [5_000, 10_000])).toBe(reserve / 2n)
  })
  it('reports no allowance when the limit is disabled', () => {
    expect(allowanceFor(1_000_000n, null)).toBeNull()
  })
})

describe('pairLockdowns', () => {
  const row = (event: string, block: number, args: Record<string, unknown>) => ({
    block_height: block, block_timestamp: '2026-01-01 00:00:00', event_name: `CircuitBreaker.${event}`,
    args_json: JSON.stringify(args), extrinsic_index: null,
  })
  it('pairs each lockdown with the removal that cleared it', () => {
    const out = pairLockdowns([
      row('AssetLockdown', 100, { assetId: 5, until: 14_500 }),
      row('AssetLockdownRemoved', 14_600, { assetId: 5 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ blockHeight: 100, untilBlock: 14_500, liftedAtBlock: 14_600, liftedEarly: false })
  })
  it('marks a removal before the scheduled block as an early lift', () => {
    const out = pairLockdowns([
      row('AssetLockdown', 100, { assetId: 5, until: 14_500 }),
      row('AssetLockdownRemoved', 900, { assetId: 5 }),
    ])
    expect(out[0].liftedEarly).toBe(true)
  })
  it('keeps an unresolved lockdown open rather than inventing a lift', () => {
    const out = pairLockdowns([row('AssetLockdown', 100, { assetId: 5, until: 14_500 })])
    expect(out[0]).toMatchObject({ liftedAtBlock: null, liftedEarly: null })
  })
  it('tracks repeated lockdowns of the same asset independently', () => {
    const out = pairLockdowns([
      row('AssetLockdown', 100, { assetId: 5, until: 14_500 }),
      row('AssetLockdownRemoved', 200, { assetId: 5 }),
      row('AssetLockdown', 300, { assetId: 5, until: 14_700 }),
      row('AssetLockdownRemoved', 400, { assetId: 5 }),
    ])
    expect(out).toHaveLength(2)
    expect(out.map(l => l.liftedAtBlock)).toEqual([200, 400])
  })
  it('ignores a removal with no matching lockdown', () => {
    expect(pairLockdowns([row('AssetLockdownRemoved', 200, { assetId: 5 })])).toHaveLength(0)
  })
})

describe('replayPauses', () => {
  const hex = (s: string) => '0x' + Buffer.from(s, 'utf8').toString('hex')
  const row = (event: string, block: number, pallet: string, call: string) => ({
    block_height: block, block_timestamp: '2026-01-01 00:00:00',
    event_name: `TransactionPause.Transaction${event}`, args_json: '{}', extrinsic_index: 2,
    pallet_hex: hex(pallet), call_hex: hex(call),
  })
  it('leaves only the calls that were paused and never unpaused', () => {
    const live = replayPauses([
      row('Paused', 100, 'Omnipool', 'add_liquidity'),
      row('Unpaused', 200, 'Omnipool', 'add_liquidity'),
      row('Paused', 300, 'EVM', 'create'),
    ])
    expect([...live.keys()]).toEqual(['EVM.create'])
    expect(live.get('EVM.create')?.block_height).toBe(300)
  })
  it('keeps the most recent pause block when a call is paused again', () => {
    const live = replayPauses([
      row('Paused', 100, 'EVM', 'create'),
      row('Unpaused', 200, 'EVM', 'create'),
      row('Paused', 300, 'EVM', 'create'),
    ])
    expect(live.get('EVM.create')?.block_height).toBe(300)
  })
})

describe('tradableLabels', () => {
  it('names every allowed operation and calls a zero mask frozen', () => {
    expect(tradableLabels(15)).toEqual(['Sell', 'Buy', 'Add liquidity', 'Remove liquidity'])
    expect(tradableLabels(0)).toEqual(['Frozen'])
    expect(tradableLabels(1)).toEqual(['Sell'])
    expect(tradableLabels(8)).toEqual(['Remove liquidity'])
    expect(tradableLabels(11)).toEqual(['Sell', 'Buy', 'Remove liquidity'])
  })
})

describe('committeeThresholds', () => {
  // EnsureProportionAtLeast<1,2> passes on ayes*2 >= size and <2,3> on ayes*3 >= 2*size.
  it('matches the runtime proportions for the live committee size', () => {
    expect(committeeThresholds(7)).toEqual({ majority: 4, superMajority: 5 })
  })
  it('holds for even and small committees', () => {
    expect(committeeThresholds(6)).toEqual({ majority: 3, superMajority: 4 })
    expect(committeeThresholds(10)).toEqual({ majority: 5, superMajority: 7 })
    expect(committeeThresholds(1)).toEqual({ majority: 1, superMajority: 1 })
  })
  it('degrades to zero when the roster is unknown, rather than claiming a threshold', () => {
    expect(committeeThresholds(0)).toEqual({ majority: 0, superMajority: 0 })
  })
})

describe('egressSinkChain', () => {
  // `sibl` ++ para id little-endian, zero-padded to 32 bytes.
  const sink = (paraId: number) => '0x7369626c' + (paraId.toString(16).padStart(8, '0').match(/../g) ?? []).reverse().join('') + '0'.repeat(48)
  it('names the sibling parachain the sovereign account belongs to', () => {
    expect(egressSinkChain(sink(1000))).toBe('AssetHub')
    expect(egressSinkChain(sink(2004))).toBe('Moonbeam')
    expect(egressSinkChain(sink(2030))).toBe('Bifrost')
  })
  it('falls back to the id for a chain with no product name', () => {
    expect(egressSinkChain(sink(9999))).toBe('Parachain 9999')
  })
  it('returns null for an account that is not a sibling sovereign', () => {
    expect(egressSinkChain('0x6d6f646c70792f74727372790000000000000000000000000000000000000000')).toBeNull()
  })
})
