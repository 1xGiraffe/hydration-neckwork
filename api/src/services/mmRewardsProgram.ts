import { z } from 'zod'

// The main money market's off-chain rewards programme: PRIME paid to HUSDC and
// HUSDT suppliers through a Morpho Universal Rewards Distributor, which took over
// from the RewardsController's on-chain PRIME programmes on aHUSDC/aHUSDT when
// referendum 462 ended them (block 17,214,845; their distribution ended
// 2026-11-20 16:00 UTC, the programme's first epoch start).
//
// How it pays: an off-chain runner snapshots every supplier hourly and publishes
// `latest.json` (each asset's daily budget, the USD value eligible to share it,
// every account's eligibility and the open epoch's accrual estimate) under
// REWARDS_PROGRAM_URL. Each closed epoch becomes a merkle root of CUMULATIVE
// per-account amounts (`trees/<root>.json`), submitted to the distributor and
// claimable once its timelock passes and it is accepted: owed = the live root's
// claimable − the distributor's claimed(account, reward). The Hydration UI reads
// the same files (apps/main/src/api/rewardsDistributor*.ts); the rules below are
// its rules, restated in integer arithmetic.
//
// Two readers here:
//  * the rate: budgetPerDay × 365 × reward price ÷ eligible USD, for an ELIGIBLE
//    supplier (an account with HOLLAR debt above maxHollarDebtUsd earns nothing),
//    from an in-memory latest.json refreshed every REFRESH_MS — never a request-path
//    fetch, like externalTokenApy.ts;
//  * the claimable: read on the mm-incentives refresher's pinned block
//    (mmIncentiveService.ts) and published in its generation as rows whose
//    asset_address is DISTRIBUTOR_ROW_PREFIX + the distributor, so every surface
//    that counts unclaimed incentives counts these too. The same cycle keeps the
//    distributor's roots and the claimed amounts in memory for the not-yet-claimable
//    stages an account page lists (accountStages).

export const REWARDS_DISTRIBUTOR = '0x5ca17568846ed083fd0eb307382c69232bd787f0'
/** The asset_address of a distributor row in mm_incentive_snapshots. */
export const DISTRIBUTOR_ROW_PREFIX = 'distributor:'
export const DISTRIBUTOR_ROW_ASSET = `${DISTRIBUTOR_ROW_PREFIX}${REWARDS_DISTRIBUTOR}`
/** The programme runs on the main market's reserves only. */
export const REWARDS_PROGRAM_MARKET = 'core'
export const REWARDS_PROGRAM_URL = (process.env.MM_REWARDS_PROGRAM_URL || 'https://rewards.play.hydration.cloud').replace(/\/+$/, '')

/**
 * latest.json names each earning asset by symbol only; the reserve's underlying
 * address per name (the Hydration UI's PROGRAM_ASSET_UNDERLYING).
 */
export const PROGRAM_ASSET_UNDERLYING: Readonly<Record<string, string>> = {
  HUSDC: '0x000000000000000000000000000000010000006e',
  HUSDT: '0x000000000000000000000000000000010000006f',
  HEURC: '0x000000000000000000000000000000010000273c',
}

const REFRESH_MS = 5 * 60_000
const TIMEOUT_MS = 15_000
/** A snapshot is published after its hour ends; older than this, the file is stale (the Hydration UI's LATEST_MAX_AGE). */
export const LATEST_MAX_AGE_MS = 6 * 3_600_000
/** Internal percentage scale, positionYield's PCT_DECIMALS. */
const PCT_DECIMALS = 6
/** USD fixed point of the explorer's prices (valuation.ts). */
const USD_DECIMALS = 12

// ───────────────────────── files ─────────────────────────

