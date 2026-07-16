import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import {
  accountRef,
  getAssets,
  resolveRelatedAccounts,
  type AccountRef,
} from './explorerService.ts'
import { assetDescriptor } from './explorerAssets.ts'
import { getTag, tagForAccount } from './tagService.ts'

// Candidate discovery is row-capped (most-recent refs first), not time-boxed —
// the lookup spans the full indexed history. Recency only decays the score.
const RECENCY_DECAY_DAYS = 365
const TRANSFER_REF_LIMIT = 5_000
const CEX_REF_LIMIT = 20_000
const SIGNED_BLOCK_LIMIT = 1_000
const MAX_FANOUT = 5
const MAX_CEX_ENDPOINT_USERS = 5
const MAX_CANDIDATES = 12
const CACHE_TTL_MS = 15 * 60_000
const MAX_CONCURRENT_COMPUTATIONS = 2
export const ACCOUNT_AFFINITY_BUSY_CODE = 'ACCOUNT_AFFINITY_BUSY'

const TRANSFER_EVENTS = ['Balances.Transfer', 'Tokens.Transfer', 'Currencies.Transferred']
const DIRECT_TRANSFER_CALLS = [
  'Balances.transfer',
  'Balances.transfer_allow_death',
  'Balances.transfer_keep_alive',
  'Balances.transfer_all',
  'Tokens.transfer',
  'Tokens.transfer_keep_alive',
  'Tokens.transfer_all',
  'Currencies.transfer',
]
const CEX_TAG_IDS = ['kraken']
const SYSTEM_PREFIXES = ['0x6d6f646c', '0x7369626c', '0x70617261', '0x506172656e74']
const DISCLAIMER = 'Behavioral signals, not proof of common ownership.'

const QUERY_SETTINGS = {
  max_threads: 4,
  max_execution_time: 5,
  max_memory_usage: '750000000',
  max_result_rows: '20000',
} as const

let client: ClickHouseClient
let activeComputations = 0

export function initAccountAffinityService(c: ClickHouseClient): void {
  client = c
}

export interface DirectTransfersReason {
  type: 'direct_transfers'
  count: number
  days: number
  valueUsd: number | null
  bidirectional: boolean
}

export interface NearSigningReason {
  type: 'near_signing'
  days: number
}

export interface SharedCexReason {
  type: 'shared_cex'
  name: string
}

export type CloseAccountReason = DirectTransfersReason | NearSigningReason | SharedCexReason

export interface CloseAccount {
  account: AccountRef
  score: number
  confidence: 'strong' | 'moderate'
  lastSeen: string
  reasons: CloseAccountReason[]
}

export interface CloseAccountsResponse {
  accounts: CloseAccount[]
  lookbackDays: number | null   // null: unlimited — the full indexed history
  disclaimer: string
}

interface DirectTransferRow {
  block_height: number
  ts: string
  extrinsic_index: number
  from_acc: string
  to_acc: string
  asset_id: number
  amount: string
  fanout: number
}

interface SignedBlockRow {
  actor: string
  block_height: number
  day: string
}

interface CexInteractionRow {
  user_acc: string
  cex_acc: string
  endpoint_users: number
}

interface CandidateEvidence {
  account: AccountRef
  rawAccountIds: Set<string>
  transferCount: number
  activeDays: Set<string>
  outbound: number
  inbound: number
  totalUsd: number
  maxSingleUsd: number
  pricedTransfers: number
  lastSeen: string
  nearSigningDays: number
  sharedCexNames: Set<string>
}

interface AssetPrice {
  decimals: number
}

export interface AffinityScoreInput {
  transferCount: number
  activeDays: number
  totalUsd: number
  bidirectional: boolean
  nearSigningDays: number
  sharedCex: boolean
  daysSinceLast: number
}

export function isSystemAccount(accountId: string): boolean {
  const lower = accountId.toLowerCase()
  return SYSTEM_PREFIXES.some(prefix => lower.startsWith(prefix))
}

