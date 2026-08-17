import type { ClickHouseClient } from '../db/client.ts'
import type { ServerResponse } from 'node:http'
import { publishIndexedRawHead } from './explorerService.ts'
import { mempoolGeneration, pendingBestHeight } from './pendingHeadService.ts'

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
// The transaction pool moves many times between blocks, so it gets its own
// much faster push — and it needs no ClickHouse read at all: the generation
// counter lives in memory, and the heads it rides along with are the ones the
// poller above already established. Clients act on a pool-only frame by
// refetching just the two feeds that carry pool rows (see POOL_PUSH_KEYS).
const POOL_PUSH_MS = 150
// The pool generation bumps on every sweep whose membership changed — many times
// a block in normal traffic, and at the sweep rate under a mempool flood. Each
// bump fans a frame out to EVERY connected client, which refetches the pool feeds
// on it. So a pool-ONLY change is rate-limited to this cadence: one source churning
// the pool cannot turn into N clients × ~10 refetches/second. A block-handoff
// (best-height advance) is latency-critical and bypasses this entirely.
const POOL_PUSH_MIN_MS = 1_000
// Both watermarks this timer carries live in memory (see pushMemoryWatermarks),
// so it runs whether or not the transaction pool is being read.
// Comment frames keep idle proxy hops from timing the stream out.
const KEEPALIVE_MS = 25_000

let client: ClickHouseClient
export function initLiveHeadService(c: ClickHouseClient): void { client = c }

const clients = new Set<ServerResponse>()
let lastHead = 0
let lastMain = 0
let lastBest = 0
let lastPool = -1
let lastPoolPushMs = 0
let pollTimer: NodeJS.Timeout | null = null
let poolTimer: NodeJS.Timeout | null = null
let keepaliveTimer: NodeJS.Timeout | null = null
let polling = false

export function sseHeadFrame(head: number, main: number, best = 0, pool = 0): string {
  // best — the newest UNFINALIZED block the pending layer can show; clients
  //        refetch feeds on its advance so incoming blocks appear pre-finality.
  // pool — the transaction-pool generation counter; it bumps whenever a pool
  //        entry appears, drops or gets judged, so mempool rows surface and
  //        update between blocks.
  return `event: head\ndata: {"head":${head},"main":${main},"best":${best},"pool":${pool}}\n\n`
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
    const pool = mempoolGeneration()
    if (head > lastHead || main > lastMain || best > lastBest || pool !== lastPool) {
      if (pool !== lastPool) lastPoolPushMs = Date.now()
      lastHead = Math.max(lastHead, head)
      lastMain = Math.max(lastMain, main)
      lastBest = Math.max(lastBest, best)
      lastPool = pool
      publishIndexedRawHead(lastHead)
      const frame = sseHeadFrame(lastHead, lastMain, lastBest, lastPool)
      for (const c of clients) c.write(frame)
    }
  } catch { /* transient read failure — the next tick retries */ } finally {
    polling = false
  }
}

// Whether a pool-only generation change may be pushed yet. The recurring timer
// retries a throttled-away change every tick (lastPool only advances on a real
// push), so no update is lost — pool churn is coalesced, not dropped.
export function poolPushDue(now: number, lastPushMs: number, minIntervalMs = POOL_PUSH_MIN_MS): boolean {
  return now - lastPushMs >= minIntervalMs
}

// The in-memory watermarks: the transaction-pool generation and the newest
// UNFINALIZED block. Neither needs a read, so both ride this fast timer rather
// than the 1s ClickHouse poller — which matters most at the handoff, where a
// transaction leaves the pool the instant its block is imported and would
// otherwise wait out that second before its unfinalized row could be pushed.
function pushMemoryWatermarks(): void {
  const pool = mempoolGeneration()
  const best = pendingBestHeight()
  if (lastHead === 0) return
  const bestMoved = best > lastBest
  const poolMoved = pool !== lastPool
  if (!bestMoved && !poolMoved) return
  // A block-handoff always pushes; a pool-only change is rate-limited so mempool
  // churn cannot drive a per-client refetch storm.
  if (poolMoved && !bestMoved && !poolPushDue(Date.now(), lastPoolPushMs)) return
  if (poolMoved) lastPoolPushMs = Date.now()
  lastPool = pool
  lastBest = Math.max(lastBest, best)
  for (const c of clients) c.write(sseHeadFrame(lastHead, lastMain, lastBest, lastPool))
}

function ensureTimers(): void {
  pollTimer ??= setInterval(() => { void pollOnce() }, POLL_MS)
  poolTimer ??= setInterval(pushMemoryWatermarks, POOL_PUSH_MS)
  keepaliveTimer ??= setInterval(() => { for (const c of clients) c.write(': ka\n\n') }, KEEPALIVE_MS)
}

function stopTimers(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (poolTimer) { clearInterval(poolTimer); poolTimer = null }
  if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null }
}

export function addLiveHeadClient(res: ServerResponse): void {
  clients.add(res)
  // Replay the last known heads immediately, so a (re)connecting tab
  // resynchronizes without waiting for the next block.
  if (lastHead > 0 || lastMain > 0) res.write(sseHeadFrame(lastHead, lastMain, lastBest, Math.max(0, lastPool)))
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
