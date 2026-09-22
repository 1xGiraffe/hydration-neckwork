// The price limit an ICE intent states, in both directions, from the raw integer
// amounts alone. Shared by the explorer, the public API and the Data API — and,
// through the explorer's response, the MCP server — so one order cannot be quoted
// two ways. A leaf: no imports, no I/O, bigint throughout because an 18-decimal
// amount passes 2^53 routinely.
//
// An intent's limit is `amountOut` per `amountIn`, and it binds on BOTH kinds.
// pallet_intent enforces `resolve.amount_out() >= amount_out` on every fill: over
// the whole order for a swap intent, and over ONE PERIOD's trade for a dca intent
// (validate_dca_intent_resolve). A dca intent's `slippage` never loosens that
// floor — it builds a SECOND, oracle-derived floor (`estimated_out` less the
// slippage) and the pallet takes the tighter of the two — so the price here is the
// owner's hard limit either way, and the floor that actually applies at fill time
// can only be better for them. That is why the limit is stated without folding
// slippage in: the oracle side moves per block and is not a term of the order.
//
// Both directions are published because neither is recoverable from the other.
// Each is truncated at 12 dp, and inverting a truncated decimal does not land on
// the other side's truncation: 135.135135135135 inverts to 0.00740000000000000037
// rather than the exact 0.0074 the raw amounts state. A consumer that needs the
// price of the asset being BOUGHT (the natural reading of a DCA that accumulates)
// reads inPerOut; one that needs the rate of the asset being SOLD reads outPerIn.

const LIMIT_PRICE_DP = 12

export interface IntentLimitPrice {
  // amountOut per one whole amountIn, as a decimal string at 12 dp.
  outPerIn: string
  // amountIn per one whole amountOut — the price cap on what the order buys.
  inPerOut: string
}

// num/10^numDecimals ÷ den/10^denDecimals, carried to 12 decimal places in integer
// arithmetic (truncated, never rounded).
function ratio(num: bigint, numDecimals: number, den: bigint, denDecimals: number): string {
  const scaled = num * 10n ** BigInt(denDecimals + LIMIT_PRICE_DP) / (den * 10n ** BigInt(numDecimals))
  const digits = scaled.toString().padStart(LIMIT_PRICE_DP + 1, '0')
  return `${digits.slice(0, -LIMIT_PRICE_DP)}.${digits.slice(-LIMIT_PRICE_DP)}`
}

// Null when either side is zero or unreadable: an order that names no amount on one
// leg states no price, and "0.000000000000" would read as a limit of zero rather
// than as the absence of one.
//
// The decimals are nullable on purpose. A price is only as good as the scaling of
// both legs, and the asset registry answers an unknown id with a 12-decimal
// placeholder — so a caller that cannot vouch for a leg's decimals passes null and
// gets no price, rather than a plausible one off by orders of magnitude.
export function intentLimitPrice(amountIn: string, decimalsIn: number | null, amountOut: string, decimalsOut: number | null): IntentLimitPrice | null {
  if (decimalsIn == null || decimalsOut == null) return null
  if (!/^\d+$/.test(amountIn) || !/^\d+$/.test(amountOut)) return null
  const inRaw = BigInt(amountIn)
  const outRaw = BigInt(amountOut)
  if (inRaw === 0n || outRaw === 0n) return null
  return {
    outPerIn: ratio(outRaw, decimalsOut, inRaw, decimalsIn),
    inPerOut: ratio(inRaw, decimalsIn, outRaw, decimalsOut),
  }
}
