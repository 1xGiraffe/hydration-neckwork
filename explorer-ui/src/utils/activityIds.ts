// Activity/detail ids as they appear in URLs: `<height>-<extrinsicIndex>` and
// the event form `<height>-e<eventIndex>`. Parsing lives here, in a leaf module,
// so the pages that only need the block out of an id do not pull the activity
// table along (and there is one parser, not two).

export interface ActivityRef { height: number; eventIndex: number | null; extrinsicIndex: number | null }

export function parseId(id: string): ActivityRef | null {
  const m = /^(\d+)-(e)?(\d+)$/.exec(id)
  if (!m) return null
  return { height: Number(m[1]), eventIndex: m[2] ? Number(m[3]) : null, extrinsicIndex: m[2] ? null : Number(m[3]) }
}

/** The block an id names, for pages that address one thing inside it. */
export function blockOf(id: string | null | undefined): number | null {
  return id ? parseId(id)?.height ?? null : null
}
