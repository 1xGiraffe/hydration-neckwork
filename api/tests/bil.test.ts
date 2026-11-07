import { describe, expect, it } from 'vitest'
import {
  BIL_ATOKEN, BIL_HOLLAR_CONTRACT, BIL_TOPIC, BIL_VAULT, BIL_ZAP, DECENTRAL_POOL,
  BIL_ACTIONS, BIL_ACTION_ASSETS, BIL_ACTION_RULES, BIL_ASSET_ID, BIL_HOLLAR_ASSET_ID, UBIL_ASSET_ID,
  bilAccruingShares, bilActionOf, bilActionRowSql, bilBeneficialBalances, bilControllerClaims, bilExpectedWindow, bilFirstInvestmentBlock,
  bilHoldingHollar, bilHoldings, bilPositionPayout, bilPositions, bilProcessingDelays, bilProcessingStats, bilQueueCoverage, bilRateObservations,
  bilRealizedApyPct, bilRequestStatus, bilRequests, bilRowAssets, bilYieldRateSum, decentralBorrowers, decodeBilLog, withPositionTerms,
  type BilEvent, type BilLogRow, type BilPosition,
} from '../src/services/bil.ts'
import { checkChainRequests, openRequestIds } from '../src/services/bilState.ts'
import { mmStrategyPlumbingExclusionSql } from '../src/services/explorerService.ts'
import { withDerivedSharePrices, withStrategySharePrices } from '../src/services/strategySharePrice.ts'

const WAD = 10n ** 18n
const word = (v: bigint | number | string) => (typeof v === 'string' ? v.slice(2).toLowerCase() : BigInt(v).toString(16)).padStart(64, '0')
const addrTopic = (a: string) => '0x' + word(a)
const numTopic = (n: number) => '0x' + word(n)
let ei = 0
function log(contract: string, topic0: string, topics: string[], data: Array<bigint | number | string>, block = 100, extrinsic = 1, ts = '2026-10-01 00:00:00'): BilLogRow {
  return { block_height: block, event_index: ei++, extrinsic_index: extrinsic, ts, contract_address: contract, topic0, topics: [topic0, ...topics], data: '0x' + data.map(word).join('') }
}
const dec = (r: BilLogRow) => decodeBilLog(r)!
const ALICE = '0x00000000000000000000000000000000000a11ce'
const BOB = '0x0000000000000000000000000000000000000b0b'
const BORROWER = '0x2333aa052610012c27e4fc176bc27095651dcbc6'

