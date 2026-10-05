import type { ClickHouseClient } from '../db/client.ts'
import { SUBSTRATE_RPC_URL } from './substrateRpc.ts'
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

// Inserts one contract's missing Transfer legs in [lo, hi] (CATCHUP_INSERT_SQL: only
// keys the table lacks, so a re-run writes nothing). The one write path of both the
// refresher's whole-history catch-up and an MV swap's window catch-up.
async function insertMissingTransferDeltas(c: ClickHouseClient, p: { contract: string; lo: number; hi: number }, why: string): Promise<void> {
  const before = Date.now()
  await c.command({
    query: CATCHUP_INSERT_SQL,
    query_params: { c: p.contract, lo: p.lo, hi: p.hi },
    clickhouse_settings: { max_threads: 4 },
  })
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
  for (const p of plan) await insertMissingTransferDeltas(client, p, 'catch-up')
  catchUpPending = truncated
  catchUpSetKey = setKey
  catchUpCheckedAt = Date.now()
}

const ERC20_BALANCE_OF = '70a08231' // keccak256("balanceOf(address)")[:4]

let client: ClickHouseClient

// Balances for the addresses the node actually answered for. A dropped batch or
// an unparseable item leaves its addresses out of the map — the caller must treat
// them as unknown, never as zero.
async function ethCallBalances(assetId: number, h160s: string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  const to = erc20Precompile(assetId)
  for (let start = 0; start < h160s.length; start += 80) {
    const chunk = h160s.slice(start, start + 80)
    const calls = chunk.map((h, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data: `0x${ERC20_BALANCE_OF}${'0'.repeat(24)}${h.slice(2).toLowerCase()}` }, 'latest'] }))
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
    } catch { /* chunk skipped; next refresh retries */ } finally { clearTimeout(timer) }
  }
  return out
}

// Rows for one refresh cycle. A holder missing from `balances` could not be read
// this cycle — that is unknown, not zero — so it gets no row and keeps its last
// published one. Every holder's anchor still counts as current, so the stale-key
// pass only zeroes keys that no longer belong to any holder.
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
  // An anchor is published only when EVERY H160 folding into it was read this
  // cycle: a sum over the ones that answered would shrink a shared anchor's balance
  // by its unread members, so a partly read anchor keeps its previous row.
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

// Refresh candidates are every address that ever appeared in a Transfer log of
// the backing contract (~1.2k for HOLLAR); each H160 is anchored to its
// substrate account id via the alias table (falling back to the ETH-prefixed
// AccountId32 form) so rows group with the account's other balances. An asset
// whose deltas have not been captured yet yields no candidates and is skipped,
// so it keeps whatever rows it already has rather than being zeroed.
async function refresh(): Promise<void> {
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
  for (const a of assets) {
    const holderRes = await client.query({
      query: `SELECT DISTINCT holder AS h FROM price_data.erc20_transfer_deltas
           WHERE contract_address = {c:String} AND holder != '0x0000000000000000000000000000000000000000'`,
      query_params: { c: a.contract }, format: 'JSONEachRow',
    })
    const h160s = (await holderRes.json<{ h: string }>())
      .map(r => r.h.toLowerCase())
      .filter(h => /^0x[0-9a-f]{40}$/.test(h))
    if (!h160s.length) continue
    // Prefer the full substrate account so the balance lands on the profile the
    // rest of the explorer groups by: (1) an alias-linked substrate account,
    // (2) a known balance-holding substrate account whose truncated first 20
    // bytes ARE the H160 (aliases only exist once substrate-side activity was
    // observed), (3) the ETH-prefixed AccountId32 form (genuine EVM accounts).
    const [aliasRes, truncRes] = await Promise.all([
      client.query({
        // account_alias_directory holds one row per distinct alias identity (19,867)
        // instead of raw_account_aliases' one row per observation (16.2M).
        query: `SELECT DISTINCT evm_address AS evm, account_id FROM price_data.account_alias_directory
                WHERE evm_address IN ({evms:Array(String)}) AND account_id != ''`,
        query_params: { evms: h160s }, format: 'JSONEachRow',
      }),
      client.query({
        query: TRUNCATED_SUBSTRATE_ACCOUNTS_SQL,
        query_params: { evms: h160s }, format: 'JSONEachRow',
      }),
    ])
    const anchor = new Map<string, string>()
    for (const r of await truncRes.json<{ evm: string; account_id: string }>()) anchor.set(r.evm, r.account_id)
    for (const r of await aliasRes.json<{ evm: string; account_id: string }>()) {
      const isEthPrefixed = r.account_id.startsWith('0x45544800') && r.account_id.endsWith('0000000000000000')
      if (!isEthPrefixed) anchor.set(r.evm, r.account_id.toLowerCase())
    }
    const balances = await ethCallBalances(a.assetId, h160s)
    if (!balances.size) continue // RPC down — keep previous rows
    if (balances.size < h160s.length) {
      console.warn(`[erc20-wallet] partial refresh for asset ${a.assetId}: ${balances.size}/${h160s.length} balances read; unread holders keep their previous rows`)
    }
    // Module/sovereign truncations resolve deterministically; then alias/
    // truncation anchors; genuine EVM accounts keep the ETH-prefixed form.
    const anchorOf = (h: string) => reservedH160AccountId(h.slice(2)) ?? anchor.get(h) ?? `0x45544800${h.slice(2)}0000000000000000`
    // Zero keys that no longer belong to the current account anchor so stale
    // rows cannot double count a wallet balance.
    const prevRes = await client.query({
      query: `SELECT account_id FROM price_data.erc20_wallet_balances WHERE asset_id = {a:String}
              GROUP BY account_id HAVING toUInt256OrZero(argMax(total, updated_at)) > 0`,
      query_params: { a: String(a.assetId) }, format: 'JSONEachRow',
    })
    const previous = (await prevRes.json<{ account_id: string }>()).map(r => r.account_id)
    await client.insert({
      table: 'price_data.erc20_wallet_balances',
      values: walletBalanceRows(a.assetId, h160s, balances, anchorOf, previous),
      format: 'JSONEachRow',
    })
  }
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
