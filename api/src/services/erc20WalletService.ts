import type { ClickHouseClient } from '../db/client.ts'
import { SUBSTRATE_RPC_URL } from './substrateRpc.ts'
import { loadPinnedSubstrateBlock, withEthBlockHash } from './pinnedBlock.ts'
import { reservedH160AccountId } from './addressIdentity.ts'
import { erc20Precompile } from './chainPrimitives.ts'

// ERC-20-backed wallet assets: registry assets whose balances live (partly) in
// EVM contract storage rather than the Tokens pallet, so the indexed balance
// observations never see them. This service keeps a small ClickHouse table
// (`erc20_wallet_balances`) current so SQL consumers — the accounts list, the
// holders list, asset totals, and account pages can price them like any other balance.
//
// An `Erc20`-kind registry asset (`AssetType::Erc20`, bound to a contract through
// its `AccountKey20` location) never touches orml_tokens: pallet_currencies routes
// its transfers straight at the contract, so `account_asset_latest_balances` reads
// every holder as zero. A money-market underlying in the set (uBIL under the BIL
// market's aToken) shows the aToken contract as a holder of its custody, exactly as
// a Tokens-side reserve (DOT under aDOT) does: that row is the contract's own
// balance, while the aToken holders' claims are valued as the aToken — two assets,
// not one counted twice.
//
// THE SET IS DERIVED, never listed: every registry asset with a local contract
// (`assets.evm_address`, which the registry tracker sets for exactly the `Erc20`
// assets whose location is a local AccountKey20) that is not a money-market aToken.
// aTokens (GIGAHDX included — its staked HDX stays in the holder's wallet) are
// reconstructed from `atoken_scaled_deltas` instead; one is recognised two
// independent ways — Aave's reserve map names it, or its contract emitted the
// AToken `Initialized` event, which every aToken emits once at initialisation —
// so a reserve added since the last reserve-map snapshot is still kept out.
// Each refresh re-derives the set into `erc20_wallet_contracts` (changes only);
// `erc20_transfer_deltas_mv` reads that table at insert time, and
// `syncTransferDeltas` fills what the MV could not see: a contract's transfers
// from before it entered the set (a Gamma vault takes deposits before its share is
// registered; a fresh database ingests raw before the set exists). Registering
// another contract-backed asset therefore needs no code or schema change.
export interface Erc20WalletAsset { assetId: number; contract: string }

export const ATOKEN_INITIALIZED_TOPIC = '0xb19e051f8af41150ccccb3fc2c2d8d15f4a4cf434f32a559ba75fe73d6eea20b'
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// The registry side of the rule, in one read. The Initialized probe reads only the
// contracts not already in the set (none, in a steady state — 9 ms, 338 rows): a
// contract that was not an aToken when it entered stays one that is not, and the
// reserve-map exclusion is applied to every contract on every cycle. Probing every
// candidate instead read HOLLAR's 5.5M log rows plus every aToken's — 28M rows /
// 1.8 GiB per cycle — to re-learn the same answer.
export const DESIRED_WALLET_CONTRACTS_SQL = `-- erc20:wallet-contracts:desired
WITH candidates AS (
  SELECT asset_id, lower(evm_address) AS contract FROM price_data.assets FINAL
  WHERE evm_address != '' AND lower(evm_address) NOT IN (SELECT lower(atoken) FROM price_data.atoken_reserve_map)
), listed AS (
  SELECT contract FROM price_data.erc20_wallet_contracts FINAL WHERE active = 1
)
SELECT asset_id, contract FROM candidates
WHERE contract IN (SELECT contract FROM listed)
   OR contract NOT IN (
     SELECT contract_address FROM price_data.evm_logs_by_contract
     WHERE topic0 = '${ATOKEN_INITIALIZED_TOPIC}'
       AND contract_address IN (SELECT contract FROM candidates WHERE contract NOT IN (SELECT contract FROM listed)))
ORDER BY asset_id`

// Without a reserve map the rule above would only have the Initialized probe to keep
// aTokens out, and on a database whose raw has not reached an aToken's
// initialisation block it would sweep the aToken in — its Transfer history into the
// deltas and a balanceOf pot beside its money-market supply. No map, no change.
export const RESERVE_MAP_SIZE_SQL = `-- erc20:wallet-contracts:reserve-map
SELECT count() AS n FROM price_data.atoken_reserve_map`

export const WALLET_CONTRACTS_SQL = `-- erc20:wallet-contracts:current
SELECT contract, asset_id, active FROM price_data.erc20_wallet_contracts FINAL`

// The rows that move `current` to `desired`: a new or re-pointed contract goes
// active, a contract that left the set goes inactive (never deleted). A contract
// named by two assets keeps the lower id — deterministic, and reported.
export function walletContractChanges(
  desired: { asset_id: number | string; contract: string }[],
  current: { contract: string; asset_id: number | string; active: number | string }[],
): { contract: string; asset_id: number; active: number }[] {
  const want = new Map<string, number>()
  for (const d of desired) {
    const contract = d.contract.toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(contract)) continue
    const id = Number(d.asset_id)
    const prev = want.get(contract)
    if (prev != null && prev !== id) console.warn(`[erc20-wallet] contract ${contract} is registered by assets ${prev} and ${id}; keeping ${Math.min(prev, id)}`)
    want.set(contract, prev == null ? id : Math.min(prev, id))
  }
  const have = new Map(current.map(c => [c.contract.toLowerCase(), { assetId: Number(c.asset_id), active: Number(c.active) === 1 }]))
  const out: { contract: string; asset_id: number; active: number }[] = []
  for (const [contract, asset_id] of want) {
    const h = have.get(contract)
    if (!h || !h.active || h.assetId !== asset_id) out.push({ contract, asset_id, active: 1 })
  }
  for (const [contract, h] of have) {
    if (h.active && !want.has(contract)) out.push({ contract, asset_id: h.assetId, active: 0 })
  }
  return out
}

