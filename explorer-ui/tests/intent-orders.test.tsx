import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActiveDcaTable, LimitOrdersTable, limitOrderFilledPct } from '../src/components/AccountSections'
import { AssetOrderBook } from '../src/components/AssetOrderBook'
import { bookSpread, depthShare, maxSideSizeUsd } from '../src/utils/orderBook'
import type { AccountRef, ActiveDca, AssetBookEntry, AssetListItem, OpenLimitOrder } from '../src/types'

// Runtime 443 made two kinds of resting order a POSITION: a DCA intent, which
// shares the DCA table with pallet-DCA schedules, and a limit order (a swap
// intent), which gets its own table and the asset page's book.

const owner: AccountRef = {
  accountId: '0x' + 'ab'.repeat(32), address: '14gxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH1ebc',
  emoji: '🦢', tag: null, identity: null, profile: null,
}
const HDX = { assetId: 0, symbol: 'HDX', name: null, decimals: 12, parachainId: null }
const HOLLAR = { assetId: 222, symbol: 'HOLLAR', name: null, decimals: 18, parachainId: null }
const TBTC = { assetId: 1000765, symbol: 'tBTC', name: null, decimals: 18, parachainId: null }

const dca = (overrides: Partial<ActiveDca> = {}): ActiveDca => ({
  id: 76,
  assetIn: HDX, assetOut: TBTC,
  direction: 'Sell', amountPerTrade: '555555555555555', totalAmount: '500000000000000000',
  filledAmount: '217777777777777560', remainingAmount: '282222222222222440',
  executionsDone: 392, period: 144, nextExecutionBlock: 14506710, periodSeconds: 336,
  valueUsd: 5.5, budgetUsd: 5000, fundingBalance: null,
  scheduleBlock: 14449261, scheduleIndex: 2, who: owner,
  ...overrides,
})

describe('ActiveDcaTable — a DCA intent shares the table but not the id space', () => {
  // Schedule 76 and intent #76 both exist on chain, so the row's key and link
  // must come from `intentId`, never from the display handle in `id`.
  it('binds each row to its own identity, never to the shared display handle', () => {
    const schedule = renderToStaticMarkup(<ActiveDcaTable dcas={[dca()]} headBlock={14510000} now={Date.now()} />)
    // rowNav navigates on click rather than through an href, so the row's own
    // marker is what identifies which order the row is bound to.
    expect(schedule).toContain('data-dca-schedule="76"')
    expect(schedule).not.toContain('data-intent-order')

    const intentId = '33002353350733935917200834560076'
    const intent = renderToStaticMarkup(<ActiveDcaTable dcas={[dca({ intentId })]} headBlock={14510000} now={Date.now()} />)
    expect(intent).toContain(`data-intent-order="${intentId}"`)
    expect(intent).not.toContain('data-dca-schedule')
  })

  it('marks the intent row so the two kinds read apart', () => {
    const html = renderToStaticMarkup(<ActiveDcaTable dcas={[dca({ intentId: '330023533507339359172008345600' })]} headBlock={14510000} now={Date.now()} />)
    expect(html).toContain('dca-kind')
    expect(html).toContain('intent')
  })

  it('renders both kinds in one table, each with its own row', () => {
    const html = renderToStaticMarkup(
      <ActiveDcaTable dcas={[dca(), dca({ intentId: '99', id: 76 })]} headBlock={14510000} now={Date.now()} />,
    )
    expect(html).toContain('Active DCA orders · 2')
    expect(html).toContain('data-dca-schedule="76"')
    expect(html).toContain('data-intent-order="99"')
  })
})

// ---------------------------------------------------------------------------

const limitOrder = (over: Partial<OpenLimitOrder> = {}): OpenLimitOrder => ({
  intentId: '33003680077461205255572160512087', seq: 87, who: owner,
  assetIn: HOLLAR, assetOut: HDX,
  amountIn: '3600000000000000000000', amountOut: '500000000000000000',
  filledIn: '0', filledOut: '0',
  remainingIn: '3600000000000000000000', remainingOut: '500000000000000000',
  fills: 0, partial: true, limitPrice: 138.8889, valueUsd: 3600,
  placedBlock: 14479916, placedIndex: 3, timestamp: '2026-09-11T13:24:42.000Z', deadline: null,
  ...over,
})

describe('LimitOrdersTable', () => {
  it('renders nothing for an empty list without emptyText', () => {
    expect(renderToStaticMarkup(<LimitOrdersTable orders={[]} now={Date.now()} />)).toBe('')
  })
  it('titles itself, links to the intent, and shows the REMAINING size', () => {
    const html = renderToStaticMarkup(<LimitOrdersTable orders={[limitOrder({
      filledIn: '900000000000000000000', filledOut: '125000000000000000',
      remainingIn: '2700000000000000000000', remainingOut: '375000000000000000', fills: 3,
    })]} now={Date.now()} />)
    expect(html).toContain('Open limit orders · 1')
    expect(html).toContain('data-intent-order="33003680077461205255572160512087"')
    expect(html).toContain('3 fills')
    expect(html).toContain('25%')       // 900 of 3,600 sold
  })
  it('marks an all-or-nothing order and leaves a partially fillable one unmarked', () => {
    expect(renderToStaticMarkup(<LimitOrdersTable orders={[limitOrder({ partial: false })]} now={Date.now()} />)).toContain('all-or-none')
    expect(renderToStaticMarkup(<LimitOrdersTable orders={[limitOrder()]} now={Date.now()} />)).not.toContain('all-or-none')
  })
  it('names the owner only in the asset-page variant', () => {
    expect(renderToStaticMarkup(<LimitOrdersTable orders={[limitOrder()]} now={Date.now()} />)).not.toContain('>Owner<')
    expect(renderToStaticMarkup(<LimitOrdersTable orders={[limitOrder()]} now={Date.now()} showOwner />)).toContain('>Owner<')
  })
})

