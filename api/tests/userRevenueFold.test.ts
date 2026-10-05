import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadExplorerAssets, stopExplorerAssetsRefresh } from '../src/services/explorerAssets.ts'
import {
  FactSink,
  HourPricer,
  bookLedger,
  hourIndexOfBlock,
  proRataResolution,
  type CustodyRegistry,
  type FoldWindow,
  type Ledger,
} from '../src/services/userRevenueFold.ts'
import { OmnipoolBook, omnipoolInflowKindOf } from '../src/services/userRevenueLp.ts'
import { buildLegacyStaking } from '../src/services/userRevenueStaking.ts'
import { buildGigahdxYield, GIGAHDX_LAUNCH_BLOCK } from '../src/services/userRevenueMm.ts'
import { holderClassOf, ethMappedAccount } from '../src/services/userRevenueStreams.ts'

const H0 = Date.UTC(2026, 8, 1) / 1000 // 2026-09-01 00:00
const window3: FoldWindow = {
  month: 202609, monthStart: H0, monthEnd: Date.UTC(2026, 9, 1) / 1000, fromHour: H0, hours: 3,
  openBlock: 100, openTs: H0 - 6,
  hourBlocks: [{ first: 101, last: 200, lastTs: H0 + 3590 }, { first: 201, last: 300, lastTs: H0 + 7190 }, { first: 301, last: 400, lastTs: H0 + 10790 }],
  lastBlock: 400,
}

/** A fake ClickHouse client answering the fold's reads by their log_comment tag. */
function fakeClient(byTag: Record<string, unknown[]>): never {
  return {
    query: async (p: { clickhouse_settings?: { log_comment?: string }; format?: string }) => {
      const tag = p.clickhouse_settings?.log_comment ?? ''
      const data = byTag[tag] ?? []
      return {
        json: async () => data,
        text: async () => data.map(r => JSON.stringify(r)).join('\n'),
      }
    },
  } as never
}

beforeAll(async () => {
  await loadExplorerAssets({ query: async () => ({ json: async () => [
    { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12 },
    { asset_id: 5, symbol: 'DOT', name: 'DOT', decimals: 10 },
    { asset_id: 43, symbol: 'PRIME', name: 'PRIME', decimals: 18 },
    { asset_id: 222, symbol: 'HOLLAR', name: 'HOLLAR', decimals: 18 },
  ] }) } as never)
})
afterAll(() => stopExplorerAssetsRefresh())

async function pricer(): Promise<HourPricer> {
  const p = new HourPricer(window3)
  // HDX: candles for the hour before the window and its first two hours; DOT: none.
  await p.load(fakeClient({ 'ur:prices': [
    { a: '0', t: String(H0 - 3600), c: '0.010000000000' },
    { a: '0', t: String(H0), c: '0.020000000000' },
    { a: '0', t: String(H0 + 3600), c: '0.030000000000' },
  ] }), [0, 5])
  return p
}

describe('the window', () => {
  it('maps a block to its hour by the hours\' last blocks', () => {
    expect(hourIndexOfBlock(window3, 100)).toBe(-1)
    expect(hourIndexOfBlock(window3, 101)).toBe(0)
    expect(hourIndexOfBlock(window3, 200)).toBe(0)
    expect(hourIndexOfBlock(window3, 201)).toBe(1)
    expect(hourIndexOfBlock(window3, 400)).toBe(2)
    expect(hourIndexOfBlock(window3, 401)).toBe(3)
  })
})

describe('FactSink — valuation and the two grains', () => {
  it('values an accrual at its own hour\'s closing candle and an event at the candle closed before it; a missing price is unpriced, never 0', async () => {
    const sink = new FactSink(window3, await pricer(), new Set())
    sink.emit('0xaa', 'user', 0, 'gigahdx_yield', 'p', '', 0, 10n ** 12n, 'accrual')
    sink.emit('0xaa', 'user', 0, 'referral_commissions', 'p', '', 0, 10n ** 12n, 'event')
    sink.emit('0xaa', 'user', 2, 'gigahdx_yield', 'p', '', 0, 10n ** 12n, 'accrual') // carries hour 1's candle
    sink.emit('0xaa', 'user', 1, 'mm_supply_interest', 'p', '', 5, 10n ** 10n, 'accrual') // DOT: no candle at all
    const hour = [...sink.hour.entries()]
    const usd = (stream: string, h: number) => hour.find(([k]) => k.startsWith(`${h}\u0001${stream}`))![1]
    expect(usd('gigahdx_yield', 0).usd).toBe(20_000_000_000n) // $0.02
    expect(usd('referral_commissions', 0).usd).toBe(10_000_000_000n) // $0.01 (the candle closed at the hour's start)
    expect(usd('gigahdx_yield', 2).usd).toBe(30_000_000_000n)
    expect(usd('mm_supply_interest', 1)).toEqual({ amount: 10n ** 10n, usd: 0n, unpriced: 1 })
  })

  it('sums the same cells into day and hour grains, so Σ daily == Σ hourly per (stream, class) exactly', async () => {
    const sink = new FactSink(window3, await pricer(), new Set())
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31)
    for (let i = 0; i < 500; i++) {
      sink.emit(`0x${(rnd() % 17).toString(16)}`, (['user', 'protocol', 'unattributed'] as const)[rnd() % 3], rnd() % 3,
        ['a', 'b'][rnd() % 2], 'p', '', 0, BigInt(rnd()) * (rnd() % 2 ? 1n : -1n), rnd() % 2 ? 'accrual' : 'event')
    }
    const sum = (rowsOf: Record<string, unknown>[]) => {
      const m = new Map<string, bigint>()
      for (const r of rowsOf) {
        if (!r.stream) continue
        const k = `${r.stream}|${r.holder_class}`
        m.set(k, (m.get(k) ?? 0n) + BigInt(r.amount as string) * 10n ** 12n + BigInt(String(r.amount_usd).replace('.', '')))
      }
      return m
    }
    const daily = sum(sink.dailyRows('1', '2', '3', '2026-09-02 00:00:00'))
    const hourly = sum(sink.hourlyRows(() => '3', '2026-09-02 00:00:00'))
    expect(daily).toEqual(hourly)
    // One marker row per hour and one per month, so an empty bucket still reads as folded.
    expect(sink.hourlyRows(() => '3', 'x').filter(r => r.stream === '')).toHaveLength(3)
    expect(sink.dailyRows('1', '2', '3', 'x').filter(r => r.stream === '')).toHaveLength(1)
  })
})

