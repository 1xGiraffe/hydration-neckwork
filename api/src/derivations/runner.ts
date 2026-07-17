// Continuous background process for the four derivation jobs in jobs.ts (the
// read models a plain materialized view cannot express). Entrypoint:
// `tsx src/derivations/runner.ts` — a standalone process/container that owns
// these jobs exclusively; the API itself no longer runs any timer-driven
// equivalent.
//
// Each cycle opens a fresh long-op client (a slow rebuild must never hold a
// connection open between ticks), does the work, and closes it in `finally`
// regardless of outcome. The four jobs share one client per cycle but are
// each wrapped in their own try/catch so one failing job (e.g. a transient
// ClickHouse hiccup) never stalls the other three.
//
// Set DERIVATIONS_ONESHOT=1 to run exactly one cycle and exit 0 instead of
// looping — used to verify a cycle completes cleanly without waiting on the
// poll interval.

import { createLongOpClickHouseClient, type ClickHouseClient } from '../db/client.ts'
import { loadExplorerAssets } from '../services/explorerAssets.ts'
import {
  runAccountTradeVolume,
  runOmnipoolOwnerIntervals,
  runXykFarmIntervals,
  runXykTotalShares,
  type DerivationResult,
} from './jobs.ts'

const DEFAULT_POLL_SECONDS = 600

// Malformed/non-finite env values (unset, empty, non-numeric, "NaN", "Infinity")
// must fall back to the default rather than propagate a NaN poll interval,
// which would turn `setTimeout(resolve, NaN * 1000)` into an immediate-fire
// busy loop instead of a 10-minute wait.
export function parsePollSeconds(raw: string | undefined): number {
  const parsed = Number(raw?.trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_SECONDS
}

const DERIVATIONS_POLL_SECONDS = parsePollSeconds(process.env.DERIVATIONS_POLL_SECONDS)
const ONESHOT = process.env.DERIVATIONS_ONESHOT === '1'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface DerivationJob {
  model: string
  run: (client: ClickHouseClient) => Promise<DerivationResult>
}

// Static model labels line up with the `model` field each job returns on
// success, so a failure log (`<model> failed`) and a success log (`<model>=N`
// rows) name the same thing regardless of which path a job took.
const JOBS: DerivationJob[] = [
  { model: 'account_trade_volume', run: runAccountTradeVolume },
  { model: 'omnipool_owner_intervals', run: runOmnipoolOwnerIntervals },
  { model: 'xyk_farm_intervals', run: runXykFarmIntervals },
  { model: 'xyk_total_shares', run: runXykTotalShares },
]

export interface RunCycleDeps {
  jobs: DerivationJob[]
  loadAssets: (client: ClickHouseClient) => Promise<void>
  makeClient: () => ClickHouseClient
}

// One recompute cycle: fresh long-op client, fresh asset registry, then every
// job attempted regardless of any individual failure. Pulled out of main's
// loop so it can be exercised with fake jobs/client/asset-loader in
// runner.test.ts without opening a real ClickHouse connection — both the
// for(;;) loop below and the DERIVATIONS_ONESHOT path call this same function.
export async function runCycle({ jobs, loadAssets, makeClient }: RunCycleDeps): Promise<void> {
  const client = makeClient()
  const results: DerivationResult[] = []
  try {
    // The ATV job's valuation reads the asset registry (per-asset decimals +
    // price aliases); refresh it first, every cycle, so a newly-registered
    // asset is picked up without a restart. Guarded on its own: a registry
    // load failure should not stop the other jobs, which don't need it.
    try {
      await loadAssets(client)
    } catch (err) {
      console.error('[derivations] asset registry refresh failed', err)
    }
    for (const { model, run } of jobs) {
      try {
        results.push(await run(client))
      } catch (err) {
        console.error(`[derivations] ${model} failed`, err)
      }
    }
  } finally {
    await client.close().catch(() => {})
  }
  const summary = jobs.map(({ model }) => {
    const result = results.find(r => r.model === model)
    return `${model}=${result ? result.rows : 'FAILED'}`
  }).join(' ')
  console.log(`[derivations] cycle complete: ${summary}`)
}

async function main(): Promise<void> {
  const deps: RunCycleDeps = {
    jobs: JOBS,
    loadAssets: loadExplorerAssets,
    makeClient: createLongOpClickHouseClient,
  }
  for (;;) {
    await runCycle(deps)
    if (ONESHOT) {
      process.exit(0)
    }
    await sleep(DERIVATIONS_POLL_SECONDS * 1000)
  }
}

// Only run the loop when this file is executed directly (`tsx
// src/derivations/runner.ts`), not when imported — runner.test.ts imports
// runCycle/parsePollSeconds and must not trigger a real DB connection or an
// infinite loop as a side effect of import.
const isMainModule = import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  await main()
}
