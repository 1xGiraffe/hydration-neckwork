import { describe, expect, it } from 'vitest'
import { mockSync } from './fixtures/mockApi'
import type { AddressDetail, AssetDetail, CloseAccountsResponse, DailyPoint, EventRow, ExplorerStats, ExtrinsicSummary, ActivityRow } from '../src/types'

const address = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'

describe('explorer API fixture routing', () => {
  it('keeps time-based fixtures stable across test runs', () => {
    const stats = mockSync<ExplorerStats>('/explorer/stats')
    const daily = mockSync<DailyPoint[]>('/explorer/daily/events')
    const asset = mockSync<AssetDetail>('/explorer/asset/0')

    expect(stats?.headTime).toBe('2026-07-15 12:00:00')
    expect(daily?.at(-1)?.date).toBe('2026-07-15')
    expect(asset?.priceDates.at(-1)).toBe('2026-07-15')
  })

  it('keeps account collection endpoints distinct from address detail', () => {
    const detail = mockSync<AddressDetail>(`/explorer/address/${address}`)
    const activity = mockSync<ActivityRow[]>(`/explorer/address/${address}/activity?limit=5`)
    const extrinsics = mockSync<ExtrinsicSummary[]>(`/explorer/address/${address}/extrinsics?limit=5`)
    const events = mockSync<EventRow[]>(`/explorer/address/${address}/events?limit=5`)
    const closeAccounts = mockSync<CloseAccountsResponse>(`/explorer/address/${address}/close-accounts`)

    expect(detail?.accountId).toBeTruthy()
    expect(Array.isArray(activity)).toBe(true)
    expect(Array.isArray(extrinsics)).toBe(true)
    expect(Array.isArray(events)).toBe(true)
    expect(activity).toHaveLength(5)
    expect(extrinsics).toHaveLength(5)
    expect(events).toHaveLength(5)
    expect(closeAccounts?.accounts).toHaveLength(2)
    expect(closeAccounts?.accounts[0].confidence).toBe('strong')
  })
})
