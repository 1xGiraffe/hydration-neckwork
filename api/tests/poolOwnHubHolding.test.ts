import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OMNIPOOL_ACCOUNT, POOL_OWN_HUB_HOLDINGS, isPoolOwnHubHolding, poolOwnHubHoldingSql } from '../src/services/valuation.ts'
import { foldShareBalances, topHeldTokens, valueAccountBalances } from '../src/services/explorerService.ts'
import type { AddressBalance, PriceInfo } from '../src/services/explorerService.ts'
import { H2O_ASSET_ID } from '../src/services/explorerAssets.ts'

// A pool account's holding of its OWN hub asset is a balance and never a value:
// the Omnipool prices H2O off the assets it pools, so its hub reserve valued at
// that price restates the pooled assets the same figure already counts. The
// rule is exactly (Omnipool pallet account, H2O) — every other holder's H2O is a
// claim on the pool and counts.

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const fn = (name: string) => {
  const at = explorerService.indexOf(`async function ${name}(`)
  expect(at, name).toBeGreaterThan(-1)
  return explorerService.slice(at, explorerService.indexOf('\n}\n', at))
}

const TREASURY = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'
const prices = new Map<number, PriceInfo>([
  [H2O_ASSET_ID, { price: 6, change24h: 0 }],
  [5, { price: 4, change24h: 0 }],
])
// 12 decimals: the registry default under the test's unloaded asset table, and H2O's.
const raw = (units: number) => (BigInt(units) * 10n ** 12n).toString()
const row = (assetId: number, total: string, uncounted?: string) => ({ asset_id: String(assetId), total, free: total, reserved: '0', last_block: 9, ...(uncounted != null ? { uncounted } : {}) })

describe('the pool-own-hub rule', () => {
  it('names the Omnipool pallet account holding H2O, and nothing else', () => {
    expect(POOL_OWN_HUB_HOLDINGS).toEqual([{ account: OMNIPOOL_ACCOUNT, assetId: H2O_ASSET_ID }])
    expect(isPoolOwnHubHolding(OMNIPOOL_ACCOUNT, H2O_ASSET_ID)).toBe(true)
    expect(isPoolOwnHubHolding(OMNIPOOL_ACCOUNT.toUpperCase().replace('0X', '0x'), H2O_ASSET_ID)).toBe(true)
    // The pool's other holdings are the pooled assets themselves: counted.
    expect(isPoolOwnHubHolding(OMNIPOOL_ACCOUNT, 0)).toBe(false)
    expect(isPoolOwnHubHolding(OMNIPOOL_ACCOUNT, 5)).toBe(false)
    // Anyone else's H2O is a claim on the pool: counted.
    expect(isPoolOwnHubHolding(TREASURY, H2O_ASSET_ID)).toBe(false)
  })

  it('states the same rule as a SQL predicate over the balance tables\' String columns', () => {
    expect(poolOwnHubHoldingSql('account_id', 'asset_id'))
      .toBe(`((account_id = '${OMNIPOOL_ACCOUNT}' AND asset_id = '${H2O_ASSET_ID}'))`)
  })
})

describe('valueAccountBalances', () => {
  it('keeps an uncounted slice in the row and out of its value', () => {
    const [h2o] = valueAccountBalances([row(H2O_ASSET_ID, raw(100), raw(100))], prices)
    // The whole amount stays: it is a real balance.
    expect(h2o.total).toBe(raw(100))
    expect(h2o.uncounted).toEqual({ amount: raw(100), reason: 'pool-hub-reserve' })
    // Priced and left out on purpose: 0, never null (null is "no price").
    expect(h2o.valueUsd).toBe(0)
  })

  it('values only the counted remainder of a partly uncounted row', () => {
    // A list-tag folding the pool with another H2O holder: 100 H2O, 75 of it the
    // pool's own reserve — the other 25 are that holder's claim on the pool.
    const [h2o] = valueAccountBalances([row(H2O_ASSET_ID, raw(100), raw(75))], prices)
    expect(h2o.valueUsd).toBe(25 * 6)
    expect(h2o.uncounted).toEqual({ amount: raw(75), reason: 'pool-hub-reserve' })
  })

  it('carries no uncounted field on an ordinary row', () => {
    const out = valueAccountBalances([row(5, raw(10)), row(H2O_ASSET_ID, raw(3), '0')], prices)
    expect(out.map(b => b.valueUsd)).toEqual([40, 18])
    expect(out.every(b => !('uncounted' in b))).toBe(true)
  })

  it('leaves a whole-row exclusion out of the top holdings and the total they are measured against', () => {
    const balances = valueAccountBalances([row(H2O_ASSET_ID, raw(1_000_000), raw(1_000_000)), row(5, raw(50))], prices)
    // Without the rule the H2O row would dominate and the DOT row would fall
    // under the 10 % share threshold.
    expect(topHeldTokens(balances).map(t => [t.asset.assetId, t.valueUsd])).toEqual([[5, 200]])
  })
})

describe('foldShareBalances', () => {
  it('carries the uncounted slice through the display fold', () => {
    const balances = valueAccountBalances([row(H2O_ASSET_ID, raw(100), raw(100)), row(690, raw(1))], prices)
    const folded = foldShareBalances(balances)
    const h2o = folded.find(b => b.asset.assetId === H2O_ASSET_ID) as AddressBalance
    expect(h2o.uncounted).toEqual({ amount: raw(100), reason: 'pool-hub-reserve' })
    expect(h2o.valueUsd).toBe(0)
  })
})

// Every surface that states the account's value applies the rule; each is pinned
// where it lives so a rewrite of one cannot silently drop it.
describe('the rule reaches every value surface', () => {
  it('is in the aggregated balance read behind the account and tag pages and the hover cards', () => {
    expect(fn('queryAggregatedBalances')).toContain("poolOwnHubHoldingSql('account_id', 'asset_id')")
  })

  it('is in the directory ranking and its top-holding map, under a bumped model version', () => {
    const body = fn('accountsPage')
    expect([...body.matchAll(/poolOwnHubHoldingSql\('latest\.account_id', 'latest\.asset_id'\)/g)]).toHaveLength(2)
    const at = explorerService.indexOf('function accountDirectoryModelVersion(): string {')
    expect(at).toBeGreaterThan(-1)
    const version = explorerService.slice(at, explorerService.indexOf('\n}\n', at))
    expect(version).toContain("'v3-r5'")
    expect(version).not.toContain('-r3')
  })

  it('is in the value chart\'s balance walk, so the live-pinned last point agrees with its interior', () => {
    expect(fn('getAccountHistory')).toContain('isPoolOwnHubHolding(accountId, Number(id))')
  })
})
