import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadExplorerAssets, stopExplorerAssetsRefresh } from '../src/services/explorerAssets.ts'
import {
  ICE_POT_ACCOUNT, dcaFinalTradeIn, iceSettlementAmounts, readIceSettlements, repatriationLeg,
  type IceSettlementFill, type IceSettlementLeg, type IceSettlementOrder,
} from '../src/services/iceSettlement.ts'

// The DCA intent's final trade emits Intent.DcaCompleted INSTEAD of DcaTradeExecuted,
// with no amounts. Real rows of intent 33046941197195428158926487553899
// (owner 138YQEm9…, USDC 22 → HDX 0, 500 USDC a trade, budget 1,500 USDC): trades at
// 15555437 and 15555456 state their amounts; the third, 15555475/2, is the
// DcaCompleted at event 51. Its input is no transfer: the pallet repatriates the
// owner's RESERVED budget to the pot (event 5, Tokens.ReserveRepatriated 500000000),
// and pays the HDX out as Currencies.Transferred pot→owner (event 50,
// 70532082825007989 — the HDX the owner received; ICE.SolutionExecuted's score,
// 70531082825007989, is not a delivered amount). Before the fix every surface read
// that trade as amountIn null: order history sold 1,000 USDC and was "unpriced",
// the intent page filled 1,000 USDC.

const ID = '33046941197195428158926487553899'
const OWNER = '0x5e38e3833f84e9dcc5ebaf0f8976cab4761f196bfda74e6455e3f279baf12057'
const ORDER_ROW = {
  intent_id: ID, seq: '1899', owner: OWNER, kind: 'dca', asset_in: 22, asset_out: 0,
  amount_in: '500000000', amount_out: '1000000000000', partial: 0, partial_min: '', slippage_ppm: 10000,
  budget: '1500000000', period: 18, deadline_ms: '0', forward_contract: '', block_height: 15555436, extrinsic_index: 2,
  ts: '2026-10-08 16:51:12', block_timestamp: '2026-10-08 16:51:12',
}
const ORDER: IceSettlementOrder = { owner: OWNER, assetIn: 22, assetOut: 0, amountIn: '500000000', budget: '1500000000', blockHeight: 15555436 }
// intent_events for the order (FINAL), chain order.
const EVENTS = [
  { intent_id: ID, block_height: 15555436, ts: '2026-10-08 16:51:12', event_index: 6, extrinsic_index: 2, event_name: 'Intent.IntentSubmitted', args_json: JSON.stringify({ id: ID, owner: OWNER, intent: { data: { __kind: 'Dca', value: { assetIn: 22, assetOut: 0, amountIn: '500000000', amountOut: '1000000000000', slippage: 10000, budget: '1500000000', remainingBudget: '1500000000', period: 18 } } } }), amount_in: '', amount_out: '', remaining_budget: '' },
  { intent_id: ID, block_height: 15555437, ts: '2026-10-08 16:51:18', event_index: 52, extrinsic_index: 2, event_name: 'Intent.DcaTradeExecuted', args_json: JSON.stringify({ id: ID, amountIn: '500000000', amountOut: '70731252562086604', remainingBudget: '1000000000' }), amount_in: '500000000', amount_out: '70731252562086604', remaining_budget: '1000000000' },
  { intent_id: ID, block_height: 15555456, ts: '2026-10-08 16:51:54', event_index: 51, extrinsic_index: 2, event_name: 'Intent.DcaTradeExecuted', args_json: JSON.stringify({ id: ID, amountIn: '500000000', amountOut: '70646342372435505', remainingBudget: '500000000' }), amount_in: '500000000', amount_out: '70646342372435505', remaining_budget: '500000000' },
  { intent_id: ID, block_height: 15555475, ts: '2026-10-08 16:52:30', event_index: 51, extrinsic_index: 2, event_name: 'Intent.DcaCompleted', args_json: JSON.stringify({ id: ID }), amount_in: '', amount_out: '', remaining_budget: '' },
]
const FILLS = EVENTS.filter(e => e.event_name !== 'Intent.IntentSubmitted')
const DONE = EVENTS[3]!
// What the leaf's reads return for block 15555475 (recorded from ClickHouse).
const SETTLEMENT: Record<string, unknown[]> = {
  'ice:settlement-legs': [{ block_height: 15555475, event_index: 50, extrinsic_index: 2, from_account: ICE_POT_ACCOUNT, to_account: OWNER, asset_id: 0, amount: '70532082825007989' }],
  'ice:settlement-repatriations': [{ block_height: 15555475, event_index: 5, extrinsic_index: 2, event_name: 'Tokens.ReserveRepatriated', args_json: JSON.stringify({ currencyId: 22, from: OWNER, to: ICE_POT_ACCOUNT, amount: '500000000', status: { __kind: 'Free' } }) }],
  'ice:settlement-fills': [{ intent_id: ID, block_height: 15555475, event_index: 51, extrinsic_index: 2, event_name: 'Intent.DcaCompleted', amount_in: '', amount_out: '' }],
  'ice:settlement-orders': [{ intent_id: ID, owner: OWNER, asset_in: 22, asset_out: 0, amount_in: '500000000', budget: '1500000000', block_height: 15555436 }],
  'ice:settlement-prior-budget': [{ intent_id: ID, rb: '500000000' }],
}
// USDC's 15:00 candle, the newest fully closed by the trades' hour (16:00 UTC).
const USDC_CLOSE = '1.000069293923'
const HOUR_16 = Date.UTC(2026, 9, 8, 16) / 1000