export function isSelectiveCexEndpoint(userCount: number): boolean {
  return Number.isFinite(userCount) && userCount > 0 && userCount <= MAX_CEX_ENDPOINT_USERS
}

export function qualifiesAffinityCandidate(input: {
  transferCount: number
  activeDays: number
  totalUsd: number
  maxSingleUsd: number
  pricedTransfers: number
}): boolean {
  if (input.pricedTransfers === 0) return input.transferCount >= 3 && input.activeDays >= 3
  return (input.transferCount >= 2 && input.activeDays >= 2 && input.totalUsd >= 100)
    || input.maxSingleUsd >= 10_000
}

export function affinityScore(input: AffinityScoreInput): number {
  const amountPoints = Math.min(30, 10 * Math.log10(1 + Math.max(0, input.totalUsd) / 100))
  const transferPoints = Math.min(18, 2 * Math.max(0, input.transferCount))
  const dayPoints = Math.min(14, 3 * Math.max(0, input.activeDays))
  const bidirectionalPoints = input.bidirectional ? 8 : 0
  const timingPoints = input.nearSigningDays >= 2 ? Math.min(8, 4 * input.nearSigningDays) : 0
  const cexPoints = input.sharedCex ? 8 : 0
  const recencyPoints = Math.max(0, 4 * (1 - Math.max(0, input.daysSinceLast) / RECENCY_DECAY_DAYS))
  return Math.round(Math.min(100, 10 + amountPoints + transferPoints + dayPoints
    + bidirectionalPoints + timingPoints + cexPoints + recencyPoints))
}

// Count distinct days on which a candidate signed shortly after/before the
// target. Same-block matches are deliberately ignored: on Hydration they are
// dominated by reactive proxy/arbitrage bots rather than common operators.
export function nearSigningDays(targetBlocks: number[], candidateRows: Array<{ blockHeight: number; day: string }>): number {
  if (!targetBlocks.length || !candidateRows.length) return 0
  const sorted = [...new Set(targetBlocks)].sort((a, b) => a - b)
  const days = new Set<string>()
  for (const row of candidateRows) {
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (sorted[mid] < row.blockHeight) lo = mid + 1
      else hi = mid
    }
    const neighbors = [sorted[lo - 1], sorted[lo], sorted[lo + 1]]
    if (neighbors.some(block => block != null && Math.abs(block - row.blockHeight) >= 1 && Math.abs(block - row.blockHeight) <= 10)) {
      days.add(row.day)
    }
  }
  return days.size
}

function normalizedAccounts(accounts: string[]): string[] {
  return [...new Set(accounts.map(a => a.toLowerCase()).filter(a => /^0x[0-9a-f]{64}$/.test(a)))]
}

function cexMembers(): Map<string, string> {
  const out = new Map<string, string>()
  for (const tagId of CEX_TAG_IDS) {
    const tag = getTag(tagId)
    if (!tag) continue
    for (const member of tag.members) out.set(member.toLowerCase(), tag.name)
  }
  return out
}

function isServiceAccount(accountId: string): boolean {
  if (isSystemAccount(accountId)) return true
  const ref = accountRef(accountId)
  return !!ref.tag || !!tagForAccount(ref.accountId)
}

async function withComputationSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeComputations >= MAX_CONCURRENT_COMPUTATIONS) {
    const error = new Error('Close-account analysis is busy') as Error & { code: string }
    error.code = ACCOUNT_AFFINITY_BUSY_CODE
    throw error
  }
  activeComputations += 1
  try {
    return await fn()
  } finally {
    activeComputations -= 1
  }
}

function transferUsd(row: DirectTransferRow, assets: Map<number, AssetPrice>, historicalPrices: Map<string, number>): number | null {
  const asset = assets.get(Number(row.asset_id))
  const price = historicalPrices.get(`${Number(row.asset_id)}:${row.ts.slice(0, 10)}`)
  if (!asset || !price || price <= 0 || !/^\d+$/.test(row.amount)) return null
  const amount = Number(BigInt(row.amount)) / 10 ** asset.decimals
  const value = amount * price
  return Number.isFinite(value) && value >= 0 ? value : null
}