describe('holder classes', () => {
  const tagged = new Set(['0x02a0ed074f14937bfe7e40e267a5978aa20ba0bb89df5030348118ac5efc0d55'])
  it('classes pallet accounts (both id forms), tagged protocol members, the collector and the executor as protocol', () => {
    expect(holderClassOf('0x6d6f646c70792f74727372790000000000000000000000000000000000000000', tagged)).toBe('protocol')
    expect(holderClassOf('0x455448006d6f646c70792f747273727900000000000000000000000000000000', tagged)).toBe('protocol')
    expect(holderClassOf('0x02a0ed074f14937bfe7e40e267a5978aa20ba0bb89df5030348118ac5efc0d55', tagged)).toBe('protocol')
    expect(holderClassOf(ethMappedAccount('0xe52567ff06acd6cbe7ba94dc777a3126e180b6d9'), tagged)).toBe('protocol')
    expect(holderClassOf('0x45544800000000000000000000000000000000000000090a0000000000000000', tagged)).toBe('protocol')
  })
  it('classes sibling and child sovereigns and the empty account unattributed, everyone else user', () => {
    expect(holderClassOf('0x7369626cd0070000000000000000000000000000000000000000000000000000', tagged)).toBe('unattributed')
    expect(holderClassOf('0x70617261d1070000000000000000000000000000000000000000000000000000', tagged)).toBe('unattributed')
    expect(holderClassOf('', tagged)).toBe('unattributed')
    expect(holderClassOf('0x8aee4e164d5d70ac67308f303c7e063e9156903e42c1087bbc530447487fa47f', tagged)).toBe('user')
  })
})

describe('custody pass-through', () => {
  const POOL = '0x22bb00df7706a5965728b60f96406ee59ce675fd5fd10652a4ed6f618856ccfe'
  const NESTED = '0x7fe7d370617e793b178de6efc9bc5813382f2e2866ee298ea1917d8b8dce436b'
  const ledger = (holder: string, amounts: bigint[]): Ledger => ({ holder, stream: 'mm_supply_interest', pot: 'core:10', via: '', asset: 0, held: 1002, price: 'accrual', amounts })
  const claimants: Record<string, Array<[string, bigint]>> = {
    [POOL]: [['0xa1', 1n], ['0xa2', 2n], [NESTED, 1n]],
    [NESTED]: [['0xb1', 1n], ['0xb2', 1n]],
  }
  const registry = (depth = 4): CustodyRegistry => ({
    resolverFor: holder => (claimants[holder] && depth > 0 ? { kind: holder === POOL ? 'stableswap:100' : 'stableswap:102', resolve: async l => proRataResolution(l, holder === POOL ? 'stableswap:100' : 'stableswap:102', () => 102, () => claimants[holder]) } : null),
    unresolvedKind: holder => (holder === '0xcafe' ? 'custody:lbp' : null),
  })

  it('passes a custody\'s income to its claimants (nested), conserving every unit, with the path in via', async () => {
    const sink = new FactSink(window3, await pricer(), new Set())
    await bookLedger(sink, registry(), ledger(POOL, [1000n, 7n, 0n]))
    const byKey = new Map<string, bigint>()
    let total = 0n
    for (const [k, c] of sink.day) { byKey.set(`${k.split('\u0001')[0]}|${k.split('\u0001')[4]}`, c.amount); total += c.amount }
    expect(total).toBe(1007n)
    expect(byKey.get('0xa2|stableswap:100')).toBe(500n + 4n) // 7 split 1:2:1 by cumulative floors: 1, 4, 2
    expect([...byKey.keys()]).toContain('0xb1|stableswap:100>stableswap:102')
  })

  it('books a custody nothing passes through as unattributed under its named cause, never as its own (protocol) income', async () => {
    const sink = new FactSink(window3, await pricer(), new Set())
    await bookLedger(sink, registry(), ledger('0xcafe', [5n, 0n, 0n]))
    const [[k]] = [...sink.day]
    expect(k.split('\u0001')).toEqual(['0xcafe', '0', 'mm_supply_interest', 'core:10', 'custody:lbp', '0', 'unattributed'])
  })
})

