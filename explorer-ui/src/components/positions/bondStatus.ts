import type { BondStatus } from '../../types'

// A bond's lifecycle as the bond pages and the Strategies tab both word it (the API's
// bonds.ts bondStatus): on sale, sold and earning toward maturity, matured and
// redeemable, fully redeemed.
export const BOND_STATUS_LABEL: Record<BondStatus, string> = {
  selling: 'On sale', active: 'Active', matured: 'Matured · redeemable', redeemed: 'Fully redeemed',
}
export const BOND_STATUS_TONE: Record<BondStatus, string> = {
  selling: 'pending', active: 'finalized', matured: 'ok', redeemed: '',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** A calendar day in UTC: "24 Nov 2026". */
export function bondDate(iso: string): string {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : '—'
}
/** A percentage to two decimals, or a dash. */
export const bondPct = (v: number | null | undefined, digits = 2): string => v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}%`
