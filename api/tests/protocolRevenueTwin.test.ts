import { describe, expect, it } from 'vitest'
import { PROTOCOL_REVENUE_PREDICATE_SQL, REVENUE_STREAMS } from '../src/services/revenueStreams.ts'
import { isProtocolRevenue } from '../src/services/revenueService.ts'

// `isProtocolRevenue` is a hand-written copy of the SQL predicate, used for the raw tail
// the dashboard splices onto the derived history. Two copies of one rule drift silently,
// and the drift shows up as a dashboard whose warm and cold arms disagree across the
// splice — so the copies are checked against each other over every combination that
// exists rather than trusted.
const DESTINATIONS = ['protocol', 'burned', 'lp', 'pol', 'unknown', ''] as const

// The predicate is plain SQL over three columns, so it can be evaluated directly.
function evaluateSql(stream: string, dest: string, internalPayer = 0): boolean {
  const expr = PROTOCOL_REVENUE_PREDICATE_SQL
    .replaceAll('internal_payer', String(internalPayer))
    .replaceAll('stream', JSON.stringify(stream))
    .replaceAll('dest', JSON.stringify(dest))
    .replace(/"([^"]*)" IN \(([^)]*)\)/g, (_m, v, list) => `[${list.replaceAll("'", '"')}].includes("${v}")`)
    .replaceAll('!=', '!==')
    .replaceAll(/(?<![!=<>])=(?!=)/g, '===')
    .replaceAll(' AND ', ' && ')
    .replaceAll(' OR ', ' || ')
  return eval(expr) as boolean
}

describe('the TS twin of the protocol-revenue predicate', () => {
  it('agrees with the SQL for every stream and destination', () => {
    const disagreements: string[] = []
    for (const stream of REVENUE_STREAMS) {
      for (const dest of DESTINATIONS) {
        // Including the payer dimension: revenue the protocol paid itself is
        // excluded by both copies, or the splice disagrees across it too.
        for (const internal of [0, 1]) {
          const sql = evaluateSql(stream, dest, internal)
          const ts = isProtocolRevenue(stream, dest, internal)
          if (sql !== ts) disagreements.push(`${stream}/${dest || '(empty)'}/${internal}: sql=${sql} ts=${ts}`)
        }
      }
    }
    expect(disagreements).toEqual([])
  })

  // A fee the pool keeps for its LPs is not the protocol's, whichever of the two
  // omnipool fee streams recorded it.
  it('rejects a pool-retained leg on both fee streams', () => {
    expect(isProtocolRevenue('omnipool_protocol_fee', 'lp')).toBe(false)
    expect(isProtocolRevenue('omnipool_asset_fee', 'lp')).toBe(false)
  })

  it('accepts a leg retained in the protocol-provided HDX position', () => {
    expect(isProtocolRevenue('omnipool_protocol_fee', 'pol')).toBe(true)
    expect(isProtocolRevenue('omnipool_asset_fee', 'pol')).toBe(true)
  })
})
