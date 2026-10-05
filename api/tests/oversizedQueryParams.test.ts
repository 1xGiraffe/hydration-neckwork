import { describe, expect, it } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'
import { assertQueryParamsFit, encodedParamBytes, HTTP_FIELD_VALUE_LIMIT, inChunkedSql } from '../src/db/queryParams.ts'

// Lists sized by chain data or by a viewer's list (up to 2,000 members, each with
// its EVM form) must never travel as ONE bound parameter: ClickHouse refuses a
// field over 128 KiB, and the query fails only once production data grows past it.
// Every stub here runs the same guard the live client runs before each request.

const hex = (i: number, len = 64) => `0x${i.toString(16).padStart(len, '0')}`
const LIST_TAG_MEMBERS = 2_000
// The User Revenue non-user set measured 877 accounts / ~64 KiB in October 2026.
const NON_USER_TODAY = 877

type Responder = (query: string, params: Record<string, unknown>) => unknown[]
function guardedClient(respond: Responder = () => []): { client: ClickHouseClient; calls: { query: string; params: Record<string, unknown> }[] } {
  const calls: { query: string; params: Record<string, unknown> }[] = []
  const client = {
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      assertQueryParamsFit(query_params)
      calls.push({ query, params: query_params ?? {} })
      const rows = respond(query, query_params ?? {})
      return { json: async () => rows, text: async () => '' }
    },
    insert: async () => {},
    command: async () => {},
    close: async () => {},
  } as unknown as ClickHouseClient
  return { client, calls }
}

describe('inChunkedSql', () => {
  it('splits a list past one parameter into OR-ed chunks that each fit', () => {
    const accounts = Array.from({ length: NON_USER_TODAY * 2 }, (_, i) => hex(i))
    expect(encodedParamBytes(accounts)).toBeGreaterThan(HTTP_FIELD_VALUE_LIMIT)
    const { sql, params } = inChunkedSql('lower(x)', 'ids', accounts)
    expect(Object.keys(params).length).toBeGreaterThan(1)
    expect(() => assertQueryParamsFit(params)).not.toThrow()
    expect(Object.values(params).flat()).toEqual(accounts)
    expect(sql).toBe(`(${Object.keys(params).map(k => `lower(x) IN {${k}:Array(String)}`).join(' OR ')})`)
  })

  it('is one plain IN for a small list and matches nothing for an empty one', () => {
    expect(inChunkedSql('a', 'ids', ['x'])).toEqual({ sql: 'a IN {ids_0:Array(String)}', params: { ids_0: ['x'] } })
    expect(inChunkedSql('a', 'ids', [])).toEqual({ sql: '0', params: {} })
  })
})

describe('the User Revenue holder rule at twice today\'s non-user set', () => {
  it('binds within the ceiling', async () => {
    const { holderIsUserSql } = await import('../src/services/userRevenueHolders.ts')
    const { resetCacheForTests } = await import('../src/services/cache.ts')
    resetCacheForTests()
    const protocol = Array.from({ length: NON_USER_TODAY * 2 }, (_, i) => ({ a: hex(i + 1), t: 'treasury' }))
    const { client } = guardedClient(query => (query.includes('ur:protocol-holders') ? protocol : []))
    const { params, urNonUser } = await holderIsUserSql(client, 'x')
    expect(urNonUser.length).toBeGreaterThanOrEqual(NON_USER_TODAY * 2)
    expect(encodedParamBytes(urNonUser)).toBeGreaterThan(HTTP_FIELD_VALUE_LIMIT)
    expect(() => assertQueryParamsFit(params)).not.toThrow()
  })
})

