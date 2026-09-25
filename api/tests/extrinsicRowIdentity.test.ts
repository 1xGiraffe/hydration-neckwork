import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { getExtrinsicActivity, initExplorerService, tradeExecutionPrice } from '../src/services/explorerService.ts'
import { resetCacheForTests } from '../src/services/cache.ts'
import type { ClickHouseClient } from '../src/db/client.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

const FROM = `0x${'a1'.repeat(32)}`
const TO = `0x${'b2'.repeat(32)}`

const transfer = (eventIndex: number, amount: string) => ({
  block_height: 900_200,
  ts: '2026-08-04 10:00:00',
  event_index: eventIndex,
  extrinsic_index: 4,
  event_name: 'Balances.Transfer',
  call_address: '',
  args_json: JSON.stringify({ from: FROM, to: TO, amount }),
})

function fakeClient(events: Record<string, unknown>[]): ClickHouseClient {
  return {
    query: async (opts: { query: string }) => ({
      json: async () => (opts.query.includes('FROM price_data.raw_events') && opts.query.includes('args_json')
        && opts.query.includes('extrinsic_index = {i:UInt32}')
        ? events
        : []),
    }),
  } as unknown as ClickHouseClient
}

// The extrinsic page dedupes because several arms legitimately build the same activity
// from the same EVENT. Two events are two activities, however identical their payloads:
// `Utility.batch_all([transfer(B, 100 HDX), transfer(B, 100 HDX)])` moved 200 HDX and
// must render as two rows, or the page understates what the extrinsic did.
describe('the extrinsic pages row identity', () => {
  beforeEach(() => resetCacheForTests())

  it('keeps two identical transfer legs of one batch', async () => {
    initExplorerService(fakeClient([transfer(1, '100'), transfer(2, '100')]))
    const rows = (await getExtrinsicActivity(900_200, 4, { revenue: false })).filter(r => r.type === 'transfer')

    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.eventIndex)).toEqual([1, 2])
    expect(rows.every(r => r.amount === '100')).toBe(true)
  })

  it('still collapses one event two arms both built', async () => {
    // The same event twice is one activity, and that is what the filter exists for.
    initExplorerService(fakeClient([transfer(1, '100'), transfer(1, '100')]))
    const rows = (await getExtrinsicActivity(900_201, 4, { revenue: false })).filter(r => r.type === 'transfer')

    expect(rows).toHaveLength(1)
  })
})

// A direct pool call is represented by its own *Executed event, and XYK (like LBP)
// names its amounts amount/buyPrice/salePrice rather than amountIn/amountOut. Read
// under the router's keys the row rendered with empty amounts and no value, while
// the same trade through Router.buy — represented by Router.Executed — was complete.
describe('the extrinsic page reads a direct XYK trade its own amounts', () => {
  beforeEach(() => resetCacheForTests())

  const WHO = `0x${'c3'.repeat(32)}`
  const POOL = `0x${'d4'.repeat(32)}`
  const swap = (blockHeight: number, eventName: string, args: Record<string, unknown>) => ({
    block_height: blockHeight,
    ts: '2026-09-25 14:20:00',
    event_index: 9,
    extrinsic_index: 2,
    event_name: eventName,
    call_address: '',
    args_json: JSON.stringify({ who: WHO, pool: POOL, feeAsset: 22, feeAmount: '909711', ...args }),
  })

  it('maps XYK.BuyExecuted buyPrice/amount onto in/out', async () => {
    initExplorerService(fakeClient([swap(900_300, 'XYK.BuyExecuted', { assetOut: 252525, assetIn: 22, amount: '1000000000000000000000', buyPrice: '303237610' })]))
    const rows = (await getExtrinsicActivity(900_300, 2, { revenue: false })).filter(r => r.type === 'trade')

    expect(rows).toHaveLength(1)
    expect(rows[0].assetIn?.assetId).toBe(22)
    expect(rows[0].assetOut?.assetId).toBe(252525)
    expect(rows[0].amountIn).toBe('303237610')
    expect(rows[0].amountOut).toBe('1000000000000000000000')
  })

  it('maps XYK.SellExecuted amount/salePrice onto in/out', async () => {
    initExplorerService(fakeClient([swap(900_301, 'XYK.SellExecuted', { assetIn: 252525, assetOut: 22, amount: '100000000000000000000', salePrice: '30533665' })]))
    const rows = (await getExtrinsicActivity(900_301, 2, { revenue: false })).filter(r => r.type === 'trade')

    expect(rows).toHaveLength(1)
    expect(rows[0].amountIn).toBe('100000000000000000000')
    expect(rows[0].amountOut).toBe('30533665')
  })

  it('still reads the router net summary under amountIn/amountOut', async () => {
    initExplorerService(fakeClient([swap(900_302, 'Router.Executed', { assetIn: 1000085, assetOut: 222, amountIn: '2099633665560911318', amountOut: '100000000000000000000' })]))
    const rows = (await getExtrinsicActivity(900_302, 2, { revenue: false })).filter(r => r.type === 'trade')

    expect(rows).toHaveLength(1)
    expect(rows[0].amountIn).toBe('2099633665560911318')
    expect(rows[0].amountOut).toBe('100000000000000000000')
  })
})

