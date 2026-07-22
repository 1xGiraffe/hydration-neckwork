import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AddrPill, DayBarChart, F, moduleName } from '../src/components/ui'
import { PortfolioChart } from '../src/components/AccountSections'
import { ActivityBadge, ExternalAccountPill } from '../src/components/ActivityTable'
import type { AccountRef, ActivityRow } from '../src/types'

const krakenMember: AccountRef = {
  accountId: '0xa7208d10c6622f3f7eca1551de8355fde9de577dbb308d38994ace561738a51f',
  address: '13b6hRRYUPRJqTm1bUgZGwzfdpr1B4yfdYwpfPnPpFhc8Br9',
  emoji: '🌻',
  tag: { id: 'kraken', name: 'Kraken', color: '#7b6cf6', icon: '/tag-icons/kraken.jpg' },
}
const plain: AccountRef = {
  accountId: '0xf2ff382d72029597035b13d87942b7161b381e971e191ed6f2cb46b14c3a25b0',
  address: '15kUt2i86LHRWCkE3D9Bg1HZAoc2smhn1fwPzDERTb1BXAkX',
  emoji: '🦊',
  tag: null,
}
const moduleAcct: AccountRef = {
  accountId: '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000',
  address: '13UVJyLnzJK7QHvX9YYUyJZ9Gw9b5x3p2X1aQ1B4yfdYw',
  emoji: '🦊',
  tag: null,
}

describe('AddrPill — label-aware display (grouping feature)', () => {
  it('renders a labeled account as its group tag', () => {
    const html = renderToStaticMarkup(<AddrPill account={krakenMember} noCopy />)
    expect(html).toContain('Kraken')
    expect(html).toContain('class="tag"')
    expect(html).not.toContain('class="tag tag-chip"')
    expect(html).not.toContain('class="a mono"')
    expect(html).toContain('#7b6cf6')
    expect(html).toContain('/tag/kraken')
    expect(html).not.toContain('/account/13b6hRRYUPRJqTm1bUgZGwzfdpr1B4yfdYwpfPnPpFhc8Br9')
  })
  it('renders an unlabeled account as a short address with last-3 highlight', () => {
    const html = renderToStaticMarkup(<AddrPill account={plain} noCopy />)
    expect(html).toContain('class="addr-pill"')
    expect(html).toContain('last3')
    expect(html).not.toContain('class="tag"')
  })
  it('renders a pallet/module account with a gear', () => {
    expect(moduleName(moduleAcct.accountId)).toBe('omnipool')
    const html = renderToStaticMarkup(<AddrPill account={moduleAcct} noCopy />)
    expect(html).toContain('⚙️')
    expect(html).toContain('omnipool')
  })
})

describe('ExternalAccountPill — tag/identity precedence on external-chain accounts', () => {
  const base = {
    kind: 'AccountId32' as const,
    raw: '0xb2927ffd2bbb0a73a317ab830e2dccd5e30cb0231c3ce7224be0f233b330742f',
    address: '15kUt2i86LHRWCkE3D9Bg1HZAoc2smhn1fwPzDERTb1BXAkX',
    subscanUrl: 'https://assethub-polkadot.subscan.io/account/15kUt2i86LHRWCkE3D9Bg1HZAoc2smhn1fwPzDERTb1BXAkX',
    emoji: '🦑',
  }
  it('shows the Hydration tag name — styled with the tag color — instead of the short address, keeping the external-site suffix', () => {
    const html = renderToStaticMarkup(<ExternalAccountPill account={{ ...base, tag: { id: 'kraken', name: 'Kraken', color: '#7b6cf6', icon: '/tag-icons/kraken.jpg' }, identity: null }} />)
    expect(html).toContain('Kraken')
    expect(html).toContain('class="tag"')
    expect(html).toContain('#7b6cf6')
    expect(html).not.toContain('class="a mono"')
    expect(html).toContain('Subscan')
  })
  it('falls back to the on-chain identity display + verified check when untagged', () => {
    const html = renderToStaticMarkup(<ExternalAccountPill account={{ ...base, tag: null, identity: { display: 'StakerNode', verified: true } }} />)
    expect(html).toContain('StakerNode')
    expect(html).toContain('id-verified')
    expect(html).not.toContain('class="a mono"')
  })
  it('shows the short address when the account has neither a tag nor an identity', () => {
    const html = renderToStaticMarkup(<ExternalAccountPill account={{ ...base, tag: null, identity: null }} />)
    expect(html).toContain('class="a mono"')
    expect(html).not.toContain('class="tag"')
  })
})

describe('ui formatters', () => {
  it('formats amounts on the shared rough scale (~3 significant digits)', () => {
    expect(F.amount('2844406322428427', 10)).toBe('284k')
    expect(F.amount('232622974490774586525', 12)).toBe('233M')
    expect(F.amount('500000000000', 9)).toBe('500')
    expect(F.amount('5371344', 4)).toBe('537')
    expect(F.amount('4870870000', 6)).toBe('4.87k')
    expect(F.amount('120000', 6)).toBe('0.12')
    // very small fractions collapse into the subscript-zero notation
    expect(F.amount('7191', 13)).toBe('0.0₈7191')
    expect(F.amount('0', 12)).toBe('0')
    // carry band tiers up: 999.6k is "1M", never "1000k"
    expect(F.amount('999600000', 3)).toBe('1M')
    expect(F.amount('999600', 3)).toBe('1k')
    expect(F.amount('999600000000', 3)).toBe('1B')
    // the exact counterpart keeps full precision (tooltips, detail surfaces)
    expect(F.exact('2844406322428427', 10)).toBe('284,440.63')
  })
  it('formats usd and percentages', () => {
    expect(F.usd(1088487)).toBe('$1.09M')
    expect(F.usd(999600)).toBe('$1M')
    expect(F.usd(999.6)).toBe('$1k')
    expect(F.pct(0.0428)).toBe('+4.28%')
    expect(F.priceUsd(0.003967)).toBe('$0.003967')
  })
  it('formats high-volume counts compactly', () => {
    expect(F.count(81600)).toBe('81.6k')
    expect(F.count(999)).toBe('999')
    expect(F.count(1234567)).toBe('1.23M')
  })
})

describe('DayBarChart', () => {
  it('renders compact average counts below the chart', () => {
    const html = renderToStaticMarkup(<DayBarChart data={[
      { date: '2026-07-07', value: 80_000 },
      { date: '2026-07-08', value: 83_200 },
    ]} />)
    expect(html).toContain('avg 81.6k/day')
  })
})

describe('PortfolioChart', () => {
  it('renders a skeleton while history is loading and no series is available', () => {
    const html = renderToStaticMarkup(<PortfolioChart title="Value" netUsd={0} series={[]} loading />)
    expect(html).toContain('Value')
    expect(html).toContain('chart-skeleton')
  })
})

describe('ActivityBadge', () => {
  const tradeRow: ActivityRow = {
    type: 'trade',
    blockHeight: 1,
    timestamp: '2026-01-01 00:00:00',
    extrinsicIndex: null,
    who: null,
    to: null,
    asset: null,
    assetIn: null,
    assetOut: null,
    amount: null,
    amountIn: null,
    amountOut: null,
    valueUsd: null,
  }

  it('splits the Trade category into Swap and DCA row badges', () => {
    expect(renderToStaticMarkup(<ActivityBadge r={tradeRow} />)).toContain('Swap')
    expect(renderToStaticMarkup(<ActivityBadge r={{ ...tradeRow, dca: true }} />)).toContain('DCA')
  })
})
