import { describe, expect, it } from 'vitest'
import {
  INTERNAL_PAYER_TAGS,
  PROTOCOL_REVENUE_PREDICATE_SQL,
  REVENUE_EVENT_COLUMNS,
  REVENUE_STREAMS,
  internalPayerAccountsSql,
  internalPayerFlagSql,
} from '../src/services/revenueStreams.ts'
import { isProtocolRevenue } from '../src/services/revenueService.ts'

// Revenue the protocol pays itself is not revenue. The treasury borrowing HOLLAR
// and paying interest on it moves money from one protocol pocket to another, so
// it belongs in neither the totals nor anybody's payer ranking — the rows are
// kept and marked, never dropped, so the gross flow stays auditable.
const evaluate = (row: { stream: string; dest: string; internal_payer: number }): boolean => {
  const expr = PROTOCOL_REVENUE_PREDICATE_SQL
    .replaceAll('internal_payer', String(row.internal_payer))
    .replaceAll('stream', JSON.stringify(row.stream))
    .replaceAll('dest', JSON.stringify(row.dest))
    .replaceAll('!=', '!==')
    .replaceAll(/(?<![!=<>])=(?!=)/g, '===')
    .replace(/"([^"]*)" IN \(([^)]*)\)/g, (_m, v, list) => `[${list}].includes("${v}")`)
    .replaceAll("'", '"')
    .replaceAll(' AND ', ' && ')
    .replaceAll(' OR ', ' || ')
  return eval(expr) as boolean
}

describe('which accounts are the protocol paying itself', () => {
  it('names the treasury and the protocol multisig', () => {
    expect(INTERNAL_PAYER_TAGS).toContain('treasury')
    expect(INTERNAL_PAYER_TAGS).toContain('hydration-multisig')
  })

  it('leaves the HOLLAR Stability Module out — it EARNS a stream, it does not pay one', () => {
    // hsm_revenue is booked with account = '' (the HSM is the source, never the
    // payer). Listing the account that generates a stream among the accounts to
    // exclude is how a future attribution change would delete real revenue.
    expect(INTERNAL_PAYER_TAGS).not.toContain('hollar-stability-module')
  })

  it('leaves pools and money-market contracts out — a fee routed through them is a USER’s fee', () => {
    for (const tag of ['xyk-pools', 'stableswap-pools', 'lbp-pools', 'omnipool', 'liquidity-mining', 'money-market']) {
      expect(INTERNAL_PAYER_TAGS).not.toContain(tag)
    }
  })

  it('leaves other chains’ treasuries and third parties out — that is external money', () => {
    for (const tag of ['polkadot-treasury', 'moonbeam-treasury', 'polkadot-fellowship', 'kraken', 'bil-originator']) {
      expect(INTERNAL_PAYER_TAGS).not.toContain(tag)
    }
  })
})

describe('matching an internal payer', () => {
  const sql = internalPayerAccountsSql()

  it('reads the tag membership with FINAL, so a removed member is really removed', () => {
    expect(sql).toContain('price_data.account_tags')
    expect(sql).toContain('FINAL')
    expect(sql).toContain('deleted = 0')
  })

  it('matches the ETH-mapped twin as well as the substrate id', () => {
    // The treasury pays as 0x45544800d64be7d51f… — its truncated-H160 form — while
    // the tag holds 0xd64be7d51f…; a join on the substrate id alone reports $0.
    expect(sql).toContain("concat('0x45544800', substring(account_id, 3, 40), repeat('0', 16))")
  })

  it('flags a row by its payer', () => {
    expect(internalPayerFlagSql('account')).toContain('account IN (')
    expect(internalPayerFlagSql('account')).toMatch(/^toUInt8\(/)
  })
})

describe('protocol revenue excludes what the protocol paid itself', () => {
  it('drops an internal payer’s row from every stream that would otherwise count', () => {
    for (const stream of REVENUE_STREAMS) {
      for (const dest of ['', 'protocol', 'burned', 'pol']) {
        expect(evaluate({ stream, dest, internal_payer: 1 })).toBe(false)
      }
    }
  })

  it('leaves an external payer’s row exactly as it was', () => {
    expect(evaluate({ stream: 'network_fee', dest: '', internal_payer: 0 })).toBe(true)
    expect(evaluate({ stream: 'omnipool_asset_fee', dest: 'pol', internal_payer: 0 })).toBe(true)
    expect(evaluate({ stream: 'omnipool_asset_fee', dest: 'lp', internal_payer: 0 })).toBe(false)
  })

  it('keeps the TS twin in step over every combination', () => {
    for (const stream of REVENUE_STREAMS) {
      for (const dest of ['', 'protocol', 'burned', 'pol', 'lp', 'unknown', 'accrued']) {
        for (const internal of [0, 1]) {
          expect(isProtocolRevenue(stream, dest, internal), `${stream}/${dest}/${internal}`)
            .toBe(evaluate({ stream, dest, internal_payer: internal }))
        }
      }
    }
  })

  it('carries the flag as a column every builder emits', () => {
    expect(REVENUE_EVENT_COLUMNS).toContain('internal_payer')
  })
})
