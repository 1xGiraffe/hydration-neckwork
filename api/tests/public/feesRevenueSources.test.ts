import { describe, expect, it } from 'vitest'
import { buildFeesStreamSql } from '../../src/public/services/feesCharts.ts'
import {
  AAVE_COLLECTOR,
  HSM_EXECUTOR_ACCOUNTS,
  hsmBuybackFee,
} from '../../src/services/revenueStreams.ts'

// The two streams this file pins were once the endpoint's estimates: the
// liquidation penalty was net_bonus × 1/9 (wrong for every pre-2026 fee era)
// and hsm_revenue was refused outright. Both are read from the events that
// carry the exact amounts — the semantics now live in the SHARED builders
// (services/revenueStreams.ts), and this file asserts the public endpoint
// still serves exactly those definitions through its raw-tail arm, so neither
// a fee-configuration era nor a governance transfer can bend the series.

describe('liquidation penalty reads the collector transfer', () => {
  const sql = buildFeesStreamSql('liquidation_penalty', 'protocol')

  it('sums the aToken BalanceTransfer into the collector, not a constant share', () => {
    // The protocol's cut of a liquidation bonus moves as an aToken
    // BalanceTransfer into the collector inside the liquidation's own block —
    // measured: 4,124 of 4,124 liquidation blocks since 2024-10 carry exactly
    // this transfer. Reading it directly is era-proof where the old
    // net_bonus × 1/9 understated every era whose fee was not 10%.
    expect(sql).toContain(AAVE_COLLECTOR)
    expect(sql).toContain("event_name = 'BalanceTransfer'")
    expect(sql).toContain('atoken_reserve_map')
    // BalanceTransfer.value is SCALED (the deltas MV stores it verbatim while
    // dividing Mint/Burn by the index); the transferred amount is value×index/RAY.
    expect(sql).toMatch(/value.+index/s)
    expect(sql).not.toContain('net_bonus_usd')
  })

  it('scopes the transfer read to liquidation blocks', () => {
    expect(sql).toContain("event_name = 'LiquidationCall'")
    expect(sql).toContain('block_height IN')
  })
})

describe('hsm revenue is arbitrage profit plus buyback fees', () => {
  const sql = buildFeesStreamSql('hsm_revenue', 'protocol')

  it('admits a stableswap fill only when an arb event names its block and HOLLAR amount', () => {
    // The executor account (0x…090a) is not only the HSM: it is also the
    // protocol liquidator, whose collateral sales cross the same stablepools.
    // The (block, hollarAmount) semi-join against HSM.ArbitrageExecuted is what
    // keeps a liquidation sale out of the revenue series.
    expect(sql).toContain("event_name = 'HSM.ArbitrageExecuted'")
    expect(sql).toContain('hollarAmount')
    for (const account of HSM_EXECUTOR_ACCOUNTS) expect(sql).toContain(account)
  })

  it('values pegged legs at parity and never a candle', () => {
    // Both sides of an arb are dollar-denominated: HOLLAR retired at face, the
    // aUSDT/aUSDC leg at parity — candle-valuing them was measured (20 of 45
    // weekly buckets negative) and is exactly what this design removes. Only a
    // non-peg collateral (the closed sUSDe/sUSDS era) takes its 1h close, and a
    // fill whose close is missing, or whose computed profit is negative, is
    // dropped rather than guessed.
    expect(sql).toContain('IN (1002, 1003)')
    expect(sql).toContain('if(peg, toDecimal256(1, 12), toDecimal256(p.close, 12))')
    expect(sql).toContain('peg OR p.close > 0')
    expect(sql).toContain('usd > 0')
  })

  it('charges the buyback fee of the fill era', () => {
    // HSM.CollateralAdded (block 9333145) opened every collateral at
    // buyBackFee 10%; the 9336534 update dropped it to 1bp (100/1e6), where it
    // has stayed. purchaseFee has been 0 from the first block, so purchases
    // contribute no fee revenue and the fills arm reads buybacks only.
    expect(hsmBuybackFee(9333145)).toEqual({ num: 100000n, den: 900000n })
    expect(hsmBuybackFee(9336533)).toEqual({ num: 100000n, den: 900000n })
    expect(hsmBuybackFee(9336534)).toEqual({ num: 100n, den: 999900n })
    expect(hsmBuybackFee(13614378)).toEqual({ num: 100n, den: 999900n })
    expect(sql).toContain("venue = 'hsm'")
  })
})
