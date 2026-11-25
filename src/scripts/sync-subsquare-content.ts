import { writeFile } from 'node:fs/promises'
import { createClickHouseClient } from '../db/client.js'
import { hasFlag, integerOption, stringOption } from '../util/cliArgs.js'
import { CircuitOpenError, SubsquareClient } from '../governance/subsquare/client.js'
import { imageFetchMode, remoteSafeFetch } from '../governance/subsquare/imageFetcher.js'
import { KuboClient } from '../governance/subsquare/kubo.js'
import { buildReport, verifyMedia } from '../governance/subsquare/report.js'
import { GovernanceSync, type CycleResult } from '../governance/subsquare/sync.js'

// Subsquare → forum import and sync (the governance-content-sync service).
//
//   --loop                 run a cycle every --cycle-minutes (the first is a full import
//                          when the forum tables are empty, else an incremental cycle)
//   --once                 one cycle and exit
//   --full                 force a full (resumable) import pass
//   --dry-run              read Subsquare and ClickHouse, write NOTHING (no rows, no pins)
//   --report=<path>        write the validation report JSON there (a full pass) and print it
//   --no-images            skip image re-hosting (also skipped, with an error logged, when
//                          neither IMAGE_FETCHER_URL nor IMAGE_FETCH_IN_PROCESS=1 is set)
//   --refetch-all          with --full: re-read every item even when stored unchanged
//                          (the post-import report; an unchanged source then writes nothing)
//   --verify-media         re-hash every pinned image and print the result, then exit
//   --cache-dir=<dir> --cache=write|read|read-write   record / replay Subsquare answers
//                          (a dry run that recorded them feeds the real import without a
//                          second crawl)
//
// SUBSQUARE_SYNC_ENABLED=false is the kill switch: the loop idles and sends nothing.

const loop = hasFlag('loop')
const forceFull = hasFlag('full')
const dryRun = hasFlag('dry-run')
const cycleMinutes = integerOption('cycle-minutes', 10, { min: 1, max: 1440, clamp: true })
const reportPath = stringOption('report')
const cacheDir = stringOption('cache-dir')
const cacheMode = (stringOption('cache') ?? 'read-write') as 'read' | 'write' | 'read-write'
const sweepHours = Number(process.env.SUBSQUARE_SWEEP_HOURS ?? 24) || 24
const enabled = (process.env.SUBSQUARE_SYNC_ENABLED ?? 'true').toLowerCase() !== 'false'
const ipfsUrl = process.env.IPFS_API_URL ?? ''

const ch = createClickHouseClient()
const kubo = ipfsUrl ? new KuboClient(ipfsUrl, fetch, process.env.IPFS_TOKEN_SYNC ?? '') : null
const client = new SubsquareClient({
  baseUrl: process.env.SUBSQUARE_API_URL ?? 'https://hydration-api.subsquare.io',
  rps: Number(process.env.SUBSQUARE_RPS ?? 1) || 1,
  cache: cacheDir ? { dir: cacheDir, mode: cacheMode } : undefined,
})
// Strangers' image URLs are fetched by the isolated fetcher service (docker-compose.yml:
// governance-image-fetcher), never from this process's networks — unless
// IMAGE_FETCH_IN_PROCESS=1 asks for that explicitly (local development). With neither
// set, the image pass does not run.
const fetchMode = imageFetchMode(process.env)
const wantImages = !hasFlag('no-images') && !!kubo
if (wantImages) {
  if (fetchMode.mode === 'fetcher') console.log('[governance-sync] image fetches go through the isolated fetcher')
  else if (fetchMode.mode === 'in-process') console.warn('[governance-sync] WARN: IMAGE_FETCH_IN_PROCESS=1 — image fetches run in this process (local development only)')
  else console.error('[governance-sync] ERROR: IMAGE_FETCHER_URL is unset — the image pass is disabled (IMAGE_FETCH_IN_PROCESS=1 fetches in this process, for local development only)')
}
const sync = new GovernanceSync({
  client, ch, kubo, dryRun, images: wantImages && fetchMode.mode !== 'off',
  imageFetch: fetchMode.mode === 'fetcher' ? remoteSafeFetch(fetchMode.url) : undefined,
  maxImagesPerCycle: integerOption('max-images', 400, { min: 0, max: 10_000, clamp: true }),
  cycleMinutes, sweepHours, refetchAll: hasFlag('refetch-all'),
})
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function summaryLine(r: CycleResult): string {
  const f = r.fetched, s = r.stats, i = r.images
  const warnings = Object.entries(r.warnings).map(([k, v]) => `${k}=${v}`).join(',') || 'none'
  return `[governance-sync] cycle complete: mode=${r.mode}${dryRun ? ' dry-run' : ''} requests=${r.requests} listPages=${f.listPages} listed=${f.head} sweep=${f.sweep} uidProbes=${f.uidProbes} details=${f.details} gone=${f.gone} threads=${f.threads} appendants=${f.appendants} polls=${f.polls}`
    + ` posts=+${s.postsNew}/~${s.postsChanged}/-${s.postsRemoved} stubs=${s.stubs} comments=+${s.commentsNew}/~${s.commentsChanged}/-${s.commentsRemoved} revisions=${s.revisions} modlog=${s.modlog} seq=${s.seqAssigned} normalised=${r.normalised.posts}/${r.normalised.comments}/${r.normalised.revisions} written=${r.written}`
    + ` images=due:${i.due},cid:${i.pinnedCid},rehosted:${i.rehosted},archived:${i.archived},failed:${i.failed},deferred:${i.deferred},gc:${i.gc ?? "-"} warnings=${warnings}`
}

async function forumEmpty(): Promise<boolean> {
  const res = await ch.query({ query: 'SELECT count() AS n FROM price_data.forum_posts', format: 'JSONEachRow' })
  return Number((await res.json<{ n: string }>())[0]?.n ?? 0) === 0
}

async function cycle(full: boolean): Promise<void> {
  // A breaker that opened aborted the last cycle only: this one starts afresh.
  client.resetBreaker()
  const result = full ? await sync.fullImport() : await sync.incremental()
  console.log(summaryLine(result))
  if (full && reportPath) {
    const report = await buildReport(result, ch, { dryRun })
    const json = JSON.stringify(report, null, 2)
    await writeFile(reportPath, json)
    console.log(json)
  }
}

async function main(): Promise<void> {
  if (hasFlag('verify-media')) {
    if (!kubo) throw new Error('IPFS_API_URL is not set')
    console.log(JSON.stringify(await verifyMedia(ch, kubo), null, 2))
    return
  }
  if (!enabled) {
    console.log('[governance-sync] SUBSQUARE_SYNC_ENABLED=false — idle, no requests are sent')
    if (!loop) return
    for (;;) await sleep(3_600_000)
  }
  let first = true
  for (;;) {
    const started = Date.now()
    try {
      await cycle(forceFull ? first : first && await forumEmpty())
    } catch (err) {
      const kind = err instanceof CircuitOpenError ? 'circuit open; cycle aborted' : 'cycle failed'
      console.error(`[governance-sync] ${kind}: ${err instanceof Error ? err.message : String(err)}`)
      if (!loop) process.exitCode = 1
    }
    first = false
    if (!loop) break
    await sleep(Math.max(5_000, cycleMinutes * 60_000 - (Date.now() - started)))
  }
}

await main()
await ch.close()
