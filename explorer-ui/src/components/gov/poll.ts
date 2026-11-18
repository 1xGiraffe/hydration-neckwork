// A discussion's poll as stored, checked field by field: the read-only card
// (PollCard.tsx) shows its results.
//
// The stored shape (forum post `poll`): { title, options[], expiresTime (ms),
// anonymous, votes?: option → count, voters?: option → account ids, `legacy:<name>`
// for an account known only by its name }. Results can be missing (not read yet, or
// never published); the options are shown without counts then.

export interface Poll {
  title: string
  options: string[]
  expiresTime: number | null
  anonymous: boolean
  votes: Record<string, number> | null
  voters: Record<string, string[]> | null
}

/** The poll as stored, or null when it is not a usable poll. Every field is checked: the shape came from elsewhere. */
export function readPoll(raw: unknown): Poll | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const options = Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === 'string' && o.length > 0).slice(0, 32) : []
  if (!options.length) return null
  const counts = (v: unknown): Record<string, number> | null => {
    if (!v || typeof v !== 'object') return null
    const out: Record<string, number> = {}
    for (const o of options) { const n = (v as Record<string, unknown>)[o]; out[o] = typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 }
    return out
  }
  const lists = (v: unknown): Record<string, string[]> | null => {
    if (!v || typeof v !== 'object') return null
    const out: Record<string, string[]> = {}
    for (const o of options) { const l = (v as Record<string, unknown>)[o]; out[o] = Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string' && x.length > 0) : [] }
    return out
  }
  const voters = r.anonymous === true ? null : lists(r.voters)
  // Public polls may carry only their voters: their counts are the list lengths.
  const votes = counts(r.votes) ?? (voters ? Object.fromEntries(options.map(o => [o, voters[o].length])) : null)
  return {
    title: typeof r.title === 'string' ? r.title : '',
    options,
    expiresTime: typeof r.expiresTime === 'number' && Number.isFinite(r.expiresTime) ? r.expiresTime : null,
    anonymous: r.anonymous === true,
    votes,
    voters,
  }
}