describe('decodeBilLog', () => {
  it('names a zapped deposit\'s depositor, and the vault\'s own half as no row', () => {
    const zap = dec(log(BIL_ZAP, BIL_TOPIC.DepositAndSupply, [addrTopic(ALICE)], [1000n * WAD, 950n * WAD]))
    expect(zap).toMatchObject({ name: 'DepositAndSupply', party: ALICE, hollar: (1000n * WAD).toString(), shares: (950n * WAD).toString() })
    const vaultHalf = dec(log(BIL_VAULT, BIL_TOPIC.Deposited, [addrTopic(BIL_ZAP)], [1000n * WAD, 950n * WAD, 7]))
    expect(bilActionOf(zap, new Set(), null)).toBe('Deposit')
    expect(bilActionOf(vaultHalf, new Set(), null)).toBeNull()
    const direct = dec(log(BIL_VAULT, BIL_TOPIC.Deposited, [addrTopic(BOB)], [10n * WAD, 9n * WAD, 8]))
    expect(bilActionOf(direct, new Set(), null)).toBe('Deposit')
  })

  it('reads a request\'s controller, owner and id, and a settlement\'s partial flag', () => {
    const req = dec(log(BIL_VAULT, BIL_TOPIC.RedeemRequest, [addrTopic(BOB), addrTopic(ALICE), numTopic(4)], [ALICE, 5n * WAD]))
    expect(req).toMatchObject({ controller: BOB, owner: ALICE, party: ALICE, requestId: 4, sender: ALICE, shares: (5n * WAD).toString() })
    const part = dec(log(BIL_VAULT, BIL_TOPIC.RedemptionPartiallyFulfilled, [numTopic(4), addrTopic(BOB)], [3n * WAD, 2n * WAD]))
    expect(part).toMatchObject({ name: 'RedemptionPartiallyFulfilled', partial: true, controller: BOB, requestId: 4 })
    const claim = dec(log(BIL_VAULT, BIL_TOPIC.Withdraw, [addrTopic(ALICE), addrTopic(ALICE), addrTopic(BOB)], [3n * WAD, 2n * WAD]))
    expect(claim).toMatchObject({ controller: BOB, receiver: ALICE, party: BOB })
  })

  it('makes a pool transfer a draw or repayment only for a borrower, and only from the vault\'s first investment', () => {
    const borrowed = dec(log(DECENTRAL_POOL, BIL_TOPIC.Borrowed, [addrTopic(BORROWER)], [1n]))
    const invest = dec(log(DECENTRAL_POOL, BIL_TOPIC.PoolDeposited, [addrTopic(BIL_VAULT), numTopic(1)], [100n], 200))
    const borrowers = decentralBorrowers([borrowed])
    const since = bilFirstInvestmentBlock([invest])
    expect(since).toBe(200)
    const draw = dec(log(BIL_HOLLAR_CONTRACT, BIL_TOPIC.Transfer, [addrTopic(DECENTRAL_POOL), addrTopic(BORROWER)], [5n], 300))
    const repay = dec(log(BIL_HOLLAR_CONTRACT, BIL_TOPIC.Transfer, [addrTopic(BORROWER), addrTopic(DECENTRAL_POOL)], [5n], 300))
    const early = dec(log(BIL_HOLLAR_CONTRACT, BIL_TOPIC.Transfer, [addrTopic(DECENTRAL_POOL), addrTopic(BORROWER)], [5n], 150))
    const stranger = dec(log(BIL_HOLLAR_CONTRACT, BIL_TOPIC.Transfer, [addrTopic(ALICE), addrTopic(DECENTRAL_POOL)], [5n], 300))
    expect(draw.party).toBe(BORROWER)
    expect(bilActionOf(draw, borrowers, since)).toBe('Draw')
    expect(bilActionOf(repay, borrowers, since)).toBe('Repay')
    expect(bilActionOf(early, borrowers, since)).toBeNull()
    expect(bilActionOf(stranger, borrowers, since)).toBeNull()
  })

  it('ignores a topic outside its contract', () => {
    expect(decodeBilLog(log(BIL_ZAP, BIL_TOPIC.Withdraw, [addrTopic(ALICE), addrTopic(ALICE), addrTopic(ALICE)], [1n, 1n]))).toBeNull()
    expect(decodeBilLog(log(BIL_VAULT, '0xdeadbeef', [], []))).toBeNull()
  })
})

