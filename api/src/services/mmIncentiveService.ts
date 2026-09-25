import { createHash } from 'node:crypto'
import type { ClickHouseClient } from '../db/client.ts'
import { incentivePending } from './aaveMath.ts'
import { assetDecimalsOrNull, assetIdFromMmAddress } from './explorerAssets.ts'
import { readExistentialDeposits } from './lmRewardService.ts'
import { loadMmReserveMap } from './moneyMarketHistory.ts'
import { MM_MARKET_ROW_PREFIX, mmIncentiveAccountForm, mmPrimaryMarket } from './mmIncentiveSnapshot.ts'
import { pendingNodeApi } from './pendingHeadService.ts'
import { queryTag } from './queryTag.ts'
import { canSkipRepublish } from './snapshotRepublish.ts'
import { SUBSTRATE_RPC_URL, rpc } from './substrateRpc.ts'

// Current claimable money-market (lending) incentives: the Aave v3
// RewardsController's own getAllUserRewards per candidate holder at one pinned
// block, on the coordinated background refresher, published as a generation of
// `mm_incentive_snapshots` that every current surface reads through
// mmIncentiveSnapshot.ts.
//
// Why the chain's number and not the log arithmetic alone: the view is cheap (one
// eth_call per holder) and immune to any gap in the indexed logs. The arithmetic
// still runs beside it, from the same pinned block — the B0 anchor
// (mm_incentive_anchor) plus every indexed Accrued less every RewardsClaimed for
// the stored accrual, plus per incentivized asset scaled balance × (the programme's
// index projected to the block by the chain's getAssetIndex − the holder's index) /
// 10^decimals — and `reconciled` records whether it agrees to the unit. It is what
// the incentive HISTORY is built from, so a holder whose arithmetic does not
// reconcile now is flagged incomplete across its history.
//
// One cycle, pinned to ONE block — min(the indexed head (raw-live, clamped to the
// newest block raw_events actually holds), the node's finalized head) — so the logs
// and scaled balances the arithmetic reads describe the same chain state the
// eth_calls read, and that state can no longer be reorganised away. Every eth_call
// names the block by its Ethereum block HASH (EIP-1898 `{ blockHash }`), resolved
// with eth_getBlockByNumber and confirmed by eth_getBlockByHash: Frontier answers an
// eth_call naming a hash it does not know at its LATEST state, without an error
// (measured on node-full, and a Substrate hash is such an unknown hash), so the hash
// is only used once the node has stated that it maps to the pinned number.
//  1. programmes from mm_incentive_programmes; candidates = every user of
//     mm_incentive_accruals ∪ every user of mm_incentive_claims ∪ every holder with
//     a positive scaled balance on a programme asset ∪ every holder whose
//     log-derived accrual is non-zero (anchor + Σ Accrued − Σ claimed);
//  2. eth_call at the block: getAssetDecimals per asset (checked against the
//     registry's decimals of the aToken's underlying — a mismatch is logged, the
//     chain's value used), getAssetIndex per programme, getAllUserRewards(every
//     programme asset, holder) per candidate;
//  3. the reward assets' existential deposits (AssetRegistry.Assets at the block);
//  4. persist a generation + pointer (checksum-skipped when nothing changed).
//
// Failure policy (the lm-rewards one): any failed read aborts the cycle and keeps
// the previous generation; so does a missing or split anchor (the aToken anchor and
// the incentive anchor must both be published at one block B0), since without it
// every pair would publish unreconciled and the history would flag them all. A
// pointer older than 15 minutes drops the rewards from every current surface
// together.

let client: ClickHouseClient | null = null

export function initMmIncentiveService(c: ClickHouseClient): void {
  client = c
}

export const REWARDS_CONTROLLER = '0x7472a3d0891df2401d981a5954d07e364f05060f'

const SEL = {
  getAllUserRewards: '4c0369c3',
  getAssetIndex: '886fe70b',
  getAssetDecimals: '9efd6f72',
} as const

const pad = (addr: string): string => addr.slice(2).toLowerCase().padStart(64, '0')
const word = (n: number | bigint): string => BigInt(n).toString(16).padStart(64, '0')

// ───────────────────────── eth_call ─────────────────────────

export interface EthCallRequest { to: string; data: string }
/** A block number tag ('0x…', 'latest') or an EIP-1898 block-hash selector. */
export type EthBlockRef = string | { blockHash: string }
export type EthCall = (calls: EthCallRequest[], blockTag: EthBlockRef) => Promise<string[]>

/**
 * Batched eth_call at `blockTag`, 50 per JSON-RPC batch, retried twice. Throws
 * when any call in a batch has no result: an unread balance is not a zero one.
 */
