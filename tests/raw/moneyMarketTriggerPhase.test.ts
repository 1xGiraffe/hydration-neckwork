import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cadenceFromEnvironment, collateralReadPlan, MoneyMarketTriggerPhase, readPairs, type ReadCollateral, type ReadPositions, type TriggerBlock } from '../../src/raw/moneyMarketTriggerPhase.ts'
import { moneyMarketEthCallBatch, snapshotMoneyMarketPositions, type EthCall } from '../../src/raw/moneyMarket.ts'
import { MM_SELECTORS } from '../../src/raw/moneyMarketPrices.ts'
import { openPositionKey, RAY } from '../../src/raw/moneyMarketSnapshot.ts'
import type { RawEvmLogRow, RawMoneyMarketPositionRow } from '../../src/raw/types.ts'

const POOL = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const GIGA = '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923'
const PROVIDER = '0xf3ba4d1b50f78301bdd7eaea9b67822a15fca691'
const GIGA_PROVIDER = '0x3c7d7b74bb625736b93d859e332f06df64635973'
const ORACLE = '0xad33c0f0c42c5a0eaa65b5895d2bdb20cb6e8760'
const GIGA_ORACLE = '0xce5bb65e09f69c038b1f1ea447eedbf1c365afcc'
const CONFIGURATOR = '0xe64c38e2fa00dfe4f1d0b92f75b8e44ebdf292e4'
const DOT = '0x0000000000000000000000000000000100000005'
const GIGAHDX = '0x000000000000000000000000000000010000029e'
const A_DOT = '0x02639ec01313c8775fae74f2dad1118c8a8a86da'
const V_DOT = '0x34321cb7334807eb718b3e1ddfaeb0c6c0403f1a'
const A_GIGA = '0x6b9ac524ec8f08c49ec80176b138d16eb461c3d8'
const ALICE = '0xa11ce00000000000000000000000000000000001'
const BOB = '0xb0b0000000000000000000000000000000000002'
const CAROL = '0xca401000000000000000000000000000000000c3'

const word = (v: bigint | string) => (typeof v === 'string' ? v.replace(/^0x/, '') : v.toString(16)).padStart(64, '0')
const arrayResult = (items: Array<bigint | string>) => `0x${word(32n)}${word(BigInt(items.length))}${items.map(word).join('')}`
const reserveData = (aToken: string, vDebt: string) => `0x${[0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n].map(word).join('')}${word(aToken)}${word(0n)}${word(vDebt)}${[0n, 0n, 0n, 0n].map(word).join('')}`

// DOT steps +1% at block 1002; GIGAHDX never moves.
function chain(dotStepAt = 1002) {
  const priceCalls: number[] = []
  const ethCall = async (batch: EthCall[], block: number) => batch.map(call => {
    const to = call.to.toLowerCase()
    if (call.data === MM_SELECTORS.addressesProvider) return `0x${word(to === POOL ? PROVIDER : GIGA_PROVIDER)}`
    if (call.data === MM_SELECTORS.getReservesList) return arrayResult(to === POOL ? [DOT] : [GIGAHDX])
    if (call.data.startsWith(MM_SELECTORS.getReserveData)) return to === POOL ? reserveData(A_DOT, V_DOT) : reserveData(A_GIGA, '0x0000000000000000000000000000000000000000')
    if (call.data === MM_SELECTORS.getPriceOracle) return `0x${word(to === PROVIDER ? ORACLE : GIGA_ORACLE)}`
    if (call.data === MM_SELECTORS.getPoolConfigurator) return `0x${word(to === PROVIDER ? CONFIGURATOR : '0x155900567996f761cc9f7332628bfc6e4b64cb33')}`
    if (call.data.startsWith(MM_SELECTORS.getAssetsPrices)) {
      priceCalls.push(block)
      return arrayResult([to === ORACLE ? (block >= dotStepAt ? 404_000_000n : 400_000_000n) : 731_356n])
    }
    return null
  })
  return { ethCall, priceCalls }
}

