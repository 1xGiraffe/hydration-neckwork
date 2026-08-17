import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

// Contract + semantics tests for the pool volume endpoints and the volume
// service's pure parts. The per-fill netting and event-time valuation run inside
// ClickHouse (they have to: a 30-day window is hundreds of thousands of fills, so
// folding them in TS would mean streaming every fill per request), so the rules
// that live in SQL are pinned as SQL-text invariants here and measured against the
// live data lake in the task report. Everything the service does in TS — window
// anchoring, the netted routed total, response shaping — is pinned end to end.
type Row = Record<string, unknown>

function result(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const ASSET_ROWS: Row[] = [
  { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1, symbol: 'H2O', name: 'H2O', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: 0, origin_ecosystem: 'polkadot', origin_chain_id: '0', origin_asset_id: null },
  { asset_id: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1001, symbol: 'aDOT', name: 'aDOT', decimals: 10, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

/** The anchor probe's answer for a populated table. */
const ANCHOR_ROW: Row = { legs: '4200', anchor: '2026-08-12 18:22:36', block_height: 9123456 }
const ANCHOR_ISO = '2026-08-12T18:22:36.000Z'

interface Seen { query: string; params: Record<string, unknown> }

/**
 * Dispatches on the marker comment each built query carries, so a test names the
 * query it is answering rather than a fragment of its body.
 */
function fakeClient(byMarker: Record<string, Row[]> = {}) {
  const seen: Seen[] = []
  const client = {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      seen.push({ query, params: query_params ?? {} })
      if (query.includes('FROM price_data.assets FINAL')) return result(ASSET_ROWS)
      if (query.includes('Bonds.TokenCreated')) return result([])
      for (const [marker, rows] of Object.entries(byMarker)) {
        if (query.includes(marker)) return result(rows)
      }
      throw new Error(`unexpected query: ${query.slice(0, 160)}`)
    }),
  }
  return client
}

let stopAssets: () => void

beforeAll(async () => {
  const { loadExplorerAssets, stopExplorerAssetsRefresh } = await import('../../src/services/explorerAssets.ts')
  await loadExplorerAssets(fakeClient() as never)
  stopAssets = stopExplorerAssetsRefresh
})

afterAll(() => { stopAssets?.() })

async function buildApp(client: ReturnType<typeof fakeClient>): Promise<FastifyInstance> {
  const { buildPublicApp } = await import('../../src/public/app.ts')
  return buildPublicApp({ client: client as never, logger: false })
}

describe('nettedTradeScaled', () => {
  it('is the larger of the two boundary sides', async () => {
    const { nettedTradeScaled, scaledUsd } = await import('../../src/public/services/poolVolumes.ts')
    expect(nettedTradeScaled('100', '120')).toBe(scaledUsd('120'))
    expect(nettedTradeScaled('120.5', '120.25')).toBe(scaledUsd('120.5'))
    expect(nettedTradeScaled('0', '0')).toBe(0n)
  })

  it('compares at full Decimal(38,12) precision, never as floats', async () => {
    const { nettedTradeScaled, scaledUsd } = await import('../../src/public/services/poolVolumes.ts')
    // Two values that are the same IEEE double; the last digit decides.
    expect(nettedTradeScaled('9007199254740993.000000000001', '9007199254740993.000000000002'))
      .toBe(scaledUsd('9007199254740993.000000000002'))
    expect(nettedTradeScaled('0.000000000002', '0.000000000001')).toBe(2n)
  })

  it('answers at the full scale so a caller sums exactly, not in rounded cents', async () => {
    const { nettedTradeScaled, renderUsd } = await import('../../src/public/services/poolVolumes.ts')
    // Ten sub-cent trades are worth 4 cents together and nothing apart: the netting
    // rule must hand the caller the exact value, not the wire string.
    let total = 0n
    for (let i = 0; i < 10; i++) total += nettedTradeScaled('0.004000000000', '0.001')
    expect(renderUsd(total)).toBe('0.04')
  })
})

describe('renderUsd', () => {
  it('is the surface\'s 2-decimal wire form, rounded half-up', async () => {
    const { renderUsd, scaledUsd } = await import('../../src/public/services/poolVolumes.ts')
    // Same shape and rounding as the accounts service's formatUsd, so the two
    // halves of a stats response cannot publish USD in different precisions.
    expect(renderUsd(scaledUsd('232389.517003038334'))).toBe('232389.52')
    expect(renderUsd(scaledUsd('1.005'))).toBe('1.01')
    expect(renderUsd(scaledUsd('1.004999999999'))).toBe('1.00')
    expect(renderUsd(scaledUsd('1.5'))).toBe('1.50')
    expect(renderUsd(0n)).toBe('0.00')
    // A value below half a cent is not rendered as a signed zero.
    expect(renderUsd(scaledUsd('-0.001'))).toBe('0.00')
    expect(renderUsd(scaledUsd('-12.345'))).toBe('-12.35')
    // The whole part stays exact past IEEE range: no float on the path.
    expect(renderUsd(scaledUsd('9007199254740993.005'))).toBe('9007199254740993.01')
  })
})

describe('window anchor', () => {
  it('anchors on the newest indexed LEG, never on the newest block', async () => {
    const client = fakeClient({ '-- pub:vol:anchor': [ANCHOR_ROW] })
    const { readAnchor } = await import('../../src/public/services/poolVolumes.ts')
    expect(await readAnchor(client as never)).toEqual({ anchor: '2026-08-12 18:22:36', blockHeight: 9123456 })
    const [{ query }] = client.seen
    // A block is indexed before the MV has projected its legs. Anchoring on the
    // blocks head would stretch every rolling window over hours that hold no
    // legs yet and publish that undercount as a full window, so the anchor is
    // the leg model's own head and the height is the block that leg sits in.
    // This test exists because that is exactly the drift that once happened here.
    expect(query).toContain('WITH (SELECT max(block_timestamp) FROM price_data.pool_swap_legs) AS leg_head')
    expect(query).toContain('(SELECT max(block_height) FROM price_data.pool_swap_legs WHERE block_timestamp = leg_head)')
    expect(query).not.toContain('FROM price_data.blocks')
  })

  it('reports no anchor at all for an empty leg model', async () => {
    const client = fakeClient({ '-- pub:vol:anchor': [{ legs: '0', anchor: '1970-01-01 00:00:00', block_height: 0 }] })
    const { readAnchor } = await import('../../src/public/services/poolVolumes.ts')
    // Never 1970: an empty model has no window, rather than one starting at the epoch.
    expect(await readAnchor(client as never)).toBeNull()
  })
})

describe('volume SQL invariants', () => {
  it('deduplicates the replaceable leg identity before any sum', async () => {
    const { buildOmnipoolVolumeSql, buildPoolVolumeSql, buildRoutedTradesSql } = await import('../../src/public/services/poolVolumes.ts')
    for (const sql of [buildOmnipoolVolumeSql(), buildPoolVolumeSql(), buildRoutedTradesSql()]) {
      // pool_swap_legs is ReplacingMergeTree(ingested_at): a replayed range inserts
      // a second copy of every leg, so the newest copy per leg identity has to win
      // BEFORE the amounts are summed. The identity is the table's ORDER BY.
      expect(sql).toMatch(/GROUP BY venue, pool_key, block_height, event_index, leg_kind, leg_index/)
      expect(sql).toMatch(/argMax\(amount, ingested_at\)/)
      expect(sql).toMatch(/argMax\(asset_id, ingested_at\)/)
    }
  })

  it('reads the window exactly once — every stage is referenced by one other stage', async () => {
    const { buildOmnipoolVolumeSql, buildPoolVolumeSql, buildRoutedTradesSql } = await import('../../src/public/services/poolVolumes.ts')
    const { buildOmnipoolYieldSql, buildStableswapYieldSql } = await import('../../src/public/services/poolYield.ts')
    // ClickHouse inlines a CTE at EVERY reference and re-reads it there. Naming
    // `priced` three times cost three windowed scans, three deduplications and
    // three ASOF price joins of the same rows — measured 7x for the Omnipool
    // volumes query before this was restructured into one linear chain.
    const references = (sql: string, cte: string): number =>
      (sql.match(new RegExp(`\\b${cte}\\b`, 'g')) ?? []).length - (sql.includes(`${cte} AS (`) ? 1 : 0)
    const chains: Array<[string, string[]]> = [
      [buildOmnipoolVolumeSql(), ['legs', 'priced', 'fill_asset', 'fill', 'flagged', 'emitted']],
      [buildPoolVolumeSql(), ['legs', 'priced', 'fill']],
      [buildRoutedTradesSql(), ['legs', 'priced', 'fill_asset', 'fill', 'flagged', 'keyed', 'netted']],
      [buildOmnipoolYieldSql(), ['legs', 'fill', 'emitted', 'fee_by_asset']],
      [buildStableswapYieldSql(), ['legs', 'priced', 'sample_legs', 'sample_tvl']],
    ]
    for (const [sql, ctes] of chains) {
      for (const cte of ctes) expect([cte, references(sql, cte)]).toEqual([cte, 1])
    }
  })

  it('values a fill by its out side and falls back to its in side', async () => {
    const { buildOmnipoolVolumeSql, buildPoolVolumeSql } = await import('../../src/public/services/poolVolumes.ts')
    for (const sql of [buildOmnipoolVolumeSql(), buildPoolVolumeSql()]) {
      expect(sql).toContain('if(out_usd > 0, out_usd, in_usd)')
    }
  })

  it('excludes the LRNA hub leg from omnipool per-asset volume', async () => {
    const { buildOmnipoolVolumeSql } = await import('../../src/public/services/poolVolumes.ts')
    const sql = buildOmnipoolVolumeSql()
    // The hub asset is dropped from the per-asset detail the fill carries…
    expect(sql).toContain('asset_id != 1) AS asset_parts')
    // …and its fee leg is kept apart as the protocol fee.
    expect(sql).toContain('sumIf(leg_fee_usd, asset_id = 1) AS hub_fee_usd')
  })

  it('groups routed legs by the router operation and unrouted fills by themselves', async () => {
    const { buildRoutedTradesSql } = await import('../../src/public/services/poolVolumes.ts')
    const sql = buildRoutedTradesSql()
    // An unrouted fill keys on its own (block_height, event_index) — never on the
    // extrinsic (a batch carries several independent trades) and never into one
    // shared bucket (which would net a third of all fills against each other).
    expect(sql).toContain("if(op_key != ''")
    expect(sql).toContain("concat('r:', toString(block_height), ':', op_key)")
    expect(sql).toContain("concat('f:', toString(block_height)")
    expect(sql).not.toContain('extrinsic_index')
  })

  it('folds an Omnipool hub hop into the fill that completes the swap', async () => {
    const { buildOmnipoolVolumeSql, buildRoutedTradesSql } = await import('../../src/public/services/poolVolumes.ts')
    // The Omnipool emits A→LRNA and LRNA→B as two fills of one user swap, so a
    // count of trades that took each fill for a trade would double the venue.
    for (const sql of [buildOmnipoolVolumeSql(), buildRoutedTradesSql()]) {
      expect(sql).toContain('out_hub = 1 AND next_in_hub = 1 AND next_event_index = event_index + 1')
      expect(sql).toContain('ROWS BETWEEN 1 FOLLOWING AND 1 FOLLOWING')
    }
    // …and only where both fills are the venue that has a hub.
    expect(buildRoutedTradesSql()).toContain("venue = 'omnipool' AND next_venue = 'omnipool'")
  })

  it('prices every leg at a candle that had closed before the fill', async () => {
    const { buildOmnipoolVolumeSql } = await import('../../src/public/services/poolVolumes.ts')
    const sql = buildOmnipoolVolumeSql()
    expect(sql).toContain('interval_start + INTERVAL 1 HOUR AS price_time')
    expect(sql).toContain('p.price_time <= l.block_time')
    expect(sql).toContain('ASOF LEFT JOIN')
  })
})

describe('omnipoolVolumes', () => {
  it('splits per-asset rows from the single-counted venue total and anchors on the source', async () => {
    const client = fakeClient({
      '-- pub:vol:anchor': [ANCHOR_ROW],
      '-- pub:vol:omnipool': [
        { scope: 'asset', asset_id: '5', volume_usd: '1000.500000000000', fee_usd: '2.250000000000', protocol_fee_usd: '0.750000000000' },
        { scope: 'asset', asset_id: '222', volume_usd: '900.000000000000', fee_usd: '1.000000000000', protocol_fee_usd: '0.000000000000' },
        { scope: 'total', asset_id: '', volume_usd: '1500.000000000000', fee_usd: '0.000000000000', protocol_fee_usd: '0.000000000000' },
      ],
    })
    const { omnipoolVolumes } = await import('../../src/public/services/poolVolumes.ts')
    const out = await omnipoolVolumes(client as never, '1h')
    expect(out).toEqual({
      asOf: ANCHOR_ISO,
      blockHeight: 9123456,
      // Single-counted per fill: NOT the sum of the per-asset rows, which carry
      // both sides of every fill.
      totalVolumeUsd: '1500.00',
      items: [
        { assetId: '5', volumeUsd: '1000.50', feeUsd: '2.25', protocolFeeUsd: '0.75' },
        { assetId: '222', volumeUsd: '900.00', feeUsd: '1.00', protocolFeeUsd: '0.00' },
      ],
    })
    const main = client.seen.find(s => s.query.includes('-- pub:vol:omnipool'))!
    expect(main.params.hours).toBe(1)
    expect(main.params.anchor).toBe('2026-08-12 18:22:36')
  })

  it('reports no data instead of a 1970 anchor when the model is empty', async () => {
    const client = fakeClient({ '-- pub:vol:anchor': [{ legs: '0', anchor: '1970-01-01 00:00:00', block_height: 0 }] })
    const { omnipoolVolumes } = await import('../../src/public/services/poolVolumes.ts')
    const out = await omnipoolVolumes(client as never, '7d')
    expect(out).toEqual({ asOf: null, blockHeight: null, totalVolumeUsd: '0.00', items: [] })
    // The windowed scan is not even issued: there is nothing to scan.
    expect(client.seen.some(s => s.query.includes('-- pub:vol:omnipool'))).toBe(false)
  })
})

describe('routedTradesUsd', () => {
  it('nets each routed trade to one side before summing', async () => {
    const client = fakeClient({
      '-- pub:vol:anchor': [ANCHOR_ROW],
      '-- pub:vol:routed': [
        { in_usd: '100.000000000000', out_usd: '99.500000000000' },
        { in_usd: '10.000000000000', out_usd: '10.250000000000' },
      ],
    })
    const { routedTradesUsd } = await import('../../src/public/services/poolVolumes.ts')
    // 100 (in wins) + 10.25 (out wins), summed at full scale and rounded once
    expect(await routedTradesUsd(client as never, '1h')).toEqual({ asOf: ANCHOR_ISO, blockHeight: 9123456, totalUsd: '110.25' })
  })
})

describe('GET /v1/pools/:venue/volumes', () => {
  it('serves omnipool per-asset volumes with the venue cache header', async () => {
    const client = fakeClient({
      '-- pub:vol:anchor': [ANCHOR_ROW],
      '-- pub:vol:omnipool': [
        { scope: 'asset', asset_id: '5', volume_usd: '1000.500000000000', fee_usd: '2.250000000000', protocol_fee_usd: '0.750000000000' },
        { scope: 'total', asset_id: '', volume_usd: '1000.500000000000', fee_usd: '0.000000000000', protocol_fee_usd: '0.000000000000' },
      ],
    })
    const app = await buildApp(client)
    try {
      const res = await app.inject('/v1/pools/omnipool/volumes?period=30d')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        period: '30d',
        asOf: ANCHOR_ISO,
        items: [{ assetId: '5', volumeUsd: '1000.50', feeUsd: '2.25', protocolFeeUsd: '0.75' }],
      })
      expect(res.headers['cache-control']).toBe('public, max-age=60')
    } finally { await app.close() }
  })

  it('serves stableswap volumes keyed by pool id', async () => {
    const client = fakeClient({
      '-- pub:vol:anchor': [ANCHOR_ROW],
      '-- pub:vol:pool': [{ pool_key: '690', volume_usd: '12.000000000000', fee_usd: '0.001200000000' }],
    })
    const app = await buildApp(client)
    try {
      const res = await app.inject('/v1/pools/stableswap/volumes?period=24h')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        period: '24h',
        asOf: ANCHOR_ISO,
        // USD goes out at 2 decimals, so a sub-cent fee reads 0.00 — the wire's
        // resolution, not a lost value: the full-scale amount was rounded once here.
        items: [{ poolId: '690', volumeUsd: '12.00', feeUsd: '0.00' }],
      })
      const main = client.seen.find(s => s.query.includes('-- pub:vol:pool'))!
      expect(main.params.venue).toBe('stableswap')
      expect(main.params.hours).toBe(24)
    } finally { await app.close() }
  })

  it('serves xyk volumes with the pair the pool account trades, filtered by ?pools', async () => {
    const poolA = `0x${'a'.repeat(64)}`
    const poolB = `0x${'b'.repeat(64)}`
    const client = fakeClient({
      '-- pub:vol:anchor': [ANCHOR_ROW],
      '-- pub:vol:pool': [
        { pool_key: poolA, volume_usd: '5.000000000000', fee_usd: '0.015000000000' },
        { pool_key: poolB, volume_usd: '3.000000000000', fee_usd: '0.009000000000' },
      ],
      '-- pub:vol:xyk-pools': [
        { pool_account: poolA, lp_asset_id: 123, asset_a: 0, asset_b: 5, created_block: 10 },
        // The account was reused after a destroy/recreate: the newest row wins.
        { pool_account: poolA, lp_asset_id: 456, asset_a: 0, asset_b: 222, created_block: 99 },
      ],
    })
    const app = await buildApp(client)
    try {
      const res = await app.inject(`/v1/pools/xyk/volumes?period=7d&pools=${poolA}`)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        period: '7d',
        asOf: ANCHOR_ISO,
        // 0.015 rounds half-UP to 0.02, the same rule formatUsd applies.
        items: [{ poolAccount: poolA, shareTokenId: '456', assetA: '0', assetB: '222', volumeUsd: '5.00', feeUsd: '0.02' }],
      })
    } finally { await app.close() }
  })

  it('rejects a period outside the enum and the unbounded all-time window', async () => {
    const client = fakeClient({ '-- pub:vol:anchor': [ANCHOR_ROW] })
    const app = await buildApp(client)
    try {
      for (const period of ['2h', 'all', '1y', '']) {
        const res = await app.inject(`/v1/pools/omnipool/volumes?period=${period}`)
        expect(res.statusCode, period).toBe(400)
        expect(res.json().error.code).toBe('bad_request')
      }
      const unknownVenue = await app.inject('/v1/pools/nowhere/volumes')
      expect(unknownVenue.statusCode).toBe(404)
    } finally { await app.close() }
  })
})
