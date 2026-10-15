import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CAP_FULL_BPS, CAP_OPEN_BPS, capIsFull, reserveCaps,
  type CapEventRow, type FacilitatorRow,
} from '../src/services/moneyMarketCaps.ts'

// The shared money-market cap model: the pure composition of configurator cap
// events, HOLLAR facilitator capacities and the reserve list into raw-unit caps
// (what /lending/v1/caps ships as whole tokens and the cap alert watches), and
// the full/open hysteresis the alert reads a reserve's headroom through.

const E18 = 10n ** 18n

describe('capIsFull', () => {
  const cap = 500_000n * E18

  it('reads a reserve at or over its cap as full', () => {
    expect(capIsFull(null, cap, cap)).toBe(true)
    // Interest accrual carries borrowing past a facilitator cap.
    expect(capIsFull(null, cap + 3_084n * E18, cap)).toBe(true)
    // One basis point of headroom is nothing anybody can borrow.
    expect(capIsFull(null, cap - cap / 10_000n, cap)).toBe(true)
  })

  it('reads a reserve with room as open', () => {
    expect(capIsFull(null, cap / 2n, cap)).toBe(false)
    expect(capIsFull(null, cap - cap / 100n, cap)).toBe(false)
  })

  it('holds the previous state inside the band so a cap oscillating on the line does not flap', () => {
    // 25 bps of headroom: above the full line, below the open line.
    const inBand = cap - (cap * 25n) / 10_000n
    expect(CAP_FULL_BPS).toBeLessThan(25)
    expect(CAP_OPEN_BPS).toBeGreaterThan(25)
    expect(capIsFull(true, inBand, cap)).toBe(true)
    expect(capIsFull(false, inBand, cap)).toBe(false)
    // First sight inside the band: not full, so the first fill is still news.
    expect(capIsFull(null, inBand, cap)).toBe(false)
  })

  it('has no state for an uncapped reserve', () => {
    // Aave's 0 is "no cap", not a freeze; null is a cap never set.
    expect(capIsFull(null, cap, 0n)).toBeNull()
    expect(capIsFull(true, cap, null)).toBeNull()
  })

  // A HOLLAR facilitator bucket has no zero exemption: capacity 0 is how a
  // facilitator is wound down, and nothing can be minted against it.
  it('reads a facilitator bucket of zero as full, not as uncapped', () => {
    expect(capIsFull(null, 400_000n * E18, 0n, false)).toBe(true)
    expect(capIsFull(null, 0n, 0n, false)).toBe(true)
    expect(capIsFull(false, 1n, 0n, false)).toBe(true)
  })
})

describe('reserveCaps', () => {
  const CORE = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
  const GIGA = '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923'
  const HOLLAR = '0x531a654d1696ed52e7275a8cede955e82620f99a'
  const DOT = '0x0000000000000000000000000000000100000005'
  const reserves = [
    { poolAddress: CORE, reserveAddress: HOLLAR, aTokenAddress: '0xa0', decimals: 18 },
    { poolAddress: GIGA, reserveAddress: HOLLAR, aTokenAddress: '0xa1', decimals: 18 },
    { poolAddress: CORE, reserveAddress: DOT, aTokenAddress: '0xa2', decimals: 10 },
  ]
  const event = (kind: CapEventRow['kind'], configurator: string, asset: string, cap: string, atoken = ''): CapEventRow =>
    ({ configurator, kind, asset, atoken, new_cap: cap, block_height: 1, block_timestamp: '' })
  const facilitator = (address: string, capacity: bigint): FacilitatorRow =>
    ({ facilitator: address, capacity: capacity.toString(), last_block: 1, last_time: '' })

  it('attributes configurator caps through initializations and scales them to raw units', () => {
    const caps = reserveCaps(reserves, [
      event('init', '0xcfg', DOT, '0', '0xa2'),
      event('borrow', '0xcfg', DOT, '17000000'),
      event('supply', '0xcfg', DOT, '25000000'),
      // A later change overrides an earlier one.
      event('supply', '0xcfg', DOT, '30000000'),
    ], [])
    expect(caps.get(`${CORE}:${DOT}`)).toEqual({
      borrowCap: 17_000_000n * 10n ** 10n, borrowCapSource: 'poolConfigurator', supplyCap: 30_000_000n * 10n ** 10n,
    })
    expect(caps.get(`${CORE}:${HOLLAR}`)).toEqual({ borrowCap: null, borrowCapSource: null, supplyCap: null })
  })

  it('takes a facilitator bucket as the borrow cap of the market whose aToken it is', () => {
    const caps = reserveCaps(reserves, [], [
      facilitator('0xa0', 12_000_000n * E18),
      facilitator('0xa1', 500_000n * E18),
      // The HSM pallet mints HOLLAR outside every market.
      facilitator('0xdead', 1n * E18),
    ])
    expect(caps.get(`${CORE}:${HOLLAR}`)).toEqual({ borrowCap: 12_000_000n * E18, borrowCapSource: 'facilitator', supplyCap: null })
    expect(caps.get(`${GIGA}:${HOLLAR}`)).toEqual({ borrowCap: 500_000n * E18, borrowCapSource: 'facilitator', supplyCap: null })
  })

  it('keeps Aave’s 0 sentinel as a zero cap rather than dropping it', () => {
    const caps = reserveCaps(reserves, [event('init', '0xcfg', DOT, '0', '0xa2'), event('supply', '0xcfg', DOT, '0')], [])
    expect(caps.get(`${CORE}:${DOT}`)?.supplyCap).toBe(0n)
  })

  it('leaves a cap on a shared asset alone when no initialization ties the configurator to a market', () => {
    const caps = reserveCaps(reserves, [event('borrow', '0xorphan', HOLLAR, '1')], [])
    expect(caps.get(`${CORE}:${HOLLAR}`)?.borrowCap).toBeNull()
    expect(caps.get(`${GIGA}:${HOLLAR}`)?.borrowCap).toBeNull()
  })

  // An Aave cap is whole tokens and needs the asset's decimals to compare with
  // a raw balance. A reserve the registry does not know has no decimals to
  // scale by, so its configurator caps are withheld rather than guessed — a
  // facilitator capacity is already raw and stays.
  it('withholds a whole-token cap for a reserve whose decimals are unknown', () => {
    const unknown = [{ poolAddress: CORE, reserveAddress: DOT, aTokenAddress: '0xa2', decimals: null }, reserves[0]]
    const caps = reserveCaps(unknown, [
      event('init', '0xcfg', DOT, '0', '0xa2'), event('borrow', '0xcfg', DOT, '17000000'), event('supply', '0xcfg', DOT, '25000000'),
    ], [facilitator('0xa0', 12_000_000n * E18)])
    expect(caps.get(`${CORE}:${DOT}`)).toEqual({ borrowCap: null, borrowCapSource: null, supplyCap: null })
    expect(caps.get(`${CORE}:${HOLLAR}`)?.borrowCap).toBe(12_000_000n * E18)
  })
})

