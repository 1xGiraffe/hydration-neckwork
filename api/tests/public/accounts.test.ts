import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

// Contract tests for the three /v1/accounts endpoints. Template:
// tests/indexerRoute.test.ts — a fake ClickHouse client dispatching on SQL
// substrings, so no database is required. Fixtures are chosen so every USD figure
// is exact in decimal arithmetic: a wrong answer here is a real math bug, not a
// rounding artefact.
type Row = Record<string, unknown>

function queryResult(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

// Two 32-byte accounts and one H160, all lowercase hex per the wire convention.
const ACCOUNT_A = `0x${'11'.repeat(32)}`
const ACCOUNT_B = `0x${'22'.repeat(32)}`
const ACCOUNT_H160 = `0x${'ab'.repeat(20)}`
// The 'ETH\0'-prefixed AccountId32 an H160's ERC-20 wallet balances are stored under.
const ACCOUNT_H160_STORED = `0x45544800${'ab'.repeat(20)}0000000000000000`
// A bound EVM account: pallet-evm-accounts lets a substrate account claim an H160,
// and the AccountId32's trailing 12 bytes are arbitrary, so neither address is
// derivable from the other. Its wallet balances sit under the AccountId32.
const BOUND_EVM = `0x${'cd'.repeat(20)}`
const BOUND_SUBSTRATE = `0x${'cd'.repeat(20)}${'ef'.repeat(12)}`
// An UNBOUND substrate account: it never called EVMAccounts.bind_evm_address, so no
// binding row names it — yet the runtime still maps it to the H160 of its FIRST 20
// BYTES, and every EVM-keyed model (money market above all) files its state under
// the 'ETH\0'-prefixed form of that H160. Measured live: 744 substrate accounts are
// in this position, one of them under-reporting 46 % of its portfolio.
const UNBOUND_SUBSTRATE = `0x${'33'.repeat(20)}${'99'.repeat(12)}`
const UNBOUND_EVM_STORED = `0x45544800${'33'.repeat(20)}0000000000000000`

const CORE_POOL = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
// Hydration's per-asset ERC-20 precompile: 0x…0001 + 4-byte big-endian asset id.
const precompile = (assetId: number) => `0x${'0'.repeat(30)}01${assetId.toString(16).padStart(8, '0')}`
const HOLLAR_CONTRACT = '0x531a654d1696ed52e7275a8cede955e82620f99a'

const ASSET_ROWS: Row[] = [
  { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  // The Omnipool hub asset, which prices every position's hub leg.
  { asset_id: 1, symbol: 'LRNA', name: 'LRNA', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: 0, origin_ecosystem: 'polkadot', origin_chain_id: '0', origin_asset_id: null },
  { asset_id: 222, symbol: 'HOLLAR', name: 'Hollar', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

// DOT 4.5, HDX 0.02, LRNA 0.5, HOLLAR 1.0 — the Decimal(38,12) rendering ClickHouse
// returns.
const PRICE_ROWS: Row[] = [
  { asset_id: 0, price: '0.020000000000' },
  { asset_id: 1, price: '0.500000000000' },
  { asset_id: 5, price: '4.500000000000' },
  { asset_id: 222, price: '1.000000000000' },
]

// A: 2 DOT free + 0.5 DOT reserved, 1 HDX free, and a 3 HOLLAR ERC-20 pot the
// substrate table reads as zero.
const LATEST_BALANCE_ROWS: Row[] = [
  { account_id: ACCOUNT_A, asset_id: '5', free: '20000000000', reserved: '5000000000', last_block: 1000 },
  { account_id: ACCOUNT_A, asset_id: '0', free: '1000000000000', reserved: '0', last_block: 1010 },
  { account_id: ACCOUNT_A, asset_id: '222', free: '0', reserved: '0', last_block: 990 },
  { account_id: ACCOUNT_H160_STORED, asset_id: '0', free: '2000000000000', reserved: '0', last_block: 900 },
  { account_id: BOUND_SUBSTRATE, asset_id: '0', free: '3000000000000', reserved: '0', last_block: 880 },
]
const ERC20_BALANCE_ROWS: Row[] = [
  { account_id: ACCOUNT_A, asset_id: '222', total: '3000000000000000000' },
]

// The hourly model is read as two bounded queries: observations INSIDE the window,
// already grouped to the requested bucket by SQL, plus the state entering it.
// Window 2026-06-24T00:00Z..03:00Z at 1h: DOT 1 (seeded from the 23:00 hour) then 2
// from the 02:00 hour (bucket 2), HDX 5 from the 00:00 hour (bucket 0).
const HOURLY_BUCKET_ROWS: Row[] = [
  { account_id: ACCOUNT_A, asset_id: '5', bucket: 2, balance: '20000000000' },
  { account_id: ACCOUNT_A, asset_id: '0', bucket: 0, balance: '5000000000000' },
]
const HOURLY_SEED_ROWS: Row[] = [
  { account_id: ACCOUNT_A, asset_id: '5', balance: '10000000000' },
]
// Closed 1h candles, bucketed by SQL over the 00:00..03:00Z hourly window: DOT 4.0
// (00:00 hour → bucket 0) then 5.0 (02:00 hour → bucket 2), HDX 0.02 (bucket 0).
const CANDLE_ROWS: Row[] = [
  { asset_id: 5, bucket: 0, ts: Date.parse('2026-06-24T00:00:00Z') / 1000, close: '4.000000000000' },
  { asset_id: 5, bucket: 2, ts: Date.parse('2026-06-24T02:00:00Z') / 1000, close: '5.000000000000' },
  { asset_id: 0, bucket: 0, ts: Date.parse('2026-06-24T00:00:00Z') / 1000, close: '0.020000000000' },
]
const CANDLE_SEED_ROWS: Row[] = []
// The debt model is read as two bounded queries, like the balance model: one row per
// pool for the state ENTERING the window, and one row per (pool, bucket) for the
// observations inside it — already reduced to the bucket by SQL, because the model
// carries one row per observed block and an account's lifetime of them overflows the
// client's result cap. total_debt_base is USD with 8 decimals: 1.00 entering the
// window, 2.50 from bucket 2 on.
// Both reads are keyed by (account_id, pool) — a requested address resolves to several
// storage forms, and two forms' debts on one pool must SUM, not collapse to one.
const POSITION_SUMMARY_ROWS: Row[] = [
  { account_id: ACCOUNT_A, pool_address: CORE_POOL, seed_debt: '100000000', in_window: 1 },
]
const POSITION_BUCKET_ROWS: Row[] = [
  { account_id: ACCOUNT_A, pool_address: CORE_POOL, bucket: 2, total_debt_base: '250000000' },
]

const RESERVE_MAP_ROWS: Row[] = [
  { pool_proxy: CORE_POOL, market_key: 'core' },
]
const BINDING_ROWS: Row[] = [
  { evm_address: BOUND_EVM, account_id: BOUND_SUBSTRATE },
]

// The money-market value snapshot: `supplied`/`debt` in RAW units of the UNDERLYING
// reserve asset_id, with reserve_present=1 marking the per-reserve rows (the
// reserve_present=0 rows carry position aggregates and no per-asset amount).
const SNAPSHOT_POINTER: Row[] = [{ snapshot_id: 'snap-1', age_seconds: 240 }]
const SNAPSHOT_ROWS: Row[] = [
  // 4 DOT supplied to the money market.
  { account_id: ACCOUNT_A, asset_id: 5, supplied_raw: '40000000000', debt_raw: '0' },
  // 5 HOLLAR borrowed against it.
  { account_id: ACCOUNT_A, asset_id: 222, supplied_raw: '0', debt_raw: '5000000000000000000' },
]
// Staking-backed markets are filtered out in SQL: their collateral never left the
// holder's wallet, so counting the supplied side too would double the same money.
const STAKING_BACKED_KEYS = ['gigahdx']

// The Omnipool claim snapshot: what each position would withdraw at current pool
// state — an asset leg in the position's own asset plus a hub leg in LRNA. Bare and
// farm-deposited positions are both in it, already summed per (account, asset).
const CLAIMS_POINTER: Row[] = [{ snapshot_id: 'lp-1', age_seconds: 180 }]
const CLAIMS_ROWS: Row[] = [
  // 2 DOT + 4 LRNA = 9.00 + 2.00 = 11.00.
  { account_id: ACCOUNT_A, asset_id: 5, amount: '20000000000', hub_amount: '4000000000000' },
]

// LiquidationCall carries debtToCover in `amount` (denominated in the DEBT asset)
// and the seized collateral in `liquidated_collateral_amount` — the only amount
// that agrees with the row's own `asset_address` (the collateral reserve).
const MM_EVENT_ROWS: Row[] = [
  { block_height: 300, event_index: 2, ts: Date.parse('2026-06-24T02:30:00Z') / 1000, event_name: 'Borrow', asset_address: precompile(5), amount: '30000000000', liquidated_collateral_amount: '' },
  { block_height: 250, event_index: 5, ts: Date.parse('2026-06-24T01:30:00Z') / 1000, event_name: 'Supply', asset_address: HOLLAR_CONTRACT, amount: '2000000000000000000', liquidated_collateral_amount: '' },
  { block_height: 200, event_index: 1, ts: Date.parse('2026-06-24T00:30:00Z') / 1000, event_name: 'LiquidationCall', asset_address: precompile(5), amount: '5000', liquidated_collateral_amount: '7000000000' },
  { block_height: 100, event_index: 0, ts: Date.parse('2026-06-23T23:00:00Z') / 1000, event_name: 'UserEModeSet', asset_address: '', amount: null, liquidated_collateral_amount: '' },
]

interface Seen { query: string; params: Record<string, unknown> }

function fakeClient(overrides: {
  latest?: Row[]
  erc20?: Row[]
  hourly?: Row[]
  hourlySeed?: Row[]
  candles?: Row[]
  candleSeed?: Row[]
  positions?: Row[]
  positionBuckets?: Row[]
  events?: Row[]
  snapshotPointer?: Row[]
  snapshot?: Row[]
  claimsPointer?: Row[]
  claims?: Row[]
} = {}) {
  const seen: Seen[] = []
  // Published snapshot state, as ClickHouse actually holds it: a pointer naming the
  // live generation, and rows that exist ONLY in that generation's partition. The
  // refresher drops superseded partitions the instant it flips the pointer, so a
  // query naming any other generation legitimately reads nothing — which is why a
  // data read must resolve the generation in SQL rather than trust a cached id.
  const published = {
    mmGeneration: String((overrides.snapshotPointer ?? SNAPSHOT_POINTER)[0]?.snapshot_id ?? ''),
    lpGeneration: String((overrides.claimsPointer ?? CLAIMS_POINTER)[0]?.snapshot_id ?? ''),
    snapshotRows: overrides.snapshot ?? SNAPSHOT_ROWS,
    claimRows: overrides.claims ?? CLAIMS_ROWS,
  }
  // Which generation a data query reads: the live one when it self-pins in SQL, or
  // whatever id it hard-codes otherwise (a dropped partition, once superseded).
  const readsGeneration = (query: string, params: Record<string, unknown>, live: string) =>
    query.includes("snapshot_key = 'current'") ? live : String(params.snapshot ?? '')
  const client = {
    seen,
    published,
    /**
     * A refresh cycle: a new generation is published under both pointers and the
     * old partitions are gone. Cached pointers still name the dead generation.
     */
    republish(claimRows: Row[], snapshotRows: Row[]) {
      published.mmGeneration = 'snap-2'
      published.lpGeneration = 'lp-2'
      published.claimRows = claimRows
      published.snapshotRows = snapshotRows
    },
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      const params = query_params ?? {}
      seen.push({ query, params })
      if (query.includes('FROM price_data.assets FINAL')) return queryResult(ASSET_ROWS)
      if (query.includes('Bonds.TokenCreated')) return queryResult([])
      // Ordered before the `blocks` branch, not incidentally: the current-price
      // read names BOTH tables — it resolves its 12-hour staleness bound to a
      // block height through `blocks` so the scan still prunes on `prices`'
      // primary key — so matching on `blocks` first would answer it with block
      // boundaries and leave every holding unpriced.
      if (query.includes('FROM price_data.prices')) return queryResult(PRICE_ROWS)
      // Ordered before the `blocks` branch: the debt reads name `blocks` too (to
      // resolve the window's block-height bounds and to map a block to its bucket),
      // so matching on `blocks` first would answer them with the wrong rows.
      if (query.includes('FROM price_data.account_money_market_position_history')) {
        // The windowed read is the one that reduces to buckets in SQL; the other
        // collapses the whole history to one row per pool.
        if (query.includes('AS bucket')) {
          return queryResult(overrides.positionBuckets ?? (overrides.positions ? [] : POSITION_BUCKET_ROWS))
        }
        return queryResult(overrides.positions ?? POSITION_SUMMARY_ROWS)
      }
      if (query.includes('FROM price_data.blocks')) {
        // No route exercised here reads `blocks` on its own (/v1/status is elsewhere).
        return queryResult([])
      }
      if (query.includes('FROM price_data.account_alias_directory')) return queryResult(BINDING_ROWS)
      // The data queries name their state table in a self-pinning subquery, so they
      // must be matched BEFORE the pointer reads.
      if (query.includes('FROM price_data.money_market_account_value_snapshots')) {
        const wanted = new Set((params.accounts as string[]) ?? [])
        const generation = readsGeneration(query, params, published.mmGeneration)
        const rows = generation === published.mmGeneration ? published.snapshotRows : []
        return queryResult(rows.filter(r => wanted.has(String(r.account_id))))
      }
      if (query.includes('FROM price_data.omnipool_account_claim_snapshots')) {
        const wanted = new Set((params.accounts as string[]) ?? [])
        const generation = readsGeneration(query, params, published.lpGeneration)
        const rows = generation === published.lpGeneration ? published.claimRows : []
        return queryResult(rows.filter(r => wanted.has(String(r.account_id))))
      }
      if (query.includes('FROM price_data.money_market_account_value_snapshot_state')) {
        const [row] = overrides.snapshotPointer ?? SNAPSHOT_POINTER
        return queryResult(row ? [{ ...row, snapshot_id: published.mmGeneration }] : [])
      }
      if (query.includes('FROM price_data.omnipool_account_claim_snapshot_state')) {
        const [row] = overrides.claimsPointer ?? CLAIMS_POINTER
        return queryResult(row ? [{ ...row, snapshot_id: published.lpGeneration }] : [])
      }
      if (query.includes('FROM price_data.account_asset_latest_balances')) {
        const wanted = new Set((params.accounts as string[]) ?? [])
        return queryResult((overrides.latest ?? LATEST_BALANCE_ROWS).filter(r => wanted.has(String(r.account_id))))
      }
      if (query.includes('FROM price_data.erc20_wallet_balances')) {
        const wanted = new Set((params.accounts as string[]) ?? [])
        return queryResult((overrides.erc20 ?? ERC20_BALANCE_ROWS).filter(r => wanted.has(String(r.account_id))))
      }
      if (query.includes('FROM price_data.account_balance_hourly')) {
        // The seed query is the one with no upper bound and no bucket column.
        const isSeed = !query.includes('AS bucket')
        if (isSeed) return queryResult(overrides.hourlySeed ?? (overrides.hourly ? [] : HOURLY_SEED_ROWS))
        return queryResult(overrides.hourly ?? HOURLY_BUCKET_ROWS)
      }
      if (query.includes('FROM price_data.ohlc_1h')) {
        // The seed query carries no bucket column, like the balance seed.
        const isSeed = !query.includes('AS bucket')
        if (isSeed) return queryResult(overrides.candleSeed ?? (overrides.candles ? [] : CANDLE_SEED_ROWS))
        return queryResult(overrides.candles ?? CANDLE_ROWS)
      }
      if (query.includes('FROM price_data.atoken_reserve_map')) return queryResult(RESERVE_MAP_ROWS)
      if (query.includes('FROM price_data.account_money_market_activity')) {
        const rows = (overrides.events ?? MM_EVENT_ROWS)
          .filter(r => ((params.events as string[]) ?? []).includes(String(r.event_name)))
        if (query.includes('count()')) return queryResult([{ total: String(rows.length) }])
        const offset = Number(params.offset ?? 0)
        const limit = Number(params.limit ?? 20)
        return queryResult(rows.slice(offset, offset + limit))
      }
      throw new Error(`unexpected query: ${query}`)
    }),
  }
  return client
}

/**
 * A service-level test with its own module graph.
 *
 * services/cache.ts holds the price map, the EVM binding map and the money-market
 * snapshot pointer in process-global state, so without a reset one test's fixture
 * decides the next one's answer. The asset registry is module state too, so it is
 * reloaded into the fresh graph — otherwise every decimals lookup silently falls
 * back to the synthetic 12-decimal default and the USD assertions become fiction.
 */
async function freshBalances(client: ReturnType<typeof fakeClient>) {
  vi.resetModules()
  const assets = await import('../../src/services/explorerAssets.ts')
  await assets.loadExplorerAssets(client as never)
  const balances = await import('../../src/public/services/accountBalances.ts')
  return { ...balances, stopAssets: assets.stopExplorerAssetsRefresh }
}

let app: FastifyInstance
let client: ReturnType<typeof fakeClient>
let stopAssets: () => void

beforeAll(async () => {
  const { loadExplorerAssets, stopExplorerAssetsRefresh } = await import('../../src/services/explorerAssets.ts')
  const { buildPublicApp } = await import('../../src/public/app.ts')
  client = fakeClient()
  await loadExplorerAssets(client as never)
  stopAssets = stopExplorerAssetsRefresh
  app = await buildPublicApp({ client: client as never, logger: false })
})

afterAll(async () => {
  await app?.close()
  stopAssets?.()
})

describe('GET /v1/accounts/balances', () => {
  it('values free, reserved, ERC-20, money-market and LP positions at current prices', async () => {
    const res = await app.inject(`/v1/accounts/balances?accounts=${ACCOUNT_A}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      items: [{
        account: ACCOUNT_A,
        // 2 DOT × 4.5 + 1 HDX × 0.02 + 3 HOLLAR × 1.0 + 4 DOT supplied × 4.5
        transferableUsd: '30.02',
        // 0.5 DOT × 4.5
        lockedUsd: '2.25',
        // The claim's asset leg 2 DOT × 4.5 plus its hub leg 4 LRNA × 0.5 — a
        // position is not valued by its asset side alone.
        lpUsd: '11.00',
        // 5 HOLLAR × 1.0, reported alongside and netted out of nothing.
        debtUsd: '5.00',
        // Gross assets: transferable + locked + lp. The picker's figure is
        // totalUsd - debtUsd = 38.27.
        totalUsd: '43.27',
        // The newest observation across the account's assets.
        blockHeight: 1010,
      }],
    })
    expect(res.headers['cache-control']).toBe('public, max-age=3')
  })

  it('keeps debt out of every other field, so the picker can subtract it once', async () => {
    const probe = fakeClient()
    const services = await freshBalances(probe)
    const [row] = await services.queryLatestBalances(probe as never, [ACCOUNT_A])
    services.stopAssets()
    // The same fixture as above, asserted as an identity rather than as constants:
    // debt is separate, and total is the three asset slices — to within the cent
    // that independent rounding can cost (see the dedicated case below).
    const cents = (usd: string | null) => Math.round(Number(usd) * 100)
    const parts = cents(row.transferableUsd) + cents(row.lockedUsd) + cents(row.lpUsd)
    expect(Math.abs(cents(row.totalUsd) - parts)).toBeLessThanOrEqual(1)
    expect(row.debtUsd).toBe('5.00')
    // A borrowed asset the account does not otherwise hold must not appear as a
    // holding: the 5 HOLLAR debt leaves transferable at the wallet+supplied figure.
    expect(row.transferableUsd).toBe('30.02')
  })

  it('rounds totalUsd from the exact sum, not from the rounded parts', async () => {
    // Two slices of half a cent each: each rounds to "0.00" on its own, but the
    // account really holds a cent. Adding the published strings gives 0.00 and
    // totalUsd gives 0.01 — the total is the accurate one, and the documented
    // identity therefore holds only to within a cent.
    const dust = fakeClient({
      // 0.2 HDX × 0.02 = 0.004
      latest: [{ account_id: ACCOUNT_A, asset_id: '0', free: '200000000000', reserved: '0', last_block: 5 }],
      erc20: [],
      snapshot: [],
      // 0.008 LRNA × 0.5 = 0.004, all in the hub leg
      claims: [{ account_id: ACCOUNT_A, asset_id: 5, amount: '0', hub_amount: '8000000000' }],
    })
    const services = await freshBalances(dust)
    const [row] = await services.queryLatestBalances(dust as never, [ACCOUNT_A])
    services.stopAssets()
    expect(row.transferableUsd).toBe('0.00')
    expect(row.lpUsd).toBe('0.00')
    // 0.004 + 0.004 = 0.008, half-up to the cent.
    expect(row.totalUsd).toBe('0.01')
  })

  it('reports lpUsd 0.00 for an account with a fresh claim snapshot and no positions', async () => {
    // Present-and-zero, not null: the snapshot is current and says this account has
    // no Omnipool position. Null is reserved for "the slice is unavailable".
    const res = await app.inject(`/v1/accounts/balances?accounts=${ACCOUNT_H160}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().items[0].lpUsd).toBe('0.00')
    expect(res.json().items[0].debtUsd).toBe('0.00')
  })

  it('includes an account known only by its LP positions', async () => {
    // A position-only wallet holds no fungible balance at all, so without the claim
    // snapshot it would be reported as "no such account" despite owning liquidity.
    const lpOnly = fakeClient({
      latest: [],
      erc20: [],
      snapshot: [],
      claims: [{ account_id: ACCOUNT_B, asset_id: 5, amount: '10000000000', hub_amount: '0' }],
    })
    const services = await freshBalances(lpOnly)
    const [row] = await services.queryLatestBalances(lpOnly as never, [ACCOUNT_B])
    services.stopAssets()
    // 1 DOT × 4.5, and blockHeight 0 — the claim snapshot carries no block height.
    expect(row).toEqual({
      account: ACCOUNT_B,
      transferableUsd: '0.00',
      lockedUsd: '0.00',
      lpUsd: '4.50',
      debtUsd: '0.00',
      totalUsd: '4.50',
      blockHeight: 0,
    })
  })

  it('omits LP from lpUsd AND totalUsd when the claim snapshot has gone stale', async () => {
    // A frozen refresher must not have an hours-old withdrawal value served as
    // current, and a stale slice may not silently be counted as zero inside a total
    // that still looks complete.
    const stale = fakeClient({ claimsPointer: [{ snapshot_id: 'lp-1', age_seconds: 7200 }] })
    const staleServices = await freshBalances(stale)
    const [row] = await staleServices.queryLatestBalances(stale as never, [ACCOUNT_A])
    staleServices.stopAssets()
    expect(row.lpUsd).toBeNull()
    // 30.02 + 2.25, with the 11.00 LP claim absent rather than folded in as zero.
    expect(row.totalUsd).toBe('32.27')
    // The money-market slice has its own pointer and is unaffected.
    expect(row.debtUsd).toBe('5.00')

    // No claim snapshot at all behaves the same way: absent, never zero.
    const missing = fakeClient({ claimsPointer: [] })
    const missingServices = await freshBalances(missing)
    const [none] = await missingServices.queryLatestBalances(missing as never, [ACCOUNT_A])
    missingServices.stopAssets()
    expect(none.lpUsd).toBeNull()
    expect(none.totalUsd).toBe('32.27')
  })

  it('pins the claim read to the live snapshot partition, resolved in SQL', async () => {
    // The table's ORDER BY is (snapshot_id, position_id) with no account column, so
    // the partition predicate is the only thing bounding this read; without it the
    // query would scan every generation ever published. The generation is resolved
    // IN the query rather than passed in, so the read cannot name a dropped one.
    const probe = fakeClient()
    const services = await freshBalances(probe)
    await services.queryLatestBalances(probe as never, [ACCOUNT_A])
    services.stopAssets()
    const [claims] = probe.seen.filter(s => s.query.includes('FROM price_data.omnipool_account_claim_snapshots'))
    expect(claims.query).toContain('WHERE snapshot_id = (')
    expect(claims.query).toContain('argMax(snapshot_id, computed_at)')
    expect(claims.query).toContain('FROM price_data.omnipool_account_claim_snapshot_state')
    expect(claims.params.snapshot).toBeUndefined()
    expect(claims.query).toContain('account_id IN ({accounts:Array(String)})')
  })

  it('reads the live generation even while the cached pointer names a dropped one', async () => {
    // The pointers are cached for a minute, but the refresher republishes every ~5
    // min and DROPS the superseded partitions the instant it flips them. A read that
    // trusted the cached id would hit a dead partition and report zero LP and zero
    // debt — indistinguishable from a real spot account, and worst of all silently
    // overstating a leveraged account's picker figure by the whole of its debt.
    const probe = fakeClient()
    const services = await freshBalances(probe)
    const [before] = await services.queryLatestBalances(probe as never, [ACCOUNT_A])
    expect(before.lpUsd).toBe('11.00')
    expect(before.debtUsd).toBe('5.00')

    // A refresh cycle lands: new generation, old partitions gone, pointers in the
    // service's cache still naming the dead one.
    probe.republish(
      [{ account_id: ACCOUNT_B, asset_id: 5, amount: '20000000000', hub_amount: '4000000000000' }],
      [{ account_id: ACCOUNT_B, asset_id: 222, supplied_raw: '0', debt_raw: '5000000000000000000' }],
    )
    const [after] = await services.queryLatestBalances(probe as never, [ACCOUNT_B])
    services.stopAssets()
    // The new generation's rows, not an empty read dressed up as zero.
    expect(after.lpUsd).toBe('11.00')
    expect(after.debtUsd).toBe('5.00')
    // The cached pointer is still the stale one, so this really is the window under
    // test rather than a refreshed pointer quietly fixing it.
    const pointers = probe.seen.filter(s => s.query.includes('FROM price_data.omnipool_account_claim_snapshot_state')
      && !s.query.includes('FROM price_data.omnipool_account_claim_snapshots'))
    expect(pointers).toHaveLength(1)
  })

  it('replaces a pallet-side aToken row with the snapshot instead of adding both', async () => {
    // aDOT (1001) is the receipt for DOT supplied to the money market: its pallet
    // row carries the position as `reserved` while `free` is 0, and the snapshot
    // reports the same position as supplied DOT. Counting both would double the
    // reserved slice, so the pallet row is replaced (AGENTS.md: replace attributed
    // custody, never add it).
    const dual = fakeClient({
      latest: [
        { account_id: ACCOUNT_A, asset_id: '1001', free: '0', reserved: '40000000000', last_block: 1200 },
      ],
      erc20: [],
      claims: [],
    })
    const { queryLatestBalances, stopAssets: stop } = await freshBalances(dual)
    const [row] = await queryLatestBalances(dual as never, [ACCOUNT_A])
    stop()
    // 4 DOT supplied × 4.5 = 18.00, counted ONCE — not 36.00, and not as locked.
    expect(row).toEqual({
      account: ACCOUNT_A,
      transferableUsd: '18.00',
      lockedUsd: '0.00',
      lpUsd: '0.00',
      debtUsd: '5.00',
      totalUsd: '18.00',
      blockHeight: 1200,
    })
  })

  it('excludes staking-backed markets, whose collateral never left the wallet', async () => {
    // Staking HDX leaves the HDX in the holder's own balance and issues a receipt
    // on top, so adding the market's supplied side doubles the same money. Measured
    // on a live account before this filter: $278,897 against the explorer's
    // $192,567, the whole $86.3 k difference being one HDX balance counted twice.
    const probe = fakeClient()
    const services = await freshBalances(probe)
    await services.queryLatestBalances(probe as never, [ACCOUNT_A])
    services.stopAssets()
    const [snapshot] = probe.seen.filter(s => s.query.includes('FROM price_data.money_market_account_value_snapshots'))
    expect(snapshot.query).toContain('market_key NOT IN ({stakingBacked:Array(String)})')
    expect(snapshot.params.stakingBacked).toEqual(STAKING_BACKED_KEYS)
    // The per-reserve rows only: reserve_present=0 rows are position aggregates
    // with no per-asset amount and must never be summed.
    expect(snapshot.query).toContain('reserve_present = 1')
    // Pinned to the LIVE generation, resolved in SQL — snapshot_id is both the
    // partition key and the leading primary-key column, so this still prunes to one
    // partition while never naming an id that may since have been dropped.
    expect(snapshot.query).toContain('WHERE snapshot_id = (')
    expect(snapshot.query).toContain('argMax(snapshot_id, computed_at)')
    expect(snapshot.query).toContain('FROM price_data.money_market_account_value_snapshot_state')
    expect(snapshot.params.snapshot).toBeUndefined()
  })

  it('omits the money-market slice when the snapshot has gone stale', async () => {
    // A frozen refresher must not have months-old supplied balances served as
    // current, so the slice drops out and the figure falls back to wallet-only.
    const stale = fakeClient({ snapshotPointer: [{ snapshot_id: 'snap-1', age_seconds: 7200 }] })
    const staleServices = await freshBalances(stale)
    const [row] = await staleServices.queryLatestBalances(stale as never, [ACCOUNT_A])
    staleServices.stopAssets()
    // The 4 supplied DOT are gone; wallet-side 12.02 remains.
    expect(row.transferableUsd).toBe('12.02')
    expect(row.lockedUsd).toBe('2.25')
    // Debt rides on the same snapshot, so it is absent rather than reported as 0.
    expect(row.debtUsd).toBeNull()
    // The LP slice has its own pointer and is unaffected.
    expect(row.lpUsd).toBe('11.00')

    // No snapshot at all behaves the same way: omitted, never zero.
    const missing = fakeClient({ snapshotPointer: [] })
    const missingServices = await freshBalances(missing)
    const [none] = await missingServices.queryLatestBalances(missing as never, [ACCOUNT_A])
    missingServices.stopAssets()
    expect(none.transferableUsd).toBe('12.02')
    expect(none.debtUsd).toBeNull()
  })

  it('answers an account with no indexed balances with empty items, not 404', async () => {
    const res = await app.inject(`/v1/accounts/balances?accounts=${ACCOUNT_B}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [] })
  })

  it('reads an H160 account from its ETH-prefixed AccountId32 storage form', async () => {
    const res = await app.inject(`/v1/accounts/balances?accounts=${ACCOUNT_H160}`)
    expect(res.statusCode).toBe(200)
    // 2 HDX × 0.02, keyed back to the address the caller asked about.
    expect(res.json()).toEqual({
      items: [{
        account: ACCOUNT_H160,
        transferableUsd: '0.04',
        lockedUsd: '0.00',
        lpUsd: '0.00',
        debtUsd: '0.00',
        totalUsd: '0.04',
        blockHeight: 900,
      }],
    })
  })

  it('finds a bound EVM account from either half of its identity', async () => {
    // The wallet's balances live under the AccountId32; asking by H160 must reach
    // them, and asking by AccountId32 must not lose them. Verified against live
    // data, where a bound EVM account otherwise reported $0 while holding $831.
    const byEvm = await app.inject(`/v1/accounts/balances?accounts=${BOUND_EVM}`)
    expect(byEvm.statusCode).toBe(200)
    // 3 HDX × 0.02, keyed to the H160 the caller asked about.
    expect(byEvm.json().items).toEqual([
      { account: BOUND_EVM, transferableUsd: '0.06', lockedUsd: '0.00', lpUsd: '0.00', debtUsd: '0.00', totalUsd: '0.06', blockHeight: 880 },
    ])

    const bySubstrate = await app.inject(`/v1/accounts/balances?accounts=${BOUND_SUBSTRATE}`)
    expect(bySubstrate.json().items).toEqual([
      { account: BOUND_SUBSTRATE, transferableUsd: '0.06', lockedUsd: '0.00', lpUsd: '0.00', debtUsd: '0.00', totalUsd: '0.06', blockHeight: 880 },
    ])
  })

  it('echoes both halves of a binding with the same figures rather than dropping one', async () => {
    const res = await app.inject(`/v1/accounts/balances?accounts=${BOUND_EVM},${BOUND_SUBSTRATE}`)
    expect(res.statusCode).toBe(200)
    // Both addresses the caller asked about come back. Dropping the alias would be
    // indistinguishable from "this address holds nothing", so each is echoed with
    // the shared identity's figures; a caller indexes by `account` and must not sum.
    expect(res.json().items).toEqual([
      { account: BOUND_EVM, transferableUsd: '0.06', lockedUsd: '0.00', lpUsd: '0.00', debtUsd: '0.00', totalUsd: '0.06', blockHeight: 880 },
      { account: BOUND_SUBSTRATE, transferableUsd: '0.06', lockedUsd: '0.00', lpUsd: '0.00', debtUsd: '0.00', totalUsd: '0.06', blockHeight: 880 },
    ])
  })

  it('reaches an UNBOUND account\'s EVM-side pot through the runtime truncation', async () => {
    // The bug this pins: an account is reachable from its EVM side only when a
    // binding row names it, but `bind_evm_address` is optional — the runtime maps
    // EVERY AccountId32 to the H160 of its first 20 bytes regardless. The money
    // market files 100 % of its positions under that H160's ETH-prefixed form
    // (measured: 19,576,579 of 19,576,579 position rows), so an unbound account was
    // answered with its pallet balances alone. Live case: $1,192,271 reported
    // against the explorer's $2,210,391 — the missing $1,018,120 being one aUSDT
    // supply, 46 % of the portfolio. The explorer has always folded this form in
    // (`explorerService.ts` evmAccountForm), which is why the two disagreed.
    const unbound = fakeClient({
      latest: [
        { account_id: UNBOUND_SUBSTRATE, asset_id: '0', free: '1000000000000', reserved: '0', last_block: 1200 },
        // The EVM-side pallet pot: a separate storage key, same entity.
        { account_id: UNBOUND_EVM_STORED, asset_id: '0', free: '2000000000000', reserved: '0', last_block: 1100 },
      ],
      erc20: [],
      claims: [],
      snapshot: [
        { account_id: UNBOUND_EVM_STORED, asset_id: 5, supplied_raw: '20000000000', debt_raw: '0' },
        { account_id: UNBOUND_EVM_STORED, asset_id: 222, supplied_raw: '0', debt_raw: '3000000000000000000' },
      ],
    })
    const services = await freshBalances(unbound)
    const [row] = await services.queryLatestBalances(unbound as never, [UNBOUND_SUBSTRATE])
    services.stopAssets()
    expect(row).toEqual({
      account: UNBOUND_SUBSTRATE,
      // 1 HDX × 0.02 + 2 HDX × 0.02 (the EVM-side pot) + 2 DOT × 4.5 supplied.
      transferableUsd: '9.06',
      lockedUsd: '0.00',
      lpUsd: '0.00',
      // 3 HOLLAR × 1.0 — zero before the fix, which is exactly the "no debt for a
      // leveraged account" failure mode the honest-null discipline forbids.
      debtUsd: '3.00',
      totalUsd: '9.06',
      blockHeight: 1200,
    })
  })

  it('resolves each identity to an EXACT form set — no missing key, no stranger\'s key', async () => {
    // Asserted as exact sets, not memberships, because both failure directions matter:
    // a MISSING form is the bug fixed here (an unbound account's money-market state is
    // filed only under its truncation), and an EXTRA form would read a stranger's rows
    // under the caller's address. Exact equality is also what keeps the union
    // duplicate-free: every live binding row binds the account's OWN truncation
    // (measured 3,310 of 3,310), so the truncated form and the bound form are one key,
    // and appending instead of set-adding would count the same pallet and snapshot row
    // twice.
    const probe = fakeClient()
    const services = await freshBalances(probe)
    const formsFor = (a: string) => services.resolveSingleAccountForms(probe as never, a)
    const boundEthForm = `0x45544800${'cd'.repeat(20)}0000000000000000`
    // An account with NO binding row: itself plus the runtime truncation, nothing else.
    expect(new Set(await formsFor(UNBOUND_SUBSTRATE)))
      .toEqual(new Set([UNBOUND_SUBSTRATE, UNBOUND_EVM_STORED]))
    // Both halves of a binding resolve to the SAME three keys, in either direction.
    expect(new Set(await formsFor(BOUND_SUBSTRATE)))
      .toEqual(new Set([BOUND_SUBSTRATE, BOUND_EVM, boundEthForm]))
    expect(new Set(await formsFor(BOUND_EVM)))
      .toEqual(new Set([BOUND_SUBSTRATE, BOUND_EVM, boundEthForm]))
    // A plain account with neither a binding nor EVM-side rows still gets its
    // truncation, and never the zero-padded form (that would be someone else).
    expect(new Set(await formsFor(ACCOUNT_A)))
      .toEqual(new Set([ACCOUNT_A, `0x45544800${'11'.repeat(20)}0000000000000000`]))
    for (const a of [UNBOUND_SUBSTRATE, BOUND_SUBSTRATE, BOUND_EVM, ACCOUNT_A]) {
      const forms = await formsFor(a)
      expect(new Set(forms).size).toBe(forms.length)
    }
    services.stopAssets()
    // The bound account's figures are unchanged from before the truncation was folded
    // in: its binding already yielded the same key.
    const byEvm = await app.inject(`/v1/accounts/balances?accounts=${BOUND_SUBSTRATE}`)
    expect(byEvm.json().items).toEqual([
      { account: BOUND_SUBSTRATE, transferableUsd: '0.06', lockedUsd: '0.00', lpUsd: '0.00', debtUsd: '0.00', totalUsd: '0.06', blockHeight: 880 },
    ])
  })

  it('resolves EVM bindings through a filtered query with a defined winner', async () => {
    // The winner rule is enforced in SQL (a fake client cannot execute it), so the
    // predicate itself is what gets pinned. Without these guards an unordered
    // DISTINCT with last-write-wins could attribute a stranger's balances to an
    // address, and an ETH-prefixed account_id would let the EVM side masquerade as
    // the substrate side of its own binding.
    const probe = fakeClient()
    const services = await freshBalances(probe)
    await services.queryLatestBalances(probe as never, [`0x${'99'.repeat(32)}`])
    services.stopAssets()
    const [alias] = probe.seen.filter(s => s.query.includes('FROM price_data.account_alias_directory'))
    expect(alias).toBeDefined()
    expect(alias.query).toContain("relationship = 'explicit_binding'")
    expect(alias.query).toContain("alias_type = 'substrate_account_id'")
    // A defined winner per address, not whichever row arrived last.
    expect(alias.query).toContain('LIMIT 1 BY evm_address')
    expect(alias.query).toContain('ORDER BY evm_address, account_id')
    // Well-formed addresses only, and never an ETH-prefixed AccountId32 as the
    // "bound substrate account".
    expect(alias.query).toContain("'^0x[0-9a-f]{64}$'")
    expect(alias.query).toContain('0x45544800')
  })

  // The current-price staleness bound is a WALL-CLOCK window, not a block count.
  // As 7,200 blocks it meant 12 h only while a block was 6 s; at 2 s the same
  // constant silently becomes 4 h and every asset whose feed updates less often
  // than that drops out of the map and values as zero. That is a wrong number
  // rather than a slow one, so the denomination is pinned here.
  it('bounds current prices by hours of wall clock, not by a block count', async () => {
    const probe = fakeClient()
    const services = await freshBalances(probe)
    await services.queryLatestBalances(probe as never, [ACCOUNT_A])
    services.stopAssets()
    const [prices] = probe.seen.filter(s => s.query.includes('FROM price_data.prices'))
    expect(prices).toBeDefined()
    expect(prices.query).toContain('INTERVAL {windowHours:UInt32} HOUR')
    expect(prices.params.windowHours).toBe(12)
    // No block arithmetic anywhere on the bound: a `head - N` form is exactly the
    // 6 s-denominated shape this replaced.
    expect(prices.query).not.toMatch(/head\s*-\s*\{?\w*window/i)
    // The window is resolved to a block height so `prices` still prunes on its
    // (asset_id, block_height) primary key — a timestamp predicate on `prices`
    // itself would turn this into a full scan.
    expect(prices.query).toContain('block_height >= cutoff')
    expect(prices.query).toContain('FROM price_data.blocks')
    // Anchored on the price head's own time, never on wall clock: an indexing lag
    // must hold the window still, not shrink it toward nothing.
    expect(prices.query).toContain('SELECT max(block_height) FROM price_data.prices')
    expect(prices.query).toContain('WHERE block_height = head')
  })

  it('looks up the ERC-20 pot on the key columns rather than filtering after the read', async () => {
    // lower(account_id) would turn the account predicate into a post-read filter
    // over every holder of the asset, defeating the (asset_id, account_id) key.
    const probe = fakeClient()
    const services = await freshBalances(probe)
    await services.queryLatestBalances(probe as never, [ACCOUNT_A])
    services.stopAssets()
    const [erc20] = probe.seen.filter(s => s.query.includes('FROM price_data.erc20_wallet_balances'))
    expect(erc20.query).toContain('AND account_id IN ({accounts:Array(String)})')
    expect(erc20.query).not.toContain('lower(account_id)')
  })

  it('rejects more than 50 accounts instead of silently truncating', async () => {
    const accounts = Array.from({ length: 51 }, (_, i) => `0x${i.toString(16).padStart(64, '0')}`)
    const res = await app.inject(`/v1/accounts/balances?accounts=${accounts.join(',')}`)
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('bad_request')
  })

  it('rejects a missing or malformed address', async () => {
    expect((await app.inject('/v1/accounts/balances')).statusCode).toBe(400)
    expect((await app.inject('/v1/accounts/balances?accounts=')).statusCode).toBe(400)
    // SS58 is never accepted on this surface.
    expect((await app.inject('/v1/accounts/balances?accounts=7KATdGakyhfBGnAt3XVgXTL7cYjzRXeSZHezKNtENcbSkry2')).statusCode).toBe(400)
    expect((await app.inject('/v1/accounts/balances?accounts=0x1234')).statusCode).toBe(400)
  })
})

describe('GET /v1/accounts/:account/balance-history', () => {
  it('forward-fills per asset and values each bucket at its closed candle', async () => {
    const res = await app.inject(`/v1/accounts/${ACCOUNT_A}/balance-history?from=2026-06-24T00:00:00Z&to=2026-06-24T03:00:00Z&bucket=1h`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      referenceCurrency: 'usd',
      items: [
        // 1 DOT × 4.0 + 5 HDX × 0.02; debt 1.00 (base units ÷ 1e8)
        { timestamp: '2026-06-24T01:00:00.000Z', transferableUsd: '4.10', lockedUsd: '0.00', debtUsd: '1.00' },
        // No 01:00 candle, so the 00:00 close carries forward — never a later price.
        { timestamp: '2026-06-24T02:00:00.000Z', transferableUsd: '4.10', lockedUsd: '0.00', debtUsd: '1.00' },
        // 2 DOT × 5.0 + 5 HDX × 0.02; the 250-block position is now in range
        { timestamp: '2026-06-24T03:00:00.000Z', transferableUsd: '10.10', lockedUsd: '0.00', debtUsd: '2.50' },
      ],
    })
    expect(res.headers['cache-control']).toBe('public, max-age=60')
  })

  it('never values a bucket at a candle that had not closed yet', async () => {
    // Only the 00:00 hour is requested, so the 02:00 close must not leak in.
    const res = await app.inject(`/v1/accounts/${ACCOUNT_A}/balance-history?from=2026-06-24T00:00:00Z&to=2026-06-24T01:00:00Z`)
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toEqual([
      { timestamp: '2026-06-24T01:00:00.000Z', transferableUsd: '4.10', lockedUsd: '0.00', debtUsd: '1.00' },
    ])
  })

  it('rejects a window wider than the point cap instead of truncating it', async () => {
    const res = await app.inject(`/v1/accounts/${ACCOUNT_A}/balance-history?from=2020-01-01T00:00:00Z&to=2026-06-24T00:00:00Z&bucket=1h`)
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/1000/)
  })

  it('rejects an inverted window and a bad bucket', async () => {
    expect((await app.inject(`/v1/accounts/${ACCOUNT_A}/balance-history?from=2026-06-24T03:00:00Z&to=2026-06-24T00:00:00Z`)).statusCode).toBe(400)
    expect((await app.inject(`/v1/accounts/${ACCOUNT_A}/balance-history?from=1969-12-31T00:00:00Z&to=1970-01-02T00:00:00Z`)).statusCode).toBe(400)
    expect((await app.inject(`/v1/accounts/${ACCOUNT_A}/balance-history?bucket=5m`)).statusCode).toBe(400)
    expect((await app.inject('/v1/accounts/0xdeadbeef/balance-history')).statusCode).toBe(400)
  })

  it('drops an asset whose price feed went stale rather than valuing it at an old close', async () => {
    // HDX's only candle is 40 days before the window, past the 30-day lookback, so
    // it must contribute nothing — a dead feed may not value today's holdings.
    const stale = fakeClient({
      positions: [],
      // A single daily bucket, so SQL would place both observations in bucket 0.
      hourly: [
        { account_id: ACCOUNT_A, asset_id: '5', bucket: 0, balance: '20000000000' },
        { account_id: ACCOUNT_A, asset_id: '0', bucket: 0, balance: '5000000000000' },
      ],
      hourlySeed: [],
      candles: [
        { asset_id: 5, bucket: 0, ts: Date.parse('2026-06-24T00:00:00Z') / 1000, close: '4.000000000000' },
      ],
      // HDX's newest close is 40 days old — inside the seed read's own bound only
      // because the fake ignores it, which is exactly what the TS guard must catch.
      candleSeed: [
        { asset_id: 0, ts: Date.parse('2026-05-15T00:00:00Z') / 1000, close: '0.020000000000' },
      ],
    })
    const { buildPublicApp } = await import('../../src/public/app.ts')
    const probe = await buildPublicApp({ client: stale as never, logger: false })
    try {
      const res = await probe.inject(`/v1/accounts/${ACCOUNT_A}/balance-history?from=2026-06-24T00:00:00Z&to=2026-06-25T00:00:00Z&bucket=1d`)
      expect(res.statusCode).toBe(200)
      // 2 DOT × 4.0 only — the 5 HDX are unpriced for this bucket, not valued at 0.02.
      expect(res.json().items).toEqual([
        { timestamp: '2026-06-25T00:00:00.000Z', transferableUsd: '8.00', lockedUsd: '0.00', debtUsd: '0.00' },
      ])
    } finally {
      await probe.close()
    }
  })

  it('charts a balance held through the window with no observation inside it', async () => {
    // The in-window read is bounded to the window, so an account that simply held a
    // balance and never transacted has NO rows in it. Without the seed read the
    // series would chart zero for a wallet that never moved.
    const dormant = fakeClient({
      hourly: [],
      hourlySeed: [{ account_id: ACCOUNT_B, asset_id: '5', balance: '10000000000' }],
      positions: [],
    })
    const { buildPublicApp } = await import('../../src/public/app.ts')
    const probe = await buildPublicApp({ client: dormant as never, logger: false })
    try {
      const res = await probe.inject(`/v1/accounts/${ACCOUNT_B}/balance-history?from=2026-06-24T00:00:00Z&to=2026-06-24T02:00:00Z`)
      expect(res.statusCode).toBe(200)
      // 1 DOT × 4.0 in every bucket — carried in, not invented.
      expect(res.json().items).toEqual([
        { timestamp: '2026-06-24T01:00:00.000Z', transferableUsd: '4.00', lockedUsd: '0.00', debtUsd: '0.00' },
        { timestamp: '2026-06-24T02:00:00.000Z', transferableUsd: '4.00', lockedUsd: '0.00', debtUsd: '0.00' },
      ])
    } finally {
      await probe.close()
    }
  })

  it('bounds the hourly read to the window instead of the account lifetime', async () => {
    // Reading every hour of an account's life is O(assets x lifetime-hours) and
    // overflowed the client's 100 k result cap for a real bound EVM account. The
    // in-window read must be bucket-grouped and time-bounded at both ends.
    const probe = fakeClient()
    const { buildPublicApp } = await import('../../src/public/app.ts')
    const app2 = await buildPublicApp({ client: probe as never, logger: false })
    try {
      await app2.inject(`/v1/accounts/${ACCOUNT_A}/balance-history?from=2026-06-24T00:00:00Z&to=2026-06-24T03:00:00Z`)
      const hourly = probe.seen.filter(s => s.query.includes('FROM price_data.account_balance_hourly'))
      expect(hourly).toHaveLength(2)
      const windowed = hourly.find(s => s.query.includes('AS bucket'))!
      expect(windowed.query).toContain('interval_start >= toDateTime({from:UInt32})')
      expect(windowed.query).toContain('interval_start < toDateTime({to:UInt32})')
      expect(windowed.query).toContain('GROUP BY account_id, asset_id, bucket')
      // The seed collapses all earlier history to one row per (account, asset).
      const seed = hourly.find(s => !s.query.includes('AS bucket'))!
      expect(seed.query).toContain('GROUP BY account_id, asset_id')
    } finally {
      await app2.close()
    }
  })

  it('reduces the debt read to buckets in SQL rather than to one row per observed block', async () => {
    // Live 500 this pins: the debt read grouped by (pool_address, block_height) over
    // the account's WHOLE history with no bound at all. `account_money_market_
    // position_history` carries one row per observed block, so a busy account is
    // 412,855 such rows (129,604 of them inside a 90-day window, 1.45 M for the
    // heaviest account) against ClickHouse's 100 k result cap — the endpoint answered
    // GET /v1/accounts/…/balance-history?bucket=1d with
    // {"error":{"code":"internal","message":"internal error"}}. The fix is the same
    // one the balance and candle reads already use: group to the requested bucket in
    // SQL, so the result is O(pools × buckets) whatever the account's history.
    const probe = fakeClient()
    const { buildPublicApp } = await import('../../src/public/app.ts')
    const app2 = await buildPublicApp({ client: probe as never, logger: false })
    try {
      // A window no other case in this file uses: the route's response cache is
      // process-global, so a shared (account, window) key would be answered without
      // touching the probe client at all.
      const res = await app2.inject(`/v1/accounts/${ACCOUNT_A}/balance-history?from=2026-06-20T00:00:00Z&to=2026-06-20T03:00:00Z&bucket=1h`)
      expect(res.statusCode).toBe(200)
      const reads = probe.seen.filter(s => s.query.includes('FROM price_data.account_money_market_position_history'))
      expect(reads.length).toBe(2)
      const windowed = reads.find(s => s.query.includes('AS bucket'))!
      const summary = reads.find(s => !s.query.includes('AS bucket'))!
      expect(windowed).toBeDefined()
      // One row per (form, pool, bucket): the outermost aggregation, not per block.
      // account_id stays in the GROUP BY so two storage forms of one identity are two
      // rows the caller sums, never one that argMax collapsed.
      expect(windowed.query).toContain('GROUP BY account_id, pool_address, bucket')
      // And bounded on block_height, the model's primary key, at BOTH ends — the
      // window's own first and last indexed block.
      expect(windowed.query).toContain('block_height >= (')
      expect(windowed.query).toContain('block_height <= (')
      // The state entering the window collapses the whole earlier history to one row
      // per (form, pool), so it is O(forms x pools) however long that history is.
      expect(summary).toBeDefined()
      expect(summary.query).toContain('GROUP BY account_id, pool_address')
      expect(summary.query).not.toContain('GROUP BY account_id, pool_address, block_height')
      // The in-window probe is bounded at BOTH ends too: counting every observation
      // after the window's START would fire the windowed read for an old window on an
      // account that is merely still active today.
      expect(summary.query).toMatch(/in_window/)
      const gate = summary.query.slice(summary.query.indexOf('AS seed_debt'))
      expect(gate).toContain('block_height >= (')
      expect(gate).toContain('block_height <= (')
      for (const call of reads) expect(call.params.accounts).toEqual(expect.arrayContaining([ACCOUNT_A]))
    } finally {
      await app2.close()
    }
  })

  it('sums two storage forms\' debt on one pool instead of collapsing them to one', async () => {
    // A requested address resolves to several storage forms, and the debt read groups
    // by pool. Without account_id in that GROUP BY, two forms carrying a position on
    // the SAME pool would be argMax-collapsed to one form's number — a silent
    // under-report, and the opposite of what the supplied/debt snapshot read does
    // (it groups by (account_id, asset_id) and lets the caller sum per form).
    //
    // Unreachable on today's data — the position model is 100 % ETH-prefixed, so one
    // identity has at most one form in it — but the fix that widened the form set is
    // what made it expressible, so the invariant is encoded rather than assumed.
    const ethForm = `0x45544800${'cd'.repeat(20)}0000000000000000`
    const twoForms = fakeClient({
      positions: [
        { account_id: BOUND_SUBSTRATE, pool_address: CORE_POOL, seed_debt: '100000000', in_window: 1 },
        { account_id: ethForm, pool_address: CORE_POOL, seed_debt: '200000000', in_window: 1 },
      ],
      positionBuckets: [
        { account_id: BOUND_SUBSTRATE, pool_address: CORE_POOL, bucket: 2, total_debt_base: '250000000' },
        { account_id: ethForm, pool_address: CORE_POOL, bucket: 2, total_debt_base: '500000000' },
      ],
      hourly: [],
      hourlySeed: [],
    })
    const { buildPublicApp } = await import('../../src/public/app.ts')
    const app2 = await buildPublicApp({ client: twoForms as never, logger: false })
    try {
      const res = await app2.inject(`/v1/accounts/${BOUND_SUBSTRATE}/balance-history?from=2026-06-24T00:00:00Z&to=2026-06-24T03:00:00Z&bucket=1h`)
      expect(res.statusCode).toBe(200)
      expect(res.json().items.map((i: { debtUsd: string }) => i.debtUsd))
        // 1.00 + 2.00 entering the window, then 2.50 + 5.00 from bucket 2 — not the
        // 1.00 / 2.50 a collapse would report, and not 2.00 / 5.00 either.
        .toEqual(['3.00', '3.00', '7.50'])
    } finally {
      await app2.close()
    }
  })

  it('reads debt under the truncated EVM form, the only form the position model uses', async () => {
    // `account_money_market_position_history` is 100 % ETH-prefixed (measured:
    // 19,576,579 of 19,576,579 rows), so an unbound account's whole debt series was
    // a flat "0.00" — indistinguishable from a wallet that never borrowed.
    const probe = fakeClient()
    const { buildPublicApp } = await import('../../src/public/app.ts')
    const app2 = await buildPublicApp({ client: probe as never, logger: false })
    try {
      const res = await app2.inject(`/v1/accounts/${UNBOUND_SUBSTRATE}/balance-history?from=2026-06-24T00:00:00Z&to=2026-06-24T03:00:00Z&bucket=1h`)
      expect(res.statusCode).toBe(200)
      const reads = probe.seen.filter(s =>
        s.query.includes('FROM price_data.account_money_market_position_history')
        || s.query.includes('FROM price_data.account_balance_hourly'))
      expect(reads.length).toBeGreaterThan(0)
      for (const call of reads) expect(call.params.accounts).toContain(UNBOUND_EVM_STORED)
    } finally {
      await app2.close()
    }
  })

  it('answers an account with no history with empty items, not 404', async () => {
    const bare = fakeClient({ hourly: [], positions: [] })
    const { buildPublicApp } = await import('../../src/public/app.ts')
    const probe = await buildPublicApp({ client: bare as never, logger: false })
    try {
      const res = await probe.inject(`/v1/accounts/${ACCOUNT_B}/balance-history?from=2026-06-24T00:00:00Z&to=2026-06-24T03:00:00Z`)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ referenceCurrency: 'usd', items: [] })
    } finally {
      await probe.close()
    }
  })
})

describe('GET /v1/accounts/:account/money-market-events', () => {
  it('returns pascal-case events newest first, with the collateral amount for a liquidation', async () => {
    const res = await app.inject(`/v1/accounts/${ACCOUNT_A}/money-market-events`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      items: [
        { eventName: 'Borrow', assetId: '5', amount: '30000000000', blockHeight: 300, eventIndex: 2, timestamp: '2026-06-24T02:30:00.000Z', categoryId: null },
        { eventName: 'Supply', assetId: '222', amount: '2000000000000000000', blockHeight: 250, eventIndex: 5, timestamp: '2026-06-24T01:30:00.000Z', categoryId: null },
        // amount is the seized collateral (7 000 000 000 = 0.7 DOT), never debtToCover.
        { eventName: 'LiquidationCall', assetId: '5', amount: '7000000000', blockHeight: 200, eventIndex: 1, timestamp: '2026-06-24T00:30:00.000Z', categoryId: null },
        // The activity model carries no eMode category column, so it is explicitly null.
        { eventName: 'UserEModeSet', assetId: null, amount: null, blockHeight: 100, eventIndex: 0, timestamp: '2026-06-23T23:00:00.000Z', categoryId: null },
      ],
      totalCount: 4,
    })
    expect(res.headers['cache-control']).toBe('public, max-age=5')
  })

  it('maps a lowercase events filter to the pascal-case names the model stores', async () => {
    const probe = fakeClient()
    const { buildPublicApp } = await import('../../src/public/app.ts')
    const app2 = await buildPublicApp({ client: probe as never, logger: false })
    try {
      const res = await app2.inject(`/v1/accounts/${ACCOUNT_A}/money-market-events?events=supply,borrow`)
      expect(res.statusCode).toBe(200)
      expect(res.json().items.map((i: { eventName: string }) => i.eventName)).toEqual(['Borrow', 'Supply'])
      const activity = probe.seen.filter(s => s.query.includes('FROM price_data.account_money_market_activity'))
      expect(activity.length).toBeGreaterThan(0)
      for (const call of activity) expect(call.params.events).toEqual(['Supply', 'Borrow'])
    } finally {
      await app2.close()
    }
  })

  it('rejects an unknown event name rather than ignoring it', async () => {
    const res = await app.inject(`/v1/accounts/${ACCOUNT_A}/money-market-events?events=supply,transfer`)
    expect(res.statusCode).toBe(400)
  })

  it('keeps totalCount independent of limit and offset, with no overlap between pages', async () => {
    const probe = fakeClient()
    const { buildPublicApp } = await import('../../src/public/app.ts')
    const app2 = await buildPublicApp({ client: probe as never, logger: false })
    try {
      const first = await app2.inject(`/v1/accounts/${ACCOUNT_A}/money-market-events?limit=2&offset=0`)
      const second = await app2.inject(`/v1/accounts/${ACCOUNT_A}/money-market-events?limit=2&offset=2`)
      expect(first.json().totalCount).toBe(4)
      expect(second.json().totalCount).toBe(4)
      const firstIds = first.json().items.map((i: { blockHeight: number }) => i.blockHeight)
      const secondIds = second.json().items.map((i: { blockHeight: number }) => i.blockHeight)
      expect(firstIds).toEqual([300, 250])
      expect(secondIds).toEqual([200, 100])
      expect(firstIds.filter((id: number) => secondIds.includes(id))).toEqual([])
    } finally {
      await app2.close()
    }
  })

  it('rejects an out-of-range limit or offset instead of serving page 1', async () => {
    expect((await app.inject(`/v1/accounts/${ACCOUNT_A}/money-market-events?limit=201`)).statusCode).toBe(400)
    expect((await app.inject(`/v1/accounts/${ACCOUNT_A}/money-market-events?offset=2000000`)).statusCode).toBe(400)
  })

  it('resolves a symbol search to the reserve addresses the model files rows under', async () => {
    const probe = fakeClient()
    const { buildPublicApp } = await import('../../src/public/app.ts')
    const app2 = await buildPublicApp({ client: probe as never, logger: false })
    try {
      const res = await app2.inject(`/v1/accounts/${ACCOUNT_A}/money-market-events?search=dot`)
      expect(res.statusCode).toBe(200)
      const activity = probe.seen.filter(s => s.query.includes('FROM price_data.account_money_market_activity'))
      for (const call of activity) expect(call.params.addresses).toEqual([precompile(5)])
    } finally {
      await app2.close()
    }
  })

  it('answers a search that matches no asset with empty items, not every row', async () => {
    const res = await app.inject(`/v1/accounts/${ACCOUNT_A}/money-market-events?search=nosuchtoken`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [], totalCount: 0 })
  })

  it('reads the truncated EVM form, so an unbound account is not answered with an empty feed', async () => {
    // `account_money_market_activity` is keyed by the account's EVM-side form for
    // every row. Without the runtime truncation an unbound substrate account got
    // `{items: [], totalCount: 0}` — a 200 that reads as "this account never
    // touched the money market". Live case: the AccountId32 returned 0 events while
    // its truncated form returned the collateral-enable it actually emitted.
    const probe = fakeClient()
    const { buildPublicApp } = await import('../../src/public/app.ts')
    const app2 = await buildPublicApp({ client: probe as never, logger: false })
    try {
      const res = await app2.inject(`/v1/accounts/${UNBOUND_SUBSTRATE}/money-market-events`)
      expect(res.statusCode).toBe(200)
      const activity = probe.seen.filter(s => s.query.includes('FROM price_data.account_money_market_activity'))
      expect(activity.length).toBeGreaterThan(0)
      for (const call of activity) {
        expect(call.params.accounts).toContain(UNBOUND_EVM_STORED)
        expect(call.params.accounts).toContain(UNBOUND_SUBSTRATE)
      }
    } finally {
      await app2.close()
    }
  })
})