const hex = (bytes: number) => z.string().regex(new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`)).transform(s => s.toLowerCase())
const address = hex(20)
const bytes32 = hex(32)
const rawAmount = z.string().regex(/^\d+$/)
const usdAmount = z.string().regex(/^\d+(\.\d+)?$/)
const unixSeconds = z.number().int().positive().lt(1e11)

const latestSchema = z.object({
  format: z.literal('hydration-rewards-latest/1'),
  asOf: z.object({ hour: unixSeconds, block: z.number().int().nonnegative(), blockTime: unixSeconds }),
  reward: z.object({ symbol: z.string(), address, decimals: z.number().int().min(0).max(36) }),
  program: z.object({ name: z.string(), sha256: z.string(), maxHollarDebtUsd: usdAmount, endsAt: unixSeconds.optional() }),
  assets: z.record(z.string(), z.object({ budgetPerDay: rawAmount.nullable(), eligibleUsd: usdAmount })),
  accounts: z.record(z.string(), z.object({ earning: z.boolean(), reason: z.string().optional(), hollarDebtUsd: usdAmount.optional() })),
  latestTree: z.object({ epoch: z.string(), root: bytes32 }).nullable(),
  // Absent from older files and dropped when malformed, so the rest still reads
  // (the Hydration UI's rule); null once the programme has ended.
  openEpoch: z.object({
    id: z.string(), start: unixSeconds, end: unixSeconds, snapshots: z.number(), expectedSnapshots: z.number(),
    accruing: z.record(z.string(), rawAmount).nullable(),
  }).nullable().optional().catch(undefined),
})

const treeSchema = z.object({
  format: z.literal('hydration-rewards-claims/1'),
  reward: address,
  root: bytes32,
  leafEncoding: z.tuple([z.literal('address'), z.literal('address'), z.literal('uint256')]),
  claims: z.record(z.string(), z.object({ claimable: rawAmount, proof: z.array(z.string()) })),
})

export interface ProgramLatest {
  /** Unix seconds the snapshot's hour starts at. */
  asOfHour: number
  asOfBlock: number
  reward: { symbol: string; address: string; decimals: number }
  program: { name: string; sha256: string; maxHollarDebtUsd: string; endsAt: number | null }
  /** Programme asset name → its daily budget (raw reward units; null while undecided) and eligible USD (decimal string). */
  assets: Map<string, { budgetPerDay: bigint | null; eligibleUsd: string }>
  /** Lowercase H160 → eligibility as of the snapshot. */
  accounts: Map<string, { earning: boolean; reason: string | null; hollarDebtUsd: string | null }>
  latestTree: { epoch: string; root: string } | null
  openEpoch: { id: string; start: number; end: number; snapshots: number; expectedSnapshots: number; accruing: Map<string, bigint> | null } | null
}

/** latest.json → ProgramLatest; throws on a file of another shape. Pure. */
export function parseProgramLatest(json: unknown): ProgramLatest {
  const f = latestSchema.parse(json)
  return {
    asOfHour: f.asOf.hour,
    asOfBlock: f.asOf.block,
    reward: f.reward,
    program: { name: f.program.name, sha256: f.program.sha256, maxHollarDebtUsd: f.program.maxHollarDebtUsd, endsAt: f.program.endsAt ?? null },
    assets: new Map(Object.entries(f.assets).map(([name, a]) => [name, { budgetPerDay: a.budgetPerDay == null ? null : BigInt(a.budgetPerDay), eligibleUsd: a.eligibleUsd }])),
    accounts: new Map(Object.entries(f.accounts).map(([acc, a]) => [acc.toLowerCase(), { earning: a.earning, reason: a.reason ?? null, hollarDebtUsd: a.hollarDebtUsd ?? null }])),
    latestTree: f.latestTree,
    openEpoch: f.openEpoch
      ? { ...f.openEpoch, accruing: f.openEpoch.accruing ? new Map(Object.entries(f.openEpoch.accruing).map(([a, v]) => [a.toLowerCase(), BigInt(v)])) : null }
      : null,
  }
}

export interface ClaimsTree {
  reward: string
  root: string
  /** Lowercase H160 → the cumulative claimable under the root (raw). */
  claims: Map<string, bigint>
  total: bigint
}

/** trees/<root>.json → ClaimsTree; throws on another shape or a file holding another root. Pure. */
export function parseClaimsTree(json: unknown, root: string): ClaimsTree {
  const f = treeSchema.parse(json)
  if (f.root !== root.toLowerCase()) throw new Error(`rewards tree ${root} holds root ${f.root}`)
  const claims = new Map<string, bigint>()
  let total = 0n
  for (const [acc, c] of Object.entries(f.claims)) {
    const v = BigInt(c.claimable)
    claims.set(acc.toLowerCase(), v)
    total += v
  }
  return { reward: f.reward, root: f.root, claims, total }
}

/** A decimal USD string as 10^-12 USD. Pure. */
export function usdScaled(usd: string): bigint {
  const [whole, frac = ''] = usd.split('.')
  return BigInt(whole || '0') * 10n ** BigInt(USD_DECIMALS) + BigInt((frac + '0'.repeat(USD_DECIMALS)).slice(0, USD_DECIMALS) || '0')
}

/** Whether the snapshot is too old to state anything from, at `nowMs`. Pure. */
export const isProgramLatestStale = (asOfHour: number, nowMs: number): boolean => nowMs - asOfHour * 1000 > LATEST_MAX_AGE_MS

/** Whether the programme has ended by `nowMs`: from its endsAt on it pays nothing more. Pure. */
export const hasProgramEnded = (endsAt: number | null, nowMs: number): boolean => endsAt != null && nowMs >= endsAt * 1000

/**
 * One programme asset's yearly rate for an eligible supplier, in internal percent
 * (10^-6 %): budgetPerDay / 10^decimals × 365 × price ÷ eligible USD × 100. The
 * budget is shared over the eligible value only, not the reserve's whole supply.
 * Null when undecided (no budget), unpriced or nothing is eligible. Pure.
 *
 * @param rewardPriceUsd the reward token's price, 10^-12 USD per whole token
 */
export function programAprPctScaled(budgetPerDay: bigint | null, rewardDecimals: number, rewardPriceUsd: bigint | null, eligibleUsd: string): bigint | null {
  if (budgetPerDay == null || rewardPriceUsd == null || rewardPriceUsd <= 0n) return null
  const eligible = usdScaled(eligibleUsd)
  if (eligible <= 0n) return null
  const num = budgetPerDay * 365n * rewardPriceUsd * 100n * 10n ** BigInt(PCT_DECIMALS)
  const den = 10n ** BigInt(rewardDecimals) * eligible
  return (num * 2n + den) / (den * 2n)
}

// ───────────────────────── stages (pure) ─────────────────────────

export type ProgramStage = 'pending' | 'closed' | 'accruing'
export interface ProgramStageAmount {
  stage: ProgramStage
  /** Raw reward units not claimable yet; an estimate while accruing. */
  amount: bigint
  /** Unix ms it should become claimable; null when unknown or already past. */
  claimableAtMs: number | null
}

/**
 * What an account has earned on the distributor that it cannot claim yet, in the
 * order it becomes claimable — under the pending root, under the newest closed
 * epoch's root, and the open epoch's estimate — the Hydration UI's
 * getAccruedRewards. Amounts under roots are cumulative, so each stage is what its
 * root adds to the ones before it; the list stops at the first input that is not
 * known (undefined), because what it holds would otherwise be shown under a later
 * stage. A null root/tree says there is none. Which of two roots is newer is told
 * by their totals. No estimate once the programme has ended. Pure.
 */
export function accountStages(inp: {
  account: string
  claimed: bigint | undefined
  /** Seconds between a root's submission and its validAt. */
  timelock: number | undefined
  nowMs: number
  liveRoot: string | null | undefined
  liveTree: ClaimsTree | null | undefined
  pending: { root: string | null; validAt: number } | null | undefined
  pendingTree: ClaimsTree | null | undefined
  latest: ProgramLatest | null | undefined
  closedTree: ClaimsTree | null | undefined
}): ProgramStageAmount[] {
  const stages: ProgramStageAmount[] = []
  const under = (root: string | null | undefined, tree: ClaimsTree | null | undefined): { amount: bigint; total: bigint } | undefined => {
    if (root === null) return { amount: 0n, total: 0n }
    if (!root || !tree) return undefined
    return { amount: tree.claims.get(inp.account) ?? 0n, total: tree.total }
  }
  const live = under(inp.liveRoot, inp.liveTree)
  if (live === undefined || inp.claimed === undefined || inp.pending === undefined) return stages
  let reached = live.amount > inp.claimed ? live.amount : inp.claimed
  let chainTotal = live.total
  if (inp.pending) {
    const p = under(inp.pending.root, inp.pendingTree)
    if (p === undefined) return stages
    if (p.amount > reached) {
      const validAt = inp.pending.validAt * 1000
      stages.push({ stage: 'pending', amount: p.amount - reached, claimableAtMs: validAt > inp.nowMs ? validAt : null })
      reached = p.amount
    }
    if (p.total > chainTotal) chainTotal = p.total
  }
  const latest = inp.latest
  if (!latest) return stages
  // The runner takes no snapshot after the end, so the file's age is judged there.
  const endsAtMs = latest.program.endsAt == null ? Infinity : latest.program.endsAt * 1000
  if (isProgramLatestStale(latest.asOfHour, Math.min(inp.nowMs, endsAtMs))) return stages
  const closed = under(latest.latestTree?.root ?? null, inp.closedTree)
  // A file behind the chain names as open an epoch the chain has a root for.
  if (closed === undefined || closed.total < chainTotal || closed.amount < reached) return stages
  if (closed.amount > reached) stages.push({ stage: 'closed', amount: closed.amount - reached, claimableAtMs: null })
  if (hasProgramEnded(latest.program.endsAt, inp.nowMs)) return stages
  const open = latest.openEpoch
  const estimate = open?.accruing?.get(inp.account) ?? 0n
  if (open && estimate > 0n) {
    const expectedAt = inp.timelock === undefined ? null : (open.end + inp.timelock) * 1000
    stages.push({ stage: 'accruing', amount: estimate, claimableAtMs: expectedAt != null && expectedAt > inp.nowMs ? expectedAt : null })
  }
  return stages
}

// ───────────────────────── reads ─────────────────────────

async function getJson(path: string): Promise<unknown | null> {
  const res = await fetch(`${REWARDS_PROGRAM_URL}/${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })
  // Not written yet: no snapshot taken, or a root's tree not served yet.
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json()
}

