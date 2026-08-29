import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { encodeAddress } from '@polkadot/util-crypto'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'

// Contract tests for GET /v1/staking/events: the global staking-only feed.

type Row = Record<string, unknown>

const STAKER = `0x${'66'.repeat(32)}`

function stakingRow(block: number, event: number, name: string, args: Record<string, unknown>): Row {
  return {
    block_height: block, event_index: event, extrinsic_index: name.startsWith('CollatorRewards') ? null : 1,
    ts: '2026-08-20 10:00:00', event_name: name,
    who: STAKER, args_json: JSON.stringify(args), ingested_at: '2026-08-20 10:00:05',
  }
}

const ROWS: Row[] = [
  stakingRow(300, 5, 'GigaHdx.Staked', { who: STAKER, amount: '1000', gigahdx: '900' }),
  stakingRow(200, 3, 'CollatorRewards.CollatorRewarded', { who: STAKER, amount: '455371584699000', currency: 0 }),
  stakingRow(100, 1, 'Staking.RewardsClaimed', { who: STAKER, paidRewards: '77' }),
]

function stakingClient(rows: Row[] = ROWS) {
  return fakeDataClient((query, params) => {
    if (!query.includes('-- data:staking:events')) return undefined
    let matched = rows
    if (params.names) matched = matched.filter(row => (params.names as string[]).includes(String(row.event_name)))
    if (params.cb != null) matched = matched.filter(row => Number(row.block_height) < Number(params.cb)
      || (Number(row.block_height) === Number(params.cb) && Number(row.event_index) < Number(params.ci)))
    return matched
  })
}

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /v1/staking/events', () => {
  it('serves the typed global stream newest first with decoded args', async () => {
    app = await freshDataApp(stakingClient())
    const res = await app.inject({ url: '/v1/staking/events', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const { items, hasMore } = res.json()
    expect(hasMore).toBe(false)
    expect(items.map((e: { blockHeight: number }) => e.blockHeight)).toEqual([300, 200, 100])
    expect(items[0]).toEqual({
      blockHeight: 300, eventIndex: 5, extrinsicIndex: 1, extrinsicHash: null, timestamp: '2026-08-20T10:00:00.000Z',
      eventName: 'GigaHdx.Staked',
      who: { address: encodeAddress(STAKER, 0), accountIdHex: STAKER, evmAddress: null },
      args: { who: STAKER, amount: '1000', gigahdx: '900' },
    })
    // A hook-context payout carries no extrinsic.
    expect(items[1]).toMatchObject({ eventName: 'CollatorRewards.CollatorRewarded', extrinsicIndex: null, extrinsicHash: null })
    expect(res.headers['cache-control']).toBe('private, max-age=60')
  })

  it('filters by type and rejects an unknown name instead of an empty page', async () => {
    const client = stakingClient()
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/staking/events?type=GigaHdx.Staked,Staking.RewardsClaimed', headers: AUTH })
    expect(res.json().items.map((e: { eventName: string }) => e.eventName)).toEqual(['GigaHdx.Staked', 'Staking.RewardsClaimed'])

    const bad = await app.inject({ url: '/v1/staking/events?type=Staking.Rewarded', headers: AUTH })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.message).toMatch(/unknown staking event type/)
    expect(bad.json().error.message).toMatch(/GigaHdx.Staked/)
  })

  it('pages by cursor without overlap', async () => {
    app = await freshDataApp(stakingClient())
    const first = await app.inject({ url: '/v1/staking/events?limit=2', headers: AUTH })
    expect(first.json().items.map((e: { blockHeight: number }) => e.blockHeight)).toEqual([300, 200])
    expect(first.json().hasMore).toBe(true)
    const second = await app.inject({ url: `/v1/staking/events?limit=2&cursor=${first.json().nextCursor}`, headers: AUTH })
    expect(second.json().items.map((e: { blockHeight: number }) => e.blockHeight)).toEqual([100])
    expect(second.json().hasMore).toBe(false)
  })

  it('collapses a replayed row instead of serving it twice', async () => {
    app = await freshDataApp(stakingClient([ROWS[0], ROWS[0], ROWS[1]]))
    const res = await app.inject({ url: '/v1/staking/events?limit=9', headers: AUTH })
    expect(res.json().items.map((e: { blockHeight: number }) => e.blockHeight)).toEqual([300, 200])
  })
})
