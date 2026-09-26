import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  EVM_EXECUTION_EVENTS,
  ICE_FEE_ACCOUNT,
  ICE_POT_ACCOUNT, TREASURY_H160,
  PARENT_SOVEREIGN_ACCOUNT,
  PROTOCOL_REVENUE_PREDICATE_SQL,
  REVENUE_EVENT_COLUMNS,
  REVENUE_STREAMS,
  TREASURY_ACCOUNT,
  buildRevenueEventRowsSql,
  hollarBorrowHourlyRows,
  siblingSovereignAccountSql,
} from '../src/services/revenueStreams.ts'
import { OMNIPOOL_ACCOUNT } from '../src/services/valuation.ts'
import { XCM_BARRIER_EVENTS, XCM_EXECUTE_BARRIER_EVENT, XCM_FEE_RUN_EVENTS } from '../src/services/xcmWalkEvents.ts'

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

  // The deposit arm is the extrinsic page's fee resolver (extrinsicFeePayment.ts)
  // restated in SQL; each rule below is one the resolver's own tests pin.
  it('scopes the deposit arm by the pallet-evm execution events and dispatch_permit, not by call name', () => {
    for (const marker of EVM_EXECUTION_EVENTS) expect(sql).toContain(`'${marker}'`)
    expect(sql).toContain("'MultiTransactionPayment.dispatch_permit'")
    // A call-name list missed every EVM call inside a Utility.batch_all and had
    // no way to say dispatch_permit; the marker events survive any wrapper.
    for (const call of ['Ethereum.transact', 'EVM.call', 'Dispatcher.dispatch_evm_call']) {
      expect(sql).not.toContain(`'${call}'`)
    }
    expect(sql).toContain(TREASURY_ACCOUNT)
    expect(sql).toContain("'Tokens.Deposited'")
    expect(sql).toContain("'Balances.Deposit'")
  })

  it('books a treasury deposit in whatever currency the payer was debited in', () => {
    // dispatch_permit fees settle in the permit signer's fee currency (USDT, DOT,
    // …) and EVM gas in the account's; pinning WETH (20) or HDX dropped them all.
    expect(sql).not.toMatch(/toUInt32\(20\)/)
    expect(sql).not.toMatch(/currencyId'\)\s*=\s*20/)
    for (const debit of ['Tokens.Withdrawn', 'Balances.Withdraw', 'Balances.Burned']) {
      expect(sql).toContain(`'${debit}'`)
    }
    // The debit must be the payer's and in the deposit's currency.
    expect(sql).toContain('(d.block_height, d.ext_index, x.payer, d.currency) IN (SELECT block_height, ext_index, who, currency FROM gas_debits)')
    // The payer is the signer, or the recovered signer of an unsigned dispatch.
    expect(sql).toContain("coalesce(signer, effective_signer, '') AS payer")
  })

  it('takes every deposit in the last candidate currency except a substrate fee the first arm booked', () => {
    expect(sql).toContain('argMax(currency, event_index) AS fee_currency')
    expect(sql).toContain('c.currency = s.fee_currency')
    // hasSubstrateFee's `fee + tip > 0`, from the extrinsic's own columns; a
    // dispatch_evm_call's post-dispatch fee deposit IS actualFee, and booking it
    // here as well counted the substrate fee twice.
    expect(sql).toContain("toUInt256OrZero(ifNull(fee, '0')) + toUInt256OrZero(ifNull(tip, '0')) > 0")
    expect(sql).toContain('NOT (c.substrate_fee = 1 AND c.event_index = s.last_index)')
  })

  it('leaves the dust of a killed account to the treasury without booking it', () => {
    expect(sql).toContain("'Balances.DustLost'")
    expect(sql).toContain('NOT IN (SELECT block_height, deposit_index FROM dust_sweeps)')
  })

  it('never counts the Currencies.* mirror events', () => {
    // The mirrors appear only in the XCM run vocabulary (events a treasury deposit
    // may be separated from its barrier by), never in a read that books or
    // vouches for a deposit.
    const counting = sql.slice(sql.indexOf('gas_debits AS ('), sql.indexOf('xf_barriers AS ('))
    expect(counting).toContain('gas_deposits AS (')
    expect(counting).not.toContain('Currencies.Deposited')
    expect(counting).not.toContain('Currencies.Withdrawn')
    expect(sql.slice(sql.indexOf('gas_candidates AS ('))).not.toContain('Currencies.')
  })

  it("leaves the XCM weight trader's deposit to the xcm_execution_fee stream", () => {
    // A dispatch_permit or an Ethereum.transact can run a PolkadotXcm.execute; its
    // program's WithdrawAsset debits the payer in the fee currency, so the trader's
    // treasury deposit passed the debit rule and — whenever the permit fee settled
    // in the same currency (21 permits in a million blocks) — was summed into the
    // gas. Excluded by the fee stream's own definition, so the two are disjoint.
    expect(sql).toContain(`xf_barriers AS (`)
    expect(sql).toContain(`event_name IN ('${XCM_EXECUTE_BARRIER_EVENT}')`)
    expect(sql).toContain('SELECT block_height, event_index, ext_index AS ctx FROM gas_deposits')
    expect(sql).toContain('AND (d.block_height, d.event_index) NOT IN (SELECT block_height, event_index FROM xf_fees)')
    // The inbound-message barriers are not this arm's concern: every deposit it
    // reads sits inside an extrinsic, so the local-execution barrier is the only
    // one its run CTEs read.
    expect(sql).not.toMatch(/event_name IN \([^)]*'(MessageQueue\.Processed|DmpQueue\.ExecutedDownward|XcmpQueue\.Success|XcmpQueue\.Fail)'/)
  })

  it('prices the substrate arm as HDX regardless of the charged fee currency', () => {
    // actualFee is ALWAYS denominated in HDX (asset 0) — verified across every
    // fee currency; reading the charged currency here would misprice ~25% of rows.
    expect(sql).toMatch(/toUInt32\(0\) AS asset_id/)
    expect(sql.slice(0, sql.indexOf('xf_barriers AS ('))).not.toContain('Currencies.Withdrawn')
  })
})

