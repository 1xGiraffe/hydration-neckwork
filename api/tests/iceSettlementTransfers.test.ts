import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ICE_POT_ACCOUNT,
  NOISY_TRANSFER_POTS,
  suppressSubordinateActivityRows,
  type ActivityRow,
  type AssetRef,
} from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// An ICE intent settles by moving the owner's input INTO the solver pot and the fill
// back OUT of it, both as ordinary Currencies/Tokens transfers against the owner's own
// account. Those two legs are the intent row's mechanics, never transfers the owner
// made — measured over ICE's whole history (from block 14,396,667), every one of the
// 671 pot legs sits in an extrinsic emitting an `Intent.*`/`ICE.*` event and none are
// hook-phase. They are dropped in SQL for that reason: leaving it to the row-level fold
// made suppression conditional on the intent row being in the same assembled set, and a
// settlement showed on the owner's transfer feed as two transfers that a later read
// silently replaced with one intent row.

const ref = (assetId: number, symbol: string, decimals: number): AssetRef =>
  ({ assetId, iconAssetId: assetId, symbol, name: null, decimals, parachainId: null, origin: null })

const account = (accountId: string) =>
  ({ accountId, address: accountId, emoji: '🦑', tag: null, identity: null, profile: null })

const OWNER = '0x45544800553f022201fa7c88e6cc10d1c688b157d6fa77750000000000000000'

// The two legs of one settlement, as the transfer read model returns them.
const settlementLegs = (): ActivityRow[] => [
  {
    type: 'transfer', blockHeight: 14_444_327, timestamp: '2026-09-10 14:22:00', eventIndex: 15, extrinsicIndex: 2,
    who: account(OWNER), to: account(ICE_POT_ACCOUNT), asset: ref(1003, 'aUSDC', 6), amount: '500000000',
    assetIn: null, assetOut: null, amountIn: null, amountOut: null, valueUsd: 500,
  },
  {
    type: 'transfer', blockHeight: 14_444_327, timestamp: '2026-09-10 14:22:00', eventIndex: 81, extrinsicIndex: 2,
    who: account(ICE_POT_ACCOUNT), to: account(OWNER), asset: ref(1_000_752, 'SOL', 9), amount: '4936417076',
    assetIn: null, assetOut: null, amountIn: null, amountOut: null, valueUsd: 500,
  },
]

const intentRow = (): ActivityRow => ({
  type: 'intent', blockHeight: 14_444_327, timestamp: '2026-09-10 14:22:00', eventIndex: 82, extrinsicIndex: 2,
  who: account(OWNER), to: null, asset: null, amount: null,
  assetIn: ref(1003, 'aUSDC', 6), assetOut: ref(1_000_752, 'SOL', 9),
  amountIn: '500000000', amountOut: '4936417076', valueUsd: 500,
  intentKind: 'dca', intentAction: 'DcaTrade',
})

describe('ICE settlement legs are the intent row, not the owner transfers', () => {
  it('names the solver pot as account-page plumbing', () => {
    expect(NOISY_TRANSFER_POTS).toContain(ICE_POT_ACCOUNT)
  })

  it('drops the legs through the same list on both transfer reads and the count arm', () => {
    // The read-model filter (shared verbatim with the count arm) and the raw-events
    // fallback must exclude the same pots, or a settlement leg the page hides is still
    // counted — or reappears the moment a filter pushes the read onto raw_events.
    expect(explorerService).toContain('AND from_account NOT IN (${noisyPotList()}) AND to_account NOT IN (${noisyPotList()})')
    expect(explorerService).toContain("AND JSONExtractString(args_json,'from') NOT IN (${noisyPotList()}) AND JSONExtractString(args_json,'to') NOT IN (${noisyPotList()})")
  })

  it('keeps the legs on the pot\'s OWN page, where they are all it does', () => {
    // The viewing exception is keyed on the same list, so adding a pot to it cannot
    // empty that pot's own feed.
    expect(explorerService).toContain('const viewingNoisyPot = accCond.some(a => NOISY_TRANSFER_POTS.includes(a))')
    expect(explorerService).toContain('if (!accCond.some(a => NOISY_TRANSFER_POTS.includes(a))) {')
  })

  it('still folds a settlement leg under the intent row when both are assembled', () => {
    // The row-level fold stays the belt to the SQL braces: on a surface that reads
    // whole extrinsics (the block and extrinsic pages), the legs arrive with the
    // intent row and must not survive beside it.
    const kept = suppressSubordinateActivityRows([...settlementLegs(), intentRow()])
    expect(kept.map(r => r.type)).toEqual(['intent'])
  })

  it('leaves an ordinary transfer in the same block alone', () => {
    const plain: ActivityRow = {
      type: 'transfer', blockHeight: 14_444_327, timestamp: '2026-09-10 14:22:00', eventIndex: 5, extrinsicIndex: 7,
      who: account(OWNER), to: account('0x' + '11'.repeat(32)), asset: ref(0, 'HDX', 12), amount: '1000000000000',
      assetIn: null, assetOut: null, amountIn: null, amountOut: null, valueUsd: 1,
    }
    const kept = suppressSubordinateActivityRows([...settlementLegs(), intentRow(), plain])
    expect(kept.map(r => r.type)).toEqual(['intent', 'transfer'])
  })
})