describe('account storage forms', () => {
  it('pads an H160 back to 32 bytes only when it is a reserved-prefix truncation', async () => {
    const { storedAccountForms } = await import('../../src/public/services/accountBalances.ts')
    // A 32-byte public key is stored as itself.
    expect(storedAccountForms(ACCOUNT_A)).toEqual([ACCOUNT_A])
    // A normal EVM wallet: itself and its ETH-prefixed AccountId32, never the
    // zero-padded form — that would be an unrelated account's key.
    expect(storedAccountForms(ACCOUNT_H160)).toEqual([ACCOUNT_H160, ACCOUNT_H160_STORED])
    // 'modl' — a pallet account whose H160 IS the runtime's truncation of it, so
    // zero-padding recovers the real AccountId32.
    const pallet = `0x6d6f646c${'00'.repeat(16)}`
    expect(storedAccountForms(pallet)).toContain(`0x6d6f646c${'00'.repeat(16)}${'0'.repeat(24)}`)
  })

  it('maps an AccountId32 to the ETH-prefixed form its EVM-side state is filed under', async () => {
    const { evmTruncationForm } = await import('../../src/public/services/accountBalances.ts')
    // The runtime's AccountId32 → H160 mapping is the FIRST 20 BYTES, and state
    // keyed by that H160 is stored as 'ETH\0' || h160 || 8 zero bytes. This holds
    // for every account, bound or not: a binding merely records the same mapping.
    expect(evmTruncationForm(UNBOUND_SUBSTRATE)).toBe(UNBOUND_EVM_STORED)
    expect(evmTruncationForm(BOUND_SUBSTRATE)).toBe(`0x45544800${'cd'.repeat(20)}0000000000000000`)
    // A pallet account truncates the same way — that is where the treasury's own
    // money-market debt is filed.
    expect(evmTruncationForm(`0x6d6f646c${'00'.repeat(16)}${'0'.repeat(24)}`))
      .toBe(`0x45544800${'6d6f646c'}${'00'.repeat(16)}${'0'.repeat(16)}`)
    // An account that IS already the truncated form has no further truncation:
    // prefixing it again would name a stranger's key.
    expect(evmTruncationForm(ACCOUNT_H160_STORED)).toBeNull()
    // An H160 is not an AccountId32; storedAccountForms already derives its forms.
    expect(evmTruncationForm(ACCOUNT_H160)).toBeNull()
  })
})

