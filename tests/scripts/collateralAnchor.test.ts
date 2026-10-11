import { describe, expect, it } from 'vitest'
import { collateralPairsToRead, createCollateralAnchorJob } from '../../src/scripts/collateralAnchor.ts'
import { openPositionKey } from '../../src/raw/moneyMarketSnapshot.ts'
import type { RawMoneyMarketCollateralFlagRow } from '../../src/raw/types.ts'

// The collateral seed: every candidate (user, pool) no read at or above B0 covers is
// read once at one pinned block; from then on the raw indexer keeps it current.

const POOL = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const GIGA = '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923'
const ALICE = '0xa11ce00000000000000000000000000000000001'
const BOB = '0xb0b0000000000000000000000000000000000002'
const CAROL = '0xca401000000000000000000000000000000000c3'
const B0 = 8_200_000

describe('collateralPairsToRead', () => {
  const candidates = [
    { pool: POOL, user: ALICE }, { pool: POOL.toUpperCase().replace('0X', '0x'), user: BOB }, { pool: GIGA, user: ALICE },
    { pool: '0x00000000000000000000000000000000000000aa', user: CAROL }, { pool: POOL, user: 'not-an-address' }, { pool: POOL, user: ALICE },
  ]

  it('full: every candidate of a known pool, deduplicated and sorted', () => {
    expect(collateralPairsToRead(candidates, new Set([openPositionKey(POOL, ALICE)]), [POOL, GIGA], 'full'))
      .toEqual(new Map([[POOL, [ALICE, BOB]], [GIGA, [ALICE]]]))
  })

  it('top-up: only the candidates no read at or above B0 covers, per pool', () => {
    expect(collateralPairsToRead(candidates, new Set([openPositionKey(POOL, ALICE)]), [POOL, GIGA], 'top-up'))
      .toEqual(new Map([[POOL, [BOB]], [GIGA, [ALICE]]]))
    expect(collateralPairsToRead(candidates, new Set([openPositionKey(POOL, ALICE), openPositionKey(POOL, BOB), openPositionKey(GIGA, ALICE)]), [POOL, GIGA], 'top-up').size).toBe(0)
  })
})

function fakeClient(rows: { candidates: Array<{ pool: string; user: string }>; covered: Array<{ pool: string; user: string }> }) {
  const queries: Array<{ query: string; params: Record<string, unknown> }> = []
  const inserts: Array<{ table: string; values: unknown[] }> = []
  const client = {
    query: async (o: { query: string; query_params: Record<string, unknown> }) => {
      queries.push({ query: o.query, params: o.query_params })
      const data = o.query.includes('FROM price_data.money_market_collateral_anchor') ? rows.covered : rows.candidates
      return { json: async () => data }
    },
    insert: async (o: { table: string; values: unknown[] }) => { inserts.push(o) },
  }
  return { client: client as never, queries, inserts }
}

const flag = (user: string, pool: string, block: number): RawMoneyMarketCollateralFlagRow => ({ user_address: user, pool_address: pool, reserve_address: '0x0000000000000000000000000000000100000005', block_height: block, enabled: 1, observed_at: '2026-10-11 00:00:00' })

describe('the collateral seed job', () => {
  it('reads the uncovered candidates at the pinned block and writes their rows', async () => {
    const f = fakeClient({ candidates: [{ pool: POOL, user: ALICE }, { pool: POOL, user: BOB }, { pool: GIGA, user: CAROL }], covered: [{ pool: POOL, user: ALICE }] })
    const reads: Array<{ users: string[]; block: number; pool: string }> = []
    const logs: Array<Record<string, unknown>> = []
    const job = createCollateralAnchorJob({
      client: f.client, anchorBlock: B0, pools: [POOL, GIGA], pinnedBlock: async () => 15_100_000,
      readCollateral: async (users, block, pool) => { reads.push({ users, block, pool }); return { flags: users.map(u => flag(u, pool, block)), failedUsers: [] } },
      log: r => { logs.push(r) },
    })
    await job.capture({ dryRun: false, mode: 'top-up' })
    // Covered means a row at or above B0: below it the log coverage is partial.
    expect(f.queries.find(q => q.query.includes('money_market_collateral_anchor'))?.query).toContain('block_height >= {b0:UInt32}')
    expect(f.queries.every(q => q.params.b0 === B0)).toBe(true)
    expect(reads).toEqual([{ users: [BOB], block: 15_100_000, pool: POOL }, { users: [CAROL], block: 15_100_000, pool: GIGA }])
    expect(f.inserts.map(i => [i.table, i.values.length])).toEqual([['price_data.money_market_collateral_anchor', 1], ['price_data.money_market_collateral_anchor', 1]])
    expect(logs).toEqual([expect.objectContaining({ type: 'mm_collateral_anchor_done', mode: 'top-up', block: 15_100_000, candidates: 3, read: 2 })])
  })

  it('pins no block and reads nothing when every candidate is covered; a dry run reads all and writes nothing', async () => {
    let pinned = 0
    const covered = fakeClient({ candidates: [{ pool: POOL, user: ALICE }], covered: [{ pool: POOL, user: ALICE }] })
    const quiet = createCollateralAnchorJob({ client: covered.client, anchorBlock: B0, pools: [POOL], pinnedBlock: async () => { pinned++; return 1 }, readCollateral: async () => { throw new Error('no read expected') }, log: () => {} })
    await quiet.capture({ dryRun: false, mode: 'top-up' })
    expect(pinned).toBe(0)

    const dry = fakeClient({ candidates: [{ pool: POOL, user: ALICE }], covered: [{ pool: POOL, user: ALICE }] })
    const reads: string[][] = []
    const job = createCollateralAnchorJob({ client: dry.client, anchorBlock: B0, pools: [POOL], pinnedBlock: async () => 9, readCollateral: async users => { reads.push(users); return { flags: users.map(u => flag(u, POOL, 9)), failedUsers: [] } }, log: () => {} })
    await job.capture({ dryRun: true, mode: 'full' })
    expect(reads).toEqual([[ALICE]])
    expect(dry.inserts).toEqual([])
  })

  it('leaves a user whose word could not be read uncovered, so the next cycle reads it again', async () => {
    const f = fakeClient({ candidates: [{ pool: POOL, user: ALICE }, { pool: POOL, user: BOB }], covered: [] })
    const logs: Array<Record<string, unknown>> = []
    const job = createCollateralAnchorJob({
      client: f.client, anchorBlock: B0, pools: [POOL], pinnedBlock: async () => 15_100_000,
      readCollateral: async (users, block, pool) => ({ flags: [flag(ALICE, pool, block)], failedUsers: users.filter(u => u === BOB) }),
      log: r => { logs.push(r) },
    })
    await job.capture({ dryRun: false, mode: 'top-up' })
    expect(f.inserts.flatMap(i => i.values)).toEqual([flag(ALICE, POOL, 15_100_000)])
    expect(logs[0]).toMatchObject({ markets: [{ pool: POOL, read: 2, rows: 1, failed: 1 }] })
  })
})