const trees = new Map<string, ClaimsTree>()

/** A root's claims file; a root's file never changes, so a loaded one is kept. Null while it is not served (404). */
export async function loadClaimsTree(root: string, fetchJson: (path: string) => Promise<unknown | null> = getJson): Promise<ClaimsTree | null> {
  const key = root.toLowerCase()
  const hit = trees.get(key)
  if (hit) return hit
  const json = await fetchJson(`trees/${key}.json`)
  if (json == null) return null
  const tree = parseClaimsTree(json, key)
  trees.set(key, tree)
  return tree
}

/**
 * The tree of the newest root read LIVE whose tree loaded — a lower bound for any
 * later live root, since amounts are cumulative. Never a pending or closed epoch's
 * tree: those are ahead of the chain's live root and would overstate what it pays.
 */
let lastLiveTree: ClaimsTree | null = null

let latest: { file: ProgramLatest; fetchedAt: number } | null = null
let timer: ReturnType<typeof setInterval> | null = null

async function refreshLatest(): Promise<void> {
  try {
    const json = await getJson('latest.json')
    if (json == null) return
    const file = parseProgramLatest(json)
    latest = { file, fetchedAt: Date.now() }
    // The closed epoch's tree is listed as not yet claimable; load it beside the file.
    if (file.latestTree) await loadClaimsTree(file.latestTree.root).catch(err => console.warn(`[rewards-program] closed tree ${file.latestTree?.root}: ${(err as Error).message}`))
  } catch (err) {
    console.warn(`[rewards-program] latest.json: ${(err as Error).message}`)
  }
}

