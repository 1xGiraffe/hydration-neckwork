import type { FinishedOrderStatus, OrderHistoryKind, OrderHistoryRow } from '../../types'

// Presentation rules for the Orders tab's history, kept apart from the component
// so the arithmetic and the URL contract can be tested without rendering.

// The dot colour of a finished order's status. These are the tones the order's
// own detail page paints the same status in (STATUS_TONE in pages/DcaSchedule.tsx
// for schedules, pages/Intent.tsx for intents), so a row and the page it opens
// never disagree: finished as planned reads sky, a failure or a lapse red, a
// deliberate stop quiet.
// Every order state's tone, one definition for the history rows and the DCA
// schedule and intent pages: live is green, finished-as-planned sky, failed or
// lapsed red, withdrawn quiet. Runtime 443 moved live schedules onto ICE
// intents: a migration is the schedule finishing by other means, a failed one
// is a termination.
export const ORDER_STATE_TONE = {
  active: 'var(--green)', open: 'var(--green)',
  'partially-filled': 'var(--sky)', completed: 'var(--sky)', filled: 'var(--sky)', migrated: 'var(--sky)',
  terminated: 'var(--red)', 'migration-cancelled': 'var(--red)', expired: 'var(--red)',
  cancelled: 'var(--text-low)',
} as const satisfies Record<string, string>
export const ORDER_STATUS_TONE: Record<FinishedOrderStatus, string> = ORDER_STATE_TONE

// What a reader calls each kind: a pallet DCA schedule, runtime 443's DCA intent,
// and a swap intent, which the product calls a limit order.
export const ORDER_KIND_LABEL: Record<OrderHistoryRow['kind'], string> = {
  dca: 'DCA', 'dca-intent': 'DCA intent', limit: 'Limit',
}

// The kind filter's URL value (`okind`). Anything unknown is the unfiltered list,
// so a hand-edited link still lands on rows rather than on an empty table.
export const ORDER_KIND_FILTERS: { v: OrderHistoryKind; label: string }[] = [
  { v: 'all', label: 'All' }, { v: 'dca', label: 'DCA' }, { v: 'limit', label: 'Limit' },
]
export function parseOrderKind(value: string | null): OrderHistoryKind {
  return value === 'dca' || value === 'limit' ? value : 'all'
}
// The pager's URL value (`opage`): the 0-based page, absent on the first.
export function parseOrderPage(value: string | null): number {
  if (!value || !/^\d{1,6}$/.test(value)) return 0
  return Number(value)
}

// The average price an order achieved over its whole life: assetOut received per
// assetIn sold, each scaled by its own decimals. Integer arithmetic to `dp`
// decimals — 128-bit amounts exist and Number would round them — returned as an
// exact decimal string; the cell renders it on the rough scale and keeps this
// figure for the title. Nothing sold means there is no price, not a price of zero.
export function orderAvgPrice(soldRaw: string, receivedRaw: string, decIn: number, decOut: number, dp = 18): string | null {
  if (!/^\d+$/.test(soldRaw) || !/^\d+$/.test(receivedRaw)) return null
  const sold = BigInt(soldRaw)
  if (sold === 0n) return null
  const unit = 10n ** BigInt(dp)
  const q = (BigInt(receivedRaw) * 10n ** BigInt(decIn) * unit) / (sold * 10n ** BigInt(decOut))
  const frac = (q % unit).toString().padStart(dp, '0').replace(/0+$/, '')
  return frac ? `${q / unit}.${frac}` : `${q / unit}`
}

// The row's short handle: a schedule's id, an intent's low-64-bit sequence
// (its full u128 id is unreadable at a glance and rides in the link instead).
export function orderHandle(row: Pick<OrderHistoryRow, 'kind' | 'id' | 'seq'>): string {
  return row.kind === 'dca' || row.seq == null ? `#${row.id}` : `#${row.seq}`
}
