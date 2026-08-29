import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'
import { attachExtrinsicHashes, extrinsicHashesFor } from '../../src/data/services/extrinsicHashes.ts'
import type { ClickHouseClient } from '../../src/db/client.ts'

// The page-scoped extrinsic-hash enrichment: every surface naming an
// extrinsicIndex also carries the extrinsicHash, resolved with ONE bounded
// primary-key IN read per page. The other suites run the default empty handler
// (hashes null); this file proves the join itself.

const HASH_A = `0x${'aa'.repeat(32)}`
const HASH_B = `0x${'bb'.repeat(32)}`

function hashClient() {
  return fakeDataClient(
    (query, params) => {
      if (!query.includes('-- data:enrich:extrinsic-hashes')) return undefined
      const bs = params.bs as number[]
      const es = params.es as number[]
      const known: Record<string, string> = { '100:2': HASH_A, '101:0': HASH_B }
      return bs.flatMap((b, i) => {
        const hash = known[`${b}:${es[i]}`]
        return hash ? [{ block_height: b, extrinsic_index: es[i], hash }] : []
      })
    },
    query => (query.includes('-- data:events:feed')
      ? [
          { block_height: 101, event_index: 5, extrinsic_index: 0, event_name: 'Balances.Transfer', ts: '2026-08-20 10:00:06', args_json: '{}', ingested_at: '2026-08-20 10:00:07' },
          { block_height: 100, event_index: 7, extrinsic_index: 2, event_name: 'Omnipool.SellExecuted', ts: '2026-08-20 10:00:00', args_json: '{}', ingested_at: '2026-08-20 10:00:05' },
          { block_height: 99, event_index: 1, extrinsic_index: null, event_name: 'Balances.Deposit', ts: '2026-08-20 09:59:54', args_json: '{}', ingested_at: '2026-08-20 10:00:05' },
        ]
      : undefined),
  )
}

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('extrinsicHashesFor', () => {
  it('deduplicates positions and binds two flat arrays', async () => {
    const client = hashClient()
    const hashes = await extrinsicHashesFor(client as unknown as ClickHouseClient, [
      { blockHeight: 100, extrinsicIndex: 2 },
      { blockHeight: 100, extrinsicIndex: 2 },
      null,
      { blockHeight: 101, extrinsicIndex: 0 },
    ])
    expect(hashes.get('100:2')).toBe(HASH_A)
    expect(hashes.get('101:0')).toBe(HASH_B)
    const read = client.seen.find(s => s.query.includes('-- data:enrich:extrinsic-hashes'))!
    expect(read.params.bs).toEqual([100, 101])
    expect(read.params.es).toEqual([2, 0])
    expect(read.query).toMatch(/arrayZip/)
  })

  it('issues no read for an all-hook page', async () => {
    const client = hashClient()
    const items = await attachExtrinsicHashes(client as unknown as ClickHouseClient, [
      { blockHeight: 5, extrinsicIndex: null },
    ])
    expect(items).toEqual([{ blockHeight: 5, extrinsicIndex: null, extrinsicHash: null }])
    expect(client.seen.some(s => s.query.includes('-- data:enrich:extrinsic-hashes'))).toBe(false)
  })
})

describe('route wiring (events feed)', () => {
  it('carries the hash beside every extrinsicIndex, null for hook rows and unknown positions', async () => {
    app = await freshDataApp(hashClient())
    const res = await app.inject({ url: '/v1/events?limit=10', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((item: { extrinsicIndex: number | null; extrinsicHash: string | null }) => [item.extrinsicIndex, item.extrinsicHash])).toEqual([
      [0, HASH_B],          // resolved
      [2, HASH_A],          // resolved
      [null, null],         // block-hook row: no extrinsic at all
    ])
  })
})