const result = (rows: unknown[]) => ({ json: async () => rows, text: async () => '' })
const tagOf = (query: string): string | undefined => /--\s*([a-z][a-z0-9:-]+)/.exec(query)?.[1]

/** Answers the leaf's settlement reads, plus whatever `extra` recognises; anything else is []. */
function fakeClient(extra: (query: string, params: Record<string, unknown>) => unknown[] | undefined = () => undefined, settlement = SETTLEMENT) {
  const seen: string[] = []
  return {
    seen,
    query: vi.fn(async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      const tag = tagOf(query)
      seen.push(tag ?? query.slice(0, 80))
      if (tag?.startsWith('ice:settlement-')) return result(settlement[tag] ?? [])
      return result(extra(query, query_params ?? {}) ?? [])
    }),
  }
}

beforeAll(async () => {
  await loadExplorerAssets({
    query: vi.fn(async ({ query }: { query: string }) => result(query.includes('FROM price_data.assets') ? [
      { asset_id: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
      { asset_id: 22, symbol: 'USDC', name: null, decimals: 6, parachain_id: 1000, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
    ] : [])),
  } as never)
})
afterAll(() => stopExplorerAssetsRefresh())

describe('iceSettlementAmounts — the DCA final trade', () => {
  const fill: IceSettlementFill = { blockHeight: 15555475, extrinsicIndex: 2, eventIndex: 51, eventName: 'Intent.DcaCompleted', intentId: ID, amountIn: null, amountOut: null }
  const out: IceSettlementLeg = { blockHeight: 15555475, extrinsicIndex: 2, from: ICE_POT_ACCOUNT, to: OWNER, assetId: 0, amount: '70532082825007989' }

  it('measures the input from the reserved budget repatriated to the pot', () => {
    const repat = repatriationLeg(SETTLEMENT['ice:settlement-repatriations']![0] as never)
    expect(repat).toEqual({ blockHeight: 15555475, extrinsicIndex: 2, from: OWNER, to: ICE_POT_ACCOUNT, assetId: 22, amount: '500000000' })
    expect(iceSettlementAmounts([fill], new Map([[ID, ORDER]]), [out, repat!]).get('15555475:51'))
      .toEqual({ amountIn: '500000000', amountOut: '70532082825007989' })
  })

  it('reads HDX repatriations (Balances, no currency) as asset 0 and ignores one not paid to the pot', () => {
    const row = { block_height: 1, event_index: 4, extrinsic_index: 2, event_name: 'Balances.ReserveRepatriated', args_json: JSON.stringify({ from: OWNER, to: ICE_POT_ACCOUNT, amount: '111944444444444444', destinationStatus: { __kind: 'Free' } }) }
    expect(repatriationLeg(row)).toMatchObject({ assetId: 0, amount: '111944444444444444' })
    expect(repatriationLeg({ ...row, args_json: JSON.stringify({ from: OWNER, to: OWNER, amount: '1' }) })).toBeNull()
    expect(repatriationLeg({ ...row, extrinsic_index: null })).toBeNull()
  })

  it('falls back to what the final trade spends when no leg measures the input', () => {
    // An Erc20 asset_in (HOLLAR, aTokens) leaves no owner→pot leg at all.
    expect(iceSettlementAmounts([fill], new Map([[ID, ORDER]]), [out], new Map([[ID, '500000000']])).get('15555475:51'))
      .toEqual({ amountIn: '500000000', amountOut: '70532082825007989' })
  })

  it('caps the fallback at the per-trade amount: the pallet unreserves leftover dust', () => {
    // 14411865: 345812397 left before the final trade, which spent 345812396.
    expect(dcaFinalTradeIn('345812396', '345812397')).toBe('345812396')
    // A smaller remainder is all the final trade can spend.
    expect(dcaFinalTradeIn('500000000', '120000000')).toBe('120000000')
    expect(dcaFinalTradeIn('500000000', null)).toBeNull()
    expect(dcaFinalTradeIn('500000000', '0')).toBeNull()
  })
})

describe('readIceSettlements on the real rows of 15555475', () => {
  it('resolves the completion to 500 USDC in, 70,532.08 HDX out', async () => {
    const client = fakeClient()
    const out = await readIceSettlements(client as never, [{ blockHeight: 15555475, eventIndex: 51, extrinsicIndex: 2, eventName: 'Intent.DcaCompleted', intentId: ID }])
    expect(out.get('15555475:51')).toEqual({ amountIn: '500000000', amountOut: '70532082825007989' })
  })

  it('takes the prior remainingBudget fallback when no repatriation is indexed', async () => {
    const client = fakeClient(undefined, { ...SETTLEMENT, 'ice:settlement-repatriations': [] })
    const out = await readIceSettlements(client as never, [{ blockHeight: 15555475, eventIndex: 51, extrinsicIndex: 2, eventName: 'Intent.DcaCompleted', intentId: ID }])
    expect(out.get('15555475:51')).toEqual({ amountIn: '500000000', amountOut: '70532082825007989' })
  })

  it('reads nothing when no completion is among the events', async () => {
    const client = fakeClient()
    expect((await readIceSettlements(client as never, [{ blockHeight: 15555456, eventIndex: 51, extrinsicIndex: 2, eventName: 'Intent.DcaTradeExecuted', intentId: ID }])).size).toBe(0)
    expect(client.seen).toEqual([])
  })
})

describe('order history row of the completed DCA intent', () => {
  it('sells the full 1,500 USDC across all three trades and prices it', async () => {
    const { initExplorerService } = await import('../src/services/explorerService.ts')
    const { enrichIntents, initOrderHistory } = await import('../src/services/orderHistory.ts')
    const client = fakeClient((query, params) => {
      if (query.includes('price_data.intent_orders')) return [ORDER_ROW]
      if (tagOf(query) === 'orders:intent-fills') return FILLS
      if (tagOf(query) === 'flows:event-time-closes') {
        const feeds = params.feeds as number[], hours = params.hours as number[]
        return feeds.map((feed, i) => ({ feed, h: hours[i], closed_at: HOUR_16, px: USDC_CLOSE }))
      }
      return undefined
    })
    initExplorerService(client as never)
    initOrderHistory(client as never)
    const rows = await enrichIntents([{ kind: 'dca-intent', id: ID, endedBlock: 15555475, endedEventIndex: 51, endedAt: DONE.ts, status: 'completed' }])
    const row = rows.get(`dca-intent:${ID}`)!
    expect(row).toMatchObject({ soldAmount: '1500000000', budgetAmount: '1500000000', trades: 3, status: 'completed' })
    // Received is what the three trades delivered: 70731252562086604 + 70646342372435505 + 70532082825007989.
    expect(row.receivedAmount).toBe('211909677759530098')
    // 1,500 USDC at the 15:00 close: $1,500.10 (was null — "unpriced").
    expect(row.soldUsd).toBeCloseTo(1500.1, 2)
  })
})

describe('the explorer intent page of the completed DCA intent', () => {
  it('fills 1,500 USDC and states the final fill\'s amounts', async () => {
    const { initExplorerService, getIntentOrder } = await import('../src/services/explorerService.ts')
    const client = fakeClient(query => {
      if (query.includes('price_data.intent_orders')) return [ORDER_ROW]
      if (!query.includes('price_data.intent_events')) return undefined
      if (query.includes('event_name NOT IN')) return [EVENTS[0]]
      if (query.includes('countIf(event_name')) return [{ n: 3, n_full: 0, n_partial: 0, n_dca: 2, n_done: 1, tin: '1000000000', tout: '141377594934522109', last_block: 15555475, last_rb: '' }]
      if (query.includes('SELECT DISTINCT block_height, extrinsic_index')) return FILLS.map(f => ({ block_height: f.block_height, extrinsic_index: f.extrinsic_index })).reverse()
      if (query.includes("event_name = 'Intent.DcaCompleted'")) return [DONE]
      if (query.includes('LIMIT {lim:UInt32}')) return [...FILLS].reverse()
      return undefined
    })
    initExplorerService(client as never)
    const detail = (await getIntentOrder(ID))!
    expect(detail.status).toBe('completed')
    expect(detail.filledIn).toBe('1500000000')
    expect(detail.filledOut).toBe('211909677759530098')
    const last = detail.fills.find(f => f.blockHeight === 15555475)!
    expect([last.amountIn, last.amountOut]).toEqual(['500000000', '70532082825007989'])
  })
})

describe('public API and Data API of the completed DCA intent', () => {
  const AGG = {
    intent_id: ID, cancelled: 0, expired: 0, resolved: 0, partial: 0, dca_completed: 1, fills: 3,
    fill_in: '1000000000', fill_out: '141377594934522109', last_ts: DONE.ts, last_rb: '500000000',
    done_block: 15555475, done_index: 51, done_extrinsic: 2,
  }
  const pageRows = [...EVENTS].reverse().map(({ intent_id: _id, args_json: _a, ...rest }) => rest)

  it('public /v1/intents/:id folds the final trade into filledAmountIn/Out', async () => {
    const { queryIntentOrderById, queryIntentEvents } = await import('../src/public/services/intentOrders.ts')
    const client = fakeClient(query => {
      if (tagOf(query) === 'pub:intents:order-by-id') return [ORDER_ROW]
      if (tagOf(query) === 'pub:intents:events-count') return [{ total: '4' }]
      if (tagOf(query) === 'pub:intents:events') return pageRows
      if (query.includes('countIf(event_name')) return [AGG]
      return undefined
    })
    const row = (await queryIntentOrderById(client as never, ID))!
    expect(row).toMatchObject({ status: 'completed', filledAmountIn: '1500000000', filledAmountOut: '211909677759530098', remainingAmountIn: '0', fillCount: 3 })
    const events = (await queryIntentEvents(client as never, ID, { limit: 20, offset: 0 }))!
    expect(events.items[0]).toMatchObject({ kind: 'dca_completed', amountIn: '500000000', amountOut: '70532082825007989', remainingBudget: '0' })
  })

  it('Data API intent detail and events state the final trade', async () => {
    const { intentOrderById, intentEvents } = await import('../src/data/services/intentData.ts')
    const client = fakeClient(query => {
      if (tagOf(query) === 'data:intents:order-by-id') return [ORDER_ROW]
      if (tagOf(query) === 'data:intents:aggregates') return [{ names: ['Intent.IntentSubmitted', 'Intent.DcaTradeExecuted', 'Intent.DcaCompleted'], fill_in: '1000000000', fill_out: '141377594934522109', fills: 3, last_block: 15555475, last_ts: DONE.ts, last_rb: '500000000', done_block: 15555475, done_index: 51, done_extrinsic: 2 }]
      if (tagOf(query) === 'data:intents:events') return pageRows
      return undefined
    })
    const detail = (await intentOrderById(client as never, ID))!
    expect(detail).toMatchObject({ status: 'completed', filledAmountIn: '1500000000', filledAmountOut: '211909677759530098' })
    const events = await intentEvents(client as never, ID, 15555436, { limit: 20, order: 'desc', cursor: null })
    expect(events.items[0]).toMatchObject({ kind: 'dca_completed', amountIn: '500000000', amountOut: '70532082825007989' })
  })
})
