import { describe, expect, it } from 'vitest'
import { JUICER_ACTION_SLUGS, JUICER_ACTIONS, decodeJuicerLog, juicerActionSlug, juicerBeneficialBalances, juicerEstimatedApyPct, juicerRequestStatus, juicerRequests, juicerRunRateApyPct, rebalanceBandBps, targetLoopLeverage, type JuicerEvent, type JuicerLogRow, type JuicerRequest } from '../src/services/juicer.ts'
import { juicerDays, mainBreakdown } from '../src/services/juicerService.ts'
import type { ActivityRow } from '../src/services/explorerService.ts'

// Real logs of the launch deployment (juicer_logs rows).
const VAULT = '0x98db179d65b8abc53946bd89b3433a4fd3bfb60c'
const SUBLOOP = '0x2df1d70f413b5edd16bb794791117948a7436a45'
const row = (r: Partial<JuicerLogRow> & Pick<JuicerLogRow, 'topic0' | 'topics' | 'data'>): JuicerLogRow =>
  ({ block_height: 1, event_index: 1, extrinsic_index: 2, ts: '2026-11-06 20:32:42', contract_address: VAULT, ...r })

describe('decodeJuicerLog', () => {
  it('decodes a deposit (block 16,702,270)', () => {
    const e = decodeJuicerLog(row({
      topic0: '0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca',
      topics: ['0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca', '0x00000000000000000000000085dbb63c0dc1555b9b6406508e6b3bf2b979d845'],
      data: '0x0000000000000000000000000000000000000000000000002be89dcc906de2790000000000000000000000000000000000000000000000002be89dcc906de279',
    }))
    expect(e).toMatchObject({ name: 'Deposited', vault: VAULT, party: '0x85dbb63c0dc1555b9b6406508e6b3bf2b979d845', assets: '3163952240149783161', shares: '3163952240149783161' })
  })

  it('decodes a withdrawal request and its scheduled eligibility (block 16,705,419)', () => {
    const req = decodeJuicerLog(row({
      topic0: '0x1d3135f7e52d949fd35b86ab673aeb906bdee851ec045f9539dc9a33fbfbe482',
      topics: ['0x1d3135f7e52d949fd35b86ab673aeb906bdee851ec045f9539dc9a33fbfbe482', '0x0000000000000000000000000000000000000000000000000000000000000001', '0x00000000000000000000000084d42a3f0dc68e3be1d4936b51ceb47a8601006a'],
      data: '0x0000000000000000000000000000000000000000000000004427ece0d219fb00',
    }))
    expect(req).toMatchObject({ name: 'RedeemRequested', requestId: 1, party: '0x84d42a3f0dc68e3be1d4936b51ceb47a8601006a', shares: '4911154369012562688' })
    const sched = decodeJuicerLog(row({
      topic0: '0x6dc83b2b4249c95db32c0425ee1720f24b33553482a672c27cfae3f9cd26b5df',
      topics: ['0x6dc83b2b4249c95db32c0425ee1720f24b33553482a672c27cfae3f9cd26b5df', '0x0000000000000000000000000000000000000000000000000000000000000001'],
      data: '0x000000000000000000000000000000000000000000000000000000006af78f7a',
    }))
    expect(sched).toMatchObject({ name: 'UnwindScheduled', requestId: 1, eligibleAt: 1794609018 })
  })

  it('decodes a rebalance and the HOLLAR the loop took beside it (block 16,684,396)', () => {
    expect(decodeJuicerLog(row({
      topic0: '0xc257294ad49c215e1a248c91a86bc2612b4781d9677285cc9c14498f485ef122',
      topics: ['0xc257294ad49c215e1a248c91a86bc2612b4781d9677285cc9c14498f485ef122'],
      data: '0x0000000000000000000000000000000000000000000000000000000000001230000000000000000000000000000000000000000000000000000000000000197b',
    }))).toMatchObject({ name: 'Rebalanced', ltvBefore: 4656, ltvAfter: 6523 })
    expect(decodeJuicerLog(row({
      contract_address: SUBLOOP,
      topic0: '0xfb5f43e3eb2833d020c71477c280fe339de3c2770691e1a67d65cd12eb6ea72d',
      topics: ['0xfb5f43e3eb2833d020c71477c280fe339de3c2770691e1a67d65cd12eb6ea72d', '0x00000000000000000000000098db179d65b8abc53946bd89b3433a4fd3bfb60c'],
      data: '0x0000000000000000000000000000000000000000000000878678326eac900000000000000000000000000000000000000000000000000089185c4e6e5f0a8613',
    }))).toMatchObject({ name: 'LoopDeposited', vault: VAULT, hollar: '2500000000000000000000' })
  })

  it('tells the vault harvest (collateral) from the loop harvest (PRIME) by contract', () => {
    const t = '0x8e55ccfc9778ff8eba1646d765cf1982537ce0f9257054a17b48aad745250183'
    const data = '0x' + (10n ** 18n).toString(16).padStart(64, '0')
    expect(decodeJuicerLog(row({ topic0: t, topics: [t], data }))).toMatchObject({ collateral: '1000000000000000000' })
    expect(decodeJuicerLog(row({ contract_address: SUBLOOP, topic0: t, topics: [t], data }))).toMatchObject({ amount: '1000000000000000000' })
  })

  it('refuses a known topic from a contract outside the deployment, and a short log', () => {
    const t = '0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca'
    // DecentralPool emits the same Deposited(address,uint256,uint256) signature.
    expect(decodeJuicerLog(row({ contract_address: '0x207a626c07b73e76134177d1f44b0f32e94adb5a', topic0: t, topics: [t, '0x' + '1'.padStart(64, '0')], data: '0x' + '1'.padStart(128, '0') }))).toBeNull()
    expect(decodeJuicerLog(row({ topic0: t, topics: [t, '0x' + '1'.padStart(64, '0')], data: '0x' + '1'.padStart(64, '0') }))).toBeNull()
  })
})