function mint(contract: string, holder: string, value: bigint, height: number): RawEvmLogRow {
  return {
    block_height: height, block_timestamp: '2026-10-10 10:00:00', event_index: 1, extrinsic_index: 1, call_address: '0',
    contract_address: contract, topic0: '0x', topics: [], data: '0x', decode_status: 'decoded', event_signature: null, event_name: 'Mint',
    decoded_args_json: JSON.stringify({ caller: holder, onBehalfOf: holder, value: value.toString(), balanceIncrease: '0', index: RAY.toString() }),
    participants: [], assets: [], warning: null, raw_log_json: '{}', ingest_source: 'test',
  }
}

function recordingReader() {
  const reads: Array<{ block: number; market: string; users: string[]; evidence: Record<string, Record<string, unknown>>; tombstones: number; source: string }> = []
  const readPositions: ReadPositions = async (users, blockHeight, blockTimestamp, ingestSource, options) => {
    const pool = options.marketKeys[0] === 'core' ? POOL : GIGA
    reads.push({
      block: blockHeight, market: options.marketKeys[0], users,
      evidence: Object.fromEntries(users.map(u => [u, options.evidenceFor(pool, u)])),
      tombstones: options.tombstoneFor.size, source: options.warningSourceKind,
    })
    return {
      positions: users.map((user): RawMoneyMarketPositionRow => ({
        block_height: blockHeight, block_timestamp: blockTimestamp, observation_id: `money-market-periodic:${blockHeight}:${user}`,
        user_address: user, account_id: null, pool_address: pool, total_collateral_base: '100', total_debt_base: '10',
        available_borrows_base: '0', current_liquidation_threshold: '8000', ltv: '7000', health_factor: '8000000000000000000',
        evidence_json: JSON.stringify(options.evidenceFor(pool, user)), ingest_source: ingestSource,
      })),
      warnings: [],
    }
  }
  return { reads, readPositions }
}

// getUserConfiguration stand-in: every user has reserve 0 as collateral; `fail`
// users get no word, `down` pools throw.
function recordingCollateral(opts: { fail?: string[]; down?: string[] } = {}) {
  const reads: Array<{ block: number; pool: string; users: string[] }> = []
  const readCollateral: ReadCollateral = async (users, blockHeight, poolProxy) => {
    reads.push({ block: blockHeight, pool: poolProxy, users })
    if (opts.down?.includes(poolProxy)) throw new Error('node down')
    const ok = users.filter(u => !opts.fail?.includes(u))
    return {
      flags: ok.map(user => ({ user_address: user, pool_address: poolProxy, reserve_address: poolProxy === POOL ? DOT : GIGAHDX, block_height: blockHeight, enabled: 1 as const, observed_at: '2026-10-10 10:00:00' })),
      failedUsers: users.filter(u => opts.fail?.includes(u)),
    }
  }
  return { reads, readCollateral }
}

const MARKETS = [{ key: 'core', pool: POOL }, { key: 'gigahdx', pool: GIGA }]
const at = (minute: number, second: number) => Date.UTC(2026, 9, 10, 10, minute, second)
function block(height: number, ms: number, previousMs: number | null): TriggerBlock {
  return { height, timestamp: '2026-10-10 10:00:00', timestampMs: ms, previousTimestampMs: previousMs, ingestSource: 'test' }
}

function phase(dotStepAt = 1002, collateralOpts: Parameters<typeof recordingCollateral>[0] = {}) {
  const c = chain(dotStepAt)
  const r = recordingReader()
  const col = recordingCollateral(collateralOpts)
  const p = new MoneyMarketTriggerPhase({
    markets: MARKETS, mode: 'exact', thresholdBp100: 100n, cadence: { allMinutes: 60, marketMinutes: { gigahdx: 5 } },
    ethCall: c.ethCall, readPositions: r.readPositions, readCollateral: col.readCollateral,
  })
  p.index.seedBalances([{ contract: A_DOT, holder: ALICE, scaled: 10n }, { contract: V_DOT, holder: BOB, scaled: 5n }, { contract: A_GIGA, holder: CAROL, scaled: 9n }])
  return { phase: p, chain: c, reader: r, collateral: col }
}