// The MV's projection and row filter, shared verbatim with the catch-up insert so
// the two can never decode a Transfer differently (api/tests/erc20WalletAssets.test.ts
// pins the MV in 003_materialized_views.sql to exactly these strings).
export const TRANSFER_DELTAS_PROJECTION = "WITH decoded_args_json AS ar, [lower(JSONExtractString(ar, 'to')), lower(JSONExtractString(ar, 'from'))] AS holders, [toInt256OrZero(JSONExtractString(ar, 'value')), -toInt256OrZero(JSONExtractString(ar, 'value'))] AS deltas, arrayJoin(arrayZip(holders, deltas, arrayEnumerate(holders))) AS leg SELECT lower(contract_address) AS contract_address, tupleElement(leg, 1) AS holder, block_height, event_index, block_timestamp, toUInt8(tupleElement(leg, 3)) AS leg_index, tupleElement(leg, 2) AS balance_delta, ingested_at FROM price_data.raw_evm_logs"
export const TRANSFER_DELTAS_MV_CONTRACT_FILTER = '(lower(contract_address) IN (SELECT contract FROM price_data.erc20_wallet_contracts FINAL WHERE active = 1))'
export const TRANSFER_DELTAS_ROW_FILTER = "(event_name = 'Transfer') AND (tupleElement(leg, 1) != '')"

export const CATCHUP_BUCKET_BLOCKS = 100_000
// Bounds one refresh cycle's catch-up work; a backlog (a fresh database's HOLLAR
// history is ~60 buckets) continues on the next cycle.
export const CATCHUP_MAX_BUCKETS_PER_CYCLE = 12
// A complete set is re-verified this often (and whenever the set changes, and once
// per process): the MV keeps it complete in between, so the check exists for the
// windows it cannot see — an MV recreate, a raw range ingested before the set had
// its contract.
export const CATCHUP_RECHECK_MS = 6 * 3600_000

// Contracts (and then 100k-block buckets) whose indexed Transfer logs outnumber the
// transfers in erc20_transfer_deltas. One delta row per Transfer carries leg 1 (the
// recipient); a not-yet-merged replay duplicate can only overstate the deltas side,
// so it hides a gap until it merges, never invents one. A Transfer log the raw
// decoder left undecoded is counted on the raw side and can never be filled — its
// bucket is re-probed by every check and inserts nothing.
export const CATCHUP_TOTALS_SQL = `-- erc20:catchup:totals
SELECT r.c AS contract, r.n AS raw_n, d.n AS delta_n
FROM (SELECT contract_address AS c, count() AS n FROM price_data.evm_logs_by_contract
      WHERE contract_address IN {cs:Array(String)} AND topic0 = '${ERC20_TRANSFER_TOPIC}' GROUP BY c) AS r
LEFT JOIN (SELECT contract_address AS c, countIf(leg_index = 1) AS n FROM price_data.erc20_transfer_deltas
      WHERE contract_address IN {cs:Array(String)} GROUP BY c) AS d USING (c)
WHERE r.n > d.n`

export const CATCHUP_BUCKETS_SQL = `-- erc20:catchup:buckets
SELECT r.b AS bucket, r.n AS raw_n, d.n AS delta_n
FROM (SELECT intDiv(block_height, {size:UInt32}) AS b, count() AS n FROM price_data.evm_logs_by_contract
      WHERE contract_address = {c:String} AND topic0 = '${ERC20_TRANSFER_TOPIC}' GROUP BY b) AS r
LEFT JOIN (SELECT intDiv(block_height, {size:UInt32}) AS b, countIf(leg_index = 1) AS n FROM price_data.erc20_transfer_deltas
      WHERE contract_address = {c:String} GROUP BY b) AS d USING (b)
WHERE r.n > d.n
ORDER BY bucket`

// Inserts exactly the Transfer logs of one contract in [lo, hi] that the table does
// not hold yet: the key set comes from the contract-keyed log index (so raw is read
// by its (block_height, event_index) key, not scanned), minus every key already
// present. Only missing keys are written, so a re-run adds nothing and the
// ReplacingMergeTree never holds a backfill duplicate for its readers to see.
export const CATCHUP_INSERT_SQL = `INSERT INTO price_data.erc20_transfer_deltas ${TRANSFER_DELTAS_PROJECTION}
WHERE block_height BETWEEN {lo:UInt32} AND {hi:UInt32}
  AND (block_height, event_index) IN (
    SELECT block_height, event_index FROM price_data.evm_logs_by_contract
    WHERE contract_address = {c:String} AND topic0 = '${ERC20_TRANSFER_TOPIC}' AND block_height BETWEEN {lo:UInt32} AND {hi:UInt32})
  AND (block_height, event_index) NOT IN (
    SELECT block_height, event_index FROM price_data.erc20_transfer_deltas
    WHERE contract_address = {c:String} AND block_height BETWEEN {lo:UInt32} AND {hi:UInt32})
  AND lower(contract_address) = {c:String} AND ${TRANSFER_DELTAS_ROW_FILTER}`