describe('E1 legacy staking', () => {
  const rps = (b: number, e: number, v: bigint) => ({ b: String(b), e: String(e), v: v.toString() })
  const ev = (b: number, e: number, n: string, args: Record<string, unknown>) => ({ b: String(b), e: String(e), n, args: JSON.stringify(args) })
  const who = '0x8aee4e164d5d70ac67308f303c7e063e9156903e42c1087bbc530447487fa47f'
  const ONE = 10n ** 18n
  const rows = {
    'ur:staking-rps': [rps(50, 1, 1n * ONE), rps(150, 1, 2n * ONE), rps(250, 1, 4n * ONE), rps(350, 1, 5n * ONE)],
    'ur:staking-events': [
      ev(40, 2, 'Staking.PositionCreated', { who, positionId: '7', stake: '1000' }),
      ev(260, 2, 'Staking.StakeAdded', { who, positionId: '7', stake: '1000', totalStake: '2000' }),
      ev(360, 2, 'Staking.RewardsClaimed', { who, positionId: '7', slashedUnpaidRewards: '300' }),
    ],
  }
  it('books the gross stake × Δrps per hour in the chain\'s event order, nothing before the window, the forfeit negative at the claim', async () => {
    const out = await buildLegacyStaking(fakeClient(rows), window3)
    const gross = out.ledgers.find(l => l.stream === 'staking_legacy')!
    // Before the window rps 0→1 while held (1000 owed, not booked); hour 0: 1→2 (+1000); hour 1: 2→4 (+2000);
    // hour 2: the stake doubles at 260 (after rps 4), then 4→5 on 2000 (+2000).
    expect(gross.amounts).toEqual([1000n, 2000n, 2000n])
    expect(out.ledgers.find(l => l.stream === 'staking_forfeit')!.amounts).toEqual([0n, 0n, -300n])
    expect(out.closing).toEqual([{ position: '7', who, stake: 2000n, cp: 4n * ONE, lifeGross: 6000n, lifeSettled: 300n }])
  })
  it('books the first runtime\'s silent forfeit at an Unstaked that paid `rewards` itself: the life gross less everything settled', async () => {
    const out = await buildLegacyStaking(fakeClient({
      'ur:staking-rps': rows['ur:staking-rps'],
      'ur:staking-events': [rows['ur:staking-events'][0], ev(260, 2, 'Staking.Unstaked', { who, positionId: '7', unlockedStake: '1000', rewards: '1200' })],
    }), window3)
    // Gross over its life to block 260: 1000 (rps 0→1, before the window) + 1000 + 2000 = 4000; paid 1200 at exit → 2800 forfeited in its hour.
    expect(out.ledgers.find(l => l.stream === 'staking_forfeit')!.amounts).toEqual([0n, -2800n, 0n])
  })
  it('opens from the month\'s anchor exactly as from the first event', async () => {
    const scratch = await buildLegacyStaking(fakeClient(rows), window3)
    const anchored = await buildLegacyStaking(fakeClient({
      'ur:staking-rps': rows['ur:staking-rps'].filter(r => Number(r.b) > 60),
      'ur:staking-events': rows['ur:staking-events'].filter(r => Number(r.b) > 60),
    }), window3, { rows: [{ pot: 'staking', holder: who, exposure_id: '7', units: 1000n, aux: `${ONE}|0|0` }, { pot: 'staking:rps', holder: '', exposure_id: '', units: ONE, aux: '' }], block: 60 })
    expect(anchored.ledgers).toEqual(scratch.ledgers)
  })
})

describe('E2 GIGAHDX yield', () => {
  it('books the zero-supply inflows once at the first supply block by END-of-block holdings, and every later inflow by start-of-block holdings', async () => {
    const w: FoldWindow = { ...window3, openBlock: GIGAHDX_LAUNCH_BLOCK - 1, hourBlocks: window3.hourBlocks.map((hb, i) => ({ ...hb, first: GIGAHDX_LAUNCH_BLOCK + i * 100, last: GIGAHDX_LAUNCH_BLOCK + i * 100 + 99 })), lastBlock: GIGAHDX_LAUNCH_BLOCK + 299 }
    const first = GIGAHDX_LAUNCH_BLOCK + 10
    const out = await buildGigahdxYield(fakeClient({
      'ur:giga-first': [{ b: String(first) }],
      'ur:giga-inflows': [{ b: String(GIGAHDX_LAUNCH_BLOCK), a: '500' }, { b: String(first + 150), a: '300' }],
      'ur:mm-b0': [],
      'ur:mm-opening': [],
      'ur:mm-deltas': [
        ['0x00000000000000000000000000000000000000a1', '0x6b9ac524ec8f08c49ec80176b138d16eb461c3d8', String(first), '0', '100'],
        ['0x00000000000000000000000000000000000000a2', '0x6b9ac524ec8f08c49ec80176b138d16eb461c3d8', String(first + 150), '0', '200'],
      ],
    }), w, h160 => h160)
    const by = new Map(out.map(l => [l.holder, l.amounts]))
    // a1 is the only holder at the end of the first-supply block: the opening 500; at first+150 a2's stake lands in the same block, so a1 takes the 300 too.
    expect(by.get('0x00000000000000000000000000000000000000a1')).toEqual([500n, 300n, 0n])
    expect(by.has('0x00000000000000000000000000000000000000a2')).toBe(false)
  })
})

