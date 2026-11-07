import type { ClickHouseClient } from '../db/client.ts'

// The machinery every strategy's CURRENT-state refresher shares (Juicer's juicerState.ts,
// BIL's bilState.ts): the coordinated scheduler (backgroundRefresh.ts) ticks it, it reads
// a fresh snapshot when the strategy's change mark moved — its logs and its share token's
// deltas — and on every `everyTicks`-th tick regardless (rates accrue with no log), keeps
// the previous snapshot whole when a read fails (a partial one is never published), and
// states nothing once its snapshot is older than `maxAgeMs` (the refresher has stopped
// renewing it). Plus the ABI-word decoding and the indexed reads both use.

export interface StrategySnapshotBase { block: number; readAt: number }
export interface StrategyRefresher<S extends StrategySnapshotBase> {
  init(c: ClickHouseClient): void
  /** One scheduler tick. */
  refresh(): Promise<void>
  /** The snapshot, or null when there is none or it is older than the max age. */
  current(nowMs?: number): S | null
  /** Test seam. */
  setForTest(s: S | null): void
}

export function createStrategyRefresher<S extends StrategySnapshotBase>(opts: {
  /** Log prefix. */
  name: string
  /** The change mark a cycle compares (rows and newest ingest of the strategy's sources). */
  loadMark: (ch: ClickHouseClient) => Promise<string>
  /** One full read at one pinned block, or null when any read failed. */
  read: (ch: ClickHouseClient) => Promise<S | null>
  /** Publish what other processes read (the share rate table). Failure is logged, the snapshot kept. */
  publish?: (ch: ClickHouseClient, s: S) => Promise<void>
  everyTicks?: number
  maxAgeMs: number
}): StrategyRefresher<S> {
  let client: ClickHouseClient | null = null
  let snapshot: S | null = null
  let lastMark = ''
  let ticks = 0
  const everyTicks = opts.everyTicks ?? 5
  return {
    init(c) { client = c },
    async refresh() {
      if (!client) return
      ticks++
      const mark = await opts.loadMark(client)
      if (snapshot && mark === lastMark && ticks % everyTicks !== 0) return
      const next = await opts.read(client)
      if (!next) {
        console.warn(`[${opts.name}] a state read failed; keeping the previous snapshot`)
        return
      }
      snapshot = next
      lastMark = mark
      if (opts.publish) await opts.publish(client, next).catch(err => console.error(`[${opts.name}] state publish failed`, err))
    },
    current(nowMs = Date.now()) {
      return snapshot && nowMs - snapshot.readAt <= opts.maxAgeMs ? snapshot : null
    },
    setForTest(s) { snapshot = s },
  }
}

export async function selectRows<T>(ch: ClickHouseClient, query: string, query_params: Record<string, unknown> = {}): Promise<T[]> {
  return (await ch.query({ query, query_params, format: 'JSONEachRow' })).json<T>()
}

/** The change mark of a strategy's logs table and its share token's Transfer deltas (plus any extra marks). */
export async function strategyChangeMark(ch: ClickHouseClient, logsTable: string, shareContracts: readonly string[], extra = ''): Promise<string> {
  const [r] = await selectRows<{ m: string }>(ch, `SELECT concat(
      (SELECT concat(toString(count()), ':', toString(max(ingested_at))) FROM ${logsTable}), '|',
      (SELECT concat(toString(count()), ':', toString(max(ingested_at))) FROM price_data.erc20_transfer_deltas WHERE contract_address IN {cs:Array(String)})${extra ? `, '|', ${extra}` : ''}) AS m`,
  { cs: shareContracts })
  return r?.m ?? ''
}

/** An ERC-20's wallet balances at or below `block`: its Transfer deltas summed per holder (zero-address legs excluded). */
export async function loadErc20Wallet(ch: ClickHouseClient, contract: string, block: number): Promise<Map<string, bigint>> {
  const rows = await selectRows<{ holder: string; balance: string }>(ch, `SELECT holder, toString(sum(balance_delta)) AS balance
    FROM price_data.erc20_transfer_deltas FINAL
    WHERE contract_address = {c:String} AND block_height <= {b:UInt32} AND holder != '0x0000000000000000000000000000000000000000'
    GROUP BY holder`, { c: contract, b: block })
  return new Map(rows.map(r => [r.holder.toLowerCase(), BigInt(r.balance)] as [string, bigint]).filter(([, v]) => v !== 0n))
}

/** A money-market reserve's variable borrow rate (ray) as last indexed at or below `block`. */
export async function loadReserveBorrowRate(ch: ClickHouseClient, pool: string, reserve: string, block: number): Promise<string | null> {
  const [r] = await selectRows<{ rate: string }>(ch, `SELECT toString(variable_borrow_rate) AS rate FROM price_data.money_market_reserve_rates FINAL
    WHERE pool_address = {pool:String} AND reserve_address = {res:String} AND block_height <= {b:UInt32}
    ORDER BY block_height DESC, event_index DESC LIMIT 1`, { pool, res: reserve, b: block })
  return r?.rate ?? null
}

/** The i-th 32-byte word of an eth_call result, or null when it is short. */
export function word(hex: string | null | undefined, i: number): bigint | null {
  if (!hex || hex.length < 2 + 64 * (i + 1)) return null
  return BigInt('0x' + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)))
}
/** The first word of an eth_call result as an address. */
export function addressWord(hex: string | null | undefined): string | null {
  const w = word(hex, 0)
  return w == null ? null : '0x' + w.toString(16).padStart(40, '0')
}
/** A 32-byte ABI argument: an address or a number. */
export const abiArg = (v: string | number | bigint): string => (typeof v === 'string' ? v.slice(2).toLowerCase() : v.toString(16)).padStart(64, '0')
/** Aave's ReserveConfiguration: LTV (bits 0–15) and liquidation threshold (16–31) in bps, supply cap (116–151) in whole tokens. */
export function reserveConfig(config: bigint): { ltvBps: number; liquidationThresholdBps: number; supplyCap: bigint } {
  return { ltvBps: Number(config & 0xffffn), liquidationThresholdBps: Number((config >> 16n) & 0xffffn), supplyCap: (config >> 116n) & ((1n << 36n) - 1n) }
}
