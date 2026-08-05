import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { unusableFilterParam } from './explorer.ts'
import {
  liqActionFor, liquidityActionEventNames, isAmountlessLiquidityEvent, liquidityRowAmount,
  evmTransactionFacts, getExtrinsic, search, initExplorerService,
} from '../services/explorerService.ts'
import type { PriceInfo } from '../services/explorerService.ts'
import { initGovernanceService } from '../services/governanceService.ts'
import { evmTransactionReceipt } from '../services/evmReceipt.ts'
import type { ClickHouseClient } from '../db/client.ts'

// A filter the server cannot honour must be refused, never dropped. Dropping one
// answers a wider question under the caller's own parameters: an unrecognized
// `type` used to fall back to `all`, so `?type=staking` (the row-type word rather
// than the wire word `stake`) returned the UNFILTERED total and every family's
// rows, indistinguishable from a genuine answer.
describe('unusableFilterParam', () => {
  it('accepts an absent or cleared filter as unfiltered', () => {
    expect(unusableFilterParam({})).toBeNull()
    expect(unusableFilterParam({ type: '', min: '', from: '', to: '', unit: '' })).toBeNull()
  })

  it('accepts every activity type the wire vocabulary defines', () => {
    for (const type of ['all', 'transfer', 'trade', 'dca', 'liquidity', 'mm', 'xcm', 'stake', 'vote', 'otc']) {
      expect(unusableFilterParam({ type })).toBeNull()
    }
  })

  it('refuses the row-type word rather than widening to the whole feed', () => {
    expect(unusableFilterParam({ type: 'staking' })?.key).toBe('type')
    expect(unusableFilterParam({ type: 'nonsense' })?.key).toBe('type')
  })

  it('refuses a min that is not a number, and honours one that is', () => {
    expect(unusableFilterParam({ min: '10' })).toBeNull()
    expect(unusableFilterParam({ min: '0' })).toBeNull()
    // A negative floor selects every row, which is what the reader resolves it to.
    expect(unusableFilterParam({ min: '-5' })).toBeNull()
    expect(unusableFilterParam({ min: 'abc' })?.key).toBe('min')
  })

  it('refuses a unit outside the two the value filter understands', () => {
    expect(unusableFilterParam({ unit: 'usd' })).toBeNull()
    expect(unusableFilterParam({ unit: 'token' })).toBeNull()
    expect(unusableFilterParam({ unit: 'eur' })?.key).toBe('unit')
  })

  it('refuses a date that is not a real calendar day', () => {
    expect(unusableFilterParam({ from: '2025-02-28', to: '2025-03-01' })).toBeNull()
    expect(unusableFilterParam({ from: '2025-02-30' })?.key).toBe('from')
    expect(unusableFilterParam({ to: '28-02-2025' })?.key).toBe('to')
    expect(unusableFilterParam({ to: '2025-13-01' })?.key).toBe('to')
  })

  it('reports the first unusable filter with what it expected', () => {
    expect(unusableFilterParam({ type: 'staking', min: 'abc' })).toEqual({
      key: 'type',
      expected: 'all, transfer, trade, dca, liquidity, mm, xcm, stake, vote, otc',
    })
  })

  it('refuses a repeated parameter rather than reading one arbitrary copy', () => {
    // Fastify parses `?type=trade&type=vote` into an array; neither copy may be
    // silently preferred over the other.
    expect(unusableFilterParam({ type: ['trade', 'vote'] })?.key).toBe('type')
  })
})