/** Starts the latest.json refresher (idempotent); the first read runs at once, unawaited. */
export function initMmRewardsProgram(): void {
  if (timer) return
  void refreshLatest()
  timer = setInterval(() => { void refreshLatest() }, REFRESH_MS)
  timer.unref?.()
}

/** The newest latest.json, or null when none was read, it is stale, or the programme has ended. */
export function currentProgramLatest(nowMs = Date.now()): ProgramLatest | null {
  if (!latest) return null
  const f = latest.file
  if (isProgramLatestStale(f.asOfHour, nowMs) || hasProgramEnded(f.program.endsAt, nowMs)) return null
  return f
}

/** For tests: replace the in-memory file. */
export function setProgramLatestForTest(file: ProgramLatest | null): void {
  latest = file ? { file, fetchedAt: Date.now() } : null
}

/**
 * Every programme asset's rate for an eligible supplier, keyed by the reserve's
 * lowercase underlying address, with the reward's address. Empty while there is no
 * fresh file. `rewardPrice` is the price lookup by reward address.
 */
export function programReserveRates(rewardPrice: (rewardAddress: string) => bigint | null, nowMs = Date.now()): Map<string, { rewardAddress: string; aprPct: bigint | null }> {
  const out = new Map<string, { rewardAddress: string; aprPct: bigint | null }>()
  const f = currentProgramLatest(nowMs)
  if (!f) return out
  const price = rewardPrice(f.reward.address)
  for (const [name, a] of f.assets) {
    const underlying = PROGRAM_ASSET_UNDERLYING[name]
    if (!underlying) {
      console.warn(`[rewards-program] asset ${name} maps to no reserve; left out`)
      continue
    }
    out.set(underlying, { rewardAddress: f.reward.address, aprPct: programAprPctScaled(a.budgetPerDay, f.reward.decimals, price, a.eligibleUsd) })
  }
  return out
}

