import type { RawBalanceObservationRow } from './types.js'

// Diff-only reconcile of the full-state balance sweep (src/scripts/snapshot-balances.ts).
//
// The raw indexer observes a balance at every block an event, call or account-state
// trigger names it, so the per-block projection (account_asset_latest_balances:
// argMax(…, block_height) over raw_balance_observations) already holds every
// changed balance. The sweep reads System.Account and Tokens.Accounts at one pinned
// block B and writes a row ONLY where storage disagrees with that projection as of B:
//   - changed:  the projection's (total, free, reserved) at B differs from storage;
//   - missing:  storage holds a pair the projection never observed (a dormant account
//               whose last move predates raw coverage — on a fresh database this is
//               every dormant pair, which is the seed);
//   - absent:   the projection shows a non-zero balance for a pair storage no longer
//               holds at B (a reap or a removed token entry no event row restated).
// A pair the projection observed ABOVE B is skipped (superseded): its newest row is
// a fresher storage read than B's, and a row at B would sit under it anyway.
//
// Any diff is a missed per-block observation and is logged as a warning.

export const NATIVE_ASSET_ID = '0'

export interface ProjectedBalance {
  /** `${total}|${free}|${reserved}` of the newest observation ('' for NULL). */
  sig: string
  lastBlock: number
}

export type BalanceDiffKind = 'changed' | 'missing' | 'absent'

export interface BalanceDiffExample {
  kind: BalanceDiffKind
  account_id: string
  asset_id: string
  projected: string | null
  storage: string
  projected_block: number | null
}

export interface BalanceReconcileStats {
  anchor_block: number
  compared: number
  unchanged: number
  superseded: number
  changed: number
  missing: number
  absent: number
}

export const ZERO_SIGNATURE = '0|0|0'

export function balanceSignature(total: string | null, free: string | null, reserved: string | null): string {
  return `${total ?? ''}|${free ?? ''}|${reserved ?? ''}`
}

export function pairKey(accountId: string, assetId: string): string {
  return `${accountId}|${assetId}`
}

export class BalanceReconciler {
  private readonly seen = new Set<string>()
  readonly stats: BalanceReconcileStats
  readonly examples: BalanceDiffExample[] = []

  constructor(
    private readonly projection: ReadonlyMap<string, ProjectedBalance>,
    readonly anchorBlock: number,
    private readonly maxExamples = 20,
  ) {
    this.stats = { anchor_block: anchorBlock, compared: 0, unchanged: 0, superseded: 0, changed: 0, missing: 0, absent: 0 }
  }

  /** The storage rows read at B that disagree with the projection as of B. */
  filter(rows: readonly RawBalanceObservationRow[]): RawBalanceObservationRow[] {
    const out: RawBalanceObservationRow[] = []
    for (const row of rows) {
      const key = pairKey(row.account_id, row.asset_id)
      this.seen.add(key)
      this.stats.compared++
      const projected = this.projection.get(key)
      if (projected != null && projected.lastBlock > this.anchorBlock) {
        this.stats.superseded++
        continue
      }
      const sig = balanceSignature(row.total, row.free, row.reserved)
      if (projected != null && projected.sig === sig) {
        this.stats.unchanged++
        continue
      }
      const kind: BalanceDiffKind = projected == null ? 'missing' : 'changed'
      this.stats[kind]++
      this.example(kind, row.account_id, row.asset_id, projected, sig)
      out.push(row)
    }
    return out
  }

  /**
   * Pairs the projection shows non-zero as of B that storage did not enumerate.
   * Call after every page was filtered; `scope` limits it to the storage maps
   * that were actually read (native = System.Account, tokens = Tokens.Accounts).
   */
  absentPairs(scope: { native: boolean; tokens: boolean }): Array<{ accountId: string; assetId: string }> {
    const out: Array<{ accountId: string; assetId: string }> = []
    for (const [key, projected] of this.projection) {
      if (this.seen.has(key) || projected.lastBlock > this.anchorBlock || projected.sig === ZERO_SIGNATURE) continue
      const split = key.lastIndexOf('|')
      const accountId = key.slice(0, split)
      const assetId = key.slice(split + 1)
      const native = assetId === NATIVE_ASSET_ID
      if (native ? !scope.native : !scope.tokens) continue
      this.stats.absent++
      this.example('absent', accountId, assetId, projected, ZERO_SIGNATURE)
      out.push({ accountId, assetId })
    }
    return out
  }

  diffCount(): number {
    return this.stats.changed + this.stats.missing + this.stats.absent
  }

  private example(kind: BalanceDiffKind, accountId: string, assetId: string, projected: ProjectedBalance | undefined, storage: string): void {
    if (this.examples.length >= this.maxExamples) return
    this.examples.push({
      kind,
      account_id: accountId,
      asset_id: assetId,
      projected: projected?.sig ?? null,
      storage,
      projected_block: projected?.lastBlock ?? null,
    })
  }
}

export type BalanceSweepMode = 'seed' | 'reconcile'

/**
 * A database no full seed was ever written to gets the full write (every entry,
 * labelled snapshot_bootstrap): that is what makes dormant accounts exist at all,
 * and what the money-market sweep waits for. Every later pass is diff-only.
 */
export function balanceSweepMode(options: { reconcile: boolean; seeded: boolean }): BalanceSweepMode {
  return options.reconcile && options.seeded ? 'reconcile' : 'seed'
}