describe('A1 Omnipool book', () => {
  const POS = (p: string, b: number, shares: string, price: string, kind = 'created') => ({ p, b: String(b), e: '1', a: '5', s: shares, px: price, act: kind === 'destroyed' ? '0' : '1', k: kind })
  it('splits an inflow into owner captures, the protocol shares\' ½ and the hub-channel remainder, summing to the inflow', async () => {
    const R = 10n ** 16n
    const Q = 2n * 10n ** 17n
    const spot = (Q * 10n ** 18n / R).toString() // entered at spot: c = ½
    const book = await OmnipoolBook.load(fakeClient({
      'ur:omni-positions': [POS('1', 50, '6000', spot), POS('2', 50, '2000', (BigInt(spot) * 2n).toString())],
      'ur:omni-owners': [{ acct: '0xA1', p: '1', fb: '50', tb: '0' }, { acct: '0xA2', p: '2', fb: '50', tb: '0' }],
      'ur:omni-grid': [{ a: '5', b: '60', r: R.toString(), q: Q.toString(), s: '10000', ps: '2000' }],
    }), window3)
    const D = 1_000_000n
    const { owners, protocol, remainder } = book.distribute(5, 'asset', 150, D)
    expect([...owners.values()].reduce((a, b) => a + b, 0n) + protocol + remainder).toBe(D)
    expect(owners.get('0xa1')).toBe(D * 6000n / 10000n / 2n) // at entry: ½ of its 60% slice
    expect(protocol).toBe(D * 2000n / 10000n / 2n)
    // Position 2 entered at twice the spot (x = ½): 2x²/(1+x)² = 2/9 of its slice.
    expect(owners.get('0xa2')).toBe(D * 2n * 2000n / (9n * 10000n))
    expect(remainder).toBeGreaterThan(0n)
  })
  it('charges an exit fee on the remover\'s EXACT payoff (its own entry price), each leg net of the rate as the node pays it', async () => {
    const { buildOmnipool } = await import('../src/services/userRevenueLp.ts')
    const { omnipoolRemoveLiquidity, OMNI_FIXED } = await import('../src/services/lpMath.ts')
    const R = 10n ** 16n
    const Q = 2n * 10n ** 17n
    const spot = Q * 10n ** 18n / R
    const tags = {
      'ur:omni-positions': [POS('1', 50, '6000', spot.toString()), POS('2', 50, '2000', (spot * 2n).toString())],
      'ur:omni-owners': [{ acct: '0xA1', p: '1', fb: '50', tb: '0' }, { acct: '0xA2', p: '2', fb: '50', tb: '0' }],
      'ur:omni-grid': [{ a: '5', b: '60', r: R.toString(), q: Q.toString(), s: '10000', ps: '2000' }],
      'ur:omni-removals': [{ b: '150', args: JSON.stringify({ who: '0xA2', positionId: 2, assetId: 5, sharesRemoved: '1000', fee: (10n ** 16n).toString() }) }],
    }
    const client = fakeClient(tags)
    const book = await OmnipoolBook.load(client, window3)
    const sink = new FactSink(window3, await pricer(), new Set())
    const ledgers = await buildOmnipool(client, window3, book, sink)
    const paid = ledgers.filter(l => l.stream === 'lp_exit_fee')
    // Entered at twice the spot, position 2 redeems less than its pro-rata slice (R·s/S): the fee is 1 % of what it gets.
    const payoff = omnipoolRemoveLiquidity({ reserve: R, hub: Q, shares: 10000n }, { assetId: 5, amount: 0n, shares: 1000n, priceNum: spot * 2n, priceDen: OMNI_FIXED })
    expect(payoff.liquidity).toBeLessThan(R * 1000n / 10000n)
    expect(paid).toHaveLength(1)
    expect(paid[0].amounts[0]).toBe(-(payoff.liquidity - (payoff.liquidity * 99n) / 100n))
  })
  it('distributes an exit fee over the positions AFTER the burn: a full remover captures none of its own fee', async () => {
    const { buildOmnipool } = await import('../src/services/userRevenueLp.ts')
    const R = 10n ** 16n
    const Q = 2n * 10n ** 17n
    const spot = Q * 10n ** 18n / R
    const client = fakeClient({
      // position 2 (0xA2) is removed whole at block 150; position 1 (0xA1) stays
      'ur:omni-positions': [POS('1', 50, '6000', spot.toString()), POS('2', 50, '2000', spot.toString()), POS('2', 150, '0', spot.toString(), 'destroyed')],
      'ur:omni-owners': [{ acct: '0xA1', p: '1', fb: '50', tb: '0' }, { acct: '0xA2', p: '2', fb: '50', tb: '150' }],
      'ur:omni-grid': [{ a: '5', b: '60', r: R.toString(), q: Q.toString(), s: '10000', ps: '2000' }],
      'ur:omni-removals': [{ b: '150', args: JSON.stringify({ who: '0xA2', positionId: 2, assetId: 5, sharesRemoved: '2000', fee: (10n ** 16n).toString() }) }],
    })
    const book = await OmnipoolBook.load(client, window3)
    const sink = new FactSink(window3, await pricer(), new Set())
    const ledgers = await buildOmnipool(client, window3, book, sink)
    const fee = -ledgers.find(l => l.stream === 'lp_exit_fee' && l.asset === 5)!.amounts[0]
    expect(fee).toBeGreaterThan(0n)
    const credit = (holder: string) => ledgers.filter(l => l.stream === 'lp_fee_omnipool' && l.holder === holder).reduce((a, l) => a + l.amounts.reduce((x, y) => x + y, 0n), 0n)
    expect(credit('0xa2')).toBe(0n)
    // The remaining position (at spot, c = ½) takes ½ of its share of the post-burn shares: 6000 / (6000 + 2000 protocol).
    const assetLeg = ledgers.filter(l => l.stream === 'lp_fee_omnipool' && l.holder === '0xa1' && l.asset === 5).reduce((a, l) => a + l.amounts[0], 0n)
    expect(assetLeg).toBe(fee * 6000n / 8000n / 2n)
  })
})

describe('pro-rata pools: start-of-block holdings', () => {
  it('splits each stretch of inflows by the holdings it accrued under — a balance change closes the stretch first', async () => {
    const { BalanceCursor, LedgerMap, distributePoolInflows } = await import('../src/services/userRevenueLp.ts')
    const cursor = new BalanceCursor(new Map([['0xa', 100n]]), [{ block: 150, account: '0xb', units: 100n }])
    const out = new LedgerMap(3)
    distributePoolInflows(window3, out, 'stableswap:1', cursor, [
      { block: 120, asset: 0, amount: 1000n, stream: 'lp_fee_stableswap' }, // only 0xa held at the end of 119
      { block: 150, asset: 0, amount: 1000n, stream: 'lp_fee_stableswap' }, // 0xb's shares land IN block 150: not yet
      { block: 151, asset: 0, amount: 1000n, stream: 'lp_fee_stableswap' }, // from 151 on both hold
    ], 1)
    const by = new Map(out.ledgers().map(l => [l.holder, l.amounts[0]]))
    expect(by.get('0xa')).toBe(2500n)
    expect(by.get('0xb')).toBe(500n)
  })
})

