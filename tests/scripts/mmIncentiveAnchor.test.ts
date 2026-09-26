import { describe, expect, it } from 'vitest'
import { CONTROLLER_LOGS_FROM, NOTHING_ANCHORED, anchorCall, anchorKeys, anchorValue, incentiveKeysToRead, readIncentiveAnchor, readIncentiveAnchorKeys, verifyIncentiveAnchor, INCENTIVE_SEL } from '../../src/scripts/mmIncentiveAnchor.ts'
import type { EthCall, EthCallRequest } from '../../src/scripts/atokenAnchor.ts'

// The incentive anchor is the RewardsController's own state at B0, read — never
// derived. Measured on 2026-09-25: 7,122 rows at 8,200,000, every one equal to the
// chain on re-read, including 0x28251ad7…'s 20399441641438 GDOT accrual that no
// indexed log carries.

const B0 = 8_200_000
const C = '0x7472a3d0891df2401d981a5954d07e364f05060f'
const A690 = '0x34d5ffb83d14d82f87aaf2f13be895a3c814c2ad'
const GDOT = '0x0000000000000000000000000000000100000045'
const HDX = '0x0000000000000000000000000000000100000000'
const USER = '0x28251ad7c5d44ddff6a6426f51b047edf0b94b9c'
const word = (v: bigint) => v.toString(16).padStart(64, '0')
const pad = (a: string) => a.slice(2).padStart(64, '0')

function fakeChain(values: Record<string, bigint>) {
  const seen: { calls: EthCallRequest[]; block: string }[] = []
  const ethCall: EthCall = async (calls, block) => {
    seen.push({ calls, block })
    return calls.map(c => `0x${word(values[c.data] ?? 0n)}${c.data.startsWith(`0x${INCENTIVE_SEL.getRewardsData}`) ? word(5n).repeat(3) : ''}`)
  }
  return { ethCall, seen }
}

describe('anchor reads', () => {
  it('reads each row kind with its own view', () => {
    expect(anchorCall({ user_address: USER, asset_address: '', reward_address: GDOT })).toEqual({ to: C, data: `0xb022418c${pad(USER)}${pad(GDOT)}` })
    expect(anchorCall({ user_address: USER, asset_address: A690, reward_address: GDOT })).toEqual({ to: C, data: `0x533f542a${pad(USER)}${pad(A690)}${pad(GDOT)}` })
    expect(anchorCall({ user_address: '', asset_address: A690, reward_address: GDOT })).toEqual({ to: C, data: `0x7eff4ba8${pad(A690)}${pad(GDOT)}` })
    expect(() => anchorCall({ user_address: '', asset_address: '', reward_address: GDOT })).toThrow()
  })

  it('takes the first word of a return (getRewardsData leads with the index); an empty return is no value', () => {
    expect(anchorValue(`0x${word(7n)}${word(9n)}`)).toBe(7n)
    expect(anchorValue('0x')).toBeNull()
  })

  it('asks per user one accrual per reward and one index per programme, after the programme rows', () => {
    const keys = anchorKeys([USER], [{ asset: A690, reward: GDOT }, { asset: A690, reward: HDX }])
    expect(keys).toEqual([
      { user_address: '', asset_address: A690, reward_address: GDOT },
      { user_address: '', asset_address: A690, reward_address: HDX },
      { user_address: USER, asset_address: '', reward_address: HDX },
      { user_address: USER, asset_address: '', reward_address: GDOT },
      { user_address: USER, asset_address: A690, reward_address: GDOT },
      { user_address: USER, asset_address: A690, reward_address: HDX },
    ])
  })
})

describe('readIncentiveAnchor', () => {
  it('stores what the chain returned at B0, skipping zeros', async () => {
    const chain = fakeChain({
      [`0xb022418c${pad(USER)}${pad(GDOT)}`]: 20_399_441_641_438n,
      [`0x533f542a${pad(USER)}${pad(A690)}${pad(GDOT)}`]: 83_166_183_608_968n,
      [`0x7eff4ba8${pad(A690)}${pad(GDOT)}`]: 5_930_700_500_023_340n,
    })
    const rows = await readIncentiveAnchor([USER.toUpperCase().replace('0X', '0x'), USER, 'bogus'], [{ asset: A690, reward: GDOT }], B0, chain.ethCall)
    expect(chain.seen[0].block).toBe('0x7d1f40')
    expect(rows).toEqual([
      { user_address: '', asset_address: A690, reward_address: GDOT, value: '5930700500023340', anchor_block: B0 },
      { user_address: USER, asset_address: '', reward_address: GDOT, value: '20399441641438', anchor_block: B0 },
      { user_address: USER, asset_address: A690, reward_address: GDOT, value: '83166183608968', anchor_block: B0 },
    ])
  })

  // A programme passed in existed at B0, so an empty answer is a failed read.
  it('refuses an empty return rather than storing a zero', async () => {
    const ethCall: EthCall = async calls => calls.map(() => '0x')
    await expect(readIncentiveAnchor([USER], [{ asset: A690, reward: GDOT }], B0, ethCall)).rejects.toThrow('empty return')
  })

  it('verifies every stored row against the chain at its block', async () => {
    const chain = fakeChain({ [`0xb022418c${pad(USER)}${pad(GDOT)}`]: 20_399_441_641_438n })
    const ok = await verifyIncentiveAnchor([{ user_address: USER, asset_address: '', reward_address: GDOT, value: '20399441641438', anchor_block: B0 }], chain.ethCall)
    expect(ok).toMatchObject({ checked: 1, matched: 1, mismatches: [] })
    const bad = await verifyIncentiveAnchor([{ user_address: USER, asset_address: '', reward_address: GDOT, value: '1', anchor_block: B0 }], chain.ethCall)
    expect(bad.mismatches).toEqual([{ user_address: USER, asset_address: '', reward_address: GDOT, anchor: '1', chain: '20399441641438', anchor_block: B0 }])
  })
})

