// ClickHouse `DateTime` literals, 'YYYY-MM-DD HH:MM:SS', always UTC.
//
// Six copies of this one line lived across the tree, and one of them took
// MILLISECONDS while the rest took seconds — indistinguishable at a call site,
// and wrong by a factor of 1000. Hence the unit in the name.

/** From a `Date`. */
export const chDateTime = (date: Date): string => date.toISOString().slice(0, 19).replace('T', ' ')

/** From unix SECONDS. */
export const chTimestamp = (seconds: number): string => chDateTime(new Date(seconds * 1000))

/** From unix MILLISECONDS. */
export const chTimestampMs = (ms: number): string => chDateTime(new Date(ms))