// XYK.PoolDestroyed always rides alongside XYK.LiquidityRemoved (728 of 728
// extrinsic groups chain-wide), so it is a lifecycle marker carrying no value.
// XYK.PoolCreated never rides alongside XYK.LiquidityAdded (0 of 956), so it is
// the only record of the seed liquidity and must keep its amount.
describe('liquidity pool lifecycle classification', () => {
  it('labels pool destruction distinctly rather than falling through to Add', () => {
    expect(liqActionFor('XYK.PoolDestroyed')).toBe('Destroy')
    expect(liqActionFor('XYK.PoolCreated')).toBe('Create')
    expect(liqActionFor('XYK.LiquidityRemoved')).toBe('Remove')
    expect(liqActionFor('XYK.LiquidityAdded')).toBe('Add')
    expect(liqActionFor('OmnipoolLiquidityMining.RewardClaimed')).toBe('Claim')
  })

  it('keeps the derived action inverse consistent with the label', () => {
    expect(liquidityActionEventNames('Destroy')).toEqual(['XYK.PoolDestroyed'])
    expect(liquidityActionEventNames('Remove')).not.toContain('XYK.PoolDestroyed')
    expect(liquidityActionEventNames()).toContain('XYK.PoolDestroyed')
  })

  it('marks pool destruction amountless so the paired removal is not double-counted', () => {
    expect(isAmountlessLiquidityEvent('XYK.PoolDestroyed')).toBe(true)
    // Every other empty-amount event MUST still be fillable from its transfer leg.
    expect(isAmountlessLiquidityEvent('XYK.PoolCreated')).toBe(false)
    expect(isAmountlessLiquidityEvent('XYK.LiquidityAdded')).toBe(false)
    expect(isAmountlessLiquidityEvent('XYK.LiquidityRemoved')).toBe(false)
    expect(isAmountlessLiquidityEvent('Omnipool.LiquidityRemoved')).toBe(false)
  })

  // The read model hands an amountless event exactly '' (see
  // LIQUIDITY_AMOUNT_ARG['XYK.PoolDestroyed']), and Number('') is 0 — so without an
  // explicit guard at the row's construction, a Destroy row would price at exactly
  // $0.00 the moment its asset has a live price, rather than carrying no value at
  // all. The price MUST be present for this to be a real test: with none loaded,
  // usdValue already returns null on its own and this would pass vacuously.
  it('keeps a Destroy row valueless on the wire even when its asset has a live price', () => {
    const prices = new Map<number, PriceInfo>([[5, { price: 2.5, change24h: 0 }]])
    expect(liquidityRowAmount('XYK.PoolDestroyed', prices, 5, '', 12)).toEqual({ amount: null, valueUsd: null })
    // Sanity: the same helper must still price a REAL amount for a non-amountless
    // event under the same price map, so the guard isn't just returning null
    // unconditionally.
    expect(liquidityRowAmount('XYK.LiquidityAdded', prices, 5, String(4 * 10 ** 12), 12)).toEqual({ amount: String(4 * 10 ** 12), valueUsd: 10 })
  })
})

// --- EVM transaction deep links -------------------------------------------------

// The declarative schema is the only place a table or MV is defined, so the one
// coupling that cannot be caught anywhere else — a projection mapped to its
// destination BY POSITION — can only be asserted against the schema files.
const SCHEMA_DIR = fileURLToPath(new URL('../../../clickhouse/schema/', import.meta.url))

function schemaStatement(file: string, name: string): string {
  const sql = readFileSync(SCHEMA_DIR + file, 'utf8')
  const statement = sql.split(';').find(s => s.includes(name))
  if (!statement) throw new Error(`${name} is not declared in clickhouse/schema/${file}`)
  return statement
}

// Comma-separated at paren depth 0 — a projection expression carries commas of its
// own (JSONExtractString(args_json, 'from')).
function topLevelParts(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of list) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(current); current = '' } else current += ch
  }
  if (current.trim()) out.push(current)
  return out
}

// The names a materialized view's SELECT projects, in order: its alias where it has
// one, else the bare column.
function projectedNames(mv: string): string[] {
  const select = mv.slice(mv.indexOf(' AS SELECT ') + ' AS SELECT '.length)
  return topLevelParts(select.slice(0, select.lastIndexOf(' FROM '))).map(expr => {
    const trimmed = expr.trim()
    const alias = trimmed.lastIndexOf(' AS ')
    return (alias >= 0 ? trimmed.slice(alias + 4) : trimmed).trim()
  })
}

describe('evm_transactions declaration', () => {
  const table = schemaStatement('001_tables.sql', 'price_data.evm_transactions ')
  const mv = schemaStatement('003_materialized_views.sql', 'price_data.evm_transactions_mv')

  // evm_transactions_mv carries no explicit column list, so ClickHouse maps its
  // SELECT to the destination by POSITION. extrinsic_index and event_index are both
  // integers next to each other, so a reordering would not fail — it would silently
  // write each into the other's column, and every hash would resolve to the wrong
  // extrinsic.
  it('projects columns in exactly the destination table order', () => {
    expect(projectedNames(mv)).toEqual([...table.matchAll(/`([a-z_0-9]+)`/g)].map(m => m[1]))
  })

  it('is hash-first and unpartitioned, which is the only reason it exists', () => {
    expect(table).toContain('ORDER BY tx_hash')
    // Partitioning by month would make a point lookup touch every partition.
    expect(table).not.toContain('PARTITION BY')
    // Replay safety: re-inserting a raw range replaces rather than duplicates.
    expect(table).toContain('ReplacingMergeTree(ingested_at)')
  })

  it('reads the same source and predicate as evm_executed_mv', () => {
    const executed = schemaStatement('003_materialized_views.sql', 'price_data.evm_executed_mv')
    for (const sql of [mv, executed]) {
      expect(sql).toContain('FROM price_data.raw_events')
      expect(sql).toContain("event_name = 'Ethereum.Executed'")
    }
  })
})