// The chain-wide feed's party-transfer view (erc20_party_transfers_mv in
// 003_materialized_views.sql): its SELECT and WHERE over raw_evm_logs, shared verbatim
// with schemaBootstrap's DATA_UPGRADES backfill and with the catch-up below (the schema
// test pins the view to exactly these strings). The fixed non-parties are explorerService's
// ERC20_NON_HOLDERS and ERC20_RESERVED_HOLDER_RE, stated literally (a test pins them equal).
export const PARTY_TRANSFERS_SELECT = "lower(contract_address) AS contract_address, lower(JSONExtractString(decoded_args_json, 'from')) AS from_address, lower(JSONExtractString(decoded_args_json, 'to')) AS to_address, toUInt256OrZero(JSONExtractString(decoded_args_json, 'value')) AS amount, block_height, event_index, extrinsic_index, block_timestamp, ingested_at"
export const PARTY_TRANSFERS_WHERE = "raw_evm_logs.event_name = 'Transfer' AND lower(raw_evm_logs.contract_address) IN (SELECT arrayJoin(groupArrayIf(contract, active = 1)) FROM price_data.erc20_wallet_contracts FINAL) AND match(lower(JSONExtractString(raw_evm_logs.decoded_args_json, 'from')), '^0x[0-9a-f]{40}$') AND match(lower(JSONExtractString(raw_evm_logs.decoded_args_json, 'to')), '^0x[0-9a-f]{40}$') AND lower(JSONExtractString(raw_evm_logs.decoded_args_json, 'from')) NOT IN ('0x0000000000000000000000000000000000000000', '0xffffffffffffffffffffffffffffffffffffffff', '0x6d6f646c63757272657365720000000000000000', '0x000000000000000000000000000000000000090a') AND lower(JSONExtractString(raw_evm_logs.decoded_args_json, 'to')) NOT IN ('0x0000000000000000000000000000000000000000', '0xffffffffffffffffffffffffffffffffffffffff', '0x6d6f646c63757272657365720000000000000000', '0x000000000000000000000000000000000000090a') AND NOT match(lower(JSONExtractString(raw_evm_logs.decoded_args_json, 'from')), '^0x(6d6f646c|7369626c|70617261|506172656e74)') AND NOT match(lower(JSONExtractString(raw_evm_logs.decoded_args_json, 'to')), '^0x(6d6f646c|7369626c|70617261|506172656e74)')"
// The aTokens' party-transfer view (atoken_party_transfers_mv in 003_materialized_views.sql),
// shared verbatim with schemaBootstrap's DATA_UPGRADES backfill like the pair above:
// BalanceTransfer under the same fixed non-parties, amount = rayMul(value, index) half-up.
export const ATOKEN_PARTY_TRANSFERS_SELECT = "lower(contract_address) AS contract_address, lower(JSONExtractString(decoded_args_json, 'from')) AS from_address, lower(JSONExtractString(decoded_args_json, 'to')) AS to_address, toUInt256OrZero(JSONExtractString(decoded_args_json, 'value')) AS scaled_amount, toUInt256OrZero(JSONExtractString(decoded_args_json, 'index')) AS liquidity_index, intDiv((toUInt256OrZero(JSONExtractString(decoded_args_json, 'value')) * toUInt256OrZero(JSONExtractString(decoded_args_json, 'index'))) + toUInt256('500000000000000000000000000'), toUInt256('1000000000000000000000000000')) AS amount, block_height, event_index, extrinsic_index, block_timestamp, ingested_at"
export const ATOKEN_PARTY_TRANSFERS_WHERE = "raw_evm_logs.event_name = 'BalanceTransfer' AND match(lower(JSONExtractString(raw_evm_logs.decoded_args_json, 'from')), '^0x[0-9a-f]{40}$') AND match(lower(JSONExtractString(raw_evm_logs.decoded_args_json, 'to')), '^0x[0-9a-f]{40}$') AND lower(JSONExtractString(raw_evm_logs.decoded_args_json, 'from')) NOT IN ('0x0000000000000000000000000000000000000000', '0xffffffffffffffffffffffffffffffffffffffff', '0x6d6f646c63757272657365720000000000000000', '0x000000000000000000000000000000000000090a') AND lower(JSONExtractString(raw_evm_logs.decoded_args_json, 'to')) NOT IN ('0x0000000000000000000000000000000000000000', '0xffffffffffffffffffffffffffffffffffffffff', '0x6d6f646c63757272657365720000000000000000', '0x000000000000000000000000000000000000090a') AND NOT match(lower(JSONExtractString(raw_evm_logs.decoded_args_json, 'from')), '^0x(6d6f646c|7369626c|70617261|506172656e74)') AND NOT match(lower(JSONExtractString(raw_evm_logs.decoded_args_json, 'to')), '^0x(6d6f646c|7369626c|70617261|506172656e74)')"
// The party transfers' catch-up: the same contract's missing keys in [lo, hi] under the
// view's own WHERE, so a contract that joined the set late reaches the chain-wide feed's
// table exactly as it reaches the deltas (the deltas' catch-up keys the same window).
export const CATCHUP_INSERT_PARTY_TRANSFERS_SQL = `INSERT INTO price_data.erc20_party_transfers
SELECT ${PARTY_TRANSFERS_SELECT} FROM price_data.raw_evm_logs
WHERE block_height BETWEEN {lo:UInt32} AND {hi:UInt32}
  AND (block_height, event_index) IN (
    SELECT block_height, event_index FROM price_data.evm_logs_by_contract
    WHERE contract_address = {c:String} AND topic0 = '${ERC20_TRANSFER_TOPIC}' AND block_height BETWEEN {lo:UInt32} AND {hi:UInt32})
  AND (block_height, event_index) NOT IN (
    SELECT block_height, event_index FROM price_data.erc20_party_transfers
    WHERE block_height BETWEEN {lo:UInt32} AND {hi:UInt32} AND contract_address = {c:String})
  AND lower(contract_address) = {c:String} AND ${PARTY_TRANSFERS_WHERE}`

// Inserts one contract's missing Transfer logs in [lo, hi] (CATCHUP_INSERT_SQL: only
// keys the table lacks, so a re-run writes nothing), into the deltas and the chain-wide
// feed's party transfers alike. The one write path of both the refresher's whole-history
// catch-up and an MV swap's window catch-up.
async function insertMissingTransferDeltas(c: ClickHouseClient, p: { contract: string; lo: number; hi: number }, why: string): Promise<void> {
  const before = Date.now()
  for (const query of [CATCHUP_INSERT_SQL, CATCHUP_INSERT_PARTY_TRANSFERS_SQL]) {
    await c.command({
      query,
      query_params: { c: p.contract, lo: p.lo, hi: p.hi },
      clickhouse_settings: { max_threads: 4 },
    })
  }
  console.log(`[erc20-wallet] transfer-deltas ${why} ${p.contract} blocks ${p.lo}-${p.hi} in ${Date.now() - before} ms`)
}

// How far either side of a swap window the window catch-up reaches, in server-clock
// seconds: ingested_at is the raw row's insert time (DEFAULT now()), and an async
// insert can flush a little after the statement that queued it.
export const CATCHUP_WINDOW_MARGIN_SECONDS = 300

