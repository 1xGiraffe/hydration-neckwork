import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Oracles } from '../src/pages/Oracles'
import { splitFeeds } from '../src/pages/oraclesModel'
import { OracleFeed } from '../src/pages/OracleFeed'
import { chartSeries, fmtChangePct } from '../src/pages/oracleFeedModel'
import { NAV_CONFIG } from '../src/components/navConfig'
import { parseRoute, paths } from '../src/router'
import { fmtRatio, isUsdPair, ageNow, KIND_LABEL } from '../src/components/oracleFormat'
import type { OracleFeedDetail, OracleFeedRow, OraclesOverview, OracleSourceRef } from '../src/api/oracles'

// The oracle pages: the nav entry and routes, the feed fold (live or read by
// something is shown, the rest folds), and the render contract of both pages on
// a deterministic payload shaped like the API's.

const DOT = { assetId: 5, iconAssetId: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachainId: null }
const VDOT = { assetId: 15, iconAssetId: 15, symbol: 'vDOT', name: 'Bifrost Voucher DOT', decimals: 10, parachainId: 2030 }
const acct = { accountId: '0x4554480033a5e905fb83fcfb62b0dd1595dfbc06792e054e0000000000000000', address: '0x33a5e905fb83fcfb62b0dd1595dfbc06792e054e', emoji: '🦏', tag: null, identity: null }
const cadence = { updates24h: 52, updates7d: 442, updates30d: 1733, medianIntervalSec: 960, longestGapSec: 17760, staleAfterSec: 19536 }

const diaSrc: OracleSourceRef = { address: '0xfbca0a6dc5b74c042df23025d99ef0f1fcac6702', kind: 'dia', label: 'DOT/USD', feedId: 'dia:0xdee629af973ebf5bf261ace12ffd1900ac715f5e:DOT/USD', provider: 'DIA', value: '1.18446611', updatedAt: '2026-10-02T18:22:12.000Z', ageSec: 508, status: 'live', note: null }
const emaSrc: OracleSourceRef = { address: '0x00000102626966726f73746f000000050000000f', kind: 'ema', label: 'Bifrost vDOT/DOT · TenMinutes', feedId: 'ema:bifrosto:5-15', provider: 'Bifrost', value: '1.66252691', updatedAt: '2026-10-02T17:50:24.000Z', ageSec: 2416, status: 'live', note: null }

const feed = (over: Partial<OracleFeedRow>): OracleFeedRow => ({
  feedId: 'dia:0xdee629af973ebf5bf261ace12ffd1900ac715f5e:DOT/USD', kind: 'dia', pair: 'DOT/USD', provider: 'DIA', contract: '0xdee629af973ebf5bf261ace12ffd1900ac715f5e',
  decimals: 8, latestValue: '1.18446611', updatedAt: '2026-10-02T18:22:12.000Z', ageSec: 508, status: 'live', cadence, allTimeUpdates: 34832,
  firstUpdateAt: '2024-07-12T08:06:18.000Z', pushers: [{ account: acct, updates: 200 }], relays: [],
  consumers: [{ kind: 'reserve', market: 'core', marketLabel: 'Money Market', asset: DOT, via: diaSrc.address, depth: 0 }], ...over,
})

const OVERVIEW: OraclesOverview = {
  asOf: { liveReadAt: '2026-10-02T18:30:08.000Z', liveBlock: 15311627, indexedHead: 15311626, now: '2026-10-02T18:30:40.000Z' },
  history: { logsComplete: true, emaComplete: true, emaCoveredFrom: '2026-09-02T18:30:36.000Z' },
  kpis: { liveFeeds: 19, staleFeeds: 0, staleUnused: 4, stale: [{ feedId: '0x6e3e', pair: 'PRIME/USD', consumed: false }], updates24h: 434, largestDeviation: { asset: VDOT, market: 'core', deviationPct: -2.84 } },
  markets: [
    {
      key: 'core', label: 'Money Market', oracle: '0xad33c0f0c42c5a0eaa65b5895d2bdb20cb6e8760', fallbackOracle: null, reserves: [
        { asset: DOT, reserve: '0x0000000000000000000000000000000100000005', oraclePrice: '1.18446611', marketPrice: 1.19113641, marketNote: null, deviationPct: -0.56, source: diaSrc },
        { asset: VDOT, reserve: '0x000000000000000000000000000000010000000f', oraclePrice: '1.96920678', marketPrice: 1.97891342, marketNote: null, deviationPct: -0.49,
          source: { address: '0x2ffa376e0a84606e4ccb3738071312a34cebad6c', kind: 'composite', label: 'Bifrost vDOT/DOT · TenMinutes × DOT/USD', feedId: null, provider: null, value: '1.96920678', updatedAt: emaSrc.updatedAt, ageSec: 2416, status: 'live', note: 'Answers the product of its two inputs.', components: [emaSrc, diaSrc] } },
      ],
    },
    { key: 'gigahdx', label: 'GIGAHDX', oracle: '0xce5bb65e09f69c038b1f1ea447eedbf1c365afcc', fallbackOracle: null, reserves: [] },
  ],
  pegs: [],
  feeds: [
    feed({}),
    feed({ feedId: '0x6e3e9403cf486af5f2ce0a6b3d7a23ee0e6bc84e', kind: 'push', pair: 'PRIME/USD', provider: 'Relay', contract: '0x6e3e9403cf486af5f2ce0a6b3d7a23ee0e6bc84e', status: 'stale', consumers: [] }),
    feed({ feedId: '0xe50aa7afa36a5e04c0b0d0892d0b173c924b662f', kind: 'push', pair: 'SIGIL/USD', provider: 'Direct', contract: '0xe50aa7afa36a5e04c0b0d0892d0b173c924b662f', status: 'static', allTimeUpdates: 1, consumers: [] }),
  ],
  ema: [{ source: 'bifrosto', label: 'Bifrost', updates24h: 22, pairs24h: 1, pairs: 1, newestAt: '2026-10-02T17:50:24.000Z', newestAgeSec: 2416, daily: Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, count: 22 })), pairRows: [] }],
  changes: [],
  rules: { cadenceSpanSec: 2_592_000, retiredAfterSec: 2_592_000, minGraceSec: 900, fallbackHeartbeatSec: 86_400 },
}

