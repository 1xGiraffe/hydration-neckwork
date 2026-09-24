import { describe, expect, it } from 'vitest'
import {
  precompileAssetId, v3AccountPositions, v3AccountPositionsRawAt, vaultShareLegs,
  type V3AccountHistoryRaw, type V3AccountPositionsRaw, type V3ManagerPositionRow, type V3VaultHoldingRow,
} from '../src/services/uniswapV3Positions.ts'

// The account-position math, pinned against the first deployment (aDOT/HOLLAR 0.3%,
// 2026-09-09): the numbers are the chain's.

const POOL = '0x5c6208a3c316a801f8996750aa7b6f45fc988548'
const MANAGER = '0xd5029e471ee3f6f51fefb63fed0482a74bb310b3'
const VAULT = '0xa206d0959813f17c17c87147271c49065438648a'
const ADOT = '0x02639ec01313c8775fae74f2dad1118c8a8a86da'
const HOLLAR = '0x531a654d1696ed52e7275a8cede955e82620f99a'

function position(over: Partial<V3ManagerPositionRow> = {}): V3ManagerPositionRow {
  return {
    manager: MANAGER, tokenId: '1', pool: POOL, token0: ADOT, token1: HOLLAR, fee: 3000, tickLower: 184980, tickUpper: 185100,
    liquidity: '5534876290645021', amount0: '421811246', amount1: '299999999999999996', openedBlock: 14395782, lastBlock: 14395782, ...over,
  }
}
// The vault after its second deposit (block 14402015): 5002.35 shares outstanding
// against 2,125.57 aDOT and 2,501.18 HOLLAR.
function holding(over: Partial<V3VaultHoldingRow> = {}): V3VaultHoldingRow {
  return {
    vault: VAULT, pool: POOL, token0: ADOT, token1: HOLLAR, fee: 3000,
    shares: '2353415739999999999', totalShares: '5002353414235199151924', total0: '21255733705342', total1: '2501176707870000000000', ...over,
  }
}
const raw = (positions: V3ManagerPositionRow[], vaults: V3VaultHoldingRow[], tokenAssets: [string, number][] = [[ADOT, 1001], [HOLLAR, 222]]): V3AccountPositionsRaw =>
  ({ positions, vaults, tokenAssets: new Map(tokenAssets) })

describe('precompileAssetId', () => {
  it('reads the id out of an asset precompile address and nothing else', () => {
    expect(precompileAssetId('0x00000000000000000000000000000001000000de')).toBe(222)
    expect(precompileAssetId('0x0000000000000000000000000000000100000005')).toBe(5)
    expect(precompileAssetId(ADOT)).toBeNull()
    expect(precompileAssetId('0x01')).toBeNull()
  })
})

describe('vaultShareLegs', () => {
  it('redeems shares pro-rata over both totals, flooring', () => {
    expect(vaultShareLegs(10n, 100n, 1001n, 2000n)).toEqual({ amount0: 100n, amount1: 200n })
  })
  it('is nothing for no shares or an empty vault, and never negative', () => {
    expect(vaultShareLegs(0n, 100n, 1n, 1n)).toEqual({ amount0: 0n, amount1: 0n })
    expect(vaultShareLegs(5n, 0n, 1n, 1n)).toEqual({ amount0: 0n, amount1: 0n })
    expect(vaultShareLegs(5n, 10n, -20n, 10n)).toEqual({ amount0: 0n, amount1: 5n })
  })
  it('conserves the vault: every holder floors, so the legs never exceed the totals', () => {
    const a = vaultShareLegs(2353415739999999999n, 5002353414235199151924n, 21255733705342n, 2501176707870000000000n)
    const b = vaultShareLegs(4999999998495199151925n, 5002353414235199151924n, 21255733705342n, 2501176707870000000000n)
    expect(a.amount0 + b.amount0).toBeLessThanOrEqual(21255733705342n)
    expect(a.amount1 + b.amount1).toBeLessThanOrEqual(2501176707870000000000n)
    // The first depositor put in 1 aDOT + 1.1767 HOLLAR for 0.047% of the vault; the
    // vault has earned a little since, so the share redeems to slightly more.
    expect(a.amount0).toBe(10000008820n)
    expect(a.amount1).toBe(1176707870353975589n)
    expect(b.amount0).toBe(21245733696521n)
  })
})

describe('v3AccountPositions', () => {
  it('keeps an open manager position with its principal and range', () => {
    const [p] = v3AccountPositions(raw([position()], []))
    expect(p).toMatchObject({
      kind: 'position', pool: POOL, fee: 3000, asset0: 1001, asset1: 222, manager: MANAGER, tokenId: '1',
      tickLower: 184980, tickUpper: 185100, shares: 5534876290645021n, amount0: 421811246n, amount1: 299999999999999996n,
    })
  })
  it('drops a closed position (nothing left after the decrease) and clamps a negative principal', () => {
    // Position #1 after 14395783: its decrease booked the whole liquidity, and paid
    // out more token1 than went in (the range earned), so net1 is negative.
    expect(v3AccountPositions(raw([position({ liquidity: '0', amount0: '421811246', amount1: '-46042755608716752' })], []))).toEqual([])
    const [p] = v3AccountPositions(raw([position({ liquidity: '7', amount0: '5', amount1: '-3' })], []))
    expect([p.amount0, p.amount1]).toEqual([5n, 0n])
  })
  it('redeems a vault holding pro-rata and carries the vault totals', () => {
    const [v] = v3AccountPositions(raw([], [holding()]))
    expect(v).toMatchObject({
      kind: 'vault', vault: VAULT, pool: POOL, asset0: 1001, asset1: 222, shares: 2353415739999999999n, totalShares: 5002353414235199151924n,
      amount0: 10000008820n, amount1: 1176707870353975589n,
    })
    expect(v3AccountPositions(raw([], [holding({ shares: '0' })]))).toEqual([])
  })
  it('resolves tokens through the caller first, then the SQL map, then the precompile rule', () => {
    const dot = '0x0000000000000000000000000000000100000005'
    const rows = raw([position({ token0: dot, token1: '0x9999999999999999999999999999999999999999' })], [], [])
    expect(v3AccountPositions(rows)[0]).toMatchObject({ asset0: 5, asset1: null })
    expect(v3AccountPositions(rows, addr => (addr === '0x9999999999999999999999999999999999999999' ? 4242 : null))[0]).toMatchObject({ asset0: 5, asset1: 4242 })
  })
})