// The 100k-block buckets holding a contract's Transfer logs INSERTED (ingested_at, not
// block time — a backfill inserts old blocks) inside a window. The contract-keyed log
// index carries ingested_at, so this reads the set's own rows (~8M rows, ~15 ms), never
// raw. A row replayed after the window carries a later ingested_at, but its replay
// fired the view again, so it never needed the window.
export const CATCHUP_WINDOW_BUCKETS_SQL = `-- erc20:catchup:window-buckets
SELECT contract_address AS contract, intDiv(block_height, {size:UInt32}) AS bucket
FROM price_data.evm_logs_by_contract
WHERE contract_address IN {cs:Array(String)} AND topic0 = '${ERC20_TRANSFER_TOPIC}'
  AND ingested_at BETWEEN {from:DateTime} - INTERVAL {margin:UInt32} SECOND AND {to:DateTime} + INTERVAL {margin:UInt32} SECOND
GROUP BY contract, bucket
ORDER BY contract, bucket`

/**
 * The catch-up of an erc20_transfer_deltas_mv swap (schemaBootstrap MV_UPGRADES): the
 * Transfer logs of the active wallet-contract set inserted while the view was being
 * replaced — server clock [from − margin, to + margin] — reached no view, so every
 * bucket holding one is filled with exactly its missing keys, by the same insert the
 * refresher's whole-history catch-up runs. Idempotent: a re-run over the same window
 * inserts nothing. Every bucket is filled (no per-cycle cap): the window is minutes.
 */
export async function catchUpTransferDeltasWindow(
  c: ClickHouseClient,
  window: { from: string; to: string },
  marginSeconds = CATCHUP_WINDOW_MARGIN_SECONDS,
): Promise<string> {
  const setRes = await c.query({ query: WALLET_CONTRACTS_SQL, format: 'JSONEachRow' })
  const contracts = (await setRes.json<{ contract: string; active: number | string }>())
    .filter(r => Number(r.active) === 1 && /^0x[0-9a-f]{40}$/.test(r.contract)).map(r => r.contract)
  if (!contracts.length) return `no active wallet contracts; nothing to fill for ${window.from}..${window.to}`
  const bucketRes = await c.query({
    query: CATCHUP_WINDOW_BUCKETS_SQL,
    query_params: { cs: contracts, size: CATCHUP_BUCKET_BLOCKS, from: window.from, to: window.to, margin: marginSeconds },
    format: 'JSONEachRow',
  })
  const plan = (await bucketRes.json<{ contract: string; bucket: number | string }>()).map(r => ({
    contract: r.contract, lo: Number(r.bucket) * CATCHUP_BUCKET_BLOCKS, hi: Number(r.bucket) * CATCHUP_BUCKET_BLOCKS + CATCHUP_BUCKET_BLOCKS - 1,
  }))
  for (const p of plan) await insertMissingTransferDeltas(c, p, `swap-window catch-up (${window.from}..${window.to} ±${marginSeconds}s)`)
  return `${plan.length} bucket(s) of ${contracts.length} contract(s) filled with their missing keys for rows ingested ${window.from}..${window.to} ±${marginSeconds}s`
}

// The buckets one cycle fills, oldest first, under the per-cycle cap.
export function catchUpPlan(
  gaps: { contract: string; buckets: number[] }[],
  maxBuckets = CATCHUP_MAX_BUCKETS_PER_CYCLE,
  size = CATCHUP_BUCKET_BLOCKS,
): { plan: { contract: string; lo: number; hi: number }[]; truncated: boolean } {
  const all = gaps.flatMap(g => g.buckets.map(b => ({ contract: g.contract, lo: b * size, hi: b * size + size - 1 })))
  return { plan: all.slice(0, maxBuckets), truncated: all.length > maxBuckets }
}

// The contracts with a gap bucket the plan does not reach this cycle.
export function unfilledContracts(gaps: { contract: string; buckets: number[] }[], plan: { contract: string; lo: number }[], size = CATCHUP_BUCKET_BLOCKS): string[] {
  const planned = new Set(plan.map(p => `${p.contract}:${p.lo}`))
  return gaps.filter(g => g.buckets.some(b => !planned.has(`${g.contract}:${b * size}`))).map(g => g.contract)
}

let walletAssets: Erc20WalletAsset[] | null = null
let walletAssetsAt = 0
let walletAssetsInflight: Promise<Erc20WalletAsset[]> | null = null
const WALLET_ASSETS_TTL_MS = 60_000

async function loadWalletAssets(): Promise<Erc20WalletAsset[]> {
  const res = await client.query({ query: WALLET_CONTRACTS_SQL, format: 'JSONEachRow' })
  const rows = await res.json<{ contract: string; asset_id: number | string; active: number | string }>()
  const list = rows
    .filter(r => Number(r.active) === 1 && /^0x[0-9a-f]{40}$/.test(r.contract))
    .map(r => ({ assetId: Number(r.asset_id), contract: r.contract }))
    .sort((a, b) => a.assetId - b.assetId)
  walletAssets = list
  walletAssetsAt = Date.now()
  return list
}

// The current set, as erc20_wallet_contracts holds it (a minute-fresh in-memory
// copy). A failed reload serves the last list it read; with none read yet the
// error propagates, so a caller never mistakes "not loaded" for "no such assets".
export function ensureErc20WalletAssets(): Promise<Erc20WalletAsset[]> {
  if (walletAssets && Date.now() - walletAssetsAt < WALLET_ASSETS_TTL_MS) return Promise.resolve(walletAssets)
  if (!walletAssetsInflight) {
    walletAssetsInflight = loadWalletAssets()
      .catch(err => { if (walletAssets) return walletAssets; throw err })
      .finally(() => { walletAssetsInflight = null })
  }
  return walletAssetsInflight
}