describe('money-market reserve addresses', () => {
  it('decodes the precompile and the one deployed-contract reserve', async () => {
    const { assetIdFromReserveAddress } = await import('../../src/public/services/moneyMarketEvents.ts')
    expect(assetIdFromReserveAddress(precompile(5))).toBe(5)
    expect(assetIdFromReserveAddress(precompile(1000765))).toBe(1000765)
    expect(assetIdFromReserveAddress(HOLLAR_CONTRACT.toUpperCase())).toBe(222)
    // UserEModeSet references no reserve.
    expect(assetIdFromReserveAddress('')).toBeNull()
    expect(assetIdFromReserveAddress(null)).toBeNull()
    // A contract that is neither the precompile nor a known reserve stays unresolved
    // rather than being decoded into a plausible-looking id.
    expect(assetIdFromReserveAddress(`0x${'ab'.repeat(20)}`)).toBeNull()
  })
})

describe('accounts USD arithmetic', () => {
  it('carries full precision through the sum and rounds only at the wire', async () => {
    // 1 wei-scale DOT dust ×3: each rounds to 0.00 alone, but the sum must not be
    // computed from rounded parts. 3 × 0.0000000001 DOT × 4.5 = 0.00000000135 USD.
    const dust = fakeClient({
      latest: [
        { account_id: ACCOUNT_A, asset_id: '5', free: '3', reserved: '0', last_block: 7 },
      ],
      erc20: [],
      snapshot: [],
    })
    const dustServices = await freshBalances(dust)
    const [row] = await dustServices.queryLatestBalances(dust as never, [ACCOUNT_A])
    dustServices.stopAssets()
    expect(row.transferableUsd).toBe('0.00')
    expect(row.blockHeight).toBe(7)

    // A value that must round half-up at the second decimal: 0.005 → 0.01.
    const halfUp = fakeClient({
      latest: [
        { account_id: ACCOUNT_B, asset_id: '0', free: '250000000000', reserved: '0', last_block: 9 },
      ],
      erc20: [],
      snapshot: [],
    })
    // 0.25 HDX × 0.02 = 0.005
    const halfServices = await freshBalances(halfUp)
    const [half] = await halfServices.queryLatestBalances(halfUp as never, [ACCOUNT_B])
    halfServices.stopAssets()
    expect(half.transferableUsd).toBe('0.01')
  })
})