type Context = { alreadyRead: Set<string>; eventReads?: Set<string>; openPositions: Set<string> }
async function step(p: MoneyMarketTriggerPhase, b: TriggerBlock, logs: RawEvmLogRow[] = [], context: Context = { alreadyRead: new Set<string>(), openPositions: new Set<string>() }) {
  return p.run(b, logs, await p.observe(b, logs), { ...context, eventReads: context.eventReads ?? new Set<string>() })
}

describe('the money-market trigger phase', () => {
  it('re-reads every holder of a stepped reserve at the step block, and nobody on a quiet block', async () => {
    const { phase: p, reader } = phase()
    const quiet = await step(p, block(1001, at(1, 2), at(1, 0)))
    expect(quiet.positions).toEqual([])
    expect(reader.reads).toEqual([])
    const stepped = await step(p, block(1002, at(1, 4), at(1, 2)))
    expect(stepped.stats).toMatchObject({ steppedReserves: 1, planned: 2 })
    expect(reader.reads).toEqual([{
      block: 1002, market: 'core', users: [ALICE, BOB], tombstones: 0, source: 'trigger_snapshot',
      evidence: { [ALICE]: { trigger: 'price_step', reserves: [DOT] }, [BOB]: { trigger: 'price_step', reserves: [DOT] } },
    }])
    // The moved price is a change row.
    expect(stepped.oraclePrices).toEqual([expect.objectContaining({ block_height: 1002, reserve_address: DOT, price: '404000000', is_change: 1 })])
  })

  it('reads a holder the block\'s own logs just created, and skips a pair the block already read', async () => {
    const { phase: p, reader } = phase()
    await step(p, block(1001, at(1, 2), at(1, 0)))
    await step(p, block(1002, at(1, 4), at(1, 2)), [mint(A_DOT, CAROL, 3n, 1002)], { alreadyRead: new Set([openPositionKey(POOL, ALICE)]), openPositions: new Set() })
    expect(reader.reads[0].users).toEqual([BOB, CAROL])
  })

  it('makes the same reads at a step block whichever block the worker started on', async () => {
    const a = phase()
    await step(a.phase, block(1000, at(0, 58), at(0, 56)))
    await step(a.phase, block(1001, at(1, 0), at(0, 58)))
    await step(a.phase, block(1002, at(1, 2), at(1, 0)))
    const b = phase()
    await step(b.phase, block(1002, at(1, 2), at(1, 0)))
    expect(b.reader.reads).toEqual(a.reader.reads.filter(r => r.block === 1002))
  })

  it('cadence: GIGAHDX open positions every 5 minutes, every market on the hour (cohort = open set ∪ holders)', async () => {
    const { phase: p, reader } = phase(9_999_999)
    const open = new Set([openPositionKey(GIGA, BOB), openPositionKey(POOL, CAROL)])
    await step(p, block(1001, at(4, 58), at(4, 56)), [], { alreadyRead: new Set(), openPositions: open })
    expect(reader.reads).toEqual([])
    await step(p, block(1002, at(5, 0), at(4, 58)), [], { alreadyRead: new Set(), openPositions: open })
    expect(reader.reads.map(r => [r.market, r.users, r.evidence[r.users[0]]])).toEqual([['gigahdx', [BOB, CAROL], { trigger: 'cadence' }]])
    reader.reads.length = 0
    const hour = await step(p, block(1003, Date.UTC(2026, 9, 10, 11, 0, 0), at(59, 58)), [], { alreadyRead: new Set(), openPositions: open })
    expect(reader.reads.map(r => [r.market, r.users]).sort()).toEqual([['core', [ALICE, BOB, CAROL]], ['gigahdx', [BOB, CAROL]]])
    // The hourly block also writes a baseline of every reserve's price.
    expect(hour.oraclePrices.map(r => [r.reserve_address, r.is_change]).sort()).toEqual([[DOT, 0], [GIGAHDX, 0]])
  })

  it('a configurator log re-reads the whole market', async () => {
    const { phase: p, reader } = phase(9_999_999)
    await step(p, block(1001, at(1, 2), at(1, 0)))
    const log = { ...mint(A_DOT, ALICE, 0n, 1002), contract_address: CONFIGURATOR, event_name: null, decode_status: 'undecoded', decoded_args_json: '{}' }
    const r = await step(p, block(1002, at(1, 4), at(1, 2)), [log], { alreadyRead: new Set(), openPositions: new Set([openPositionKey(POOL, CAROL)]) })
    expect(r.stats.configPools).toBe(1)
    expect(reader.reads).toEqual([expect.objectContaining({ market: 'core', users: [ALICE, BOB, CAROL] })])
    expect(reader.reads[0].evidence[CAROL]).toEqual({ trigger: 'config' })
  })

  it('an oracle that cannot be read is a warning per market and no step — never a guessed read', async () => {
    const r = recordingReader()
    const p = new MoneyMarketTriggerPhase({
      markets: MARKETS, mode: 'exact', thresholdBp100: 100n, cadence: { allMinutes: 60, marketMinutes: {} },
      ethCall: async () => { throw new Error('node down') }, readPositions: r.readPositions, readCollateral: recordingCollateral().readCollateral,
    })
    const result = await step(p, block(1002, at(1, 4), at(1, 2)))
    expect(result.warnings.map(w => [w.source_kind, w.source_index, w.warning_code])).toEqual([
      ['oracle', POOL, 'oracle_price_read_failed'], ['oracle', GIGA, 'oracle_price_read_failed'],
    ])
    expect(r.reads).toEqual([])
  })

  it('does not fold a re-delivered block twice', async () => {
    const { phase: p } = phase(9_999_999)
    await step(p, block(1001, at(1, 2), at(1, 0)), [mint(A_DOT, CAROL, 3n, 1001)])
    await step(p, block(1001, at(1, 2), at(1, 0)), [mint(A_DOT, CAROL, 3n, 1001)])
    expect(p.index.scaledBalance(A_DOT, CAROL)).toBe(3n)
  })
})