describe('v3AccountPositionsRawAt', () => {
  const ME = `0x${'61'.repeat(20)}`
  const ALT = `0x${'62'.repeat(20)}`
  const OTHER = `0x${'77'.repeat(20)}`
  const ZERO = `0x${'00'.repeat(20)}`
  const history = (over: Partial<V3AccountHistoryRaw> = {}): V3AccountHistoryRaw => ({
    accounts: [ME],
    managerEvents: [
      { manager: MANAGER, tokenId: '1', block: 100, index: 0, event: 'Transfer', holder: ME, liquidity: '0', amount0: '0', amount1: '0' },
      { manager: MANAGER, tokenId: '1', block: 100, index: 1, event: 'IncreaseLiquidity', holder: '', liquidity: '1000', amount0: '400', amount1: '600' },
      { manager: MANAGER, tokenId: '1', block: 200, index: 0, event: 'DecreaseLiquidity', holder: '', liquidity: '250', amount0: '100', amount1: '150' },
      { manager: MANAGER, tokenId: '1', block: 300, index: 0, event: 'Transfer', holder: OTHER, liquidity: '0', amount0: '0', amount1: '0' },
    ],
    ranges: [{ manager: MANAGER, tokenId: '1', pool: POOL, token0: ADOT, token1: HOLLAR, fee: 3000, tickLower: -60, tickUpper: 60, openedBlock: 100 }],
    shareEvents: [
      { vault: VAULT, block: 110, index: 0, from: ZERO, to: ME, value: '10' },
      { vault: VAULT, block: 400, index: 0, from: ME, to: ZERO, value: '10' },
    ],
    vaultFlows: [
      { vault: VAULT, block: 110, index: 1, event: 'Deposit', shares: '10', amount0: '100', amount1: '200' },
      { vault: VAULT, block: 120, index: 0, event: 'Deposit', shares: '30', amount0: '300', amount1: '600' },
      // The rebalance restates the whole vault (fees earned): 440 / 880.
      { vault: VAULT, block: 150, index: 0, event: 'Rebalance', shares: '0', amount0: '440', amount1: '880' },
      { vault: VAULT, block: 160, index: 0, event: 'Deposit', shares: '10', amount0: '110', amount1: '220' },
      { vault: VAULT, block: 400, index: 1, event: 'Withdraw', shares: '10', amount0: '110', amount1: '220' },
    ],
    vaults: [{ vault: VAULT, pool: POOL, token0: ADOT, token1: HOLLAR, fee: 3000 }],
    tokenAssets: new Map([[ADOT, 1001], [HOLLAR, 222]]),
    ...over,
  })
  const at = (h: V3AccountHistoryRaw, block?: number) => v3AccountPositions(v3AccountPositionsRawAt(h, block))

  it('holds nothing before the first event', () => {
    expect(at(history(), 99)).toEqual([])
  })
  it('states the position principal as of the block: opened, then partly decreased', () => {
    expect(at(history(), 100)).toMatchObject([{ kind: 'position', tokenId: '1', shares: 1000n, amount0: 400n, amount1: 600n }])
    expect(at(history(), 250).find(p => p.kind === 'position')).toMatchObject({ shares: 750n, amount0: 300n, amount1: 450n })
  })
  it('drops a position once its NFT is transferred away', () => {
    expect(at(history(), 300).filter(p => p.kind === 'position')).toEqual([])
  })
  it('redeems vault shares against the totals as of the block, before and after a rebalance', () => {
    // Block 120: net deposits, 10 of 40 shares -> a quarter of 400 / 800.
    expect(at(history(), 120).find(p => p.kind === 'vault')).toMatchObject({ shares: 10n, totalShares: 40n, amount0: 100n, amount1: 200n })
    // Block 160: the rebalance's 440 / 880 plus the later deposit, 10 of 50 shares.
    expect(at(history(), 160).find(p => p.kind === 'vault')).toMatchObject({ shares: 10n, totalShares: 50n, amount0: 110n, amount1: 220n })
    expect(at(history(), 400).filter(p => p.kind === 'vault')).toEqual([])
  })
  it('matches the current reader at the head', () => {
    expect(at(history())).toEqual(at(history(), 10_000))
    expect(at(history())).toEqual([])
  })
  it('nets a transfer between two of the holders, so a tag is one holder', () => {
    const h = history({
      accounts: [ME, ALT],
      shareEvents: [
        { vault: VAULT, block: 110, index: 0, from: ZERO, to: ME, value: '10' },
        { vault: VAULT, block: 130, index: 0, from: ME, to: ALT, value: '10' },
      ],
    })
    expect(at(h, 140).find(p => p.kind === 'vault')).toMatchObject({ shares: 10n })
    // Folded for ME alone the shares left at block 130.
    expect(at({ ...h, accounts: [ME] }, 140).filter(p => p.kind === 'vault')).toEqual([])
  })
})
