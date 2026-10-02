import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AssetVolumeSection, PoolVolumeRows, TvlSection, VolumeTvlSection } from '../src/components/VolumeCharts'
import { VENUE_COLOR, VENUE_LABEL, VENUE_ORDER } from '../src/components/volumeColors'
import { asOfLabel, changeColor, fmtChange, fmtVolumeTvl, venueBands, volumeTipLabel } from '../src/utils/volume'
import type { AssetVolume, PoolVolume } from '../src/api/volume'

// The asset/pool/platform volume surfaces: the venue palette, the formatters
// every figure goes through, and the asset section's render contract (hidden
// when the asset never traded, the head and the fold named when it did).

const stat = (volumeUsd: number, prevUsd: number) => ({ volumeUsd, prevUsd, changePct: prevUsd > 0 ? ((volumeUsd - prevUsd) / prevUsd) * 100 : null })

describe('venue palette', () => {
  it('names and colours every venue once, by theme token, in one fixed order', () => {
    expect(VENUE_ORDER).toEqual(['omnipool', 'stableswap', 'xyk', 'otc', 'uniswapv3', 'hsm', 'lbp'])
    for (const v of VENUE_ORDER) {
      expect(VENUE_COLOR[v]).toBe(`var(--vol-${v})`)
      expect(VENUE_LABEL[v]).toBeTruthy()
    }
    expect(VENUE_LABEL.uniswapv3).toBe('Uniswap v3')
    expect(new Set(Object.values(VENUE_COLOR)).size).toBe(VENUE_ORDER.length)
  })
})

describe('volume formatters', () => {
  it('shows volume/TVL as a share for the window, never annualised', () => {
    expect(fmtVolumeTvl(0.0679)).toBe('6.8%')
    expect(fmtVolumeTvl(3.96)).toBe('396.0%')
    expect(fmtVolumeTvl(null)).toBe('—')
  })

  it('signs a change and reads it in colour, and has none without a previous period', () => {
    expect(fmtChange(27.85)).toBe('+27.85%')
    expect(fmtChange(-2.25)).toBe('-2.25%')
    expect(fmtChange(null)).toBeNull()
    expect(changeColor(5)).toBe('var(--green)')
    expect(changeColor(-5)).toBe('var(--red)')
    expect(changeColor(0.01)).toBe('var(--text-low)')
  })

  it('dates a bar by its own span', () => {
    expect(volumeTipLabel('2026-09-30 14:00:00', 3_600)).toBe('2026-09-30 14:00 UTC')
    expect(volumeTipLabel('2026-09-30', 86_400)).toBe('2026-09-30')
    expect(volumeTipLabel('2026-09-28', 7 * 86_400)).toBe('2026-09-28 – 2026-10-04')
    // The bucket holding the cut is still open: its label ends at the cut.
    const asOf = '2026-10-02T05:00:00.000Z'
    expect(volumeTipLabel('2026-10-02', 86_400, asOf)).toBe('2026-10-02 through 05:00 UTC (so far)')
    expect(volumeTipLabel('2026-09-28', 7 * 86_400, asOf)).toBe('2026-09-28 – 2026-10-02 05:00 UTC (so far)')
    expect(volumeTipLabel('2026-09-28', 7 * 86_400, '2026-10-02T00:00:00.000Z')).toBe('2026-09-28 – 2026-10-01 (so far)')
    // A closed bucket, or an hour, keeps its full label.
    expect(volumeTipLabel('2026-10-01', 86_400, asOf)).toBe('2026-10-01')
    expect(volumeTipLabel('2026-10-02 04:00:00', 3_600, asOf)).toBe('2026-10-02 04:00 UTC')
  })

  it('states the hour a window runs to', () => {
    expect(asOfLabel('2026-10-02T02:00:00.000Z')).toBe('02:00 UTC')
    expect(asOfLabel(null)).toBeNull()
  })

  it('stacks only the venues that traded, in the fixed order', () => {
    const bands = venueBands({ stepSec: 86_400, buckets: ['a', 'b'], series: { stableswap: [1, 2], omnipool: [0, 3], hsm: [0, 0], routed: [1, 1] } })
    expect(bands.map(b => b.key)).toEqual(['omnipool', 'stableswap'])
  })
})

