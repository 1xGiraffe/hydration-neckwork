// Forum write rate limits: sliding windows per account (and a coarse one per client
// IP), kept in memory. The api is the forum's only interactive writer and runs as one
// process, so one in-process ledger is the whole truth; the windows that must survive
// a restart (posts and comments per day, uploads per day) are SEEDED from the stored
// rows the first time an account writes after a boot, so a restart never resets a
// daily cap. IP addresses live only here, in memory, and are never persisted or logged.

export interface Window { max: number; ms: number; label: string }

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000

/** The spec's limits, per action. `label` is how the refusal names the window. */
export const FORUM_LIMITS = {
  discussion: [{ max: 3, ms: HOUR, label: 'hour' }, { max: 10, ms: DAY, label: 'day' }],
  comment: [{ max: 10, ms: MINUTE, label: 'minute' }, { max: 100, ms: DAY, label: 'day' }],
  edit: [{ max: 30, ms: HOUR, label: 'hour' }],
  upload: [{ max: 20, ms: HOUR, label: 'hour' }, { max: 50, ms: DAY, label: 'day' }],
  report: [{ max: 5, ms: HOUR, label: 'hour' }, { max: 20, ms: DAY, label: 'day' }],
  /** Every write from one client address, whichever account it signs in as. */
  ip: [{ max: 60, ms: MINUTE, label: 'minute' }, { max: 600, ms: HOUR, label: 'hour' }],
  /** Uploads across every account: the IPFS node and its disk are shared. */
  uploadGlobal: [{ max: 300, ms: HOUR, label: 'hour' }],
} as const satisfies Record<string, readonly Window[]>

export type LimitAction = keyof typeof FORUM_LIMITS

export interface LimitRefusal { action: LimitAction; window: Window; retryAfterSec: number }

export class SlidingLimiter {
  private readonly log = new Map<string, number[]>()
  private readonly seeded = new Set<string>()

  constructor(private readonly now: () => number = Date.now) {}

  private key(action: LimitAction, who: string): string { return `${action}\u0000${who}` }

  /** Whether `who` has been seeded for `action` since boot. */
  isSeeded(action: LimitAction, who: string): boolean { return this.seeded.has(this.key(action, who)) }

  /** Adds stored events (their timestamps) before the first check after a boot. Idempotent per key. */
  seed(action: LimitAction, who: string, times: readonly number[]): void {
    const k = this.key(action, who)
    if (this.seeded.has(k)) return
    this.seeded.add(k)
    const horizon = this.now() - Math.max(...FORUM_LIMITS[action].map(w => w.ms))
    const list = [...(this.log.get(k) ?? []), ...times.filter(t => t > horizon)].sort((a, b) => a - b)
    this.log.set(k, list)
  }

  /** The first window `who` would exceed by one more event, or null when it may proceed. Records nothing. */
  check(action: LimitAction, who: string, cost = 1): LimitRefusal | null {
    const now = this.now()
    const list = this.trim(action, who, now)
    for (const w of FORUM_LIMITS[action]) {
      const inWindow = list.filter(t => t > now - w.ms)
      if (inWindow.length + cost > w.max) {
        const oldest = inWindow[inWindow.length + cost - w.max - 1] ?? now
        return { action, window: w, retryAfterSec: Math.max(1, Math.ceil((oldest + w.ms - now) / 1000)) }
      }
    }
    return null
  }

  /** Records one event and returns its timestamp (the handle `release` takes back). */
  record(action: LimitAction, who: string): number {
    const k = this.key(action, who)
    const list = this.log.get(k) ?? []
    const at = this.now()
    list.push(at)
    this.log.set(k, list)
    return at
  }

  /**
   * Checks and records in one synchronous step — no await between them, so two
   * concurrent requests can never both pass the last free slot. Returns the slot's
   * handle, or the refusal.
   */
  reserve(action: LimitAction, who: string): { at: number } | LimitRefusal {
    const refused = this.check(action, who)
    return refused ?? { at: this.record(action, who) }
  }

  /** Gives back a slot `reserve`/`record` took (the action failed before it did anything). */
  release(action: LimitAction, who: string, at: number): void {
    const list = this.log.get(this.key(action, who))
    const i = list?.lastIndexOf(at) ?? -1
    if (list && i >= 0) list.splice(i, 1)
  }

  private trim(action: LimitAction, who: string, now: number): number[] {
    const k = this.key(action, who)
    const horizon = now - Math.max(...FORUM_LIMITS[action].map(w => w.ms))
    const list = (this.log.get(k) ?? []).filter(t => t > horizon)
    if (list.length) this.log.set(k, list); else this.log.delete(k)
    return list
  }

  /** Forgets everything (tests). */
  clear(): void { this.log.clear(); this.seeded.clear() }

  /** Drops every key with nothing left in its longest window (bounded memory). */
  sweep(): void {
    const now = this.now()
    for (const k of [...this.log.keys()]) {
      const action = k.split('\u0000')[0] as LimitAction
      this.trim(action, k.slice(action.length + 1), now)
    }
  }
}

/** Plain words for a refusal: "You can post 3 discussions an hour — try again in 12 minutes." */
export function limitMessage(r: LimitRefusal): string {
  const what: Record<LimitAction, string> = {
    discussion: 'discussions', comment: 'comments', edit: 'edits', upload: 'images',
    report: 'reports', ip: 'changes from this connection', uploadGlobal: 'images (all accounts together)',
  }
  const wait = r.retryAfterSec < 90 ? `${r.retryAfterSec} seconds` : r.retryAfterSec < 5400 ? `${Math.ceil(r.retryAfterSec / 60)} minutes` : `${Math.ceil(r.retryAfterSec / 3600)} hours`
  const scope = r.action === 'uploadGlobal' ? 'The forum accepts' : r.action === 'ip' ? 'You can make' : 'You can add'
  return `${scope} at most ${r.window.max} ${what[r.action]} per ${r.window.label} — try again in ${wait}.`
}
