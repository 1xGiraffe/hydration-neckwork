// User Revenue — one window's computation (services/userRevenueFold.ts explains
// the shape): every stream builder, the custody registry that passes a pool
// account's or an aToken contract's income on to its claimants, and the exposure
// anchor the window ends on. Both derivations jobs call
// computeUserRevenueWindow, so the daily and the hourly facts of a month are
// sums of the same cells.

import type { ClickHouseClient } from '../db/client.ts'
import { RAY } from './aaveMath.ts'
import { chTimestamp } from './clickhouseTime.ts'
import { allExplorerAssets, assetDecimalsOrNull } from './explorerAssets.ts'
import {
  FactSink,
  HourPricer,
  joinVia,
  loadProtocolHolders,
  bookLedger,
  userRevenueRows as rows,
  type CustodyRegistry,
  type CustodyResolution,
  type CustodyResolver,
  type HolderMembers,
  type FoldWindow,
  type Ledger,
} from './userRevenueFold.ts'
import {
  BalanceBook,
  OMNIPOOL_ACCOUNT,
  OmnipoolBook,
  buildOmnipool,
  buildStableswap,
  buildXyk,
  loadStableswapPools,
  loadXykPools,
  omnipoolCustody,
  poolCustody,
  xykFarmCustody,
  XYK_LM_ACCOUNT,
} from './userRevenueLp.ts'
import {
  type ReserveIndexBook,
  buildGigahdxYield,
  buildMmIncentives,
  buildMmInterest,
  loadEvmBindings,
  loadMmContracts,
  loadOpeningScaled,
  mmAccountOf,
  type MmContract,
} from './userRevenueMm.ts'
import { buildGigahdxVoting, buildLegacyStaking, buildReferralCommissions } from './userRevenueStaking.ts'
import { buildFarmRewards } from './userRevenueFarms.ts'
import { buildV3LpFees, loadVaultCustodies } from './userRevenueV3.ts'
import { ACCRUING_TOKENS, ERC20_CHECKPOINT_MARK, TOKEN_BALANCE_ASSETS, buildTokenAccrual, erc20CheckpointPot, erc20Closing, loadErc20Book, loadPegGrid, tokenSegments } from './userRevenueTokens.ts'
import type { PegSegment } from './userRevenueMath.ts'
import { MM_COVERAGE_FROM_BLOCK, UNATTRIBUTED_VIA, USER_REVENUE_RULE_VERSION, ethMappedAccount, h160Of } from './userRevenueStreams.ts'

/** The anchor row stating that the replay checkpoints (farm entries, v3 pool states, vault shares) are in it. */
export const CHECKPOINT_POT = 'ckpt'

/** One exposure row of a month-start anchor. */
export interface AnchorRow { pot: string; holder: string; exposure_id: string; units: bigint; aux: string }

/** The anchor a window opens from: month m's rows and the block they hold at (the last block before m). */
export interface AnchorIn { rows: readonly AnchorRow[]; block: number }

export interface WindowStats {
  ledgers: number
  cells: number
  unresolvedIndexUpdates: number
  omnipoolUnstated: number
  farmUnstated: number
  /** (hour, farm, reward asset) cells marked unmeasured: no stated claimable to difference from. */
  farmUnmeasuredHours: number
  farmDryGaps: number
  unmeasuredTokens: Array<{ token: number; reason: string }>
  /** The v3 replay's checks: swaps whose closing tick/liquidity differ from the log, collects not matching the replay to the unit. */
  v3: { swaps: number; swapStateMismatch: number; dustNegative: number; collects: number; collectsExact: number }
  ms: Record<string, number>
}

export interface WindowResult {
  sink: FactSink
  anchorOut: AnchorRow[]
  protocolFp: string
  /** The tag-driven holder set the build classified by (the month fingerprint narrows it to the month's accounts). */
  holderMembers: HolderMembers
  /** The token rate segments the window booked by (their identities join every bucket's fingerprint). */
  pegSegments: Map<number, PegSegment[]>
  stats: WindowStats
}

/**
 * The rule and protocol-holder inputs every HOUR's fingerprint carries (a definition or tag change re-marks every
 * hour the hourly fold can refold — the head months). A MONTH carries the rule alone (`ruleFingerprint('0')`) and the
 * holder set narrowed to its own accounts (userRevenueHolderMonthFpSql): a tag change re-marks exactly the months
 * holding a fact of an account whose membership changed.
 */