// One wire field, one behaviour. Four surfaces spelled the execution price as
// `out > 0 ? out / in : null` and one as a finiteness check, so the same zero-output
// trade rendered 0 on one page and no price on the others.
describe('tradeExecutionPrice', () => {
  it('is assetOut per 1 assetIn, in display units', () => {
    expect(tradeExecutionPrice('1000000000000', '2000000', 12, 6)).toBe(2)
  })

  it('has no price for a trade that produced nothing, on every surface', () => {
    expect(tradeExecutionPrice('1000000000000', '0', 12, 6)).toBeNull()
    expect(tradeExecutionPrice('0', '2000000', 12, 6)).toBeNull()
    expect(tradeExecutionPrice(null, '2000000', 12, 6)).toBeNull()
    expect(tradeExecutionPrice('1000000000000', undefined, 12, 6)).toBeNull()
    expect(tradeExecutionPrice('nonsense', '2000000', 12, 6)).toBeNull()
  })

  it('is the only expression any surface computes it with', () => {
    // No second spelling may reappear beside the shared helper: every site calls it.
    const computed = (explorerService.match(/executionPrice: [^,\n]+/g) ?? [])
      .filter(site => /[?]|inNum|outNum|tradeExecutionPrice/.test(site))
    expect(computed.length).toBeGreaterThan(4)
    for (const site of computed) expect(site).toContain('tradeExecutionPrice(')
  })
})

// Read-model guards that only exist as query shape.
describe('replay and alias guards', () => {
  // dca_schedules is ReplacingMergeTree(block_height) ORDER BY id: a later event
  // enriches a schedule's row, so an unresolved replacement lists one order twice.
  // The account page and the asset page must not disagree about that.
  it('reads dca_schedules with FINAL on both the account and the asset side', () => {
    const at = explorerService.indexOf('async function getActiveDcas')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))
    expect(body).toContain('FROM price_data.dca_schedules FINAL')

    const asset = explorerService.indexOf('export async function getAssetDcas')
    expect(explorerService.slice(asset, explorerService.indexOf('\n}\n', asset)))
      .toContain('FROM price_data.dca_schedules FINAL')
  })

  // ClickHouse resolves a later reference to a SELECT alias, so an expression aliased
  // to the name of a column it READS silently redefines that column for every other
  // clause of the statement (a value filter's predicate, an ORDER BY).
  it('never aliases the money-market amount expression to the column it reads', () => {
    // Every site that selects the effective amount names it `amount_eff`; none may
    // alias it back to `amount`, which the expression itself reads.
    const selects = explorerService.match(/if\(event_name='LiquidationCall'[^\n]*/g) ?? []
    expect(selects.length).toBeGreaterThan(1)
    for (const site of selects) expect(site).not.toMatch(/AS amount$/)
    expect(explorerService.match(/AS amount_eff/g)?.length).toBe(5)
  })
})