const ASSET: AssetVolume = {
  assetId: 5, assetIds: [5, 1001],
  assets: [
    { assetId: 5, iconAssetId: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachainId: null },
    { assetId: 1001, iconAssetId: 5, symbol: 'aDOT', name: 'aDOT', decimals: 10, parachainId: null },
  ],
  asOf: '2026-10-02T02:00:00.000Z',
  kpis: { d1: stat(704_762, 551_238), d7: stat(4_610_998, 3_719_496), d30: stat(13_542_629, 7_191_595), d365: stat(201_000_000, 0) },
  byVenue: [{ venue: 'omnipool', d1: 1, d7: 1, d30: 1, d365: 1 }],
  allTimeUsd: 1_325_768_032,
  volumeTvl: { d7: 1.158, d30: 3.48, d365: 50.1, meanTvl7dUsd: 3_982_742, meanTvl30dUsd: 3_891_980, meanTvl365dUsd: 4_010_000 },
  chart: { stepSec: 86_400, buckets: ['2026-09-30', '2026-10-01', '2026-10-02'], series: { omnipool: [10, 20, 30], stableswap: [5, 0, 1], xyk: [0, 0, 0] } },
}

function renderAsset(data?: AssetVolume): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  if (data) queryClient.setQueryData(['volume-asset', 5], data)
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}><AssetVolumeSection assetId={5} symbol="DOT" /></QueryClientProvider>)
}

describe('AssetVolumeSection', () => {
  it('heads the card with the all-time total, the 24H/7D/30D/12M totals and 7D volume/TVL, and names the fold', () => {
    const html = renderAsset(ASSET)
    expect(html).toContain('Volume')
    expect(html).toContain('DOT with aDOT')
    expect(html).toContain('through 02:00 UTC')
    // Headline: all time; then the four window totals, no change badge.
    expect(html.indexOf('$1.33B')).toBeLessThan(html.indexOf('>24H<'))
    for (const label of ['24H', '7D', '30D', '12M']) expect(html).toContain(`>${label}<`)
    expect(html).toContain('$705k')
    expect(html).toContain('$201M')
    expect(html).not.toContain('+27.85%')
    expect(html).toContain('7D vol / TVL')
    expect(html).toContain('115.8%')
    // One neutral bar per bucket: no venue legend, no venue colours on the plot.
    expect(html).not.toContain('var(--vol-omnipool)')
    expect(html).toContain('var(--chart-neutral)')
    // Bars drawn like the area charts beside them: no axis labels, no "in view" total.
    expect(html).toContain('apx-chart')
    expect(html).not.toContain('hdx-ax')
    expect(html).not.toContain('in view')
  })

  it('is absent for an asset that never traded', () => {
    expect(renderAsset({ ...ASSET, allTimeUsd: 0, chart: { stepSec: 0, buckets: [], series: {} } })).toBe('')
  })
})

describe('PoolVolumeRows', () => {
  it('states volume, fees to LPs and volume/TVL for 24h and 7d, with the fee APR where the venue has one', () => {
    const d = {
      venue: 'stableswap', poolKey: '111', asOf: null,
      kpis: { d1: stat(1_358_845, 1), d7: stat(7_685_122, 1), d30: stat(1, 1), d365: stat(1, 1) },
      fees: { d1: { lpUsd: 195, protocolUsd: 0 }, d7: { lpUsd: 1_100, protocolUsd: 0 }, d30: { lpUsd: 0, protocolUsd: 0 }, d365: { lpUsd: 0, protocolUsd: 0 } },
      fills: { d1: 10, d7: 4_321, d30: 0, d365: 0 }, allTime: { volumeUsd: 1, lpFeeUsd: 0, protocolFeeUsd: 0, fills: 0 },
      tvlUsd: 1_393_386, meanTvl7dUsd: 1_940_000, meanTvl30dUsd: null, meanTvl365dUsd: null,
      volumeTvl: { d1: 0.975, d7: 3.96, d30: null, d365: null }, feeApr7dPct: 4.2,
      tvlAgo: { d1: { usd: null, at: null }, d7: { usd: null, at: null }, d30: { usd: null, at: null }, d365: { usd: null, at: null } },
      chart: { stepSec: 0, buckets: [], series: {} },
    } as PoolVolume
    const html = renderToStaticMarkup(<div className="dl"><PoolVolumeRows d={d} /></div>)
    expect(html).toContain('$1.36M')
    expect(html).toContain('$7.69M')
    expect(html).toContain('4,321 swaps')
    expect(html).toContain('4.20% fee APR')
    expect(html).toContain('97.5%')
    expect(html).toContain('396.0%')
  })
})