describe('the redemption queue', () => {
  const events: BilEvent[] = [
    dec(log(BIL_VAULT, BIL_TOPIC.RedeemRequest, [addrTopic(ALICE), addrTopic(ALICE), numTopic(0)], [ALICE, 10n * WAD], 10)),
    dec(log(BIL_VAULT, BIL_TOPIC.RedeemRequest, [addrTopic(BOB), addrTopic(BOB), numTopic(1)], [BOB, 4n * WAD], 11)),
    dec(log(BIL_VAULT, BIL_TOPIC.RedeemRequest, [addrTopic(BOB), addrTopic(BOB), numTopic(2)], [BOB, 6n * WAD], 12)),
    dec(log(BIL_VAULT, BIL_TOPIC.RedemptionPartiallyFulfilled, [numTopic(0), addrTopic(ALICE)], [6n * WAD, 6n * WAD], 13)),
    dec(log(BIL_VAULT, BIL_TOPIC.RedemptionFulfilled, [numTopic(1), addrTopic(BOB)], [4400n * WAD / 1000n, 4n * WAD], 14)),
    dec(log(BIL_VAULT, BIL_TOPIC.RedemptionCancelled, [numTopic(2)], [6n * WAD], 15)),
    dec(log(BIL_VAULT, BIL_TOPIC.Withdraw, [addrTopic(BOB), addrTopic(BOB), addrTopic(BOB)], [4400n * WAD / 1000n, 4n * WAD], 16)),
  ]
  const requests = bilRequests(events)
  const claims = bilControllerClaims(events)
  const unclaimed = (c: string) => requests.filter(r => r.controller === c).reduce((s, r) => s + BigInt(r.settledShares), 0n) - (claims.get(c)?.shares ?? 0n)

  it('states each request\'s settled, owed, cancelled and pending parts from the logs', () => {
    expect(requests.map(r => [r.requestId, r.settledShares, r.hollarOwed, r.cancelledShares, r.pendingShares])).toEqual([
      [0, (6n * WAD).toString(), (6n * WAD).toString(), '0', (4n * WAD).toString()],
      [1, (4n * WAD).toString(), (4400n * WAD / 1000n).toString(), '0', '0'],
      [2, '0', '0', (6n * WAD).toString(), '0'],
    ])
  })

  it('reads claims per controller, as the vault draws them', () => {
    expect(bilRequestStatus(requests[0], unclaimed(ALICE))).toBe('partly-settled')
    expect(bilRequestStatus(requests[1], unclaimed(BOB))).toBe('claimed')
    expect(bilRequestStatus(requests[2], unclaimed(BOB))).toBe('cancelled')
    expect(bilRequestStatus({ settledShares: '5', cancelledShares: '0', pendingShares: '0' }, 5n)).toBe('claimable')
    expect(bilRequestStatus({ settledShares: '0', cancelledShares: '0', pendingShares: '5' }, 0n)).toBe('queued')
  })

  it('reads every request still open: pending, or settled while its controller has unclaimed shares', () => {
    expect(openRequestIds(requests, claims)).toEqual([0])
    // Claims are per controller: a partial claim leaves every settled request of that controller open.
    const more = [...events,
      dec(log(BIL_VAULT, BIL_TOPIC.RedeemRequest, [addrTopic(BOB), addrTopic(BOB), numTopic(3)], [BOB, 3n * WAD], 17)),
      dec(log(BIL_VAULT, BIL_TOPIC.RedemptionFulfilled, [numTopic(3), addrTopic(BOB)], [3n * WAD, 3n * WAD], 18)),
    ]
    expect(openRequestIds(bilRequests(more), bilControllerClaims(more))).toEqual([0, 1, 3])
  })

  it('withholds the chain state unless it names the logged controllers and sums to the vault\'s totals', () => {
    const user = BigInt(ALICE)
    const read = { user, amount: 4n * WAD + 6n * WAD, settled: 6n * WAD, owed: 6n * WAD, active: 1n }
    expect(checkChainRequests(requests, [0], [read], { queued: 10n * WAD, settled: 6n * WAD }))
      .toEqual([{ requestId: 0, controller: ALICE, escrowShares: (10n * WAD).toString(), settledShares: (6n * WAD).toString(), hollarOwed: (6n * WAD).toString() }])
    expect(checkChainRequests(requests, [0], [read], { queued: 11n * WAD, settled: 6n * WAD })).toBeNull()
    expect(checkChainRequests(requests, [0], [{ ...read, user: BigInt(BOB) }], { queued: 10n * WAD, settled: 6n * WAD })).toBeNull()
    expect(checkChainRequests(requests, [0], [null], { queued: 10n * WAD, settled: 6n * WAD })).toBeNull()
    // An inactive request (fully claimed since the logs were read) is skipped.
    expect(checkChainRequests(requests, [0], [{ ...read, active: 0n }], { queued: 0n, settled: 0n })).toEqual([])
  })
})