// Re-derive the set and write what changed. Returns the active list afterwards.
export async function syncWalletContracts(): Promise<Erc20WalletAsset[]> {
  const mapRes = await client.query({ query: RESERVE_MAP_SIZE_SQL, format: 'JSONEachRow' })
  const [{ n } = { n: 0 }] = await mapRes.json<{ n: number | string }>()
  const [desiredRes, currentRes] = await Promise.all([
    client.query({ query: DESIRED_WALLET_CONTRACTS_SQL, format: 'JSONEachRow' }),
    client.query({ query: WALLET_CONTRACTS_SQL, format: 'JSONEachRow' }),
  ])
  const desired = await desiredRes.json<{ asset_id: number | string; contract: string }>()
  const current = await currentRes.json<{ contract: string; asset_id: number | string; active: number | string }>()
  if (Number(n) === 0 || desired.length === 0) {
    console.warn(`[erc20-wallet] wallet-contract set not re-derived (reserve map rows: ${n}, candidates: ${desired.length}); keeping ${current.length} rows`)
  } else {
    const changes = walletContractChanges(desired, current)
    if (changes.length) {
      await client.insert({ table: 'price_data.erc20_wallet_contracts', values: changes, format: 'JSONEachRow' })
      console.log(`[erc20-wallet] wallet-contract set changed: ${changes.map(c => `${c.asset_id}=${c.contract}${c.active ? '' : ' (inactive)'}`).join(', ')}`)
    }
  }
  return loadWalletAssets()
}

let catchUpCheckedAt = 0
let catchUpSetKey = ''
let catchUpPending = false
// Contracts the last catch-up check left with gap buckets it did not reach (the
// per-cycle cap): their deltas are known incomplete, so their balances are not
// republished from them until a later cycle has filled the rest.
let unfilledGapContracts = new Set<string>()

// Fill erc20_transfer_deltas wherever the indexed logs show Transfers it lacks.
export async function syncTransferDeltas(assets: Erc20WalletAsset[]): Promise<void> {
  const setKey = assets.map(a => a.contract).sort().join(',')
  if (!assets.length) return
  if (!catchUpPending && setKey === catchUpSetKey && Date.now() - catchUpCheckedAt < CATCHUP_RECHECK_MS) return
  const totalsRes = await client.query({
    query: CATCHUP_TOTALS_SQL, query_params: { cs: assets.map(a => a.contract) }, format: 'JSONEachRow',
  })
  const short = await totalsRes.json<{ contract: string; raw_n: string | number; delta_n: string | number }>()
  const gaps: { contract: string; buckets: number[] }[] = []
  for (const s of short) {
    const bucketRes = await client.query({
      query: CATCHUP_BUCKETS_SQL, query_params: { c: s.contract, size: CATCHUP_BUCKET_BLOCKS }, format: 'JSONEachRow',
    })
    gaps.push({ contract: s.contract, buckets: (await bucketRes.json<{ bucket: number | string }>()).map(r => Number(r.bucket)) })
  }
  const { plan, truncated } = catchUpPlan(gaps)
  unfilledGapContracts = new Set(unfilledContracts(gaps, plan))
  for (const p of plan) await insertMissingTransferDeltas(client, p, 'catch-up')
  catchUpPending = truncated
  catchUpSetKey = setKey
  catchUpCheckedAt = Date.now()
}

const ERC20_BALANCE_OF = '70a08231' // keccak256("balanceOf(address)")[:4]
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

let client: ClickHouseClient

// Balances for the addresses the node actually answered for, every call at the
// pinned block `at` (EIP-1898 `{ blockHash }`). A dropped batch or an unparseable
// item leaves its addresses out of the map — the caller must treat them as
// unknown, never as zero.
async function ethCallBalances(assetId: number, h160s: string[], at: { blockHash: string }): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  const to = erc20Precompile(assetId)
  for (let start = 0; start < h160s.length; start += 80) {
    const chunk = h160s.slice(start, start + 80)
    const calls = chunk.map((h, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data: `0x${ERC20_BALANCE_OF}${'0'.repeat(24)}${h.slice(2).toLowerCase()}` }, at] }))
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      const res = await fetch(SUBSTRATE_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal, body: JSON.stringify(calls) })
      if (!res.ok) continue
      const json = await res.json() as unknown
      for (const item of Array.isArray(json) ? json : []) {
        if (!item || typeof item !== 'object') continue
        const { id, result } = item as { id?: unknown; result?: unknown }
        if (!Number.isInteger(id) || (id as number) < 0 || (id as number) >= chunk.length) continue
        if (typeof result !== 'string' || !/^0x[0-9a-f]+$/i.test(result)) continue
        out.set(chunk[id as number], BigInt(result))
      }
    } catch { /* chunk skipped; counted unread by the audit */ } finally { clearTimeout(timer) }
  }
  return out
}

// Rows for one publication. A holder missing from `balances` is unknown, not
// zero — so it gets no row and keeps its last published one. Every holder's
// anchor still counts as current, so the stale-key pass only zeroes keys that no
// longer belong to any holder. (The delta producer states every holder, so its
// publications are always whole; the partial-read rule is kept for any caller
// that is not.)
export function walletBalanceRows(
  assetId: number,
  h160s: string[],
  balances: Map<string, bigint>,
  anchorOf: (h160: string) => string,
  previousNonZeroAccounts: string[],
): { account_id: string; asset_id: string; total: string }[] {
  const asset_id = String(assetId)
  // Folded by ANCHOR, not emitted per H160: several EVM addresses can resolve
  // through account_alias_directory onto one substrate account, and
  // erc20_wallet_balances replaces on (asset_id, account_id) with an `updated_at`
  // DEFAULT those rows would SHARE — so two rows under one key keep whichever
  // the merge picks and silently drop the other balance. Summing first makes the
  // emitted set key-unique by construction.
  // An anchor is published only when EVERY H160 folding into it was read: a sum
  // over the ones that answered would shrink a shared anchor's balance by its
  // unread members, so a partly read anchor keeps its previous row.
  const totals = new Map<string, bigint>()
  const unread = new Set<string>()
  for (const h of h160s) {
    const account_id = anchorOf(h)
    const balance = balances.get(h)
    if (balance == null) { unread.add(account_id); continue }
    totals.set(account_id, (totals.get(account_id) ?? 0n) + balance)
  }
  const rows = [...totals].filter(([account_id]) => !unread.has(account_id)).map(([account_id, total]) => ({ account_id, asset_id, total: total.toString() }))
  const current = new Set(h160s.map(anchorOf))
  for (const account_id of previousNonZeroAccounts) {
    if (!current.has(account_id)) rows.push({ account_id, asset_id, total: '0' })
  }
  return rows
}

