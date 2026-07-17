import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  affinityScore,
  isSelectiveCexEndpoint,
  isSystemAccount,
  nearSigningDays,
  qualifiesAffinityCandidate,
} from '../src/services/accountAffinityService.ts'

const TARGET = '0x2c9cb9a8e415f13e70494c9f54e9d9d7740b6104eba196440b1bc9eacc774d09'
const CANDIDATE = '0x5887da297c56fa911c2ec1b9a4f731f1dca0ee64a8b21e8e4e2ee2dadf747273'
const NOISY_DISTRIBUTOR = '0x6887da297c56fa911c2ec1b9a4f731f1dca0ee64a8b21e8e4e2ee2dadf747274'
const KRAKEN = '0xa7208d10c6622f3f7eca1551de8355fde9de577dbb308d38994ace561738a51f'
const MODULE = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'

describe('account affinity evidence rules', () => {
  it('rejects system prefixes and conservative low-signal transfer sets', () => {
    expect(isSystemAccount(MODULE)).toBe(true)
    expect(isSystemAccount(TARGET)).toBe(false)
    expect(isSelectiveCexEndpoint(2)).toBe(true)
    expect(isSelectiveCexEndpoint(5)).toBe(true)
    expect(isSelectiveCexEndpoint(6)).toBe(false)
    expect(isSelectiveCexEndpoint(241)).toBe(false)
    expect(qualifiesAffinityCandidate({ transferCount: 2, activeDays: 1, totalUsd: 50_000, maxSingleUsd: 9_000, pricedTransfers: 2 })).toBe(false)
    expect(qualifiesAffinityCandidate({ transferCount: 2, activeDays: 2, totalUsd: 101, maxSingleUsd: 60, pricedTransfers: 2 })).toBe(true)
    expect(qualifiesAffinityCandidate({ transferCount: 1, activeDays: 1, totalUsd: 10_001, maxSingleUsd: 10_001, pricedTransfers: 1 })).toBe(true)
    expect(qualifiesAffinityCandidate({ transferCount: 3, activeDays: 3, totalUsd: 0, maxSingleUsd: 0, pricedTransfers: 0 })).toBe(true)
  })

  it('scores direct evidence first and caps confirmation bonuses', () => {
    const score = affinityScore({
      transferCount: 15,
      activeDays: 4,
      totalUsd: 43_584,
      bidirectional: false,
      nearSigningDays: 2,
      sharedCex: true,
      daysSinceLast: 29,
    })
    expect(score).toBeGreaterThanOrEqual(80)
    expect(score).toBeLessThanOrEqual(100)
    expect(affinityScore({
      transferCount: 2,
      activeDays: 1,
      totalUsd: 100,
      bidirectional: false,
      nearSigningDays: 1,
      sharedCex: false,
      daysSinceLast: 180,
    })).toBeLessThan(45)
  })

  it('counts nearby signing on distinct days but ignores exact same-block bots', () => {
    expect(nearSigningDays([100, 200, 300], [
      { blockHeight: 100, day: '2026-06-01' },
      { blockHeight: 108, day: '2026-06-01' },
      { blockHeight: 209, day: '2026-06-02' },
      { blockHeight: 311, day: '2026-06-03' },
    ])).toBe(2)
  })
})

function queryResult<T extends object>(rows: T[]) {
  return { json: vi.fn(async () => rows) }
}

