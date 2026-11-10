import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_BALANCE_WEEKLY_CLOSE, HDX_CLOSES_TOUCHED_REBUILD_MS, closesAssets, hdxClosesFor, hdxClosesParams, hdxWeeklyCloseRowsSql, initHdxWeeklyCloses, refreshHdxWeeklyCloses,
} from '../src/services/hdxWeeklyCloses.ts'

const views = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')
const schema = readFileSync(new URL('../../clickhouse/schema/024_hdx_weekly_closes.sql', import.meta.url), 'utf8')

describe('the weekly closes the /hdx history reads', () => {
  it('states the weeks from the cut on by account_balance_weekly_mv\'s own close', () => {
    const mv = views.split('\n').find(l => l.includes('VIEW IF NOT EXISTS price_data.account_balance_weekly_mv '))!
    expect(mv).toContain(`argMaxState(${ACCOUNT_BALANCE_WEEKLY_CLOSE.slice('argMax('.length)} AS balance_state`)
    expect(mv).toContain("WHERE (account_id != '') AND (asset_id != '')")
    expect(mv).toContain('toMonday(block_timestamp) AS week_start')
  })

  it('reads the generation before its cut and raw from the cut, the filter inside both', () => {
    const sql = hdxWeeklyCloseRowsSql("asset_id = '0'")
    const [snapshot, raw] = sql.split('UNION ALL')
    expect(snapshot).toContain('FROM price_data.hdx_weekly_closes')
    expect(snapshot).toContain('snapshot_id = {closesGen:String} AND week_start < {closesCut:Date}')
    expect(raw).toContain('FROM price_data.raw_balance_observations')
    // the block bound prunes by primary key; the timestamp bound is the exact one
    expect(raw).toContain('block_height > {closesCutHeight:UInt32} AND block_timestamp >= toDateTime({closesCut:Date})')
    expect(raw).toContain("account_id != '' AND asset_id IN {closesAssets:Array(String)}")
    expect(raw).toContain('GROUP BY account_id, asset_id, week_start')
    expect(sql.match(/AND \(asset_id = '0'\)/g)).toHaveLength(2)
  })

  it('always covers HDX, once per asset', () => {
    expect(closesAssets([])).toEqual(['0'])
    expect(closesAssets(['1000013', '1000010', '1000013'])).toEqual(['0', '1000010', '1000013'])
  })

  it('declares a marks view with nothing that can throw on the weekly table\'s inserts', () => {
    const mv = schema.split('\n').find(l => l.includes('VIEW IF NOT EXISTS price_data.account_balance_weekly_marks_mv'))!
    expect(mv).toContain('SELECT week_start, max(now()) AS inserted_at FROM price_data.account_balance_weekly GROUP BY week_start')
  })
})

// A fake ClickHouse holding the pointer, the marks and the generations' partitions.
function fakeClickHouse() {
  const state = {
    pointer: null as null | Record<string, unknown>,
    clock: { cut: '2026-11-09', source_at: '2026-11-10 12:00:00', cut_height: 16787098 },
    touched: 0,
    partitions: new Set<string>(),
    builds: [] as { assets: string[]; cut: string }[],
    dropped: [] as string[],
    queries: [] as string[],
  }
  const json = (rows: unknown[]) => ({ json: async () => rows })
  const client = {
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      state.queries.push(query)
      if (query.includes('hdx:closes-pointer')) return json(state.pointer ? [{ ...state.pointer, n: 1 }] : [{ snapshot_id: '', n: 0 }])
      if (query.includes('hdx:closes-marks')) return json([{ cut: state.clock.cut, touched: state.touched }])
      if (query.includes('hdx:closes-cut')) return json([state.clock])
      if (query.includes('hdx:closes-count')) return json([{ n: state.partitions.has(String(query_params!.snapshotId)) ? 360_000 : 0 }])
      if (query.includes('FROM system.parts')) return json([...state.partitions].filter(p => !(query_params!.keep as string[]).includes(p)).map(partition => ({ partition })))
      throw new Error(`unexpected query ${query}`)
    },
    command: async ({ query, query_params }: { query: string; query_params: Record<string, unknown> }) => {
      if (query.includes('INSERT INTO price_data.hdx_weekly_closes')) {
        state.builds.push({ assets: query_params.assets as string[], cut: String(query_params.cut) })
        state.partitions.add(String(query_params.snapshotId))
        return { summary: { written_rows: '360000' } }
      }
      if (query.includes('DROP PARTITION')) {
        state.dropped.push(String(query_params.partition))
        state.partitions.delete(String(query_params.partition))
        return {}
      }
      throw new Error(`unexpected command ${query}`)
    },
    insert: async ({ values }: { values: Record<string, unknown>[] }) => {
      state.pointer = { ...values[0], cut: String(values[0].cut), source_at: String(values[0].source_at) }
    },
  }
  return { state, client }
}

