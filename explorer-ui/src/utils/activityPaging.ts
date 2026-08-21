import type { ListCountQuery } from '../api/explorer'

// Paging rules shared by the account and tag detail lists. Each list publishes an
// exact row total for the filters it is showing, so its pages are real numbers
// over the full ordering — "Page 3 of 26" — and the last page is one jump away.
export const PAGE_SIZE = 25

// The last page holds the remainder of the total. undefined when the list has no
// total (a feed too deep to walk to its end): Pager then numbers pages only up to
// the current one and leans on the next arrow, so no page is ever offered before
// it is known to hold rows.
export function pageCount(rowCount?: number | null, pageSize = PAGE_SIZE): number | undefined {
  return rowCount != null && rowCount > 0 ? Math.ceil(rowCount / pageSize) : undefined
}

// How many pages the API will actually serve, from the deepest offset it accepts.
// A chain-wide list is bounded by cost as well as by length — the merged Activity
// feed assembles one candidate window per source per page, and the 302.9M-row
// events feed reads every row it skips — so the depth at which a page stops being
// servable is a real bound, published by the API rather than guessed here.
export function servablePageCount(maxOffset?: number, pageSize = PAGE_SIZE): number | undefined {
  return maxOffset == null ? undefined : Math.floor(maxOffset / pageSize) + 1
}

// The › arrow. A known total owns it — offering the page after the last one is
// what made pages 26-48 of a 26-page feed load empty, including when the last
// page happens to be exactly full. Only without a total does a full page stand in
// for "there may be more", and then only up to `maxPages`: past the servable depth
// the request itself fails, so the walk has to stop there too.
export function hasNextPage(totalPages: number | undefined, page: number, rowsOnPage: number, maxPages?: number, pageSize = PAGE_SIZE): boolean {
  if (maxPages != null && page + 1 >= maxPages) return false
  return totalPages != null ? page + 1 < totalPages : rowsOnPage === pageSize
}

export interface OfferedPages { totalPages: number | undefined; hasNext: boolean; note: string | undefined }

// One rule for every list bounded both by its length and by how deep its API
// serves it: number the pages that exist AND can be fetched, stop the › arrow at
// the last of those, and say what lies past it. A list whose length is unknown gets
// no page numbers at all — numbering the servable depth would claim pages a
// filtered feed may not hold — so its arrow walks one full page at a time.
export function offeredPages(args: {
  page: number
  rowsOnPage: number
  rowCount?: number | null
  maxOffset?: number
  pageSize?: number
}): OfferedPages {
  const pageSize = args.pageSize ?? PAGE_SIZE
  const counted = pageCount(args.rowCount, pageSize)
  const servable = servablePageCount(args.maxOffset, pageSize)
  const totalPages = counted != null && servable != null ? Math.min(counted, servable) : counted
  const beyondDepth = counted != null && servable != null && servable < counted
  return {
    totalPages,
    hasNext: hasNextPage(totalPages, args.page, args.rowsOnPage, servable, pageSize),
    note: beyondDepth
      ? 'older history beyond the pages this list can serve'
      : totalPages == null && servable != null && args.page + 1 >= servable
        ? 'as deep as this list pages — narrow the date range for older rows'
        : undefined,
  }
}

// Each list asks for its total under ITS OWN filters — a total that ignored a
// filter would size the pager for a longer list than the one on screen, which is
// exactly how the pager used to advertise 49 pages of a 26-page feed. Splitting the
// builders per tab also keeps one tab's filters out of another tab's cache key, so
// switching tabs does not re-count.
export interface ActivityFilterValues { token?: string; min?: string; minRevenue?: string; from?: string; to?: string; identity?: string }
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
    // The pager's total must move with every filter the list shows, or a
    // filtered list offers pages that hold nothing.
    minRevenue: set(values.minRevenue),
    identity: set(values.identity),
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
