import { describe, expect, it } from 'vitest'
import { API_CLICKHOUSE_SETTINGS } from '../src/db/client.ts'

// A tag page reads its members' activity with the account list interpolated into the
// SQL — 68 bytes per account, several copies per statement (the candidate read and
// its account-index prefilter). The largest tag, xyk-pools, has 730 members: its
// liquidity window read came out past ClickHouse's default parser ceiling of 256 KiB
// (`max_query_size`), so its Transfer, Liquidity and All tabs answered 500 — 83
// times on 2026-09-07 alone. The ceiling only sizes the parser's buffer, so the API
// raises it per query; 1 MiB leaves that tag four times over and a tag twice its
// size still inside.
describe('API ClickHouse settings', () => {
  it('raises max_query_size well past the 256 KiB default a large tag overruns', () => {
    expect(Number(API_CLICKHOUSE_SETTINGS.max_query_size)).toBeGreaterThanOrEqual(1_048_576)
  })
})
