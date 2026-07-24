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

// Deep pages are cheaper to reach from the oldest end, but only within the API's
// tail budget — beyond it a forward offset is the servable form.
export function activityTailOffset(rowCount: number | null | undefined, offset: number): number | undefined {
  if (rowCount == null || offset + PAGE_SIZE <= MAX_FORWARD_OFFSET) return undefined
  const tail = Math.max(0, rowCount - offset - PAGE_SIZE)
  return tail + PAGE_SIZE <= MAX_TAIL_ROWS ? tail : undefined
}
