import { describe, expect, it } from 'vitest'
import { uniswapV3FeePayersSql, uniswapV3RealizationsSql } from '../src/services/uniswapV3Attribution.ts'
import { accountRevenueEventfulInsertSql } from '../src/derivations/jobs.ts'
import { attributablePayerSql, TREASURY_H160 } from '../src/services/revenueStreams.ts'

// A v3 protocol fee is a REALIZATION of something the swappers paid earlier: the
// pool keeps `setFeeProtocol`'s share of every swap fee inside itself, and a
// `CollectProtocol` (or a Gamma vault's fee transfer) moves the accumulated lump
// to the protocol in one event. Booking the lump against whoever happened to call
// the collect would name the wrong payer, so it is split over the swaps that
// accrued it — the same shape asset_reserve's inter-mint split already uses.

describe('uniswapV3RealizationsSql', () => {
  const sql = uniswapV3RealizationsSql()

  // Only the Gamma vault's lump is a realization to spread. A pool's own protocol
  // fee is booked where it accrues, per swap and already naming its payer, so it
  // needs no window and no split — and a CollectProtocol would be a second booking
  // of revenue the accrual already recognised.
  it('spreads only the vault lump, never a pool collect', () => {
    expect(sql).not.toContain("event_name = 'CollectProtocol'")
    // A vault's fee transfer names only the vault, which reaches its pool through
    // the pair and fee tier the two projections share.
    expect(sql).toContain('price_data.uniswap_v3_vaults')
    expect(sql).toContain(`lower(JSONExtractString(l.decoded_args_json, 'to')) = '${TREASURY_H160}'`)
  })

  it('carries each realization’s accrual window, from the previous one on the same pool and asset', () => {
    expect(sql).toContain('lagInFrame')
    expect(sql).toContain('PARTITION BY pool, asset_id')

  })

  // A Gamma rebalance collects both tokens and pays the Treasury twice in the SAME
  // block. Walking realizations row by row gives the second one a window of
  // (prev, this] where prev == this — empty, so its whole amount degrades to
  // unattributed. Measured before the fix: 23 of 94 realizations, carrying 90% of
  // the stream. Realizations sharing a timestamp share one window instead.
  it('gives realizations in the same block one shared window, not an empty one', () => {
    expect(sql).toContain('SELECT DISTINCT pool, asset_id, kind, ts')
    // The previous realization can sit in an earlier month, so the window walks
    // every realization and only then narrows to the partition being rebuilt.
    expect(sql).toContain('{partition:UInt32}')
  })

  // The two kinds accrue on completely different clocks: a Gamma vault pays out
  // roughly hourly on each ZeroBurn, while the pool's own protocol fee accrues from
  // the moment setFeeProtocol turned it on until someone collects. Walking them as
  // one series would open the first CollectProtocol's window at the last vault
  // payout — splitting a lump accrued over 600+ swaps across the three since — and
  // then strand the next vault payout behind it.
  // Two vaults on one pool pay on their own schedules, so a window still belongs to
  // one vault rather than to the pool.
  it('keeps each vault on its own accrual clock', () => {
    expect(sql).toContain('PARTITION BY pool, asset_id, kind')
    expect(sql).toMatch(/concat\('vault:'/)
  })

  it('only splits protocol revenue that was actually booked', () => {
    expect(sql).toContain("stream = 'uniswap_v3_fee'")
    expect(sql).toContain('amount_usd')
  })
})

describe('uniswapV3FeePayersSql', () => {
  const sql = uniswapV3FeePayersSql()

  it('weights payers by the gross fee each swapper paid in the window', () => {
    expect(sql).toContain("venue = 'uniswapv3'")
    expect(sql).toContain("leg_kind = 'fee'")
    expect(sql).toContain('{pool:String}')
    expect(sql).toContain('{asset:UInt32}')
    expect(sql).toContain('{start:DateTime}')
    expect(sql).toContain('{end:DateTime}')
  })

  // pool_swap_legs is a ReplacingMergeTree the uniswap_v3_legs job republishes
  // whole months into: the live table holds 1,440 rows for 614 real fee legs.
  // Summing it raw would weight a republished swapper 2.3x.
  it('deduplicates the leg before summing it', () => {
    expect(sql).toContain('argMax')
    expect(sql).toContain('ingested_at')
    expect(sql).toContain('GROUP BY block_height, event_index, leg_index')
  })

  it('opens the window exclusively and closes it inclusively, so no swap is counted twice', () => {
    expect(sql).toContain('block_timestamp > {start:DateTime}')
    expect(sql).toContain('block_timestamp <= {end:DateTime}')
  })

  // A direct EVM swap has no Broadcast to name its trader, and its Swap log
  // routinely names the SwapRouter's own pallet account as the recipient — 139 of
  // 614 legs, measured after the routed ones were corrected. A pallet is not a
  // payer: crediting it would put protocol revenue on `modlrouterex` and make the
  // router the protocol's biggest customer. Such a leg keeps its WEIGHT (the fee
  // was really paid) but carries no payer, so its share lands unattributed.
  // Reuses the stream module's own rule rather than restating it: that one covers
  // the native `modl…` form as well as the ETH-mapped one, plus the placeholder
  // swapper and the HSM executor. A local substring test caught only the mapped
  // form, so a native pallet swapper (the ICE pot routing through the pool) would
  // still have been named a payer.
  it('does not name a pallet account as the payer, by the shared rule', () => {
    expect(sql).toContain(attributablePayerSql('payer'))
    expect(sql).toMatch(/AS account/)
  })
})

describe('account_revenue', () => {
  it('leaves uniswap_v3_fee to the split rather than booking it unattributed', () => {
    expect(accountRevenueEventfulInsertSql('202609'))
      .toContain("stream NOT IN ('hollar_borrow', 'asset_reserve', 'uniswap_v3_fee')")
  })
})