describe('the collateral reads of the trigger phase', () => {
  it('reads nothing on a block that names nobody, prices and cadence notwithstanding', async () => {
    const { phase: p, collateral } = phase()
    await step(p, block(1001, at(1, 2), at(1, 0)))
    const stepped = await step(p, block(1002, at(1, 4), at(1, 2)), [], { alreadyRead: new Set(), openPositions: new Set([openPositionKey(POOL, CAROL)]) })
    expect(stepped.stats.planned).toBe(2)
    expect(collateral.reads).toEqual([])
    expect(stepped.collateral).toEqual([])
  })

  it('reads every pair the block\'s events named, failed position reads included, at the block', async () => {
    const { phase: p, collateral } = phase(9_999_999)
    const r = await step(p, block(1001, at(1, 2), at(1, 0)), [], {
      alreadyRead: new Set([openPositionKey(POOL, ALICE)]),
      eventReads: new Set([openPositionKey(POOL, ALICE), openPositionKey(POOL, BOB), openPositionKey(GIGA, '0x0000000000000000000000000000000000000000')]),
      openPositions: new Set(),
    })
    // The zero address is never a user.
    expect(collateral.reads).toEqual([{ block: 1001, pool: POOL, users: [ALICE, BOB] }])
    expect(r.collateral.map(f => [f.pool_address, f.user_address, f.block_height])).toEqual([[POOL, ALICE, 1001], [POOL, BOB, 1001]])
    expect(r.stats.collateralReads).toBe(2)
  })

  it('reads both sides of a reserve-token leg in the token\'s own pool (a Substrate-side aToken move logs no pool event)', async () => {
    const { phase: p, collateral } = phase(9_999_999)
    await step(p, block(1001, at(1, 2), at(1, 0)))
    const transfer = { ...mint(A_DOT, ALICE, 0n, 1002), event_name: 'BalanceTransfer', decoded_args_json: JSON.stringify({ from: ALICE, to: CAROL, value: '4', index: RAY.toString() }) }
    const unrelated = mint('0x00000000000000000000000000000000000000ff', BOB, 5n, 1002)
    await step(p, block(1002, at(1, 4), at(1, 2)), [transfer, unrelated, mint(A_GIGA, BOB, 1n, 1002)])
    expect(collateral.reads.sort((a, b) => a.pool.localeCompare(b.pool))).toEqual([
      { block: 1002, pool: POOL, users: [ALICE, CAROL] },
      { block: 1002, pool: GIGA, users: [BOB] },
    ].sort((a, b) => a.pool.localeCompare(b.pool)))
  })

  it('reads the whole market on a configuration change — its holders and open positions', async () => {
    const { phase: p, collateral } = phase(9_999_999)
    await step(p, block(1001, at(1, 2), at(1, 0)))
    const log = { ...mint(A_DOT, ALICE, 0n, 1002), contract_address: CONFIGURATOR, event_name: null, decode_status: 'undecoded', decoded_args_json: '{}' }
    await step(p, block(1002, at(1, 4), at(1, 2)), [log], { alreadyRead: new Set(), openPositions: new Set([openPositionKey(POOL, CAROL)]) })
    expect(collateral.reads).toEqual([{ block: 1002, pool: POOL, users: [ALICE, BOB, CAROL] }])
  })

  it('states an unread word and a failed pool as warnings, never as rows', async () => {
    const { phase: p } = phase(9_999_999, { fail: [BOB], down: [GIGA] })
    const r = await step(p, block(1001, at(1, 2), at(1, 0)), [], {
      alreadyRead: new Set(), eventReads: new Set([openPositionKey(POOL, ALICE), openPositionKey(POOL, BOB), openPositionKey(GIGA, CAROL)]), openPositions: new Set(),
    })
    expect(r.collateral.map(f => f.user_address)).toEqual([ALICE])
    expect(r.warnings.map(w => [w.source_kind, w.source_index, w.warning_code, w.warning]).sort()).toEqual([
      ['collateral_snapshot', `${POOL}:${BOB}`, 'collateral_eth_call_failed', 'getUserConfiguration returned no word'],
      ['collateral_snapshot', `${GIGA}:${CAROL}`, 'collateral_eth_call_failed', 'node down'],
    ])
  })

  it('plans one read per (pool, user) across the three sources, known pools only', () => {
    const plan = collateralReadPlan({
      pools: [POOL, GIGA],
      eventReads: new Set([openPositionKey(POOL, ALICE), openPositionKey('0x00000000000000000000000000000000000000aa', BOB)]),
      legHolders: new Map([[POOL, new Set([ALICE.toUpperCase().replace('0X', '0x'), BOB])]]),
      configReads: new Map([[GIGA, [CAROL]]]),
    })
    expect(plan).toEqual(new Map([[POOL, [ALICE, BOB]], [GIGA, [CAROL]]]))
  })
})

