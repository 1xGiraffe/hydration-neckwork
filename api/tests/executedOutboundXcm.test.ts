import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ActivityRow } from '../src/services/explorerService.ts'
import { admitsExecutedXcmWithdrawal, emitsExecutedOutboundXcm, executedXcmPayloadLegs, executedXcmSendExtrinsics, isBridgePlumbingSwap, suppressSubordinateActivityRows } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const occurrences = (needle: string): number => explorerService.split(needle).length - 1

// Hydration sets `type XcmEventEmitter = ()` (runtime/hydradx/src/xcm.rs:269), so any
// message the XCM *executor* dispatches — InitiateReserveWithdraw, DepositReserveAsset,
// InitiateTransfer, ExportMessage — leaves only `XcmpQueue.XcmpMessageSent` behind.
// `PolkadotXcm.Sent` is deposited solely where pallet_xcm itself delivers. So the modern
// `PolkadotXcm.execute` / EVM-dispatch-precompile path emits no Sent and no XTokens event,
// and the feed's send list (XTokens pair + PolkadotXcm.Sent) cannot see it at all:
// 2,974 extrinsics measured, growing from ~120/month through 2025 to ~320/month since
// June 2026.
describe('executor-dispatched outbound XCM is recognised', () => {
  it('emits when the message left and nothing else already claimed it', () => {
    expect(emitsExecutedOutboundXcm(true, [])).toBe(true)
    expect(emitsExecutedOutboundXcm(true, ['transfer'])).toBe(true)
  })

  // The load-bearing half of the guard: 1,248 extrinsics carry BOTH XcmpMessageSent and
  // PolkadotXcm.Sent (pallet_xcm delivered, and the executor also queued the XCMP leg).
  // Those already have a row from getRecentXcm/parseOutboundXcm — emitting again doubles them.
  it('never doubles a send that already produced an xcm row', () => {
    expect(emitsExecutedOutboundXcm(true, ['xcm'])).toBe(false)
    expect(emitsExecutedOutboundXcm(true, ['trade', 'xcm'])).toBe(false)
  })

  // The defect this fixes. The SDK builds every fee-bearing bridge as
  // `Utility.batch_all([Router.buy, PolkadotXcm.execute])`, so the extrinsic carries a swap
  // row. Yielding to it hid the bridge entirely: on block 13841482 the account's page showed
  // one HDX->DOT trade (115 HDX -> 1.29 DOT of delivery fee) and no sign that 3.84 USDC
  // had left for Ethereum.
  it('does NOT yield to a swap row in the same extrinsic', () => {
    expect(emitsExecutedOutboundXcm(true, ['trade'])).toBe(true)
  })

  it('stays silent when no message left the chain', () => {
    expect(emitsExecutedOutboundXcm(false, [])).toBe(false)
    expect(emitsExecutedOutboundXcm(false, ['trade'])).toBe(false)
  })
})

// Once the bridge row exists, the swap beside it is the delivery-fee purchase, not a trade
// the user made. Verified on chain: the six sends of 0x13a53d99… decode to `0x0d02`
// (Utility.batch_all) while every standalone swap that account made decodes to `0x4300`
// (Router.sell) in its own extrinsic — so sharing an extrinsic with an outbound marker is
// what separates plumbing from a real trade. This is the same extrinsic-keyed ownership
// rule suppressActivityPlumbing already applies to transfer legs.
describe('a swap sharing an extrinsic with an outbound bridge is plumbing', () => {
  it('suppresses the swap when the extrinsic sent a message', () => {
    expect(isBridgePlumbingSwap(true)).toBe(true)
  })

  it('leaves a standalone swap alone', () => {
    expect(isBridgePlumbingSwap(false)).toBe(false)
  })
})