describe('a 2,000-member list tag', () => {
  // Distinct in their first 20 bytes, as real accounts are, so the EVM twins are distinct too.
  const members = Array.from({ length: LIST_TAG_MEMBERS }, (_, i) => `0x${(i + 1).toString(16).padStart(8, '0')}${'ab'.repeat(28)}`)
  // Each member's EVM twin doubles the set the User Revenue detail reads.
  const withTwins = [...members, ...members.map(m => `0x45544800${m.slice(2, 42)}0000000000000000`)]

  it('reads its User Revenue detail in chunks whose integer sums add up exactly', async () => {
    const { accountUserRevenueDetail } = await import('../src/services/userRevenueRead.ts')
    const { client, calls } = guardedClient((query, params) => {
      const n = (params.accounts as string[]).length
      // Each account earned 1 and paid 1 (raw units); one fact row and one day row per chunk.
      if (query.includes('ur:account-detail')) return [{ stream: 's', pot: 'p', via: 'v', asset_id: '0', holder_class: 'user', earned: String(n), paid: String(-n), net: '0', unpriced: '1' }]
      return [{ d: '2026-10-01', stream: 's', holder_class: 'user', net: '0', earned: String(n), paid: String(-n) }]
    })
    // One account's figure is the unit (the reader's own fixed-point scale).
    const unit = (await accountUserRevenueDetail(client, [members[0]], '2026-01-01')).rows[0].earned
    calls.length = 0
    const { rows, days } = await accountUserRevenueDetail(client, withTwins, '2026-01-01')
    const chunks = calls.filter(c => c.query.includes('ur:account-detail')).length
    expect(chunks).toBeGreaterThan(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].earned).toBe(unit * BigInt(withTwins.length))
    expect(rows[0].paid).toBe(-unit * BigInt(withTwins.length))
    expect(rows[0].unpriced).toBe(chunks)
    expect(days).toHaveLength(1)
    expect(days[0].earned).toBe(unit * BigInt(withTwins.length))
  })

  it('reads its Data API User Revenue buckets in chunks', async () => {
    const { accountUserRevenueBuckets } = await import('../src/services/userRevenueRead.ts')
    const { client } = guardedClient((_q, params) => [{ t: '1759276800', stream: 's', holder_class: 'user', earned: String((params.accounts as string[]).length), paid: '0', net: '0', unpriced: '0' }])
    const opts = { grain: 'day' as const, fromDay: '2026-01-01', toDay: '2026-10-01' }
    const unit = (await accountUserRevenueBuckets(client, [members[0]], opts))[0].earned
    const out = await accountUserRevenueBuckets(client, withTwins, opts)
    expect(out).toHaveLength(1)
    expect(out[0].earned).toBe(unit * BigInt(withTwins.length))
  })

  it('scopes the directory page to its members within the ceiling', async () => {
    const { getAccountsForMembers, initExplorerService } = await import('../src/services/explorerService.ts')
    const { client, calls } = guardedClient()
    initExplorerService(client)
    await getAccountsForMembers(members, 'value')
    const memberParams = calls.flatMap(c => Object.keys(c.params).filter(k => k.startsWith('members_')))
    expect(memberParams.length).toBeGreaterThan(1)
  })

  it('reads the members\' ERC-20 pots in chunks, counting each storage row once', async () => {
    const { erc20WalletHoldingsForAccounts, initExplorerService } = await import('../src/services/explorerService.ts')
    const { initErc20WalletService } = await import('../src/services/erc20WalletService.ts')
    const h160s = members.map(m => m.slice(0, 42))
    // Every chunk answers the same row: a storage form two chunks both matched.
    const { client, calls } = guardedClient(query => (query.includes('erc20_wallet_balances FINAL') ? [{ account_id: hex(7), asset_id: '0', total: '5' }] : []))
    initExplorerService(client)
    initErc20WalletService(client)
    const out = await erc20WalletHoldingsForAccounts(h160s)
    expect(calls.filter(c => c.query.includes('erc20_wallet_balances FINAL')).length).toBeGreaterThan(1)
    expect(out.map(h => h.raw)).toEqual([5n])
  })

  it('reads the members\' scaled aToken history in chunks', async () => {
    const { loadAccountScaledRead, initExplorerService } = await import('../src/services/explorerService.ts')
    const holders = members.map(m => m.slice(0, 42))
    const { client, calls } = guardedClient((query, params) => (query.includes('history-scaled-anchor')
      ? (params.holders as string[]).map(h => ({ holder: h, contract: '0xc', scaled: '1' }))
      : []))
    initExplorerService(client)
    const bk = { N: 10, endHeight: () => 100, ofTs: () => '0', ofHeightCarry: () => '0' } as never
    const read = await loadAccountScaledRead(holders, ['0xc'], 1, 100, bk)
    expect(calls.filter(c => c.query.includes('history-scaled-anchor')).length).toBeGreaterThan(1)
    expect(read.anchors.size).toBe(holders.length)
  })
})