describe('xcm_execution_fee', () => {
  const sql = buildRevenueEventRowsSql('xcm_execution_fee')

  it('is listed once, last, so every ordered consumer agrees', () => {
    expect(REVENUE_STREAMS.indexOf('xcm_execution_fee')).toBe(REVENUE_STREAMS.length - 1)
    expect(REVENUE_STREAMS.filter(s => s === 'xcm_execution_fee')).toHaveLength(1)
  })

  it("reads the trader's deposit to the treasury before every execution barrier, in every era", () => {
    expect(sql).toContain('-- rev:xcm_execution_fee')
    expect(sql).toContain(`JSONExtractString(args_json, 'who') = '${TREASURY_ACCOUNT}'`)
    expect(sql).toContain("event_name IN ('Tokens.Deposited', 'Balances.Deposit')")
    // The inbound barriers of both runtime eras (the feed's own list) plus the
    // local-execution barrier, in one list — a decode that only knows
    // MessageQueue.Processed drops every pre-migration message's fee.
    const barriers = [...XCM_BARRIER_EVENTS, XCM_EXECUTE_BARRIER_EVENT].map(n => `'${n}'`).join(', ')
    expect(sql).toContain(`event_name IN (${barriers})`)
    // MessageQueue.Processed is hook-only (its rare extrinsic-context occurrences
    // are ServiceQueues calls); the pre-migration barriers ran inside the
    // set_validation_data inherent and keep its extrinsic index as their context.
    expect(sql).toContain("(extrinsic_index IS NULL OR event_name != 'MessageQueue.Processed')")
    expect(sql).toContain('ifNull(extrinsic_index, 4294967295) AS ctx')
  })

  it('takes the last treasury deposit joined to the barrier by run events only, never past the previous barrier', () => {
    // The trader deposits when the executor drops — after every instruction — so
    // only the run's own bookkeeping (XCM_FEE_RUN_EVENTS: mirrors, the HDX Issued
    // twin, AssetsTrapped, Sent, …) may sit between the deposit and the barrier.
    // The WETH gas of an EVM call the message Transacted, a DCA hook deposit in a
    // block's first segment and a dust sweep all fail that rule and stay out.
    const runList = XCM_FEE_RUN_EVENTS.map(n => `'${n}'`).join(', ')
    expect(sql).toContain(`event_name IN (${runList})`)
    expect(XCM_FEE_RUN_EVENTS).not.toContain(XCM_EXECUTE_BARRIER_EVENT)
    expect(sql).toContain('length(arrayFilter(i -> i > d.event_index AND i < r.barrier, p.idx)) = toInt64(r.barrier) - toInt64(d.event_index) - 1')
    expect(sql).toContain('max(d.event_index) AS event_index')
    expect(sql).toContain('lagInFrame(toInt64(event_index), 1, toInt64(-1)) OVER (PARTITION BY block_height, ctx ORDER BY event_index')
    expect(sql).toContain('toInt64(d.event_index) > r.floor AND d.event_index < r.barrier')
    expect(sql).toContain("'Balances.DustLost'")
    expect(sql).toContain('NOT IN (SELECT block_height, deposit_index FROM xf_dust)')
  })

  it('attributes an inbound fee to the origin the barrier names and a local execute to its signer', () => {
    // Sibling(id) → the `sibl` + LE u32 sovereign; Parent (and every DmpQueue
    // barrier) → the relay's `Parent` account; a pre-migration XCMP barrier names
    // no sender and yields ''. A PolkadotXcm.execute pays from its dispatcher:
    // the signer, or the recovered effective signer of an unsigned EVM dispatch.
    expect(sql).toContain(`'${PARENT_SOVEREIGN_ACCOUNT}'`)
    expect(PARENT_SOVEREIGN_ACCOUNT).toMatch(/^0x506172656e74(00){26}$/)
    expect(sql).toContain(siblingSovereignAccountSql("JSONExtractUInt(f.barrier_args, 'origin', 'value')"))
    expect(siblingSovereignAccountSql('1000')).toContain("concat('0x7369626c'")
    expect(sql).toContain("coalesce(signer, effective_signer, '') AS payer")
    expect(sql).toContain(`if(f.barrier_name = '${XCM_EXECUTE_BARRIER_EVENT}', x.payer,`)
    // Sovereigns stay attributed (another chain executing here is a user); the
    // protocol's own pallet accounts blank to the unattributed bucket.
    expect(sql).toContain("startsWith(f.payer, '0x6d6f646c')")
    expect(sql).toContain('FROM price_data.raw_extrinsics FINAL')
  })

  it('books the deposit in its own currency, positive amounts only, valued at event time', () => {
    expect(sql).toContain("if(event_name = 'Tokens.Deposited', toUInt32(JSONExtractUInt(args_json, 'currencyId')), toUInt32(0))")
    expect(sql).toContain('WHERE d.amount > 0')
    expect(sql).toMatch(/'' AS dest/)
    expect(sql).toContain('ASOF LEFT JOIN')
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
      for (const dest of ["'burned'", "'pol'", "'protocol'", "'unknown'"]) expect(sql).toContain(dest)
    }
    // Only the asset fee can be an LP's: it stays in the position of the asset it
    // was charged in, while every retained hub fee lands in HDX (see below).
    expect(asset).toContain("'lp'")
    expect(hub).not.toContain("'lp'")
  })

  // The runtime credits every non-burned hub protocol fee to the HDX sub-pool's hub
  // reserve (process_protocol_fee → increase_hdx_subpool_hub_reserve), so the leg's
  // recipient is the whole rule and the traded pair is irrelevant to it. The asset fee
  // is charged in the traded asset and stays in that asset's position, so there the
  // fee's own asset decides.
  it('marks every hub fee the Omnipool keeps as protocol-owned, whatever was sold', () => {
    const sql = buildRevenueEventRowsSql('omnipool_protocol_fee')
    expect(sql).toContain(`f.fee_recipient = '${OMNIPOOL_ACCOUNT}', 'pol'`)
    // Nothing about the swap's other legs may enter the classification.
    expect(sql).not.toContain("leg_kind = 'in'")
    expect(sql).not.toContain('sold_asset')
    // And no era switch: the rule holds for every hub leg the pool ever kept,
    // because before it the chain burned or routed them out instead.
    expect(sql).not.toMatch(/block_height\s*[<>]/)
  })

  it('leaves an asset fee with the LPs unless it was charged in HDX', () => {
    expect(buildRevenueEventRowsSql('omnipool_asset_fee'))
      .toContain(`f.fee_recipient = '${OMNIPOOL_ACCOUNT}', if(f.asset_id = 0, 'pol', 'lp')`)
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

  // The pot pays the pool fees of the routes it runs for the intents it settles, so
  // the payer is the intent OWNER — exactly one when the solution settled one owner's
  // intents (every solution so far); several owners' fills in one solution cannot
  // split its routes between them and stay unattributed, as a pallet payer does.
  it("attributes the ICE pot's route fees to the solution's single intent owner", () => {
    const marker = "toYYYYMM(block_timestamp) = 209901"
    for (const stream of ['omnipool_asset_fee', 'omnipool_protocol_fee'] as const) {
      const sql = buildRevenueEventRowsSql(stream, marker)
      expect(sql, stream).toMatch(/FROM price_data\.intent_events(\s+AS\s+\w+)?\s+FINAL/)
      expect(sql, stream).toMatch(/FROM price_data\.intent_orders(\s+AS\s+\w+)?\s+FINAL/)
      // The NOT NULL filter reads the TABLE's column: `assumeNotNull(x) AS x`
      // would resolve the later `x` to the alias, which is never null.
      expect(sql, stream).toContain('ie.extrinsic_index IS NOT NULL')
      expect(sql, stream).toContain("if(uniqExact(o.owner) = 1, any(o.owner), '') AS owner")
      expect(sql, stream).toContain(`if(f.swapper = '${ICE_POT_ACCOUNT}' AND i.owner != '', i.owner,`)
      // The owner read is bounded like every other source read of the stream.
      const reads = sql.split(marker).length - 1
      expect(reads, stream).toBeGreaterThanOrEqual(2)
    }
  })

  it('exports the protocol-revenue predicate the explorer and account model share', () => {
    // Fee legs count as protocol revenue when routed out of the pool, burned, or
    // retained in the protocol-provided HDX position ('pol'). A leg left with the LPs
    // of the position it landed in ('lp') never counts — on either fee stream, though
    // only the asset fee can produce one. Legacy asset-fee legs whose destination the
    // chain never recorded stay unclassified.
    expect(PROTOCOL_REVENUE_PREDICATE_SQL).toContain('omnipool_asset_fee')
    expect(PROTOCOL_REVENUE_PREDICATE_SQL).toContain("dest IN ('protocol', 'burned', 'pol')")
    expect(PROTOCOL_REVENUE_PREDICATE_SQL).toContain("dest != 'lp'")
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

describe('ice_matched_fee', () => {
  const sql = buildRevenueEventRowsSql('ice_matched_fee')

  it('is listed once, right after hsm_revenue, so every ordered consumer agrees', () => {
    expect(REVENUE_STREAMS.indexOf('ice_matched_fee')).toBe(REVENUE_STREAMS.indexOf('hsm_revenue') + 1)
    expect(REVENUE_STREAMS.filter(s => s === 'ice_matched_fee')).toHaveLength(1)
  })

  it('reads the pot → fee-account sweep as ONE Currencies.Transferred, in that direction', () => {
    expect(sql).toContain('-- rev:ice_matched_fee')
    expect(sql).toContain("event_name = 'Currencies.Transferred'")
    expect(sql).toContain(`JSONExtractString(args_json, 'from') = '${ICE_POT_ACCOUNT}'`)
    expect(sql).toContain(`JSONExtractString(args_json, 'to') = '${ICE_FEE_ACCOUNT}'`)
    // The runtime emits a paired Tokens.Transfer / Balances.Transfer for the same
    // movement; reading either beside Currencies.Transferred books the fee twice.
    expect(sql).not.toContain("'Tokens.Transfer'")
    expect(sql).not.toContain("'Balances.Transfer'")
  })

  it('names two distinct pallet accounts', () => {
    expect(ICE_POT_ACCOUNT).not.toBe(ICE_FEE_ACCOUNT)
    for (const account of [ICE_POT_ACCOUNT, ICE_FEE_ACCOUNT]) {
      expect(account).toMatch(/^0x6d6f646c[0-9a-f]{56}$/)
    }
  })

  it('books the transferred currency and a u128 amount whether it was serialised as number or string', () => {
    expect(sql).toContain("JSONExtractUInt(args_json, 'currencyId')")
    expect(sql).toContain(`toUInt256OrZero(replaceAll(JSONExtractRaw(args_json, 'amount'), '"', ''))`)
    expect(sql).toMatch(/argMax/)
  })

  it('is protocol revenue with no payer: the matched set paid it, not one account', () => {
    expect(sql).toMatch(/'' AS dest/)
    expect(sql).toMatch(/'' AS account/)
    expect(sql).not.toContain('startsWith')
  })
})

describe('uniswap_v3_fee', () => {
  const sql = buildRevenueEventRowsSql('uniswap_v3_fee')

  it('is listed once, right after ice_matched_fee, so every ordered consumer agrees', () => {
    expect(REVENUE_STREAMS.indexOf('uniswap_v3_fee')).toBe(REVENUE_STREAMS.indexOf('ice_matched_fee') + 1)
    expect(REVENUE_STREAMS.filter(s => s === 'uniswap_v3_fee')).toHaveLength(1)
  })

  // The Gamma vault pays its fee share as a plain ERC-20 Transfer to the Treasury's EVM
  // address; only a vault the projection announced counts, or any contract paying the
  // treasury would read as pool revenue.
  it('reads the vault fee share as a Transfer from a known vault to the Treasury address', () => {
    expect(sql).toContain('-- rev:uniswap_v3_fee')
    expect(sql).toContain("event_name = 'Transfer'")
    expect(sql).toContain(`lower(JSONExtractString(decoded_args_json, 'to')) = '${TREASURY_H160}'`)
    expect(sql).toContain('IN (SELECT vault_address FROM price_data.uniswap_v3_vaults FINAL)')
    expect(TREASURY_H160).toBe('0x6d6f646c70792f74727372790000000000000000')
  })

  // The protocol's share of a swap fee is revenue when the swap happens, not when
  // governance sweeps it. Only the factory owner (the runtime's AaveManagerAccount,
  // via root or the EconomicParameters track) can call collectProtocol, so a sweep
  // may never come — booking it meant the stream showed the Gamma cut alone, $0.62
  // against ~$53.7 the pool had already earned.
  it('books the pool protocol fee where it accrues, under its own dest', () => {
    expect(sql).toContain("'accrued' AS dest")
    // The gross fee is already derived once, per swap and per payer, by the legs
    // job; the protocol keeps 1/feeProtocol of it. Recomputing the tier against the
    // raw Swap amounts here would be the same number written a second way.
    expect(sql).toContain("l.venue = 'uniswapv3' AND l.leg_kind = 'fee'")
    expect(sql).toContain('intDiv(f.gross_fee, fp.fp)')
    // The payer rides along, which is what lets account_revenue attribute the
    // accrual directly instead of spreading a realization nobody made.
    expect(sql).toContain('swapper AS account')
  })

  // Booking both the accrual and the sweep would count one fee twice: a collect
  // moves a balance this stream has already recognised, exactly as a HOLLAR
  // repayment is not revenue on top of the interest that accrued.
  it('does not book CollectProtocol, which would double-count the accrual', () => {
    expect(sql).not.toContain('CollectProtocol')
  })

  // The rate in force at a swap was usually set long before the window being
  // recomputed, so the SetFeeProtocol relation must not carry the job's window or
  // an incremental recompute would silently accrue nothing.
  it('reads the fee-protocol rate without the job window, as of each swap', () => {
    expect(sql).toContain("event_name = 'SetFeeProtocol'")
    expect(sql).toContain('fp.pool = f.pool AND fp.side = f.side AND fp.at_key <= f.at_key')
    const feeProtocolCte = sql.slice(sql.indexOf('fee_protocol AS ('), sql.indexOf('swap_fees AS ('))
    expect(feeProtocolCte).not.toContain('block_timestamp >')
  })

  // dest is what keeps the two arms tellable apart on a frozen stream enum, and
  // anything that is not an omnipool 'lp' leg counts as protocol revenue in full.
  it('counts the accrual as protocol revenue without touching the stream list', () => {
    expect(REVENUE_STREAMS.filter(s => s.startsWith('uniswap_v3'))).toEqual(['uniswap_v3_fee'])
    expect(PROTOCOL_REVENUE_PREDICATE_SQL).toContain("dest != 'lp'")
  })

  // A token the registry cannot name must not become asset 0 (HDX) by default.
  it('resolves the token through the registry or the precompile rule and drops strangers', () => {
    expect(sql).toContain("FROM price_data.assets WHERE evm_address != ''")
    expect(sql).toContain('asset_id != 4294967295')
  })

  it('is protocol revenue with no payer', () => {
    expect(sql).toMatch(/'' AS dest/)
    expect(sql).toMatch(/'' AS account/)
  })
})

describe('hollarBorrowHourlyRows', () => {
  // The seed read hits the same view as the window read, so it is matched by its
  // own tag first — the generic view marker would otherwise answer both.
  const SEED = 'rev:hollar-seed'
  interface Call { query: string }
  function fakeClient(rowsByMarker: Record<string, unknown[]>): { calls: Call[]; client: never } {
    const calls: Call[] = []
    const client = {
      query: async ({ query }: { query: string }) => {
        calls.push({ query })
        const marker = query.includes(SEED)
          ? SEED
          : Object.keys(rowsByMarker).find(m => m !== SEED && query.includes(m))
        return { json: async () => (marker ? rowsByMarker[marker] ?? [] : []) }
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

  it('reports how many hours a sparse pool\'s accrual actually covers', async () => {
    // A quiet market is observed only when something touches it. The view emits
    // no row for the hours between, so the index delta booked at the later hour
    // is FIVE hours of interest, not one. Consumers that read the amount as a
    // RATE need the span to divide by; without it a lump reads 5x too high.
    const { client } = fakeClient({
      'money_market_reserve_state_history': [
        { bucket: ch(t0), pool_address: '0xquiet', debt_scaled: '1000000000000000000000', borrow_index: '1000000000000000000000000000' },
        { bucket: ch(t0 + 5 * H), pool_address: '0xquiet', debt_scaled: '1000000000000000000000', borrow_index: '1001000000000000000000000000' },
      ],
      'ohlc_1h': [{ bucket: ch(t0), close: '1' }],
    })
    const rows = await hollarBorrowHourlyRows(client, t0, t0 + 5 * H)
    expect(rows).toHaveLength(1)
    // The amount itself is unchanged — booking must stay byte-identical.
    expect(rows[0].amountPlanck).toBe(10n ** 18n)
    expect(rows[0].hoursCovered).toBe(5)
  })

  // The leak this guards against: the view emits a row only for an hour the
  // reserve was TOUCHED, so the observation before a window boundary is routinely
  // hours back — 3 to 30 in the measured history. Differencing against a
  // one-hour lead-in finds nothing there and drops the segment outright, losing
  // one accrual per pool per window. Because the derivations job runs a month
  // partition at a time, that fell on every month boundary: 13 unbooked segments
  // worth 2,398.90 HOLLAR (~$2,394) between 2025-09 and 2026-09-17, which is the
  // whole of the explorer's shortfall against /api/v1/fees/charts on this stream.
  it('books the first observation in the window against the last one BEFORE it', async () => {
    const { client, calls } = fakeClient({
      [SEED]: [{
        pool_address: '0xpool',
        debt_scaled: '1000000000000000000000',
        borrow_index: '1000000000000000000000000000',
        index_bucket: ch(t0 - 8 * H),
      }],
      'money_market_reserve_state_history': [
        { bucket: ch(t0), pool_address: '0xpool', debt_scaled: '1000000000000000000000', borrow_index: '1001000000000000000000000000' },
      ],
      'ohlc_1h': [{ bucket: ch(t0), close: '1' }],
    })
    const rows = await hollarBorrowHourlyRows(client, t0, t0 + H)
    expect(rows).toHaveLength(1)
    expect(rows[0].amountPlanck).toBe(10n ** 18n)
    // …and the span is the real gap back to that observation, not one hour.
    expect(rows[0].hoursCovered).toBe(8)
    // The seed must not be bounded by a guessed lookback: a pool untouched for
    // months still has to difference against its last real observation.
    const seed = calls.find(c => c.query.includes(SEED))!
    expect(seed.query).toContain("start_time = '1970-01-01 00:00:00'")
  })

  // The other half of the same boundary. The view bounds the UNDERLYING events by
  // `block_timestamp <= end_time` and buckets them afterwards, so an hour-aligned
  // end_time returns no bucket for that hour unless an event landed exactly on the
  // second — measured live: end_time '2025-09-30 23:00:00' returns 20:00, 21:00,
  // 22:00 and no 23:00, while '2025-09-30 23:59:59' returns all four. That dropped
  // each month's last accrual: 666.21 HOLLAR over six month-ends, 2025-09 … 2026-07.
  it('asks the view for the whole of the last hour, not just its first second', async () => {
    const { client, calls } = fakeClient({
      'money_market_reserve_state_history': [
        { bucket: ch(t0), pool_address: '0xpool', debt_scaled: '1000000000000000000000', borrow_index: '1000000000000000000000000000' },
        { bucket: ch(t0 + H), pool_address: '0xpool', debt_scaled: '1000000000000000000000', borrow_index: '1001000000000000000000000000' },
      ],
      'ohlc_1h': [{ bucket: ch(t0), close: '1' }],
    })
    const rows = await hollarBorrowHourlyRows(client, t0, t0 + H)
    const debt = calls.find(c => c.query.includes('rev:hollar-debt'))!
    expect(debt.query).toContain(`end_time = '${ch(t0 + H + 3_599)}'`)
    // Reading the full hour must not book an hour past the window.
    expect(rows.every(r => r.hour <= t0 + H)).toBe(true)
  })

  it('emits nothing for a pool whose first observation has no predecessor at all', async () => {
    // Nothing to difference against is not zero interest — it is no model. The
    // pool's accrual starts being booked at its second observation.
    const { client } = fakeClient({
      'money_market_reserve_state_history': [
        { bucket: ch(t0), pool_address: '0xnew', debt_scaled: '1000000000000000000000', borrow_index: '1000000000000000000000000000' },
        { bucket: ch(t0 + H), pool_address: '0xnew', debt_scaled: '1000000000000000000000', borrow_index: '1001000000000000000000000000' },
      ],
      'ohlc_1h': [{ bucket: ch(t0), close: '1' }],
    })
    const rows = await hollarBorrowHourlyRows(client, t0, t0 + H)
    expect(rows).toHaveLength(1)
    expect(rows[0].hour).toBe(t0 + H)
  })

  it('reports a contiguous pool\'s accrual as covering one hour', async () => {
    const { client } = fakeClient({
      'money_market_reserve_state_history': [
        { bucket: ch(t0), pool_address: '0xbusy', debt_scaled: '1000000000000000000000', borrow_index: '1000000000000000000000000000' },
        { bucket: ch(t0 + H), pool_address: '0xbusy', debt_scaled: '1000000000000000000000', borrow_index: '1001000000000000000000000000' },
      ],
      'ohlc_1h': [{ bucket: ch(t0), close: '1' }],
    })
    const rows = await hollarBorrowHourlyRows(client, t0, t0 + H)
    expect(rows[0].hoursCovered).toBe(1)
  })
})