/** The programme's own facts as of its fresh snapshot, for a wire to attach its reward asset to; null without one. */
export function programMetaFields(nowMs = Date.now()): {
  name: string; marketKey: string; distributor: string; rewardAddress: string; maxHollarDebtUsd: string; endsAt: string | null; asOf: string
} | null {
  const f = currentProgramLatest(nowMs)
  if (!f) return null
  return {
    name: f.program.name,
    marketKey: REWARDS_PROGRAM_MARKET,
    distributor: REWARDS_DISTRIBUTOR,
    rewardAddress: f.reward.address,
    maxHollarDebtUsd: f.program.maxHollarDebtUsd,
    endsAt: f.program.endsAt == null ? null : new Date(f.program.endsAt * 1000).toISOString(),
    asOf: new Date(f.asOfHour * 1000).toISOString(),
  }
}

// ───────────────────────── the distributor at a block ─────────────────────────

const SEL = { root: 'ebf0c717', pendingRoot: '750588cf', timelock: 'd33219b4', claimed: '0c9cbf0e' } as const
const pad = (addr: string): string => addr.slice(2).toLowerCase().padStart(64, '0')
const ZERO_ROOT = '0x' + '0'.repeat(64)

export interface DistributorState {
  block: number
  /** Unix ms the state was read at. */
  readAt: number
  liveRoot: string | null
  liveTree: ClaimsTree | null
  pending: { root: string | null; validAt: number } | null
  pendingTree: ClaimsTree | null
  timelock: number
  /** Lowercase H160 → claimed(account, reward) for every account under a loaded tree. */
  claimed: Map<string, bigint>
  /** The tree the claimable rows were built from (the live root's, else the newest loaded one, a lower bound); null when none. */
  rowsTree: ClaimsTree | null
}

let distributorState: DistributorState | null = null
/** The newest distributor read (the mm-incentives cycle's). */
export const currentDistributorState = (): DistributorState | null => distributorState

type EthCallFn = (calls: Array<{ to: string; data: string }>, blockTag: string | { blockHash: string }) => Promise<string[]>

/**
 * The distributor at the pinned block: its live and pending roots, the timelock,
 * the trees of those roots and of latest.json's closed epoch, and claimed() for
 * every account any of them lists. A live root whose tree is not served falls
 * back to the tree of the previous live root (claimable amounts are cumulative,
 * so it understates and never overstates); with none there is nothing to list.
 */
