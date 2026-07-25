import { createClickHouseClient } from '../db/client.js'
import { hasFlag, integerOption, stringOption } from '../util/cliArgs.js'
import {
  parseSubsquareTitle,
  planTitleFetches,
  subsquareReferendumUrl,
  type ReferendumInventoryRow,
  type ReferendumPallet,
  type StoredTitleRow,
} from '../governance/subsquareTitles.js'

// Referendum titles from SubSquare.
//
// The chain gives a referendum an index, a track and a proposal hash but no human
// title — that lives off-chain. "#369" tells a reader nothing, so the explorer
// shows "Authorize runtime upgrade 50" instead, which means the title has to be
// fetched and cached.
//
// The polling policy is deliberately lopsided, because the data is:
//   - A LIVE referendum's title is edited while the vote runs, so it is re-read
//     every --live-refresh-minutes. Hydration usually has 0-2 open at a time (at
//     the time of writing: exactly one, 369), so this is a couple of requests.
//   - A CONCLUDED referendum's title is frozen. Once stored it is never requested
//     again, which is what keeps this from hammering SubSquare for the 576 settled
//     referenda (OpenGov 0-369 plus Democracy 0-206).
// The first run therefore backfills at --max-fetches per cycle and then goes
// nearly silent.
//
// Usage:
//   npx tsx src/scripts/snapshot-referendum-titles.ts [--loop] [--dry-run]
//     [--max-fetches=40] [--delay-ms=1500] [--live-refresh-minutes=30]
//     [--cycle-minutes=15] [--base-url=https://hydration.subsquare.io]

const dryRun = hasFlag('dry-run')
const loop = hasFlag('loop')
const maxFetches = integerOption('max-fetches', 40, { min: 1, max: 400, clamp: true })
const delayMs = integerOption('delay-ms', 1_500, { min: 0, max: 60_000, clamp: true })
const liveRefreshMinutes = integerOption('live-refresh-minutes', 30, { min: 1, max: 1_440, clamp: true })
const cycleMinutes = integerOption('cycle-minutes', 15, { min: 1, max: 1_440, clamp: true })
const flushEvery = integerOption('flush', 25, { min: 1, max: 500, clamp: true })
const requestTimeoutMs = integerOption('timeout-ms', 20_000, { min: 1_000, max: 120_000, clamp: true })
const baseUrl = stringOption('base-url') ?? process.env.SUBSQUARE_BASE_URL ?? 'https://hydration.subsquare.io'

const client = createClickHouseClient()
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Referendum inventory straight from the lifecycle events, so the fetcher never
// invents an index: OpenGov referenda exist once Referenda.Submitted names them and
// are concluded by Confirmed/Rejected/Cancelled/TimedOut/Killed/Approved; Democracy
// ones exist on Democracy.Started and conclude on Passed/NotPassed/Cancelled/Vetoed.
async function loadInventory(): Promise<ReferendumInventoryRow[]> {
  const res = await client.query({
    query: `
      SELECT 'opengov' AS pallet,
             toUInt32(JSONExtractInt(args_json, 'index')) AS ref_index,
             maxIf(1, event_name IN ('Referenda.Confirmed','Referenda.Rejected','Referenda.Cancelled','Referenda.TimedOut','Referenda.Killed','Referenda.Approved')) AS concluded
      FROM price_data.raw_events
      WHERE event_name LIKE 'Referenda.%' AND JSONHas(args_json, 'index')
      GROUP BY pallet, ref_index
      UNION ALL
      SELECT 'democracy' AS pallet,
             toUInt32(JSONExtractInt(args_json, 'refIndex')) AS ref_index,
             maxIf(1, event_name IN ('Democracy.Passed','Democracy.NotPassed','Democracy.Cancelled','Democracy.Vetoed','Democracy.Executed')) AS concluded
      FROM price_data.raw_events
      WHERE event_name LIKE 'Democracy.%' AND event_name != 'Democracy.Voted' AND JSONHas(args_json, 'refIndex')
      GROUP BY pallet, ref_index`,
    format: 'JSONEachRow',
  })
  return (await res.json<{ pallet: string; ref_index: number; concluded: number }>()).map(row => ({
    pallet: row.pallet as ReferendumPallet,
    refIndex: Number(row.ref_index),
    concluded: Number(row.concluded) === 1,
  }))
}

