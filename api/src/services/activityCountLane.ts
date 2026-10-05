// A bounded, demand-driven lane for activity totals of directory rows the swept
// leaderboard does not cover (see "The activity ordering" in explorerService.ts).
//
// The sweep counts the ~650 busiest and most-shown rows; every other row a reader
// pages to rendered "—". Those rows are counted here, on demand, through the very
// function the row's own detail page calls, so the number is the page's number —
// never a cheaper proxy. The directory request itself never counts anything (a
// fold total started per page build once made /accounts take 15 s): the table asks
// for the rows it is showing, this lane counts them a few at a time, and the
// answer is whatever finished inside a short wait. The rest is reported pending
// and asked for again.
//
// Cost is bounded three ways: at most `concurrency` counts run at once across all
// callers, at most `queueMax` keys wait (a key past that is simply pending and is
// offered again on the next ask), and a counted key is reused for `freshMs` and
// served — while it recounts behind the reader — up to `maxAgeMs`. One request
// enqueues at most `perRequestMax` new keys, and waiting keys are served
// round-robin across the requests that asked, so no reader's page waits behind
// another's whole backlog. A failed count is remembered for `failMs` only, and
// reported as failed rather than as an uncountable null. Results live
// in memory only, never in account_activity_totals: the directory's activity SORT
// stays exactly the sweep's ranking.

export interface LaneTotal { total: number | null; complete: boolean }
export interface LaneAnswer {
  // key → its total, or null when it cannot be counted (rendered as no number).
  counts: Record<string, LaneTotal | null>
  // Keys still counting or waiting for a slot: ask again.
  pending: string[]
  // Keys whose count FAILED recently (an error, not "uncountable"): not retried
  // until `failMs` has passed, and reported apart from a valid null so the reader
  // can say "count unavailable" rather than showing an empty cell as an answer.
  failed: string[]
}

export interface ActivityCountLaneOptions {
  count: (key: string) => Promise<LaneTotal | null>
  concurrency: number
  queueMax: number
  // New keys one request may enqueue. Keys are then served round-robin across
  // the requests that asked, so one page of uncounted rows cannot hold the head
  // of the queue against every other reader.
  perRequestMax: number
  freshMs: number
  maxAgeMs: number
  // How long a failed count is remembered (and not retried).
  failMs: number
  entriesMax: number
  now?: () => number
  onError?: (key: string, error: unknown) => void
}

interface Entry { value: LaneTotal | null; at: number; failed?: boolean }

export function createActivityCountLane(opts: ActivityCountLaneOptions) {
  const now = opts.now ?? Date.now
  const entries = new Map<string, Entry>()
  // Waiting keys per asking request, served round-robin over `rotation`.
  const queues = new Map<number, string[]>()
  const rotation: number[] = []
  let queued = 0
  let nextOwner = 0
  const waiters = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  let running = 0

  const remember = (key: string, value: LaneTotal | null, failed = false): void => {
    entries.delete(key)
    entries.set(key, { value, at: now(), ...(failed ? { failed } : {}) })
    // Insertion order is recency: the oldest entry is the first one out.
    while (entries.size > opts.entriesMax) entries.delete(entries.keys().next().value as string)
  }

  const takeNext = (): string | undefined => {
    while (rotation.length) {
      const owner = rotation.shift()!
      const q = queues.get(owner)
      if (!q?.length) { queues.delete(owner); continue }
      const key = q.shift()!
      queued--
      if (q.length) rotation.push(owner)
      else queues.delete(owner)
      return key
    }
    return undefined
  }

  const pump = (): void => {
    while (running < opts.concurrency) {
      const key = takeNext()
      if (key == null) return
      running++
      void (async () => {
        try {
          remember(key, await opts.count(key))
        } catch (error) {
          opts.onError?.(key, error)
          // Recorded as FAILED for a short while, so a key that fails is not
          // retried by every poll, and is tried again once `failMs` has passed.
          remember(key, null, true)
        } finally {
          running--
          const waiter = waiters.get(key)
          waiters.delete(key)
          waiter?.resolve()
          pump()
        }
      })()
    }
  }

  return {
    async request(keys: readonly string[], waitMs: number): Promise<LaneAnswer> {
      const unique = [...new Set(keys)]
      const owner = nextOwner++
      let enqueued = 0
      const waitFor: Promise<void>[] = []
      const usable = (hit: Entry | undefined): boolean =>
        hit != null && now() - hit.at <= (hit.failed ? opts.failMs : opts.maxAgeMs)
      for (const key of unique) {
        const hit = entries.get(key)
        const age = hit ? now() - hit.at : Infinity
        if (hit?.failed ? age <= opts.failMs : age <= opts.freshMs) continue
        const held = waiters.get(key)
        if (held) { if (!usable(hit)) waitFor.push(held.promise); continue }
        if (enqueued >= opts.perRequestMax || queued >= opts.queueMax) continue
        let resolve!: () => void
        const promise = new Promise<void>(r => { resolve = r })
        waiters.set(key, { promise, resolve })
        if (!queues.has(owner)) { queues.set(owner, []); rotation.push(owner) }
        queues.get(owner)!.push(key)
        enqueued++
        queued++
        pump()
        // Stale but still within maxAge: served as is while it recounts.
        if (!usable(hit)) waitFor.push(promise)
      }
      if (waitFor.length && waitMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          Promise.all(waitFor),
          new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs) }),
        ])
        if (timer) clearTimeout(timer)
      }
      const counts: Record<string, LaneTotal | null> = {}
      const pending: string[] = []
      const failed: string[] = []
      for (const key of unique) {
        const hit = entries.get(key)
        if (hit?.failed && now() - hit.at <= opts.failMs) failed.push(key)
        else if (hit && !hit.failed && now() - hit.at <= opts.maxAgeMs) counts[key] = hit.value
        else pending.push(key)
      }
      return { counts, pending, failed }
    },
    // For tests and logs.
    stats: () => ({ running, queued, entries: entries.size }),
  }
}
