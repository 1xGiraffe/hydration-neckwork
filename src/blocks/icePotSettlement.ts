/**
 * Whose trade an ICE settlement is.
 *
 * An ICE solution is submitted by the solver, so every AMM route it runs carries
 * the ICE pot as the Broadcast `swapper`. Booking those legs as they stand credits
 * the pot with the trade and leaves the people whose intents caused it with no
 * volume at all: the pot led every candle's per-account breakdown while the owner
 * of the DCA driving it appeared nowhere.
 *
 * The pot is a holding account, not a trader. Within one settlement extrinsic it
 * moves each owner's input IN and the fill OUT against the owner's own account, so
 * the extrinsic names the owners without any cross-block state. Two rules, by how
 * many owners the solution served:
 *
 * - ONE owner (45,128 of the 46,444 solutions by November 2026): the pot's
 *   transfer counterparties are that owner, and the route legs are booked to it as
 *   they stand (`icePotSettlementOwner`) — exact, and the same booking an ordinary
 *   routed trade gets.
 * - SEVERAL owners (1,316 solutions, two to four owners each): the routes cannot
 *   be divided between them — ICE matches the intents against each other and
 *   routes only the remainder, so one route's input is one owner's and its output
 *   another's. Each owner is booked its FILL instead (`iceSolutionFills`): what the
 *   solution's own call states it resolved for the intent, paid out by the pot to
 *   the owner. The route legs then get no per-account row, the fee processor's
 *   rule; the candle's own volume still counts them.
 * - NO route at all (3 solutions by November 2026: the intents matched each other
 *   whole): there is nothing to re-attribute, so the owners' fills are booked from
 *   the call the same way, whatever the owner count.
 *
 * What that leaves between a candle's volume and its accounts. The candle's volume
 * is POOL volume — every Broadcast fill, the solution's routes included, the same
 * definition every other volume surface uses (pool_swap_legs, the explorer's and
 * the public API's volumes) — and a fill booked here adds nothing to it. So:
 * - the part of a fill ICE matched against another intent, never touching a pool,
 *   is in its owner's figures and in no candle (pure peer-to-peer matching is the
 *   extreme: accounts traded, the candle did not);
 * - a route hop through an asset no owner traded (an intermediate asset of a
 *   several-owner solution) is in the candle and in no account's figures, as the
 *   fee processor's conversions are.
 * A candle's account sum can therefore fall short of its volume or exceed it. The
 * preis inspection states the difference as its own row rather than hiding it
 * (api/src/services/tradeVolumeService.ts, `candle*` fields). Counting matched
 * volume in the candle instead was weighed and refused: no other volume surface
 * can see it (it emits no Broadcast fill, unlike an OTC fill, which is one), so
 * the preis candles — and public `/v1/prices` `volumeUsd`, read from the same
 * candles — would disagree with every other volume Hydration Neckwork publishes.
 *
 * A solution neither rule can state keeps the pot rather than a guessed split —
 * the same "leave it as it was rather than guess" rule an unresolvable OTC fill
 * takes (see otcSides).
 *
 * This rule lives here because two paths book this same trade — the live indexer
 * (src/blocks/extractVolume.ts) and the repair script (src/scripts/repair-volume.ts).
 * The explorer's `account_trade_volume` (api/src/services/accountTradeVolume.ts)
 * books every owner's fill from the Intent events and the order, whatever the
 * owner count; the amounts are the same (see `iceSolutionFills`).
 */

/** The ICE solver's holding pot: `modl` + `ice_ice#`. */
export const ICE_POT_ACCOUNT = '0x6d6f646c6963655f696365230000000000000000000000000000000000000000'

/**
 * Runtime 443, which introduced the intent pallet. No settlement can exist below
 * it, so a range read for pot legs starts here (the first event actually observed
 * is at 14,396,667; the activation block is the safe bound).
 */
export const ICE_FIRST_BLOCK = 14_362_830

/** The fee processor's pot: `modl` + `feeproc/`. */
export const FEE_PROCESSOR_ACCOUNT = '0x6d6f646c66656570726f632f0000000000000000000000000000000000000000'