function parseTimestamp(value: string): number {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z'
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function daysSince(value: string): number {
  return Math.max(0, (Date.now() - parseTimestamp(value)) / 86_400_000)
}

async function loadDirectTransfers(accounts: string[]): Promise<DirectTransferRow[]> {
  const res = await client.query({
    query: `
      WITH refs AS (
        SELECT block_height, assumeNotNull(extrinsic_index) AS extrinsic_index
        FROM price_data.account_activity
        WHERE account IN ({accounts:Array(String)})
          AND event_name IN ({transferEvents:Array(String)})
          AND is_module_transfer = 0
          AND extrinsic_index IS NOT NULL
        GROUP BY block_height, extrinsic_index
        ORDER BY block_height DESC, extrinsic_index DESC
        LIMIT {refLimit:UInt32}
      ), transfers AS (
        SELECT
          e.block_height,
          toString(e.block_timestamp) AS ts,
          e.event_index,
          assumeNotNull(e.extrinsic_index) AS extrinsic_index,
          ifNull(e.call_address, '') AS call_address,
          JSONExtractString(e.args_json, 'from') AS from_acc,
          JSONExtractString(e.args_json, 'to') AS to_acc,
          if(e.event_name = 'Balances.Transfer', 0, multiIf(
            JSONHas(e.args_json, 'currencyId'), JSONExtractInt(e.args_json, 'currencyId'),
            JSONHas(e.args_json, 'currency_id'), JSONExtractInt(e.args_json, 'currency_id'),
            JSONHas(e.args_json, 'assetId'), JSONExtractInt(e.args_json, 'assetId'),
            JSONHas(e.args_json, 'asset_id'), JSONExtractInt(e.args_json, 'asset_id'),
            0
          )) AS asset_id,
          JSONExtractString(e.args_json, 'amount') AS amount,
          multiIf(e.event_name = 'Currencies.Transferred', 3, e.event_name = 'Tokens.Transfer', 2, 1) AS priority
        FROM price_data.raw_events AS e
        WHERE e.block_height >= (SELECT min(block_height) FROM refs)
          AND (e.block_height, assumeNotNull(e.extrinsic_index)) IN (SELECT block_height, extrinsic_index FROM refs)
          AND e.event_name IN ({transferEvents:Array(String)})
        ORDER BY e.block_height DESC, priority DESC, e.event_index DESC
        LIMIT 1 BY e.block_height, extrinsic_index, asset_id, lower(from_acc), lower(to_acc), amount
      ), verified AS (
        SELECT t.*
        FROM transfers AS t
        ANY INNER JOIN price_data.raw_calls AS c
          ON c.block_height = t.block_height
          AND c.extrinsic_index = t.extrinsic_index
          AND c.call_address = t.call_address
        WHERE c.block_height >= (SELECT min(block_height) FROM refs)
          AND c.call_name IN ({directCalls:Array(String)})
      ), fanouts AS (
        SELECT block_height, extrinsic_index,
          uniqExactIf(lower(participant), participant != '' AND lower(participant) NOT IN ({accounts:Array(String)})) AS fanout
        FROM verified
        ARRAY JOIN [from_acc, to_acc] AS participant
        GROUP BY block_height, extrinsic_index
      )
      SELECT
        t.block_height,
        t.ts,
        t.extrinsic_index,
        lower(t.from_acc) AS from_acc,
        lower(t.to_acc) AS to_acc,
        t.asset_id,
        t.amount,
        f.fanout
      FROM verified AS t
      ANY INNER JOIN fanouts AS f USING (block_height, extrinsic_index)
      WHERE (lower(t.from_acc) IN ({accounts:Array(String)}) OR lower(t.to_acc) IN ({accounts:Array(String)}))
      ORDER BY t.block_height DESC
      LIMIT {refLimit:UInt32}
    `,
    query_params: {
      accounts,
      transferEvents: TRANSFER_EVENTS,
      directCalls: DIRECT_TRANSFER_CALLS,
      refLimit: TRANSFER_REF_LIMIT,
    },
    clickhouse_settings: QUERY_SETTINGS,
    format: 'JSONEachRow',
  })
  return res.json<DirectTransferRow>()
}

async function loadHistoricalPrices(rows: DirectTransferRow[]): Promise<Map<string, number>> {
  const assetIds = [...new Set(rows.map(row => Number(row.asset_id)).filter(Number.isSafeInteger))]
  if (!assetIds.length) return new Map()
  // Only the (asset, day) pairs a transfer actually references — transferUsd keys on
  // `${asset_id}:${ts[:10]}`. Fetching every OHLC day for every asset across full
  // history returns tens of thousands of rows for accounts that touched many assets
  // (each has years of daily candles) and trips max_result_rows. Scoping to the
  // needed pairs bounds the result to the transfer count (≤ TRANSFER_REF_LIMIT).
  const pairs = [...new Set(rows
    .filter(row => Number.isSafeInteger(Number(row.asset_id)))
    .map(row => `${Number(row.asset_id)}:${row.ts.slice(0, 10)}`))]
  if (!pairs.length) return new Map()
  const res = await client.query({
    query: `SELECT asset_id, toString(toDate(interval_start)) AS day,
              toFloat64(argMaxMerge(close_state)) AS price
            FROM price_data.ohlc_1d
            WHERE asset_id IN ({assetIds:Array(UInt32)})
              AND concat(toString(asset_id), ':', toString(toDate(interval_start))) IN ({pairs:Array(String)})
            GROUP BY asset_id, interval_start`,
    query_params: { assetIds, pairs },
    clickhouse_settings: QUERY_SETTINGS,
    format: 'JSONEachRow',
  })
  const prices = new Map<string, number>()
  for (const row of await res.json<{ asset_id: number; day: string; price: number }>()) {
    const price = Number(row.price)
    if (price > 0 && Number.isFinite(price)) prices.set(`${Number(row.asset_id)}:${row.day}`, price)
  }
  return prices
}

async function loadSignedBlocks(targetAccounts: string[], candidates: CandidateEvidence[]): Promise<SignedBlockRow[]> {
  const actors = normalizedAccounts([...targetAccounts, ...candidates.flatMap(c => [...c.rawAccountIds])])
  if (!actors.length) return []
  const res = await client.query({
    query: `
      SELECT actor, block_height, toString(toDate(block_timestamp)) AS day
      FROM (
        SELECT
          if(ifNull(signer, '') IN ({actors:Array(String)}), ifNull(signer, ''), ifNull(effective_signer, '')) AS actor,
          block_height,
          block_timestamp
        FROM price_data.raw_extrinsics
        WHERE (ifNull(signer, '') IN ({actors:Array(String)}) OR ifNull(effective_signer, '') IN ({actors:Array(String)}))
        ORDER BY block_height DESC
        LIMIT {perActor:UInt16} BY actor
      )
      WHERE actor != ''
    `,
    query_params: { actors, perActor: SIGNED_BLOCK_LIMIT },
    clickhouse_settings: QUERY_SETTINGS,
    format: 'JSONEachRow',
  })
  return res.json<SignedBlockRow>()
}

async function loadCexInteractions(candidateAccounts: string[], cexAccounts: string[]): Promise<CexInteractionRow[]> {
  if (!candidateAccounts.length || !cexAccounts.length) return []
  const res = await client.query({
    query: `
      WITH refs AS (
        SELECT block_height, event_index
        FROM price_data.account_activity
        WHERE account IN ({cexAccounts:Array(String)})
          AND event_name IN ({transferEvents:Array(String)})
          AND is_module_transfer = 0
          AND extrinsic_index IS NOT NULL
        GROUP BY block_height, event_index
        ORDER BY block_height DESC, event_index DESC
        LIMIT {refLimit:UInt32}
      ), transfers AS (
        SELECT
          e.block_height,
          assumeNotNull(e.extrinsic_index) AS extrinsic_index,
          ifNull(e.call_address, '') AS call_address,
          JSONExtractString(e.args_json, 'from') AS from_acc,
          JSONExtractString(e.args_json, 'to') AS to_acc,
          if(e.event_name = 'Balances.Transfer', 0, multiIf(
            JSONHas(e.args_json, 'currencyId'), JSONExtractInt(e.args_json, 'currencyId'),
            JSONHas(e.args_json, 'currency_id'), JSONExtractInt(e.args_json, 'currency_id'),
            JSONHas(e.args_json, 'assetId'), JSONExtractInt(e.args_json, 'assetId'),
            JSONHas(e.args_json, 'asset_id'), JSONExtractInt(e.args_json, 'asset_id'),
            0
          )) AS asset_id,
          JSONExtractString(e.args_json, 'amount') AS amount,
          multiIf(e.event_name = 'Currencies.Transferred', 3, e.event_name = 'Tokens.Transfer', 2, 1) AS priority
        FROM price_data.raw_events AS e
        WHERE e.block_height >= (SELECT min(block_height) FROM refs)
          AND (e.block_height, e.event_index) IN (SELECT block_height, event_index FROM refs)
          AND e.event_name IN ({transferEvents:Array(String)})
          AND (from_acc IN ({cexAccounts:Array(String)}) OR to_acc IN ({cexAccounts:Array(String)}))
        ORDER BY e.block_height DESC, priority DESC, e.event_index DESC
        LIMIT 1 BY e.block_height, extrinsic_index, asset_id, lower(from_acc), lower(to_acc), amount
      ), verified AS (
        SELECT
          lower(if(t.from_acc IN ({cexAccounts:Array(String)}), t.to_acc, t.from_acc)) AS user_acc,
          lower(if(t.from_acc IN ({cexAccounts:Array(String)}), t.from_acc, t.to_acc)) AS cex_acc
        FROM transfers AS t
        ANY INNER JOIN price_data.raw_calls AS c
          ON c.block_height = t.block_height
          AND c.extrinsic_index = t.extrinsic_index
          AND c.call_address = t.call_address
        WHERE c.block_height >= (SELECT min(block_height) FROM refs)
          AND c.call_name IN ({directCalls:Array(String)})
      ), endpoint_stats AS (
        SELECT cex_acc, uniqExact(user_acc) AS endpoint_users
        FROM verified
        WHERE user_acc != ''
        GROUP BY cex_acc
      )
      SELECT DISTINCT
        v.user_acc,
        v.cex_acc,
        s.endpoint_users
      FROM verified AS v
      INNER JOIN endpoint_stats AS s USING (cex_acc)
      WHERE v.user_acc IN ({candidateAccounts:Array(String)})
      LIMIT {refLimit:UInt32}
    `,
    query_params: {
      candidateAccounts,
      cexAccounts,
      transferEvents: TRANSFER_EVENTS,
      directCalls: DIRECT_TRANSFER_CALLS,
      refLimit: CEX_REF_LIMIT,
    },
    clickhouse_settings: QUERY_SETTINGS,
    format: 'JSONEachRow',
  })
  return res.json<CexInteractionRow>()
}

function emptyResponse(): CloseAccountsResponse {
  return { accounts: [], lookbackDays: null, disclaimer: DISCLAIMER }
}

async function computeCloseAccounts(targetAccountsInput: string[], opts: { taggedTargets?: boolean } = {}): Promise<CloseAccountsResponse> {
  const targetAccounts = normalizedAccounts(targetAccountsInput)
  const targetSet = new Set(targetAccounts)
  // Address mode never analyzes service accounts (pools, exchanges, pots) —
  // their counterparties are the whole chain. Tag mode targets tagged members
  // BY DEFINITION, so the guard would short-circuit every tag to empty there.
  if (!targetAccounts.length || (!opts.taggedTargets && targetAccounts.some(isServiceAccount))) return emptyResponse()

  const rows = await loadDirectTransfers(targetAccounts)
  if (!rows.length) return emptyResponse()

  const [assetRows, historicalPrices] = await Promise.all([getAssets(), loadHistoricalPrices(rows)])

  const assets = new Map<number, AssetPrice>(assetRows.map(a => [a.assetId, { decimals: a.decimals }]))
  // Keep decimal lookup useful during a cold asset-registry refresh. Prices are
  // intentionally historical daily closes; missing historical prices remain
  // unpriced/count-only rather than being distorted by today's market value.
  const missingAssetIds = new Set(rows.map(row => Number(row.asset_id)).filter(assetId => !assets.has(assetId)))
  if (missingAssetIds.size) {
    for (const assetId of missingAssetIds) {
      const descriptor = assetDescriptor(assetId)
      assets.set(assetId, { decimals: descriptor.decimals })
    }
  }
  const cex = cexMembers()
  const targetCex = new Set<string>()
  const targetDirectBlocks = new Set<number>()

  const candidates = new Map<string, CandidateEvidence>()
  for (const row of rows) {
    if (Number(row.fanout) > MAX_FANOUT) continue
    const fromTarget = targetSet.has(row.from_acc)
    const rawCandidate = fromTarget ? row.to_acc : row.from_acc
    if (!rawCandidate || targetSet.has(rawCandidate)) continue
    if (fromTarget) targetDirectBlocks.add(Number(row.block_height))
    if (cex.has(rawCandidate)) {
      targetCex.add(rawCandidate)
      continue
    }
    if (isSystemAccount(rawCandidate)) continue
    const ref = accountRef(rawCandidate)
    if (targetSet.has(ref.accountId.toLowerCase()) || ref.tag || isSystemAccount(ref.accountId)) continue

    const canonical = ref.accountId.toLowerCase()
    let evidence = candidates.get(canonical)
    if (!evidence) {
      evidence = {
        account: ref,
        rawAccountIds: new Set(),
        transferCount: 0,
        activeDays: new Set(),
        outbound: 0,
        inbound: 0,
        totalUsd: 0,
        maxSingleUsd: 0,
        pricedTransfers: 0,
        lastSeen: row.ts,
        nearSigningDays: 0,
        sharedCexNames: new Set(),
      }
      candidates.set(canonical, evidence)
    }
    evidence.rawAccountIds.add(rawCandidate)
    evidence.transferCount += 1
    evidence.activeDays.add(row.ts.slice(0, 10))
    if (fromTarget) evidence.outbound += 1
    else evidence.inbound += 1
    const usd = transferUsd(row, assets, historicalPrices)
    if (usd != null) {
      evidence.pricedTransfers += 1
      evidence.totalUsd += usd
      evidence.maxSingleUsd = Math.max(evidence.maxSingleUsd, usd)
    }
    if (parseTimestamp(row.ts) > parseTimestamp(evidence.lastSeen)) evidence.lastSeen = row.ts
  }

  let eligible = [...candidates.values()].filter(c => qualifiesAffinityCandidate({
    transferCount: c.transferCount,
    activeDays: c.activeDays.size,
    totalUsd: c.totalUsd,
    maxSingleUsd: c.maxSingleUsd,
    pricedTransfers: c.pricedTransfers,
  }))
  eligible.sort((a, b) => affinityScore({
    transferCount: b.transferCount,
    activeDays: b.activeDays.size,
    totalUsd: b.totalUsd,
    bidirectional: b.outbound > 0 && b.inbound > 0,
    nearSigningDays: 0,
    sharedCex: false,
    daysSinceLast: daysSince(b.lastSeen),
  }) - affinityScore({
    transferCount: a.transferCount,
    activeDays: a.activeDays.size,
    totalUsd: a.totalUsd,
    bidirectional: a.outbound > 0 && a.inbound > 0,
    nearSigningDays: 0,
    sharedCex: false,
    daysSinceLast: daysSince(a.lastSeen),
  }))
  eligible = eligible.slice(0, MAX_CANDIDATES)
  if (!eligible.length) return emptyResponse()

  // Timing/CEX signals are auxiliary confirmations: over the unlimited window
  // their scans can hit the 5s cap onvery busy accounts — degrade to "no signal"
  // instead of failing the whole lookup.
  const signedRows = await loadSignedBlocks(targetAccounts, eligible).catch(() => [] as SignedBlockRow[])
  const targetBlocks = [
    ...signedRows.filter(r => targetSet.has(r.actor)).map(r => Number(r.block_height)),
    ...targetDirectBlocks,
  ]
  for (const evidence of eligible) {
    const candidateRows = signedRows
      .filter(r => evidence.rawAccountIds.has(r.actor))
      .map(r => ({ blockHeight: Number(r.block_height), day: r.day }))
    evidence.nearSigningDays = nearSigningDays(targetBlocks, candidateRows)
  }

  if (targetCex.size) {
    const candidateAccounts = normalizedAccounts(eligible.flatMap(c => [...c.rawAccountIds]))
    const interactions = await loadCexInteractions(candidateAccounts, [...targetCex]).catch(() => [] as CexInteractionRow[])
    for (const row of interactions) {
      if (!isSelectiveCexEndpoint(Number(row.endpoint_users))) continue
      const name = cex.get(row.cex_acc)
      if (!name) continue
      for (const evidence of eligible) {
        if (evidence.rawAccountIds.has(row.user_acc)) evidence.sharedCexNames.add(name)
      }
    }
  }

  const accounts: CloseAccount[] = []
  for (const evidence of eligible) {
    const score = affinityScore({
      transferCount: evidence.transferCount,
      activeDays: evidence.activeDays.size,
      totalUsd: evidence.totalUsd,
      bidirectional: evidence.outbound > 0 && evidence.inbound > 0,
      nearSigningDays: evidence.nearSigningDays,
      sharedCex: evidence.sharedCexNames.size > 0,
      daysSinceLast: daysSince(evidence.lastSeen),
    })
    if (score < 45) continue
    const reasons: CloseAccountReason[] = [{
      type: 'direct_transfers',
      count: evidence.transferCount,
      days: evidence.activeDays.size,
      valueUsd: evidence.pricedTransfers ? Math.round(evidence.totalUsd * 100) / 100 : null,
      bidirectional: evidence.outbound > 0 && evidence.inbound > 0,
    }]
    if (evidence.nearSigningDays >= 2) reasons.push({ type: 'near_signing', days: evidence.nearSigningDays })
    for (const name of evidence.sharedCexNames) reasons.push({ type: 'shared_cex', name })
    accounts.push({
      account: evidence.account,
      score,
      confidence: score >= 70 ? 'strong' : 'moderate',
      lastSeen: evidence.lastSeen,
      reasons,
    })
  }
  accounts.sort((a, b) => b.score - a.score || parseTimestamp(b.lastSeen) - parseTimestamp(a.lastSeen))
  return { accounts, lookbackDays: null, disclaimer: DISCLAIMER }
}

export async function getCloseAccounts(addressInput: string): Promise<CloseAccountsResponse | null> {
  const inputKey = addressInput.trim().toLowerCase()
  return cached(`explorer:close-accounts:input:${inputKey}`, CACHE_TTL_MS, () => withComputationSlot(async () => {
    const resolved = await resolveRelatedAccounts(addressInput)
    if (!resolved) return null
    const canonicalKey = resolved.norm.accountId.toLowerCase()
    return cached(`explorer:close-accounts:account:${canonicalKey}`, CACHE_TTL_MS,
      () => computeCloseAccounts(resolved.related))
  }))
}

// Tag-scoped variant: the whole member set is the target, so signals are
// aggregated across the group and the members themselves (plus any other
// tagged account) never appear as matches — same exclusions as per-address.
export async function getCloseAccountsForTag(tagId: string): Promise<CloseAccountsResponse | null> {
  const tag = getTag(tagId.trim().toLowerCase())
  if (!tag || !tag.members.length) return null
  return cached(`explorer:close-accounts:tag:${tag.tagId}`, CACHE_TTL_MS, () => withComputationSlot(
    () => computeCloseAccounts(tag.members, { taggedTargets: true })))
}