describe('getCloseAccounts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    vi.doUnmock('../src/services/explorerService.ts')
    vi.doUnmock('../src/services/tagService.ts')
  })

  it('combines explicit transfers, nearby signing, and a selective shared CEX endpoint', async () => {
    vi.resetModules()
    const accountRef = vi.fn((accountId: string) => ({
      accountId,
      address: accountId,
      emoji: '🧪',
      tag: accountId === KRAKEN ? { id: 'kraken', name: 'Kraken', color: '', icon: '' } : null,
      identity: null,
    }))
    vi.doMock('../src/services/explorerService.ts', () => ({
      accountRef,
      getAssets: vi.fn(async () => [{
        assetId: 0,
        symbol: 'HDX',
        name: 'Hydration',
        decimals: 12,
        parachainId: null,
        price: 0.01,
        change24h: null,
        change7d: null,
        type: 'Native',
        amountUsd: null,
      }]),
      resolveRelatedAccounts: vi.fn(async (input: string) => {
        if (input === 'invalid') return null
        if (input === 'system') return { norm: { accountId: MODULE }, related: [MODULE], aliasRows: [] }
        return { norm: { accountId: TARGET }, related: [TARGET], aliasRows: [] }
      }),
    }))
    vi.doMock('../src/services/tagService.ts', () => ({
      getTag: vi.fn((id: string) => id === 'kraken'
        ? { tagId: 'kraken', name: 'Kraken', color: '', note: '', icon: '', members: [KRAKEN] }
        : null),
      tagForAccount: vi.fn((accountId: string) => accountId === KRAKEN
        ? { tagId: 'kraken', name: 'Kraken', color: '', icon: '' }
        : null),
    }))

    const directRows = Array.from({ length: 15 }, (_, i) => ({
      block_height: 1_000 + i,
      ts: `2026-06-${String(8 + (i % 4)).padStart(2, '0')} 12:00:00`,
      extrinsic_index: i,
      from_acc: TARGET,
      to_acc: CANDIDATE,
      asset_id: 0,
      amount: '300000000000000000',
      fanout: 1,
    }))
    directRows.push({
      block_height: 2_000,
      ts: '2026-06-11 13:00:00',
      extrinsic_index: 1,
      from_acc: KRAKEN,
      to_acc: TARGET,
      asset_id: 0,
      amount: '1',
      fanout: 1,
    })
    // A large distributor payment would otherwise be a compelling amount, but
    // the global extrinsic fanout guard must reject it.
    directRows.push({
      block_height: 2_001,
      ts: '2026-06-11 14:00:00',
      extrinsic_index: 2,
      from_acc: NOISY_DISTRIBUTOR,
      to_acc: TARGET,
      asset_id: 0,
      amount: '999999000000000000',
      fanout: 100,
    })

    const client = {
      query: vi.fn((request: { query: string; query_params: Record<string, unknown>; clickhouse_settings: Record<string, unknown> }) => {
        expect(request.query_params.lookbackDays).toBeUndefined()   // unlimited lookback: no time bound
        expect(request.clickhouse_settings.max_execution_time).toBe(5)
        if (request.query_params.cexAccounts) return queryResult([{ user_acc: CANDIDATE, cex_acc: KRAKEN, endpoint_users: 2 }])
        if (request.query_params.assetIds) return queryResult([
          { asset_id: 0, day: '2026-06-08', price: 0.01 },
          { asset_id: 0, day: '2026-06-09', price: 0.01 },
          { asset_id: 0, day: '2026-06-10', price: 0.01 },
          { asset_id: 0, day: '2026-06-11', price: 0.01 },
        ])
        if (request.query.includes('FROM price_data.raw_extrinsics')) return queryResult([
          { actor: TARGET, block_height: 100, day: '2026-06-08' },
          { actor: TARGET, block_height: 200, day: '2026-06-09' },
          { actor: CANDIDATE, block_height: 108, day: '2026-06-08' },
          { actor: CANDIDATE, block_height: 209, day: '2026-06-09' },
          { actor: CANDIDATE, block_height: 200, day: '2026-06-10' },
        ])
        expect(request.query_params.accounts).toEqual([TARGET])
        expect(request.query_params.refLimit).toBe(5_000)
        return queryResult(directRows)
      }),
    }

    const { getCloseAccounts, initAccountAffinityService } = await import('../src/services/accountAffinityService.ts')
    initAccountAffinityService(client as never)
    const result = await getCloseAccounts(TARGET)

    expect(result).not.toBeNull()
    expect(result?.lookbackDays).toBeNull()
    expect(result?.disclaimer).toContain('not proof')
    expect(result?.accounts).toHaveLength(1)
    expect(result?.accounts[0]).toMatchObject({
      account: { accountId: CANDIDATE },
      confidence: 'strong',
      reasons: [
        { type: 'direct_transfers', count: 15, days: 4, bidirectional: false },
        { type: 'near_signing', days: 2 },
        { type: 'shared_cex', name: 'Kraken' },
      ],
    })
    expect(result?.accounts[0].score).toBeGreaterThanOrEqual(70)

    await expect(getCloseAccounts(TARGET)).resolves.toEqual(result)
    expect(client.query).toHaveBeenCalledTimes(4)
    await expect(getCloseAccounts('system')).resolves.toEqual({
      accounts: [],
      lookbackDays: null,
      disclaimer: 'Behavioral signals, not proof of common ownership.',
    })
    expect(client.query).toHaveBeenCalledTimes(4)
    await expect(getCloseAccounts('invalid')).resolves.toBeNull()
  })
})

describe('/explorer/address/:address/close-accounts', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../src/services/accountAffinityService.ts')
  })

  it('validates the address and distinguishes unknown accounts', async () => {
    vi.resetModules()
    const getCloseAccounts = vi.fn(async (address: string) => {
      if (address === MODULE) throw Object.assign(new Error('busy'), { code: 'ACCOUNT_AFFINITY_BUSY' })
      return address === TARGET
        ? { accounts: [], lookbackDays: null, disclaimer: 'Behavioral signals, not proof of common ownership.' }
        : null
    })
    vi.doMock('../src/services/accountAffinityService.ts', () => ({
      ACCOUNT_AFFINITY_BUSY_CODE: 'ACCOUNT_AFFINITY_BUSY',
      getCloseAccounts,
    }))

    const [{ default: Fastify }, { explorerRoutes }] = await Promise.all([
      import('fastify'),
      import('../src/routes/explorer.ts'),
    ])
    const app = Fastify()
    await app.register(explorerRoutes)

    const ok = await app.inject(`/explorer/address/${TARGET}/close-accounts`)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ lookbackDays: null, accounts: [] })

    const missing = await app.inject(`/explorer/address/${CANDIDATE}/close-accounts`)
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ error: 'Address not recognized' })

    const busy = await app.inject(`/explorer/address/${MODULE}/close-accounts`)
    expect(busy.statusCode).toBe(503)
    expect(busy.headers['retry-after']).toBe('5')

    const invalid = await app.inject('/explorer/address/x/close-accounts')
    expect(invalid.statusCode).toBe(400)
    expect(getCloseAccounts).toHaveBeenCalledTimes(3)
    await app.close()
  })
})
