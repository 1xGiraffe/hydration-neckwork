// Continuous background process for the four derivation jobs in jobs.ts (the
// read models a plain materialized view cannot express). Entrypoint:
// `tsx src/derivations/runner.ts` — a standalone process/container, distinct
// from the API's own timer-driven startAccountTradeVolumeRefresh (server.ts),
// which only covers the newest account_trade_volume partitions between full
// runner cycles.
//
// Each cycle mirrors startAccountTradeVolumeRefresh's per-run client
// lifecycle: open a fresh long-op client (a slow rebuild must never hold a
// connection open between ticks), do the work, close it in `finally`
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

const DERIVATIONS_POLL_SECONDS = Number(process.env.DERIVATIONS_POLL_SECONDS?.trim() || '600')
const ONESHOT = process.env.DERIVATIONS_ONESHOT === '1'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Static model labels line up with the `model` field each job returns on
// success, so a failure log (`<model> failed`) and a success log (`<model>=N`
// rows) name the same thing regardless of which path a job took.
const JOBS: { model: string; run: (client: ClickHouseClient) => Promise<DerivationResult> }[] = [
  { model: 'account_trade_volume', run: runAccountTradeVolume },
  { model: 'omnipool_owner_intervals', run: runOmnipoolOwnerIntervals },
  { model: 'xyk_farm_intervals', run: runXykFarmIntervals },
  { model: 'xyk_total_shares', run: runXykTotalShares },
]

// One recompute cycle: fresh long-op client, fresh asset registry, then all
// four jobs attempted regardless of any individual failure.
async function runCycle(): Promise<void> {
  const client = createLongOpClickHouseClient()
  const results: DerivationResult[] = []
  try {
    // The ATV job's valuation reads the asset registry (per-asset decimals +
    // price aliases); refresh it first, every cycle, so a newly-registered
    // asset is picked up without a restart. Guarded on its own: a registry
    // load failure should not stop the other three jobs, which don't need it.
    try {
      await loadExplorerAssets(client)
    } catch (err) {
      console.error('[derivations] asset registry refresh failed', err)
    }
    for (const { model, run } of JOBS) {
      try {
        results.push(await run(client))
      } catch (err) {
        console.error(`[derivations] ${model} failed`, err)
      }
    }
  } finally {
    await client.close().catch(() => {})
  }
  const summary = JOBS.map(({ model }) => {
    const result = results.find(r => r.model === model)
    return `${model}=${result ? result.rows : 'FAILED'}`
  }).join(' ')
  console.log(`[derivations] cycle complete: ${summary}`)
}

async function main(): Promise<void> {
  for (;;) {
    await runCycle()
    if (ONESHOT) {
      process.exit(0)
    }
    await sleep(DERIVATIONS_POLL_SECONDS * 1000)
  }
}

await main()