/**
 * Pots whose swaps are protocol machinery rather than anybody's trade, and which
 * have no owner to hand them to. The fee processor converts collected fees; the
 * accounts that paid them are the whole chain, so there is no account the volume
 * could name. Their rows are dropped from per-account volume rather than
 * re-attributed — the candle's own volume still counts the swap, so a candle
 * holding fee conversions lists accounts summing to less than it traded.
 *
 * The ICE pot is NOT here: its settlements DO name their owners, so they are
 * re-attributed (`icePotSettlementOwner`, `iceSolutionFills`) instead of dropped.
 */
export const UNATTRIBUTABLE_VOLUME_POTS = [FEE_PROCESSOR_ACCOUNT] as const

/**
 * The transfer events an ICE settlement moves the owner's funds with. BOTH are
 * read: an aToken or Erc20 leg is reported as `Currencies.Transferred` alone, and
 * every fill's payout to its owner is one (see ICE_PAYOUT_EVENT), so reading
 * `Tokens.Transfer` alone leaves a settlement naming no owner at all.
 */
export const ICE_SETTLEMENT_TRANSFER_EVENTS = ['Tokens.Transfer', 'Currencies.Transferred'] as const

const normalize = (account: string | null | undefined): string | null =>
  account == null || account.length === 0 ? null : account.toLowerCase()

/**
 * Substrate derives a pallet's own account from `modl` + its pallet id, so an
 * account starting with those bytes is protocol machinery and never an intent
 * owner. The pot's legs are full of them — the router paying a route's output
 * into the pot, the fee account taking ICE's cut — and counting those as owners
 * would make every such solution look multi-owner and stop it being attributed.
 */
const MODULE_ACCOUNT_PREFIX = '0x6d6f646c'
const isModuleAccount = (account: string): boolean => account.startsWith(MODULE_ACCOUNT_PREFIX)

/** Whether a Broadcast trade's swapper is the ICE pot, i.e. a solution's own route leg. */
export function isIcePotSwapper(swapper: string | null | undefined): boolean {
  return normalize(swapper) === ICE_POT_ACCOUNT
}

/** Whether an account's swaps are machinery with nobody to attribute them to. */
export function isUnattributableVolumePot(account: string | null | undefined): boolean {
  const id = normalize(account)
  return id != null && UNATTRIBUTABLE_VOLUME_POTS.some(pot => pot === id)
}

/**
 * The intent owner an ICE settlement belongs to, from the pot's transfer legs in
 * that same settlement extrinsic.
 *
 * `legs` are the extrinsic's transfers that have the pot on one side, in either
 * direction. Returns null when the extrinsic names no counterparty (nothing to
 * attribute to) or more than one (a multi-owner solution, whose routes cannot be
 * divided without guessing — `iceSolutionFills` books its owners instead).
 */
export function icePotSettlementOwner(
  legs: ReadonlyArray<{ from: string | null | undefined; to: string | null | undefined }>,
): string | null {
  const owners = new Set<string>()
  for (const leg of legs) {
    const from = normalize(leg.from)
    const to = normalize(leg.to)
    const counterparty = from === ICE_POT_ACCOUNT ? to : to === ICE_POT_ACCOUNT ? from : null
    if (counterparty == null || counterparty === ICE_POT_ACCOUNT || isModuleAccount(counterparty)) continue
    owners.add(counterparty)
  }
  return owners.size === 1 ? [...owners][0] : null
}

/** The call an ICE solution is submitted with. It states every intent the solution resolved. */
export const ICE_SOLUTION_CALL = 'ICE.submit_solution'

/**
 * The event the pot pays an intent's fill out with: one `Currencies.Transferred`
 * pot → owner of exactly the resolved `amountOut` in the intent's `assetOut`. It is
 * the one transfer event every asset reports — HDX's `Balances.Transfer` and an
 * Erc20 asset's EVM log both come with it, `Tokens.Transfer` does not.
 */
const ICE_PAYOUT_EVENT = 'Currencies.Transferred'

/** One intent as the solution resolved it: what the owner paid in and was paid out. */
export interface IceResolvedIntent {
  assetIn: number
  amountIn: bigint
  assetOut: number
  amountOut: bigint
}

/** A resolved intent with the account it belongs to. */
export interface IceFill extends IceResolvedIntent {
  owner: string
}