describe('the loop\'s own steps', () => {
  it('decodes a lever: borrowed HOLLAR sent out as an ICE intent for PRIME (block 16,683,616)', () => {
    const t = '0xf47be53a3800f408a772b4ce403212b043ad8c0eff97ec1a583cbc250aa91c89'
    const e = decodeJuicerLog(row({ contract_address: SUBLOOP, topic0: t,
      topics: [t, '0x' + '1'.padStart(64, '0'), '0x' + '2'.padStart(64, '0')],
      data: '0x00000000000000000000000000000000000000000000000062bc84443fb4d800' + '0'.repeat(64) + '0'.repeat(64) }))
    expect(e).toMatchObject({ name: 'IntentSubmitted', intentKind: 1, intentNonce: 2, amount: '7114706940000000000' })
  })
})

describe('juicer actions', () => {
  it('give every action exactly one feed slug', () => {
    expect(Object.values(JUICER_ACTION_SLUGS).sort()).toEqual([...JUICER_ACTIONS].sort())
    for (const a of JUICER_ACTIONS) expect(JUICER_ACTION_SLUGS[juicerActionSlug(a)]).toBe(a)
  })
})

describe('juicerEstimatedApyPct', () => {
  // The launch state at block 16,729,229, where app.hydration.net showed "Est. APY 7.11%":
  // GETH max LTV 80 % less a 5 % band gap, the loop's target HF 1.05 against PRIME's
  // 88 % liquidation threshold, HOLLAR at 4.40 %, PRIME supply 6.746 % (Kamino + the
  // market), a 69 % harvest share, 40 % Main and 90 % loop discounts.
  const inputs = { targetLtv: 0.75, targetHf: 1.05, primeLtBps: 8800, borrowRate: 0.044016888917752794, primeSupplyApyPct: 6.745965, protocolFeeBps: 6900, mainDiscountBps: 4000, loopDiscountBps: 9000 }
  it('reproduces the official app’s figure', () => {
    expect(juicerEstimatedApyPct(inputs)!.toFixed(2)).toBe('7.11')
  })
  it('is the steady state at target leverage', () => {
    expect(targetLoopLeverage(1.05, 8800)).toBeCloseTo(1 / (1 - 0.88 / 1.05), 12)
    expect(targetLoopLeverage(0.8, 8800)).toBeNull()
  })
  it('states nothing for an input out of range', () => {
    expect(juicerEstimatedApyPct({ ...inputs, protocolFeeBps: 10_001 })).toBeNull()
    expect(juicerEstimatedApyPct({ ...inputs, targetLtv: 1.2 })).toBeNull()
    expect(juicerEstimatedApyPct({ ...inputs, targetHf: 0 })).toBeNull()
  })
})