describe('the Decentral positions', () => {
  const day = 86_400
  const events: BilEvent[] = [
    dec(log(DECENTRAL_POOL, BIL_TOPIC.PoolDeposited, [addrTopic(ALICE), numTopic(1)], [999n], 5, 1, '2026-08-01 00:00:00')),
    dec(log(DECENTRAL_POOL, BIL_TOPIC.PoolDeposited, [addrTopic(BIL_VAULT), numTopic(12)], [300n * WAD], 6, 1, '2026-08-01 00:00:00')),
    dec(log(DECENTRAL_POOL, BIL_TOPIC.PoolDeposited, [addrTopic(BIL_VAULT), numTopic(13)], [10n * WAD], 7, 1, '2026-08-02 00:00:00')),
    dec(log(BIL_VAULT, BIL_TOPIC.PositionProcessed, [numTopic(0)], [12, 1], 8)),
    dec(log(DECENTRAL_POOL, BIL_TOPIC.YieldWithdrawn, [addrTopic(BIL_VAULT), numTopic(12)], [5n * WAD], 9)),
    dec(log(BIL_VAULT, BIL_TOPIC.PositionRedeemed, [numTopic(0)], [12, 0, 300n * WAD], 10)),
    dec(log(DECENTRAL_POOL, BIL_TOPIC.PrincipalWithdrawn, [addrTopic(BIL_VAULT), numTopic(12)], [300n * WAD], 10, 1, '2026-09-30 18:00:00')),
  ]
  const positions = bilPositions(events, 60 * day)

  it('numbers the vault\'s positions by its own investments only, in order, with the term\'s maturity', () => {
    expect(positions.map(p => [p.index, p.tokenId, p.state])).toEqual([[0, '12', 'redeemed'], [1, '13', 'active']])
    expect(positions[0].maturityTime - positions[0].depositTime).toBe(60 * day)
    expect(positions[0].interestPaid).toBe((5n * WAD).toString())
  })

  it('pays principal plus fixed simple interest over the term', () => {
    const p = { principal: (365n * WAD).toString(), depositTime: 0, maturityTime: 365 * day, apyWad: null }
    expect(bilPositionPayout(p, 18n * WAD / 100n)).toBe(365n * WAD + 657n * WAD / 10n)
    // A position's own stored rate wins over the vault's current one.
    expect(bilPositionPayout({ ...p, apyWad: (10n * WAD / 100n).toString() }, 18n * WAD / 100n)).toBe(365n * WAD + 365n * WAD / 10n)
  })

  it('takes each position\'s own stored terms, and publishes no ladder when they name another position', () => {
    const terms = new Map([[1, { tokenId: '13', principal: (10n * WAD).toString(), apyWad: (17n * WAD / 100n).toString(), depositTime: 1000, maturityTime: 1000 + 61 * day }]])
    const withTerms = withPositionTerms(positions, terms)!
    expect(withTerms[1]).toMatchObject({ depositTime: 1000, maturityTime: 1000 + 61 * day, apyWad: (17n * WAD / 100n).toString() })
    expect(withTerms[0]).toEqual(positions[0])
    expect(withPositionTerms(positions, new Map([[1, { ...terms.get(1)!, tokenId: '99' }]]))).toBeNull()
    // The yieldRateSum self-check: Σ apy × principal over open, uncapped positions.
    expect(bilYieldRateSum(withTerms)).toBe(17n * WAD / 100n * 10n * WAD)
    expect(bilYieldRateSum(positions)).toBeNull()
  })

  it('measures each repayment against its position\'s maturity', () => {
    expect(bilProcessingDelays(positions, events)).toEqual([18 * 3600])
  })

  it('reaches a request by the vault\'s FIFO rule: idle HOLLAR first, then each open position\'s payout in order', () => {
    const open = positions.filter(p => p.state !== 'redeemed')
    const apy = 18n * WAD / 100n
    expect(bilQueueCoverage({ positions: open, apyWad: apy, idleHollar: 5n * WAD, queuedAheadHollar: 0n, hollarNeeded: 4n * WAD }))
      .toEqual({ covered: true, coveredByIdle: true, maturityTime: null, position: null })
    const r = bilQueueCoverage({ positions: open, apyWad: apy, idleHollar: 0n, queuedAheadHollar: 1n * WAD, hollarNeeded: 4n * WAD })
    expect(r.maturityTime).toBe(open[0].maturityTime)
    expect(bilQueueCoverage({ positions: open, apyWad: apy, idleHollar: 0n, queuedAheadHollar: 0n, hollarNeeded: 11n * WAD }).covered).toBe(false)
  })

  it('queues several pending requests behind each other', () => {
    const mk = (index: number, principal: bigint, maturityTime: number): BilPosition => ({ ...positions[1], index, tokenId: String(index), principal: principal.toString(), depositTime: maturityTime - 60 * day, maturityTime, apyWad: '0' })
    const ladder = [mk(0, 10n * WAD, 1000), mk(1, 10n * WAD, 2000), mk(2, 10n * WAD, 3000)]
    const at = (ahead: bigint, need: bigint) => bilQueueCoverage({ positions: ladder, apyWad: 0n, idleHollar: 2n * WAD, queuedAheadHollar: ahead, hollarNeeded: need }).maturityTime
    // 2 idle + 10 per maturity: the first request (8) is the first maturity's, the second (8) the second's, a third (8) the third's.
    expect([at(0n, 8n * WAD), at(8n * WAD, 8n * WAD), at(16n * WAD, 8n * WAD)]).toEqual([1000, 2000, 3000])
    expect(at(24n * WAD, 9n * WAD)).toBeNull()
  })

  it('states the wait as maturity plus the measured median to 90th-percentile processing, never a past time', () => {
    const processing = bilProcessingStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])!
    expect(processing).toEqual({ samples: 10, medianSec: 50, p90Sec: 90, maxSec: 100 })
    expect(bilExpectedWindow(1000, processing, 3600, 500)).toEqual({ maturesAt: 1000, from: 1050, to: 1090, matured: false })
    // A maturity already in the past: matured, awaiting processing.
    expect(bilExpectedWindow(1000, processing, 3600, 5000).matured).toBe(true)
    // Nothing repaid yet: the pool's own delay.
    expect(bilExpectedWindow(1000, null, 3600, 0)).toEqual({ maturesAt: 1000, from: 4600, to: 4600, matured: false })
  })
})

