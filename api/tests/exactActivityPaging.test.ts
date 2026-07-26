import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { exactActivityMismatch, isExactlyPagedActivityType } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// A page is located by counting the feed per block in SQL and then classifying only
// the blocks that hold its ranks. The two halves have to be reconciled BEFORE a page
// is served, and reconciled per block: the failure worth guarding against is a read
// that returns the right NUMBER of rows for the wrong blocks, which leaves every
// total intact. (The ANY-join analyzer bug did exactly that — right count, wrong
// blocks — and so did counting DCA failures in both an arm and an enumerated source.)
describe('exactActivityMismatch', () => {
  it('accepts a page whose blocks each hold the counted number of rows', () => {
    expect(exactActivityMismatch([7, 7, 9], new Map([[7, 2], [9, 1]]))).toBeNull()
  })

  it('names the block a read under-delivered', () => {
    expect(exactActivityMismatch([7, 9], new Map([[7, 2], [9, 1]]))).toBe('block 7 counted 2, built 1')
  })

  it('names the block a read over-delivered', () => {
    expect(exactActivityMismatch([7, 7, 7], new Map([[7, 2]]))).toBe('block 7 counted 2, built 3')
  })

  it('catches a block the count never mentioned', () => {
    expect(exactActivityMismatch([7, 8], new Map([[7, 1]]))).toBe('block 8 counted 0, built 1')
  })

  it('catches a block that vanished entirely', () => {
    expect(exactActivityMismatch([7], new Map([[7, 1], [4, 1]]))).toBe('block 4 counted 1, built 0')
  })

  // The whole point: the same rows in the wrong blocks.
  it('sees the right row count spread over the wrong blocks', () => {
    expect(exactActivityMismatch([7, 7], new Map([[7, 1], [4, 1]]))).not.toBeNull()
  })
})

// Which categories page by locating their ranks decides the route's offset bound, so
// the two must agree on the vocabulary — including that `dca` is a kind of trade.
describe('isExactlyPagedActivityType', () => {
  it('covers the categories counted exactly, under either spelling of DCA', () => {
    for (const type of ['trade', 'dca', 'liquidity', 'mm', 'vote', 'staking', 'otc']) {
      expect(isExactlyPagedActivityType(type), type).toBe(true)
    }
  })

  it('excludes the categories still served from a candidate window', () => {
    for (const type of ['all', 'transfer', 'xcm']) {
      expect(isExactlyPagedActivityType(type), type).toBe(false)
    }
  })
})

// A row counted by an arm AND by an enumerated source is counted twice, which shifts
// every page past it. Failed DCA attempts are the case that actually happened: they
// are trade rows of the same feed, but `getRecentDcaFailures` is one of the sources
// read in full, so the executions arm must not count them.
describe('activity count arms count each row once', () => {
  it('counts DCA executions in the arm and failures only in the enumerated source', () => {
    const at = explorerService.indexOf('function accountDcaTradeArm')
    expect(at).toBeGreaterThan(-1)
    const arm = explorerService.slice(at, explorerService.indexOf('\n}', at))

    expect(arm).toContain(`e.event_name = 'DCA.TradeExecuted'`)
    expect(arm).not.toContain('DCA.TradeFailed')
    expect(explorerService).toContain('getRecentDcaFailures(depth,')
  })

  // The arm and the page read must select the same rows, so they read one event list
  // rather than two copies of it.
  it('counts the liquidity events the page read builds rows from', () => {
    expect((explorerService.match(/event_name IN \(\$\{sqlEventNameList\(LIQUIDITY_EVENTS\)\}\)/g) ?? []).length)
      .toBeGreaterThanOrEqual(2)
    expect(explorerService).not.toContain(`'Omnipool.LiquidityAdded','Omnipool.LiquidityRemoved'`)
  })

  // Pool-share membership is asset-registry state ClickHouse does not hold. It is
  // interpolated from the live registry per request precisely so a newly registered
  // share token cannot leave a baked classification stale.
  it('derives the share-asset list from the live registry', () => {
    const at = explorerService.indexOf('function shareAssetIdsSql')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}', at))

    expect(body).toContain('allExplorerAssets()')
    expect(body).toContain('isShareAssetId')
    expect(body).toContain('SHARE_TOKEN_UNDERLYING_ID')
  })
})