// The Ethereum-native facts come off the extrinsic's OWN Ethereum.Executed event,
// which the detail already carries — evm_transactions is ordered by tx_hash and
// cannot be asked "what happened at this (block, index)" without reading all of it.
describe('evmTransactionFacts', () => {
  const executed = {
    name: 'Ethereum.Executed',
    args: {
      from: '0x72d405a0ec9bc7fd73b9cea9fb514601f344681f',
      to: '0x0000000000000000000000000000000000000401',
      transactionHash: '0x' + '8d'.repeat(32),
      exitReason: { __kind: 'Succeed', value: { __kind: 'Stopped' } },
      extraData: '0x',
    },
  }

  it('reads the hash and both halves of the exit reason', () => {
    expect(evmTransactionFacts([{ name: 'EVM.Log', args: {} }, executed])).toEqual({
      txHash: '0x' + '8d'.repeat(32),
      exitKind: 'Succeed',
      exitDetail: 'Stopped',
      extraData: null,
    })
  })

  it('keeps returned data on a revert — the reason no other surface carries', () => {
    const facts = evmTransactionFacts([{
      ...executed,
      args: { ...executed.args, exitReason: { __kind: 'Revert', value: { __kind: 'Reverted' } }, extraData: '0x303b682f' },
    }])
    expect(facts).toEqual({ txHash: '0x' + '8d'.repeat(32), exitKind: 'Revert', exitDetail: 'Reverted', extraData: '0x303b682f' })
  })

  it('is absent on an extrinsic that submitted no EVM transaction', () => {
    expect(evmTransactionFacts([{ name: 'System.ExtrinsicSuccess', args: { weight: 1 } }])).toBeNull()
    expect(evmTransactionFacts([])).toBeNull()
  })
})

// One canned answer per query shape. The service takes its ClickHouse client by
// injection (initExplorerService), so the resolution ORDER and what each miss falls
// back to can be asserted exactly, without a database.
function stubClient(rows: (sql: string) => Record<string, unknown>[]): { client: ClickHouseClient; sql: string[] } {
  const sql: string[] = []
  const client = {
    query: async ({ query }: { query: string }) => {
      sql.push(query)
      return { json: async () => rows(query) }
    },
  }
  return { client: client as unknown as ClickHouseClient, sql }
}

const EXTRINSIC_ROW = {
  block_height: 13473783, extrinsic_index: 3, extrinsic_hash: '0x' + '47'.repeat(32),
  ts: '2026-08-05 15:02:33', version: 4, signer: null, success: 1, call_name: 'Ethereum.transact',
  fee: null, tip: null,
  call_args_json: JSON.stringify({ transaction: { __kind: 'EIP1559', value: { nonce: '141', gasLimit: '565795', value: '0', maxFeePerGas: '7000447' } } }),
  error_json: null, spec_version: 434,
}
const EXECUTED_EVENT_ROW = {
  event_index: 67, event_name: 'Ethereum.Executed',
  args_json: JSON.stringify({
    from: '0x72d405a0ec9bc7fd73b9cea9fb514601f344681f', to: '0x0000000000000000000000000000000000000401',
    transactionHash: '0x' + 'e0'.repeat(32),
    exitReason: { __kind: 'Succeed', value: { __kind: 'Stopped' } }, extraData: '0x',
  }),
}

