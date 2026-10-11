import type { RawMoneyMarketPositionRow } from './types.js'

// One (market, holder) pair as a set member, both halves lowercase — the identity
// the open-position set below is keyed on.
export function openPositionKey(poolProxy: string, userAddress: string): string {
  return `${poolProxy.toLowerCase()}:${userAddress.toLowerCase()}`
}

// Whether an aggregate observation states a position at all: Aave answers
// getUserAccountData with zeroed totals for an account that is not a user.
export function isZeroPosition(position: Pick<RawMoneyMarketPositionRow, 'total_collateral_base' | 'total_debt_base'>): boolean {
  return position.total_collateral_base === '0' && position.total_debt_base === '0'
}

// Fold a batch of observations into the set of open (market, holder) pairs: a
// non-zero aggregate opens the pair, an all-zero one closes it. A batch is one
// block's reads, so a holder's several rows in it are the same state and their
// order does not matter.
export function trackOpenPositions(
  open: Set<string>,
  positions: Iterable<Pick<RawMoneyMarketPositionRow, 'pool_address' | 'user_address' | 'total_collateral_base' | 'total_debt_base'>>,
): void {
  for (const position of positions) {
    if (!position.user_address) continue
    const key = openPositionKey(position.pool_address, position.user_address)
    if (isZeroPosition(position)) open.delete(key)
    else open.add(key)
  }
}

// ───────────────────── reserve holder index (raw indexer) ─────────────────────
//
// Which accounts hold a reserve — supply it (its aToken) or borrow it (its
// variable-debt token) — so a price step on that reserve re-reads exactly the
// positions it moves. Folded from the tokens' own Mint / Burn / BalanceTransfer
// logs with the arithmetic of atoken_scaled_deltas_mv (clickhouse/schema/
// 001_tables.sql), so the index and the MV agree on every scaled balance.
//
// Two modes. EXACT (raw-live): every (token, holder) scaled balance, seeded at
// the worker's first block from atoken_scaled_anchor (B0) plus every indexed
// delta below that block, then folded block by block; a holder is a holder while
// its balance is non-zero. SUPERSET (range/backfill workers, whose start block's
// lower history may not be indexed yet): every account that EVER held the token,
// with the first block it is known at; a superset of the holders at any block at
// or after that one, so a read is never missed — only extra, and an extra read of
// an account with nothing open writes nothing (zero reads are not recorded unless
// the projection shows the pair open).

export const RAY = 10n ** 27n

/** One holder's scaled-balance change from one log (atoken_scaled_deltas_mv's legs). */
export interface ScaledLeg {
  contract: string
  holder: string
  delta: bigint
}

type LogLike = { contract_address: string; event_name: string | null; decoded_args_json: string; decode_status?: string }

function uintArg(args: Record<string, unknown>, key: string): bigint {
  const value = args[key]
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  return 0n
}

function holderArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.toLowerCase() : ''
}

// Aave's rayDiv (half up), with the MV's guard against a zero index.
function rayDiv(amount: bigint, index: bigint): bigint {
  return (amount * RAY + index / 2n) / index
}

/**
 * The scaled-balance legs of one decoded Mint / Burn / BalanceTransfer, exactly as
 * atoken_scaled_deltas_mv states them: a Mint credits `onBehalfOf` with
 * (value − balanceIncrease)/index (a debit when the interest exceeds the amount —
 * Aave mints the difference on a burn smaller than the accrued interest), a Burn
 * debits `from` by (value + balanceIncrease)/index, a BalanceTransfer moves its
 * (already scaled) value from `from` to `to`. Anything else yields no leg.
 */
export function scaledLegsFromLog(log: LogLike): ScaledLeg[] {
  const name = log.event_name
  if (name !== 'Mint' && name !== 'Burn' && name !== 'BalanceTransfer') return []
  if (log.decode_status != null && log.decode_status !== 'decoded') return []
  let args: Record<string, unknown>
  try {
    const parsed = JSON.parse(log.decoded_args_json) as unknown
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    args = parsed as Record<string, unknown>
  } catch {
    return []
  }
  const contract = log.contract_address.toLowerCase()
  const amount = uintArg(args, 'value')
  const legs: ScaledLeg[] = []
  if (name === 'BalanceTransfer') {
    const to = holderArg(args, 'to')
    const from = holderArg(args, 'from')
    if (to) legs.push({ contract, holder: to, delta: amount })
    if (from) legs.push({ contract, holder: from, delta: -amount })
    return legs
  }
  const balanceIncrease = uintArg(args, 'balanceIncrease')
  const rawIndex = uintArg(args, 'index')
  const index = rawIndex > 1n ? rawIndex : 1n
  if (name === 'Mint') {
    const holder = holderArg(args, 'onBehalfOf')
    if (!holder) return []
    const delta = amount >= balanceIncrease ? rayDiv(amount - balanceIncrease, index) : -rayDiv(balanceIncrease - amount, index)
    return [{ contract, holder, delta }]
  }
  const holder = holderArg(args, 'from')
  if (!holder) return []
  return [{ contract, holder, delta: -rayDiv(amount + balanceIncrease, index) }]
}