describe('readReserveStateRows', () => {
  // A fake client answering by marker, recording each statement's parameters.
  function client(answers: { bounds: Array<{ anchor: number; head: number }>; rows: Array<Array<Record<string, unknown>>> }) {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> = []
    let boundsAt = 0, rowsAt = 0
    return {
      calls,
      query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
        calls.push({ query, params: query_params })
        const rows = query.includes('-- mm:reserve-cold:bounds') ? [answers.bounds[Math.min(boundsAt++, answers.bounds.length - 1)]]
          : query.includes('-- mm:reserve-cold:scaled') ? [{ contract: '0xa', scaled: '5' }]
          : query.includes('-- mm:reserve-cold:indices') ? [{ pool_address: '0xp', reserve_address: '0xr', li: '1', vbi: '2', bh: 90, bts: '2026-10-15 00:00:00' }]
          : query.includes('-- mm:reserve-state') ? answers.rows[Math.min(rowsAt++, answers.rows.length - 1)]
          : []
        return { json: async () => rows }
      },
    }
  }
  const row = (anchor: number) => ({ pool_address: '0xp', reserve_address: '0xr', market_key: 'core', atoken: '0xa', block_height: 99, block_timestamp: '2026-10-15 00:00:00', supplied: '1', debt: '0', listed: 1, state_anchor: anchor })

  it('hands the cold part in as parameters, reads only above its cut, and strips the anchor', async () => {
    const { readReserveStateRows } = await import('../src/services/moneyMarketCaps.ts')
    const c = client({ bounds: [{ anchor: 10, head: 1_000 }], rows: [[row(10)]] })
    const rows = await readReserveStateRows(c as never)
    const { state_anchor: _anchor, ...expected } = row(10)
    expect(rows).toEqual([expected])
    const main = c.calls.find(x => x.query.includes('-- mm:reserve-state'))!
    expect(main.params).toMatchObject({ cut: 850, cold_contracts: ['0xa'], cold_scaled: ['5'], cold_blocks: [90] })
    const cold = c.calls.find(x => x.query.includes('-- mm:reserve-cold:scaled'))!
    expect(cold.params).toEqual({ anchor: 10, cut: 850 })
  })

  it('rebuilds the cold part when the statement sees another anchor', async () => {
    const { readReserveStateRows } = await import('../src/services/moneyMarketCaps.ts')
    const c = client({ bounds: [{ anchor: 10, head: 1_000 }, { anchor: 20, head: 1_000 }], rows: [[row(20)], [row(20)]] })
    await readReserveStateRows(c as never)
    expect(c.calls.filter(x => x.query.includes('-- mm:reserve-cold:scaled')).map(x => x.params?.anchor)).toEqual([10, 20])
    expect(c.calls.filter(x => x.query.includes('-- mm:reserve-state')).length).toBe(2)
  })

  it('takes the tail holders from every party the delta view writes a row under', () => {
    // The tail's (contract, holder) prefixes are the parties of the logs above the
    // cut; a holder the materialized view keys a delta under that the candidate set
    // misses would drop that delta from the total.
    const mv = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')
      .split('\n').find(line => line.includes('atoken_scaled_deltas_by_contract_mv'))!
    const parties = [...mv.matchAll(/JSONExtractString\(ar, '(\w+)'\)/g)].map(m => m[1]).filter(k => ['onBehalfOf', 'from', 'to'].includes(k))
    expect(new Set(parties)).toEqual(new Set(['onBehalfOf', 'from', 'to']))
    const source = readFileSync(new URL('../src/services/moneyMarketCaps.ts', import.meta.url), 'utf8')
    expect(source).toContain("ARRAY JOIN ['onBehalfOf', 'from', 'to'] AS party")
    expect(mv).toContain("WHERE (event_name IN ('Mint', 'Burn', 'BalanceTransfer'))")
    expect(source).toContain("raw_evm_logs.event_name IN ('Mint', 'Burn', 'BalanceTransfer')")
  })
})