describe('limitOrderFilledPct', () => {
  it('is the sold leg’s share, clamped, and null when there is nothing to divide by', () => {
    expect(limitOrderFilledPct('1000', '250')).toBe(25)
    expect(limitOrderFilledPct('1000', '0')).toBe(0)
    // A replayed sum can momentarily exceed the placed amount; 100% is the
    // honest ceiling, not 140%.
    expect(limitOrderFilledPct('1000', '1400')).toBe(100)
    expect(limitOrderFilledPct('0', '0')).toBeNull()
    expect(limitOrderFilledPct('', '1')).toBeNull()
  })
})

// ---------------------------------------------------------------------------

const asset: AssetListItem = { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null } as AssetListItem

const entry = (over: Partial<AssetBookEntry> = {}): AssetBookEntry => ({
  ...limitOrder(), counter: HOLLAR, price: 0.0072, priceUsd: 0.0072,
  size: '500000000000000000', sizeUsd: 3600, total: '3600000000000000000000', ...over,
})

describe('order book arithmetic', () => {
  it('depth is a share of the biggest on the side, not of its total', () => {
    const entries = [entry({ sizeUsd: 100 }), entry({ sizeUsd: 25 })]
    const max = maxSideSizeUsd(entries)
    expect(max).toBe(100)
    expect(depthShare(entries[0], max)).toBe(1)
    expect(depthShare(entries[1], max)).toBe(0.25)
  })
  it('an unpriced row has no depth and an empty side has no divisor', () => {
    expect(depthShare(entry({ sizeUsd: null }), 100)).toBe(0)
    expect(depthShare(entry({ sizeUsd: 10 }), 0)).toBe(0)
    expect(maxSideSizeUsd([])).toBe(0)
  })

  it('spreads the best PRICED bid against the best priced ask', () => {
    const book = {
      bids: [entry({ intentId: 'b1', priceUsd: 0.0090 }), entry({ intentId: 'b2', priceUsd: 0.0080 })],
      asks: [entry({ intentId: 'a1', priceUsd: 0.0110 }), entry({ intentId: 'a2', priceUsd: 0.0120 })],
    }
    const spread = bookSpread(book)
    expect(spread?.absUsd).toBeCloseTo(0.002, 6)
    expect(spread?.midUsd).toBeCloseTo(0.01, 6)
    expect(spread?.pct).toBeCloseTo(20, 4)
  })
  it('skips an unpriced top of book rather than treating it as the best price', () => {
    const book = {
      bids: [entry({ intentId: 'b0', priceUsd: null }), entry({ intentId: 'b1', priceUsd: 0.009 })],
      asks: [entry({ intentId: 'a1', priceUsd: 0.011 })],
    }
    expect(bookSpread(book)?.absUsd).toBeCloseTo(0.002, 6)
  })
  it('has no spread unless both sides carry a priced order', () => {
    expect(bookSpread({ bids: [], asks: [entry()] })).toBeNull()
    expect(bookSpread({ bids: [entry({ priceUsd: null })], asks: [entry()] })).toBeNull()
  })
  it('reports a crossed book rather than hiding it', () => {
    // Two orders quoted in different assets can cross without being matchable.
    const spread = bookSpread({ bids: [entry({ priceUsd: 0.012 })], asks: [entry({ priceUsd: 0.010 })] })
    expect(spread?.absUsd).toBeLessThan(0)
  })
})

describe('AssetOrderBook', () => {
  it('names both sides and the asset, even when a side is empty', () => {
    const html = renderToStaticMarkup(<AssetOrderBook book={{ bids: [entry()], asks: [] }} asset={asset} />)
    expect(html).toContain('Bids · 1')
    expect(html).toContain('Asks · 0')
    expect(html).toContain('No open orders selling HDX')
    expect(html).toContain('data-intent-order="33003680077461205255572160512087"')
  })
  it('shows the spread only when both sides are priced', () => {
    expect(renderToStaticMarkup(<AssetOrderBook book={{ bids: [entry()], asks: [] }} asset={asset} />)).not.toContain('Spread')
    const two = renderToStaticMarkup(<AssetOrderBook
      book={{ bids: [entry({ intentId: 'b', priceUsd: 0.009 })], asks: [entry({ intentId: 'a', priceUsd: 0.011 })] }} asset={asset} />)
    expect(two).toContain('Spread')
  })
  it('marks a row whose counter asset has no feed as unranked', () => {
    const html = renderToStaticMarkup(<AssetOrderBook book={{ bids: [entry({ priceUsd: null })], asks: [] }} asset={asset} />)
    expect(html).toContain('unranked')
  })
})
