import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { getBlockActivity, getDcaExecution, initExplorerService } from '../src/services/explorerService.ts'
import { resetCacheForTests } from '../src/services/cache.ts'
import type { ClickHouseClient } from '../src/db/client.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// One execution of schedule 37917 as block 15,027,912 holds it: the Router.Executed
// net summary at event 34, the DCA.TradeExecuted that settles it at event 35.
const HEIGHT = 15_027_912
const OWNER = `0x${'7c'.repeat(32)}`
const TS = '2026-09-25 16:56:12'
const AMOUNT_IN = '4110721252870312518628'
const AMOUNT_OUT = '4101081022'

const routerExecuted = {
  block_height: HEIGHT, ts: TS, event_index: 34, extrinsic_index: null, event_name: 'Router.Executed',
  args_json: JSON.stringify({ assetIn: 222, assetOut: 1000766, amountIn: AMOUNT_IN, amountOut: AMOUNT_OUT, eventId: 11285067 }),
}
const tradeExecuted = {
  block_height: HEIGHT, ts: TS, event_index: 35, extrinsic_index: null, event_name: 'DCA.TradeExecuted',
  id: '37917', who: OWNER, amount_in: AMOUNT_IN, amount_out: AMOUNT_OUT, error: '',
}

// Answers the two reads that carry the execution and its swap; every other read
// (extrinsics, prices, XCM, revenue, schedule links) is empty.
function fakeClient(): ClickHouseClient {
  return {
    query: async (opts: { query: string; query_params?: Record<string, unknown> }) => ({
      json: async () => {
        const q = opts.query
        if (q.includes('FROM price_data.raw_events') && q.includes("'Router.Executed'") && q.includes('extrinsic_index IS NULL')) return [routerExecuted]
        if (q.includes('FROM price_data.dca_events') && q.includes("'DCA.TradeExecuted'") && q.includes('block_height = {h:UInt32}')) {
          // getDcaExecution's nearest-following read: the execution at or after the
          // requested index, if any.
          const from = Number(opts.query_params?.i ?? 0)
          return tradeExecuted.event_index >= from ? [tradeExecuted] : []
        }
        if (q.includes('FROM price_data.dca_schedules') && q.includes('id = {sid:UInt64}')) {
          return [{ who: OWNER, asset_in: 222, asset_out: 1000766, direction: 'Sell', amount_per: AMOUNT_IN, period: 18 }]
        }
        return []
      },
    }),
  } as unknown as ClickHouseClient
}

// Every surface addresses one DCA execution by ONE event: its DCA.TradeExecuted (or
// TradeFailed) — the /dca/<block>-e<index> identity the schedule page links. The
// feeds used to key the same execution on the swap leg they paired it with, so
// the block page said e34 where the schedule page said e35, and two URLs named one
// fill.
describe('a DCA execution is identified by its execution event on every surface', () => {
  beforeEach(() => resetCacheForTests())

  it('keys the block page row on DCA.TradeExecuted, not the Router leg it was paired with', async () => {
    initExplorerService(fakeClient())
    const rows = (await getBlockActivity(HEIGHT, { revenue: false })).filter(r => r.dca)

    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('trade')
    expect(rows[0].eventIndex).toBe(35)
    expect(rows[0].dcaScheduleId).toBe(37917)
    // The leg still supplies the traded pair.
    expect(rows[0].assetIn?.assetId).toBe(222)
    expect(rows[0].assetOut?.assetId).toBe(1000766)
  })

  it('reports the execution event as the detail\'s own index, whichever index reached it', async () => {
    initExplorerService(fakeClient())
    // The canonical link and a link keyed on the swap leg name the same execution;
    // both learn its canonical index. One past the execution names nothing.
    expect((await getDcaExecution(HEIGHT, 35))?.eventIndex).toBe(35)
    expect((await getDcaExecution(HEIGHT, 34))?.eventIndex).toBe(35)
    expect(await getDcaExecution(HEIGHT, 36)).toBeNull()
  })
})

// The feed builders read ClickHouse in shapes a fake cannot answer cheaply, so the
// rule is pinned on their source: each keys its DCA rows on the execution event's
// index, and none mints the pre-unification `type: 'dca'` shape.
describe('every DCA row builder keys on the execution event', () => {
  // Module-level function bodies end at the first column-0 closing brace.
  const body = (name: string): string => {
    const start = explorerService.indexOf(`function ${name}(`)
    expect(start, name).toBeGreaterThan(-1)
    return explorerService.slice(start, start + explorerService.slice(start).indexOf('\n}\n'))
  }

  it('the trade feed (global activity)', () => {
    expect(body('getRecentTrades')).toContain('eventIndex: dcaHit ? dcaHit.event_index : rep.event_index')
  })

  it('the asset feed', () => {
    const asset = body('assetActivityPage')
    expect(asset).toContain('eventIndex: dcaHit ? dcaHit.event_index : rep.event_index')
    expect(asset).toContain('dcaScheduleId: dcaHit ? Number(dcaHit.id) || undefined : undefined')
  })

  it('the account and tag feeds', () => {
    const account = body('collectAccountActivity')
    expect(account).toContain('eventIndex: d.event_index, extrinsicIndex: null')
    expect(account).not.toContain('sw?.event_index')
  })

  it('the block page', () => {
    const block = body('getBlockHookActivity')
    expect(block).toContain('eventIndex: d.event_index,')
    expect(block).not.toContain('match?.row.event_index')
  })

  it('classifies an execution as a trade row carrying the dca flag everywhere', () => {
    expect(explorerService).not.toContain("type: 'dca'")
  })
})