describe('trigger phase helpers', () => {
  it('collects the pairs a batch of rows read', () => {
    expect(readPairs([{ pool_address: POOL.toUpperCase().replace('0X', '0x'), user_address: ALICE }, { pool_address: POOL, user_address: '' }]))
      .toEqual(new Set([openPositionKey(POOL, ALICE)]))
  })

  it('reads the cadence from the environment (60 / 5 minutes by default)', () => {
    expect(cadenceFromEnvironment({})).toEqual({ allMinutes: 60, marketMinutes: { gigahdx: 5 } })
    expect(cadenceFromEnvironment({ RAW_MM_CADENCE_MINUTES: '30', RAW_MM_GIGAHDX_CADENCE_MINUTES: '0' })).toEqual({ allMinutes: 30, marketMinutes: { gigahdx: 0 } })
    expect(() => cadenceFromEnvironment({ RAW_MM_CADENCE_MINUTES: 'hourly' })).toThrow()
  })
})

describe('trigger reads through snapshotMoneyMarketPositions', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })
  const USER = '0xf34e845538cc8a498edd97d7cde16fdfef3d4d99'

  it('carries the trigger evidence and the periodic observation id (ranked at the end of the block)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ result: `0x${[1000n, 200n, 800n, 7000n, 4000n, 3n].map(v => v.toString(16).padStart(64, '0')).join('')}` }),
    } as unknown as Response)
    const result = await snapshotMoneyMarketPositions([USER], 15_000_000, '2026-10-10 10:00:00', 'rpc', {
      marketKeys: ['gigahdx'], evidenceFor: () => ({ trigger: 'price_step', reserves: [GIGAHDX] }), warningSourceKind: 'trigger_snapshot',
    })
    expect(result.positions[0].observation_id).toBe(`money-market-periodic:gigahdx:15000000:${USER}`)
    expect(JSON.parse(result.positions[0].evidence_json)).toMatchObject({ trigger: 'price_step', reserves: [GIGAHDX], pool: GIGA })
  })

  it('names the pool in a failed trigger read\'s warning so two markets never collapse into one row', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'))
    const result = await snapshotMoneyMarketPositions([USER], 15_000_000, '2026-10-10 10:00:00', 'rpc', {
      marketKeys: ['core', 'gigahdx'], evidenceFor: () => ({ trigger: 'cadence' }), warningSourceKind: 'trigger_snapshot',
    })
    expect(result.warnings.map(w => [w.source_kind, w.source_index]).sort()).toEqual([
      ['trigger_snapshot', `${POOL}:${USER}`], ['trigger_snapshot', `${GIGA}:${USER}`],
    ])
  })

  it('batches eth_calls in one request and answers a reverted call with null', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      json: async () => [{ id: 1, error: { message: 'revert' } }, { id: 0, result: '0x01' }],
    } as unknown as Response)
    expect(await moneyMarketEthCallBatch([{ to: POOL, data: '0x01' }, { to: POOL, data: '0x02' }], 255)).toEqual(['0x01', null])
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as Array<{ params: unknown[] }>
    expect(body.map(r => r.params[1])).toEqual(['0xff', '0xff'])
  })
})