describe('weekly-close generations', () => {
  let ch: ReturnType<typeof fakeClickHouse>
  let now = Date.parse('2026-11-10T12:00:00Z')
  const later = () => { now += HDX_CLOSES_TOUCHED_REBUILD_MS }
  beforeEach(() => {
    ch = fakeClickHouse()
    initHdxWeeklyCloses(ch.client as never, ch.client as never)
    vi.spyOn(Date, 'now').mockImplementation(() => now++)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('builds the first generation on the first read, keeping each series\' changes only', async () => {
    const g = await hdxClosesFor(['0'])
    expect(ch.state.builds).toEqual([{ assets: ['0'], cut: '2026-11-09' }])
    expect(g).toMatchObject({ cut: '2026-11-09', cutHeight: 16787098, sourceAt: '2026-11-10 12:00:00', assets: ['0'] })
    expect(hdxClosesParams(g)).toEqual({ closesGen: g.snapshotId, closesCut: '2026-11-09', closesCutHeight: 16787098, closesAssets: ['0'] })
    // the pointer is written only after the rows are in, and names them
    expect(ch.state.pointer).toMatchObject({ snapshot_key: 'current', snapshot_id: g.snapshotId, row_count: 360_000 })
    // a second read answers from the generation in hand
    const queries = ch.state.queries.length
    expect(await hdxClosesFor(['0'])).toBe(g)
    expect(ch.state.queries).toHaveLength(queries)
  })

  it('reads a stored generation without building, and builds one that covers a new bond', async () => {
    ch.state.pointer = { snapshot_id: '1794000000000-a', cut: '2026-11-09', cut_height: 1, source_at: '2026-11-10 12:00:00', assets: ['0'] }
    expect((await hdxClosesFor(['0'])).snapshotId).toBe('1794000000000-a')
    expect(ch.state.builds).toHaveLength(0)
    const g = await hdxClosesFor(closesAssets(['1000010']))
    expect(ch.state.builds).toEqual([{ assets: ['0', '1000010'], cut: '2026-11-09' }])
    expect(g.assets).toEqual(['0', '1000010'])
  })

  it('never hands a reader a concurrent build that lacks its assets', async () => {
    const [hdxOnly, withBonds] = await Promise.all([hdxClosesFor(['0']), hdxClosesFor(closesAssets(['1000010', '1000013']))])
    expect(hdxOnly.assets).toContain('0')
    expect(withBonds.assets).toEqual(['0', '1000010', '1000013'])
  })

  it('rebuilds only when a week closed, an insert landed before the cut, or a bond is missing', async () => {
    await hdxClosesFor(['0'])
    expect(await refreshHdxWeeklyCloses([])).toBe('unchanged')
    ch.state.touched = 1
    // an insert below the cut rebuilds, at most once per interval
    expect(await refreshHdxWeeklyCloses([])).toBe('unchanged')
    later()
    expect(await refreshHdxWeeklyCloses([])).toBe('rebuilt')
    ch.state.touched = 0
    expect(await refreshHdxWeeklyCloses([])).toBe('unchanged')
    ch.state.clock = { ...ch.state.clock, cut: '2026-11-16' }
    expect(await refreshHdxWeeklyCloses([])).toBe('rebuilt')
    expect(ch.state.builds.at(-1)).toEqual({ assets: ['0'], cut: '2026-11-16' })
    expect(await refreshHdxWeeklyCloses(['1000010'])).toBe('rebuilt')
    expect(ch.state.builds.at(-1)!.assets).toEqual(['0', '1000010'])
    // a generation's assets never shrink when the registry has not loaded the bonds yet
    ch.state.clock = { ...ch.state.clock, cut: '2026-11-23' }
    await refreshHdxWeeklyCloses([])
    expect(ch.state.builds.at(-1)!.assets).toEqual(['0', '1000010'])
  })

  it('keeps the generation readers held until the next one is published', async () => {
    const first = await hdxClosesFor(['0'])
    ch.state.touched = 1
    later()
    await refreshHdxWeeklyCloses([])
    const second = (await hdxClosesFor(['0'])).snapshotId
    expect(ch.state.partitions).toEqual(new Set([first.snapshotId, second]))
    later()
    await refreshHdxWeeklyCloses([])
    expect(ch.state.dropped).toEqual([first.snapshotId])
    expect(ch.state.partitions.has(second)).toBe(true)
  })

  it('publishes nothing when the generation\'s rows did not all land', async () => {
    ch.client.command = async () => ({ summary: { written_rows: '5' } }) as never
    await expect(hdxClosesFor(['0'])).rejects.toThrow(/incomplete/)
    expect(ch.state.pointer).toBeNull()
  })
})