export type HolderIndexMode = 'exact' | 'superset'

/** A reserve and the tokens whose holders hold it (its aToken and variable-debt token). */
export interface ReserveTokens {
  reserve: string
  tokens: string[]
}

export class MoneyMarketHolderIndex {
  readonly mode: HolderIndexMode
  // exact: token → holder → scaled balance (zero entries removed).
  private readonly balances = new Map<string, Map<string, bigint>>()
  // superset: token → holder → first block known to hold it.
  private readonly firstSeen = new Map<string, Map<string, number>>()
  // pool → reserve → its tokens.
  private readonly markets = new Map<string, Map<string, string[]>>()
  /** Exact mode: legs that drove a balance below zero (a fold that disagrees with the chain). */
  negativeBalances = 0

  constructor(mode: HolderIndexMode) {
    this.mode = mode
  }

  /** Exact mode: the scaled balances at the end of the block before the first one folded. */
  seedBalances(rows: Iterable<{ contract: string; holder: string; scaled: bigint }>): void {
    for (const row of rows) this.addBalance(row.contract.toLowerCase(), row.holder.toLowerCase(), row.scaled)
  }

  /** Superset mode: every known holder with the first block it is known at. */
  seedHolders(rows: Iterable<{ contract: string; holder: string; firstBlock: number }>): void {
    for (const row of rows) this.markSeen(row.contract.toLowerCase(), row.holder.toLowerCase(), row.firstBlock)
  }

  /** Declare (or replace) a market's reserves and their tokens. */
  setMarket(pool: string, reserves: ReserveTokens[]): void {
    const map = new Map<string, string[]>()
    for (const r of reserves) map.set(r.reserve.toLowerCase(), r.tokens.map(t => t.toLowerCase()).filter(t => t !== '' && t !== ZERO_ADDRESS))
    this.markets.set(pool.toLowerCase(), map)
  }

  reservesOf(pool: string): string[] {
    return [...(this.markets.get(pool.toLowerCase())?.keys() ?? [])]
  }

  /**
   * Fold one block's logs. Every Mint/Burn/BalanceTransfer leg is applied whatever
   * contract emitted it (a reserve added later finds its holders already folded);
   * only the token → reserve map decides what a holder holds.
   */
  apply(logs: Iterable<LogLike>, blockHeight: number): number {
    let legs = 0
    for (const log of logs) {
      for (const leg of scaledLegsFromLog(log)) {
        legs++
        if (this.mode === 'exact') this.addBalance(leg.contract, leg.holder, leg.delta)
        else if (leg.delta > 0n) this.markSeen(leg.contract, leg.holder, blockHeight)
      }
    }
    return legs
  }

  /** The reserve's holders at `blockHeight`, sorted. */
  holdersOfReserve(pool: string, reserve: string, blockHeight: number): string[] {
    const tokens = this.markets.get(pool.toLowerCase())?.get(reserve.toLowerCase()) ?? []
    const out = new Set<string>()
    for (const token of tokens) this.collectHolders(token, blockHeight, out)
    return [...out].sort()
  }

  /** The pools one of whose reserves this token (an aToken or variable-debt token) belongs to. */
  poolsOfToken(token: string): string[] {
    const t = token.toLowerCase()
    const out: string[] = []
    for (const [pool, reserves] of this.markets) {
      for (const tokens of reserves.values()) if (tokens.includes(t)) { out.push(pool); break }
    }
    return out
  }

  /** Every holder of any of the market's reserves at `blockHeight`, sorted. */
  holdersOfMarket(pool: string, blockHeight: number): string[] {
    const out = new Set<string>()
    for (const tokens of this.markets.get(pool.toLowerCase())?.values() ?? []) {
      for (const token of tokens) this.collectHolders(token, blockHeight, out)
    }
    return [...out].sort()
  }

  /** Exact mode: one holder's scaled balance of one token (0 when none). */
  scaledBalance(token: string, holder: string): bigint {
    return this.balances.get(token.toLowerCase())?.get(holder.toLowerCase()) ?? 0n
  }

  private collectHolders(token: string, blockHeight: number, out: Set<string>): void {
    if (this.mode === 'exact') {
      for (const [holder, balance] of this.balances.get(token) ?? []) if (balance > 0n) out.add(holder)
      return
    }
    for (const [holder, first] of this.firstSeen.get(token) ?? []) if (first <= blockHeight) out.add(holder)
  }

  private addBalance(token: string, holder: string, delta: bigint): void {
    if (delta === 0n || holder === ZERO_ADDRESS) return
    let holders = this.balances.get(token)
    if (holders == null) {
      holders = new Map()
      this.balances.set(token, holders)
    }
    const next = (holders.get(holder) ?? 0n) + delta
    if (next === 0n) holders.delete(holder)
    else holders.set(holder, next)
    if (next < 0n) this.negativeBalances++
  }

