/**
 * Who was on which side of an OTC fill.
 *
 * A Broadcast OTC fill is internally inconsistent and cannot be booked as it
 * stands. Measured over every OTC fill on chain (796, across
 * Broadcast.Swapped/Swapped2/Swapped3):
 *
 *  * `inputs`/`outputs` are ALWAYS the ORDER's direction, which is the TAKER's:
 *    the order's input is what the taker pays in, its output what the taker takes
 *    out. 796 of 796.
 *  * `swapper` names the order's MAKER in 620 of them and the taker in the other
 *    176 — the same two accounts swap roles from block to block, and the split
 *    does not follow the call either (`OtcSettlements.settle_otc_order` and
 *    `Dispatcher.dispatch_with_extra_gas` each appear on both sides). So the legs
 *    describe the taker while `swapper` describes whichever party the runtime felt
 *    like naming, and booking the legs against `swapper` reports a resting seller
 *    as a buyer.
 *  * the taker is ALWAYS one of {swapper, filler} — 0 of 796 name neither — so
 *    once the taker is known the maker is simply the other one.
 *
 * What names the taker is the pallet's own fill event, which sits at exactly
 * `event_index - 1` for all 796 fills and carries it as `who`.
 *
 * This rule lives here because three separate paths book this same trade — the
 * live indexer (src/blocks/extractVolume.ts), the repair script
 * (src/scripts/repair-volume.ts) and the `account_trade_volume` SQL mirror — and
 * they had already drifted into three copies of the legacy XYK/LBP inversion.
 */

/** The OTC pallet events that report a fill and name its taker as `who`. */
export const OTC_FILL_EVENT_NAMES = ['OTC.Filled', 'OTC.PartiallyFilled'] as const

/** `fillerType.__kind` of a Broadcast fill that came from an OTC order. */
export const OTC_FILLER_KIND = 'OTC'

/**
 * The two accounts of an OTC fill, on their true sides: `trader` holds the legs as
 * the event states them and `counterparty` holds their mirror.
 *
 * Returns null when the pairing cannot be established — no taker (the sibling
 * event is not in the window being read), or a taker that is neither of the two
 * accounts the Broadcast names. Callers then leave the trade booked as it was
 * rather than guessing which account is which.
 */
export function otcSides(
  swapper: string | null | undefined,
  fillerAccount: string | null | undefined,
  taker: string | null | undefined,
): { trader: string; counterparty: string } | null {
  if (!taker || !swapper || !fillerAccount) return null
  if (taker === swapper) return { trader: swapper, counterparty: fillerAccount }
  if (taker === fillerAccount) return { trader: fillerAccount, counterparty: swapper }
  return null
}
