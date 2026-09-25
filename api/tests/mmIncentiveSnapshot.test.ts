import { describe, expect, it, vi } from 'vitest'
import {
  MM_INCENTIVE_MAX_AGE_SECONDS, MM_MARKET_ROW_PREFIX, currentMmIncentiveGenerationSql, loadMmIncentives, mmIncentiveAccountForm, mmIncentiveRewardsFromStored,
  withPostSnapshotClaims,
} from '../src/services/mmIncentiveSnapshot.ts'

// The one read of the claimable-incentive snapshot every current surface shares: the
// staleness gate, the self-pinned generation and the stored-row shape.

const H160 = `0x${'4a'.repeat(20)}`
const FORM = mmIncentiveAccountForm(H160)
const GDOT = '0x0000000000000000000000000000000100000045'
const A690 = '0x34d5ffb83d14d82f87aaf2f13be895a3c814c2ad'
const stored = (over: Record<string, unknown>) => ({
  account_id: FORM, holder: H160, reward_asset_id: 69, reward_address: GDOT, asset_address: '', market_key: 'core',
  claimable_s: '100', model_s: '100', accrued_s: '60', pending_s: '40', scaled_s: '0', user_index_s: '0', asset_index_s: '0',
  reconciled: 1, below_ed: 0, snapshot_block: 15_000_000, ...over,
})

function client(pointer: unknown[], rows: unknown[], claims: unknown[] = []) {
  const seen: Array<{ query: string; params?: Record<string, unknown> }> = []
  return {
    seen,
    query: vi.fn(async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      seen.push({ query, params: query_params })
      return { json: async () => (query.includes('-- mm:incentive-snapshot-state') ? pointer : query.includes('-- mm:incentive-post-snapshot-claims') ? claims : rows) }
    }),
  }
}

describe('loadMmIncentives', () => {
  it('reads the holders by their ETH form from the generation the rows statement pins itself', async () => {
    const c = client([{ snapshot_id: 's1', block_height: 15_000_001, age_seconds: 30 }], [
      stored({}),
      stored({ asset_address: A690, scaled_s: '5', user_index_s: '1', asset_index_s: '9', pending_s: '40', claimable_s: '0' }),
    ])
    const snap = await loadMmIncentives(c as never, [H160.toUpperCase().replace('0X', '0x'), H160])
    expect(snap.asOfBlock).toBe(15_000_000)
    expect(snap.rewards).toEqual([{
      accountId: FORM, holder: H160, marketKey: 'core', rewardAssetId: 69, rewardAddress: GDOT,
      claimable: 100n, model: 100n, accrued: 60n, reconciled: true, belowExistentialDeposit: false,
      legs: [{ assetAddress: A690, scaledBalance: 5n, userIndex: 1n, assetIndex: 9n, pending: 40n }],
    }])
    const rowsRead = c.seen.find(s => s.query.includes('-- mm:incentive-snapshot-rows'))!
    expect(rowsRead.params?.accs).toEqual([FORM])
    expect(rowsRead.query).toContain("WHERE snapshot_id = (\n          SELECT argMax(snapshot_id, computed_at) FROM price_data.mm_incentive_snapshot_state WHERE snapshot_key = 'current'")
  })

  it('publishes nothing from a pointer older than the gate, or from none', async () => {
    for (const pointer of [[{ snapshot_id: 's1', block_height: 1, age_seconds: MM_INCENTIVE_MAX_AGE_SECONDS + 1 }], []]) {
      const c = client(pointer, [stored({})])
      expect(await loadMmIncentives(c as never, [H160])).toEqual({ asOfBlock: null, rewards: [] })
      expect(c.seen.some(s => s.query.includes('-- mm:incentive-snapshot-rows'))).toBe(false)
    }
  })

  it('dates a holder with no rows by the pointer', async () => {
    const c = client([{ snapshot_id: 's1', block_height: 15_000_001, age_seconds: 30 }], [])
    expect(await loadMmIncentives(c as never, [H160])).toEqual({ asOfBlock: 15_000_001, rewards: [] })
  })
})

