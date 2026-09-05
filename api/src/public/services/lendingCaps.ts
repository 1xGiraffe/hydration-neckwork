import type { ClickHouseClient } from '../../db/client.ts'
import { cachedSwr } from '../../services/cache.ts'
import {
  readCapEvents, readFacilitatorCaps, reserveCaps, reserveKey, tokenAmount, utilizationRatio, type ReserveCaps,
} from '../../services/moneyMarketCaps.ts'
import { type MmReserveState, moneyMarketSupply } from './moneyMarketReserves.ts'

// GET /lending/v1/caps — per-reserve supply/borrow caps, current supply/borrow and
// utilization for every money-market reserve (spec § Phase 2 → "hydration.net
// stats + lending caps").
//
// The caps themselves — configurator events decoded from `raw_evm_logs`, HOLLAR
// facilitator buckets attributed to a market through its aToken, and their
// composition per reserve — live in services/moneyMarketCaps.ts, which the
// explorer's cap alert reads too, so the two can never disagree. This module owns
// only the wire shape: the incumbent endpoint's field names and JSON numbers
// (whole tokens, because its consumers parse numbers), the legacy first row, and
// the USD-valued, delisting-aware reserve list moneyMarketSupply provides.
//
// Verified against the incumbent at rollout: the core HOLLAR facilitator capacity
// (12,000,000) is exactly the `borrowCap` it served, and the current borrow
// (10,735,924.996 HOLLAR from the indexed reserve state) matched its RPC read of
// the variable-debt token's `totalSupply` seconds later, drifting only by the
// interest accrued between the two reads.

export interface LendingCap {
  /** The reserve asset's registry name — the incumbent's field, e.g. "Hydrated Dollar". */
  asset: string
  /** Maximum borrowable, in whole tokens. Null when no cap has ever been set for the reserve. */
  borrowCap: number | null
  /** Currently borrowed, in whole tokens. */
  currentBorrow: number
  /** `borrowCap - currentBorrow`, or null when there is no cap to be available against. */
  available: number | null
  /** Which model set `borrowCap`: the market's HOLLAR facilitator, or the pool configurator. */
  borrowCapSource: 'facilitator' | 'poolConfigurator' | null
  /** The isolated market this reserve belongs to ('core', 'gigahdx', 'bil'). */
  market: string | null
  /** Registry id as a decimal string, or null for a reserve outside the registry. */
  assetId: string | null
  symbol: string | null
  /** Maximum suppliable, in whole tokens. Null when no cap has ever been set. */
  supplyCap: number | null
  /** Currently supplied, in whole tokens. */
  currentSupply: number
  /** `currentBorrow / currentSupply`, 0–1. Null when nothing is supplied. */
  utilization: number | null
  /** The indexed block whose state this row reports. */
  asOf: string
}

/**
 * The reserve rows, legacy row first.
 *
 * The incumbent endpoint returned exactly ONE element — the core market's HOLLAR
 * borrow cap — so a consumer reading `body[0].borrowCap` must keep reading the same
 * number here. That row is therefore pinned to index 0; everything else follows in
 * a stable (market, symbol) order so the payload is diffable.
 */
export function orderCaps(rows: LendingCap[]): LendingCap[] {
  const isLegacy = (row: LendingCap): boolean => row.market === 'core' && row.borrowCapSource === 'facilitator'
  const legacy = rows.filter(isLegacy)
  const rest = rows.filter(row => !isLegacy(row))
  rest.sort((a, b) => (a.market ?? '').localeCompare(b.market ?? '') || (a.symbol ?? '').localeCompare(b.symbol ?? ''))
  return [...legacy, ...rest]
}

// Both caps reach the wire as whole tokens; the shared model holds them in raw
// units, so an Aave cap round-trips to exactly the whole number it was set as.
function capRow(reserve: MmReserveState, caps: ReserveCaps | undefined): LendingCap {
  const borrowCap = caps?.borrowCap == null ? null : tokenAmount(caps.borrowCap, reserve.decimals)
  const currentBorrow = tokenAmount(reserve.debt, reserve.decimals)
  return {
    asset: reserve.name ?? reserve.symbol ?? reserve.reserveAddress,
    borrowCap,
    currentBorrow,
    available: borrowCap == null ? null : borrowCap - currentBorrow,
    borrowCapSource: caps?.borrowCapSource ?? null,
    market: reserve.market,
    assetId: reserve.assetId == null ? null : String(reserve.assetId),
    symbol: reserve.symbol,
    supplyCap: caps?.supplyCap == null ? null : tokenAmount(caps.supplyCap, reserve.decimals),
    currentSupply: tokenAmount(reserve.supplied, reserve.decimals),
    utilization: utilizationRatio(reserve.supplied, reserve.debt),
    asOf: reserve.asOf,
  }
}

export async function lendingCaps(client: ClickHouseClient): Promise<LendingCap[]> {
  return cachedSwr('pub:lending:caps', 60_000, 300_000, async () => {
    const [supply, capEvents, facilitatorRows] = await Promise.all([
      moneyMarketSupply(client), readCapEvents(client), readFacilitatorCaps(client),
    ])
    const caps = reserveCaps(supply.reserves, capEvents, facilitatorRows)
    return orderCaps(supply.reserves.map(reserve => capRow(reserve, caps.get(reserveKey(reserve.poolAddress, reserve.reserveAddress)))))
  })
}