describe('withdrawal requests from their logs', () => {
  const ev = (name: JuicerEvent['name'], block: number, extra: Partial<JuicerEvent>): JuicerEvent =>
    ({ name, blockHeight: block, eventIndex: 1, extrinsicIndex: 1, timestamp: '2026-11-06 22:30:18', contract: VAULT, vault: VAULT, requestId: 1, ...extra })
  const logs = [
    ev('RedeemRequested', 10, { party: '0x84d42a3f0dc68e3be1d4936b51ceb47a8601006a', shares: '100' }),
    ev('UnwindScheduled', 10, { eligibleAt: 2_000 }),
  ]
  it('follow one request from cooldown to claimed', () => {
    const [r] = juicerRequests(logs)
    expect(r).toMatchObject({ requestId: 1, owner: '0x84d42a3f0dc68e3be1d4936b51ceb47a8601006a', shares: '100', eligibleAt: 2_000, started: false })
    expect(juicerRequestStatus(r, 1_000)).toBe('cooldown')
    expect(juicerRequestStatus(r, 3_000)).toBe('queued')
    const started = juicerRequests([...logs, ev('UnwindStarted', 20, { collateral: '90' })])[0]
    expect(juicerRequestStatus(started, 3_000)).toBe('settling')
    // collateralSettled is the UNCLAIMED balance: released and not yet claimed means claimable.
    const settled = juicerRequests([...logs, ev('UnwindStarted', 20, { collateral: '90' }), ev('RedeemSettled', 21, { collateral: '50' })])[0]
    expect(juicerRequestStatus(settled, 3_000)).toBe('claimable')
    const partly = juicerRequests([...logs, ev('UnwindStarted', 20, { collateral: '90' }), ev('RedeemSettled', 21, { collateral: '50' }), ev('Claimed', 22, { collateral: '50', party: '0x1111111111111111111111111111111111111111' })])[0]
    expect(juicerRequestStatus(partly, 3_000)).toBe('settling')
    const done = juicerRequests([...logs, ev('UnwindStarted', 20, { collateral: '90' }), ev('RedeemSettled', 21, { collateral: '90' }), ev('Claimed', 22, { collateral: '90' })])[0]
    expect(juicerRequestStatus(done, 3_000)).toBe('claimed')
  })
})

describe('beneficial share balances', () => {
  const YA = '0x3f4b16860c15a0ea7596c0b4218f5e45a1a8e53d'
  const A = '0xaaaa000000000000000000000000000000000001', B = '0xbbbb000000000000000000000000000000000002'
  const req = (owner: string, shares: string, extra: Partial<JuicerRequest> = {}): JuicerRequest => ({
    vault: VAULT, requestId: 0, owner, shares, requestedAt: { blockHeight: 1, timestamp: '' }, eligibleAt: 0, started: false, collateralOwed: null, settled: '0', claimed: '0', ...extra,
  })
  it('moves escrow and funded earnings to their owners and conserves the custody', () => {
    const wallet = new Map([[VAULT, 40n], [YA, 15n], [A, 100n], [B, 0n]])
    const out = juicerBeneficialBalances({ vault: VAULT, wallet, funded: new Map([[A, 5n]]), requests: [req(B, '45')], exchangeRateWad: 10n ** 18n })!
    expect(out.get(A)).toBe(105n)
    expect(out.get(B)).toBe(45n)
    // wallet(vault) + wallet(fund) = attributed + remainders
    expect((out.get(VAULT) ?? 0n) + (out.get(YA) ?? 0n) + 5n + 45n).toBe(55n)
  })
  it('states an unwinding request at exactly what it is still owed', () => {
    const out = juicerBeneficialBalances({ vault: VAULT, wallet: new Map([[VAULT, 100n]]), funded: new Map(),
      requests: [req(A, '100', { started: true, collateralOwed: '110', claimed: '10' })], exchangeRateWad: 2n * 10n ** 18n })!
    expect(out.get(A)).toBe(50n) // (110 − 10) / 2
  })
  it('publishes nothing when the attribution exceeds the custody', () => {
    expect(juicerBeneficialBalances({ vault: VAULT, wallet: new Map([[VAULT, 1n]]), funded: new Map(), requests: [req(A, '2')], exchangeRateWad: 10n ** 18n })).toBeNull()
  })
})

