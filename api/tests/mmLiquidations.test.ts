import { describe, expect, it } from 'vitest'
import { assembleMmLiquidations } from '../src/services/mmLiquidations.ts'

// Registry assets map to the money market's precompile addresses (…0001 + id hex).
const mmAddr = (id: number) => `0x00000000000000000000000000000001${id.toString(16).padStart(8, '0')}`
const CORE = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'

describe('assembleMmLiquidations', () => {
  const pricer = { usd: (assetId: number, amount: bigint, hourSec: number) => (hourSec === 3600 && assetId === 10 ? amount * 10n ** 6n : null) }
  const rows = [
    { pool: CORE, block_height: 100, event_index: 3, ts: 3700, asset: mmAddr(34), amount: '5' },
    { pool: CORE, block_height: 200, event_index: 1, ts: 7300, asset: mmAddr(34), amount: '7' },
    { pool: '0xdeadbeef00000000000000000000000000000000', block_height: 150, event_index: 0, ts: 5000, asset: mmAddr(34), amount: '9' },
  ]
  const debts = new Map([['100:3', { asset: mmAddr(10), amount: '558785360' }]])

  it('files each liquidation under its pool\'s market, newest first, and drops unknown pools', () => {
    const out = assembleMmLiquidations(rows, debts, p => (p === CORE ? 'core' : undefined), pricer)
    expect(out.map(l => [l.marketKey, l.blockHeight])).toEqual([['core', 200], ['core', 100]])
  })

  it('values each leg at the liquidation hour and never prices a missing one as zero', () => {
    const [newest, older] = assembleMmLiquidations(rows, debts, () => 'core', pricer).filter(l => l.blockHeight !== 150)
    expect(older.debtAssetId).toBe(10)
    expect(older.debtAmount).toBe(558785360n)
    expect(older.debtUsd).toBe(558785360n * 10n ** 6n)
    expect(older.collateralAssetId).toBe(34)
    expect(older.collateralUsd).toBeNull()
    expect(newest.debtAmount).toBeNull()
    expect(newest.debtUsd).toBeNull()
  })
})
