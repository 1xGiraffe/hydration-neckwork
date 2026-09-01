import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Revenue } from '../src/pages/Revenue'
import { REVENUE_STREAMS_ORDERED, REVENUE_STREAM_COLOR, STAKER_POT_COLOR } from '../src/components/revenueColors'
import type { RevenueDashboard, StakerDistributions } from '../src/types'

// Deterministic fixture: two streams over two day-buckets, one attributed payer.
const DAY = 86_400
const T0 = Math.floor(Date.parse('2026-08-10T00:00:00Z') / 1000)
const PAYER = {
  accountId: `0x${'ab'.repeat(32)}`,
  address: '7Payer1111111111111111111111111111111111111111',
  emoji: '🦛',
  tag: null,
  profile: null,
}

function fixture(): RevenueDashboard {
  return {
    totals: { day: 512.34, week: 3_804.5, month: 16_420.11, allTime: 431_207.9 },
    history: {
      range: '30d',
      bucketSeconds: DAY,
      series: [
        { stream: 'network_fee', points: [{ t: T0, usd: 12.5 }, { t: T0 + DAY, usd: 14.25 }] },
        { stream: 'omnipool_asset_fee', points: [{ t: T0, usd: 380.0 }, { t: T0 + DAY, usd: 420.75 }] },
      ],
    },
    breakdown: [
      { stream: 'omnipool_asset_fee', usd: 800.75, share: 0.9676 },
      { stream: 'network_fee', usd: 26.75, share: 0.0324 },
    ],
    topAccounts: [{ account: PAYER, usd: 96.4 }],
    asOf: '2026-08-14T12:00:00.000Z',
  }
}

// The staker section reads its own endpoint and opens on the recent month.
function stakerFixture(): StakerDistributions {
  return {
    range: '30d',
    bucketSeconds: DAY,
    series: [
      { pot: 'staking', points: [{ t: T0, hdx: 12_000, usd: 110.4 }] },
      { pot: 'gigahdx', points: [{ t: T0, hdx: 36_000, usd: 331.2 }, { t: T0 + DAY, hdx: 40_000, usd: 372 }] },
      { pot: 'gigarwd', points: [{ t: T0 + DAY, hdx: 60_000, usd: 558 }] },
    ],
    totals: { hdx: 148_000, usd: 1_371.6 },
    allTime: { hdx: 201_000_000, usd: 2_140_000 },
  }
}

function render(data?: RevenueDashboard, stakers: StakerDistributions | undefined = stakerFixture()): string {
  const client = new QueryClient()
  if (data) {
    // The page reads range '30d' by default; seed exactly that key.
    client.setQueryData(['revenue-dashboard', '30d'], data)
  }
  if (stakers) {
    // The staker section defaults to the 30d range; seed exactly that key.
    client.setQueryData(['revenue-stakers', '30d'], stakers)
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Revenue />
    </QueryClientProvider>,
  )
}

describe('Revenue page', () => {
  it('renders the river, the ribbon totals, breakdown and top payers from one payload', () => {
    const html = render(fixture())
    expect(html).toContain('rev-river')
    expect(html).toContain('collected while watching')
    // Ribbon totals in the shared compact USD format.
    expect(html).toContain('$512')
    expect(html).toContain('$431k')
    // Breakdown rows carry the stream label, the amount and the share.
    expect(html).toContain('Omnipool trade fees')
    expect(html).toContain('96.8%')
    // The top payer links to its account page.
    expect(html).toContain('/account/7Payer1111111111111111111111111111111111111111')
  })

  it('gives every table cell a data-label so the 720px card layout can name it', () => {
    const html = render(fixture())
    for (const label of ['data-label="Stream"', 'data-label="Revenue"', 'data-label="Share"', 'data-label="Account"', 'data-label="Revenue paid"']) {
      expect(html).toContain(label)
    }
  })

  it('states emptiness instead of inventing zeros', () => {
    const empty = render(
      { ...fixture(), history: { range: '30d', bucketSeconds: DAY, series: [] }, breakdown: [], topAccounts: [] },
      { range: '30d', bucketSeconds: DAY, series: [], totals: { hdx: 0, usd: 0 }, allTime: { hdx: 0, usd: 0 } },
    )
    expect(empty).toContain('No revenue recorded in this range yet.')
    expect(empty).toContain('No attributable payers in this range yet.')
    expect(empty).toContain('No staker distributions in this range yet.')
  })

  it('renders the staker distributions with the recent month by default', () => {
    const html = render(fixture())
    expect(html).toContain('Staker distributions')
    // Defaults to the 30d range: the four-cell ribbon carries the window pair
    // AND the all-time pair.
    expect(html).toContain('last 30 days')
    expect(html).toContain('148k HDX')
    expect(html).toContain('$1.37k')
    expect(html).toContain('201M HDX')
    expect(html).toContain('$2.14M')
    // The three pots are named in the legend.
    for (const label of ['Legacy staking', 'GIGAHDX yield', 'GIGAHDX voting rewards']) {
      expect(html).toContain(label)
    }
    // The section explains the boundary: incentive programmes are not fee revenue.
    expect(html).toContain('Treasury incentive programmes')
  })

  it('keeps one color per stream across every surface', () => {
    // The mapping is the contract the river, chart, legend and breakdown share;
    // duplicates would make two streams indistinguishable.
    const colors = REVENUE_STREAMS_ORDERED.map(s => REVENUE_STREAM_COLOR[s])
    expect(new Set(colors).size).toBe(colors.length)
  })

  it('keeps one color per staker pot', () => {
    const colors = Object.values(STAKER_POT_COLOR)
    expect(new Set(colors).size).toBe(colors.length)
  })
})