describe('custody pass-through: what cannot pass, and whose key', () => {
  const POOL = '0x22bb00df7706a5965728b60f96406ee59ce675fd5fd10652a4ed6f618856ccfe'
  const registry: CustodyRegistry = {
    resolverFor: holder => (holder === POOL ? { kind: 'stableswap:100', resolve: async l => proRataResolution(l, 'stableswap:100', () => 102, () => [['0xa1', 1n]]) } : null),
    unresolvedKind: () => null,
  }
  it('books a money-market reward accrued to a custody unattributed (only its own key could claim it), never passed to its claimants', async () => {
    const sink = new FactSink(window3, await pricer(), new Set())
    await bookLedger(sink, registry, { holder: POOL, stream: 'mm_incentives', pot: 'core:1002:0', via: '', asset: 0, held: 1002, price: 'accrual', amounts: [9n, 0n, 0n], custodyVia: 'incentives-unclaimable' })
    const keys = [...sink.day.keys()].map(k => k.split('\u0001'))
    expect(keys).toEqual([[POOL, '0', 'mm_incentives', 'core:1002:0', 'incentives-unclaimable', '0', 'unattributed']])
  })
  it('books an ETH-mapped holder under the substrate account that bound its H160 (one person, one key)', async () => {
    const owner = '0x3e4830f109e8768c94aca32dba50a1192d964e2f177184d66fc949117d05c239'
    const eth = ethMappedAccount('0x3e4830f109e8768c94aca32dba50a1192d964e2f')
    const sink = new FactSink(window3, await pricer(), new Set(), new Map([[eth, owner]]))
    await bookLedger(sink, registry, { holder: eth, stream: 'mm_supply_interest', pot: 'core:5', via: '', asset: 0, held: 1001, price: 'accrual', amounts: [5n, 0n, 0n] })
    expect([...sink.day.keys()].map(k => k.split('\u0001')[0])).toEqual([owner])
  })
  it('names an unattributed holder\'s cause after its path, but never a second cause after a named one', async () => {
    const sink = new FactSink(window3, await pricer(), new Set())
    await bookLedger(sink, registry, { holder: '', stream: 'gigahdx_voting', pot: 'gigahdx-voting:1', via: 'voting-unrecorded', asset: 0, held: null, price: 'event', amounts: [5n, 0n, 0n] })
    await bookLedger(sink, registry, { holder: '0x7369626c' + '00'.repeat(28), stream: 'token_accrual_catchup', pot: 'token:43', via: 'catchup-spread', asset: 222, held: 43, price: 'accrual', amounts: [5n, 0n, 0n] })
    const vias = [...sink.day.keys()].map(k => k.split('\u0001')[4]).sort()
    expect(vias).toEqual(['catchup-spread>sovereign', 'voting-unrecorded'])
  })
})

