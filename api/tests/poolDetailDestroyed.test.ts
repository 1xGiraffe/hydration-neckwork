import { describe, it, expect, beforeEach } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'
import { getPoolDetail, initPoolService } from '../src/services/poolService.ts'
import { resetCacheForTests } from '../src/services/cache.ts'

// A DESTROYED stableswap pool whose sampled history is entirely outside the
// requested window.
//
// The null guard ahead of the history code passes as soon as the pool has ANY
// param event, and the params query carries no window bound while the history
// query does — so a pool that was created, sampled and destroyed years ago
// answers with params but zero history rows for `?fromTs=1&toTs=2`. The window
// schema accepts any 0…2^32-1 pair, so this is an UNAUTHENTICATED request, and
// reading the last history key unguarded turned it into a 500.
const POOL_ID = 102

function fakeClient(paramRows: Record<string, unknown>[], histRows: Record<string, unknown>[]): ClickHouseClient {
  return {
    query: async ({ query }: { query: string }) => ({
      json: async () => {
        if (query.includes('stableswap_pool_params')) return paramRows
        if (query.includes('stableswap_pool_state_history')) return histRows
        return []
      },
    }),
    insert: async () => {},
    close: async () => {},
  } as unknown as ClickHouseClient
}

const CREATED = {
  block_height: 1_000,
  block_timestamp: '2024-01-01 00:00:00',
  event_name: 'Stableswap.PoolCreated',
  args_json: JSON.stringify({ assets: [10, 11], amplification: 100, fee: 500 }),
}

describe('destroyed stableswap pool detail', () => {
  beforeEach(() => { resetCacheForTests() })

  it('answers rather than throwing when the window holds no sampled history', async () => {
    initPoolService(fakeClient([CREATED], []))
    const detail = await getPoolDetail(POOL_ID, undefined, { fromSec: 1, toSec: 2 })
    expect(detail).not.toBeNull()
    expect(detail?.kind).toBe('stableswap')
    expect(detail?.destroyed).toBe(true)
    // No sampled row in the window means no history to chart — an empty series,
    // never a fabricated one.
    expect(detail?.history.buckets).toEqual([])
  })

  it('still ends a destroyed pool at its LAST sampled key when it has one', async () => {
    initPoolService(fakeClient([CREATED], [{
      d: '2024-02-01', ids: [10, 11], rs: ['1000', '2000'],
      peg_num: [], peg_den: [], issuance: '3000',
    }]))
    const detail = await getPoolDetail(POOL_ID, undefined, { fromSec: 1_706_745_600, toSec: 1_800_000_000 })
    // The grid stops at the pool's own last sample, not at the window end: a
    // destroyed pool must not forward-fill to now.
    expect(detail?.history.buckets.at(-1)).toBe('2024-02-01')
  })
})
