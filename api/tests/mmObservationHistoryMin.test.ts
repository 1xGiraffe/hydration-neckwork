import { describe, expect, it } from 'vitest'
import type { ClickHouseClient } from '@clickhouse/client'
import { makeBucketing } from '../src/services/bucketLadder.ts'
import type { BlockClock } from '../src/services/blockClock.ts'
import { loadObservationHistory } from '../src/services/moneyMarketHistory.ts'

// The in-bucket lowest health factor is a NUMERIC minimum. `health_factor` is a
// String column, and a string min is lexicographic — an 18-digit liquidatable
// value ("996…") sorts above a 19-digit healthy one ("1038…"), and the 78-digit
// uint256 max of a debt-free observation sorts below a "22…" — so the dip below 1
// that a LiquidationCall observed never won its bucket, and a debt-free
// observation drew a bucket with debt at the cap. This pins the cast on both the
// minimum and the block that observed it.

const POOL = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const H160 = `0x${'ec'.repeat(20)}`
const STUB_CLOCK: BlockClock = { hours: [], heights: [], builtAt: 0 }

function bucketing() {
  // Three hourly buckets ending at heights 200, 300 and 400; bucket 0 opens at 100.
  return makeBucketing(STUB_CLOCK, 0, 3 * 3_600, 100, 180, undefined, { stepSec: 3_600, heightAt: sec => 100 + sec / 36 })
}

function fakeClient(rows: (query: string) => unknown[]) {
  const seen: { query: string; params: Record<string, unknown> }[] = []
  const client = {
    query: async (o: { query: string; query_params: Record<string, unknown> }) => {
      seen.push({ query: o.query, params: o.query_params })
      return { json: async () => rows(o.query) }
    },
  }
  return { client: client as unknown as ClickHouseClient, seen }
}

describe('loadObservationHistory', () => {
  it('takes the in-bucket minimum over the numeric health factor, never the string column', async () => {
    const { client, seen } = fakeClient(query => (query.includes('-- mm:observations\n')
      ? [
          // Bucket 1 closes healthy (1.04) but a liquidation inside it observed 0.996.
          { pool: POOL, b: 1, obs_block: 290, coll: '44836241956727', debt: '34117121188730', avail: '0', lt: '8000', max_ltv: '7000', hf: '1040828390681286450', hf_min: '996361001510207746', hf_min_block: 282 },
        ]
      : []))
    const out = await loadObservationHistory(client, [H160], [POOL], bucketing())
    const read = seen.find(s => s.query.includes('-- mm:observations\n'))!
    expect(read.query).toContain('toString(min(toUInt256OrNull(health_factor))) AS hf_min')
    expect(read.query).toContain('argMin(block_height, toUInt256OrNull(health_factor)) AS hf_min_block')
    expect(read.query).not.toMatch(/min\(health_factor\)/)
    expect(read.query).not.toMatch(/argMin\(block_height, health_factor\)/)
    const series = out.get(POOL)!
    expect(series[0]).toBeUndefined()
    expect(series[1]).toMatchObject({ block: 290, healthFactor: '1040828390681286450', lowestHealthFactor: '996361001510207746', lowestAtBlock: 282 })
    // The quiet bucket after it carries the close forward, and its lowest is that close.
    expect(series[2]).toMatchObject({ block: 290, lowestHealthFactor: '1040828390681286450', lowestAtBlock: 290 })
  })

  it('leaves a bucket with no numeric observation without an in-bucket minimum', async () => {
    const { client } = fakeClient(query => (query.includes('-- mm:observations\n')
      ? [{ pool: POOL, b: 0, obs_block: 150, coll: '1', debt: '0', avail: '0', lt: '8000', max_ltv: '7000', hf: 'inf', hf_min: null, hf_min_block: 0 }]
      : []))
    const out = await loadObservationHistory(client, [H160], [POOL], bucketing())
    expect(out.get(POOL)![0]).toMatchObject({ healthFactor: 'inf', lowestHealthFactor: 'inf', lowestAtBlock: 150 })
  })
})