// Every balance-holding substrate account whose first 20 bytes are one of the
// `{evms:Array(String)}` H160s (each a validated `0x` + 40 lower-case hex digits).
// A truncated substrate account IS its H160 followed by 12 more bytes; account ids
// are stored as lower-case 66-character hex (normalizeAccountId in the raw
// indexer), so its first 42 characters are exactly the H160. One hash-set `IN`
// per row reads the table's ~730k keys in ~15 ms. Per-candidate sort-key ranges
// are the wrong shape here: the ~1.4k candidates land in most of the table's
// granules, so they prune nothing, and their OR of ~2.9k string comparisons is an
// expression ClickHouse JIT-compiles — up to 89 s under the server's global
// compiler lock, stalling every other query that compiles an expression
// meanwhile. The ETH-prefixed EVM form is excluded — it is the fallback anchor,
// not a substrate account.
export const TRUNCATED_SUBSTRATE_ACCOUNTS_SQL = `SELECT DISTINCT concat('0x', substring(b.account_id, 3, 40)) AS evm, b.account_id AS account_id
                FROM price_data.account_asset_latest_balances AS b
                WHERE length(b.account_id) = 66
                  AND substring(b.account_id, 1, 42) IN {evms:Array(String)}
                  AND substring(b.account_id, 3, 8) != '45544800'`

// ── balances from the transfer deltas ─────────────────────────────────────────
//
// A contract-backed balance IS the sum of its holder's Transfer legs: every mint,
// burn and move of these contracts emits a Transfer, and erc20_transfer_deltas
// holds one signed leg per side of each (verified 2026-10-10: equal to balanceOf
// for every holder of all 7 contracts). So the producer sums the deltas (FINAL — a
// replayed log is one row, never two, and a duplicate shares its block's month
// partition, so FINAL is exact under do_not_merge_across_partitions_select_final),
// at or below the cycle's pinned block, instead of one eth_call per holder.
// NOT an additive MV: a replayed raw range would be summed twice.
//
// A contract is recomputed only when its delta WATERMARK moves — its row count,
// newest ingest and newest block at or below the pin. The count is what catches a
// catch-up insert (the refresher's own, or an MV swap's `catchUpTransferDeltasWindow`):
// it carries raw's original `ingested_at`, so max(ingested_at) may stand still,
// but the row count cannot. A merge that drops a replay duplicate moves the count
// too, which costs one harmless recompute. The anchors are re-read every cycle
// (cheap, one pair of reads for every holder at once), so an alias linked since
// the last publication re-keys the balance on the next cycle, transfers or not.
//
// eth_call stays as an hourly AUDIT: every holder's balanceOf at the pinned block,
// compared with the delta sum at that same block; a mismatch is logged and counted
// (`erc20BalanceAuditStats`), never published.

export const DELTA_WATERMARKS_SQL = `-- erc20:balances:watermarks
SELECT contract_address AS contract, count() AS n, toString(max(ingested_at)) AS ingested, max(block_height) AS top
FROM price_data.erc20_transfer_deltas
WHERE contract_address IN {cs:Array(String)} AND block_height <= {b:UInt32}
GROUP BY contract`

export const DELTA_BALANCES_SQL = `-- erc20:balances:sum
SELECT contract_address AS contract, holder, toString(sum(balance_delta)) AS balance
FROM price_data.erc20_transfer_deltas FINAL
WHERE contract_address IN {cs:Array(String)} AND block_height <= {b:UInt32}
  AND holder != '${ZERO_ADDRESS}'
GROUP BY contract, holder`

export const ALIAS_ANCHORS_SQL = `SELECT DISTINCT evm_address AS evm, account_id FROM price_data.account_alias_directory
                WHERE evm_address IN ({evms:Array(String)}) AND account_id != ''`

export const ERC20_AUDIT_INTERVAL_MS = 3600_000

export function deltaWatermarkKey(r: { n: number | string; ingested: string; top: number | string }): string {
  return `${Number(r.n)}|${r.ingested}|${Number(r.top)}`
}

/**
 * Per contract, each holder's balance from its delta-sum rows. A negative sum is a
 * holder whose received legs are missing — the contract's deltas are incomplete,
 * so it is reported (and the contract not published) rather than clamped.
 */
export function balancesFromDeltaRows(rows: ReadonlyArray<{ contract: string; holder: string; balance: string }>): {
  balances: Map<string, Map<string, bigint>>
  negative: Map<string, string[]>
} {
  const balances = new Map<string, Map<string, bigint>>()
  const negative = new Map<string, string[]>()
  for (const r of rows) {
    const contract = r.contract.toLowerCase()
    const holder = r.holder.toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(holder) || holder === ZERO_ADDRESS) continue
    const v = BigInt(r.balance)
    if (v < 0n) negative.set(contract, [...(negative.get(contract) ?? []), holder])
    let m = balances.get(contract)
    if (!m) balances.set(contract, (m = new Map()))
    m.set(holder, v)
  }
  return { balances, negative }
}

/** The anchor of an H160: a module/sovereign truncation, else an alias/truncation anchor, else the ETH-prefixed form. */
export function makeAnchorOf(anchor: ReadonlyMap<string, string>): (h: string) => string {
  return (h: string) => reservedH160AccountId(h.slice(2)) ?? anchor.get(h) ?? `0x45544800${h.slice(2)}0000000000000000`
}

/** One contract's holder → anchor map as a stable string, so a re-keyed holder is noticed. */
export function anchorFingerprint(h160s: readonly string[], anchorOf: (h: string) => string): string {
  return [...h160s].sort().map(h => `${h}=${anchorOf(h)}`).join(',')
}

export interface AuditMismatch { holder: string; deltas: string; chain: string }
/** Every holder the chain answered for whose balanceOf differs from its delta sum. */
export function auditMismatches(deltas: ReadonlyMap<string, bigint>, chain: ReadonlyMap<string, bigint>): { checked: number; unread: number; mismatches: AuditMismatch[] } {
  let checked = 0
  let unread = 0
  const mismatches: AuditMismatch[] = []
  for (const [holder, d] of deltas) {
    const c = chain.get(holder)
    if (c == null) { unread++; continue }
    checked++
    if (c !== d) mismatches.push({ holder, deltas: d.toString(), chain: c.toString() })
  }
  return { checked, unread, mismatches }
}

