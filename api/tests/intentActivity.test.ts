import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { activityTypes } from '../src/routes/explorer'
import { ICE_POT_ACCOUNT, INTENT_EVENT_NAMES, activityPagesInMemory, activityRowMatchesAction, activityTypeMatchesFamily, activityWindowPlan, dcaMigratedScheduleId, dcaMigrationReason, dcaScheduleStatus, iceMatchedInUsd, iceSettlementAmounts, intentActivityParts, intentOrderStatus, intentRowFromEvent, intentSeqOf, isIntentOnlyTradeRequest, limitPriceOutPerIn, resolveIntentActions, suppressIcePotSettlementTrades, type ActivityRow, type IceSettlementFill, type IceSettlementLeg, type IntentOrder } from '../src/services/explorerService'
import type { PriceInfo } from '../src/services/explorerService'
import { isClassifiedAction } from '../src/services/pendingActivity'
import { activityPath, activityTypeSelects, dcaHourly, dcaIntentScheduleRow, evaluateDcaStart, largeTradeRowEligible, renderMatch, type RuleMatch } from '../src/notifications/evaluator'
import { renderNotification } from '../src/notifications/render'
import type { NotificationRule } from '../src/notifications/notificationStore'
import { assetDescriptor } from '../src/services/explorerAssets'

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')
const tables = read('clickhouse/schema/001_tables.sql')
const mvs = read('clickhouse/schema/003_materialized_views.sql')
const data = read('clickhouse/schema/009_data.sql')

const FEED_EVENTS = ['Intent.IntentSubmitted', 'Intent.IntentResolved', 'Intent.IntentResovedPartially', 'Intent.IntentCanceled', 'Intent.IntentExpired', 'Intent.DcaTradeExecuted']
const LIFECYCLE_ONLY = ['Intent.DcaCompleted', 'Intent.FailedToQueueCallback', 'LazyExecutor.Queued', 'LazyExecutor.Executed', 'ICE.SolutionExecuted', 'DCA.Migrated']

