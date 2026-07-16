import type { Runtime } from '@subsquid/substrate-runtime'
import { createClickHouseClient } from '../db/client.js'
import { config } from '../config.js'
import { hasFlag, integerOption, optionalIntegerOption } from '../util/cliArgs.js'
import { createSnapshotRpcClient, loadSnapshotRuntime, resolveSnapshotAnchor, runSnapshotProcess } from './snapshotRuntime.js'

// One-shot on-chain identity snapshot.
//
// Pages over every Identity.IdentityOf entry at a single anchor block (default the
// finalized head) and writes one price_data.account_identities row per account
// that has a display name, with verified = has a KnownGood/Reasonable judgement.
// The API's identityService reads this table (refreshed in memory every 5 min), so
// the explorer can show verified display names on account pills.
//
// Run it ONCE to seed, then periodically to refresh (ReplacingMergeTree(updated_at)
// dedupes — a newer snapshot supersedes the old row for each account).
//
// Usage:
//   npx tsx src/scripts/snapshot-identities.ts [--dry-run] [--block=N] [--page-size=500]
//
// State availability: reads STATE at the anchor block via RPC_URL. A pruned node
// only keeps recent state, so a historical --block needs a full-archive RPC; the
// head default always works.

interface AccountIdentityRow {
  account_id: string
  display: string
  verified: number
  email: string
  web: string
  twitter: string
  updated_at: string
}

const dryRun = hasFlag('dry-run')
// --loop runs an initial snapshot immediately, then re-snapshots every
// --refresh-hours, so the service self-populates on `docker compose up` and keeps
// identities fresh without any manual step.
const loop = hasFlag('loop')
const refreshHours = integerOption('refresh-hours', 24)
const pageSize = integerOption('page-size', 500)
const flushThreshold = integerOption('flush', 5_000)
const blockOverride = optionalIntegerOption('block')

const client = createClickHouseClient()
const rpc = createSnapshotRpcClient()

async function buildRuntime(hash: string): Promise<{ runtime: Runtime; timestamp: string }> {
  return loadSnapshotRuntime(rpc, hash)
}

// AccountId32 storage keys decode to a 0x-hex string or raw bytes depending on the
// runtime type; normalise to lowercase 0x + 64 hex (the account_id form used by the
// rest of the pipeline).
function toAccountId(key: unknown): string | null {
  const raw = Array.isArray(key) ? key[0] : key
  let hex: string | null = null
  if (raw instanceof Uint8Array) hex = Buffer.from(raw).toString('hex')
  else if (typeof raw === 'string') hex = raw.startsWith('0x') ? raw.slice(2) : raw
  if (hex == null || !/^[0-9a-fA-F]{64}$/.test(hex)) return null
  return `0x${hex.toLowerCase()}`
}

// Identity `Data` enum -> string. Human-readable variants are None and Raw/RawN
// (inline bytes); hashed variants (Sha256, Keccak256, …) aren't display text.
function dataToString(data: unknown): string {
  if (data == null) return ''
  if (typeof data === 'string') return data.startsWith('0x') ? bytesToUtf8(data) : data
  if (data instanceof Uint8Array) return bytesToUtf8(data)
  const d = data as { __kind?: string; value?: unknown }
  const kind = d.__kind
  if (!kind || kind === 'None') return ''
  if (kind === 'Raw' || /^Raw\d+$/.test(kind)) return bytesToUtf8(d.value)
  return ''
}

function bytesToUtf8(value: unknown): string {
  let bytes: Uint8Array | null = null
  if (value instanceof Uint8Array) bytes = value
  else if (typeof value === 'string') {
    if (!value.startsWith('0x')) return value.replace(/\0+$/, '').trim()
    try { bytes = Uint8Array.from(Buffer.from(value.slice(2), 'hex')) } catch { return '' }
  }
  if (bytes == null) return ''
  try { return Buffer.from(bytes).toString('utf8').replace(/\0+$/, '').trim() } catch { return '' }
}

// Registration value may be `Registration` or, on identity v2, `[Registration, Option<Username>]`.
function registrationOf(value: unknown): { info?: Record<string, unknown>; judgements?: unknown[] } | null {
  const reg = Array.isArray(value) ? value[0] : value
  if (reg == null || typeof reg !== 'object') return null
  return reg as { info?: Record<string, unknown>; judgements?: unknown[] }
}

function isVerified(judgements: unknown): boolean {
  if (!Array.isArray(judgements)) return false
  for (const entry of judgements) {
    // Each entry is [registrarIndex, Judgement]; Judgement is a {__kind} enum.
    const judgement = Array.isArray(entry) ? entry[1] : entry
    const kind = (judgement as { __kind?: string } | null)?.__kind
    if (kind === 'KnownGood' || kind === 'Reasonable') return true
  }
  return false
}

async function runOnce(): Promise<void> {
  const { hash, height } = await resolveSnapshotAnchor(rpc, blockOverride)
  const { runtime, timestamp } = await buildRuntime(hash)

  console.log(JSON.stringify({
    type: 'identity_snapshot_start',
    dry_run: dryRun,
    anchor_block: height,
    anchor_hash: hash,
    anchor_timestamp: timestamp,
    page_size: pageSize,
    rpc_url: config.RPC_URL,
  }))

  let buffer: AccountIdentityRow[] = []
  let scanned = 0
  let withDisplay = 0
  let inserted = 0
  let flushSeq = 0
  let sampleLogged = 0
  const startedAt = Date.now()

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return
    const rows = buffer
    buffer = []
    await client.insert({
      table: 'price_data.account_identities',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: `account-identities-snapshot-${height}-${flushSeq++}-${rows.length}`,
      },
    })
    inserted += rows.length
  }

  for await (const page of runtime.getStoragePairsPaged(pageSize, hash, 'Identity.IdentityOf')) {
    for (const [key, value] of page) {
      scanned++
      const accountId = toAccountId(key)
      if (accountId == null) continue
      const reg = registrationOf(value)
      const info = reg?.info
      if (info == null) continue
      const display = dataToString(info.display)
      if (sampleLogged < 3 && display) {
        console.log(JSON.stringify({ type: 'identity_sample', account_id: accountId, display, verified: isVerified(reg?.judgements) }))
        sampleLogged++
      }
      if (!display) continue
      withDisplay++
      buffer.push({
        account_id: accountId,
        display,
        verified: isVerified(reg?.judgements) ? 1 : 0,
        email: dataToString(info.email),
        web: dataToString(info.web),
        twitter: dataToString(info.twitter),
        updated_at: timestamp,
      })
      if (!dryRun && buffer.length >= flushThreshold) await flush()
    }
    if (scanned % 20_000 < pageSize) {
      console.log(JSON.stringify({ type: 'identity_snapshot_progress', scanned, with_display: withDisplay, seconds: Math.round((Date.now() - startedAt) / 1000) }))
    }
  }

  if (!dryRun) await flush()

  console.log(JSON.stringify({
    type: 'identity_snapshot_done',
    dry_run: dryRun,
    anchor_block: height,
    scanned,
    with_display: withDisplay,
    rows_inserted: inserted,
    seconds: Math.round((Date.now() - startedAt) / 1000),
  }, null, 2))
}

void runSnapshotProcess({
  loop,
  refreshHours,
  runOnce,
  close: async () => {
    await client.close()
    rpc.close()
  },
})