describe('the directory gate', () => {
  it('names no partition once the pointer is stale — the reader\'s own 15-minute gate', () => {
    const sql = currentMmIncentiveGenerationSql()
    expect(MM_INCENTIVE_MAX_AGE_SECONDS).toBe(900)
    expect(sql).toContain(`<= ${MM_INCENTIVE_MAX_AGE_SECONDS}`)
    expect(sql).toContain("argMax(snapshot_id, computed_at), '')")
    expect(sql).toContain("FROM price_data.mm_incentive_snapshot_state WHERE snapshot_key = 'current'")
  })

  it('attaches leg rows to their (holder, reward) total and drops orphans', () => {
    const rewards = mmIncentiveRewardsFromStored([stored({ asset_address: A690, reward_asset_id: 43 }) as never])
    expect(rewards).toEqual([])
  })
})

describe('claims after the snapshot', () => {
  // A claim pays at least what the snapshot showed; the snapshot's amount beside
  // the wallet it moved into would count the incentive twice.
  it('subtracts the RewardsClaimed indexed after the snapshot block, floored at zero', async () => {
    const PRIME = '0x000000000000000000000000000000010000002b'
    const c = client([{ snapshot_id: 's1', block_height: 15_000_001, age_seconds: 30 }], [
      stored({}),
      stored({ reward_asset_id: 43, reward_address: PRIME, claimable_s: '50' }),
    ], [{ u: H160, reward: GDOT, amount_s: '30' }, { u: H160, reward: PRIME, amount_s: '80' }])
    const snap = await loadMmIncentives(c as never, [H160])
    expect(snap.rewards.map(r => [r.rewardAssetId, r.claimable])).toEqual([[69, 70n], [43, 0n]])
    const read = c.seen.find(s => s.query.includes('-- mm:incentive-post-snapshot-claims'))!
    expect(read.params).toEqual({ holders: [H160], block: 15_000_000 })
    expect(read.query).toContain('GROUP BY u, reward, block_height, event_index')
  })

  it('takes a split pair\'s claim across its markets in order and clears the sub-ED flag at zero', () => {
    const base = { accountId: FORM, holder: H160, rewardAssetId: 69, rewardAddress: GDOT, model: 0n, accrued: 0n, reconciled: true, belowExistentialDeposit: true, legs: [] }
    const out = withPostSnapshotClaims([{ ...base, marketKey: 'core', claimable: 10n }, { ...base, marketKey: 'bil', claimable: 10n }], new Map([[`${H160}|${GDOT}`, 15n]]))
    expect(out.map(r => [r.marketKey, r.claimable, r.belowExistentialDeposit])).toEqual([['core', 0n, false], ['bil', 5n, true]])
  })
})

describe('a reward spanning markets', () => {
  // Beside the '' pair total, a pair whose programmes span markets carries one row
  // per market (the chain's claimable over that market's aTokens): it reads as one
  // reward per market, each with its own legs, summing to the pair.
  it('reads one reward per market from the per-market rows', () => {
    const A_BIL = '0x52e1311e26610e6662a1e5b5bd113130b6815213'
    const rewards = mmIncentiveRewardsFromStored([
      stored({ claimable_s: '100' }),
      stored({ asset_address: `${MM_MARKET_ROW_PREFIX}bil`, market_key: 'bil', claimable_s: '30', model_s: '0', accrued_s: '0' }),
      stored({ asset_address: `${MM_MARKET_ROW_PREFIX}core`, market_key: 'core', claimable_s: '70', model_s: '0', accrued_s: '0' }),
      stored({ asset_address: A690, market_key: 'core', pending_s: '7', claimable_s: '0' }),
      stored({ asset_address: A_BIL, market_key: 'bil', pending_s: '3', claimable_s: '0' }),
    ] as never)
    expect(rewards.map(r => [r.marketKey, r.claimable, r.legs.map(l => l.assetAddress), r.reconciled])).toEqual([
      ['bil', 30n, [A_BIL], true],
      ['core', 70n, [A690], true],
    ])
  })
})