describe('D1 token accrual: segments, holders, unmeasured markers', () => {
  it('books a catch-up segment\'s share of each hour to that hour\'s holders (via catchup-spread), and states the undecided rest unmeasured', async () => {
    const { BalanceBook } = await import('../src/services/userRevenueLp.ts')
    const { buildTokenAccrual } = await import('../src/services/userRevenueTokens.ts')
    const { segmentRiseIn, PEG_OPEN_END } = await import('../src/services/userRevenueMath.ts')
    const ONE = 10n ** 36n
    const seg = { startTs: H0 - 10 * 86_400, endTs: H0 + 5_400, rise: ONE / 100n, kind: 'catchup' as const, moves: 40 }
    const open = { startTs: H0 + 5_400, endTs: PEG_OPEN_END, rise: 0n, kind: 'pending' as const, moves: 0 }
    const balances = new BalanceBook()
    balances.opening.set(43, new Map([['0xa', 10n ** 20n]]))
    balances.changes.set(43, [{ block: 250, account: '0xb', units: 10n ** 20n }])
    const { ledgers, markers } = await buildTokenAccrual(window3, new Map([[43, [seg, open]]]), new Map([[43, [{ ts: H0 - 20 * 86_400, rate: ONE }]]]), balances, new Map(), h => h)
    const a = ledgers.find(l => l.holder === '0xa')!
    expect(a).toMatchObject({ stream: 'token_accrual_catchup', via: 'catchup-spread', pot: 'token:43', asset: 222, held: 43 })
    const per = (h: number) => (10n ** 20n * segmentRiseIn(seg, H0 + h * 3600, H0 + (h + 1) * 3600)) / ONE
    expect(a.amounts).toEqual([per(0), per(1), 0n])
    // 0xb's units land inside hour 1: it holds from hour 2's start, when the segment has ended.
    expect(ledgers.find(l => l.holder === '0xb')).toBeUndefined()
    expect(markers).toEqual([{ h: 1, token: 43, reason: 'peg-pending' }, { h: 2, token: 43, reason: 'peg-pending' }])
  })

  it('states the hours of a segment the high-water mark zeroed as unmeasured:under-high-water, and a relay\'s as peg-jump', async () => {
    const { BalanceBook } = await import('../src/services/userRevenueLp.ts')
    const { buildTokenAccrual } = await import('../src/services/userRevenueTokens.ts')
    const { PEG_OPEN_END } = await import('../src/services/userRevenueMath.ts')
    const ONE = 10n ** 36n
    const segs = [
      { startTs: H0 - 3_600, endTs: H0 + 1_800, rise: 0n, kind: 'jump' as const, moves: 1 },
      { startTs: H0 + 1_800, endTs: H0 + 7_200, rise: 0n, kind: 'under-high-water' as const, moves: 1 },
      { startTs: H0 + 7_200, endTs: PEG_OPEN_END, rise: 0n, kind: 'pending' as const, moves: 0 },
    ]
    const balances = new BalanceBook()
    balances.opening.set(43, new Map([['0xa', 10n ** 18n]]))
    const { ledgers, markers } = await buildTokenAccrual(window3, new Map([[43, segs]]), new Map([[43, [{ ts: H0 - 86_400, rate: ONE }]]]), balances, new Map(), h => h)
    expect(ledgers).toEqual([])
    expect(markers).toEqual([
      { h: 0, token: 43, reason: 'peg-jump' },
      { h: 0, token: 43, reason: 'under-high-water' },
      { h: 1, token: 43, reason: 'under-high-water' },
      { h: 2, token: 43, reason: 'peg-pending' },
    ])
  })

  it('writes a zero-amount marker row in both grains, kept although it sums to nothing', async () => {
    const sink = new FactSink(window3, await pricer(), new Set())
    sink.mark(1, 'token_accrual', 'token:46', 'peg-never-moved', 46)
    const daily = sink.dailyRows('0', '0', '0', '2026-09-01 00:00:00').filter(r => r.stream !== '')
    const hourly = sink.hourlyRows(() => '0', '2026-09-01 00:00:00').filter(r => r.stream !== '')
    expect(daily).toEqual([expect.objectContaining({ account: '', stream: 'token_accrual', via: 'unmeasured:peg-never-moved', asset_id: 46, holder_class: '', amount: '0', amount_usd: '0.000000000000' })])
    expect(hourly).toEqual([expect.objectContaining({ hour: '2026-09-01 01:00:00', via: 'unmeasured:peg-never-moved', amount: '0' })])
  })

  it('anchors an external rate series to end exactly at the first peg row, its rises telescoping (and none when it falls short)', async () => {
    const { externalSegments } = await import('../src/services/userRevenueTokens.ts')
    const ONE = 10n ** 36n
    const ext = { token: 43, via: 'external-rate:test', points: [[H0 - 2 * 86_400, 100_000_000n], [H0 - 86_400, 100_100_000n], [H0 + 86_400, 100_300_000n]] as const }
    const first = { ts: H0, rate: (ONE * 1005n) / 1000n }
    const segs = externalSegments(ext, first)
    expect(segs.map(sg => [sg.startTs, sg.endTs, sg.kind, sg.via])).toEqual([[H0 - 2 * 86_400, H0 - 86_400, 'external', 'external-rate:test'], [H0 - 86_400, H0, 'external', 'external-rate:test']])
    // nav(H0) = 1.002 (linear between the last two points); the series is scaled by first.rate / 1.002.
    const start = (first.rate * 100_000_000n * 10n ** 12n) / (100_200_000n * 10n ** 12n)
    expect(segs.reduce((a, sg) => a + sg.rise, 0n)).toBe(first.rate - start)
    expect(segs[1].rise).toBe(first.rate - (first.rate * 100_100_000n) / 100_200_000n)
    // A series ending before the first peg row would leave a gap: it books nothing.
    expect(externalSegments({ ...ext, points: ext.points.slice(0, 2) }, first)).toEqual([])
    expect(externalSegments(ext, undefined)).toEqual([])
  })

  it('books an external stretch as token_accrual via its source, and marks no-rate-yet only before the series starts', async () => {
    const { BalanceBook } = await import('../src/services/userRevenueLp.ts')
    const { buildTokenAccrual } = await import('../src/services/userRevenueTokens.ts')
    const { segmentRiseIn, PEG_OPEN_END } = await import('../src/services/userRevenueMath.ts')
    const ONE = 10n ** 36n
    const ext = { startTs: H0 + 3_600, endTs: H0 + 9_000, rise: ONE / 1000n, kind: 'external' as const, moves: 0, via: 'external-rate:hastra-nav' }
    const open = { startTs: H0 + 9_000, endTs: PEG_OPEN_END, rise: 0n, kind: 'pending' as const, moves: 0 }
    const balances = new BalanceBook()
    balances.opening.set(43, new Map([['0xa', 10n ** 6n * 1000n]]))
    const { ledgers, markers } = await buildTokenAccrual(window3, new Map([[43, [ext, open]]]), new Map([[43, [{ ts: H0 + 9_000, rate: ONE }]]]), balances, new Map(), h => h)
    const a = ledgers.find(l => l.holder === '0xa')!
    expect(a).toMatchObject({ stream: 'token_accrual', via: 'external-rate:hastra-nav', pot: 'token:43', asset: 222, held: 43 })
    // Underlying units per held unit: units × Δrate × 10^du / (10^dt × 10^36), the registry's decimals.
    const { assetDecimalsOrNull } = await import('../src/services/explorerAssets.ts')
    const du = BigInt(assetDecimalsOrNull(222)!), dt = BigInt(assetDecimalsOrNull(43)!)
    const per = (h: number) => (10n ** 9n * segmentRiseIn(ext, H0 + h * 3600, H0 + (h + 1) * 3600) * 10n ** du) / (10n ** dt * ONE)
    expect(a.amounts).toEqual([0n, per(1), per(2)])
    expect(markers).toEqual([{ h: 0, token: 43, reason: 'no-rate-yet' }, { h: 2, token: 43, reason: 'peg-pending' }])
  })

  it('pins PRIME\'s Hastra NAV series: ~8 % APR from its first Hydration holder to the first peg row, ending exactly at that row', async () => {
    const { externalSegments, PRIME_HASTRA_NAV } = await import('../src/services/userRevenueTokens.ts')
    const ONE = 10n ** 36n
    const firstTs = Date.UTC(2026, 1, 19, 16, 30, 42) / 1000 // pool 143's first grid row, block 11,434,800
    const first = { ts: firstTs, rate: (101_953_570n * ONE) / 100_000_000n }
    const segs = externalSegments(PRIME_HASTRA_NAV, first)
    expect(segs.at(-1)!.endTs).toBe(firstTs)
    const firstHeld = Date.UTC(2026, 0, 27, 15, 25, 48) / 1000
    let rise = 0n
    for (const sg of segs) {
      const { segmentRiseIn } = await import('../src/services/userRevenueMath.ts')
      rise += segmentRiseIn(sg, firstHeld, firstTs)
    }
    const growth = Number((rise * 10n ** 9n) / (first.rate - rise)) / 1e9
    const apr = Math.log(1 + growth) / ((firstTs - firstHeld) / (365 * 86_400))
    expect(apr).toBeGreaterThan(0.078)
    expect(apr).toBeLessThan(0.082)
    for (const sg of segs) expect(sg.rise).toBeGreaterThan(0n)
  })

  it('re-marks exactly the buckets a newly decided segment spans (its identity joins their fingerprints)', async () => {
    const { pegBucketFingerprints } = await import('../src/services/userRevenueTokens.ts')
    const { PEG_OPEN_END } = await import('../src/services/userRevenueMath.ts')
    const buckets = [0, 1, 2, 3].map(i => [H0 + i * 3600, H0 + (i + 1) * 3600] as const)
    const before = pegBucketFingerprints(new Map([[15, [{ startTs: H0 - 60, endTs: H0 + 3000, rise: 7n, kind: 'accrual' as const, moves: 1 },
      { startTs: H0 + 3000, endTs: PEG_OPEN_END, rise: 0n, kind: 'pending' as const, moves: 0 }]]]), buckets)
    const after = pegBucketFingerprints(new Map([[15, [{ startTs: H0 - 60, endTs: H0 + 3000, rise: 7n, kind: 'accrual' as const, moves: 1 },
      { startTs: H0 + 3000, endTs: H0 + 4000, rise: 5n, kind: 'accrual' as const, moves: 1 },
      { startTs: H0 + 4000, endTs: PEG_OPEN_END, rise: 0n, kind: 'pending' as const, moves: 0 }]]]), buckets)
    expect(before[0]).not.toBe(after[0]) // hour 0 holds the old pending start
    expect(before[1]).not.toBe(after[1])
    expect(before[2]).not.toBe(after[2]) // the pending segment moved
    expect(after[2]).toBe(after[3])
  })
})