// The extrinsic page had the whole event list in hand, so fixing its precedence was enough.
// The FEED surfaces (account, global, asset) build each row type from its own arm, and the
// outbound arm — getRecentXcm — finds its candidates by `sender IN (…)` on
// raw_xcm_activity. That column is NULL on 100% of the 271,571 XcmpQueue.XcmpMessageSent
// rows (it is populated on 0% of them, versus 100% of the XTokens rows), so no filter on
// that arm can reach an executor-dispatched send. getRecentXcmExecuted is a sibling arm that
// inverts the lookup: the candidate IS the user's Currencies.Withdrawn row, whose `who` is
// the ORDER BY prefix of xcm_event_activity_by_account, and the marker only filters it.
describe('an executed send is attributed to the withdrawing account', () => {
  it('claims a marker extrinsic that emitted no legacy send event', () => {
    expect(executedXcmSendExtrinsics(['100:2'], [])).toEqual(new Set(['100:2']))
  })

  // The same 1,248 both-marker extrinsics getRecentXcm already returns rows for. Claiming
  // them here would double every one of them on the feed.
  it('yields a both-marker extrinsic to the legacy arm', () => {
    expect(executedXcmSendExtrinsics(['100:2'], ['100:2'])).toEqual(new Set())
    expect(executedXcmSendExtrinsics(['100:2', '101:0'], ['100:2'])).toEqual(new Set(['101:0']))
  })

  it('claims nothing from an extrinsic that never sent a message', () => {
    expect(executedXcmSendExtrinsics([], ['100:2'])).toEqual(new Set())
  })

  // A bridge send withdraws from the user AND from pallet pots (routerex on the fee swap,
  // the reserve account on the transfer leg). Only the user's leg is the economic action;
  // the pot legs are the same plumbing RESERVED_ACCOUNT_RE strips everywhere else.
  it('admits the user leg and drops the pallet-pot legs', () => {
    expect(admitsExecutedXcmWithdrawal('0x13a53d99c2a0dc306bb64488167797323e1fe539', '3840000')).toBe(true)
    expect(admitsExecutedXcmWithdrawal('0x6d6f646c726f7574657265780000000000000000000000000000000000000000', '3840000')).toBe(false)
    expect(admitsExecutedXcmWithdrawal('0x7369626c07080000000000000000000000000000000000000000000000000000', '1')).toBe(false)
    expect(admitsExecutedXcmWithdrawal('0x70617261feff0000000000000000000000000000000000000000000000000000', '1')).toBe(false)
  })

  it('drops a zero or missing amount', () => {
    expect(admitsExecutedXcmWithdrawal('0x13a53d99c2a0dc306bb64488167797323e1fe539', '0')).toBe(false)
    expect(admitsExecutedXcmWithdrawal('0x13a53d99c2a0dc306bb64488167797323e1fe539', '')).toBe(false)
    expect(admitsExecutedXcmWithdrawal('', '3840000')).toBe(false)
  })
})

// A new arm reaches a surface only by being named on it. Half-wiring is silent: the account
// page would show the sends while the exact-count path disagreed, and a count mismatch is
// what makes a page refuse to render. Pinning the call-site COUNT (not just presence) is why
// this catches a surface added later without its arm.
describe('the executed-send arm is wired into every feed surface', () => {
  it('is called on all six surfaces and defined once', () => {
    // One definition + the classified global feed, the two type-filtered global paths
    // (`xcm` and `all`), the asset surface, the exact-count enumerated path, and the
    // account page.
    expect(occurrences('getRecentXcmExecuted(')).toBe(7)
  })

  it('is a classified source of its own, so saturation is counted per leg', () => {
    // Sharing the 'xcm' key would compare one arm's rawSize against both arms' fetchSize.
    expect(explorerService).toContain("'xcmExecuted'")
    expect(explorerService).toContain("{ key: 'xcmExecuted', fetchSize: sourceFetchSize('xcmExecuted')")
    expect(explorerService).toContain("loadClassifiedSource('xcmExecuted'")
  })

  it('joins the xcm leg set wherever legs are enumerated by name', () => {
    // The asset surface is the one that lists its legs by name (the global feed enumerates
    // through `allSources`, so membership in classifiedSourceKeys covers it, and the
    // account/exact-count paths flatten a `xcmLegs` array). An arm missing from the named
    // list is an arm whose exhaustion never raises "query too broad".
    expect(occurrences('[xcm, xcmIn, xcmOutRemote, xcmExecuted, nttOut, nttIn]')).toBe(1)
    expect(occurrences('...xcm, ...xcmIn, ...xcmOutRemote, ...xcmExecuted, ...nttOut, ...nttIn')).toBe(1)
  })
})