describe('beneficial uBIL', () => {
  it('moves the escrow to the controllers — pending as uBIL, settled at its owed HOLLAR — and keeps the remainder with the vault', () => {
    const wallet = new Map([[BIL_VAULT, 20n * WAD], [BIL_ATOKEN, 1000n * WAD]])
    const out = bilBeneficialBalances({
      wallet, exchangeRateWad: 11n * WAD / 10n,
      chain: [
        { controller: ALICE, escrowShares: 10n * WAD, settledShares: 0n, hollarOwed: 0n },
        { controller: BOB, escrowShares: 10n * WAD, settledShares: 10n * WAD, hollarOwed: 10n * WAD },
      ],
    })!
    expect(out.get(ALICE)).toBe(10n * WAD)
    expect(out.get(BOB)).toBe(10n * WAD * WAD / (11n * WAD / 10n))
    // Conservation: direct holdings plus custody equal the attributed claims plus the vault's remainder.
    const attributed = out.get(ALICE)! + out.get(BOB)!
    expect(attributed + out.get(BIL_VAULT)!).toBe(wallet.get(BIL_VAULT)!)
    expect(out.get(BIL_ATOKEN)).toBe(1000n * WAD)
  })

  it('publishes nothing when the attribution would exceed the custody', () => {
    expect(bilBeneficialBalances({ wallet: new Map([[BIL_VAULT, 1n]]), exchangeRateWad: WAD, chain: [{ controller: ALICE, escrowShares: 5n, settledShares: 0n, hollarOwed: 0n }] })).toBeNull()
  })

  it('states each holder\'s position once: what accrues apart from the settled HOLLAR it is owed', () => {
    const { holdings, complete } = bilHoldings({
      bil: new Map([[ALICE, 100n * WAD]]),
      wallet: new Map([[BIL_VAULT, 15n * WAD], [BIL_ATOKEN, 100n * WAD], [BOB, 3n * WAD]]),
      chain: [
        { controller: ALICE, escrowShares: 5n * WAD, settledShares: 0n, hollarOwed: 0n },
        // Fully settled, unclaimed: fixed HOLLAR, nothing accrues.
        { controller: BOB, escrowShares: 10n * WAD, settledShares: 10n * WAD, hollarOwed: 11n * WAD },
      ],
    })
    expect(complete).toBe(true)
    expect(holdings).toEqual([
      { h160: ALICE, bil: 100n * WAD, ubil: 0n, queuedShares: 5n * WAD, claimableHollar: 0n },
      { h160: BOB, bil: 0n, ubil: 3n * WAD, queuedShares: 0n, claimableHollar: 11n * WAD },
    ])
    const rate = 11n * WAD / 10n
    expect(bilAccruingShares(holdings[1])).toBe(3n * WAD)
    expect(bilHoldingHollar(holdings[1], rate)).toBe(3n * WAD * rate / WAD + 11n * WAD)
  })

  it('says so when the open requests could not be stated', () => {
    expect(bilHoldings({ bil: new Map(), wallet: new Map([[BIL_VAULT, 1n]]), chain: null }).complete).toBe(false)
    expect(bilHoldings({ bil: new Map(), wallet: new Map(), chain: null }).complete).toBe(true)
  })
})

