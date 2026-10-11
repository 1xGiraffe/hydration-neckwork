import { describe, expect, it } from 'vitest'
import {
  cadenceDueMarkets,
  MoneyMarketHolderIndex,
  openHoldersOfPool,
  openPositionKey,
  planTriggerReads,
  RAY,
  scaledLegsFromLog,
  triggerEvidence,
} from '../../src/raw/moneyMarketSnapshot.ts'
import { crossedChainTimeBoundary } from '../../src/util/chainTimeCadence.ts'

const POOL = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const GIGA = '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923'
const DOT = '0x0000000000000000000000000000000100000005'
const USDT = '0x000000000000000000000000000000010000000a'
const A_DOT = '0x02639ec01313c8775fae74f2dad1118c8a8a86da'
const V_DOT = '0x34321cb7334807eb718b3e1ddfaeb0c6c0403f1a'
const A_USDT = '0xc64980e4eaf9a1151bd21712b9946b81e41e2b92'
const ALICE = '0xa11ce00000000000000000000000000000000001'
const BOB = '0xb0b0000000000000000000000000000000000002'
const INDEX = 1_100_000_000_000_000_000_000_000_000n // 1.1 RAY

function log(contract: string, event: 'Mint' | 'Burn' | 'BalanceTransfer' | 'Supply', args: Record<string, string>) {
  return { contract_address: contract, event_name: event, decoded_args_json: JSON.stringify(args), decode_status: 'decoded' }
}
const rayDiv = (a: bigint, b: bigint) => (a * RAY + b / 2n) / b

describe('scaled legs (atoken_scaled_deltas_mv arithmetic)', () => {
  it('credits a Mint to onBehalfOf with (value − balanceIncrease)/index, half up', () => {
    expect(scaledLegsFromLog(log(A_DOT, 'Mint', { caller: BOB, onBehalfOf: ALICE, value: '1100', balanceIncrease: '100', index: INDEX.toString() })))
      .toEqual([{ contract: A_DOT, holder: ALICE, delta: rayDiv(1000n, INDEX) }])
  })

  it('debits a Mint whose interest exceeds the amount (Aave mints the difference on a small burn)', () => {
    expect(scaledLegsFromLog(log(A_DOT, 'Mint', { caller: ALICE, onBehalfOf: ALICE, value: '40', balanceIncrease: '100', index: INDEX.toString() })))
      .toEqual([{ contract: A_DOT, holder: ALICE, delta: -rayDiv(60n, INDEX) }])
  })

  it('debits a Burn from `from` by (value + balanceIncrease)/index', () => {
    expect(scaledLegsFromLog(log(V_DOT, 'Burn', { from: ALICE, target: ALICE, value: '900', balanceIncrease: '100', index: INDEX.toString() })))
      .toEqual([{ contract: V_DOT, holder: ALICE, delta: -rayDiv(1000n, INDEX) }])
  })

  it('moves a BalanceTransfer\'s scaled value from `from` to `to`', () => {
    expect(scaledLegsFromLog(log(A_DOT, 'BalanceTransfer', { from: ALICE, to: BOB, value: '77', index: INDEX.toString() })))
      .toEqual([{ contract: A_DOT, holder: BOB, delta: 77n }, { contract: A_DOT, holder: ALICE, delta: -77n }])
  })

  it('yields nothing for other events, undecoded logs or unparsable args', () => {
    expect(scaledLegsFromLog(log(A_DOT, 'Supply', { user: ALICE, value: '1' }))).toEqual([])
    expect(scaledLegsFromLog({ ...log(A_DOT, 'Mint', { onBehalfOf: ALICE, value: '1' }), decode_status: 'undecoded' })).toEqual([])
    expect(scaledLegsFromLog({ contract_address: A_DOT, event_name: 'Mint', decoded_args_json: 'not json' })).toEqual([])
  })
})

