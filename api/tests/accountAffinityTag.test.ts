import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const KRAKEN = `0x${'11'.repeat(32)}`
const CANDIDATE = `0x${'22'.repeat(32)}`

function queryResult<T extends object>(rows: T[]) {
  return { json: vi.fn(async () => rows) }
}

// Module isolation keeps the service dependencies deterministic for this suite.
describe('getCloseAccountsForTag', () => {
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

  // Tag members are tagged by definition — the address-mode service-account
  // guard must not short-circuit the tag variant to an empty result.
  it('computes matches although the targets themselves are tagged', async () => {
    vi.resetModules()
    vi.doMock('../src/services/explorerService.ts', () => ({
      accountRef: vi.fn((accountId: string) => ({
        accountId, address: accountId, emoji: '🧪',
        tag: accountId === KRAKEN ? { id: 'kraken', name: 'Kraken', color: '', icon: '' } : null,
        identity: null,
      })),
      getAssets: vi.fn(async () => []),
      resolveRelatedAccounts: vi.fn(async () => null),
    }))
    vi.doMock('../src/services/tagService.ts', () => ({
      getTag: vi.fn((id: string) => id === 'kraken'
        ? { tagId: 'kraken', name: 'Kraken', color: '', note: '', icon: '', members: [KRAKEN] }
        : null),
      tagForAccount: vi.fn((accountId: string) => accountId === KRAKEN
        ? { tagId: 'kraken', name: 'Kraken', color: '', icon: '' }
        : null),
    }))
    // 10 unpriced transfers across 5 days: count/day points alone must clear
    // the 45-score gate (no USD, timing or CEX bonuses in this fixture).
    const directRows = Array.from({ length: 10 }, (_, i) => ({
      block_height: 1_000 + i,
      ts: `2026-07-0${1 + (i % 5)} 12:00:00`,
      extrinsic_index: i,
      from_acc: KRAKEN,
      to_acc: CANDIDATE,
      asset_id: 0,
      amount: '300000000000000000',
      fanout: 1,
    }))
    const client = {
      query: vi.fn((request: { query: string }) => {
        if (request.query.includes('FROM price_data.ohlc_1d')) return queryResult([])
        if (request.query.includes('FROM price_data.raw_extrinsics')) return queryResult([])
        return queryResult(directRows)
      }),
    }
    const { getCloseAccountsForTag, initAccountAffinityService } = await import('../src/services/accountAffinityService.ts')
    initAccountAffinityService(client as never)
    const result = await getCloseAccountsForTag('kraken')
    expect(result).not.toBeNull()
    expect(result?.accounts.map(a => a.account.accountId)).toEqual([CANDIDATE])
  })
})