describe('NAV', () => {
  it('reads the rate each deposit and settlement executed at, exactly', () => {
    const obs = bilRateObservations([
      { blockHeight: 2, timestamp: '2026-08-02T00:00:00Z', hollar: (1047n * WAD / 1000n).toString(), shares: WAD.toString(), source: 'settlement' },
      { blockHeight: 1, timestamp: '2026-08-01T00:00:00Z', hollar: (100n * WAD).toString(), shares: (100n * WAD).toString(), source: 'deposit' },
      { blockHeight: 3, timestamp: '2026-08-03T00:00:00Z', hollar: '0', shares: '1', source: 'deposit' },
    ])
    expect(obs.map(o => [o.block, o.rateWad])).toEqual([[1, WAD], [2, 1047n * WAD / 1000n]])
  })

  it('annualises the growth simply, and refuses a span under a day', () => {
    expect(bilRealizedApyPct(WAD, WAD + 18n * WAD / 100n, 365 * 86_400)).toBeCloseTo(18, 6)
    expect(bilRealizedApyPct(WAD, 2n * WAD, 3600)).toBeNull()
  })

  it('prices uBIL and BIL at the rate times HOLLAR\'s price', () => {
    const feeds = new Map([[222, 997n * 10n ** 9n], [55, 1040n * 10n ** 9n]])
    const out = withStrategySharePrices(feeds, [
      { shareAssetId: 550, collateralAssetId: 222, rateWad: 1048n * WAD / 1000n, block: 1 },
      { shareAssetId: 55, collateralAssetId: 222, rateWad: 1048n * WAD / 1000n, block: 1 },
    ])
    expect(out.get(55)).toBe(997n * 10n ** 9n * 1048n / 1000n)
    expect(out.get(550)).toBe(out.get(55))
  })
})

// The row classifier (bilActionOf) and the per-day SQL (bilActionRowSql) are both read off
// BIL_ACTION_RULES: an event built to each rule is that action in TS, and each rule's
// every condition is in that action's SQL.
describe('one rule set for the feed and the daily counts', () => {
  it('classifies an event built from each rule as that rule\'s action, and states each condition in its SQL', () => {
    for (const action of BIL_ACTIONS) {
      const sql = bilActionRowSql(action)
      for (const r of BIL_ACTION_RULES[action]) {
        expect(sql, action).toContain(`contract_address = '${r.contract}'`)
        for (const t of r.topics) expect(sql, action).toContain(`'${t}'`)
        if (r.party) expect(sql, action).toContain(`party = '${r.party}'`)
        if (r.partyNot) expect(sql, action).toContain(`party != '${r.partyNot}'`)
        if (r.poolSide) expect(sql, action).toContain(`topics[${r.poolSide === 'from' ? 2 : 3}]`)
        const name = (Object.keys(BIL_TOPIC) as Array<keyof typeof BIL_TOPIC>).find(k => BIL_TOPIC[k] === r.topics[0])!
        const party = r.poolSide ? BORROWER : r.party ?? (r.partyNot ? ALICE : null)
        const e = { name, contract: r.contract, party, blockHeight: 100, from: r.poolSide === 'from' ? DECENTRAL_POOL : BORROWER, to: r.poolSide === 'to' ? DECENTRAL_POOL : BORROWER } as unknown as BilEvent
        expect(bilActionOf(e, new Set([BORROWER]), 50), `${action} ${name}`).toBe(action)
      }
    }
  })

  it('leaves the vault\'s half of a zapped deposit and a draw before the first investment out', () => {
    expect(bilActionOf({ name: 'Deposited', contract: BIL_VAULT, party: BIL_ZAP, blockHeight: 100 } as unknown as BilEvent, new Set(), 50)).toBeNull()
    expect(bilActionOf({ name: 'Transfer', contract: BIL_HOLLAR_CONTRACT, party: BORROWER, from: DECENTRAL_POOL, to: BORROWER, blockHeight: 10 } as unknown as BilEvent, new Set([BORROWER]), 50)).toBeNull()
  })
})

