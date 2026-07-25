import type { ListCountQuery } from '../api/explorer'

// Paging rules shared by the account and tag detail lists. Each list publishes an
// exact row total for the filters it is showing, so its pages are real numbers
// over the full ordering — "Page 3 of 26" — and the last page is one jump away.
export const PAGE_SIZE = 25

// The last page holds the remainder of the total. undefined when the list has no
// total (a feed too deep to walk to its end): Pager then numbers pages only up to
// the current one and leans on the next arrow, so no page is ever offered before
// it is known to hold rows.
export function pageCount(rowCount?: number | null): number | undefined {
  return rowCount != null && rowCount > 0 ? Math.ceil(rowCount / PAGE_SIZE) : undefined
}

// The › arrow. A known total owns it — offering the page after the last one is
// what made pages 26-48 of a 26-page feed load empty, including when the last
// page happens to be exactly full. Only without a total does a full page stand in
// for "there may be more".
export function hasNextPage(totalPages: number | undefined, page: number, rowsOnPage: number): boolean {
  return totalPages != null ? page + 1 < totalPages : rowsOnPage === PAGE_SIZE
}

// Each list asks for its total under ITS OWN filters — a total that ignored a
// filter would size the pager for a longer list than the one on screen, which is
// exactly how the pager used to advertise 49 pages of a 26-page feed. Splitting the
// builders per tab also keeps one tab's filters out of another tab's cache key, so
// switching tabs does not re-count.
export interface ActivityFilterValues { token?: string; min?: string; from?: string; to?: string }
export interface ExtrinsicFilterValues { call?: string; result?: string; origin?: string; from?: string; to?: string }
export interface EventFilterValues { event?: string; from?: string; to?: string }

const set = (value?: string): string | undefined => (value ? value : undefined)

export function activityListCount(type: string, action: string, values: ActivityFilterValues): ListCountQuery {
  return {
    tab: 'activity',
    type,
    action: set(action),
    token: set(values.token),
    min: set(values.min),
    from: set(values.from),
    to: set(values.to),
  }
}

export function extrinsicListCount(values: ExtrinsicFilterValues): ListCountQuery {
  return {
    tab: 'extrinsics',
    call: set(values.call),
    result: set(values.result),
    origin: set(values.origin),
    from: set(values.from),
    to: set(values.to),
  }
}

export function eventListCount(values: EventFilterValues): ListCountQuery {
  return { tab: 'events', event: set(values.event), from: set(values.from), to: set(values.to) }
}

// The Votes list exposes no filters, so its total is the account's whole vote history.
export function voteListCount(): ListCountQuery {
  return { tab: 'votes' }
}