// Captured whole once, then topped up every cycle: the sources are log-fed and the
// logs before B0 are partial, so a user whose every pre-B0 log fell in a gap is
// named later or by a source outside the logs — measured at B0: 18 such users,
// named by the Substrate legs of GDOT alone, several with an unclaimed accrual.
describe('the top-up', () => {
  const OTHER = '0x86b31a41eedadd04aa2a347ac7609b01e3ecad46'
  const programmes = [{ asset: A690, reward: GDOT }, { asset: A690, reward: HDX }]

  it('reads every key of every candidate in a full capture, whatever the table holds', () => {
    const anchored = { users: new Set([USER]), programmes: new Set([`${A690}|${GDOT}`, `${A690}|${HDX}`]) }
    expect(incentiveKeysToRead([USER, OTHER], programmes, anchored, 'full')).toEqual(anchorKeys([USER, OTHER], programmes))
    expect(incentiveKeysToRead([USER], programmes, NOTHING_ANCHORED, 'full')).toEqual(anchorKeys([USER], programmes))
  })

  it('reads, in a top-up, every key of each user the table holds no row for, and a programme row it lacks', () => {
    // USER has a row (an accrual, say): read whole at its capture, so none of its
    // keys is read again; OTHER has none: every one of its keys is read.
    const anchored = { users: new Set([USER]), programmes: new Set([`${A690}|${GDOT}`]) }
    expect(incentiveKeysToRead([USER, OTHER], programmes, anchored, 'top-up')).toEqual([
      { user_address: '', asset_address: A690, reward_address: HDX },
      { user_address: OTHER, asset_address: '', reward_address: HDX },
      { user_address: OTHER, asset_address: '', reward_address: GDOT },
      { user_address: OTHER, asset_address: A690, reward_address: GDOT },
      { user_address: OTHER, asset_address: A690, reward_address: HDX },
    ])
    // Nothing new: nothing to read.
    expect(incentiveKeysToRead([USER], programmes, { users: new Set([USER]), programmes: new Set([`${A690}|${GDOT}`, `${A690}|${HDX}`]) }, 'top-up')).toEqual([])
  })

  it('normalises the candidates the way the full capture does', () => {
    const upper = `0x${OTHER.slice(2).toUpperCase()}`
    const keys = incentiveKeysToRead([upper, OTHER, 'bogus', USER], programmes, { users: new Set([USER]), programmes: new Set() }, 'top-up')
    expect(new Set(keys.map(k => k.user_address))).toEqual(new Set(['', OTHER]))
  })

  it('reads only the given keys, and asks the chain nothing for none', async () => {
    const chain = fakeChain({ [`0x533f542a${pad(OTHER)}${pad(A690)}${pad(GDOT)}`]: 2_352_845_126_453_640n })
    const keys = [{ user_address: OTHER, asset_address: '', reward_address: GDOT }, { user_address: OTHER, asset_address: A690, reward_address: GDOT }]
    expect(await readIncentiveAnchorKeys(keys, B0, chain.ethCall)).toEqual([{ user_address: OTHER, asset_address: A690, reward_address: GDOT, value: '2352845126453640', anchor_block: B0 }])
    expect(chain.seen).toHaveLength(1)
    expect(chain.seen[0].calls).toHaveLength(2)
    expect(await readIncentiveAnchorKeys([], B0, chain.ethCall)).toEqual([])
    expect(chain.seen).toHaveLength(1)
  })
})

describe('the capture gate', () => {
  it('gates the first capture on raw coverage from the backfill low-water', async () => {
    expect(CONTROLLER_LOGS_FROM).toBe(7_346_900)
    const { readFileSync } = await import('node:fs')
    const job = readFileSync(new URL('../../src/scripts/mmIncentiveAnchorJob.ts', import.meta.url), 'utf8')
    expect(job).toContain('missingRawCoverage(CONTROLLER_LOGS_FROM, B0')
  })

  it('names the candidates from the Substrate legs of the registry assets over the programme aTokens too, and tops up by user', async () => {
    const { readFileSync } = await import('node:fs')
    const job = readFileSync(new URL('../../src/scripts/mmIncentiveAnchorJob.ts', import.meta.url), 'utf8')
    expect(job).toMatch(/FROM price_data\.transfer_activity WHERE asset_id IN \(\$\{registryAsset\}\) AND block_height <= \{b0:UInt32\}/)
    expect(job).toMatch(/FROM price_data\.asset_swap_activity WHERE asset_id IN \(\$\{registryAsset\}\) AND block_height <= \{b0:UInt32\}/)
    expect(job).toContain("mode === 'top-up' ? await anchoredKeys() : NOTHING_ANCHORED")
    expect(job).toContain('incentiveKeysToRead(candidates.users, programmes, anchored, mode)')
  })
})
