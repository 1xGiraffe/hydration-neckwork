import { describe, it, expect, beforeEach, vi } from 'vitest'

// The mint gate's valuation (apiTokenMintGate.ts) over a stubbed explorer
// service: it must read the account page's own value, and refuse — never
// allow — whenever that value cannot be stated on current prices.
const explorer = vi.hoisted(() => ({
  headTime: null as number | null | Error,
  detail: null as unknown,
  getAddress: null as unknown as ReturnType<typeof vi.fn>,
}))
vi.mock('../src/services/explorerService.ts', () => {
  explorer.getAddress = vi.fn(async () => {
    if (explorer.detail instanceof Error) throw explorer.detail
    return explorer.detail
  })
  return {
    withAccountValuePrices: async <T>(fn: (state: unknown) => Promise<T>) => fn({}),
    accountValuePriceHeadTime: async () => {
      if (explorer.headTime instanceof Error) throw explorer.headTime
      return explorer.headTime
    },
    getAddress: explorer.getAddress,
  }
})

import { MINT_PRICE_MAX_AGE_S, MintValuationUnavailable, mintHoldingsUsd } from '../src/services/apiTokenMintGate.ts'

const ACCOUNT = `0x${'11'.repeat(32)}`
const NOW_MS = 1_800_000_000_000

beforeEach(() => {
  explorer.headTime = NOW_MS / 1000 - 30
  explorer.detail = { portfolioUsd: 12.5, moneyMarket: [{ totalDebtBase: String(2.5e8) }] }
  explorer.getAddress.mockClear()
})

describe('mintHoldingsUsd', () => {
  it('values the account as the account page does: summary read, debt netted', async () => {
    expect(await mintHoldingsUsd(ACCOUNT, NOW_MS)).toBe(10)
    expect(explorer.getAddress).toHaveBeenCalledWith(ACCOUNT, { summary: true })
  })

  it('refuses when no price generation is loaded', async () => {
    explorer.headTime = null
    await expect(mintHoldingsUsd(ACCOUNT, NOW_MS)).rejects.toBeInstanceOf(MintValuationUnavailable)
    expect(explorer.getAddress).not.toHaveBeenCalled()
  })

  it('refuses on prices older than the freshness bound', async () => {
    explorer.headTime = NOW_MS / 1000 - MINT_PRICE_MAX_AGE_S - 1
    await expect(mintHoldingsUsd(ACCOUNT, NOW_MS)).rejects.toBeInstanceOf(MintValuationUnavailable)
    explorer.headTime = NOW_MS / 1000 - MINT_PRICE_MAX_AGE_S + 1
    expect(await mintHoldingsUsd(ACCOUNT, NOW_MS)).toBe(10)
  })

  it('propagates a read failure and refuses an unresolvable or non-finite value', async () => {
    explorer.headTime = new Error('clickhouse down')
    await expect(mintHoldingsUsd(ACCOUNT, NOW_MS)).rejects.toThrow('clickhouse down')
    explorer.headTime = NOW_MS / 1000
    explorer.detail = new Error('query timeout')
    await expect(mintHoldingsUsd(ACCOUNT, NOW_MS)).rejects.toThrow('query timeout')
    explorer.detail = null
    await expect(mintHoldingsUsd(ACCOUNT, NOW_MS)).rejects.toBeInstanceOf(MintValuationUnavailable)
    explorer.detail = { portfolioUsd: Number.NaN, moneyMarket: [] }
    await expect(mintHoldingsUsd(ACCOUNT, NOW_MS)).rejects.toBeInstanceOf(MintValuationUnavailable)
  })
})
