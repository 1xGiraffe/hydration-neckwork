import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  PROTOCOL_REVENUE_PREDICATE_SQL,
  REVENUE_EVENT_COLUMNS,
  REVENUE_STREAMS,
  TREASURY_ACCOUNT,
  buildRevenueEventRowsSql,
  hollarBorrowHourlyRows,
} from '../src/services/revenueStreams.ts'

type Row = Record<string, unknown>

const ASSET_ROWS: Row[] = [
  { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1, symbol: 'LRNA', name: 'LRNA', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: 0, origin_ecosystem: 'polkadot', origin_chain_id: '0', origin_asset_id: null },
  { asset_id: 20, symbol: 'WETH', name: 'Ether', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1002, symbol: 'aUSDT', name: 'aUSDT', decimals: 6, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

// The builders bake per-asset decimal factors from the registry snapshot, the
// same way poolVolumes does; give them a deterministic registry.
let stopAssets: () => void
beforeAll(async () => {
  const registryClient = {
    query: vi.fn(async ({ query }: { query: string }) => {
      if (query.includes('FROM price_data.assets FINAL')) return { json: async () => ASSET_ROWS }
      return { json: async () => [] }
    }),
  }
  const { loadExplorerAssets, stopExplorerAssetsRefresh } = await import('../src/services/explorerAssets.ts')
  await loadExplorerAssets(registryClient as never)
  stopAssets = stopExplorerAssetsRefresh
})
afterAll(() => { stopAssets?.() })

const eventful = REVENUE_STREAMS.filter(s => s !== 'hollar_borrow')

describe('unified row shape', () => {
  it('every eventful stream selects the revenue_events columns and its own stream literal', () => {
    for (const stream of eventful) {
      const sql = buildRevenueEventRowsSql(stream)
      expect(sql, stream).toContain(`'${stream}' AS stream`)
      for (const col of REVENUE_EVENT_COLUMNS) {
        expect(sql, `${stream} must select AS ${col}`).toContain(`AS ${col}`)
      }
    }
  })

  it('every replaying source is deduplicated before aggregation', () => {
    for (const stream of eventful) {
      expect(buildRevenueEventRowsSql(stream), stream).toMatch(/argMax|FINAL|DISTINCT/)
    }
  })

  it('every stream binds the shared anchored window', () => {
    for (const stream of eventful) {
      const sql = buildRevenueEventRowsSql(stream)
      expect(sql, stream).toContain('{anchor:DateTime}')
      expect(sql, stream).toContain('{hours:UInt32}')
    }
  })

  it('an extra predicate reaches every source read of the stream', () => {
    // The derivations job injects the partition bound through this hook; a
    // builder that drops it would write rows outside the partition being
    // replaced, which REPLACE PARTITION would then silently discard.
    for (const stream of eventful) {
      const marker = "toYYYYMM(block_timestamp) = 209901"
      const sql = buildRevenueEventRowsSql(stream, marker)
      expect(sql, stream).toContain(marker)
    }
  })
})

describe('network_fee', () => {
  const sql = buildRevenueEventRowsSql('network_fee')

  it('reads TransactionFeePaid and never adds the tip to actualFee', () => {
    expect(sql).toContain("'TransactionPayment.TransactionFeePaid'")
    expect(sql).toContain("'actualFee'")
    // actualFee already INCLUDES the tip (verified on 3898/3898 joined rows);
    // any arithmetic combining the two would double-count every tipped fee.
    expect(sql).not.toMatch(/actualFee'\)[^\n]*\+[^\n]*tip|tip'\)[^\n]*\+[^\n]*actualFee/)
  })

  it('skips zero-fee events', () => {
    expect(sql).toMatch(/!= '0'/)
  })

  it('never reads FeeProcessor or Treasury.Deposit', () => {
    // FeeProcessor.* is TRADE fee plumbing (3x the row volume of TxFeePaid) and
    // Treasury.Deposit is dust sweeps — both classic miscount traps.
    expect(sql).not.toContain('FeeProcessor')
    expect(sql).not.toContain("'Treasury.Deposit'")
  })

  it('scopes EVM gas deposits to the three EVM call names and the treasury', () => {
    for (const call of ['Ethereum.transact', 'EVM.call', 'Dispatcher.dispatch_evm_call']) {
      expect(sql).toContain(`'${call}'`)
    }
    expect(sql).toContain(TREASURY_ACCOUNT)
    // WETH gas arrives as Tokens.Deposited currencyId 20; HDX gas as Balances.Deposit.
    expect(sql).toContain("'Tokens.Deposited'")
    expect(sql).toContain("'Balances.Deposit'")
  })

  it('prices the substrate arm as HDX regardless of the charged fee currency', () => {
    // actualFee is ALWAYS denominated in HDX (asset 0) — verified across every
    // fee currency; reading the charged currency here would misprice ~25% of rows.
    expect(sql).toMatch(/toUInt32\(0\) AS asset_id/)
    expect(sql).not.toContain('Currencies.Withdrawn')
  })
})

describe('liquidation_penalty', () => {
  const sql = buildRevenueEventRowsSql('liquidation_penalty')

  it('reads the collector transfer and un-scales value by the event index', () => {
    expect(sql).toContain('0xe52567ff06acd6cbe7ba94dc777a3126e180b6d9')
    expect(sql).toMatch(/value/)
    expect(sql).toContain("toUInt256('1000000000000000000000000000')")
  })

  it('attributes pro-rata by liquidatedCollateralAmount within a block-reserve group', () => {
    expect(sql).toContain('liquidatedCollateralAmount')
    // The exact-partition split: cumulative floor differences sum to the whole.
    expect(sql).toMatch(/intDiv/)
  })

  it('keeps unmatched transfers as unattributed rows rather than dropping them', () => {
    // A transfer with no same-block LiquidationCall on its reserve must still be
    // revenue (account = ''), or conservation against the stream total breaks.
    expect(sql).toMatch(/'' AS account|UNION ALL/)
  })
})

describe('omnipool fee streams', () => {
  it('splits hub and non-hub legs and classifies destinations', () => {
    const asset = buildRevenueEventRowsSql('omnipool_asset_fee')
    const hub = buildRevenueEventRowsSql('omnipool_protocol_fee')
    expect(asset).toContain('asset_id != 1')
    expect(hub).toContain('asset_id = 1')
    for (const sql of [asset, hub]) {
      for (const dest of ["'burned'", "'lp'", "'protocol'", "'unknown'"]) expect(sql).toContain(dest)
    }
  })

  it('unattributes the placeholder swapper', () => {
    expect(buildRevenueEventRowsSql('omnipool_asset_fee'))
      .toContain("'0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a'")
  })

  it('never lists the protocol among its own payers, on any attributed stream', () => {
    // Pallet accounts (treasury buybacks, the liquidation pallet's collateral
    // sales, referral/OTC bots) and the runtime executor pay with protocol
    // money; their rows keep their value but blank to the unattributed bucket.
    for (const stream of ['omnipool_asset_fee', 'omnipool_protocol_fee', 'hsm_revenue',
      'network_fee', 'liquidation_penalty', 'pepl_liquidation_profit'] as const) {
      const sql = buildRevenueEventRowsSql(stream)
      expect(sql, stream).toContain("startsWith")
      expect(sql, stream).toContain("'0x6d6f646c'")
      expect(sql, stream).toContain('0x45544800000000000000000000000000000000000000090a0000000000000000')
    }
  })

  it('exports the protocol-revenue predicate the explorer and account model share', () => {
    // Asset-fee legs count as protocol revenue only when routed out of the pool
    // (or burned); lp stays with LPs and legacy unknown legs stay unclassified.
    expect(PROTOCOL_REVENUE_PREDICATE_SQL).toContain('omnipool_asset_fee')
    expect(PROTOCOL_REVENUE_PREDICATE_SQL).toContain("dest IN ('protocol', 'burned')")
  })
})

describe('pepl_liquidation_profit', () => {
  it('attributes to the liquidated user in the ETH-mapped account form', () => {
    const sql = buildRevenueEventRowsSql('pepl_liquidation_profit')
    expect(sql).toContain("'user'")
    expect(sql).toContain("'0x45544800'")
    expect(sql).toContain('liquidation_extrinsics')
  })
})

describe('hsm_revenue', () => {
  const sql = buildRevenueEventRowsSql('hsm_revenue')

  it('keeps the arb semi-join scope guard and the buyback era switch', () => {
    expect(sql).toContain("'HSM.ArbitrageExecuted'")
    expect(sql).toContain('9336534')
    expect(sql).toContain('0x45544800000000000000000000000000000000000000090a0000000000000000')
  })

  it('attributes buyback fills to the swapper and arb profit to nobody', () => {
    expect(sql).toMatch(/swapper/)
    expect(sql).toMatch(/'' *\)? AS account|, ''\)/)
  })

  it('values peg collaterals at parity and drops non-positive profit', () => {
    expect(sql).toContain('1002, 1003')
    expect(sql).toMatch(/usd > 0/)
  })
})