export function ruleFingerprint(protocolFp: string): string {
  let h = BigInt(protocolFp) ^ BigInt(USER_REVENUE_RULE_VERSION) * 0x9e3779b97f4a7c15n
  h &= 0xffffffffffffffffn
  return h.toString()
}

/** The last block before an instant (a month's anchor block). */
export async function lastBlockBefore(client: ClickHouseClient, ts: number): Promise<number> {
  const got = await rows<{ b: string }>(client, `
    SELECT max(block_height) AS b FROM price_data.blocks
    WHERE block_timestamp < {t:DateTime} AND block_timestamp >= {t:DateTime} - INTERVAL 30 DAY AND block_height > 0`,
  { t: chTimestamp(ts) }, 'ur:last-block-before')
  return Number(got[0]?.b ?? 0)
}

/** The claims rule for an aToken contract holding an income-earning share: suppliers +, borrowers −, per unit the contract holds. */
export function aTokenClaimsCustody(
  w: FoldWindow, supply: MmContract, debt: MmContract | undefined, book: ReserveIndexBook,
  scaledAt: (contract: string, h: number) => ReadonlyArray<readonly [string, bigint]>,
  accountOf: (h160: string) => string,
): CustodyResolver {
  const kind = `atoken:${supply.aTokenAsset ?? supply.contract}`
  return {
    kind,
    async resolve(ledger: Ledger): Promise<CustodyResolution> {
      const H = ledger.amounts.length
      const parts = new Map<string, Ledger>()
      const remainder = new Array<bigint>(H).fill(0n)
      // Before B0 no aToken balance is stated: a wrapper's income then reaches no claimant, named as such.
      const beforeB0 = new Array<bigint>(H).fill(0n)
      // A claim is a scaled balance times its reserve index. Before a reserve's first indexed update (or after an
      // update the book could not state) there is no index: the hour's income is booked unattributed under
      // 'mm-index-unknown' until every index the hour's claimants need is known — never weighed at RAY (1.0),
      // which mis-splits it between suppliers and borrowers.
      const indexUnknown = new Array<bigint>(H).fill(0n)
      for (let h = 0; h < H; h++) {
        const I = ledger.amounts[h]
        if (I === 0n) continue
        if (w.hourBlocks[h].last <= MM_COVERAGE_FROM_BLOCK) { beforeB0[h] += I; continue }
        const block = h === 0 ? w.openBlock : w.hourBlocks[h - 1].last
        const ts = h === 0 ? w.openTs : w.hourBlocks[h - 1].lastTs
        const suppliers = scaledAt(supply.contract, h)
        const borrowers = debt ? scaledAt(debt.contract, h) : []
        const li = suppliers.length ? book.indexAt(supply.pool, supply.reserve, 'supply', block, ts) : RAY
        const di = borrowers.length ? book.indexAt(debt!.pool, debt!.reserve, 'debt', block, ts) : RAY
        if (li == null || di == null) { indexUnknown[h] += I; continue }
        const claims: Array<[string, bigint]> = []
        let net = 0n
        for (const [holder, s] of suppliers) { const c = (s * li) / RAY; claims.push([holder, c]); net += c }
        for (const [holder, s] of borrowers) { const c = -(s * di) / RAY; claims.push([holder, c]); net += c }
        const U = ledger.units?.[h] && ledger.units[h] > 0n ? ledger.units[h] : net
        if (U <= 0n || !claims.length) { remainder[h] += I; continue }
        let given = 0n
        for (const [holder, c] of claims) {
          const part = (I * c) / U
          if (part === 0n) continue
          const account = accountOf(holder)
          let l = parts.get(account)
          if (!l) {
            l = { holder: account, stream: ledger.stream, pot: ledger.pot, via: joinVia(ledger.via, kind), asset: ledger.asset, held: c > 0n ? supply.aTokenAsset : null, price: ledger.price, amounts: new Array<bigint>(H).fill(0n) }
            parts.set(account, l)
          }
          l.amounts[h] += part
          given += part
        }
        remainder[h] += I - given
      }
      return { parts: [...parts.values()], remainder, remainderVia: 'custody:atoken-remainder', more: [{ via: 'mm-before-b0', amounts: beforeB0 }, { via: 'mm-index-unknown', amounts: indexUnknown }] }
    },
  }
}

/**
 * The whole window: builders, custody pass-through, classification, valuation.
 * `anchor` is month m's anchor (null: the window opens from scratch — each
 * builder reconstructs its opening from raw). The returned anchorOut is the
 * exposure at the window's last block (anchor(m+1) when the window is month m).
 */