describe('the rebalance band', () => {
  it('measures its gaps from the target, as SubLoop.setRebalanceBand does', () => {
    // Launch: GETH max LTV 80 %, target gap 5 %, relever 10 %, delever 8 % → 65 / 75 / 83 (under the 85 % threshold).
    expect(rebalanceBandBps(8000, { targetGapBps: 500, releverGapBps: 1000, deleverGapBps: 800 })).toEqual({ target: 7500, relever: 6500, delever: 8300 })
  })
})

describe('the run-rate', () => {
  it('is what the live loop earns, negative while its carry is below Main\'s interest', () => {
    // block 16,730,188: loop at 1.04x, Main at 74.2 % LTV.
    const r = juicerRunRateApyPct({ borrowRate: 0.044016888917752794, primeSupplyApyPct: 6.745965, protocolFeeBps: 6900, mainDiscountBps: 4000, loopDiscountBps: 9000, leverage: 1.0382, mainLtv: 0.7424 })!
    expect(r).toBeLessThan(0)
    expect(r).toBeGreaterThan(-1)
  })
})

describe('Main breakdown', () => {
  // getUserAccountData(vault) at block 16,729,871 and the synthetic supplied at its
  // oracle price (1.0000 USD): real collateral = base collateral − synthetic.
  it('strips the synthetic at its oracle value and states the deployed share of target borrowing', () => {
    const m = mainBreakdown({ collateralBase: '17878043763126', debtBase: '7535934016389', healthFactor: '2149606859420224909', blockHeight: 16_729_871 }, '7727440937431', 7500)!
    expect(m.collateralUsd!).toBeCloseTo(178780.43763126 - 77274.40937431, 6)
    expect(m.ltv!).toBeCloseTo(0.7424, 4)
    expect(m.deployedFraction!).toBeCloseTo(m.ltv! / 0.75, 9)
  })
})

describe('juicerDays', () => {
  const r = (action: ActivityRow['juicerAction'], ts: string, valueUsd: number | null, amount = '1'): ActivityRow => ({
    type: 'juicer', blockHeight: 1, timestamp: ts, extrinsicIndex: 1, who: null, to: null, asset: null, assetIn: null, assetOut: null,
    amount, amountIn: null, amountOut: null, valueUsd, juicerAction: action,
  })
  it('fills every day from launch and sums each act on its own day', () => {
    const days = juicerDays([r('Deposit', '2026-11-05 10:00:00', 100), r('Deposit', '2026-11-05 11:00:00', null), r('Withdraw', '2026-11-07 01:00:00', null, '5'), r('Rebalance', '2026-11-05 12:00:00', null)], '2026-11-05', '2026-11-07')
    expect(days.map(d => d.day)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07'])
    expect(days[0]).toMatchObject({ deposits: 2, depositsUsd: 100, rebalances: 1 })
    expect(days[1]).toMatchObject({ deposits: 0, withdrawals: 0 })
    expect(days[2]).toMatchObject({ withdrawals: 1, withdrawShares: '5' })
  })
})