interface PublishedContract { watermark: string; anchors: string; block: number; balances: Map<string, bigint> }
const published = new Map<string, PublishedContract>()
let lastAuditAt = 0

export interface Erc20BalanceAuditStats {
  runs: number
  lastAt: string | null
  lastBlock: number
  lastChecked: number
  lastUnread: number
  lastMismatches: number
  /** Mismatching (contract, holder) pairs summed over every audit since the process started. */
  totalMismatches: number
}
const auditStats: Erc20BalanceAuditStats = { runs: 0, lastAt: null, lastBlock: 0, lastChecked: 0, lastUnread: 0, lastMismatches: 0, totalMismatches: 0 }
export function erc20BalanceAuditStats(): Erc20BalanceAuditStats { return { ...auditStats } }

async function json<T>(query: string, query_params: Record<string, unknown>): Promise<T[]> {
  const res = await client.query({ query, query_params, format: 'JSONEachRow' })
  return res.json<T>()
}

async function loadDeltaBalances(contracts: string[], block: number) {
  return balancesFromDeltaRows(await json<{ contract: string; holder: string; balance: string }>(DELTA_BALANCES_SQL, { cs: contracts, b: block }))
}

// Prefer the full substrate account so the balance lands on the profile the rest
// of the explorer groups by: (1) an alias-linked substrate account, (2) a known
// balance-holding substrate account whose truncated first 20 bytes ARE the H160
// (aliases only exist once substrate-side activity was observed), (3) the
// ETH-prefixed AccountId32 form (genuine EVM accounts).
async function loadAnchors(h160s: string[]): Promise<Map<string, string>> {
  const anchor = new Map<string, string>()
  if (!h160s.length) return anchor
  // account_alias_directory holds one row per distinct alias identity, not
  // raw_account_aliases' one row per observation.
  const [alias, trunc] = await Promise.all([
    json<{ evm: string; account_id: string }>(ALIAS_ANCHORS_SQL, { evms: h160s }),
    json<{ evm: string; account_id: string }>(TRUNCATED_SUBSTRATE_ACCOUNTS_SQL, { evms: h160s }),
  ])
  for (const r of trunc) anchor.set(r.evm, r.account_id)
  for (const r of alias) {
    const isEthPrefixed = r.account_id.startsWith('0x45544800') && r.account_id.endsWith('0000000000000000')
    if (!isEthPrefixed) anchor.set(r.evm, r.account_id.toLowerCase())
  }
  return anchor
}

async function publishContract(a: Erc20WalletAsset, balances: Map<string, bigint>, anchorOf: (h: string) => string): Promise<void> {
  // Zero keys that no longer belong to the current account anchor so stale rows
  // cannot double count a wallet balance.
  const previous = (await json<{ account_id: string }>(
    `SELECT account_id FROM price_data.erc20_wallet_balances WHERE asset_id = {a:String}
     GROUP BY account_id HAVING toUInt256OrZero(argMax(total, updated_at)) > 0`, { a: String(a.assetId) },
  )).map(r => r.account_id)
  const rows = walletBalanceRows(a.assetId, [...balances.keys()], balances, anchorOf, previous)
  if (rows.length) await client.insert({ table: 'price_data.erc20_wallet_balances', values: rows, format: 'JSONEachRow' })
}

/**
 * One cycle of the delta producer at `pin.block`. Returns the contracts it
 * (re)published. A contract whose deltas are known short (an unreached catch-up
 * gap) or whose sums go negative keeps its previous rows; an asset with no
 * deltas yet yields no holders and keeps whatever rows it already has.
 */
export async function publishDeltaBalances(assets: Erc20WalletAsset[], pin: { block: number }): Promise<string[]> {
  if (!assets.length) return []
  const contracts = assets.map(a => a.contract)
  const marks = new Map((await json<{ contract: string; n: number | string; ingested: string; top: number | string }>(
    DELTA_WATERMARKS_SQL, { cs: contracts, b: pin.block },
  )).map(r => [r.contract.toLowerCase(), deltaWatermarkKey(r)]))
  const moved = contracts.filter(c => marks.has(c) && published.get(c)?.watermark !== marks.get(c))
  const fresh = moved.length ? await loadDeltaBalances(moved, pin.block) : { balances: new Map<string, Map<string, bigint>>(), negative: new Map<string, string[]>() }
  // Current holders per contract: freshly summed where the watermark moved, the
  // last publication's otherwise.
  const holdersOf = (c: string): Map<string, bigint> | undefined => fresh.balances.get(c) ?? published.get(c)?.balances
  const allHolders = [...new Set(contracts.flatMap(c => [...(holdersOf(c)?.keys() ?? [])]))]
  const anchorOf = makeAnchorOf(await loadAnchors(allHolders))
  const out: string[] = []
  for (const a of assets) {
    const c = a.contract
    const mark = marks.get(c)
    const balances = holdersOf(c)
    if (!mark || !balances?.size) continue
    if (unfilledGapContracts.has(c)) {
      console.warn(`[erc20-wallet] asset ${a.assetId} (${c}): transfer deltas have an unfilled catch-up gap; keeping its previous balances`)
      continue
    }
    const neg = fresh.negative.get(c)
    if (neg?.length) {
      console.warn(`[erc20-wallet] asset ${a.assetId} (${c}): ${neg.length} holder(s) sum negative at block ${pin.block} (${neg.slice(0, 5).join(', ')}) — deltas incomplete; keeping its previous balances`)
      continue
    }
    const anchors = anchorFingerprint([...balances.keys()], anchorOf)
    const prev = published.get(c)
    if (prev && prev.watermark === mark && prev.anchors === anchors) continue
    await publishContract(a, balances, anchorOf)
    published.set(c, { watermark: mark, anchors, block: pin.block, balances })
    out.push(c)
  }
  if (out.length) console.log(`[erc20-wallet] balances published from transfer deltas at block ${pin.block}: ${out.map(c => assets.find(a => a.contract === c)?.assetId).join(', ')}`)
  return out
}

/**
 * The hourly audit: every holder's balanceOf at the pinned block (by its Ethereum
 * hash), against the delta sum at the same block. Logs each mismatching
 * (contract, holder) and counts them; publishes nothing.
 */