  private markSeen(token: string, holder: string, blockHeight: number): void {
    if (holder === ZERO_ADDRESS) return
    let holders = this.firstSeen.get(token)
    if (holders == null) {
      holders = new Map()
      this.firstSeen.set(token, holders)
    }
    const first = holders.get(holder)
    if (first == null || blockHeight < first) holders.set(holder, blockHeight)
  }
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// ───────────────────── trigger cadence and read planning ─────────────────────

/** Why the raw indexer re-read a position at a block (evidence_json.trigger). */
export type MoneyMarketTrigger = 'config' | 'price_step' | 'cadence'

// Precedence for evidence_json.trigger when one read serves several: a config
// change re-reads the whole market, a step names its reserves, cadence is the floor.
const TRIGGER_ORDER: MoneyMarketTrigger[] = ['config', 'price_step', 'cadence']

/**
 * Chain-time cadence: every open position on `allMinutes`, and the markets listed
 * in `marketMinutes` (by key) on their own shorter grid. Deterministic — the first
 * block past an absolute boundary, from the two adjacent block timestamps — so
 * parallel range workers and replays agree.
 */
export interface MoneyMarketCadence {
  allMinutes: number
  marketMinutes: Readonly<Record<string, number>>
}

export function cadenceDueMarkets(
  previousTimestampMs: number | null | undefined,
  blockTimestampMs: number | null | undefined,
  markets: ReadonlyArray<{ key: string; pool: string }>,
  cadence: MoneyMarketCadence,
  crossed: (previous: number | null | undefined, current: number | null | undefined, intervalMs: number) => boolean,
): Set<string> {
  const due = new Set<string>()
  const all = cadence.allMinutes > 0 && crossed(previousTimestampMs, blockTimestampMs, cadence.allMinutes * 60_000)
  for (const market of markets) {
    const own = cadence.marketMinutes[market.key]
    if (all || (own != null && own > 0 && crossed(previousTimestampMs, blockTimestampMs, own * 60_000))) due.add(market.pool.toLowerCase())
  }
  return due
}

export interface PlannedRead {
  triggers: Set<MoneyMarketTrigger>
  /** The stepped reserves this holder holds (price_step only). */
  reserves: Set<string>
}

/**
 * Who the trigger phase reads at one block, per pool: one entry per (pool, user)
 * however many triggers name it. config → the market's holders plus its open
 * positions; price_step → each stepped reserve's holders; cadence → the cohort
 * (raw-live: the open positions; a range worker: the market's holder superset).
 * Pairs `alreadyRead` at this block (the block's own event-driven reads) are left
 * out — one read per (block, pool, user).
 */
export function planTriggerReads(input: {
  pools: readonly string[]
  configChanged: ReadonlySet<string>
  steps: ReadonlyMap<string, readonly string[]>
  cadenceDue: ReadonlySet<string>
  holdersOfReserve: (pool: string, reserve: string) => readonly string[]
  holdersOfMarket: (pool: string) => readonly string[]
  cadenceCohort: (pool: string) => readonly string[]
  alreadyRead: ReadonlySet<string>
}): Map<string, Map<string, PlannedRead>> {
  const plan = new Map<string, Map<string, PlannedRead>>()
  const add = (pool: string, user: string, trigger: MoneyMarketTrigger, reserve?: string): void => {
    const u = user.toLowerCase()
    if (input.alreadyRead.has(openPositionKey(pool, u))) return
    let reads = plan.get(pool)
    if (reads == null) {
      reads = new Map()
      plan.set(pool, reads)
    }
    let read = reads.get(u)
    if (read == null) {
      read = { triggers: new Set(), reserves: new Set() }
      reads.set(u, read)
    }
    read.triggers.add(trigger)
    if (reserve != null) read.reserves.add(reserve.toLowerCase())
  }
  for (const rawPool of input.pools) {
    const pool = rawPool.toLowerCase()
    if (input.configChanged.has(pool)) {
      for (const user of input.holdersOfMarket(pool)) add(pool, user, 'config')
      for (const user of input.cadenceCohort(pool)) add(pool, user, 'config')
    }
    for (const reserve of input.steps.get(pool) ?? []) {
      for (const user of input.holdersOfReserve(pool, reserve)) add(pool, user, 'price_step', reserve)
    }
    if (input.cadenceDue.has(pool)) {
      for (const user of input.cadenceCohort(pool)) add(pool, user, 'cadence')
    }
  }
  return plan
}

/** evidence_json for a trigger read: the primary trigger, every trigger, the stepped reserves. */
export function triggerEvidence(read: PlannedRead): Record<string, unknown> {
  const triggers = TRIGGER_ORDER.filter(t => read.triggers.has(t))
  const evidence: Record<string, unknown> = { trigger: triggers[0] ?? 'cadence' }
  if (triggers.length > 1) evidence.triggers = triggers
  if (read.reserves.size > 0) evidence.reserves = [...read.reserves].sort()
  return evidence
}

/** The open (pool, user) pairs of one pool, from the open-position set (sorted). */
export function openHoldersOfPool(open: ReadonlySet<string>, pool: string): string[] {
  const prefix = `${pool.toLowerCase()}:`
  const out: string[] = []
  for (const key of open) if (key.startsWith(prefix)) out.push(key.slice(prefix.length))
  return out.sort()
}