describe('pool TVL and Volume / TVL sections', () => {
  const ago = (usd: number | null, at: string | null) => ({ usd, at })
  const POOL = {
    venue: 'omnipool', poolKey: 'omnipool', asOf: '2026-10-02T10:00:00.000Z',
    kpis: { d1: stat(1, 1), d7: stat(1, 1), d30: stat(1, 1), d365: stat(1, 1) },
    fees: { d1: { lpUsd: 0, protocolUsd: 0 }, d7: { lpUsd: 0, protocolUsd: 0 }, d30: { lpUsd: 0, protocolUsd: 0 }, d365: { lpUsd: 0, protocolUsd: 0 } },
    fills: { d1: 0, d7: 0, d30: 0, d365: 0 }, allTime: { volumeUsd: 1, lpFeeUsd: 0, protocolFeeUsd: 0, fills: 0 },
    tvlUsd: 20_000_000, meanTvl7dUsd: 19_000_000, meanTvl30dUsd: 18_000_000, meanTvl365dUsd: 17_000_000,
    volumeTvl: { d1: 0.021, d7: 0.152, d30: 0.6, d365: 7.25 }, feeApr7dPct: null,
    tvlAgo: { d1: ago(19_900_000, '2026-10-01T00:00:00.000Z'), d7: ago(18_100_000, '2026-09-25T00:00:00.000Z'), d30: ago(16_500_000, '2026-09-02T00:00:00.000Z'), d365: ago(null, null) },
    chart: { stepSec: 86_400, buckets: ['2026-09-30', '2026-10-01', '2026-10-02'], series: { volumeTvl: [0.02, null, 0.03] } },
  } as PoolVolume

  it('heads TVL with the TVL now and as it stood each window ago, each dated on hover', () => {
    const html = renderToStaticMarkup(<TvlSection nowUsd={20_000_000} ago={POOL.tvlAgo} points={[{ b: '2026-09-30', v: 1 }, { b: '2026-10-01', v: 2 }]} />)
    expect(html).toContain('<div class="sec-title">TVL</div>')
    expect(html.indexOf('$20M')).toBeLessThan(html.indexOf('>24H<'))
    expect(html).toContain('$19.9M')
    expect(html).toContain('title="TVL 24H ago · daily close 2026-10-01 00:00 UTC"')
    // A window before the pool's first close has no figure.
    expect(html).toContain('title="TVL 12M ago"')
    expect(html).toContain('data-zoom-key="ztvl"')
  })

  it('heads Volume / TVL with the 7D figure and the four windows, on the shared zoom', () => {
    const html = renderToStaticMarkup(<VolumeTvlSection d={POOL} />)
    expect(html).toContain('Volume / TVL')
    expect(html.indexOf('15.2%')).toBeLessThan(html.indexOf('>24H<'))
    for (const v of ['2.1%', '60.0%', '725.0%']) expect(html).toContain(v)
    expect(html).toContain('data-zoom-key="ztvl"')
    // Two non-null buckets are enough to draw; a single one is not.
    expect(renderToStaticMarkup(<VolumeTvlSection d={{ ...POOL, chart: { ...POOL.chart, series: { volumeTvl: [0.02, null, null] } } }} />)).toBe('')
  })
})