export async function auditDeltaBalances(assets: Erc20WalletAsset[], pin: { block: number; ethBlockHash: string }): Promise<Erc20BalanceAuditStats> {
  const { balances } = await loadDeltaBalances(assets.map(a => a.contract), pin.block)
  let checked = 0, unread = 0, mismatchCount = 0
  for (const a of assets) {
    const deltas = balances.get(a.contract)
    if (!deltas?.size) continue
    const chain = await ethCallBalances(a.assetId, [...deltas.keys()], { blockHash: pin.ethBlockHash })
    const r = auditMismatches(deltas, chain)
    checked += r.checked
    unread += r.unread
    mismatchCount += r.mismatches.length
    for (const m of r.mismatches.slice(0, 20)) {
      console.warn(`[erc20-wallet] AUDIT MISMATCH asset ${a.assetId} (${a.contract}) holder ${m.holder} at block ${pin.block}: deltas ${m.deltas}, balanceOf ${m.chain}`)
    }
    if (r.mismatches.length > 20) console.warn(`[erc20-wallet] AUDIT MISMATCH asset ${a.assetId}: ${r.mismatches.length - 20} more`)
  }
  auditStats.runs++
  auditStats.lastAt = new Date().toISOString()
  auditStats.lastBlock = pin.block
  auditStats.lastChecked = checked
  auditStats.lastUnread = unread
  auditStats.lastMismatches = mismatchCount
  auditStats.totalMismatches += mismatchCount
  console.log(`[erc20-wallet] balance audit at block ${pin.block}: ${checked} holder(s) checked, ${mismatchCount} mismatch(es), ${unread} unread`)
  return erc20BalanceAuditStats()
}

async function refresh(nowMs = Date.now()): Promise<void> {
  // A failed derivation keeps the last set (the table is untouched); a failed
  // catch-up is retried on the next check. Neither stops the balance refresh.
  const assets = await syncWalletContracts().catch(err => {
    console.error('[erc20-wallet] wallet-contract sync failed', err)
    return ensureErc20WalletAssets()
  })
  await syncTransferDeltas(assets).catch(err => {
    catchUpPending = true
    console.error('[erc20-wallet] transfer-deltas catch-up failed', err)
  })
  await zeroInactiveAssetBalances(assets).catch(err => console.error('[erc20-wallet] inactive-asset reconcile failed', err))
  // ONE block per cycle (pinnedBlock.ts: min(indexed head, finalized head)): the
  // deltas are summed up to it, and the audit's eth_calls name it by its hash.
  const pin = await loadPinnedSubstrateBlock(client, undefined, 'erc20:balances-pin')
  await publishDeltaBalances(assets, pin)
  // A failed audit (the node could not confirm the block's Ethereum hash, a read
  // threw) is retried on the next cycle rather than an hour later.
  if (nowMs - lastAuditAt >= ERC20_AUDIT_INTERVAL_MS) {
    await withEthBlockHash(pin)
      .then(p => auditDeltaBalances(assets, p))
      .then(() => { lastAuditAt = nowMs })
      .catch(err => console.error('[erc20-wallet] balance audit failed', err))
  }
}

/** Test seam: forget the published watermarks, the audit clock and the catch-up state. */
export function resetErc20BalanceStateForTest(): void {
  published.clear()
  lastAuditAt = 0
  unfilledGapContracts = new Set()
  catchUpCheckedAt = 0
  catchUpSetKey = ''
  catchUpPending = false
  Object.assign(auditStats, { runs: 0, lastAt: null, lastBlock: 0, lastChecked: 0, lastUnread: 0, lastMismatches: 0, totalMismatches: 0 })
}

// Balance rows of asset ids that are no longer in the active set (a contract that
// left it, or an asset re-pointed to another contract id): every reader takes
// erc20_wallet_balances as the wallet pot of a contract-backed asset, so a row the
// refresher stopped maintaining would be counted for good. Tombstoned to zero
// (rows replace on (asset_id, account_id)).
export const STALE_ASSET_BALANCES_SQL = `-- erc20:wallet-balances:stale-assets
SELECT account_id, asset_id FROM price_data.erc20_wallet_balances
WHERE asset_id NOT IN {active:Array(String)}
GROUP BY account_id, asset_id HAVING toUInt256OrZero(argMax(total, updated_at)) > 0`

export function staleAssetZeroRows(rows: ReadonlyArray<{ account_id: string; asset_id: string }>, activeIds: ReadonlySet<string>): { account_id: string; asset_id: string; total: string }[] {
  return rows.filter(r => !activeIds.has(String(r.asset_id))).map(r => ({ account_id: r.account_id, asset_id: String(r.asset_id), total: '0' }))
}

async function zeroInactiveAssetBalances(assets: Erc20WalletAsset[]): Promise<void> {
  // An empty active set is never trusted as "no assets": it zeroes nothing.
  if (!assets.length) return
  const active = new Set(assets.map(a => String(a.assetId)))
  const res = await client.query({ query: STALE_ASSET_BALANCES_SQL, query_params: { active: [...active] }, format: 'JSONEachRow' })
  const zero = staleAssetZeroRows(await res.json<{ account_id: string; asset_id: string }>(), active)
  if (!zero.length) return
  await client.insert({ table: 'price_data.erc20_wallet_balances', values: zero, format: 'JSONEachRow' })
  console.log(`[erc20-wallet] zeroed ${zero.length} balance row(s) of asset(s) no longer contract-backed: ${[...new Set(zero.map(z => z.asset_id))].join(', ')}`)
}

let refreshInflight: Promise<void> | null = null

// Cadence is owned by the coordinated background scheduler
// (backgroundRefresh.ts); this keeps only the single-flight guard.
export function refreshErc20Wallets(): Promise<void> {
  if (refreshInflight) return refreshInflight
  const request = refresh()
    .catch(err => console.error('[erc20-wallet] refresh failed', err))
    .finally(() => { if (refreshInflight === request) refreshInflight = null })
  refreshInflight = request
  return request
}

export function initErc20WalletService(c: ClickHouseClient): void {
  client = c
}