describe('the reserve holder index', () => {
  const market = (index: MoneyMarketHolderIndex) => index.setMarket(POOL, [
    { reserve: DOT, tokens: [A_DOT, V_DOT] },
    { reserve: USDT, tokens: [A_USDT, '0x0000000000000000000000000000000000000000'] },
  ])

  it('exact: a holder holds a reserve while its aToken or debt balance is non-zero', () => {
    const index = new MoneyMarketHolderIndex('exact')
    market(index)
    index.seedBalances([{ contract: A_DOT.toUpperCase().replace('0X', '0x'), holder: ALICE, scaled: 500n }])
    expect(index.holdersOfReserve(POOL, DOT, 10)).toEqual([ALICE])
    // Bob borrows DOT: a debt-token Mint makes him a DOT holder.
    index.apply([log(V_DOT, 'Mint', { caller: BOB, onBehalfOf: BOB, value: '1000', balanceIncrease: '0', index: RAY.toString() })], 11)
    expect(index.holdersOfReserve(POOL, DOT, 11)).toEqual([ALICE, BOB])
    expect(index.holdersOfMarket(POOL, 11)).toEqual([ALICE, BOB])
    // Alice sends her whole aDOT to Bob: she no longer holds DOT, Bob holds both legs.
    index.apply([log(A_DOT, 'BalanceTransfer', { from: ALICE, to: BOB, value: '500', index: RAY.toString() })], 12)
    expect(index.holdersOfReserve(POOL, DOT, 12)).toEqual([BOB])
    expect(index.scaledBalance(A_DOT, ALICE)).toBe(0n)
    expect(index.holdersOfReserve(POOL, USDT, 12)).toEqual([])
    expect(index.negativeBalances).toBe(0)
  })

  it('exact: folds every contract, so a reserve declared later finds its holders already there', () => {
    const index = new MoneyMarketHolderIndex('exact')
    index.apply([log(A_USDT, 'Mint', { caller: ALICE, onBehalfOf: ALICE, value: '5', balanceIncrease: '0', index: RAY.toString() })], 5)
    expect(index.holdersOfReserve(POOL, USDT, 5)).toEqual([])
    market(index)
    expect(index.holdersOfReserve(POOL, USDT, 5)).toEqual([ALICE])
  })

  it('exact: counts a leg that drives a balance negative (a fold the chain disagrees with) and excludes it', () => {
    const index = new MoneyMarketHolderIndex('exact')
    market(index)
    index.apply([log(A_DOT, 'Burn', { from: ALICE, target: ALICE, value: '1', balanceIncrease: '0', index: RAY.toString() })], 1)
    expect(index.negativeBalances).toBe(1)
    expect(index.holdersOfReserve(POOL, DOT, 1)).toEqual([])
  })

  it('names the pools a reserve token belongs to, never the zero address of a reserve without debt token', () => {
    const index = new MoneyMarketHolderIndex('exact')
    market(index)
    index.setMarket(GIGA, [{ reserve: USDT, tokens: [A_USDT] }])
    expect(index.poolsOfToken(A_DOT.toUpperCase().replace('0X', '0x'))).toEqual([POOL])
    expect(index.poolsOfToken(A_USDT).sort()).toEqual([POOL, GIGA].sort())
    expect(index.poolsOfToken('0x0000000000000000000000000000000000000000')).toEqual([])
    expect(index.poolsOfToken(DOT)).toEqual([])
  })

  it('superset: every account ever credited, from the first block it is known at, never removed', () => {
    const index = new MoneyMarketHolderIndex('superset')
    market(index)
    index.seedHolders([{ contract: A_DOT, holder: ALICE, firstBlock: 100 }])
    index.apply([log(V_DOT, 'Mint', { caller: BOB, onBehalfOf: BOB, value: '1', balanceIncrease: '0', index: RAY.toString() })], 50)
    expect(index.holdersOfReserve(POOL, DOT, 60)).toEqual([BOB])
    expect(index.holdersOfReserve(POOL, DOT, 100)).toEqual([ALICE, BOB])
    // A full exit keeps the holder: a superset only ever over-reads.
    index.apply([log(V_DOT, 'Burn', { from: BOB, target: BOB, value: '1', balanceIncrease: '0', index: RAY.toString() })], 70)
    expect(index.holdersOfReserve(POOL, DOT, 100)).toEqual([ALICE, BOB])
    // An earlier credit lowers the first block.
    index.apply([log(A_DOT, 'Mint', { caller: ALICE, onBehalfOf: ALICE, value: '1', balanceIncrease: '0', index: RAY.toString() })], 20)
    expect(index.holdersOfReserve(POOL, DOT, 20)).toEqual([ALICE])
  })
})

