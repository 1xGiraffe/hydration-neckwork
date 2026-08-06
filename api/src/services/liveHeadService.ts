import type { ClickHouseClient } from '../db/client.ts'
import type { ServerResponse } from 'node:http'
import { publishIndexedRawHead } from './explorerService.ts'
import { pendingBestHeight } from './pendingHeadService.ts'

// Server-sent head events: one shared ClickHouse poller fans two watermarks
// out to every connected tab, so live surfaces refetch the moment their data
// exists instead of waiting out a poll timer:
//   head — the raw-ingestion checkpoint (what the explorer's feeds read);
//   main — the price indexer's newest block (what preis candles and the
//          indexer-status chip depend on; it trails `head` by its own
//          processing, so pushing raw alone would fire candle refetches
//          before the candles exist).
// The poller runs only while at least one client is connected (at most one
// trivial read per second, shared by all viewers), and publishes each raw
// head into the feed caches' head probe BEFORE broadcasting, so a refetch
// racing the push is served the pushed head, never the probe's older value.

const POLL_MS = 1_000
// Comment frames keep idle proxy hops from timing the stream out.
const KEEPALIVE_MS = 25_000

let client: ClickHouseClient
export function initLiveHeadService(c: ClickHouseClient): void { client = c }

const clients = new Set<ServerResponse>()
let lastHead = 0
let lastMain = 0
let lastBest = 0
let pollTimer: NodeJS.Timeout | null = null
let keepaliveTimer: NodeJS.Timeout | null = null
let polling = false

export function sseHeadFrame(head: number, main: number, best = 0): string {
  // best — the newest UNFINALIZED block the pending layer can show; clients
  // refetch feeds on its advance so incoming blocks appear pre-finality.
  return `event: head\ndata: {"head":${head},"main":${main},"best":${best}}\n\n`
}

async function pollOnce(): Promise<void> {
  if (polling) return
  polling = true
  try {
    const res = await client.query({
      query: `SELECT
                (SELECT max(last_block) FROM price_data.raw_ingestion_state) AS head,
                (SELECT max(block_height) FROM price_data.blocks) AS main`,
      format: 'JSONEachRow',
    })
    const row = (await res.json<{ head: number | null; main: number | null }>())[0]
    const head = Number(row?.head ?? 0)
    const main = Number(row?.main ?? 0)
    const best = pendingBestHeight()
    if (head > lastHead || main > lastMain || best > lastBest) {
      lastHead = Math.max(lastHead, head)
      lastMain = Math.max(lastMain, main)
      lastBest = Math.max(lastBest, best)
      publishIndexedRawHead(lastHead)
      const frame = sseHeadFrame(lastHead, lastMain, lastBest)
      for (const c of clients) c.write(frame)
    }
  } catch { /* transient read failure — the next tick retries */ } finally {
    polling = false
  }
}

function ensureTimers(): void {
  pollTimer ??= setInterval(() => { void pollOnce() }, POLL_MS)
  keepaliveTimer ??= setInterval(() => { for (const c of clients) c.write(': ka\n\n') }, KEEPALIVE_MS)
}

function stopTimers(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null }
}

export function addLiveHeadClient(res: ServerResponse): void {
  clients.add(res)
  // Replay the last known heads immediately, so a (re)connecting tab
  // resynchronizes without waiting for the next block.
  if (lastHead > 0 || lastMain > 0) res.write(sseHeadFrame(lastHead, lastMain, lastBest))
  ensureTimers()
}

export function removeLiveHeadClient(res: ServerResponse): void {
  clients.delete(res)
  if (clients.size === 0) stopTimers()
}

export function liveHeadClientCount(): number { return clients.size }

export function stopLiveHeadService(): void {
  stopTimers()
  for (const c of clients) { try { c.end() } catch { /* already closing */ } }
  clients.clear()
}