/** A pot transfer leg of the settlement extrinsic, with what it moved. */
export interface IcePotLeg {
  event: string
  from: string | null | undefined
  to: string | null | undefined
  assetId: number | null
  amount: bigint | null
}

function toAmount(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  return null
}

function toAssetId(value: unknown): number | null {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 ? id : null
}

/**
 * One of ICE_SETTLEMENT_TRANSFER_EVENTS' args (decoded or JSON form) as a pot leg,
 * or null when they name no two accounts.
 */
export function icePotLegOf(event: string, args: unknown): IcePotLeg | null {
  const a = args as { from?: unknown; to?: unknown; currencyId?: unknown; amount?: unknown } | null | undefined
  const from = typeof a?.from === 'string' && a.from.length > 0 ? a.from : null
  const to = typeof a?.to === 'string' && a.to.length > 0 ? a.to : null
  if (!from || !to) return null
  return { event, from, to, assetId: toAssetId(a?.currencyId), amount: toAmount(a?.amount) }
}

/**
 * The intents an `ICE.submit_solution` call resolved, from its JSON-form args
 * (`solution.resolvedIntents[].data`: `Swap { assetIn, assetOut, amountIn,
 * amountOut }`). Null when the call carries no list or any entry is a kind or a
 * shape this rule does not know — a solution read only in part would book its
 * owners only in part.
 */
export function iceResolvedIntents(args: unknown): IceResolvedIntent[] | null {
  const list = (args as { solution?: { resolvedIntents?: unknown } } | null | undefined)?.solution?.resolvedIntents
  if (!Array.isArray(list) || list.length === 0) return null
  const out: IceResolvedIntent[] = []
  for (const entry of list) {
    const data = (entry as { data?: { __kind?: unknown; value?: Record<string, unknown> } } | null)?.data
    if (data?.__kind !== 'Swap' || data.value == null) return null
    const assetIn = toAssetId(data.value.assetIn)
    const assetOut = toAssetId(data.value.assetOut)
    const amountIn = toAmount(data.value.amountIn)
    const amountOut = toAmount(data.value.amountOut)
    if (assetIn == null || assetOut == null || amountIn == null || amountOut == null) return null
    out.push({ assetIn, amountIn, assetOut, amountOut })
  }
  return out
}

/**
 * Each owner's FILL in a solution: every resolved intent, booked to the account
 * the pot paid exactly its `amountOut` in its `assetOut` within the settlement
 * extrinsic (`legs` are that extrinsic's pot transfer legs).
 *
 * Both halves are the explorer's figures. A resolved intent's amounts equal its
 * Intent event's for every fill that states them (IntentResolved,
 * IntentResovedPartially, DcaTradeExecuted — 47,581 of 47,581 over ICE's history),
 * and for the budget-exhausting DcaCompleted, which states none, they equal the
 * explorer's settlement figure (services/iceSettlement.ts, 1,104 of 1,104). And a
 * payout of exactly those amounts reaches the intent's order owner for every one
 * of the 48,685 resolved intents on chain.
 *
 * The match is by (assetOut, amountOut) taken as a multiset: an intent group
 * sharing those must meet exactly as many payouts, and when the group's payouts
 * name different accounts its intents must be identical, so which one is whose
 * does not matter (twice on chain: two DCAs on the same terms in one solution).
 * Anything else returns null and the caller leaves the solution on the pot. A
 * payout to a module account names no owner (see `isModuleAccount`).
 */
export function iceSolutionFills(
  intents: readonly IceResolvedIntent[],
  legs: readonly IcePotLeg[],
): IceFill[] | null {
  if (intents.length === 0) return null
  const key = (assetId: number, amount: bigint) => `${assetId}:${amount}`
  const payees = new Map<string, string[]>()
  for (const leg of legs) {
    if (leg.event !== ICE_PAYOUT_EVENT || normalize(leg.from) !== ICE_POT_ACCOUNT) continue
    const to = normalize(leg.to)
    if (to == null || to === ICE_POT_ACCOUNT || isModuleAccount(to) || leg.assetId == null || leg.amount == null) continue
    const k = key(leg.assetId, leg.amount)
    const list = payees.get(k)
    if (list) list.push(to)
    else payees.set(k, [to])
  }
  const groups = new Map<string, IceResolvedIntent[]>()
  for (const intent of intents) {
    const k = key(intent.assetOut, intent.amountOut)
    const group = groups.get(k)
    if (group) group.push(intent)
    else groups.set(k, [intent])
  }
  const fills: IceFill[] = []
  for (const [k, group] of groups) {
    const owners = payees.get(k) ?? []
    if (owners.length !== group.length) return null
    const interchangeable = new Set(owners).size === 1
      || group.every(intent => intent.assetIn === group[0].assetIn && intent.amountIn === group[0].amountIn)
    if (!interchangeable) return null
    group.forEach((intent, i) => fills.push({ ...intent, owner: owners[i] }))
  }
  return fills
}