export async function computeUserRevenueWindow(client: ClickHouseClient, w: FoldWindow, anchor: AnchorIn | null): Promise<WindowResult> {
  const ms: Record<string, number> = {}
  const timed = async <T>(name: string, f: () => Promise<T>): Promise<T> => {
    const t = Date.now()
    try { return await f() } finally { ms[name] = (ms[name] ?? 0) + Date.now() - t }
  }
  const [protocol, contracts, ssPools, xykPools, bindings] = await timed('registry', () => Promise.all([
    loadProtocolHolders(client), loadMmContracts(client), loadStableswapPools(client), loadXykPools(client), loadEvmBindings(client),
  ]))
  const pricer = new HourPricer(w)
  await timed('prices', () => pricer.load(client, [...allExplorerAssets().map(a => a.assetId), 0, 1]))
  const boundOwners = new Map([...bindings].map(([h160, owner]) => [ethMappedAccount(h160), owner]))
  const sink = new FactSink(w, pricer, { protocol: protocol.set, user: protocol.user, custody: protocol.custody }, boundOwners)

  // Custody accounts by their own id and by the H160 an EVM contract sees them as.
  const ssByAccount = new Map(ssPools.map(p => [p.account, p.poolId]))
  const xykByAccount = new Map(xykPools.map(p => [p.account, p.lpAsset]))
  const custodyByH160 = new Map<string, string>()
  for (const a of [OMNIPOOL_ACCOUNT, ...ssByAccount.keys(), ...xykByAccount.keys()]) custodyByH160.set(h160Of(a), a)
  const accountOf = mmAccountOf(custodyByH160, bindings)

  // Opening exposures.
  const anchorOf = (pot: string) => anchor?.rows.filter(r => r.pot === pot) ?? null
  const mmAnchor = anchor ? { rows: anchorOf('mm')!, fromBlock: anchor.block } : null
  const balAnchor = (prefix: string) => anchor
    ? (() => {
        const m = new Map<number, Map<string, bigint>>()
        for (const r of anchor.rows) {
          if (!r.pot.startsWith(prefix)) continue
          const a = Number(r.pot.slice(prefix.length))
          const mm = m.get(a) ?? new Map<string, bigint>()
          mm.set(r.holder, r.units)
          m.set(a, mm)
        }
        return m
      })()
    : null
  const ssAssets = await timed('registry', async () => (await rows<{ p: string }>(client, 'SELECT DISTINCT pool_id AS p FROM price_data.stableswap_pool_state_history ORDER BY p', {}, 'ur:ss-ids')).map(r => Number(r.p)))
  const xykAssets = xykPools.map(p => p.lpAsset)
  // Sequential on purpose: each read is large, and a result left unread while the
  // process parses another stalls ClickHouse's socket write (30 s send timeout).
  // Coverage starts at B0: a window before it holds nothing, one spanning it opens at the B0 anchor.
  const opening = await timed('mm-opening', async () => w.lastBlock < MM_COVERAGE_FROM_BLOCK
    ? new Map<string, bigint>()
    : loadOpeningScaled(client, contracts, Math.max(w.openBlock, MM_COVERAGE_FROM_BLOCK), mmAnchor && anchor!.block >= MM_COVERAGE_FROM_BLOCK ? mmAnchor : null))
  const ssBalances = await timed('ss-balances', () => BalanceBook.load(client, w, ssAssets, balAnchor('bal:'), anchor?.block ?? 0))
  const xykBalances = await timed('xyk-balances', () => BalanceBook.load(client, w, xykAssets, balAnchor('xyk:'), anchor?.block ?? 0, 'xyk'))
  const omnipool = await timed('omnipool-book', () => OmnipoolBook.load(client, w))
  const tokenBalances = await timed('token-balances', () => BalanceBook.load(client, w, [...TOKEN_BALANCE_ASSETS], balAnchor('tok:'), anchor?.block ?? 0))
  const erc20Books = new Map<string, BalanceBook>()
  // The month anchor's ERC-20 checkpoints (holder balances at its block), from the build that wrote the mark on.
  const erc20Ckpt = anchor && anchor.rows.some(r => r.pot === CHECKPOINT_POT && r.exposure_id === ERC20_CHECKPOINT_MARK) ? anchor : null
  for (const t of ACCRUING_TOKENS) {
    if (!t.erc20) continue
    const pot = erc20CheckpointPot(t.erc20)
    const ckpt = erc20Ckpt ? { block: erc20Ckpt.block, monthStart: w.monthStart, balances: new Map(erc20Ckpt.rows.filter(r => r.pot === pot).map(r => [r.holder, r.units] as const)) } : null
    erc20Books.set(t.erc20, await timed('token-balances', () => loadErc20Book(client, w, t.erc20!, t.token, ckpt)))
  }

  const mm = await timed('mm', () => buildMmInterest(client, w, contracts, opening, accountOf))
  const incentives = await timed('mm-incentives', () => buildMmIncentives(client, w, contracts, opening, mm, accountOf, assetDecimalsOrNull))
  const ledgers: Ledger[] = [...mm.ledgers, ...incentives]
  const giga = await timed('gigahdx', () => buildGigahdxYield(client, w, accountOf))
  const staking = await timed('staking', () => buildLegacyStaking(client, w, anchor))
  const voting = await timed('voting', () => buildGigahdxVoting(client, w))
  const referrals = await timed('referrals', () => buildReferralCommissions(client, w))
  const omni = await timed('omnipool', () => buildOmnipool(client, w, omnipool, sink))
  const ss = await timed('stableswap', () => buildStableswap(client, w, ssPools, ssBalances))
  const xyk = await timed('xyk', () => buildXyk(client, w, xykPools, xykBalances))
  // The replay checkpoints (farm entries, v3 pool states, vault shares) ride in the anchor from the build that
  // wrote CHECKPOINT_POT on; an older anchor opens those builders from their full history.
  const ckpt = anchor && anchor.rows.some(r => r.pot === CHECKPOINT_POT) ? anchor : null
  const farmsBuild = await timed('farms', () => buildFarmRewards(client, w, ckpt))
  const v3Build = await timed('v3', () => buildV3LpFees(client, w, ckpt))
  const v3 = v3Build.ledgers
  const pegGrid = await timed('tokens', () => loadPegGrid(client))
  const pegSegments = tokenSegments(pegGrid)
  const tokens = await timed('tokens', () => buildTokenAccrual(w, pegSegments, pegGrid, tokenBalances, erc20Books, accountOf))
  ledgers.push(...giga, ...staking.ledgers, ...voting, ...referrals, ...omni, ...ss, ...xyk, ...farmsBuild.ledgers, ...v3, ...tokens.ledgers)

  // ── custody registry ──
  const book = mm.book
  const omniResolver = omnipoolCustody(w, omnipool, sink)
  const resolvers = new Map<string, CustodyResolver>()
  for (const [account, pool] of ssByAccount) resolvers.set(account, poolCustody(w, `stableswap:${pool}`, ssBalances, pool))
  for (const [account, lp] of xykByAccount) resolvers.set(account, poolCustody(w, `xyk:${lp}`, xykBalances, lp))
  const xykFarm = await timed('xyk-farm', () => xykFarmCustody(client, w))
  const xykLpAssets = new Set(xykByAccount.values())
  const debtOf = new Map(contracts.filter(c => c.side === 'debt').map(c => [`${c.pool}:${c.reserve}`, c]))
  for (const c of contracts) {
    if (c.side !== 'supply') continue
    resolvers.set(ethMappedAccount(c.contract), aTokenClaimsCustody(w, c, debtOf.get(`${c.pool}:${c.reserve}`), book, mm.scaledAtHourStart, accountOf))
  }
  const [v3Pools, v3Vaults, lbp] = await Promise.all([
    rows<{ a: string }>(client, 'SELECT DISTINCT lower(pool_address) AS a FROM price_data.uniswap_v3_pools FINAL', {}, 'ur:v3-pools'),
    rows<{ a: string }>(client, 'SELECT DISTINCT lower(vault_address) AS a FROM price_data.uniswap_v3_vaults FINAL', {}, 'ur:v3-vaults'),
    rows<{ a: string }>(client, "SELECT DISTINCT lower(account_id) AS a FROM price_data.account_tags FINAL WHERE deleted = 0 AND label_id = 'lbp-pools'", {}, 'ur:lbp'),
  ])
  const unresolved = new Map<string, string>()
  for (const { a } of v3Pools) unresolved.set(ethMappedAccount(a), UNATTRIBUTED_VIA.v3PoolSurplus)
  for (const { a } of v3Vaults) unresolved.set(ethMappedAccount(a), 'custody:gamma-vault')
  const vaultBuild = await timed('v3-vaults', () => loadVaultCustodies(client, w, sink, accountOf, ckpt))
  for (const [account, resolver] of vaultBuild.resolvers) {
    resolvers.set(account, resolver)
    unresolved.delete(account)
  }
  for (const { a } of lbp) unresolved.set(a, 'custody:lbp')
  const custody: CustodyRegistry = {
    resolverFor(holder: string, ledger: Ledger): CustodyResolver | null {
      if (holder === OMNIPOOL_ACCOUNT) return omniResolver
      // The XYK LM account passes on only what its farmed XYK shares earn; its own balances (reward pots) are the protocol's.
      if (holder === XYK_LM_ACCOUNT) return ledger.held != null && xykLpAssets.has(ledger.held) ? xykFarm : null
      return resolvers.get(holder) ?? null
    },
    unresolvedKind: holder => unresolved.get(holder) ?? null,
  }
  await timed('book', async () => { for (const l of ledgers) await bookLedger(sink, custody, l) })
  for (const m of tokens.markers) sink.mark(m.h, 'token_accrual', `token:${m.token}`, m.reason, m.token)
  for (const m of farmsBuild.markers ?? []) sink.mark(m.h, 'farm_rewards', m.pot, m.reason, m.asset)

  // ── the exposure the window ends on ──
  const anchorOut: AnchorRow[] = []
  for (const [k, v] of mm.closing) {
    const [holder, contract] = k.split('|')
    anchorOut.push({ pot: 'mm', holder, exposure_id: contract, units: v, aux: '' })
  }
  for (const [asset, m] of ssBalances.closing()) for (const [holder, units] of m) anchorOut.push({ pot: `bal:${asset}`, holder, exposure_id: '', units, aux: '' })
  for (const [asset, m] of xykBalances.closing()) for (const [holder, units] of m) anchorOut.push({ pot: `xyk:${asset}`, holder, exposure_id: '', units, aux: '' })
  for (const [asset, m] of tokenBalances.closing()) for (const [holder, units] of m) anchorOut.push({ pot: `tok:${asset}`, holder, exposure_id: '', units, aux: '' })
  for (const p of staking.closing) anchorOut.push({ pot: 'staking', holder: p.who, exposure_id: p.position, units: p.stake, aux: `${p.cp}|${p.lifeGross}|${p.lifeSettled}` })
  if (staking.rps > 0n) anchorOut.push({ pot: 'staking:rps', holder: '', exposure_id: '', units: staking.rps, aux: '' })
  anchorOut.push(...farmsBuild.closing, ...v3Build.closing, ...vaultBuild.closing)
  for (const t of ACCRUING_TOKENS) {
    if (!t.erc20) continue
    for (const [holder, units] of erc20Closing(erc20Books.get(t.erc20)!, t.token)) anchorOut.push({ pot: erc20CheckpointPot(t.erc20), holder, exposure_id: '', units, aux: '' })
  }
  anchorOut.push({ pot: CHECKPOINT_POT, holder: '', exposure_id: 'farm|v3|vault', units: 1n, aux: '' })
  anchorOut.push({ pot: CHECKPOINT_POT, holder: '', exposure_id: ERC20_CHECKPOINT_MARK, units: 1n, aux: '' })
  anchorOut.sort((a, b) => (a.pot + a.holder + a.exposure_id < b.pot + b.holder + b.exposure_id ? -1 : 1))

  return {
    sink, anchorOut, protocolFp: protocol.fp, holderMembers: protocol.members, pegSegments,
    stats: { ledgers: ledgers.length, cells: sink.cells, unresolvedIndexUpdates: mm.unresolvedIndexUpdates, omnipoolUnstated: omnipool.unstated, farmUnstated: farmsBuild.unstated, farmUnmeasuredHours: farmsBuild.markers?.length ?? 0, farmDryGaps: farmsBuild.dryGaps, unmeasuredTokens: tokens.unmeasured, v3: [...v3Build.stats.values()].reduce((a, x) => ({ swaps: a.swaps + x.swaps, swapStateMismatch: a.swapStateMismatch + x.swapStateMismatch, dustNegative: a.dustNegative + x.dustNegative, collects: a.collects + x.collects, collectsExact: a.collectsExact + x.collectsExact }), { swaps: 0, swapStateMismatch: 0, dustNegative: 0, collects: 0, collectsExact: 0 }), ms },
  }
}
