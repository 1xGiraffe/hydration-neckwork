import { refreshHdxSnapshot } from './hdxService.ts'
import { refreshProxyMultisig } from './proxyMultisigService.ts'
import { refreshErc20Wallets } from './erc20WalletService.ts'
import { refreshContractCode } from './contractRegistryService.ts'
import { refreshSecurityChainState } from './securityService.ts'
import { refreshWormholeBacking } from './wormholeNttService.ts'

// Coordinated scheduler for the background refreshers that read node-full
// (chain-state enumeration and EVM eth_call). Previously each ran on its own
// independent setInterval (15 / 10 / 10 min), so their phases could align and
// stack concurrent RPC bursts on the one archive node. Here they share a single
// timer and run SEQUENTIALLY, so node-full only ever sees one refresh lane, and
// the cadence is fast enough that a just-changed balance (an unstake, a claimed
// vesting tranche, a vote lock removed) shows within a minute.
//
// Measured per-cycle cost against node-full (same-host RPC):
//   hdx-locks      ~2.2s enumeration + ~0.8s ClickHouse write   → every tick (60s)
//   proxy-multisig ~15ms enumeration + ~30ms reconstruction     → every tick (60s)
//   erc20-wallets  ~1s eth_call (HOLLAR holders, 80/batch)       → every 3rd tick (180s)
//   security-state ~90ms (≈140 storage reads, 2 batches)         → every tick (60s)
//   wormhole-backing ~2.7s node-full (≈23 throttled eth_call, one batched
//                    array of 4 fuse reads per manager, 1 pinned storage
//                    batch) + 3 ClickHouse reads                   → every tick (60s)
// Worst case (every fifteenth minute all of them run back to back) ≈ 7s of
// node-full time per 60s window — a low single-digit duty cycle, comfortably
// below the one backfill worker the node sustains before live ingestion lags.
// The Wormhole cycle also reaches OFF-chain endpoints (origin RPCs,
// Wormholescan); those are bounded by their own timeouts and never block a
// request path, since every response is served from the snapshot it leaves.
// Its origin pass also probes the managers' inbound rate-limiter queues: one
// batched eth_call array per EVM origin over the digests still unresolved, and
// one inbox enumeration per Solana manager. A released queue entry is cached
// settled for the life of the process, so only a cold boot pays for the whole
// lookback window — steady state is a handful of calls. The same batches carry
// each manager's two rate-limiter legs and, for the outbound digests still
// unresolved, its own `isMessageExecuted` answer — so custody and redemption
// are read together rather than from two sources that can disagree.
//
// Every Hydration-side read in the cycle is pinned to the INDEXED head, not the
// chain's: issuance at that block's hash and the log window bounded by it, so
// the supply side and the redemption side describe one block.
//
// The Wormhole cycle runs at the BASE cadence because a backing shortfall is the
// one thing on this scheduler somebody has to act on inside minutes rather than
// inside an hour. Off-chain call volume doubles with it: ~43,200 cycles a month,
// and each origin endpoint (plus Wormholescan) takes one or two batched requests
// per cycle — under ~86k a month apiece, well inside every public tier involved.
// node-full sees one more ~2.7s lane per 60s window, which the duty-cycle figure
// above already accounts for. A first-sight shortfall additionally costs ONE
// narrow confirmation pass ~15s later, scoped to the flagged assets alone (see
// wormholeNttService); it is rare by construction, since a clean bridge never
// schedules one.
//
// ClickHouse-only refreshers (money-market / Omnipool value snapshots, the
// account-directory prewarm, tag syncs, asset/identity caches) are intentionally
// NOT routed through here: they never touch node-full, are already well spaced,
// and share no scarce resource — coordinating them would add coupling with no
// contention to resolve.

export interface RefreshTask {
  name: string
  // Run every Nth base tick: 1 = every 60s, 3 = every 180s.
  everyTicks: number
  run: () => Promise<void>
}

const BASE_TICK_MS = 60_000

const TASKS: RefreshTask[] = [
  { name: 'hdx-locks', everyTicks: 1, run: refreshHdxSnapshot },
  { name: 'proxy-multisig', everyTicks: 1, run: refreshProxyMultisig },
  { name: 'erc20-wallets', everyTicks: 3, run: refreshErc20Wallets },
  // EVM.AccountCodes enumeration (~1k keys); contracts appear rarely, so a
  // slow cadence keeps the archive-node duty cycle where it was.
  { name: 'contract-code', everyTicks: 15, run: refreshContractCode },
  // Circuit-breaker state: a handful of small map enumerations plus the total
  // issuance of the ~60 rate-limited assets (~140 reads, 2 batches). The deposit
  // fuses move with every mint, so this wants the base cadence.
  { name: 'security-state', everyTicks: 1, run: refreshSecurityChainState },
  // Wormhole NTT backing: manager facts + per-asset issuance from node-full,
  // origin-chain custody and Wormholescan off-chain. A shortfall in the bridge's
  // backing is the one finding here that is worth minutes rather than an hour, so
  // it takes the base cadence.
  { name: 'wormhole-backing', everyTicks: 1, run: refreshWormholeBacking },
]

// Tasks due on a given 1-based tick number (exported for testing the cadence).
export function dueTasks(tickNumber: number, tasks: RefreshTask[] = TASKS): RefreshTask[] {
  return tasks.filter(t => tickNumber % t.everyTicks === 0)
}

let timer: ReturnType<typeof setInterval> | null = null
let tickInFlight = false
let tick = 0

// Run the given tasks one after another (never concurrently), each isolated so
// one failure or slow RPC cannot abort the batch, holding `tickInFlight` for the
// whole batch so no other batch (including a tick overlapping the cold initial
// pass) can start alongside it. Per-service single-flight guards make each run
// idempotent even so.
function runGuardedBatch(tasks: RefreshTask[]): Promise<void> {
  tickInFlight = true
  return (async () => {
    for (const task of tasks) {
      try {
        await task.run()
      } catch (err) {
        console.error(`[refresh] ${task.name} failed`, err)
      }
    }
  })().finally(() => { tickInFlight = false })
}

export function startBackgroundRefresh(): void {
  if (timer) return
  // Initial pass: every task once at startup, sequentially, off the boot path.
  void runGuardedBatch(TASKS)
  timer = setInterval(() => {
    // Skip this tick entirely if a batch is still running (a stalled RPC must
    // not let ticks pile up); the counter only advances when a batch starts, so
    // "every Nth tick" counts run-ticks and the cadence just slips, never stacks.
    if (tickInFlight) return
    tick += 1
    const due = dueTasks(tick)
    if (due.length) void runGuardedBatch(due)
  }, BASE_TICK_MS)
  timer.unref?.()
}

export function stopBackgroundRefresh(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  tick = 0
  tickInFlight = false
}
