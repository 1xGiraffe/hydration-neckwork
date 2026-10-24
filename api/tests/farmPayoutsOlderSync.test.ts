import { describe, it, expect } from 'vitest'
import { readFarmPayouts } from '../src/services/farmApr.ts'
import type { ClickHouseClient } from '../src/db/client.ts'

// A drained pot stops syncing, so its AllRewardsDistributed marker leaves the 30-day
// window a month after it ran dry. XYK DOT/MYTH (pool 1000227) then fell back to the
// scheduled 63.8 % from farms 1 and 3, both empty since 2026-09-15. The reader steps
// back for a live farm's newest sync — cheaply, and only for farms silent in the window.
describe('readFarmPayouts: a live farm silent through the window', () => {
  const ONE = 10n ** 18n
  function fakeClient() {
    const queries: string[] = []
    const client = {
      queries,
      query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => ({
        json: async () => {
          queries.push(query)
          // The window holds only farm 5's syncs.
          if (query.includes('INTERVAL {windowDays:UInt32} DAY')) {
            return [{ global_farm_id: 5, block_height: 900, event_index: 1, t: 2_000_000, drained: 0, acc: String(ONE), z: '1' }]
          }
          // One step back finds farm 1's newest sync; farm 9 never synced.
          if (query.includes('max(block_height)')) {
            return (query_params?.ids as number[]).includes(1) && query_params?.hi === 3_000_000 - 30 * 86_400 ? [{ g: 1, b: 700 }] : []
          }
          // The newest sync's block: its update and the drained marker beside it.
          if (query.includes('block_height IN {blocks:Array(UInt32)}')) {
            return [
              { global_farm_id: 1, block_height: 700, event_index: 3, t: 1_000_000, drained: 1, acc: '', z: '' },
              { global_farm_id: 1, block_height: 700, event_index: 4, t: 1_000_000, drained: 0, acc: String(5n * ONE), z: '100' },
            ]
          }
          throw new Error(`unexpected query: ${query}`)
        },
      }),
    }
    return client as unknown as ClickHouseClient & { queries: string[] }
  }

  it('reads the drained marker of the newest sync from before the window', async () => {
    const client = fakeClient()
    const p = await readFarmPayouts(client, 'XYKWarehouseLM', 3_000_000, [1, 5])
    expect(p.get(1)?.state).toBe('drained')
    expect(p.get(5)?.state).toBe('quiet')
  })

  it('walks back only for farms the window did not see, and remembers what it found', async () => {
    const client = fakeClient()
    await readFarmPayouts(client, 'XYKWarehouseLM', 3_000_000, [1, 5])
    // Farm 1 is remembered from the test above; farm 5 synced in the window.
    expect(client.queries.filter(q => q.includes('max(block_height)'))).toHaveLength(0)
  })

  it('gives up on a farm with no sync within reach, once', async () => {
    const client = fakeClient()
    const p = await readFarmPayouts(client, 'XYKWarehouseLM', 3_000_000, [9])
    expect(p.has(9)).toBe(false)
    const steps = client.queries.filter(q => q.includes('max(block_height)')).length
    await readFarmPayouts(client, 'XYKWarehouseLM', 3_000_000, [9])
    expect(client.queries.filter(q => q.includes('max(block_height)')).length).toBe(steps)
  })
})