export function makeEthCall(url: string = SUBSTRATE_RPC_URL, fetchImpl: typeof fetch = fetch): EthCall {
  return async (calls, blockTag) => {
    const out: string[] = new Array(calls.length)
    for (let start = 0; start < calls.length; start += 50) {
      const chunk = calls.slice(start, start + 50)
      const body = JSON.stringify(chunk.map((c, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to: c.to, data: c.data }, blockTag] })))
      let lastError: unknown = null
      for (let attempt = 0; attempt < 3; attempt++) {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 20_000)
        try {
          const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal, body })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const json = await res.json() as Array<{ id: number; result?: string; error?: { message?: string } }>
          if (!Array.isArray(json) || json.length !== chunk.length) throw new Error('short batch response')
          for (const r of json) {
            if (typeof r.result !== 'string' || !Number.isInteger(r.id) || r.id < 0 || r.id >= chunk.length) throw new Error(`eth_call failed: ${r.error?.message ?? 'no result'}`)
            out[start + r.id] = r.result
          }
          lastError = null
          break
        } catch (err) {
          lastError = err
        } finally { clearTimeout(timer) }
      }
      if (lastError) throw new Error(`[mm-incentives] eth_call batch at ${start} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
    }
    return out
  }
}

/** Decode getAllUserRewards' (address[] rewardsList, uint256[] unclaimedAmounts). */
export function decodeAllUserRewards(hex: string): Map<string, bigint> {
  const h = hex.slice(2)
  const at = (byte: number) => BigInt('0x' + (h.slice(byte * 2, byte * 2 + 64) || '0'))
  const listOff = Number(at(0))
  const amountsOff = Number(at(32))
  const n = Number(at(listOff))
  const m = Number(at(amountsOff))
  if (n !== m) throw new Error(`getAllUserRewards: ${n} rewards but ${m} amounts`)
  const out = new Map<string, bigint>()
  for (let i = 0; i < n; i++) {
    const addr = '0x' + h.slice((listOff + 32 + i * 32) * 2 + 24, (listOff + 32 + (i + 1) * 32) * 2)
    out.set(addr.toLowerCase(), (out.get(addr.toLowerCase()) ?? 0n) + at(amountsOff + 32 + i * 32))
  }
  return out
}

export function getAllUserRewardsCall(assets: string[], user: string, controller = REWARDS_CONTROLLER): EthCallRequest {
  return { to: controller, data: `0x${SEL.getAllUserRewards}${word(64)}${pad(user)}${word(assets.length)}${assets.map(pad).join('')}` }
}

// ───────────────────────── rows (pure) ─────────────────────────

export interface Programme { asset: string; reward: string }

export interface MmIncentiveInputs {
  block: number
  candidates: string[]
  programmes: Programme[]
  /** holder → reward address → the chain's getAllUserRewards amount. */
  chain: Map<string, Map<string, bigint>>
  /** `${asset}|${reward}` → the programme index projected to the block. */
  assetIndex: Map<string, bigint>
  /** asset → decimals. */
  decimals: Map<string, number>
  /** `${holder}|${asset}` → scaled balance at the block. */
  scaled: Map<string, bigint>
  /** `${holder}|${reward}` → anchor + Σ Accrued − Σ claimed (can be negative only on a log gap). */
  accrued: Map<string, bigint>
  /** `${holder}|${asset}|${reward}` → the holder's index. */
  userIndex: Map<string, bigint>
  /** reward asset id → existential deposit. */
  eds: Map<number, bigint>
  marketOf: (asset: string) => string
  /**
   * holder → market → reward → the chain's getAllUserRewards over that market's
   * programme aTokens alone. Read only for rewards whose programmes span several
   * markets (spanningRewards); such a pair publishes one per-market total row
   * each (MM_MARKET_ROW_PREFIX) from it.
   */
  chainByMarket?: Map<string, Map<string, Map<string, bigint>>>
}

/** The rewards whose programme aTokens belong to more than one market, with those markets (sorted). Pure. */
export function spanningRewards(programmes: readonly Programme[], marketOf: (asset: string) => string): Map<string, string[]> {
  const byReward = new Map<string, Set<string>>()
  for (const p of programmes) (byReward.get(p.reward) ?? byReward.set(p.reward, new Set()).get(p.reward)!).add(marketOf(p.asset))
  const out = new Map<string, string[]>()
  for (const [reward, markets] of byReward) if (markets.size > 1) out.set(reward, [...markets].sort())
  return out
}

export interface MmIncentiveSnapshotRow {
  accountId: string
  holder: string
  rewardAssetId: number
  rewardAddress: string
  assetAddress: string
  marketKey: string
  claimableRaw: bigint
  modelRaw: bigint
  accruedRaw: bigint
  pendingRaw: bigint
  scaledBalance: bigint
  userIndex: bigint
  assetIndex: bigint
  reconciled: boolean
  belowEd: boolean
  snapshotBlock: number
}

/**
 * Per holder and reward one total row (asset '') and one leg row per programme
 * asset the holder has a scaled balance on. Rows only where something is owed
 * (the chain's claimable or the model's). A holder/reward the arithmetic cannot
 * state (a negative accrual, an index that went backwards) publishes model 0 and
 * reconciled false.
 */
export function buildMmIncentiveRows(inp: MmIncentiveInputs): { rows: MmIncentiveSnapshotRow[]; reconciledPairs: number; unreconciled: Array<{ holder: string; reward: string; chain: string; model: string | null }> } {
  const rows: MmIncentiveSnapshotRow[] = []
  const unreconciled: Array<{ holder: string; reward: string; chain: string; model: string | null }> = []
  let reconciledPairs = 0
  const rewardAddrs = [...new Set(inp.programmes.map(p => p.reward))].sort()
  const spanning = spanningRewards(inp.programmes, inp.marketOf)
  for (const holder of [...new Set(inp.candidates)].sort()) {
    const chain = inp.chain.get(holder) ?? new Map<string, bigint>()
    for (const reward of [...new Set([...rewardAddrs, ...chain.keys()])].sort()) {
      const rewardAssetId = assetIdFromMmAddress(reward)
      if (rewardAssetId == null) continue
      const accrued = inp.accrued.get(`${holder}|${reward}`) ?? 0n
      let stated = accrued >= 0n
      let pendingTotal = 0n
      const legs: MmIncentiveSnapshotRow[] = []
      // A pair within one market is filed under it; one spanning several is filed
      // under each through its per-market rows below, the '' total carrying its
      // primary market (mmPrimaryMarket, the history's rule).
      const span = spanning.get(reward)
      let market = span ? mmPrimaryMarket(span) : ''
      for (const p of inp.programmes) {
        if (p.reward !== reward) continue
        market ||= inp.marketOf(p.asset)
        const scaled = inp.scaled.get(`${holder}|${p.asset}`) ?? 0n
        if (scaled <= 0n) continue
        const assetIndex = inp.assetIndex.get(`${p.asset}|${reward}`)
        const userIndex = inp.userIndex.get(`${holder}|${p.asset}|${reward}`) ?? 0n
        const decimals = inp.decimals.get(p.asset)
        let pending = 0n
        if (assetIndex == null || decimals == null || assetIndex < userIndex) stated = false
        else pending = incentivePending(scaled, assetIndex, userIndex, 10n ** BigInt(decimals))
        pendingTotal += pending
        legs.push({
          accountId: mmIncentiveAccountForm(holder), holder, rewardAssetId, rewardAddress: reward, assetAddress: p.asset, marketKey: inp.marketOf(p.asset),
          claimableRaw: 0n, modelRaw: 0n, accruedRaw: 0n, pendingRaw: pending, scaledBalance: scaled, userIndex, assetIndex: assetIndex ?? 0n,
          reconciled: false, belowEd: false, snapshotBlock: inp.block,
        })
      }
      const claimable = chain.get(reward) ?? 0n
      const model = stated ? accrued + pendingTotal : null
      if (claimable <= 0n && (model == null || model <= 0n) && accrued === 0n) continue
      const reconciled = model != null && model === claimable
      if (reconciled) reconciledPairs++
      else unreconciled.push({ holder, reward, chain: claimable.toString(), model: model == null ? null : model.toString() })
      const ed = inp.eds.get(rewardAssetId)
      const common = { reconciled, snapshotBlock: inp.block }
      rows.push({
        accountId: mmIncentiveAccountForm(holder), holder, rewardAssetId, rewardAddress: reward, assetAddress: '', marketKey: market || 'core',
        claimableRaw: claimable, modelRaw: model != null && model > 0n ? model : 0n, accruedRaw: accrued > 0n ? accrued : 0n, pendingRaw: pendingTotal,
        scaledBalance: 0n, userIndex: 0n, assetIndex: 0n,
        belowEd: ed != null && claimable > 0n && claimable < ed, ...common,
      })
      const belowEd = ed != null && claimable > 0n && claimable < ed
      for (const m of spanning.get(reward) ?? []) {
        const byMarket = inp.chainByMarket?.get(holder)?.get(m)
        if (!byMarket) throw new Error(`[mm-incentives] no per-market claimable for ${holder} in ${m}`)
        const amount = byMarket.get(reward) ?? 0n
        const pending = legs.filter(l => l.marketKey === m).reduce((sum, l) => sum + l.pendingRaw, 0n)
        if (amount <= 0n && pending <= 0n) continue
        rows.push({
          accountId: mmIncentiveAccountForm(holder), holder, rewardAssetId, rewardAddress: reward, assetAddress: `${MM_MARKET_ROW_PREFIX}${m}`, marketKey: m,
          claimableRaw: amount, modelRaw: 0n, accruedRaw: 0n, pendingRaw: pending, scaledBalance: 0n, userIndex: 0n, assetIndex: 0n,
          belowEd, ...common,
        })
      }
      for (const leg of legs) rows.push({ ...leg, ...common })
    }
  }
  return { rows, reconciledPairs, unreconciled }
}

// ───────────────────────── indexed reads ─────────────────────────

async function select<T>(ch: ClickHouseClient, query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const res = await ch.query({ query, query_params: params, format: 'JSONEachRow', clickhouse_settings: { log_comment: queryTag(query) ?? 'mm:incentives' } })
  return res.json<T>()
}

const big = (v: unknown): bigint => (/^-?\d+$/.test(String(v ?? '')) ? BigInt(String(v)) : 0n)

/** The indexed head, clamped to the newest block raw_events holds (raw-live's pointer can lead its rows). */
export async function loadIndexedHead(ch: ClickHouseClient): Promise<number> {
  const [state] = await select<{ b: number }>(ch, `-- mm:incentives-head
    SELECT argMax(last_block, updated_at) AS b FROM price_data.raw_ingestion_state WHERE pipeline_id = 'raw-live'`)
  const head = Number(state?.b ?? 0)
  if (!head) throw new Error('no raw-live head')
  const [rows] = await select<{ b: number }>(ch, `-- mm:incentives-rows-head
    SELECT max(block_height) AS b FROM price_data.raw_events WHERE block_height > {lo:UInt32} AND block_height <= {hi:UInt32}`, { lo: Math.max(0, head - 2_000), hi: head })
  const b = Number(rows?.b ?? 0)
  if (!b) throw new Error('raw_events holds no block near the raw-live head')
  return b
}

export type RpcFn = <T>(method: string, params: unknown[]) => Promise<T | null>

/** The node's finalized head number (chain_getFinalizedHead → chain_getHeader). */
export async function loadFinalizedHead(rpcFn: RpcFn = rpc): Promise<number> {
  const hash = await rpcFn<string>('chain_getFinalizedHead', [])
  if (!hash) throw new Error('chain_getFinalizedHead failed')
  const header = await rpcFn<{ number: string }>('chain_getHeader', [hash])
  const n = header?.number != null ? Number(BigInt(header.number)) : 0
  if (!n) throw new Error(`chain_getHeader(${hash}) failed`)
  return n
}

/**
 * The block a cycle reads: min(indexed head, finalized head) with its Substrate
 * hash (for the existential-deposit storage read) and its Ethereum block hash (for
 * every eth_call, EIP-1898). The Ethereum hash is confirmed by eth_getBlockByHash
 * to name the pinned number, because an eth_call naming an unknown hash silently
 * answers at the node's latest state.
 */
export async function loadPinnedBlock(ch: ClickHouseClient, rpcFn: RpcFn = rpc): Promise<{ block: number; blockHash: string; ethBlockHash: string; indexedHead: number; finalizedHead: number }> {
  const [indexedHead, finalizedHead] = await Promise.all([loadIndexedHead(ch), loadFinalizedHead(rpcFn)])
  const block = Math.min(indexedHead, finalizedHead)
  const tag = `0x${block.toString(16)}`
  const [blockHash, ethBlock] = await Promise.all([
    rpcFn<string>('chain_getBlockHash', [block]),
    rpcFn<{ hash?: string; number?: string }>('eth_getBlockByNumber', [tag, false]),
  ])
  if (!blockHash) throw new Error(`chain_getBlockHash(${block}) failed`)
  const ethBlockHash = ethBlock?.hash
  if (!ethBlockHash || ethBlock?.number == null || Number(BigInt(ethBlock.number)) !== block) throw new Error(`eth_getBlockByNumber(${block}) failed`)
  const confirm = await rpcFn<{ number?: string }>('eth_getBlockByHash', [ethBlockHash, false])
  if (confirm?.number == null || Number(BigInt(confirm.number)) !== block) throw new Error(`eth_getBlockByHash(${ethBlockHash}) does not name block ${block}`)
  return { block, blockHash, ethBlockHash, indexedHead, finalizedHead }
}

export async function loadProgrammes(ch: ClickHouseClient, block: number): Promise<Programme[]> {
  return (await select<Programme>(ch, `-- mm:incentives-programmes
    SELECT DISTINCT asset_address AS asset, reward_address AS reward FROM price_data.mm_incentive_programmes FINAL
    WHERE block_height <= {b:UInt32} ORDER BY asset, reward`, { b: block }))
}

export interface MmIncentiveLogState {
  anchorBlock: number
  scaled: Map<string, bigint>
  accrued: Map<string, bigint>
  userIndex: Map<string, bigint>
  /** Every user an Accrued (resp. RewardsClaimed) up to the block names — candidates whatever their balance. */
  accrualUsers: string[]
  claimUsers: string[]
}

/**
 * Everything the log arithmetic needs at `block`, in four reads: per-holder scaled
 * balances on the programme assets (the aToken anchor + contract-first deltas),
 * per (holder, asset, reward) the post-B0 accrual sum and last user index, per
 * (holder, reward) the post-B0 claims, and the incentive anchor.
 */
export async function loadIncentiveLogState(ch: ClickHouseClient, assets: string[], block: number): Promise<MmIncentiveLogState> {
  const [a] = await select<{ b0: number }>(ch, '-- mm:incentives-anchor-block\nSELECT max(anchor_block) AS b0 FROM price_data.mm_incentive_anchor')
  const [sa] = await select<{ b0: number }>(ch, '-- mm:incentives-atoken-anchor-block\nSELECT max(anchor_block) AS b0 FROM price_data.atoken_scaled_anchor')
  const anchorBlock = Number(a?.b0 ?? 0)
  const scaledAnchor = Number(sa?.b0 ?? 0)
  if (!anchorBlock || !scaledAnchor || anchorBlock !== scaledAnchor) {
    // Without both anchors at one block the arithmetic has no base: every pair
    // would publish unreconciled and the history would flag every holder. Abort the
    // cycle instead, so the previous generation stays published (and turns stale
    // after 15 minutes, which drops the rewards everywhere together).
    throw new Error(`[mm-incentives] no common anchor block (mm_incentive_anchor ${anchorBlock || 'empty'}, atoken_scaled_anchor ${scaledAnchor || 'empty'}); keeping the previous generation`)
  }
  const out: MmIncentiveLogState = { anchorBlock, scaled: new Map(), accrued: new Map(), userIndex: new Map(), accrualUsers: [], claimUsers: [] }
  const [scaledRows, accrualRows, claimRows, anchorRows, accrualUserRows, claimUserRows] = await Promise.all([
    assets.length ? select<{ holder: string; contract: string; scaled: string }>(ch, `-- mm:incentives-scaled
      SELECT holder, contract, toString(sum(v)) AS scaled FROM (
        SELECT lower(holder) AS holder, lower(contract_address) AS contract, scaled_balance AS v
        FROM price_data.atoken_scaled_anchor FINAL
        WHERE contract_address IN {assets:Array(String)} AND holder != '' AND anchor_block = {b0:UInt32}
        UNION ALL
        SELECT holder, contract_address AS contract, scaled_delta AS v
        FROM price_data.atoken_scaled_deltas_by_contract FINAL
        WHERE contract_address IN {assets:Array(String)} AND block_height > {b0:UInt32} AND block_height <= {b:UInt32}
      ) GROUP BY holder, contract HAVING sum(v) > 0`, { assets, b0: anchorBlock, b: block }) : Promise.resolve([]),
    select<{ u: string; asset: string; reward: string; acc: string; idx: string }>(ch, `-- mm:incentives-accruals
      SELECT user_address AS u, asset_address AS asset, reward_address AS reward, toString(sum(rewards_accrued)) AS acc,
        toString(argMax(user_index, (block_height, event_index))) AS idx
      FROM price_data.mm_incentive_accruals FINAL
      WHERE block_height > {b0:UInt32} AND block_height <= {b:UInt32}
      GROUP BY u, asset, reward`, { b0: anchorBlock, b: block }),
    select<{ u: string; reward: string; amount: string }>(ch, `-- mm:incentives-claims
      SELECT user_address AS u, reward_address AS reward, toString(sum(amount)) AS amount
      FROM price_data.mm_incentive_claims FINAL
      WHERE block_height > {b0:UInt32} AND block_height <= {b:UInt32}
      GROUP BY u, reward`, { b0: anchorBlock, b: block }),
    select<{ u: string; asset: string; reward: string; value: string }>(ch, `-- mm:incentives-anchor
      SELECT user_address AS u, asset_address AS asset, reward_address AS reward, toString(value) AS value
      FROM price_data.mm_incentive_anchor FINAL WHERE user_address != ''`),
    // Both tables are user-first, so a DISTINCT over the key's first column is a key read.
    select<{ u: string }>(ch, `-- mm:incentives-accrual-users
      SELECT DISTINCT user_address AS u FROM price_data.mm_incentive_accruals WHERE block_height <= {b:UInt32}`, { b: block }),
    select<{ u: string }>(ch, `-- mm:incentives-claim-users
      SELECT DISTINCT user_address AS u FROM price_data.mm_incentive_claims WHERE block_height <= {b:UInt32}`, { b: block }),
  ])
  out.accrualUsers = accrualUserRows.map(r => r.u.toLowerCase())
  out.claimUsers = claimUserRows.map(r => r.u.toLowerCase())
  for (const r of scaledRows) out.scaled.set(`${r.holder}|${r.contract}`, big(r.scaled))
  const add = (key: string, v: bigint) => out.accrued.set(key, (out.accrued.get(key) ?? 0n) + v)
  for (const r of anchorRows) {
    if (r.asset === '') add(`${r.u}|${r.reward}`, big(r.value))
    else out.userIndex.set(`${r.u}|${r.asset}|${r.reward}`, big(r.value))
  }
  for (const r of accrualRows) {
    add(`${r.u}|${r.reward}`, big(r.acc))
    out.userIndex.set(`${r.u}|${r.asset}|${r.reward}`, big(r.idx))
  }
  for (const r of claimRows) add(`${r.u}|${r.reward}`, -big(r.amount))
  return out
}

// ───────────────────────── persist ─────────────────────────

export const mmIncentiveChecksumFields = (r: MmIncentiveSnapshotRow): string =>
  `${r.accountId}|${r.holder}|${r.rewardAssetId}|${r.rewardAddress}|${r.assetAddress}|${r.marketKey}|${r.claimableRaw}|${r.modelRaw}|${r.accruedRaw}|${r.pendingRaw}|${r.scaledBalance}|${r.userIndex}|${r.assetIndex}|${r.reconciled}|${r.belowEd}|${r.snapshotBlock}\n`

export async function persistMmIncentiveSnapshot(
  ch: ClickHouseClient, rows: MmIncentiveSnapshotRow[],
  meta: { blockHeight: number; blockHash: string; candidates: number; reconciledPairs: number; unreconciledPairs: number },
): Promise<'republished' | 'unchanged'> {
  const checksum = createHash('sha256')
  for (const r of rows) checksum.update(mmIncentiveChecksumFields(r))
  const digest = checksum.digest('hex')
  if (await canSkipRepublish(ch, {
    dataTable: 'mm_incentive_snapshots', stateTable: 'mm_incentive_snapshot_state',
    rowCountColumn: 'row_count', checksum: digest, rowCount: rows.length,
  })) return 'unchanged'
  const snapshotId = String(Date.now())
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
  for (let offset = 0; offset < rows.length; offset += 5_000) {
    await ch.insert({
      table: 'price_data.mm_incentive_snapshots',
      values: rows.slice(offset, offset + 5_000).map(r => ({
        snapshot_id: snapshotId, account_id: r.accountId, holder: r.holder, reward_asset_id: r.rewardAssetId, reward_address: r.rewardAddress,
        asset_address: r.assetAddress, market_key: r.marketKey, claimable_raw: r.claimableRaw.toString(), model_raw: r.modelRaw.toString(),
        accrued_raw: r.accruedRaw.toString(), pending_raw: r.pendingRaw.toString(), scaled_balance: r.scaledBalance.toString(),
        user_index: r.userIndex.toString(), asset_index: r.assetIndex.toString(), reconciled: r.reconciled ? 1 : 0, below_ed: r.belowEd ? 1 : 0,
        snapshot_block: r.snapshotBlock, computed_at: now,
      })),
      format: 'JSONEachRow',
    })
  }
  const verify = await ch.query({
    query: `SELECT count() AS c, uniqExact((account_id, reward_asset_id, asset_address)) AS u
      FROM price_data.mm_incentive_snapshots WHERE snapshot_id = {snapshotId:String}`,
    query_params: { snapshotId }, format: 'JSONEachRow',
  })
  const counts = (await verify.json<{ c: string; u: string }>())[0]
  if (Number(counts?.c) !== rows.length || Number(counts?.u) !== rows.length) throw new Error(`incomplete mm incentive snapshot ${counts?.c ?? 0}/${rows.length}`)
  // The pointer is written last, so a partial generation is never request-visible.
  await ch.insert({
    table: 'price_data.mm_incentive_snapshot_state',
    values: [{
      snapshot_key: 'current', snapshot_id: snapshotId, row_count: rows.length, block_height: meta.blockHeight, block_hash: meta.blockHash,
      candidates: meta.candidates, reconciled_pairs: meta.reconciledPairs, unreconciled_pairs: meta.unreconciledPairs,
      source_checksum: digest, computed_at: now,
    }],
    format: 'JSONEachRow',
  })
  const parts = await ch.query({
    query: `SELECT DISTINCT partition FROM system.parts
      WHERE database = 'price_data' AND table = 'mm_incentive_snapshots' AND active AND partition != {snapshotId:String}`,
    query_params: { snapshotId }, format: 'JSONEachRow',
  })
  for (const row of await parts.json<{ partition: string }>()) {
    await ch.command({ query: `ALTER TABLE price_data.mm_incentive_snapshots DROP PARTITION {partition:String}`, query_params: { partition: row.partition } })
  }
  return 'republished'
}

// ───────────────────────── the cycle ─────────────────────────

export interface MmIncentiveCycle {
  block: number
  blockHash: string
  indexedHead: number
  finalizedHead: number
  candidates: number
  /** Programme aTokens whose chain getAssetDecimals disagrees with the registry's decimals of their underlying. */
  decimalsMismatches: Array<{ asset: string; chain: number; registry: number }>
  rows: MmIncentiveSnapshotRow[]
  reconciledPairs: number
  unreconciled: Array<{ holder: string; reward: string; chain: string; model: string | null }>
}

/**
 * The programme aTokens whose chain getAssetDecimals differs from the registry's
 * decimals of the aToken's underlying (Aave initialises an aToken with its
 * underlying's decimals, and the incentive history computes on the registry's).
 * An aToken the registry cannot name is not a mismatch — the history leaves its
 * pending part unstated anyway. Pure.
 */
export function assetDecimalsMismatches(
  chain: Map<string, number>, reserves: ReadonlyArray<{ atoken: string; assetAddress: string }>, registryDecimals: (assetId: number) => number | null,
): Array<{ asset: string; chain: number; registry: number }> {
  const byAtoken = new Map(reserves.map(r => [r.atoken.toLowerCase(), r]))
  const out: Array<{ asset: string; chain: number; registry: number }> = []
  for (const [asset, dec] of chain) {
    const reserve = byAtoken.get(asset)
    const underlying = reserve ? assetIdFromMmAddress(reserve.assetAddress) : null
    const registry = underlying != null ? registryDecimals(underlying) : null
    if (registry != null && registry !== dec) out.push({ asset, chain: dec, registry })
  }
  return out
}

export interface MmIncentiveDeps {
  ethCall?: EthCall
  eds?: (hash: string, ids: number[]) => Promise<Map<number, bigint>>
  rpc?: RpcFn
  registryDecimals?: (assetId: number) => number | null
}

/** Read + reconcile, with no write — the refresher's whole computation. */
export async function computeMmIncentives(ch: ClickHouseClient, deps: MmIncentiveDeps = {}): Promise<MmIncentiveCycle> {
  const ethCall = deps.ethCall ?? makeEthCall()
  const pinned = await loadPinnedBlock(ch, deps.rpc ?? rpc)
  const { block, blockHash } = pinned
  const at: EthBlockRef = { blockHash: pinned.ethBlockHash }
  const programmes = await loadProgrammes(ch, block)
  const assets = [...new Set(programmes.map(p => p.asset))].sort()
  const [state, reserveMap] = await Promise.all([loadIncentiveLogState(ch, assets, block), loadMmReserveMap(ch)])
  const marketByAtoken = new Map(reserveMap.reserves.map(r => [r.atoken, r.marketKey]))
  const holders = new Set<string>([...state.accrualUsers, ...state.claimUsers])
  for (const [key, v] of state.scaled) if (v > 0n) holders.add(key.slice(0, key.indexOf('|')))
  for (const [key, v] of state.accrued) if (v !== 0n) holders.add(key.slice(0, key.indexOf('|')))
  const candidates = [...holders].filter(h => /^0x[0-9a-f]{40}$/.test(h)).sort()

  const meta = await ethCall([
    ...assets.map(a => ({ to: REWARDS_CONTROLLER, data: `0x${SEL.getAssetDecimals}${pad(a)}` })),
    ...programmes.map(p => ({ to: REWARDS_CONTROLLER, data: `0x${SEL.getAssetIndex}${pad(p.asset)}${pad(p.reward)}` })),
  ], at)
  const decimals = new Map(assets.map((a, i) => [a, Number(BigInt(meta[i]))]))
  const decimalsMismatches = assetDecimalsMismatches(decimals, reserveMap.reserves, deps.registryDecimals ?? assetDecimalsOrNull)
  for (const m of decimalsMismatches) console.warn('[mm-incentives] getAssetDecimals disagrees with the registry', m)
  // getAssetIndex returns (oldIndex, newIndex): the stored index and the index brought to the block.
  const assetIndex = new Map(programmes.map((p, i) => [`${p.asset}|${p.reward}`, BigInt('0x' + meta[assets.length + i].slice(66, 130))]))
  const answers = await ethCall(candidates.map(h => getAllUserRewardsCall(assets, h)), at)
  const chain = new Map(candidates.map((h, i) => [h, decodeAllUserRewards(answers[i])]))
  // A reward spanning markets is owed per market: the chain's figure over each
  // market's programme aTokens alone (none today, so no extra calls).
  const marketOf = (asset: string) => marketByAtoken.get(asset) ?? 'core'
  const spanningMarkets = [...new Set([...spanningRewards(programmes, marketOf).values()].flat())].sort()
  const chainByMarket = new Map<string, Map<string, Map<string, bigint>>>()
  if (spanningMarkets.length) {
    const perMarket = spanningMarkets.map(m => ({ m, assets: assets.filter(a => marketOf(a) === m) }))
    const calls = candidates.flatMap(h => perMarket.map(({ assets: list }) => getAllUserRewardsCall(list, h)))
    const perAnswers = await ethCall(calls, at)
    candidates.forEach((h, i) => {
      const byMarket = new Map<string, Map<string, bigint>>()
      perMarket.forEach(({ m }, j) => byMarket.set(m, decodeAllUserRewards(perAnswers[i * perMarket.length + j])))
      chainByMarket.set(h, byMarket)
    })
  }

  const rewardIds = [...new Set(programmes.map(p => assetIdFromMmAddress(p.reward)).filter((x): x is number => x != null))]
  let edMap: Map<number, bigint>
  if (deps.eds) edMap = await deps.eds(blockHash, rewardIds)
  else {
    const api = pendingNodeApi()
    if (!api) throw new Error('node connection not ready')
    edMap = await readExistentialDeposits(await api.at(blockHash), blockHash, rewardIds)
  }
  const built = buildMmIncentiveRows({
    block, candidates, programmes, chain, assetIndex, decimals, scaled: state.scaled, accrued: state.accrued, userIndex: state.userIndex,
    eds: edMap, marketOf, chainByMarket,
  })
  return {
    block, blockHash, indexedHead: pinned.indexedHead, finalizedHead: pinned.finalizedHead, candidates: candidates.length, decimalsMismatches,
    rows: built.rows, reconciledPairs: built.reconciledPairs, unreconciled: built.unreconciled,
  }
}

async function refresh(): Promise<void> {
  const ch = client
  if (!ch || !pendingNodeApi()) {
    console.info('[mm-incentives] skipped: node connection not ready')
    return
  }
  const t0 = Date.now()
  const cycle = await computeMmIncentives(ch)
  const result = await persistMmIncentiveSnapshot(ch, cycle.rows, {
    blockHeight: cycle.block, blockHash: cycle.blockHash, candidates: cycle.candidates,
    reconciledPairs: cycle.reconciledPairs, unreconciledPairs: cycle.unreconciled.length,
  })
  console.info('[mm-incentives] snapshot', {
    block: cycle.block, indexedHead: cycle.indexedHead, finalizedHead: cycle.finalizedHead, candidates: cycle.candidates, rows: cycle.rows.length,
    decimalsMismatches: cycle.decimalsMismatches.length,
    reconciled: cycle.reconciledPairs, unreconciled: cycle.unreconciled.length, ms: Date.now() - t0, result,
    ...(cycle.unreconciled.length ? { unreconciledSample: cycle.unreconciled.slice(0, 5) } : {}),
  })
}

let inflight: Promise<void> | null = null

// The coordinated scheduler (backgroundRefresh.ts) owns the cadence; a thrown
// cycle keeps the published generation as it was.
export function refreshMmIncentives(): Promise<void> {
  if (inflight) return inflight
  const run = refresh()
    .catch(err => console.error('[mm-incentives] refresh failed, keeping the previous snapshot', err))
    .finally(() => { if (inflight === run) inflight = null })
  inflight = run
  return run
}
