// How the open-ended DCA orders that sell one asset from one wallet share it.
//
// An open-ended order has no budget: it runs until the owner's balance of the sold
// asset can no longer fund a trade. When several such orders sell the same asset
// from the same wallet they draw on ONE balance, so stating that balance as each
// order's "left" counted it once per order (four HUSDC orders read $25.9k each,
// $104k between them, out of $25.9k), and dating each order's end as if it had
// the balance alone pushed every end date out by the others' share of the drain.
//
// The honest projection treats them as one pool: the pool drains at the orders'
// COMBINED rate, so all of them run dry together, at balance ÷ combined rate; and
// each order's share of what is left is the slice of the balance its own rate
// takes, so the shares add up to the balance exactly once. It is still a
// projection — a top-up, a withdrawal or a manual trade moves it — and an order
// whose rate is unknown (a Buy that has not traded yet: what it spends per trade
// moves with the price) makes the whole pool's split unknowable rather than
// guessed. Pure; amounts are raw integers of the sold asset.

const DAY_SECONDS = 86_400n

export interface FundingOrder {
  /** The order's identity (a schedule id or an intent id). */
  key: string
  /** Which balance funds it: the owner and the exact asset it sells. */
  poolKey: string
  /** What one trade spends of the sold asset; null when that is not known. */
  perTrade: bigint | null
  /** Seconds between its trades. */
  periodSeconds: number
}

export interface FundingAllocation {
  /** This order's projected slice of the pool; null when the split is unknowable. */
  share: bigint | null
  /** What this order spends per day, raw; null when unknown. */
  perDay: bigint | null
  /** What the whole pool spends per day, raw; null when any member's rate is unknown. */
  poolPerDay: bigint | null
  /** Seconds until the pool is spent at that rate; null when unknown. */
  runsOutSeconds: number | null
  /** Every order the pool funds (this one included), in input order. */
  members: string[]
}

function perDayOf(o: FundingOrder): bigint | null {
  if (o.perTrade == null || o.perTrade <= 0n || !(o.periodSeconds > 0)) return null
  // Milliseconds keep a sub-second cadence from truncating to zero.
  const periodMs = BigInt(Math.max(1, Math.round(o.periodSeconds * 1000)))
  return o.perTrade * DAY_SECONDS * 1000n / periodMs
}

export function allocateFundingPools(orders: readonly FundingOrder[], balances: ReadonlyMap<string, bigint | null>): Map<string, FundingAllocation> {
  const pools = new Map<string, FundingOrder[]>()
  for (const o of orders) (pools.get(o.poolKey) ?? pools.set(o.poolKey, []).get(o.poolKey)!).push(o)
  const out = new Map<string, FundingAllocation>()
  for (const [poolKey, members] of pools) {
    const balance = balances.get(poolKey) ?? null
    const rates = members.map(perDayOf)
    const known = rates.every((r): r is bigint => r != null)
    const poolPerDay = known ? rates.reduce((a, b) => a + (b ?? 0n), 0n) : null
    const keys = members.map(m => m.key)
    let allotted = 0n
    members.forEach((m, i) => {
      let share: bigint | null = null
      if (balance != null && poolPerDay != null && poolPerDay > 0n) {
        // The last member takes the remainder, so the shares sum to the balance exactly.
        share = i === members.length - 1 ? balance - allotted : balance * rates[i]! / poolPerDay
        allotted += share
      }
      out.set(m.key, {
        share,
        perDay: rates[i],
        poolPerDay,
        runsOutSeconds: balance != null && poolPerDay != null && poolPerDay > 0n
          ? Number(balance * DAY_SECONDS / poolPerDay)
          : null,
        members: keys,
      })
    })
  }
  return out
}
