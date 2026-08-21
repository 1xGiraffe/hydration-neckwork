import { describe, expect, it } from 'vitest'
import { PROTOCOL_REVENUE_PREDICATE_SQL, REVENUE_STREAMS } from '../src/services/revenueStreams.ts'
import { isProtocolRevenue } from '../src/services/revenueService.ts'

// `isProtocolRevenue` is a hand-written copy of the SQL predicate, used for the raw tail
// the dashboard splices onto the derived history. Two copies of one rule drift silently,
// and the drift shows up as a dashboard whose warm and cold arms disagree across the
// splice — so the copies are checked against each other over every combination that
// exists rather than trusted.
const DESTINATIONS = ['protocol', 'burned', 'lp', 'pol', 'unknown', ''] as const

// The predicate is plain SQL over two columns, so it can be evaluated directly.
function evaluateSql(stream: string, dest: string): boolean {
  const expr = PROTOCOL_REVENUE_PREDICATE_SQL
    .replaceAll('stream', JSON.stringify(stream))
    .replaceAll('dest', JSON.stringify(dest))
    .replace(/"([^"]*)" IN \(([^)]*)\)/g, (_m, v, list) => `[${list.replaceAll("'", '"')}].includes("${v}")`)
    .replaceAll('!=', '!==')
    .replaceAll(' AND ', ' && ')
    .replaceAll(' OR ', ' || ')
  return eval(expr) as boolean
}

describe('the TS twin of the protocol-revenue predicate', () => {
  it('agrees with the SQL for every stream and destination', () => {
    const disagreements: string[] = []
    for (const stream of REVENUE_STREAMS) {
      for (const dest of DESTINATIONS) {
        const sql = evaluateSql(stream, dest)
        const ts = isProtocolRevenue(stream, dest)
        if (sql !== ts) disagreements.push(`${stream}/${dest || '(empty)'}: sql=${sql} ts=${ts}`)
      }
    }
    expect(disagreements).toEqual([])
  })

  // Guards the specific correction: a fee left with the pool is not the protocol's,
  // whichever of the two omnipool fee streams recorded it.
  it('rejects a pool-retained leg on both fee streams', () => {
    expect(isProtocolRevenue('omnipool_protocol_fee', 'lp')).toBe(false)
    expect(isProtocolRevenue('omnipool_asset_fee', 'lp')).toBe(false)
  })

  it('accepts a leg retained in the protocol-provided HDX position', () => {
    expect(isProtocolRevenue('omnipool_protocol_fee', 'pol')).toBe(true)
    expect(isProtocolRevenue('omnipool_asset_fee', 'pol')).toBe(true)
  })
})
