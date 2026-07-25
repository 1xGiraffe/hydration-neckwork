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


// Paging from the OLDEST end, counted in pages back from the last one: tailPage 0 is
// the last page, 1 the one before it, and so on. This exists because the activity row
// count overshoots the classified feed (one account reports 2,082 rows where the feed
// ends at 1,650, so a count-derived "last page" lands 18 pages past the end), while the
// API's tail mode walks back from the true oldest row and needs no count to be right.
export const MAX_TAIL_PAGE = Math.floor(MAX_TAIL_ROWS / PAGE_SIZE) - 1

export function tailPageParam(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.min(parsed, MAX_TAIL_PAGE)
}

export function tailOffsetForPage(tailPage: number): number {
  return Math.max(0, tailPage) * PAGE_SIZE
}

export function pageCount(rowCount?: number | null): number | undefined {
  return rowCount != null && rowCount > 0 ? Math.ceil(rowCount / PAGE_SIZE) : undefined
}

// The activity count the pager used to size itself from is a SUM OF OVERLAPPING
// per-category counts, so it is an upper bound on the feed, not its length. For one live
// account it reported 1,209 where the classified feed holds 646: trades 588 + dca 584 were
// both counted for the same 613 trade rows (a DCA execution IS a swap), plus xcm 3 for 1,
// transfers 20 for 19, staking 5 for 4. At 25 a page that advertised 49 pages when 26
// exist, and pages 26-48 all loaded empty.
//
// So this never converts the count into a total. It reports a page count only when the
// feed itself has PROVEN one — a settled page holding fewer than PAGE_SIZE rows is the
// last page, and nothing else proves anything:
//   - a full page: there may be more, which is what the next arrow is for
//   - an empty page past the start: the end is somewhere EARLIER, but we do not know
//     where, so claiming `page` pages would still advertise pages that do not exist
//     (landing directly on ?apage=48 used to render "Page 49 of 48")
// An unknown total makes Pager number pages only up to the current one, which is exactly
// its documented no-count behaviour, so no page is ever offered before it is known to hold
// rows.
export function provenPageCount(
  rowsOnPage: number,
  page: number,
  loading: boolean,
): number | undefined {
  if (loading || rowsOnPage === 0 || rowsOnPage >= PAGE_SIZE) return undefined
  return page + 1
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
