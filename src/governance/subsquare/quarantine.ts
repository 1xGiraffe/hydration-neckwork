// Items Subsquare keeps failing to serve, set aside so they stop costing every cycle.
//
// An isolated request that fails all its attempts skips only its own item for that
// cycle (client.ts, ItemRequestError). An item that fails in QUARANTINE_AFTER
// consecutive cycles is then not asked for again for QUARANTINE_MS, and comes back on
// its own after that; one success clears its record. In memory only: a restart gives
// every item a fresh chance.

export const QUARANTINE_AFTER = 3
export const QUARANTINE_MS = 6 * 3600_000

interface Entry { fails: number; until: number }

export class Quarantine {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly after = QUARANTINE_AFTER, private readonly ms = QUARANTINE_MS) {}

  /** Whether `key` is set aside at `now`. */
  held(key: string, now: number): boolean {
    const e = this.entries.get(key)
    return !!e && e.until > now
  }

  /** Records a failed cycle for `key`; true when this failure sets it aside. */
  failed(key: string, now: number): boolean {
    const fails = (this.entries.get(key)?.fails ?? 0) + 1
    const until = fails >= this.after ? now + this.ms : 0
    this.entries.set(key, { fails, until })
    return until > 0
  }

  /** A success: the item is in good standing again. */
  ok(key: string): void { this.entries.delete(key) }

  /** Items currently set aside (for the cycle log). */
  size(now: number): number {
    let n = 0
    for (const e of this.entries.values()) if (e.until > now) n++
    return n
  }
}
