import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityDesc } from '../src/components/ActivityTable'
import type { ActivityRow, AssetRef } from '../src/types'

// A detail page states the row's context in its own header; a list row has nothing
// above it. `headed` is what tells the shared description which surface it is on, so
// the detail page stops repeating its own header while the lists keep every fact.

const hdx: AssetRef = { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null }
const usdt: AssetRef = { assetId: 10, symbol: 'USDT', name: 'Tether USD', decimals: 6, parachainId: 1000 }

const base: ActivityRow = {
  type: 'vote', blockHeight: 13267476, timestamp: '2026-07-22 08:01:21', eventIndex: 33, extrinsicIndex: 2,
  who: null, to: null, asset: null, assetIn: null, assetOut: null,
  amount: null, amountIn: null, amountOut: null, valueUsd: null,
}

const vote: ActivityRow = {
  ...base, asset: hdx, amount: '24855324262301054799',
  votePallet: 'ConvictionVoting', voteAction: 'Voted', voteRef: '368', voteRefPallet: 'opengov',
  voteRefTitle: 'Tip Request for DIA Oracle Services on Hydration',
  voteSide: 'Aye', voteConviction: 'Locked5x',
}

describe('ActivityDesc — vote', () => {
  it('carries the referendum, the side and the conviction in a list', () => {
    const html = renderToStaticMarkup(<ActivityDesc r={vote} />)
    expect(html).toContain('#368')
    expect(html).toContain('Tip Request for DIA Oracle Services on Hydration')
    expect(html).toContain('AYE')
    expect(html).toContain('Locked5x')
    expect(html).toContain('24.9')
  })

  it('keeps only the locked capital when the page header already says the rest', () => {
    const html = renderToStaticMarkup(<ActivityDesc r={vote} headed />)
    expect(html).toContain('HDX')
    expect(html).toContain('24.9')
    expect(html).not.toContain('#368')
    expect(html).not.toContain('Tip Request')
    expect(html).not.toContain('AYE')
    expect(html).not.toContain('Locked5x')
  })
})

describe('ActivityDesc — cross-chain', () => {
  const out: ActivityRow = {
    ...base, type: 'xcm', xcmDir: 'out', asset: hdx, amount: '1000000000000',
    destChain: 'Moonbeam',
    destAccount: { kind: 'AccountKey20', address: '0x1111111111111111111111111111111111111111', raw: '0x11', subscanUrl: null },
  }

  const inbound: ActivityRow = { ...base, type: 'xcm', xcmDir: 'in', asset: hdx, amount: '1000000000000', fromChain: 'AssetHub' }

  // The local end, asserted through its class: the fixture asset is itself named
  // Hydration, so matching the bare word would pass on the asset alone.
  const local = /class="chain-badge chain-badge-local"/

  it('names the destination chain in a list', () => {
    expect(renderToStaticMarkup(<ActivityDesc r={out} />)).toContain('Moonbeam')
  })

  // Unlike every other family, a hop keeps both ends on a headed surface: the two
  // chains ARE the phrase, and a subtitle naming one of them in passing is not the
  // same as drawing the journey. This is what a detail page reading only "AAVE 30.4"
  // was missing.
  it('draws the whole journey on a headed surface too', () => {
    const html = renderToStaticMarkup(<ActivityDesc r={out} headed />)
    expect(html).toContain('Moonbeam')
    expect(html).toMatch(local)
    expect(html).toContain('0x1111111111111111111111111111111111111111')
  })

  it('names both ends of an inbound hop with no resolved origin account', () => {
    const html = renderToStaticMarkup(<ActivityDesc r={inbound} headed />)
    expect(html).toContain('AssetHub')
    expect(html).toMatch(local)
    expect(html).toContain('→')
  })

  it('leaves no dangling arrow when nothing is left to point at', () => {
    const html = renderToStaticMarkup(<ActivityDesc r={{ ...out, destChain: undefined, destAccount: undefined }} headed />)
    expect(html).not.toContain('→')
    // Nor a local badge opposite nothing, which would read as a destination.
    expect(html).not.toMatch(local)
  })

  // Which side the local badge lands on is the direction: the chain the balance left
  // for an outbound hop, the chain it reached for an inbound one.
  it('puts Hydration on the receiving side of an inbound hop', () => {
    const html = renderToStaticMarkup(<ActivityDesc r={inbound} />)
    expect(html.indexOf('AssetHub')).toBeLessThan(html.search(local))
  })

  it('puts Hydration on the sending side of an outbound hop', () => {
    const html = renderToStaticMarkup(<ActivityDesc r={out} />)
    expect(html.search(local)).toBeLessThan(html.indexOf('Moonbeam'))
  })

  it('leaves a same-chain transfer with no chain badges at all', () => {
    const transfer: ActivityRow = { ...base, type: 'transfer', asset: hdx, amount: '1000000000000', to: null }
    expect(renderToStaticMarkup(<ActivityDesc r={transfer} />)).not.toMatch(local)
  })
})

describe('ActivityDesc — OTC', () => {
  const fill: ActivityRow = {
    ...base, type: 'otc', otcAction: 'Fill', otcOrderId: 91,
    assetIn: hdx, assetOut: usdt, amountIn: '1000000000000', amountOut: '5000000',
  }

  it('trails the order id in a list', () => {
    expect(renderToStaticMarkup(<ActivityDesc r={fill} />)).toContain('#91')
  })

  it('drops the order id the header already carries', () => {
    expect(renderToStaticMarkup(<ActivityDesc r={fill} headed />)).not.toContain('#91')
  })

  it('keeps the order id when the legs are unknown — nothing else identifies the row', () => {
    const legless = { ...fill, assetIn: null, assetOut: null }
    expect(renderToStaticMarkup(<ActivityDesc r={legless} headed />)).toContain('Order #91')
  })
})