/** How a trade type is read and rewritten by `bookIceSettlements` (see foldOmnipoolHubHops). */
export interface IceBookingAccess<T> {
  traderOf(trade: T): string | null | undefined
  /** The route leg re-attributed to the solution's one owner. */
  withTrader(trade: T, owner: string): T
  /** The route leg of a solution booked to its owners' fills: no per-account row. */
  bookedAsFills(trade: T): T
  /** An owner's fill as a trade: a per-account booking only, no candle volume. */
  fillTrade(fill: IceFill): T
}

/**
 * Book a block's ICE solutions to their intent owners, for both extractors.
 *
 * `slots` are the block's decoded trades in event order with their extrinsic; the
 * route legs of a solution (swapper = the pot) are rewritten in place. `legs` are
 * each settlement extrinsic's pot transfer legs, `solutions` each one's
 * `ICE.submit_solution` args (absent where the call was not read). Every extrinsic
 * that has route legs or a solution call is booked once:
 * - route legs and ONE owner named by the pot's legs: the legs go to that owner;
 * - otherwise (several owners, or no route at all) each owner's fill from the
 *   call, the route legs marked as booked by them;
 * - neither stated: the routes stay on the pot, and a zero-route solution books
 *   nothing.
 * Returns the fills, by extrinsic, to append after the block's trades.
 */
export function bookIceSettlements<T>(
  slots: Array<{ trade: T; extrinsicIndex?: number | null }>,
  legs: ReadonlyMap<number, readonly IcePotLeg[]>,
  solutions: ReadonlyMap<number, unknown>,
  access: IceBookingAccess<T>,
): T[] {
  const routed = new Set<number>()
  for (const slot of slots) {
    if (slot.extrinsicIndex != null && isIcePotSwapper(access.traderOf(slot.trade))) routed.add(slot.extrinsicIndex)
  }
  const extrinsics = [...new Set([...routed, ...solutions.keys()])].sort((a, b) => a - b)
  const owners = new Map<number, string>()
  const byFills = new Set<number>()
  const fills: T[] = []
  for (const x of extrinsics) {
    const extrinsicLegs = legs.get(x) ?? []
    const owner = routed.has(x) ? icePotSettlementOwner(extrinsicLegs) : null
    if (owner) {
      owners.set(x, owner)
      continue
    }
    const intents = solutions.has(x) ? iceResolvedIntents(solutions.get(x)) : null
    const solved = intents ? iceSolutionFills(intents, extrinsicLegs) : null
    if (!solved) continue
    byFills.add(x)
    for (const fill of solved) fills.push(access.fillTrade(fill))
  }
  for (const slot of slots) {
    const x = slot.extrinsicIndex
    if (x == null || !isIcePotSwapper(access.traderOf(slot.trade))) continue
    const owner = owners.get(x)
    if (owner) slot.trade = access.withTrader(slot.trade, owner)
    else if (byFills.has(x)) slot.trade = access.bookedAsFills(slot.trade)
  }
  return fills
}

/** The extrinsics whose pot legs `bookIceSettlements` needs: every route leg's and every solution call's. */
export function iceSettlementExtrinsics<T>(
  slots: ReadonlyArray<{ trade: T; extrinsicIndex?: number | null }>,
  solutions: ReadonlyMap<number, unknown>,
  traderOf: (trade: T) => string | null | undefined,
): Set<number> {
  const out = new Set<number>(solutions.keys())
  for (const slot of slots) {
    if (slot.extrinsicIndex != null && isIcePotSwapper(traderOf(slot.trade))) out.add(slot.extrinsicIndex)
  }
  return out
}
