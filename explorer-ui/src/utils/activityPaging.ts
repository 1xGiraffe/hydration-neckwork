// Paging rules shared by the account and tag activity feeds. Both are served by
// the same API, whose two paging forms have different reach: a forward offset
// walks from the newest row, while a tail walks back from the oldest one.
export const PAGE_SIZE = 25
const MAX_FORWARD_OFFSET = 2_000
// The API's tail builder walks `tail + limit` classified rows out of a bounded
// candidate budget and rejects deeper windows outright, so tail paging reaches
// only this far back from the oldest end. Asking for more is a guaranteed
// failure; those pages are served by a forward offset instead.
const MAX_TAIL_ROWS = 4_500

export function pageCount(rowCount?: number | null): number | undefined {
  return rowCount != null && rowCount > 0 ? Math.ceil(rowCount / PAGE_SIZE) : undefined
}

// The row count the pager sizes itself from is a sum of per-category counts, so it can
// exceed the classified feed it is paging: one live account reported 1,209 activity rows
// while the feed ends at 646, and the pager offered 49 pages when 26 exist. Pages past
// the real end loaded empty and the user had no way to tell which were real.
//
// A page that has SETTLED short (fewer than PAGE_SIZE rows) is proof of the end: the
// current page is the last one when it holds rows, and the previous one was when it is
// empty. Clamp to that and never above the count, so the pager only ever shrinks toward
// the truth and stays stable while a page is still loading.
export function shownPageCount(
  countedPages: number | undefined,
  rowsOnPage: number,
  page: number,
  loading: boolean,
): number | undefined {
  if (loading || rowsOnPage >= PAGE_SIZE) return countedPages
  const lastRealPage = rowsOnPage > 0 ? page + 1 : page
  return countedPages == null ? (lastRealPage > 0 ? lastRealPage : undefined) : Math.min(countedPages, lastRealPage)
}

// Deep pages are cheaper to reach from the oldest end, but only within the API's
// tail budget — beyond it a forward offset is the servable form.
export function activityTailOffset(rowCount: number | null | undefined, offset: number): number | undefined {
  if (rowCount == null || offset + PAGE_SIZE <= MAX_FORWARD_OFFSET) return undefined
  const tail = Math.max(0, rowCount - offset - PAGE_SIZE)
  return tail + PAGE_SIZE <= MAX_TAIL_ROWS ? tail : undefined
}

// The last page holds the remainder of the count, not a full window. Tail 0 is
// the oldest window, so its leading rows are the ones the previous page already
// showed — drop them rather than repeating them, which also lets the pager stop
// on a short page instead of advertising another one. Row counts are category
// sums and may overshoot the classified feed, so this trims to what the page can
// hold at most.
export function trimFinalTailPage<T>(rows: T[], rowCount: number | null | undefined, offset: number, tail: number | undefined): T[] {
  if (tail !== 0 || rowCount == null) return rows
  const remainder = rowCount - offset
  return remainder >= PAGE_SIZE ? rows : rows.slice(Math.max(0, rows.length - remainder))
}