describe('asset_reserve', () => {
  it('reads MintedToTreasury reserve-level with no payer', () => {
    const sql = buildRevenueEventRowsSql('asset_reserve')
    expect(sql).toContain("'MintedToTreasury'")
    expect(sql).toContain("'amountMinted'")
    expect(sql).toMatch(/'' AS account/)
  })
})

describe('hollarBorrowHourlyRows', () => {
  interface Call { query: string }
  function fakeClient(rowsByMarker: Record<string, unknown[]>): { calls: Call[]; client: never } {
    const calls: Call[] = []
    const client = {
      query: async ({ query }: { query: string }) => {
        calls.push({ query })
        const marker = Object.keys(rowsByMarker).find(m => query.includes(m))
        return { json: async () => (marker ? rowsByMarker[marker] : []) }
      },
    }
    return { calls, client: client as never }
  }

  const H = 3_600
  const t0 = 1_754_000_000 - (1_754_000_000 % H)

  const ch = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')

  it('accrues prevDebt × Δindex / RAY per hour, per pool, priced at the closed candle', async () => {
    const { client } = fakeClient({
      'money_market_reserve_state_history': [
        { bucket: ch(t0), pool_address: '0xpool', debt_scaled: '1000000000000000000000', borrow_index: '1000000000000000000000000000' },
        { bucket: ch(t0 + H), pool_address: '0xpool', debt_scaled: '1000000000000000000000', borrow_index: '1001000000000000000000000000' },
      ],
      'ohlc_1h': [{ bucket: ch(t0), close: '1' }],
    })
    const rows = await hollarBorrowHourlyRows(client, t0, t0 + H)
    expect(rows).toHaveLength(1)
    // 1000e18 scaled × 0.001 index growth = 1e18 planck = 1 HOLLAR at $1.
    expect(rows[0]).toMatchObject({ hour: t0 + H, poolAddress: '0xpool' })
    expect(rows[0].amountPlanck).toBe(10n ** 18n)
    expect(rows[0].usd1e12).toBe(10n ** 12n)
  })

  it('answers an empty view with an empty array, never zeros', async () => {
    const { client } = fakeClient({})
    expect(await hollarBorrowHourlyRows(client, t0, t0 + 4 * H)).toEqual([])
  })

  it('never leaks one pool\'s later price into another pool\'s earlier hour', async () => {
    const { client } = fakeClient({
      'money_market_reserve_state_history': [
        { bucket: ch(t0), pool_address: '0xa', debt_scaled: '1000000000000000000000', borrow_index: '1000000000000000000000000000' },
        { bucket: ch(t0 + H), pool_address: '0xa', debt_scaled: '1000000000000000000000', borrow_index: '1001000000000000000000000000' },
        { bucket: ch(t0), pool_address: '0xb', debt_scaled: '2000000000000000000000', borrow_index: '1000000000000000000000000000' },
        { bucket: ch(t0 + H), pool_address: '0xb', debt_scaled: '2000000000000000000000', borrow_index: '1001000000000000000000000000' },
      ],
      'ohlc_1h': [{ bucket: ch(t0), close: '1' }, { bucket: ch(t0 + H), close: '3' }],
    })
    const rows = await hollarBorrowHourlyRows(client, t0, t0 + H)
    // Both pools' t0+H accrual must use the price usable AT t0+H for that hour —
    // the same resolved timeline — so both value at 3, not one at 1.
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.usd1e12).toBe(row.amountPlanck * 3n / 10n ** 6n)
  })
})