// A send extrinsic emits exactly ONE message — measured across all 2,650 of them — so a
// bridge send is ONE activity, not one per asset that left. The extra Currencies.Withdrawn
// legs are its cost: the XCM fee(s), and the input leg of any Router call batched in to buy
// them. The executor withdraws in program order — WithdrawAsset/BuyExecution for the fees
// first, the payload last — so the payload is the highest event_index leg of the extrinsic.
//
// Verified on chain. 13841482 legs (ev 42 DOT 1.28, ev 44 USDC 3.84): payload is the USDC.
// 13797529 legs (ev 5 USDC 0.0138, ev 7 DOT, ev 9 USDC 16.38): payload is the last USDC, and
// note the rule beats "largest of its asset" and "first of its asset" both. Population-wide
// the dropped legs are the fee assets (HDX 0, DOT 5) and swap inputs, which is why the
// reverse shape — Router.sell(USDC->DOT) then send DOT — also keeps the right leg.
describe('a bridge send folds to one row', () => {
  const leg = (eventIndex: number, who = 'a') => ({ eventIndex, who, extrinsicIndex: 2, blockHeight: 1 })
  const key = (l: { blockHeight: number; extrinsicIndex: number | null; who: string }) =>
    `${l.blockHeight}:${l.extrinsicIndex}:${l.who}`
  const order = (l: { eventIndex: number }) => l.eventIndex

  it('keeps the payload leg and drops the fee legs', () => {
    expect(executedXcmPayloadLegs([leg(42), leg(44)], key, order)).toEqual([leg(44)])
    expect(executedXcmPayloadLegs([leg(5), leg(7), leg(9)], key, order)).toEqual([leg(9)])
  })

  it('does not depend on the order the legs arrive in', () => {
    expect(executedXcmPayloadLegs([leg(44), leg(42)], key, order)).toEqual([leg(44)])
  })

  it('leaves a single-leg send alone', () => {
    expect(executedXcmPayloadLegs([leg(42)], key, order)).toEqual([leg(42)])
  })

  // ~40 send extrinsics withdraw from two accounts. Each account's feed must still show its
  // own send, so the fold is per (extrinsic, account) — never one row for the extrinsic.
  it('folds per account, not per extrinsic', () => {
    const folded = executedXcmPayloadLegs([leg(42, 'a'), leg(44, 'a'), leg(46, 'b')], key, order)
    expect(folded).toHaveLength(2)
    expect(folded).toEqual(expect.arrayContaining([leg(44, 'a'), leg(46, 'b')]))
  })
})

// The other two rows the user saw. The swap is the delivery-fee purchase, so it folds behind
// the send exactly as a transfer leg folds behind the semantic row that owns its extrinsic.
// Gated on the executor-dispatched marker, NOT on "any xcm row in the extrinsic": a
// deliberate `batch_all([Router.sell, XTokens.transfer])` is a swap the user chose to make
// and a bridge they chose to make, and both belong on the feed.
describe('the fee-purchase swap folds behind the send it funded', () => {
  const row = (over: Partial<ActivityRow>): ActivityRow => ({
    type: 'trade', blockHeight: 13841482, timestamp: '', eventIndex: 39, extrinsicIndex: 2,
    who: null, to: null, asset: null, assetIn: null, assetOut: null,
    amount: null, amountIn: null, amountOut: null, valueUsd: null, ...over,
  })
  const types = (rows: ActivityRow[]) => rows.map(r => r.type)

  it('drops the swap that bought an executor-dispatched send its fee', () => {
    const rows = [row({ type: 'xcm', eventIndex: 44, xcmExecuted: true }), row({ type: 'trade' })]
    expect(types(suppressSubordinateActivityRows(rows))).toEqual(['xcm'])
  })

  it('keeps a swap batched with a pallet_xcm/XTokens send', () => {
    const rows = [row({ type: 'xcm', eventIndex: 44 }), row({ type: 'trade' })]
    expect(types(suppressSubordinateActivityRows(rows))).toEqual(['xcm', 'trade'])
  })

  it('keeps a swap the send did not share an extrinsic with', () => {
    const rows = [row({ type: 'xcm', eventIndex: 44, xcmExecuted: true }), row({ type: 'trade', extrinsicIndex: 3 })]
    expect(types(suppressSubordinateActivityRows(rows))).toEqual(['xcm', 'trade'])
  })

  // The existing contract: it is the transfer legs' owner too, and folding the swap must not
  // change that or the bridge's own transfer legs would reappear.
  it('still folds transfer legs behind the send', () => {
    const rows = [row({ type: 'xcm', eventIndex: 44, xcmExecuted: true }), row({ type: 'transfer' })]
    expect(types(suppressSubordinateActivityRows(rows))).toEqual(['xcm'])
  })
})