describe('the assets each action moves', () => {
  it('names HOLLAR alone for the strategy\'s own flows and uBIL alone for a request or cancellation', () => {
    for (const a of ['Reinvest', 'Interest', 'Principal', 'Draw', 'Repay'] as const) expect(bilRowAssets(a, false), a).toEqual([BIL_HOLLAR_ASSET_ID])
    for (const a of ['Redeem', 'Cancel'] as const) expect(bilRowAssets(a, false), a).toEqual([UBIL_ASSET_ID])
    expect(bilRowAssets('Deposit', true)).toEqual([BIL_HOLLAR_ASSET_ID, UBIL_ASSET_ID, BIL_ASSET_ID])
    expect(bilRowAssets('Deposit', false)).toEqual([BIL_HOLLAR_ASSET_ID, UBIL_ASSET_ID])
    expect(new Set(BIL_ACTIONS)).toEqual(new Set(Object.keys(BIL_ACTION_ASSETS)))
  })
})

describe('derived share prices', () => {
  // 2-Pool-BIL (a stableswap share over BIL and HOLLAR) must redeem at BIL's NAV price,
  // so the strategy rates apply BEFORE the share pricing; jETH's underlying is itself a
  // pool share, so the rates apply again after it.
  it('prices a pool share over BIL at NAV, and a strategy share over a pool share at that share\'s price', () => {
    const P = 10n ** 12n
    const feeds = new Map([[222, 1n * P], [55, 9n * P / 10n]])
    const pool = { poolId: 9055, assetIds: [55, 222], reserves: [100n * WAD, 100n * WAD], totalIssuance: 200n * WAD }
    const rates = [
      { shareAssetId: 550, collateralAssetId: 222, rateWad: 2n * WAD, block: 1 },
      { shareAssetId: 55, collateralAssetId: 222, rateWad: 2n * WAD, block: 1 },
      { shareAssetId: 5555, collateralAssetId: 9055, rateWad: WAD, block: 1 },
    ]
    const out = withDerivedSharePrices(feeds, [pool], rates, () => 18, id => id === 9055)
    expect(out.get(55)).toBe(2n * P)
    // (100 × 2 + 100 × 1) / 200 = 1.5 per share — BIL at NAV, not at its 0.9 feed.
    expect(out.get(9055)).toBe(3n * P / 2n)
    expect(out.get(5555)).toBe(out.get(9055))
  })
})

// Money-market events name an EVM user in the chain's ETH-prefixed AccountId32 form,
// 0x45544800 + h160 + 16 zero nibbles (all 418 BIL-market supplies and withdrawals).
// The zap/redeem exclusion compares characters 11..50 of it (1-based SQL substring) with
// the BIL log's party: exactly the h160 body.
describe('the money-market plumbing exclusion', () => {
  it('reads the h160 out of the ETH-prefixed account id at the right offset', () => {
    const sql = mmStrategyPlumbingExclusionSql()
    const m = /substring\(ifNull\(account_id, ''\), (\d+), (\d+)\)/.exec(sql)!
    const accountId = '0x45544800' + ALICE.slice(2) + '0'.repeat(16)
    const start = Number(m[1]) - 1, len = Number(m[2])
    expect('0x' + accountId.slice(start, start + len)).toBe(ALICE)
    expect(sql).toContain(`'${BIL_TOPIC.DepositAndSupply}'`)
    expect(sql).toContain(`'${BIL_TOPIC.RedeemRequest}'`)
  })
})
