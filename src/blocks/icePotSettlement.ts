/**
 * Whose trade an ICE settlement is.
 *
 * An ICE solution is submitted by the solver, so every AMM route it runs carries
 * the ICE pot as the Broadcast `swapper`. Booking those legs as they stand credits
 * the pot with the trade and leaves the person whose intent caused it with no
 * volume at all: the pot led every candle's per-account breakdown while the owner
 * of the DCA driving it appeared nowhere.
 *
 * The pot is a holding account, not a trader. Within one settlement extrinsic it
 * moves the owner's input IN and the fill OUT, both as `Currencies.Transferred`
 * against the owner's own account, so the extrinsic names the owner without any
 * cross-block state: the pot's transfer counterparties ARE the intents' owners.
 * Measured over ICE's whole history (from block 14,396,667), all 150 solutions
 * settle exactly ONE owner, so naming that account is exact rather than a share-out.
 *
 * A solution serving several owners at once is possible even though none has
 * occurred: its route legs cannot be divided between them without inventing a
 * split, so such a solution keeps the pot — the same "leave it as it was rather
 * than guess" rule an unresolvable OTC fill takes (see otcSides).
 *
 * This rule lives here because three paths book this same trade — the live indexer
 * (src/blocks/extractVolume.ts), the repair script (src/scripts/repair-volume.ts)
 * and the `account_trade_volume` SQL mirror (api/src/services/accountTradeVolume.ts).
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
 * The ICE pot is NOT here: its settlements DO name an owner, so they are
 * re-attributed by `icePotSettlementOwner` instead of dropped.
 */
export const UNATTRIBUTABLE_VOLUME_POTS = [FEE_PROCESSOR_ACCOUNT] as const

/**
 * The transfer events an ICE settlement moves the owner's funds with. BOTH are
 * needed: over ICE's whole history the pot's legs are 409 `Tokens.Transfer` and
 * 308 `Currencies.Transferred`, and reading only the former — the one the
 * processor already subscribed to — leaves 15 of 150 solutions naming no owner
 * at all, because an aToken leg is reported as `Currencies.Transferred` alone.
 * With both, all 150 name exactly one.
 */
export const ICE_SETTLEMENT_TRANSFER_EVENTS = ['Tokens.Transfer', 'Currencies.Transferred'] as const

const normalize = (account: string | null | undefined): string | null =>
  account == null || account.length === 0 ? null : account.toLowerCase()

/**
 * Substrate derives a pallet's own account from `modl` + its pallet id, so an
 * account starting with those bytes is protocol machinery and never an intent
 * owner. The pot's legs are full of them — 211 of its 717 legs face another
 * module account (the router paying the solution's output into the pot, the fee
 * processor taking its cut) — and counting those as owners would make every such
 * solution look multi-owner and stop it being attributed at all.
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
 * attribute to) or more than one (a multi-owner solution, which cannot be divided
 * without guessing) — the caller then leaves the trade booked to the pot.
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