describe('C3 money-market incentives: the window does not move the booking', () => {
  it('books an hour the same whether its window opens before or after the last emitted index point', async () => {
    const { buildMmIncentives } = await import('../src/services/userRevenueMm.ts')
    const B = 9_000_000 // after B0
    const A = '0x' + 'a1'.repeat(20)
    const REWARD = '0x0000000000000000000000000000000100000000'
    const contracts = [{ contract: A, side: 'supply' as const, reserve: '0x00', pool: '0xp', market: 'core', reserveAsset: 0, aTokenAsset: 1002 }]
    const H1 = '0x' + 'c1'.repeat(20)
    const H2 = '0x' + 'c2'.repeat(20)
    const long: FoldWindow = {
      ...window3, openBlock: B + 100,
      hourBlocks: [{ first: B + 101, last: B + 200, lastTs: H0 + 3590 }, { first: B + 201, last: B + 300, lastTs: H0 + 7190 }, { first: B + 301, last: B + 400, lastTs: H0 + 10790 }],
      lastBlock: B + 400,
    }
    const short: FoldWindow = { ...long, fromHour: H0 + 3600, hours: 2, openBlock: B + 200, openTs: H0 + 3590, hourBlocks: long.hourBlocks.slice(1) }
    // Programme from before the windows; one emitted point at B+150; H2 supplies at B+180 — inside the long
    // window's hour 0, BEFORE the short window opens at B+200.
    const progs = [{ a: A, r: REWARD, b: String(B + 50), ts: String(H0 - 3000), em: '1000000000000', end: String(H0 + 86_400) }]
    const updates = [{ a: A, r: REWARD, b: String(B + 150), ts: String(H0 + 1000), idx: '5000' }]
    const client = (pre: unknown[]) => fakeClient({ 'ur:inc-programmes': progs, 'ur:inc-updates': updates, 'ur:inc-pre-supply': pre })
    const decimals = () => 12
    const T = 10n ** 12n
    const fromLong = await buildMmIncentives(client([]), long, contracts, new Map([[`${H1}|${A}`, T]]),
      { deltasOf: new Map([[`${H2}|${A}`, [{ holder: H2, contract: A, block: B + 180, ts: H0 + 2000, delta: 3n * T }]]]), start: { block: B + 100, ts: H0 - 6 } }, h => h, decimals)
    const fromShort = await buildMmIncentives(client([{ c: A, b: String(B + 180), d: String(3n * T) }]), short, contracts,
      new Map([[`${H1}|${A}`, T], [`${H2}|${A}`, 3n * T]]), { deltasOf: new Map(), start: { block: B + 200, ts: H0 + 3590 } }, h => h, decimals)
    const cell = (ls: typeof fromLong, holder: string, h: number) => ls.find(l => l.holder === holder)?.amounts[h] ?? 0n
    for (const holder of [H1, H2]) {
      expect(cell(fromLong, holder, 1)).toBeGreaterThan(0n)
      expect(cell(fromShort, holder, 0)).toBe(cell(fromLong, holder, 1))
      expect(cell(fromShort, holder, 1)).toBe(cell(fromLong, holder, 2))
    }
  })
})