describe('hash resolution', () => {
  // Each case uses a hash and a location of its own: getExtrinsic and getExtrinsicAt
  // are both cached by those, so sharing them would answer a later case from an
  // earlier one's result.
  it('resolves an Ethereum transaction hash to the extrinsic that carries it', async () => {
    const evmHash = '0x' + 'e0'.repeat(32)
    const { client, sql } = stubClient(sql0 => {
      if (sql0.includes('e.extrinsic_hash = {hash:String}')) return []
      if (sql0.includes('price_data.evm_transactions')) return [{ block_height: 13473783, extrinsic_index: 3 }]
      if (sql0.includes('e.block_height = {h:UInt32}')) return [EXTRINSIC_ROW]
      if (sql0.includes('price_data.raw_events')) return [EXECUTED_EVENT_ROW]
      return []
    })
    initExplorerService(client)

    const detail = await getExtrinsic(evmHash)
    expect(detail?.blockHeight).toBe(13473783)
    expect(detail?.index).toBe(3)
    // The same object the height-index path returns, from the same code — including
    // the substrate hash, which is NOT the hash that was asked for.
    expect(detail?.hash).toBe('0x' + '47'.repeat(32))
    expect(detail?.evmTx).toEqual({ txHash: evmHash, exitKind: 'Succeed', exitDetail: 'Stopped', extraData: null })
    // Substrate first, EVM only on its miss.
    expect(sql.findIndex(s => s.includes('e.extrinsic_hash = {hash:String}')))
      .toBeLessThan(sql.findIndex(s => s.includes('price_data.evm_transactions')))
  })

  it('still resolves a substrate extrinsic hash without touching evm_transactions', async () => {
    const { client, sql } = stubClient(sql0 => {
      if (sql0.includes('e.extrinsic_hash = {hash:String}')) return [{ ...EXTRINSIC_ROW, block_height: 13473784, extrinsic_index: 1, extrinsic_hash: '0x' + '11'.repeat(32), call_name: 'Omnipool.sell', call_args_json: '{}' }]
      if (sql0.includes('price_data.raw_events')) return []
      return []
    })
    initExplorerService(client)

    const detail = await getExtrinsic('0x' + '11'.repeat(32))
    expect(detail?.blockHeight).toBe(13473784)
    expect(detail?.evmTx).toBeUndefined()
    expect(sql.some(s => s.includes('price_data.evm_transactions'))).toBe(false)
  })

  it('answers nothing for a 64-hex value neither hash space knows', async () => {
    const { client } = stubClient(() => [])
    initExplorerService(client)
    expect(await getExtrinsic('0x' + 'ab'.repeat(32))).toBeNull()
  })

  it('rejects a value that is not a 32-byte hash without querying at all', async () => {
    const { client, sql } = stubClient(() => [EXTRINSIC_ROW])
    initExplorerService(client)
    expect(await getExtrinsic('not-a-hash')).toBeNull()
    expect(await getExtrinsic('0x' + 'ab'.repeat(20))).toBeNull()
    expect(sql).toEqual([])
  })

  // The column is Nullable to match its source. A transaction whose owning extrinsic
  // is unknown has nothing to open, so it is a miss rather than an extrinsic 0.
  it('treats a null extrinsic_index as a miss', async () => {
    const { client } = stubClient(sql0 => {
      if (sql0.includes('price_data.evm_transactions')) return [{ block_height: 13473785, extrinsic_index: null }]
      return []
    })
    initExplorerService(client)
    expect(await getExtrinsic('0x' + 'cd'.repeat(32))).toBeNull()
  })
})

// The fabricated-account regression: both hash spaces are 64-hex, and an EVM
// transaction hash used to fall through to canonicalizeAddress, which reads any 32
// bytes as an AccountId32 and offered a plausible account page that does not exist.
describe('search of an EVM transaction hash', () => {
  it('offers the extrinsic and no account', async () => {
    const hash = '0x' + 'b1'.repeat(32)
    const { client } = stubClient(sql0 => {
      if (sql0.includes('price_data.evm_transactions')) return [{ block_height: 13473783, extrinsic_index: 3 }]
      return []
    })
    initExplorerService(client)
    initGovernanceService(client)

    const results = await search(hash)
    expect(results.filter(r => r.type === 'extrinsic').map(r => r.value)).toEqual([hash])
    expect(results.some(r => r.type === 'address')).toBe(false)
  })

  // Control: the same code offers the account for a 64-hex value that resolves to no
  // hash at all, so the assertion above proves the EVM hit is what suppressed it.
  it('still offers an account for a 64-hex value no hash space claims', async () => {
    const { client } = stubClient(() => [])
    initExplorerService(client)
    initGovernanceService(client)

    const results = await search('0x' + 'b2'.repeat(32))
    expect(results.some(r => r.type === 'extrinsic')).toBe(false)
    expect(results.some(r => r.type === 'address')).toBe(true)
  })
})

describe('evmTransactionReceipt', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('converts the node hex quantities to exact decimal integers', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1, result: { gasUsed: '0x56f36', effectiveGasPrice: '0x6ad17f', logs: [] },
    }), { status: 200 }))
    // 0x56f36 = 356150, 0x6ad17f = 7000447 — a wei-scale price may never be routed
    // through a JS number, so the conversion is exact and the result stays a string.
    expect(await evmTransactionReceipt('0x' + 'a1'.repeat(32))).toEqual({ gasUsed: '356150', effectiveGasPrice: '7000447' })
  })

  // Null, never an error and never a zero: the page then omits its gas rows.
  it('answers null when the node has no receipt, errors, or omits gas', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 }))
    expect(await evmTransactionReceipt('0x' + 'a2'.repeat(32))).toBeNull()

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } }), { status: 200 }))
    expect(await evmTransactionReceipt('0x' + 'a3'.repeat(32))).toBeNull()

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { logs: [] } }), { status: 200 }))
    expect(await evmTransactionReceipt('0x' + 'a4'.repeat(32))).toBeNull()

    vi.stubGlobal('fetch', async () => { throw new Error('unreachable') })
    expect(await evmTransactionReceipt('0x' + 'a5'.repeat(32))).toBeNull()
  })

  it('keeps the effective price optional rather than inventing one', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1, result: { gasUsed: '0x56f36' },
    }), { status: 200 }))
    expect(await evmTransactionReceipt('0x' + 'a6'.repeat(32))).toEqual({ gasUsed: '356150', effectiveGasPrice: null })
  })
})