describe('the trigger cadence', () => {
  const markets = [{ key: 'core', pool: POOL }, { key: 'gigahdx', pool: GIGA }]
  const cadence = { allMinutes: 60, marketMinutes: { gigahdx: 5 } }
  const at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 10, h, m, s)

  it('fires every market on the first block past an hour, GIGAHDX also past every 5 minutes', () => {
    expect([...cadenceDueMarkets(at(9, 59, 58), at(10, 0, 0), markets, cadence, crossedChainTimeBoundary)]).toEqual([POOL, GIGA])
    expect([...cadenceDueMarkets(at(10, 4, 58), at(10, 5, 0), markets, cadence, crossedChainTimeBoundary)]).toEqual([GIGA])
    expect([...cadenceDueMarkets(at(10, 5, 0), at(10, 5, 2), markets, cadence, crossedChainTimeBoundary)]).toEqual([])
  })

  it('cannot fire without the previous block\'s timestamp, and a zero interval never fires', () => {
    expect(cadenceDueMarkets(null, at(10, 0, 0), markets, cadence, crossedChainTimeBoundary).size).toBe(0)
    expect(cadenceDueMarkets(at(9, 59, 58), at(10, 0, 0), markets, { allMinutes: 0, marketMinutes: {} }, crossedChainTimeBoundary).size).toBe(0)
  })
})

describe('trigger read planning', () => {
  const base = {
    pools: [POOL, GIGA],
    configChanged: new Set<string>(),
    steps: new Map<string, string[]>(),
    cadenceDue: new Set<string>(),
    holdersOfReserve: (_pool: string, reserve: string) => (reserve === DOT ? [ALICE, BOB] : [BOB]),
    holdersOfMarket: () => [ALICE, BOB],
    cadenceCohort: (pool: string) => (pool === POOL ? [ALICE] : [BOB]),
    alreadyRead: new Set<string>(),
  }

  it('reads every holder of a stepped reserve once, naming the reserves it holds', () => {
    const plan = planTriggerReads({ ...base, steps: new Map([[POOL, [DOT, USDT]]]) })
    expect([...plan.keys()]).toEqual([POOL])
    const reads = plan.get(POOL)!
    expect([...reads.keys()].sort()).toEqual([ALICE, BOB])
    expect(triggerEvidence(reads.get(BOB)!)).toEqual({ trigger: 'price_step', reserves: [DOT, USDT] })
    expect(triggerEvidence(reads.get(ALICE)!)).toEqual({ trigger: 'price_step', reserves: [DOT] })
  })

  it('leaves out pairs the block\'s own events already read', () => {
    const plan = planTriggerReads({ ...base, steps: new Map([[POOL, [DOT]]]), alreadyRead: new Set([openPositionKey(POOL, ALICE)]) })
    expect([...plan.get(POOL)!.keys()]).toEqual([BOB])
  })

  it('a config change reads the market\'s holders and open positions; cadence the cohort; one entry per user', () => {
    const plan = planTriggerReads({ ...base, configChanged: new Set([GIGA]), cadenceDue: new Set([POOL, GIGA]), steps: new Map([[GIGA, [USDT]]]) })
    expect([...plan.get(POOL)!.keys()]).toEqual([ALICE])
    expect(triggerEvidence(plan.get(POOL)!.get(ALICE)!)).toEqual({ trigger: 'cadence' })
    const giga = plan.get(GIGA)!
    expect([...giga.keys()].sort()).toEqual([ALICE, BOB])
    expect(triggerEvidence(giga.get(BOB)!)).toEqual({ trigger: 'config', triggers: ['config', 'price_step', 'cadence'], reserves: [USDT] })
    expect(triggerEvidence(giga.get(ALICE)!)).toEqual({ trigger: 'config' })
  })

  it('plans nothing on a quiet block', () => {
    expect(planTriggerReads(base).size).toBe(0)
  })

  it('lists one pool\'s open holders from the open-position set', () => {
    const open = new Set([openPositionKey(POOL, BOB), openPositionKey(GIGA, ALICE), openPositionKey(POOL, ALICE)])
    expect(openHoldersOfPool(open, POOL.toUpperCase().replace('0X', '0x'))).toEqual([ALICE, BOB])
  })
})