describe('omnipoolInflowKindOf', () => {
  it('adds units only for a directly held rebasing aToken; a share\'s fee legs raise its NAV (price)', () => {
    expect(omnipoolInflowKindOf({ stream: 'mm_supply_interest', via: '' })).toBe('asset')
    expect(omnipoolInflowKindOf({ stream: 'lp_fee_stableswap', via: '' })).toBe('price')
    expect(omnipoolInflowKindOf({ stream: 'lp_fee_xyk', via: '' })).toBe('price')
    expect(omnipoolInflowKindOf({ stream: 'mm_supply_interest', via: 'stableswap:690' })).toBe('price')
    expect(omnipoolInflowKindOf({ stream: 'token_accrual', via: '' })).toBe('price')
  })
})

describe('HourPricer — ETH filled from WETH where its own series has no candle', () => {
  it('takes the newest candle of either series, its own on a tie', async () => {
    const p = new HourPricer(window3)
    await p.load(fakeClient({ 'ur:prices': [
      { a: '20', t: String(H0 - 3600), c: '4000.000000000000' },
      { a: '20', t: String(H0 + 3600), c: '4100.000000000000' },
      { a: '34', t: String(H0), c: '4050.000000000000' },
      { a: '34', t: String(H0 + 3600), c: '4090.000000000000' },
    ] }), [34])
    expect(p.closeAt(34, H0 - 3600)).toBe(4000n * 10n ** 12n) // before ETH's own series: WETH
    expect(p.closeAt(34, H0)).toBe(4050n * 10n ** 12n) // ETH's own
    expect(p.closeAt(34, H0 + 3600)).toBe(4090n * 10n ** 12n) // tie: own
    expect(p.closeAt(20, H0)).toBe(4000n * 10n ** 12n) // WETH never borrows ETH's series
  })
})

describe('FactSink — a key netting to zero is no row and no fingerprint input', () => {
  it('leaves it out of hourAssets/assets as hourlyRows does', async () => {
    const sink = new FactSink(window3, await pricer(), new Set())
    sink.emit('0xaa', 'user', 0, 'gigahdx_yield', 'p', '', 0, 10n ** 12n, 'accrual')
    sink.emit('0xaa', 'user', 0, 'gigahdx_yield', 'p', '', 0, -(10n ** 12n), 'accrual')
    sink.emit('0xbb', 'user', 1, 'gigahdx_yield', 'p', '', 222, 5n, 'accrual')
    expect(sink.hourAssets().get(0)).toBeUndefined()
    expect(sink.assets()).toEqual([222])
    expect(sink.hourlyRows(() => '0', '2026-09-01 00:00:00').filter(r => r.stream !== '').map(r => r.asset_id)).toEqual([222])
  })
})

describe('B1 farm accrual per entry (Δclaimable + claimed)', () => {
  const run = async (opening: bigint | null, claimable: Array<bigint | null>, claimed: bigint[] = []) => {
    const { farmEntryAccruals } = await import('../src/services/userRevenueFarms.ts')
    return farmEntryAccruals(claimable.length, opening, {
      notYet: () => false, closedBefore: () => false, claimable: h => claimable[h], claimed: h => claimed[h] ?? 0n,
    })
  }
  it('books each stated hour, carrying an unstated hour\'s claims to the next stated one', async () => {
    const r = await run(10n, [15n, null, 5n, 9n], [0n, 20n, 0n, 0n])
    expect([...r.accrual]).toEqual([[0, 5n], [2, 10n], [3, 4n]])
    expect(r.unmeasured).toEqual([])
    expect(r.unstated).toBe(1)
  })
  it('states the stretch from an unstatable opening to the first stated hour unmeasured, its claims dropped with it — never folded into a later hour', async () => {
    const r = await run(null, [null, 40n, 45n], [7n, 3n, 0n])
    expect([...r.accrual]).toEqual([[2, 5n]])
    expect(r.unmeasured).toEqual([[0, 1]])
  })
  // An entry whose farm has no stated state at all books nothing — and says so: the hours it is open are marked
  // farm-state-unknown (userRevenueFarms, the `!f` branch), never left as a silent 0.
  it('marks every open hour of an entry whose farm state is unknown', async () => {
    const { entryOpenHours, FARM_STATE_UNKNOWN_REASON } = await import('../src/services/userRevenueFarms.ts')
    const w = { openBlock: 100, lastBlock: 400, hours: 3, hourBlocks: [{ last: 200 }, { last: 300 }, { last: 400 }] } as never
    expect(entryOpenHours(w, 50, null)).toEqual([0, 2])
    expect(entryOpenHours(w, 250, null)).toEqual([1, 2])
    expect(entryOpenHours(w, 50, 210)).toEqual([0, 1])
    expect(entryOpenHours(w, 450, null)).toBeNull()
    const src = (await import('node:fs')).readFileSync(new URL('../src/services/userRevenueFarms.ts', import.meta.url), 'utf8')
    const branch = src.slice(src.indexOf('if (!f) {'), src.indexOf('continue\n    }', src.indexOf('if (!f) {')))
    expect(branch).toContain('entryOpenHours(w, e.enteredBlock, e.closedBlock)')
    expect(branch).toContain('reason: FARM_STATE_UNKNOWN_REASON')
    expect(FARM_STATE_UNKNOWN_REASON).toBe('farm-state-unknown')
  })
  it('states a window that never states a claimable, and an unstatable tail, unmeasured', async () => {
    expect((await run(null, [null, null])).unmeasured).toEqual([[0, 1]])
    const tail = await run(10n, [12n, null, null])
    expect([...tail.accrual]).toEqual([[0, 2n]])
    expect(tail.unmeasured).toEqual([[1, 2]])
  })
})
