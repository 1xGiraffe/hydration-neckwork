import { describe, expect, it } from 'vitest'
import {
  FIXED_ONE, LmMathError, entryPeriods, entryReward, fixedDiv, fixedMulInt, loyaltyMultiplier, periodOf, rewardBetween, userReward,
  type FarmEntry, type YieldFarmData,
} from '../src/services/lmRewardMath.ts'

// Vectors ported verbatim from the node's math/src/liquidity_mining/tests.rs
// (hydration-node 8d87791c). They pin the runtime's FixedU128 rounding: every
// expected value there is the Rust result, so a floor where the runtime rounds
// (or the reverse) fails here rather than drifting a unit on chain.

const F = (n: bigint): bigint => n * FIXED_ONE

const LOYALTY: bigint[][] = [
  [0n, 500000000000000000n, 1000000000000000000n, 123580000000000000n, 0n],
  [1n, 504950495049504950n, 1000000000000000000n, 160097500000000000n, 62500000000000000n],
  [4n, 519230769230769230n, 1000000000000000000n, 253420000000000000n, 210526315789473684n],
  [130n, 782608695652173913n, 1000000000000000000n, 868250588235294117n, 896551724137931034n],
  [150n, 800000000000000000n, 1000000000000000000n, 883481734104046242n, 909090909090909090n],
  [180n, 821428571428571428n, 1000000000000000000n, 900701182266009852n, 923076923076923076n],
  [240n, 852941176470588235n, 1000000000000000000n, 923354904942965779n, 941176470588235294n],
  [270n, 864864864864864864n, 1000000000000000000n, 931202525597269624n, 947368421052631578n],
  [280n, 868421052631578947n, 1000000000000000000n, 933473069306930693n, 949152542372881355n],
  [320n, 880952380952380952n, 1000000000000000000n, 941231311953352769n, 955223880597014925n],
  [380n, 895833333333333333n, 1000000000000000000n, 949980992555831265n, 962025316455696202n],
  [390n, 897959183673469387n, 1000000000000000000n, 951192106537530266n, 962962962962962962n],
  [4000n, 987804878048780487n, 1000000000000000000n, 994989395973154362n, 996264009962640099n],
  [4400n, 988888888888888888n, 1000000000000000000n, 995442536739769387n, 996602491506228765n],
  [4700n, 989583333333333333n, 1000000000000000000n, 995732022019902604n, 996818663838812301n],
]

const USER_REWARD: bigint[][] = [
  [79n, 1733800371n, 259n, 2333894n, 456446123846332000n, 142447228701n, 169634504185n],
  [61n, 3117n, 1148n, 34388n, 621924695680678000n, 2072804n, 1280987n],
  [0n, 3232645500n, 523n, 1124892n, 1000000000000n, 565781n, 1690671905827n],
  [159n, 3501142339n, 317n, 3309752n, 384109209525475000n, 212478410818n, 340698768992n],
  [352n, 156n, 596n, 2156n, 100703041057143000n, 1677n, 34231n],
  [0n, 192208478782n, 4n, 534348n, 104779339071984000n, 80557375135n, 688276005645n],
  [138n, 36579085n, 213n, 1870151n, 129927485118411000n, 354576988n, 2386984236n],
  [897n, 1n, 970n, 1n, 502367859476566000n, 35n, 37n],
  [4n, 38495028244n, 6n, 2568893n, 265364053378152000n, 20427824566n, 56559663029n],
  [10n, 13343864050n, 713n, 1959317n, 279442586539696000n, 2621375291532n, 6759359176301n],
  [29n, 18429339175n, 833n, 3306140n, 554635100856657000n, 8218129641066n, 6599055749494n],
  [224n, 39102822603n, 586n, 1839083n, 654427828000143000n, 9263569206758n, 4891650736445n],
  [36n, 55755691086n, 251n, 3521256n, 802407775824621000n, 9618838494628n, 2368631567606n],
  [36n, 258339226986n, 77n, 2106922n, 743748274128360000n, 7877711415708n, 2714194783796n],
  [383n, 34812134025n, 2491n, 1442758n, 130076146093442000n, 9545503668738n, 63838473413204n],
  [117n, 44358629274n, 295n, 2076570n, 495172207692510000n, 3909796472461n, 3986037461741n],
  [172n, 64667747645n, 450n, 33468n, 326047919016893000n, 5861570070642n, 12116063741200n],
  [37n, 68875501378n, 82n, 230557n, 176816131903196000n, 548023257587n, 2551374073866n],
  [41n, 100689735793n, 81n, 2268544n, 376605306400251000n, 1516809283443n, 2510777879733n],
  [252n, 16283442689n, 266n, 3797763n, 189489655763324000n, 43193817533n, 184770582350n],
  [20n, 205413646819n, 129n, 3184799n, 543081681209601000n, 12159643178907n, 10230441139565n],
  [23n, 100000n, 155n, 1210762n, 404726206620574000n, 4131623n, 7857615n],
  [11n, 84495025009n, 166n, 468012n, 735133167032114000n, 9627839308653n, 3468889099730n],
  [198n, 79130076897n, 571n, 830256n, 689497061649446000n, 20350862574442n, 9164655277883n],
  [30n, 68948735954n, 72n, 3278682n, 238786980081793000n, 691487259752n, 2204356371634n],
  [54n, 280608075911n, 158n, 0n, 504409653378878000n, 14720307919780n, 14462931974964n],
  [193n, 22787841433n, 1696n, 2962625n, 623942971029398000n, 21370122208415n, 12880000502759n],
  [193n, 22787841433n, 193n, 2962625n, 623942971029398000n, 0n, 0n],
]