describe('the raw indexer wiring', () => {
  const indexer = readFileSync(new URL('../../src/raw/indexer.ts', import.meta.url), 'utf8')

  it('runs the trigger phase after the block\'s own event-driven reads, and stores its collateral rows', () => {
    expect(indexer.indexOf("'mm_triggers'")).toBeGreaterThan(indexer.indexOf("'money_market'"))
    expect(indexer).toContain('alreadyRead: mmReadThisBlock')
    expect(indexer).toContain('eventReads: moneyMarket.positionReads')
    expect(indexer).toContain('ctx.store.addMoneyMarketCollateralAnchors(triggered.collateral)')
    // The open-position set feeds the trigger phase (tombstones, cadence cohort): it
    // is seeded and tracked with the phase, never behind another switch.
    const seed = indexer.slice(indexer.indexOf('if (mmTriggersEnabled())'), indexer.indexOf('const accountStateOn'))
    expect(seed).toContain('openPositions = await loadOpenPositions()')
    expect(indexer).not.toContain('RAW_MM_PERIODIC_SNAPSHOT_ENABLED')
  })

  it('reads an exact index on raw-live and the superset on a bounded range worker', () => {
    expect(indexer).toContain('createMoneyMarketTriggerPhase(startBlock, boundedRange != null)')
  })
})