export async function readDistributorAt(ethCall: EthCallFn, at: string | { blockHash: string }, block: number, fetchTree: (root: string) => Promise<ClaimsTree | null> = loadClaimsTree): Promise<DistributorState> {
  const [rootHex, pendingHex, timelockHex] = await ethCall([
    { to: REWARDS_DISTRIBUTOR, data: `0x${SEL.root}` },
    { to: REWARDS_DISTRIBUTOR, data: `0x${SEL.pendingRoot}` },
    { to: REWARDS_DISTRIBUTOR, data: `0x${SEL.timelock}` },
  ], at)
  const word = (h: string, i: number) => '0x' + h.slice(2 + i * 64, 2 + (i + 1) * 64)
  const liveRoot = rootHex.length >= 66 && word(rootHex, 0) !== ZERO_ROOT ? word(rootHex, 0).toLowerCase() : null
  const validAt = pendingHex.length >= 194 ? Number(BigInt(word(pendingHex, 2))) : 0
  const pendingRoot = word(pendingHex, 0)
  const pending = validAt === 0 ? null : { root: pendingRoot === ZERO_ROOT ? null : pendingRoot.toLowerCase(), validAt }
  const tryTree = async (root: string | null | undefined): Promise<ClaimsTree | null> => {
    if (!root) return null
    try { return await fetchTree(root) } catch (err) {
      console.warn(`[rewards-program] tree ${root}: ${(err as Error).message}`)
      return null
    }
  }
  const [liveTree, pendingTree, closedTree] = await Promise.all([
    tryTree(liveRoot), tryTree(pending?.root), tryTree(latest?.file.latestTree?.root),
  ])
  let rowsTree = liveTree
  if (liveTree) lastLiveTree = liveTree
  else if (liveRoot) {
    rowsTree = lastLiveTree
    console.warn(`[rewards-program] live root ${liveRoot} has no tree yet; ${rowsTree ? `claimables from root ${rowsTree.root} (a lower bound)` : 'no distributor claimables this cycle'}`)
  }
  const reward = (rowsTree ?? liveTree ?? pendingTree ?? closedTree)?.reward
  const accounts = new Set<string>()
  for (const t of [rowsTree, liveTree, pendingTree, closedTree]) for (const a of t?.claims.keys() ?? []) if (/^0x[0-9a-f]{40}$/.test(a)) accounts.add(a)
  const list = [...accounts].sort()
  const claimed = new Map<string, bigint>()
  if (reward && list.length) {
    const answers = await ethCall(list.map(a => ({ to: REWARDS_DISTRIBUTOR, data: `0x${SEL.claimed}${pad(a)}${pad(reward)}` })), at)
    list.forEach((a, i) => claimed.set(a, BigInt(answers[i] === '0x' ? 0 : answers[i])))
  }
  const state: DistributorState = { block, readAt: Date.now(), liveRoot, liveTree, pending, pendingTree, timelock: Number(BigInt(timelockHex === '0x' ? 0 : timelockHex)), claimed, rowsTree: liveRoot ? rowsTree : null }
  distributorState = state
  return state
}

/** Per account the distributor owes now: the claimable under `tree` less what it has claimed, where positive. Pure. */
export function distributorOwed(tree: ClaimsTree | null, claimed: ReadonlyMap<string, bigint>): Map<string, bigint> {
  const out = new Map<string, bigint>()
  if (!tree) return out
  for (const [acc, claimable] of tree.claims) {
    const owed = claimable - (claimed.get(acc) ?? 0n)
    if (owed > 0n) out.set(acc, owed)
  }
  return out
}

export interface ProgramAccountState {
  holder: string
  /** latest.json's eligibility; 'not-listed' when the snapshot does not list the account. */
  status: 'earning' | 'not-earning' | 'not-listed'
  reason: string | null
  hollarDebtUsd: string | null
  stages: ProgramStageAmount[]
}

/**
 * The programme as each of `h160s` meets it: its eligibility in the newest fresh
 * latest.json and its not-yet-claimable stages from the newest distributor read.
 * An account the programme has never listed and that holds nothing on the
 * distributor is left out. Null without a fresh latest.json.
 */
export function programAccounts(h160s: readonly string[], nowMs = Date.now()): { latest: ProgramLatest; accounts: ProgramAccountState[] } | null {
  const f = currentProgramLatest(nowMs)
  if (!f) return null
  const d = distributorState
  const closedTree = f.latestTree ? trees.get(f.latestTree.root) ?? undefined : null
  const accounts: ProgramAccountState[] = []
  for (const h of [...new Set(h160s.map(x => x.toLowerCase()))].sort()) {
    const listed = f.accounts.get(h)
    const stages = d ? accountStages({
      account: h, claimed: d.claimed.get(h) ?? 0n, timelock: d.timelock, nowMs,
      liveRoot: d.liveRoot, liveTree: d.liveRoot ? d.liveTree ?? undefined : null,
      pending: d.pending, pendingTree: d.pending ? (d.pending.root ? d.pendingTree ?? undefined : null) : null,
      latest: f, closedTree,
    }) : []
    if (!listed && !stages.length) continue
    accounts.push({
      holder: h,
      status: !listed ? 'not-listed' : listed.earning ? 'earning' : 'not-earning',
      reason: listed?.reason ?? null,
      hollarDebtUsd: listed?.hollarDebtUsd ?? null,
      stages,
    })
  }
  return { latest: f, accounts }
}
