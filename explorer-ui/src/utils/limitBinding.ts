// Whether a stated price limit is actually the constraint an order runs under.
//
// A DCA order's limit is a CEILING on what it pays, and pallet_intent enforces the
// tighter of it and an oracle-derived floor built from the order's slippage. So a
// ceiling far ABOVE market can never reject a fill — the slippage band is what
// constrains that order — and one far BELOW market cannot fill at today's price.
// Neither is a defect, but "≤ 5 HOLLAR per HDX" beside a market of 0.0075 reads
// like one, which is the question this answers on the row itself.
//
// The band is deliberately wide. A limit is a deliberate act and orders sit at or
// near market by design; this is meant to catch the order that is off by orders of
// magnitude, not to second-guess one placed 20% out. Inside the band nothing is
// said at all, because on a normal order the limit IS the story.
export const LIMIT_NOT_BINDING_ABOVE = 2
export const LIMIT_BELOW_MARKET_UNDER = 0.5

export type LimitBinding = { kind: 'not-binding' | 'below-market'; label: string; title: string } | null

export function limitBinding(marketRatio: number | null | undefined): LimitBinding {
  if (marketRatio == null || !Number.isFinite(marketRatio) || marketRatio <= 0) return null
  const times = marketRatio >= 10 ? Math.round(marketRatio).toLocaleString('en-US') : marketRatio.toFixed(2)
  if (marketRatio > LIMIT_NOT_BINDING_ABOVE) {
    return {
      kind: 'not-binding',
      label: 'not binding',
      title: `This ceiling is ${times}× the current price, so it cannot reject a fill. What constrains this order is its slippage tolerance against the oracle price, not the limit it states.`,
    }
  }
  if (marketRatio < LIMIT_BELOW_MARKET_UNDER) {
    return {
      kind: 'below-market',
      label: 'below market',
      title: `This ceiling is ${times}× the current price, so the order cannot fill until the price falls to meet it.`,
    }
  }
  return null
}
