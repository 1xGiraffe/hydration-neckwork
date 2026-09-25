import { describe, expect, it } from 'vitest'
import { LM_REWARD_MAX_AGE_SECONDS, lmCountedClaimable, loadLmRewards, withPostSnapshotEvents } from '../src/services/lmRewardSnapshot.ts'

const ACC = `0x${'61'.repeat(32)}`
const stored = (over: Record<string, unknown> = {}) => ({
  account_id: ACC, pallet: 'omnipool', deposit_id: '77', yield_farm_id: 139, global_farm_id: 133, pool_key: '5', position_id: '4712',
  lp_asset_id: null, reward_asset_id: 5, farm_state: 'active', settled_s: '1', projected_s: '2', max_reward_s: '3', forfeit_s: '1',
  loyalty_s: '1000000000000000000', farm_updated_at_period: 1, current_period: 2, below_ed: 0, snapshot_block: 9_100, ...over,
})

function client(pointer: Record<string, unknown> | null, rows: Record<string, unknown>[], events: Record<string, unknown>[] = []) {
  const seen: { query: string; params: Record<string, unknown> }[] = []
  return {
    seen,
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      seen.push({ query, params: query_params ?? {} })
      return { json: async () => (query.includes('-- lm:reward-snapshot-state') ? (pointer ? [pointer] : []) : query.includes('-- lm:reward-post-snapshot-events') ? events : rows) }
    },
  }
}

describe('loadLmRewards', () => {
  // The rows statement pins the generation itself, so it can never name one the
  // refresher dropped between two reads (which served 0 rows as "no rewards").
  it('pins the generation inside the rows statement and dates rows by their own block', async () => {
    const c = client({ snapshot_id: 'old', block_height: 9_000, age_seconds: 30 }, [stored()])
    const out = await loadLmRewards(c as never, [ACC.toUpperCase().replace('0X', '0x')])
    const rowsQuery = c.seen.find(q => q.query.includes('-- lm:reward-snapshot-rows'))!
    expect(rowsQuery.query).toMatch(/snapshot_id = \(\s*SELECT argMax\(snapshot_id, computed_at\) FROM price_data\.lm_reward_snapshot_state WHERE snapshot_key = 'current'\s*\)/)
    expect(rowsQuery.params).toEqual({ accs: [ACC] })
    // The pointer read said 9_000, but the rows are the newer generation's.
    expect(out.asOfBlock).toBe(9_100)
    expect(out.rows[0]).toMatchObject({ claimable: 2n, projected: true, belowExistentialDeposit: false })
  })

  it('dates an account without rows by the pointer, and serves nothing without one', async () => {
    expect(await loadLmRewards(client({ snapshot_id: 's', block_height: 9_000, age_seconds: 30 }, []) as never, [ACC])).toEqual({ asOfBlock: 9_000, rows: [] })
    expect(await loadLmRewards(client(null, [stored()]) as never, [ACC])).toEqual({ asOfBlock: null, rows: [] })
  })

  it('does not serve a stale snapshot', async () => {
    const c = client({ snapshot_id: 's', block_height: 9_000, age_seconds: LM_REWARD_MAX_AGE_SECONDS + 1 }, [stored()])
    expect(await loadLmRewards(c as never, [ACC])).toEqual({ asOfBlock: null, rows: [] })
    expect(c.seen.some(q => q.query.includes('-- lm:reward-snapshot-rows'))).toBe(false)
    const fresh = client({ snapshot_id: 's', block_height: 9_000, age_seconds: LM_REWARD_MAX_AGE_SECONDS }, [stored({ below_ed: 1 })])
    expect((await loadLmRewards(fresh as never, [ACC])).rows[0].belowExistentialDeposit).toBe(true)
  })
})

describe('rewards claimed or withdrawn after the snapshot', () => {
  const POINTER = { snapshot_id: 's', block_height: 9_100, age_seconds: 30 }

  // A claim pays everything claimable at its block, never less than the snapshot
  // showed: counting the snapshot's amount beside the wallet it moved into would
  // count it twice.
  it('subtracts later claims per entry, floors at zero, and zeroes withdrawn entries and destroyed deposits', async () => {
    const c = client(POINTER, [
      stored({ projected_s: '1000' }),
      stored({ yield_farm_id: 140, projected_s: '500' }),
      stored({ deposit_id: '78', projected_s: '300' }),
      stored({ deposit_id: '79', projected_s: '200' }),
      stored({ pallet: 'xyk', deposit_id: '77', yield_farm_id: 139, projected_s: '50' }),
    ], [
      { pallet: 'omnipool', deposit_id: '77', yield_farm_id: 139, kind: 'claimed', amount_s: '400' },
      { pallet: 'omnipool', deposit_id: '77', yield_farm_id: 140, kind: 'claimed', amount_s: '900' },
      { pallet: 'omnipool', deposit_id: '78', yield_farm_id: 139, kind: 'withdrawn', amount_s: '1' },
      { pallet: 'omnipool', deposit_id: '79', yield_farm_id: 0, kind: 'destroyed', amount_s: '0' },
    ])
    const out = await loadLmRewards(c as never, [ACC])
    expect(out.rows.map(r => r.claimable)).toEqual([600n, 0n, 0n, 0n, 50n])
    // Bounded by the generation's deposits and its block.
    const ev = c.seen.find(q => q.query.includes('-- lm:reward-post-snapshot-events'))!
    expect(ev.params).toEqual({ deposits: ['77', '78', '79'], block: 9_100 })
    expect(ev.query).toContain('GROUP BY pallet, deposit_id, block_height, event_index')
  })

  it('leaves rows alone without events and clears the sub-ED flag once nothing is left', () => {
    const base = { accountId: ACC, pallet: 'omnipool', depositId: '77', yieldFarmId: 139, claimable: 10n, belowExistentialDeposit: true, payable: true } as never
    expect(withPostSnapshotEvents([base], [])[0]).toBe(base)
    expect(withPostSnapshotEvents([base], [{ pallet: 'omnipool', depositId: '77', yieldFarmId: 139, kind: 'claimed', amount: 10n }])[0])
      .toMatchObject({ claimable: 0n, belowExistentialDeposit: false })
  })

  // below_ed 2: below the existential deposit and the owner holds less — the claim
  // pays the owner nothing, so the amount stays visible and counts 0.
  it('reads the unpayable code and counts such an entry 0', async () => {
    const out = await loadLmRewards(client(POINTER, [stored({ below_ed: 2 }), stored({ yield_farm_id: 140, below_ed: 1 })]) as never, [ACC])
    expect(out.rows.map(r => [r.claimable, r.belowExistentialDeposit, r.payable, lmCountedClaimable(r)])).toEqual([[2n, true, false, 0n], [2n, true, true, 2n]])
  })
})