async function loadStored(): Promise<StoredTitleRow[]> {
  const res = await client.query({
    query: `SELECT pallet, ref_index, title, toUnixTimestamp(fetched_at) AS fetched_at
            FROM price_data.referendum_titles FINAL`,
    format: 'JSONEachRow',
  })
  return (await res.json<{ pallet: string; ref_index: number; title: string; fetched_at: number }>()).map(row => ({
    pallet: row.pallet as ReferendumPallet,
    refIndex: Number(row.ref_index),
    title: row.title,
    fetchedAtMs: Number(row.fetched_at) * 1000,
  }))
}

// A page that does not name a referendum yields null rather than a placeholder, so
// an unavailable title stays visibly absent and gets retried next cycle instead of
// being cached as a plausible-looking wrong one.
async function fetchTitle(pallet: ReferendumPallet, refIndex: number): Promise<string | null> {
  const url = subsquareReferendumUrl(baseUrl, pallet, refIndex)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'hydration-neckwork-explorer/1.0 (+referendum title sync)', accept: 'text/html' },
    })
    if (!res.ok) { console.warn(`[titles] ${pallet} ${refIndex}: HTTP ${res.status}`); return null }
    return parseSubsquareTitle(await res.text())
  } catch (err) {
    console.warn(`[titles] ${pallet} ${refIndex}: ${(err as Error).message}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function runCycle(): Promise<void> {
  const [inventory, stored] = await Promise.all([loadInventory(), loadStored()])
  const concludedByKey = new Map(inventory.map(row => [`${row.pallet}:${row.refIndex}`, row.concluded]))
  const plan = planTitleFetches(inventory, stored, {
    nowMs: Date.now(),
    liveRefreshMs: liveRefreshMinutes * 60_000,
    maxFetches,
  })
  const missing = inventory.length - stored.filter(row => row.title).length
  console.log(`[titles] ${inventory.length} referenda known, ${stored.length} stored, ${Math.max(0, missing)} without a title; fetching ${plan.length} this cycle`)
  if (!plan.length) return

  type TitleRow = { pallet: string; ref_index: number; title: string; concluded: number; fetched_at: string }
  let pending: TitleRow[] = []
  let written = 0
  // Flush as we go. A first run has hundreds of referenda to fetch, and holding
  // every row until the end would throw away the whole cycle's work on one failure
  // — and leave the table empty for however long the cycle takes.
  const flush = async (): Promise<void> => {
    if (!pending.length) return
    if (dryRun) { console.log(`[titles] dry run, would write ${pending.length} row(s)`); pending = []; return }
    await client.insert({ table: 'price_data.referendum_titles', values: pending, format: 'JSONEachRow' })
    written += pending.length
    pending = []
  }

  for (const [i, target] of plan.entries()) {
    if (i > 0 && delayMs > 0) await sleep(delayMs)
    const title = await fetchTitle(target.pallet, target.refIndex)
    if (title == null) continue
    pending.push({
      pallet: target.pallet,
      ref_index: target.refIndex,
      title,
      concluded: concludedByKey.get(`${target.pallet}:${target.refIndex}`) ? 1 : 0,
      fetched_at: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    })
    console.log(`[titles] ${target.pallet} ${target.refIndex} (${target.reason}): ${title}`)
    if (pending.length >= flushEvery) await flush()
  }
  await flush()
  console.log(written ? `[titles] wrote ${written} row(s)` : '[titles] nothing new to write')
}

async function main(): Promise<void> {
  if (!loop) { await runCycle(); return }
  for (;;) {
    try { await runCycle() } catch (err) { console.error('[titles] cycle failed:', (err as Error).message) }
    await sleep(cycleMinutes * 60_000)
  }
}

await main()
