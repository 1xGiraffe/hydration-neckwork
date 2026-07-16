import { describe, expect, it, vi } from 'vitest'
import {
  getAssetHolderCounts,
  initExplorerService,
  mergeATokenHolderCounts,
  mmReserveAddressForAsset,
  reconstructATokenHolderCounts,
} from '../src/services/explorerService.ts'

describe('aToken asset-list holder counts', () => {
  it('overrides stale aToken counts while preserving ordinary assets', () => {
    const result = mergeATokenHolderCounts(
      new Map([[46, 27], [1001, 999], [1816, 3]]),
      [1001, 1005, 1816],
      [
        { assetId: 1001, contract: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        { assetId: 1005, contract: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      ],
      new Map([['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 2]]),
    )

    expect(result).toEqual(new Map([[46, 27], [1001, 2], [1005, 0]]))
  })

  it('normalizes and batches contracts for indexed holder reconstruction', async () => {
    const query = vi.fn(async (_request: {
      query: string
      query_params?: unknown
      clickhouse_settings?: Record<string, unknown>
    }) => ({
      json: async () => [
        { contract: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', holders: '1006' },
        { contract: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', holders: 227 },
      ],
    }))

    const result = await reconstructATokenHolderCounts(
      { query } as never,
      [
        '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'not-an-address',
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ],
      8_200_000,
    )

    expect(result).toEqual(new Map([
      ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1006],
      ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 227],
    ]))
    const request = query.mock.calls[0][0]
    expect(request.query_params).toEqual({
      contracts: [
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ],
      b0: 8_200_000,
    })
    expect(request.query).toContain("NOT startsWith(holder, '0x6d6f646c')")
    expect(request.query).toContain('HAVING scaled > 0')
    expect(request.clickhouse_settings).toMatchObject({
      max_threads: 4,
      max_memory_usage: '3000000000',
      max_bytes_before_external_group_by: '500000000',
    })
  })

  it('skips ClickHouse when no valid contracts are supplied', async () => {
    const query = vi.fn()

    await expect(reconstructATokenHolderCounts({ query } as never, ['invalid'], 1)).resolves.toEqual(new Map())
    expect(query).not.toHaveBeenCalled()
  })

  it('wires reconstructed aToken counts into the asset-list holder map', async () => {
    const reserve = mmReserveAddressForAsset(5)[0]
    const contract = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const pool = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
    const query = vi.fn(async ({ query: sql }: { query: string }) => {
      if (sql.includes('count() AS n') && sql.includes('account_asset_latest_balances')) {
        return { json: async () => [
          { asset_id: '46', n: 27 },
          { asset_id: '1001', n: 999 },
        ] }
      }
      if (sql.includes('max(anchor_block) AS b0')) {
        return { json: async () => [{ b0: 8_200_000 }] }
      }
      if (sql.includes('FROM price_data.atoken_reserve_map')) {
        return { json: async () => [{
          asset_address: reserve,
          atoken: contract,
          vdebt: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          pool_proxy: pool,
          market_key: 'core',
        }] }
      }
      if (sql.includes('FROM price_data.raw_money_market_reserves')) {
        return { json: async () => [{
          pool,
          reserve,
          liq: '1000000000000000000000000000',
          vbi: '1000000000000000000000000000',
        }] }
      }
      if (sql.includes('sum(anchor) + sum(delta) AS scaled')) {
        return { json: async () => [{ contract, holders: 2 }] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    })
    initExplorerService({ query } as never)

    const counts = await getAssetHolderCounts()

    expect(counts.get(46)).toBe(27)
    expect(counts.get(1001)).toBe(2)
    expect(counts.has(1816)).toBe(false)
  })
})

// aToken holder rows resolve through accountRef: tagged holders (e.g. the
// GIGADOT pool via its truncated H160) collapse into tag group rows, matching
// the substrate-side holders query. Untagged holders stay individual.
describe('groupATokenHolderRows — tag grouping for aToken holder lists', () => {
  const POOL = '0xe21da918e4176b72ef1930ffaa17edcb03b9b739c2843fb0cf096283a7d9c261'
  const ref = (accountId: string) => ({
    accountId,
    address: accountId.slice(0, 10),
    emoji: '🐽', emojiName: null, emojiUrl: null,
    tag: accountId === POOL ? { id: 'stableswap-pools', name: 'Stableswap Pool', color: '#38a3d8', icon: '💧' } : null,
    identity: null,
  })
  const toAccountId = (h160: string) =>
    h160 === '0xe21da918e4176b72ef1930ffaa17edcb03b9b739' ? POOL : '0x45544800' + h160.slice(2) + '0000000000000000'

  it('collapses tagged holders into a tag row and ranks by balance', async () => {
    const { groupATokenHolderRows } = await import('../src/services/explorerService.ts')
    const rows = groupATokenHolderRows([
      { h160: '0xe21da918e4176b72ef1930ffaa17edcb03b9b739', bal: 300n },   // tagged pool
      { h160: '0x1111111111111111111111111111111111111111', bal: 500n },   // plain EVM user
      { h160: '0x2222222222222222222222222222222222222222', bal: 100n },
    ], ref as never, toAccountId)

    expect(rows.map(r => r.balance)).toEqual(['500', '300', '100'])
    expect(rows.map(r => r.rank)).toEqual([1, 2, 3])
    expect(rows[1].tag).toMatchObject({ tagId: 'stableswap-pools', name: 'Stableswap Pool', memberCount: 1 })
    expect(rows[1].account).toBeNull()
    expect(rows[0].tag).toBeNull()
    expect(rows[0].account?.accountId).toBe('0x455448001111111111111111111111111111111111111111' + '0000000000000000')
  })

  it('sums balances of several same-tag holders into one group row', async () => {
    const { groupATokenHolderRows } = await import('../src/services/explorerService.ts')
    const twoPools = (_h160: string) => POOL // both resolve to tagged accounts
    const refBoth = (accountId: string) => ({ ...ref(POOL), accountId })
    const rows = groupATokenHolderRows([
      { h160: '0xe21da918e4176b72ef1930ffaa17edcb03b9b739', bal: 300n },
      { h160: '0x3333333333333333333333333333333333333333', bal: 200n },
    ], refBoth as never, twoPools)

    expect(rows).toHaveLength(1)
    expect(rows[0].balance).toBe('500')
    expect(rows[0].tag).toMatchObject({ memberCount: 2 })
  })
})

describe('groupHolderBalanceClaims — folded display holders', () => {
  it('merges wallet and aToken claims for one canonical account without double-counting tag members', async () => {
    const { groupHolderBalanceClaims } = await import('../src/services/explorerService.ts')
    const ref = (accountId: string) => ({
      accountId,
      address: accountId,
      emoji: '•', emojiName: null, emojiUrl: null,
      tag: accountId.startsWith('pool-')
        ? { id: 'pools', name: 'Pools', color: '#123456', icon: '💧' }
        : null,
      identity: null,
    })
    const rows = groupHolderBalanceClaims([
      { accountId: 'alice', bal: 40n, lastBlock: 10 },
      { accountId: 'alice', bal: 60n, lastBlock: 0 },
      { accountId: 'pool-a', bal: 70n, lastBlock: 9 },
      { accountId: 'pool-a', bal: 30n, lastBlock: 0 },
      { accountId: 'pool-b', bal: 50n, lastBlock: 8 },
    ], ref as never)

    expect(rows.map(row => row.balance)).toEqual(['150', '100'])
    expect(rows[0].tag).toMatchObject({ tagId: 'pools', memberCount: 2 })
    expect(rows[1].account?.accountId).toBe('alice')
    expect(rows[1].lastBlock).toBe(10)
  })

  it('keeps module-held claims and only retains the unattributed custody remainder', async () => {
    const { groupHolderBalanceClaims, unattributedCustodyBalance } = await import('../src/services/explorerService.ts')
    const ref = (accountId: string) => ({
      accountId,
      address: accountId,
      emoji: '•', emojiName: null, emojiUrl: null,
      tag: accountId === 'omnipool'
        ? { id: 'omnipool', name: 'Omnipool', color: '#123456', icon: '💧' }
        : accountId === 'custody'
          ? { id: 'supply-borrow', name: 'Supply & Borrow', color: '#654321', icon: '🏦' }
          : null,
      identity: null,
    })
    const remainder = unattributedCustodyBalance(1_000n, 750n)
    const rows = groupHolderBalanceClaims([
      { accountId: 'omnipool', bal: 600n, lastBlock: 0 },
      { accountId: 'alice', bal: 150n, lastBlock: 0 },
      { accountId: 'custody', bal: remainder, lastBlock: 99 },
    ], ref as never)

    expect(remainder).toBe(250n)
    expect(rows.map(row => row.balance)).toEqual(['600', '250', '150'])
    expect(rows[0].tag).toMatchObject({ tagId: 'omnipool' })
    expect(rows[1].tag).toMatchObject({ tagId: 'supply-borrow' })
    expect(rows.reduce((sum, row) => sum + BigInt(row.balance), 0n)).toBe(1_000n)
    expect(unattributedCustodyBalance(1_000n, 1_000n)).toBe(0n)
    expect(unattributedCustodyBalance(1_000n, 1_001n)).toBe(0n)
  })
})