const render = (node: React.ReactNode, data?: (qc: QueryClient) => void) => {
  const qc = new QueryClient()
  data?.(qc)
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('oracle routes and nav', () => {
  it('parses /oracles and every /oracle/:feed form, a DIA key slash included', () => {
    expect(parseRoute('/oracles')).toEqual({ name: 'oracles' })
    expect(parseRoute('/oracle/ema:bifrosto:5-15')).toEqual({ name: 'oracle', feed: 'ema:bifrosto:5-15' })
    expect(parseRoute('/oracle/dia:0xdee629af973ebf5bf261ace12ffd1900ac715f5e:DOT%2FUSD')).toEqual({ name: 'oracle', feed: 'dia:0xdee629af973ebf5bf261ace12ffd1900ac715f5e:DOT/USD' })
    expect(parseRoute('/oracle/dia:0xdee629af973ebf5bf261ace12ffd1900ac715f5e:DOT/USD')).toEqual({ name: 'oracle', feed: 'dia:0xdee629af973ebf5bf261ace12ffd1900ac715f5e:DOT/USD' })
    expect(parseRoute('/oracle')).toEqual({ name: 'oracles' })
    expect(paths.oracle('dia:0xdee6:DOT/USD')).toBe('/oracle/dia:0xdee6:DOT%2FUSD')
    expect(parseRoute(paths.oracle('dia:0xdee6:DOT/USD'))).toEqual({ name: 'oracle', feed: 'dia:0xdee6:DOT/USD' })
  })

  it('lists Oracles under Assets right after Volume, in the folded menu and the drawer too', () => {
    const { ASSETS_GROUP, ASSETS_FOLD_GROUP, DRAWER_LINKS } = NAV_CONFIG
    for (const list of [ASSETS_GROUP.items, ASSETS_GROUP.menuItems!, ASSETS_FOLD_GROUP.items, ASSETS_FOLD_GROUP.menuItems!, DRAWER_LINKS]) {
      const labels = list.map(i => i.label)
      expect(labels[labels.indexOf('Volume') + 1]).toBe('Oracles')
    }
    const item = ASSETS_GROUP.items.find(i => i.label === 'Oracles')!
    expect(item.to).toBe('/oracles')
    expect(item.match).toEqual(['oracles', 'oracle'])
  })
})

describe('feed fold', () => {
  it('shows live feeds and stale ones something reads; folds the rest', () => {
    const { shown, folded } = splitFeeds([
      feed({ status: 'live' }), feed({ feedId: 'a', status: 'stale' }), feed({ feedId: 'b', status: 'stale', consumers: [] }),
      feed({ feedId: 'c', status: 'retired' }), feed({ feedId: 'd', status: 'static', consumers: [] }),
    ])
    expect(shown.map(f => f.status)).toEqual(['live', 'stale'])
    expect(folded.map(f => f.feedId)).toEqual(['b', 'c', 'd'])
  })
})

describe('formatting', () => {
  it('reads a USD pair as a price and keeps a ratio at oracle precision', () => {
    expect(isUsdPair('DOT/USD')).toBe(true)
    expect(isUsdPair('BIL / USD')).toBe(true)
    expect(isUsdPair('jitoSOL/SOL')).toBe(false)
    expect(fmtRatio(1.30417056)).toBe('1.3042')
    expect(fmtRatio(0.00746577)).toBe('0.007466')
    expect(fmtRatio(84585.67)).toBe('84,585.67')
  })
  it('neither draws nor legends a series with no point in the window', () => {
    const chart = { range: '30d' as const, stepSec: 3600, buckets: ['a', 'b'], series: [{ key: 'value', label: 'ETH/USD', values: [1, 2] }, { key: 'market', label: 'Market GETH', values: [null, null] }] }
    expect(chartSeries(chart).map(s => s.key)).toEqual(['value'])
    expect(chartSeries(null)).toEqual([])
  })
  it('labels a read-through adapter for what it is', () => {
    expect(KIND_LABEL.computed).toBe('Computed on call')
  })
  it('keeps a tiny rate step visible instead of +0.00%', () => {
    expect(fmtChangePct(0.0037)).toBe('+0.0037%')
    expect(fmtChangePct(-0.7993)).toBe('-0.80%')
    expect(fmtChangePct(0)).toBe('+0.00%')
  })
  it('ages a payload figure by the time since it was built', () => {
    expect(ageNow(100, '2026-10-02T18:30:40.000Z', Date.parse('2026-10-02T18:31:40.000Z'))).toBe(160)
    expect(ageNow(null, null, 0)).toBeNull()
  })
})

describe('/oracles page', () => {
  it('renders the head, the KPI cards, the market tabs and every section', () => {
    const html = render(<Oracles />, qc => qc.setQueryData(['oracles'], OVERVIEW))
    expect(html).toContain('19 feeds live · 0 stale in use · 434 updates in the last 24H')
    for (const k of ['Live feeds', 'Stale feeds', 'Updates · 24H', 'Largest deviation']) expect(html).toContain(k)
    expect(html).toContain('vDOT -2.84%')
    // Only markets with reserves get a tab; one market alone needs no seg-bar.
    expect(html).not.toContain('aria-label="Market"')
    for (const s of ['Money market prices', 'Push feeds', 'On-chain EMA oracle', 'Source changes']) expect(html).toContain(s)
    // The composite names its inputs, each linked to its own feed.
    expect(html).toContain('Composite')
    expect(html).toContain('/oracle/ema:bifrosto:5-15')
    expect(html).toContain('/oracle/dia:0xdee629af973ebf5bf261ace12ffd1900ac715f5e:DOT%2FUSD')
    // Unused stale and never-updated feeds fold behind one line.
    expect(html).toContain('2 retired, never-updated or unused feeds')
    expect(html).not.toContain('SIGIL/USD')
    // The rule is stated.
    expect(html).toContain('heartbeat + grace')
  })
})

describe('/oracle/:feed page', () => {
  it('renders a DIA key with its cadence, consumers, chart and updates', () => {
    const detail: OracleFeedDetail = {
      feedId: feed({}).feedId, kind: 'dia', label: 'DOT/USD', provider: 'DIA', contract: '0xdee629af973ebf5bf261ace12ffd1900ac715f5e', key: 'DOT/USD', decimals: 8,
      latestValue: '1.18446611', updatedAt: '2026-10-02T18:22:12.000Z', ageSec: 508, reportedAt: '2026-10-02T18:22:18.000Z', status: 'live', cadence,
      allTimeUpdates: 34832, firstUpdateAt: '2024-07-12T08:06:18.000Z', pushers: [{ account: acct, updates: 200 }], relays: [],
      consumers: feed({}).consumers, subject: { asset: DOT, quote: null }, source: null, ema: null,
      chart: { range: '30d', stepSec: 14_400, buckets: ['2026-10-02 08:00:00', '2026-10-02 12:00:00', '2026-10-02 16:00:00'], series: [{ key: 'value', label: 'DOT/USD', values: [1.22, 1.21, 1.18] }, { key: 'market', label: 'Market DOT', values: [1.22, 1.21, 1.19] }] },
      updates: { rows: [{ blockHeight: 15311401, eventIndex: 7, extrinsicIndex: 2, timestamp: '2026-10-02T18:22:12.000Z', value: '1.18446611', changePct: -0.7993, intervalSec: 240, reportedAt: '2026-10-02T18:22:18.000Z', pusher: acct }], total: 34832, page: 0, pageSize: 25, complete: true },
      historyComplete: true,
    }
    const html = render(<OracleFeed feed={detail.feedId} />, qc => qc.setQueryData(['oracle', detail.feedId, '30d', 0], detail))
    expect(html).toContain('DOT/USD')
    expect(html).toContain('DIA key')
    expect(html).toContain('52 · 24H')
    expect(html).toContain('-0.80%')
    expect(html).toContain('34,832 in all, newest first')
    for (const r of ['7D', '30D', '12M', 'All']) expect(html).toContain(`>${r}<`)
  })
})
