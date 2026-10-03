// Single-flight for a value composed per head (the explorer's price generation):
// concurrent callers share one computation, but only one for the head they asked
// about or a newer one. Joining a computation started for an OLDER head would hand
// a caller who has already seen head N a result composed at N − 1 — and a poller
// would push that older generation as the current one.

export interface HeadComposed { head: number }

export function headSingleFlight<T extends HeadComposed>(compose: (head: number) => Promise<T>) {
  let inflight: { head: number; promise: Promise<T> } | null = null
  const start = (head: number) => {
    const run = { head, promise: compose(head) }
    run.promise.finally(() => { if (inflight === run) inflight = null }).catch(() => {})
    inflight = run
    return run
  }
  /** The value composed at `head` or later (the newest one after a bounded retry); rejects when its composition fails. */
  return async function at(head: number): Promise<T> {
    let last: T | undefined
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = inflight
      if (current && current.head < head) {
        // An older head's run: let it finish, then look again (it may have been
        // superseded by a run for this head meanwhile).
        await current.promise.catch(() => {})
        continue
      }
      const next = await (current ?? start(head)).promise
      if (next.head >= head) return next
      // Composed below the head asked (it saw an older state): compose again.
      last = next
      if (inflight === null || inflight.head < head) start(head)
    }
    return last ?? (await (inflight ?? start(head)).promise)
  }
}