describe('intent schema', () => {
  it('declares the order and event tables', () => {
    expect(tables).toMatch(/CREATE TABLE IF NOT EXISTS price_data\.intent_orders \(`intent_id` UInt128/)
    expect(tables).toMatch(/CREATE TABLE IF NOT EXISTS price_data\.intent_events \(`intent_id` UInt128/)
    expect(data).toMatch(/CREATE TABLE IF NOT EXISTS price_data\.intent_orders_by_account \(/)
    expect(data).toMatch(/ORDER BY \(owner, block_height, event_index\)/)
  })
  it('feeds intent_orders from IntentSubmitted only', () => {
    const line = mvs.split('\n').find(l => l.includes('price_data.intent_orders_mv'))!
    expect(line).toContain("WHERE event_name = 'Intent.IntentSubmitted'")
    expect(line).toContain("'intent', 'data', 'value', 'assetIn'")
    expect(line).toContain("bitAnd(")
  })
  it('feeds intent_events from every lifecycle event', () => {
    const line = mvs.split('\n').find(l => l.includes('price_data.intent_events_mv'))!
    for (const name of [...FEED_EVENTS, ...LIFECYCLE_ONLY]) expect(line, name).toContain(`'${name}'`)
    expect(line).toContain("'src', 'value'")
  })
  it('counts intent feed events in the histogram, with asset refs on the placement', () => {
    const line = mvs.split('\n').find(l => l.includes('price_data.activity_histogram_events_mv'))!
    for (const name of FEED_EVENTS) expect(line, name).toContain(`'${name}'`)
    // The budget-exhausting trade of a DCA intent is DcaCompleted alone: its bar too.
    expect(line).toContain("'Intent.DcaCompleted'")
    expect(line).toContain("event_name = 'Intent.IntentSubmitted', arrayDistinct([toUInt32(greatest(0, JSONExtractInt(args_json, 'intent', 'data', 'value', 'assetIn')))")
  })
  it('records DCA migration outcomes in dca_events', () => {
    const line = mvs.split('\n').find(l => l.includes('price_data.dca_events_mv'))!
    expect(line).toContain("'DCA.Migrated'")
    expect(line).toContain("'DCA.MigrationCancelled'")
    expect(line).toContain("if(event_name = 'DCA.MigrationCancelled', JSONExtractRaw(args_json, 'reason'), '') AS error")
  })
})

// Real payloads from the first mainnet intents (runtime 443, 2026-09-09):
//   submitted = Intent.IntentSubmitted  14396667-e7  (Intent.submit_intent, extrinsic 2)
//   resolved  = Intent.IntentResolved   14396670-e57 (ICE.submit_solution, extrinsic 2)
//   dcaTrade  = Intent.DcaTradeExecuted 14402274-e60 (ICE.submit_solution, extrinsic 2)
//   dcaDone   = Intent.DcaCompleted     14402317-e73 (ICE.submit_solution, extrinsic 2): the budget-exhausting
//               trade of a DCA intent emits DcaCompleted { id } INSTEAD of DcaTradeExecuted
//               (pallet_intent::intent_resolved), so the final fill carries no amounts of its own.
//   order / dcaOrderRow = the intent_orders rows those placements made.
// None of the first 35 orders carried a deadline or a Forward callback, so `intent.deadline` and
// `intent.onResolved` are absent from the JSON (None is omitted). The id's high 64 bits are the
// PLACEMENT time (generate_new_intent_id(now)), not a deadline: 1788944634000 ms = 09:03:54 UTC.
const OWNER = '0x1ad9d16ce64de2df5b556e1c0cf58b8428e6ce66d68d6b3eb28b69706cf8a829'
const ID = '33000203825434002837989228544000'      // seq 0
const DCA_ID = '33000433376717256079649538048034'  // seq 34
const submitted = { id: ID, owner: OWNER, intent: { data: { __kind: 'Swap', value: { assetIn: 10, assetOut: 1001, amountIn: '8610630', amountOut: '72230122863', partial: { __kind: 'No' } } } } }
const resolved = { id: ID, amountIn: '8610630', amountOut: '72585831293' }
const dcaTrade = { id: DCA_ID, amountIn: '190218680', amountOut: '189916449', remainingBudget: '380437361' }
const dcaDone = { id: DCA_ID }
const ID_SEQ7 = '18446744073709551623' // 2^64 + 7: high half 1, low half (seq) 7 — a seq the real ids (0, 34) cannot pin
const order: IntentOrder = { intentId: ID, seq: 0, owner: OWNER, kind: 'swap', assetIn: 10, assetOut: 1001, amountIn: '8610630', amountOut: '72230122863', partial: false, partialMin: null, slippagePpm: 0, budget: null, period: 0, deadlineMs: null, forwardContract: null, blockHeight: 14396667, extrinsicIndex: 2, timestamp: '2026-09-09 09:03:54' }
const dcaOrderRow: IntentOrder = { intentId: DCA_ID, seq: 34, owner: OWNER, kind: 'dca', assetIn: 1003, assetOut: 1000766, amountIn: '190218680', amountOut: '10000', partial: false, partialMin: null, slippagePpm: 30000, budget: '570656041', period: 18, deadlineMs: null, forwardContract: null, blockHeight: 14402251, extrinsicIndex: 2, timestamp: '2026-09-09 12:31:18' }
// The settlement legs of 14402317/2 (Currencies.Transferred): e17 owner→pot 190218680 aUSDC, e65 pot→owner 189907076 USDC.
const doneLegs: IceSettlementLeg[] = [
  { blockHeight: 14402317, extrinsicIndex: 2, from: OWNER, to: ICE_POT_ACCOUNT, assetId: 1003, amount: '190218680' },
  { blockHeight: 14402317, extrinsicIndex: 2, from: ICE_POT_ACCOUNT, to: OWNER, assetId: 1000766, amount: '189907076' },
]
const doneFill: IceSettlementFill = { blockHeight: 14402317, extrinsicIndex: 2, eventIndex: 73, eventName: 'Intent.DcaCompleted', intentId: DCA_ID, amountIn: null, amountOut: null }
const prices = new Map<number, PriceInfo>()

describe('intentActivityParts', () => {
  it('reads a placement', () => {
    expect(intentActivityParts('Intent.IntentSubmitted', submitted)).toEqual({ action: 'Place', intentId: ID, owner: OWNER, amountIn: '8610630', amountOut: '72230122863', remainingBudget: null })
  })
  it('reads a fill, a partial fill, a DCA trade, a cancel and an expiry', () => {
    expect(intentActivityParts('Intent.IntentResolved', resolved)?.action).toBe('Fill')
    expect(intentActivityParts('Intent.IntentResovedPartially', resolved)?.action).toBe('PartialFill')
    expect(intentActivityParts('Intent.DcaTradeExecuted', dcaTrade)).toMatchObject({ action: 'DcaTrade', amountIn: '190218680', amountOut: '189916449', remainingBudget: '380437361' })
    expect(intentActivityParts('Intent.IntentCanceled', { id: ID })).toMatchObject({ action: 'Cancel', amountIn: null })
    expect(intentActivityParts('Intent.IntentExpired', { id: ID })).toMatchObject({ action: 'Expire' })
  })
  // The pallet emits DcaCompleted { id } in place of the final DcaTradeExecuted, so it IS
  // the DCA's last trade: nothing is left of the budget, and the amounts come from the
  // settlement legs (iceSettlementAmounts), never from the event.
  it('reads a DCA completion as the final trade, with nothing left', () => {
    expect(intentActivityParts('Intent.DcaCompleted', dcaDone)).toEqual({ action: 'DcaTrade', intentId: DCA_ID, owner: null, amountIn: null, amountOut: null, remainingBudget: '0' })
  })
  it('accepts a numeric id and rejects unrelated events', () => {
    expect(intentActivityParts('Intent.IntentCanceled', { id: 42 })?.intentId).toBe('42')
    expect(intentActivityParts('ICE.SolutionExecuted', { intentsExecuted: '1' })).toBeNull()
    expect(intentActivityParts('Bonds.Issued', {})).toBeNull()
  })
})

describe('intentSeqOf', () => {
  it('takes the low 64 bits of the u128 id', () => {
    expect(intentSeqOf(ID_SEQ7)).toBe(7)
  })
})

describe('resolveIntentActions', () => {
  it('maps slugs and bare words', () => {
    expect(resolveIntentActions('intent-fill')).toEqual(['Fill', 'PartialFill'])
    expect(resolveIntentActions('intent-place')).toEqual(['Place'])
    expect(resolveIntentActions('Cancel')).toEqual(['Cancel'])
    expect(resolveIntentActions('swap')).toBeUndefined()
  })
})

describe('intentRowFromEvent', () => {
  const ev = (event_name: string, args: unknown, extrinsic_index: number | null = 2, at: { block_height?: number; event_index?: number } = {}) =>
    ({ block_height: 14396670, ts: '2026-09-09 09:04:00', event_index: 57, ...at, extrinsic_index, event_name, args_json: JSON.stringify(args) })
  it('builds a fill for the order owner with realized amounts', () => {
    const out = intentRowFromEvent(ev('Intent.IntentResolved', resolved), prices, new Map([[ID, order]]))
    expect(out?.owner).toBe(OWNER)
    expect(out?.row).toMatchObject({ type: 'intent', intentAction: 'Fill', intentId: ID, intentSeq: 0, intentKind: 'swap', amountIn: '8610630', amountOut: '72585831293', linkBlock: 14396670, linkIndex: 2 })
    expect(out?.row.assetIn?.assetId).toBe(10)
    expect(out?.row.assetOut?.assetId).toBe(1001)
    expect(out?.row.who?.accountId).toBe(OWNER)
  })
  it('builds a placement from the event alone when the order map is empty', () => {
    const out = intentRowFromEvent(ev('Intent.IntentSubmitted', submitted, null), prices, new Map())
    expect(out?.row).toMatchObject({ type: 'intent', intentAction: 'Place', intentKind: 'swap', intentPartial: false, amountIn: '8610630', amountOut: '72230122863', intentDeadline: null, intentForward: null })
    expect(out?.row.assetIn?.assetId).toBe(10)
    expect(out?.row.extrinsicIndex).toBeNull()
  })
  // No real order has carried a deadline yet (all 35 first placements omit it), so the
  // deadline path is pinned on the real payload with the field added in the metadata's shape.
  it('reads a deadline when the placement carries one', () => {
    const withDeadline = { ...submitted, intent: { ...submitted.intent, deadline: '1788960000000' } }
    expect(intentRowFromEvent(ev('Intent.IntentSubmitted', withDeadline, null), prices, new Map())?.row.intentDeadline).toBe(new Date(1788960000000).toISOString())
  })
  it('keeps a fill whose order is unknown, with no actor', () => {
    const out = intentRowFromEvent(ev('Intent.IntentResolved', resolved), prices, new Map())
    expect(out?.row.who).toBeNull()
    expect(out?.row.assetIn).toBeNull()
    expect(out?.row.amountIn).toBe('8610630')
  })
  it('values a cancel on the remaining input and carries the order limits', () => {
    const out = intentRowFromEvent(ev('Intent.IntentCanceled', { id: ID }), prices, new Map([[ID, order]]))
    expect(out?.row).toMatchObject({ intentAction: 'Cancel', amountIn: '8610630', amountOut: '72230122863' })
  })
  it("builds the DCA's final trade from DcaCompleted with the settlement legs' amounts", () => {
    const done = ev('Intent.DcaCompleted', dcaDone, 2, { block_height: 14402317, event_index: 73 })
    const settlements = iceSettlementAmounts([doneFill], new Map([[DCA_ID, dcaOrderRow]]), doneLegs)
    const out = intentRowFromEvent(done, prices, new Map([[DCA_ID, dcaOrderRow]]), { settlements })
    expect(out?.row).toMatchObject({ type: 'intent', intentAction: 'DcaTrade', intentKind: 'dca', intentId: DCA_ID, intentSeq: 34, amountIn: '190218680', amountOut: '189907076', intentRemainingBudget: '0', linkBlock: 14402317, linkIndex: 2 })
    expect(out?.row.who?.accountId).toBe(OWNER)
    expect(out?.row.assetIn?.assetId).toBe(1003)
    expect(out?.row.assetOut?.assetId).toBe(1000766)
  })
  // The order's per-period amount is what the DCA USUALLY trades, not what this trade did:
  // a completion without its legs stays amountless rather than showing a plausible number.
  it('leaves a completion without settlement legs amountless', () => {
    const done = ev('Intent.DcaCompleted', dcaDone, 2, { block_height: 14402317, event_index: 73 })
    const out = intentRowFromEvent(done, prices, new Map([[DCA_ID, dcaOrderRow]]))
    expect(out?.row).toMatchObject({ intentAction: 'DcaTrade', amountIn: null, amountOut: null, valueUsd: null })
    expect(out?.row.who?.accountId).toBe(OWNER)
  })
  it('carries the seq from the low 64 bits of an id above 2^64', () => {
    const out = intentRowFromEvent(ev('Intent.IntentCanceled', { id: ID_SEQ7 }), prices, new Map())
    expect(out?.row).toMatchObject({ intentId: ID_SEQ7, intentSeq: 7 })
  })
})

// pallet_ice moves each fill through the pot: owner→pot in the order's asset_in, pot→owner
// in its asset_out (Currencies.Transferred). For DcaTradeExecuted rows the event states the
// same numbers as the legs (14402274: 190218680 in / 189916449 out, transfer for transfer),
// so for a DcaCompleted — which states none — the legs ARE the amounts.
describe('iceSettlementAmounts', () => {
  const orders = new Map([[DCA_ID, dcaOrderRow]])
  it('reads the final DCA trade of 14402317/2 from its two legs', () => {
    expect(iceSettlementAmounts([doneFill], orders, doneLegs).get('14402317:73')).toEqual({ amountIn: '190218680', amountOut: '189907076' })
  })
  it('subtracts the sibling fills that state their own amounts', () => {
    const sibling: IceSettlementFill = { ...doneFill, eventIndex: 60, eventName: 'Intent.DcaTradeExecuted', intentId: 'other', amountIn: '100', amountOut: '50' }
    const otherOrder: IntentOrder = { ...dcaOrderRow, intentId: 'other', seq: 35 }
    const legs: IceSettlementLeg[] = [
      { ...doneLegs[0], amount: '190218780' },
      { ...doneLegs[1], amount: '189907126' },
    ]
    expect(iceSettlementAmounts([doneFill, sibling], new Map([...orders, ['other', otherOrder]]), legs).get('14402317:73')).toEqual({ amountIn: '190218680', amountOut: '189907076' })
  })
  it('refuses to split two completions of one owner in the same asset', () => {
    const twin: IceSettlementFill = { ...doneFill, eventIndex: 90, intentId: 'twin' }
    const twinOrder: IntentOrder = { ...dcaOrderRow, intentId: 'twin', seq: 36 }
    const out = iceSettlementAmounts([doneFill, twin], new Map([...orders, ['twin', twinOrder]]), doneLegs)
    expect(out.get('14402317:73')).toEqual({ amountIn: null, amountOut: null })
    expect(out.get('14402317:90')).toEqual({ amountIn: null, amountOut: null })
  })
  it('keys legs by solution: a leg of another extrinsic or block is not this fill', () => {
    const elsewhere = doneLegs.map(l => ({ ...l, extrinsicIndex: 3 }))
    expect(iceSettlementAmounts([doneFill], orders, elsewhere).get('14402317:73')).toEqual({ amountIn: null, amountOut: null })
  })
  it('has nothing for an unknown order and skips a hook row', () => {
    expect(iceSettlementAmounts([doneFill], new Map(), doneLegs).get('14402317:73')).toEqual({ amountIn: null, amountOut: null })
    expect(iceSettlementAmounts([{ ...doneFill, extrinsicIndex: null }], orders, doneLegs).size).toBe(0)
  })
})

// Matched (intent-to-intent) volume is what the fills took in beyond what the pot routed
// through the AMMs, per input asset: intent_in − pool_in, floored at zero, valued at the
// fills' own event-time price. A difference of USD valuations read price noise as matched
// volume ($0.08 on a fully routed solution).
describe('iceMatchedInUsd', () => {
  const base = { blockHeight: 14402317, timestamp: '2026-09-09 12:34:00', eventIndex: 0, extrinsicIndex: 2, who: null, to: null, asset: null, assetOut: null, amount: null, amountOut: null }
  const fill = (assetId: number, amountIn: string, valueUsd: number | null): ActivityRow => ({ ...base, type: 'intent', assetIn: { assetId, decimals: 6 } as any, amountIn, valueUsd })
  const pot = (assetId: number, amountIn: string, valueUsd: number | null): ActivityRow => ({ ...base, type: 'trade', assetIn: { assetId, decimals: 6 } as any, amountIn, valueUsd })
  it('is zero for a fully routed solution however the two legs were priced', () => {
    // 14402317/2: the fill paid 190218680 aUSDC ($190.20 at its price), the pot routed the same 190218680 ($190.12 at its own).
    expect(iceMatchedInUsd([fill(1003, '190218680', 190.199212)], [pot(1003, '190218680', 190.119543)])).toBe(0)
  })
  it('values the unrouted remainder at the fills\' own price', () => {
    expect(iceMatchedInUsd([fill(1003, '100', 100), fill(1003, '100', 100)], [pot(1003, '150', 150)])).toBeCloseTo(50, 9)
  })
  it('is unknown when a matched asset has no valued fill, and zero with no fills', () => {
    expect(iceMatchedInUsd([fill(1003, '100', null)], [])).toBeNull()
    expect(iceMatchedInUsd([], [pot(1003, '150', 150)])).toBe(0)
  })
})

describe('intent wiring', () => {
  it('is a wire type in the Trade family', () => {
    expect(activityTypes).toContain('intent')
    expect(activityTypeMatchesFamily('intent', 'trade')).toBe(true)
    expect(activityTypeMatchesFamily('intent', 'intent')).toBe(true)
  })
  it('matches actions by word and by slug', () => {
    const fill = { type: 'intent', intentAction: 'Fill' } as any
    expect(activityRowMatchesAction(fill, 'intent-fill')).toBe(true)
    expect(activityRowMatchesAction({ ...fill, intentAction: 'PartialFill' }, 'intent-fill')).toBe(true)
    expect(activityRowMatchesAction(fill, 'intent-place')).toBe(false)
  })
  it('suppresses pending transfer legs of the intent pallets', () => {
    for (const name of ['Intent.IntentSubmitted', 'ICE.SolutionExecuted', 'LazyExecutor.Queued']) expect(isClassifiedAction(name), name).toBe(true)
  })
  it('names every feed event in the transfer-suppression allow-list', () => {
    const src = readFileSync(resolve(root, 'api/src/services/explorerService.ts'), 'utf8')
    const start = src.indexOf('const semanticNames = [')
    const block = src.slice(start, src.indexOf(']', start))
    expect(block).toContain('...INTENT_EVENT_NAMES')
    // The six lifecycle events plus DcaCompleted, the DCA's final trade.
    expect(INTENT_EVENT_NAMES).toHaveLength(7)
    expect(INTENT_EVENT_NAMES).toContain('Intent.DcaCompleted')
  })
  it("counts a DCA intent's trade under the Trade chip's dca action in the histogram", () => {
    // The list admits it through activityRowMatchesAction's intent arm; the bars over
    // activity_histogram_events must name the same event, or the chart empties as
    // schedules migrate while the list keeps its rows.
    const src = read('api/src/services/explorerService.ts')
    const start = src.indexOf('export async function getDailyActivity(')
    const body = src.slice(start, src.indexOf('\nexport ', start + 1))
    const dca = body.split('\n').filter(l => l.includes("filters.action === 'dca')") && l.includes('names = ['))
    expect(dca).toHaveLength(1)
    expect(dca[0]).toContain("'Intent.DcaTradeExecuted'")
    expect(dca[0]).toContain("'Intent.DcaCompleted'")
    expect(activityRowMatchesAction({ type: 'intent', intentKind: 'dca', intentAction: 'DcaTrade' } as any, 'dca')).toBe(true)
  })
  it('links an intent row to its order page', () => {
    const row = { type: 'intent', intentId: ID, intentAction: 'Fill', blockHeight: 14400010, eventIndex: 7, extrinsicIndex: 2, timestamp: '2026-09-09 10:00:30' } as any
    expect(activityPath(row)).toBe(`/intent/${ID}`)
  })
})

// An intent action on the Trade tab is answered by the intent source alone. Through
// the shared Trade classifier it paged swaps, failed DCA schedules and OTC rows that
// can never match it, widening every source until the read guard tripped: a 503
// while no intent rows exist at all, where `type=intent` with the same action
// answers an empty page.
describe('isIntentOnlyTradeRequest', () => {
  it('names the Trade tab intent actions, by slug and by word', () => {
    for (const action of ['intent-place', 'intent-fill', 'intent-cancel', 'intent-expire', 'intent-dca-trade', 'Cancel', 'Expire', 'PartialFill', 'DcaTrade']) {
      expect(isIntentOnlyTradeRequest('trade', action), action).toBe(true)
    }
    // `dca` is the Trade family's other wire spelling.
    expect(isIntentOnlyTradeRequest('dca', 'intent-fill')).toBe(true)
  })
  it('leaves every other trade action and every other type alone', () => {
    for (const action of ['swap', 'dca', 'dca-failed', 'otc-place', 'otc-fill', 'otc-pull', 'Pull', 'Supply', undefined]) {
      expect(isIntentOnlyTradeRequest('trade', action), action ?? 'none').toBe(false)
    }
    // The bare `Place`/`Fill` words are claimed by the OTC resolver first — the
    // precedence the Trade builder's branch order already gives them.
    expect(isIntentOnlyTradeRequest('trade', 'Place')).toBe(false)
    expect(isIntentOnlyTradeRequest('trade', 'Fill')).toBe(false)
    for (const type of ['bond', 'intent', 'otc', 'all', 'transfer', 'liquidity']) {
      expect(isIntentOnlyTradeRequest(type, 'intent-fill'), type).toBe(false)
    }
  })
  it('pages those requests in SQL on their own per-page cache, like dca-failed and the otc actions', () => {
    expect(activityPagesInMemory('trade', 'intent-fill')).toBe(false)
    expect(activityWindowPlan(3, 0, 'trade', undefined, undefined, {}, 'intent-fill')).toBeNull()
    // `type=intent` keeps its local arm, and the other trade actions their paths.
    expect(activityPagesInMemory('intent', 'intent-fill')).toBe(true)
    expect(activityPagesInMemory('trade', 'dca')).toBe(true)
    expect(activityPagesInMemory('trade', 'swap')).toBe(true)
  })
  it('short-circuits every builder that would otherwise page the whole trade family', () => {
    const src = read('api/src/services/explorerService.ts')
    const body = (name: string) => {
      const start = src.indexOf(name)
      expect(start, name).toBeGreaterThan(-1)
      return src.slice(start, src.indexOf('\n}\n', start))
    }
    const window = body('async function buildActivityWindow(')
    const dcaFailed = window.indexOf("if (type === 'trade' && action === 'dca-failed') {")
    const intentOnly = window.indexOf('} else if (isIntentOnlyTradeRequest(type, action)) {')
    expect(dcaFailed).toBeGreaterThan(-1)
    expect(intentOnly).toBeGreaterThan(dcaFailed)
    // The same SQL-paged read `type=intent` takes without an action, with the action pushed in.
    expect(window).toContain('getRecentIntents(limit, from, to, undefined, offset, filters, undefined, action)')
    expect(body('async function assetActivityPage(')).toContain('const intentOnly = isIntentOnlyTradeRequest(type, action)')
    expect(body('async function collectAccountActivity(')).toContain('const intentOnly = isIntentOnlyTradeRequest(type, action)')
  })
})

// Inside an ICE solution the pot's AMM trades are how the fills were produced: they
// fold behind the fills on every merged feed, and stay on the pot's own page.
describe('suppressIcePotSettlementTrades', () => {
  const pot = { accountId: ICE_POT_ACCOUNT, address: '7L53bUTB' } as any
  const user = { accountId: OWNER, address: '13b2927f' } as any
  const base = { timestamp: '2026-09-09 10:00:30', to: null, asset: null, assetIn: null, assetOut: null, amount: null, amountIn: null, amountOut: null, valueUsd: null }
  const fill: ActivityRow = { ...base, type: 'intent', blockHeight: 100, eventIndex: 5, extrinsicIndex: 2, who: user, intentAction: 'Fill', intentId: ID }
  const potTrade: ActivityRow = { ...base, type: 'trade', blockHeight: 100, eventIndex: 3, extrinsicIndex: 2, who: pot }
  const potTradeElsewhere: ActivityRow = { ...base, type: 'trade', blockHeight: 100, eventIndex: 9, extrinsicIndex: 3, who: pot }
  const userTrade: ActivityRow = { ...base, type: 'trade', blockHeight: 100, eventIndex: 4, extrinsicIndex: 2, who: user }
  const potHookTrade: ActivityRow = { ...base, type: 'trade', blockHeight: 100, eventIndex: 1, extrinsicIndex: null, who: pot }
  const hookFill: ActivityRow = { ...fill, eventIndex: 2, extrinsicIndex: null }
  it('drops the pot\'s trades from the extrinsic that produced the fills, and nothing else', () => {
    expect(suppressIcePotSettlementTrades([fill, potTrade, potTradeElsewhere, userTrade, potHookTrade, hookFill]))
      .toEqual([fill, potTradeElsewhere, userTrade, potHookTrade, hookFill])
  })
  it('keeps them for the pot\'s own account page', () => {
    expect(suppressIcePotSettlementTrades([fill, potTrade], true)).toEqual([fill, potTrade])
  })
  it('leaves a feed without intent rows untouched', () => {
    expect(suppressIcePotSettlementTrades([potTrade, userTrade])).toEqual([potTrade, userTrade])
  })
  // The solution is an UNSIGNED extrinsic, so a pot trade built from the signer alone has
  // no actor and matches nothing here: attachHookSwapActors must have named the pot first.
  it('cannot fold an actorless pot trade — the swapper has to be attached before', () => {
    const actorless: ActivityRow = { ...potTrade, who: null }
    expect(suppressIcePotSettlementTrades([fill, actorless])).toEqual([fill, actorless])
  })
})

describe('intentOrderStatus', () => {
  it('derives the order state from its lifecycle', () => {
    expect(intentOrderStatus('swap', ['Intent.IntentSubmitted'])).toBe('open')
    expect(intentOrderStatus('swap', ['Intent.IntentSubmitted', 'Intent.IntentResovedPartially'])).toBe('partially-filled')
    expect(intentOrderStatus('swap', ['Intent.IntentSubmitted', 'Intent.IntentResovedPartially', 'Intent.IntentResolved'])).toBe('filled')
    expect(intentOrderStatus('swap', ['Intent.IntentSubmitted', 'Intent.IntentCanceled'])).toBe('cancelled')
    expect(intentOrderStatus('swap', ['Intent.IntentSubmitted', 'Intent.IntentExpired'])).toBe('expired')
    expect(intentOrderStatus('dca', ['Intent.IntentSubmitted', 'Intent.DcaTradeExecuted'])).toBe('open')
    expect(intentOrderStatus('dca', ['Intent.IntentSubmitted', 'Intent.DcaTradeExecuted', 'Intent.DcaCompleted'])).toBe('completed')
  })
  it('lets a cancel outrank a partial fill and a DCA trade', () => {
    expect(intentOrderStatus('swap', ['Intent.IntentSubmitted', 'Intent.IntentResovedPartially', 'Intent.IntentCanceled'])).toBe('cancelled')
    expect(intentOrderStatus('dca', ['Intent.IntentSubmitted', 'Intent.DcaTradeExecuted', 'Intent.IntentCanceled'])).toBe('cancelled')
  })
})

// amountOut/amountIn in whole units, 12 decimal places, integer arithmetic only.
describe('limitPriceOutPerIn', () => {
  it('scales both legs by their decimals', () => {
    // 1000 DOT (10 dp) for 4500 USDT (6 dp) → 4.5 USDT per DOT
    expect(limitPriceOutPerIn('10000000000000', 10, '4500000000', 6)).toBe('4.500000000000')
    // 2 HDX (12 dp) for 0.03 USDT → 0.015
    expect(limitPriceOutPerIn('2000000000000', 12, '30000', 6)).toBe('0.015000000000')
  })
  it('truncates past twelve places and refuses a zero or unreadable input', () => {
    expect(limitPriceOutPerIn('3000000000000', 12, '1000000', 6)).toBe('0.333333333333')
    expect(limitPriceOutPerIn('0', 12, '1000000', 6)).toBeNull()
    expect(limitPriceOutPerIn('abc', 12, '1000000', 6)).toBeNull()
  })
})

// The schedule a DCA.Migrated row names. An unreadable id is null, never 0 — 0 is
// the first real schedule id — and `Number(null)` would have been exactly that 0.
describe('dcaMigratedScheduleId', () => {
  it('reads a numeric or string id and refuses anything else', () => {
    expect(dcaMigratedScheduleId({ id: 33546 })).toBe(33546)
    expect(dcaMigratedScheduleId({ id: '33546' })).toBe(33546)
    expect(dcaMigratedScheduleId({ id: 0 })).toBe(0)
    expect(dcaMigratedScheduleId({})).toBeNull()
    expect(dcaMigratedScheduleId({ id: null })).toBeNull()
    expect(dcaMigratedScheduleId({ id: 'abc' })).toBeNull()
    expect(dcaMigratedScheduleId({ id: -1 })).toBeNull()
  })
})

describe('resolveIntentActions', () => {
  it('does not admit a prototype key as an action', () => {
    expect(resolveIntentActions('toString')).toBeUndefined()
    expect(resolveIntentActions('constructor')).toBeUndefined()
  })
})

// A migrated or migration-cancelled schedule is finished; either outranks the
// live state and the pre-443 states are unchanged.
describe('dcaScheduleStatus with migration', () => {
  it('keeps the pre-443 answers byte-identical', () => {
    expect(dcaScheduleStatus(true, false, true)).toBe('cancelled')
    expect(dcaScheduleStatus(true, false, false)).toBe('terminated')
    expect(dcaScheduleStatus(false, true, false)).toBe('completed')
    expect(dcaScheduleStatus(false, false, false)).toBe('active')
  })
  it('names the migration outcomes', () => {
    expect(dcaScheduleStatus(false, false, false, true, false)).toBe('migrated')
    expect(dcaScheduleStatus(false, false, false, false, true)).toBe('migration-cancelled')
  })
  // dca_events stores the raw `reason` JSON; the enum may serialise bare or tagged.
  it('reads the cancel reason in either enum serialisation', () => {
    expect(dcaMigrationReason('{"__kind":"BudgetBelowTrade"}')).toBe('BudgetBelowTrade')
    expect(dcaMigrationReason('"ForceCancelled"')).toBe('ForceCancelled')
    expect(dcaMigrationReason('')).toBeNull()
    expect(dcaMigrationReason('{"value":1}')).toBeNull()
  })
})

describe('notification parity', () => {
  const base = { blockHeight: 100, timestamp: '2026-09-09 10:00:30', eventIndex: 5, extrinsicIndex: 2, who: null, to: null, asset: null, assetIn: null, assetOut: null, amount: null, amountIn: null, amountOut: null, valueUsd: 5000 }
  const otc = (otcAction: 'Place' | 'Pull' | 'Fill'): ActivityRow => ({ ...base, type: 'otc', otcAction })
  const intent = (intentAction: ActivityRow['intentAction'], intentKind: 'swap' | 'dca' = 'swap'): ActivityRow => ({ ...base, type: 'intent', intentAction, intentKind, intentId: ID })

  // Placements were admitted at first (an "order placed" alert); the user pulled
  // them after a re-placed 1.2M HDX OTC order kept arriving as a $15k trade — an
  // order trades nothing until it is filled.
  it('admits fills to the large-trade lane and never a placement or a cancel', () => {
    expect(largeTradeRowEligible(otc('Place'))).toBe(false)
    expect(largeTradeRowEligible(otc('Fill'))).toBe(true)
    expect(largeTradeRowEligible(otc('Pull'))).toBe(false)
    expect(largeTradeRowEligible(intent('Place', 'swap'))).toBe(false)
    expect(largeTradeRowEligible(intent('Place', 'dca'))).toBe(false)
    expect(largeTradeRowEligible(intent('Fill'))).toBe(true)
    expect(largeTradeRowEligible(intent('PartialFill'))).toBe(true)
    expect(largeTradeRowEligible(intent('DcaTrade', 'dca'))).toBe(true)
    expect(largeTradeRowEligible(intent('Cancel'))).toBe(false)
    expect(largeTradeRowEligible(intent('Expire'))).toBe(false)
    expect(largeTradeRowEligible({ ...base, type: 'trade' })).toBe(true)
  })

  it('lets a dca rule and the dca action filter see DCA intents', () => {
    expect(activityTypeSelects(intent('DcaTrade', 'dca'), 'dca')).toBe(true)
    expect(activityTypeSelects(intent('Fill', 'swap'), 'dca')).toBe(false)
    expect(activityTypeSelects({ ...base, type: 'trade', dca: true }, 'dca')).toBe(true)
    expect(activityRowMatchesAction(intent('DcaTrade', 'dca'), 'dca')).toBe(true)
    expect(activityRowMatchesAction(intent('Place', 'dca'), 'dca')).toBe(false)
    expect(activityRowMatchesAction(intent('Fill', 'swap'), 'dca')).toBe(false)
  })

  it('reads as the product does in a headline', () => {
    const rule: NotificationRule = { ruleId: 'r', accountId: OWNER, kind: 'large-trade', name: '', params: { minUsd: 1 }, channels: [], muted: false, cooldownS: 0 }
    const title = (row: ActivityRow) => renderNotification(renderMatch({ ruleId: 'r', accountId: OWNER, kind: 'large-trade', identity: 'i', blockHeight: 100, payload: { lane: 'activity', row } }, rule, () => null)).title
    expect(title(intent('Place', 'swap'))).toBe('Limit order placed')
    expect(title(intent('Fill', 'swap'))).toBe('Limit order filled')
    expect(title(intent('PartialFill', 'swap'))).toBe('Limit order partially filled')
    expect(title(intent('DcaTrade', 'dca'))).toBe('DCA intent trade')
    expect(title(intent('Cancel', 'swap'))).toBe('Limit order cancelled')
    expect(title(intent('Expire', 'swap'))).toBe('Limit order expired')
  })

  // A DCA-intent placement is judged like an old schedule: per-hour notional. The row is
  // intent 34's intent_orders row (14402251-e15): 190.21868 aUSDC every 18 blocks, budget 570.656041.
  const dcaOrder = (over: Record<string, unknown> = {}) => ({
    intent_id: DCA_ID, seq: 34, owner: OWNER, asset_in: 1003, asset_out: 1000766,
    amount_in: '190218680', budget: '570656041', period: 18, block_height: 14402251, ...over,
  })
  // aUSDC at $1 (6 dp); nothing else priced.
  const priceUsdc = (assetId: number, raw: string): number | null => assetId === 1003 ? Number(raw) / 1e6 : null

  it('maps a budgeted and a rolling dca intent order onto the schedule shape', () => {
    expect(dcaIntentScheduleRow(dcaOrder())).toEqual({
      id: 34, intentId: DCA_ID, blockHeight: 14402251, who: OWNER, assetIn: 1003, assetOut: 1000766,
      direction: 'Sell', amountPer: '190218680', totalAmount: '570656041', periodBlocks: 18,
    })
    expect(dcaIntentScheduleRow(dcaOrder({ budget: '' })).totalAmount).toBe('0')
  })

  it('values an hour of a dca intent as perTradeUsd × 3600 / (period × 2) at 2 s blocks, capped by the budget', () => {
    // $190.21868 every 18 blocks → 190.21868 × 3600 / 36 = $19,021.868/h, capped by the $570.656041 budget
    expect(dcaHourly(dcaIntentScheduleRow(dcaOrder()), priceUsdc, 2000).hourlyUsd).toBeCloseTo(570.656041, 6)
    // rolling (no budget): the full hourly rate
    expect(dcaHourly(dcaIntentScheduleRow(dcaOrder({ budget: '' })), priceUsdc, 2000).hourlyUsd).toBeCloseTo(19021.868, 3)
    // every 1800 blocks → 190.21868 × 3600 / 3600 = $190.22/h, under the budget
    expect(dcaHourly(dcaIntentScheduleRow(dcaOrder({ period: 1800 })), priceUsdc, 2000).hourlyUsd).toBeCloseTo(190.21868, 5)
  })

  it('fires a DCA-intent start under its own identity and links the order page', () => {
    const rule: NotificationRule = { ruleId: 'r', accountId: OWNER, kind: 'large-trade', name: '', params: { minUsd: 100, dcaStart: true }, channels: [], muted: false, cooldownS: 0 }
    const row = dcaIntentScheduleRow(dcaOrder())
    const matches = evaluateDcaStart([row], [rule], { from: 14402250, to: 14402251 }, priceUsdc, 2000)
    expect(matches).toHaveLength(1)
    expect(matches[0].identity).toBe(`intent:${DCA_ID}`)
    const out = renderNotification(renderMatch(matches[0] as RuleMatch, rule, () => null))
    expect(out.title).toContain(`DCA intent started ${assetDescriptor(1003).symbol} → ${assetDescriptor(1000766).symbol}`)
    expect(out.url).toMatch(new RegExp(`/intent/${DCA_ID}$`))
    expect(evaluateDcaStart([row], [{ ...rule, params: { minUsd: 100, dcaStart: false } }], { from: 14402250, to: 14402251 }, priceUsdc, 2000)).toHaveLength(0)
  })
})