describe('loyaltyMultiplier (calculate_loyalty_multiplier)', () => {
  it('matches the node vectors for four curves', () => {
    for (const [periods, m1, m2, m3, m4] of LOYALTY) {
      expect(loyaltyMultiplier(periods, { initialRewardPercentage: 500_000_000_000_000_000n, scaleCoef: 100 })).toBe(m1)
      expect(loyaltyMultiplier(periods, { initialRewardPercentage: F(1n), scaleCoef: 50 })).toBe(m2)
      expect(loyaltyMultiplier(periods, { initialRewardPercentage: 123_580_000_000_000_000n, scaleCoef: 23 })).toBe(m3)
      expect(loyaltyMultiplier(periods, { initialRewardPercentage: 0n, scaleCoef: 15 })).toBe(m4)
    }
  })

  it('is exactly 1 without a curve and refuses a multiplier above 1', () => {
    expect(loyaltyMultiplier(0, null)).toBe(FIXED_ONE)
    expect(() => loyaltyMultiplier(0, { initialRewardPercentage: F(2n), scaleCoef: 10 })).toThrow(LmMathError)
  })
})

describe('userReward (calculate_user_reward)', () => {
  it('matches the node vectors', () => {
    for (const [rpvs, valuedShares, rpvsNow, claimed, loyalty, expectedUser, expectedUnclaimable] of USER_REWARD) {
      const { userRewards, unclaimable } = userReward(F(rpvs), valuedShares, claimed, F(rpvsNow), loyalty)
      expect([userRewards, unclaimable]).toEqual([expectedUser, expectedUnclaimable])
    }
  })
})

describe('the small primitives', () => {
  it('calculate_reward', () => {
    expect(rewardBetween(F(0n), F(1n), 168_416_531n)).toBe(168_416_531n)
    expect(rewardBetween(F(684_131n), F(19_874_646n), 9_798_646n)).toBe(188_041_063_042_690n)
    expect(rewardBetween(F(1_688_453n), F(786_874_343n), 58n)).toBe(45_540_781_620n)
    expect(rewardBetween(F(1_688_453n), F(1_688_453n), 268_413_545_346n)).toBe(0n)
    expect(() => rewardBetween(F(2n), F(1n), 1n)).toThrow(LmMathError)
  })

  it('floors every fixed-point step', () => {
    // 2/3 as a fixed floors at the 18th decimal, and 2/3 · 3 then floors to 1, not 2.
    expect(fixedDiv(F(2n), F(3n))).toBe(666_666_666_666_666_666n)
    expect(fixedMulInt(fixedDiv(F(2n), F(3n)), 3n)).toBe(1n)
    expect(() => fixedDiv(F(1n), 0n)).toThrow(LmMathError)
  })

  it('counts periods in the relay-block periods of the farm', () => {
    expect(periodOf(33_144_929, 1)).toBe(33_144_929)
    expect(periodOf(1_000, 7)).toBe(142)
    expect(() => periodOf(1_000, 0)).toThrow(LmMathError)
  })
})

const yf = (over: Partial<YieldFarmData> = {}): YieldFarmData => ({
  id: 2, updatedAt: 1_000, totalShares: 0n, totalValuedShares: 1_000_000n, accumulatedRpvs: F(10n), accumulatedRpz: F(4n),
  loyaltyCurve: { initialRewardPercentage: FIXED_ONE / 2n, scaleCoef: 100 }, multiplier: F(1n), state: 'active',
  entriesCount: 1n, leftToDistribute: 0n, totalStopped: 0, ...over,
})
const entry = (over: Partial<FarmEntry> = {}): FarmEntry => ({
  globalFarmId: 1, yieldFarmId: 2, valuedShares: 1_000n, accumulatedRpvs: F(4n), accumulatedClaimedRewards: 0n,
  enteredAt: 900, updatedAt: 900, stoppedAtCreation: 0, ...over,
})

describe('entryReward (claim_rewards after the sync)', () => {
  it('pays loyalty · gross − claimed and names what an exit would forfeit', () => {
    // 100 periods on the (0.5, 100) curve: (100 + 50) / 200 = 0.75; gross = 6 · 1000.
    const r = entryReward(entry({ accumulatedClaimedRewards: 1_000n }), yf())
    expect(r).toEqual({ periods: 100, loyalty: 750_000_000_000_000_000n, claimable: 3_500n, maxReward: 5_000n, forfeitIfWithdrawnNow: 1_500n })
  })

  it('subtracts only the stopped periods the farm spent after the entry was created', () => {
    // 40 periods stopped in total, 10 of them before this entry existed → 30 do not count.
    expect(entryPeriods(entry({ stoppedAtCreation: 10 }), { updatedAt: 1_000, totalStopped: 40 })).toBe(70)
    expect(() => entryPeriods(entry({ stoppedAtCreation: 50 }), { updatedAt: 1_000, totalStopped: 40 })).toThrow(LmMathError)
  })

  it('a stopped farm still pays what accrued before the stop; a terminated one pays nothing', () => {
    expect(entryReward(entry(), yf({ state: 'stopped' })).claimable).toBe(4_500n)
    expect(entryReward(entry(), yf({ state: 'terminated' }))).toEqual({ periods: 0, loyalty: 0n, claimable: 0n, maxReward: 0n, forfeitIfWithdrawnNow: 0n })
  })

  it('pays the full gross without a loyalty curve', () => {
    expect(entryReward(entry(), yf({ loyaltyCurve: null })).claimable).toBe(6_000n)
  })
})
