import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

// Contract + semantics tests for the DexScreener adapter endpoints. Template:
// tests/public/poolVolumes.test.ts — a fake ClickHouse client dispatching on the
// marker comment each built query carries, so no database is required.
//
// The adapter's field names are fixed by DexScreener's DEX-adapter spec (pinned
// against the previous Hydration adapter's own interface declaration,
// galacticcouncil/hydration-data-feeds
// apps/hydration-data-lake-adapter/src/modules/consumers/dexscreener/v1/dexscreener.interfaces.ts),
// so the tests assert the exact wire keys rather than a shape of our choosing.
type Row = Record<string, unknown>

function result(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const ASSET_ROWS: Row[] = [
  { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1, symbol: 'H2O', name: 'H2O', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: 0, origin_ecosystem: 'polkadot', origin_chain_id: '0', origin_asset_id: null },
  { asset_id: 10, symbol: 'USDT', name: 'Tether', decimals: 6, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 22, symbol: 'USDC', name: 'USD Coin', decimals: 6, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 102, symbol: '2-Pool', name: 'USDT/USDC', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

const OMNIPOOL_ACCOUNT = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'
const XYK_ACCOUNT = `0x${'ab'.repeat(32)}`
const MAKER = `0x${'c5'.repeat(32)}`

// The two identifier maps that make this surface's ids the previous adapter's.
// HOLLAR's real contract, so the ERC-20 substitution is asserted against the
// address kril actually publishes for asset 222.
const HOLLAR_CONTRACT = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const STABLESWAP_ACCOUNT = `0x${'11'.repeat(32)}`
const ERC20_CONTRACT_ROWS: Row[] = [{ asset_id: 222, contract: HOLLAR_CONTRACT }]
const STABLESWAP_ACCOUNT_ROWS: Row[] = [{ pool_id: 102, pool_account: STABLESWAP_ACCOUNT }]

/** /v1/status's two probes, so latest-block reads the same head the status route does. */
const STATUS_MAIN: Row[] = [{ block_height: '13585536', block_timestamp: '2026-08-12 20:51:51' }]
const STATUS_RAW: Row[] = [{ block_height: '13585540' }]

/** Distinct Omnipool assets, for pair validation. */
const OMNIPOOL_ASSET_ROWS: Row[] = [{ asset_id: 0 }, { asset_id: 5 }, { asset_id: 102 }, { asset_id: 222 }]
/** Stableswap pool → its underlying assets, for pair validation. */
const STABLESWAP_POOL_ROWS: Row[] = [{ pool_id: 102, asset_ids: [10, 22, 222] }, { pool_id: 690, asset_ids: [15, 1001] }]
/** price_data.xyk_pool_registry, read through poolVolumes.xykPoolMeta. */
const XYK_REGISTRY_ROWS: Row[] = [{ pool_account: XYK_ACCOUNT, lp_asset_id: 1000021, asset_a: 0, asset_b: 5, created_block: 4000000 }]

interface Seen { query: string; params: Record<string, unknown> }

function fakeClient(byMarker: Record<string, Row[]> = {}) {
  const seen: Seen[] = []
  const client = {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      seen.push({ query, params: query_params ?? {} })
      if (query.includes('FROM price_data.assets FINAL')) return result(ASSET_ROWS)
      if (query.includes('Bonds.TokenCreated')) return result([])
      for (const [marker, rows] of Object.entries(byMarker)) {
        if (query.includes(marker)) return result(rows)
      }
      // Defaults keep a test that only cares about one query from having to
      // declare the other five.
      if (query.includes('FROM price_data.blocks')) return result(STATUS_MAIN)
      if (query.includes('raw_ingestion_state')) return result(STATUS_RAW)
      if (query.includes('pub:ds:omnipool-assets')) return result(OMNIPOOL_ASSET_ROWS)
      if (query.includes('pub:ds:stableswap-pools')) return result(STABLESWAP_POOL_ROWS)
      if (query.includes('pub:ds:erc20-contracts')) return result(ERC20_CONTRACT_ROWS)
      if (query.includes('pub:ds:stableswap-accounts')) return result(STABLESWAP_ACCOUNT_ROWS)
      if (query.includes('pub:vol:xyk-pools')) return result(XYK_REGISTRY_ROWS)
      if (query.includes('pub:ds:events:')) return result([])
      throw new Error(`unexpected query: ${query.slice(0, 200)}`)
    }),
  }
  return client
}

let stopAssets: () => void

beforeAll(async () => {
  const { loadExplorerAssets, stopExplorerAssetsRefresh } = await import('../../src/services/explorerAssets.ts')
  await loadExplorerAssets(fakeClient() as never)
  stopAssets = stopExplorerAssetsRefresh
})

afterAll(() => { stopAssets?.() })

async function buildApp(client: ReturnType<typeof fakeClient>): Promise<FastifyInstance> {
  const { buildPublicApp } = await import('../../src/public/app.ts')
  return buildPublicApp({ client: client as never, logger: false })
}

/**
 * The only cached reads on this surface are the indexed head, the pool universe
 * and the identifier forms, and every fixture below declares the same rows for all
 * three, so a cache entry surviving between tests cannot change an answer. The
 * event windows — whose key would be one entry per (fromBlock, toBlock) pair — are
 * deliberately not cached at all, which is what lets each test hand the same route
 * a different event set.
 */
async function withApp(client: ReturnType<typeof fakeClient>, fn: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = await buildApp(client)
  try { await fn(app) } finally { await app.close() }
}

describe('formatUnits', () => {
  it('divides a raw integer by its decimals exactly, never through a float', async () => {
    const { formatUnits } = await import('../../src/public/services/dexscreener.ts')
    expect(formatUnits('200000000000', 10)).toBe('20')
    expect(formatUnits('5031706880812806', 9)).toBe('5031706.880812806')
    expect(formatUnits('0', 18)).toBe('0')
    expect(formatUnits('1', 18)).toBe('0.000000000000000001')
    // 2^53 + 1 raw units: a double would round this to an even number.
    expect(formatUnits('9007199254740993', 0)).toBe('9007199254740993')
    // 18-decimal values routinely exceed 2^64.
    expect(formatUnits('19283615746991957413689422', 18)).toBe('19283615.746991957413689422')
  })

  it('trims only trailing fraction zeros, never significant ones', async () => {
    const { formatUnits } = await import('../../src/public/services/dexscreener.ts')
    expect(formatUnits('1000000000000', 12)).toBe('1')
    expect(formatUnits('1000000000001', 12)).toBe('1.000000000001')
    expect(formatUnits('100000000000', 12)).toBe('0.1')
  })
})

describe('priceNative', () => {
  it('is asset1 per asset0, in token units, at full integer precision', async () => {
    const { priceNative } = await import('../../src/public/services/dexscreener.ts')
    // The kril adapter's own block-8,000,000 fill: 20 DOT (10 dec) in against
    // 3.435069126996 LRNA (12 dec) out, on the (LRNA, DOT) pair.
    expect(priceNative('3435069126996', 12, '200000000000', 10)).toBe('5.82229913302798264081')
    // A 1:1 fill prints as a bare "1", not "1.00000000000000000000".
    expect(priceNative('1000000', 6, '1000000000000000000', 18)).toBe('1')
  })

  it('is 0 when the asset0 side is 0, rather than dividing by zero', async () => {
    const { priceNative } = await import('../../src/public/services/dexscreener.ts')
    expect(priceNative('0', 12, '200000000000', 10)).toBe('0')
  })
})

// Pair ids and asset ids are the PREVIOUS adapter's, byte for byte, so
// DexScreener's existing per-pair history carries over a base-URL swap. Every
// expectation below was read off a live head-to-head against
// adapters.kril.hydration.cloud/dexscreener.
describe('pair ids', () => {
  async function forms() {
    const { pairIdForms } = await import('../../src/public/services/dexscreener.ts')
    return pairIdForms(fakeClient() as never)
  }

  it('names an XYK pair by its pool account alone', async () => {
    const { pairId } = await import('../../src/public/services/dexscreener.ts')
    // An XYK pool has exactly one registered pair, so the assets carry nothing the
    // account does not — and the previous adapter's ids omit them.
    expect(pairId(await forms(), 'xyk', XYK_ACCOUNT, 0, 5)).toBe(XYK_ACCOUNT)
    expect(pairId(await forms(), 'xyk', XYK_ACCOUNT, 5, 0)).toBe(XYK_ACCOUNT)
  })

  it('names a stableswap pool by its on-chain account, not its pool id', async () => {
    const { pairId } = await import('../../src/public/services/dexscreener.ts')
    expect(pairId(await forms(), 'stableswap', '102', 102, 22)).toBe(`${STABLESWAP_ACCOUNT}-22-102`)
    // A pool whose account is not derivable keeps the pool id, so the id stays
    // well-formed and unique rather than the pair being dropped.
    expect(pairId(await forms(), 'stableswap', '690', 690, 15)).toBe('690-15-690')
  })

  it('names an ERC-20 asset by its contract address', async () => {
    const { pairId, wireAssetId } = await import('../../src/public/services/dexscreener.ts')
    const f = await forms()
    expect(wireAssetId(f, 222)).toBe(HOLLAR_CONTRACT)
    expect(wireAssetId(f, 5)).toBe('5')
    expect(pairId(f, 'omnipool', 'omnipool', 222, 1)).toBe(`${OMNIPOOL_ACCOUNT}-1-${HOLLAR_CONTRACT}`)
  })

  it('orders the sides by the id read as an integer, so registry ids precede contracts', async () => {
    const { orderPairSides, pairId } = await import('../../src/public/services/dexscreener.ts')
    const f = await forms()
    expect(orderPairSides(f, 5, 1)).toEqual([1, 5])
    // HDX is asset 0, so it sorts BEFORE the hub — the hub is not always asset0.
    expect(orderPairSides(f, 1, 0)).toEqual([0, 1])
    // 222 < 22 numerically is false, but the contract form puts HOLLAR second
    // whatever its registry id: this is what decides whether priceNative is a
    // price or its reciprocal.
    expect(orderPairSides(f, 222, 22)).toEqual([22, 222])
    expect(orderPairSides(f, 22, 222)).toEqual([22, 222])
    expect(pairId(f, 'stableswap', '102', 222, 22)).toBe(`${STABLESWAP_ACCOUNT}-22-${HOLLAR_CONTRACT}`)
  })

  it('accepts either wire form of an asset reference and rejects an unknown contract', async () => {
    const { resolveAssetRef } = await import('../../src/public/services/dexscreener.ts')
    const f = await forms()
    expect(resolveAssetRef(f, '222')).toBe(222)
    expect(resolveAssetRef(f, HOLLAR_CONTRACT)).toBe(222)
    expect(resolveAssetRef(f, HOLLAR_CONTRACT.toUpperCase().replace('0X', '0x'))).toBe(222)
    expect(resolveAssetRef(f, `0x${'ff'.repeat(20)}`)).toBeNull()
    expect(resolveAssetRef(f, 'DOT')).toBeNull()
  })

  it('accepts every id shape it emits, plus the legacy ones, and rejects malformed ids', async () => {
    const { parsePairIdShape } = await import('../../src/public/services/dexscreener.ts')
    expect(parsePairIdShape(XYK_ACCOUNT)).toEqual({ pool: XYK_ACCOUNT, assets: [] })
    expect(parsePairIdShape(`${OMNIPOOL_ACCOUNT}-1-${HOLLAR_CONTRACT}`))
      .toEqual({ pool: OMNIPOOL_ACCOUNT, assets: ['1', HOLLAR_CONTRACT] })
    // Legacy: a stableswap pool named by its decimal pool id, and either asset order.
    expect(parsePairIdShape('102-22-102')).toEqual({ pool: '102', assets: ['22', '102'] })
    expect(parsePairIdShape(`${OMNIPOOL_ACCOUNT}-5-1`)).toEqual({ pool: OMNIPOOL_ACCOUNT, assets: ['5', '1'] })
    for (const bad of ['0', '', '102-22', '102-22-102-5', '102-b-102', '0xzz-1-5', '102-22-22', `0x${'ab'.repeat(19)}`]) {
      expect(parsePairIdShape(bad), bad).toBeNull()
    }
  })
})

describe('GET /dexscreener/latest-block', () => {
  it('reports the indexed head as a block number and unix seconds', async () => {
    await withApp(fakeClient(), async app => {
      const res = await app.inject('/dexscreener/latest-block')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ block: { blockNumber: 13585536, blockTimestamp: 1786567911 } })
      expect(res.headers['cache-control']).toBe('public, max-age=3')
    })
  })
})

describe('GET /dexscreener/asset', () => {
  it('serves the registry entry under the adapter spec field names', async () => {
    await withApp(fakeClient(), async app => {
      const res = await app.inject('/dexscreener/asset?id=5')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ asset: { id: '5', name: 'Polkadot', symbol: 'DOT', metadata: { decimals: '10' } } })
      expect(res.headers['cache-control']).toBe('public, max-age=60')
    })
  })

  it('falls back to the symbol when the registry carries no separate name', async () => {
    await withApp(fakeClient(), async app => {
      const res = await app.inject('/dexscreener/asset?id=0')
      expect(res.json().asset).toEqual({ id: '0', name: 'HDX', symbol: 'HDX', metadata: { decimals: '12' } })
    })
  })

  it('404s an id the registry does not know instead of synthesising one', async () => {
    await withApp(fakeClient(), async app => {
      const res = await app.inject('/dexscreener/asset?id=999999')
      expect(res.statusCode).toBe(404)
      expect(res.json().error.code).toBe('not_found')
    })
  })

  it('400s an id that is neither a registry id nor a contract address', async () => {
    await withApp(fakeClient(), async app => {
      expect((await app.inject('/dexscreener/asset?id=DOT')).statusCode).toBe(400)
      expect((await app.inject('/dexscreener/asset')).statusCode).toBe(400)
      // 20 bytes short of an address.
      expect((await app.inject(`/dexscreener/asset?id=0x${'ab'.repeat(19)}`)).statusCode).toBe(400)
    })
  })

  it('accepts an ERC-20 asset under either wire form and always answers with the contract', async () => {
    // The previous adapter 500s on the registry id of an ERC-20 asset and only
    // answers for the contract, so accepting both is a strict superset — and the
    // canonical `id` is what /events and /pair publish.
    await withApp(fakeClient(), async app => {
      const byContract = await app.inject(`/dexscreener/asset?id=${HOLLAR_CONTRACT}`)
      expect(byContract.statusCode).toBe(200)
      expect(byContract.json().asset).toEqual({
        id: HOLLAR_CONTRACT, name: 'Hydrated Dollar', symbol: 'HOLLAR', metadata: { decimals: '18' },
      })
      expect((await app.inject('/dexscreener/asset?id=222')).json().asset.id).toBe(HOLLAR_CONTRACT)
      // A well-formed address this chain does not carry is a 404, not a 400.
      expect((await app.inject(`/dexscreener/asset?id=0x${'ff'.repeat(20)}`)).statusCode).toBe(404)
    })
  })
})

describe('GET /dexscreener/pair', () => {
  it('resolves an Omnipool pair against the hub', async () => {
    await withApp(fakeClient(), async app => {
      const res = await app.inject(`/dexscreener/pair?id=${OMNIPOOL_ACCOUNT}-1-5`)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        pair: { id: `${OMNIPOOL_ACCOUNT}-1-5`, dexKey: 'hydration', asset0Id: '1', asset1Id: '5' },
      })
      expect(res.headers['cache-control']).toBe('public, max-age=60')
    })
  })

  it('resolves a stableswap pair by its pool ACCOUNT, including one against the share token', async () => {
    await withApp(fakeClient(), async app => {
      const underlying = await app.inject(`/dexscreener/pair?id=${STABLESWAP_ACCOUNT}-10-22`)
      expect(underlying.statusCode).toBe(200)
      expect(underlying.json().pair.id).toBe(`${STABLESWAP_ACCOUNT}-10-22`)
      const share = await app.inject(`/dexscreener/pair?id=${STABLESWAP_ACCOUNT}-22-102`)
      expect(share.json().pair.asset1Id).toBe('102')
    })
  })

  it('resolves an XYK pair from its bare pool account', async () => {
    await withApp(fakeClient(), async app => {
      const res = await app.inject(`/dexscreener/pair?id=${XYK_ACCOUNT}`)
      expect(res.statusCode).toBe(200)
      // The pool's registered pair, ordered the same way the ids are.
      expect(res.json().pair).toEqual({ id: XYK_ACCOUNT, dexKey: 'hydration', asset0Id: '0', asset1Id: '5' })
    })
  })

  it('canonicalises a legacy id and an ERC-20 asset named by its registry id', async () => {
    await withApp(fakeClient(), async app => {
      // Legacy stableswap pool id in, canonical pool account out.
      expect((await app.inject('/dexscreener/pair?id=102-22-102')).json().pair.id)
        .toBe(`${STABLESWAP_ACCOUNT}-22-102`)
      // Legacy XYK form with the assets appended, and in the other order.
      expect((await app.inject(`/dexscreener/pair?id=${XYK_ACCOUNT}-5-0`)).json().pair.id).toBe(XYK_ACCOUNT)
      // The registry id of an ERC-20 asset resolves and comes back as the contract.
      const hollar = await app.inject(`/dexscreener/pair?id=${OMNIPOOL_ACCOUNT}-222-1`)
      expect(hollar.json().pair).toEqual({
        id: `${OMNIPOOL_ACCOUNT}-1-${HOLLAR_CONTRACT}`, dexKey: 'hydration',
        asset0Id: '1', asset1Id: HOLLAR_CONTRACT,
      })
    })
  })

  it('404s a well-formed id whose pool does not hold those assets', async () => {
    await withApp(fakeClient(), async app => {
      // Omnipool trades only against the hub, so an asset/asset pair is not one.
      expect((await app.inject(`/dexscreener/pair?id=${OMNIPOOL_ACCOUNT}-5-222`)).statusCode).toBe(404)
      // Asset 5 is not in stableswap pool 102.
      expect((await app.inject(`/dexscreener/pair?id=${STABLESWAP_ACCOUNT}-5-22`)).statusCode).toBe(404)
      // An unknown pool.
      expect((await app.inject(`/dexscreener/pair?id=${'0x' + '99'.repeat(32)}-0-5`)).statusCode).toBe(404)
      expect((await app.inject(`/dexscreener/pair?id=${'0x' + '99'.repeat(32)}`)).statusCode).toBe(404)
      // An XYK pool whose registered pair is 0/5, asked for 0/222.
      expect((await app.inject(`/dexscreener/pair?id=${XYK_ACCOUNT}-0-222`)).statusCode).toBe(404)
      // A contract address this chain does not carry.
      expect((await app.inject(`/dexscreener/pair?id=${OMNIPOOL_ACCOUNT}-1-0x${'ff'.repeat(20)}`)).statusCode).toBe(404)
    })
  })

  it('400s a malformed id', async () => {
    await withApp(fakeClient(), async app => {
      expect((await app.inject('/dexscreener/pair?id=0')).statusCode).toBe(400)
      expect((await app.inject('/dexscreener/pair')).statusCode).toBe(400)
    })
  })
})

// One Omnipool fill: 20 DOT (asset 5) sold into the hub for 3.435069126996 LRNA.
const OMNIPOOL_EVENT_ROWS: Row[] = [{
  pool_key: 'omnipool',
  block_height: 8000000,
  event_index: 22,
  block_ts: 1750441728,
  swapper: MAKER,
  op_key: '10556971',
  extrinsic_index: 3,
  in_asset: 5,
  in_amount: '200000000000',
  out_asset: 1,
  out_amount: '3435069126996',
  reserve_block: 7999800,
  reserve_raw: '33972437170250937',
  hub_reserve_raw: '580379520840828899',
}]

// One stableswap fill against the pool's own share token: 66.94007… of asset 102
// in, 67.679896 USDC out, on pool 102.
const STABLESWAP_EVENT_ROWS: Row[] = [{
  pool_key: '102',
  block_height: 8000000,
  event_index: 32,
  block_ts: 1750441728,
  swapper: MAKER,
  op_key: '10556971',
  extrinsic_index: 3,
  in_asset: 102,
  in_amount: '66940070515621831003',
  out_asset: 22,
  out_amount: '67679896',
  reserve_block: 7999800,
  asset_ids: [10, 22],
  reserves_raw: ['9557710535580', '9918164515512'],
  total_issuance_raw: '19264382473792383645741197',
}]

const XYK_EVENT_ROWS: Row[] = [{
  pool_key: XYK_ACCOUNT,
  block_height: 8000001,
  event_index: 4,
  block_ts: 1750441740,
  swapper: MAKER,
  op_key: '',
  extrinsic_index: null,
  in_asset: 0,
  in_amount: '1000000000000000',
  out_asset: 5,
  out_amount: '20000000000',
  reserve_block: 7999800,
  asset_a: 0,
  asset_b: 5,
  reserve_a_raw: '500000000000000000',
  reserve_b_raw: '10000000000000',
}]

describe('GET /dexscreener/events', () => {
  it('maps an Omnipool fill onto its hub pair, with the sides on the right asset', async () => {
    const client = fakeClient({ 'pub:ds:events:omnipool': OMNIPOOL_EVENT_ROWS })
    await withApp(client, async app => {
      const res = await app.inject('/dexscreener/events?fromBlock=8000000&toBlock=8000010')
      expect(res.statusCode).toBe(200)
      expect(res.headers['cache-control']).toBe('public, max-age=15')
      const { events } = res.json()
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        block: { blockNumber: 8000000, blockTimestamp: 1750441728 },
        eventType: 'swap',
        txnId: '8000000-3',
        txnIndex: 0,
        eventIndex: 22,
        maker: MAKER,
        pairId: `${OMNIPOOL_ACCOUNT}-1-5`,
        // asset0 is the hub (id 1), asset1 is DOT (id 5): DOT came IN, hub went OUT.
        asset1In: '20',
        asset0Out: '3.435069126996',
        priceNative: '5.82229913302798264081',
        // The hub side of the pair is the asset's hub_reserve; the other side is
        // its own reserve.
        reserves: { asset0: '580379.520840828899', asset1: '3397243.7170250937' },
      })
    })
  })

  it('reads the stableswap share token\'s reserve as the pool\'s total issuance', async () => {
    const client = fakeClient({ 'pub:ds:events:stableswap': STABLESWAP_EVENT_ROWS })
    await withApp(client, async app => {
      const { events } = (await app.inject('/dexscreener/events?fromBlock=8000000&toBlock=8000010')).json()
      expect(events[0].pairId).toBe(`${STABLESWAP_ACCOUNT}-22-102`)
      expect(events[0].asset1In).toBe('66.940070515621831003')
      expect(events[0].asset0Out).toBe('67.679896')
      expect(events[0].reserves).toEqual({
        // asset0 = USDC (22), from the pool's reserve array.
        asset0: '9918164.515512',
        // asset1 = the share token (102): a pool does not hold its own shares, so
        // its reserve is the share total issuance.
        asset1: '19264382.473792383645741197',
      })
    })
  })

  it('reads XYK reserves in the pool registry\'s own a/b order', async () => {
    const client = fakeClient({ 'pub:ds:events:xyk': XYK_EVENT_ROWS })
    await withApp(client, async app => {
      const { events } = (await app.inject('/dexscreener/events?fromBlock=8000000&toBlock=8000010')).json()
      expect(events[0].pairId).toBe(XYK_ACCOUNT)
      expect(events[0].reserves).toEqual({ asset0: '500000', asset1: '1000' })
      // No extrinsic and no router operation: the event is its own transaction.
      expect(events[0].txnId).toBe('8000001-e4')
    })
  })

  it('names the router operation as the transaction when a hook dispatched the fill', async () => {
    const hook = [{ ...OMNIPOOL_EVENT_ROWS[0], extrinsic_index: null, op_key: '10556971' }]
    const client = fakeClient({ 'pub:ds:events:omnipool': hook })
    await withApp(client, async app => {
      const { events } = (await app.inject('/dexscreener/events?fromBlock=8000000&toBlock=8000010')).json()
      expect(events[0].txnId).toBe('8000000-r10556971')
    })
  })

  it('omits reserves rather than publishing a stale sample', async () => {
    // A delisted Omnipool asset keeps its final state row forever, so the
    // nearest-at-or-before sample can be months old; past the staleness bound the
    // field is absent, never a year-old number presented as the fill's reserves.
    const stale = [{ ...OMNIPOOL_EVENT_ROWS[0], reserve_block: 7000000 }]
    const missing = [{ ...OMNIPOOL_EVENT_ROWS[0], reserve_block: 0, reserve_raw: '', hub_reserve_raw: '' }]
    for (const rows of [stale, missing]) {
      const client = fakeClient({ 'pub:ds:events:omnipool': rows })
      await withApp(client, async app => {
        const { events } = (await app.inject('/dexscreener/events?fromBlock=8000000&toBlock=8000010')).json()
        expect(events[0].reserves).toBeUndefined()
        expect(events[0].priceNative).toBe('5.82229913302798264081')
      })
    }
  })

  it('orders every venue into one stream by block then event index', async () => {
    const client = fakeClient({
      'pub:ds:events:omnipool': OMNIPOOL_EVENT_ROWS,
      'pub:ds:events:stableswap': STABLESWAP_EVENT_ROWS,
      'pub:ds:events:xyk': XYK_EVENT_ROWS,
    })
    await withApp(client, async app => {
      const { events } = (await app.inject('/dexscreener/events?fromBlock=8000000&toBlock=8000010')).json()
      expect(events.map((e: { block: { blockNumber: number }; eventIndex: number }) => [e.block.blockNumber, e.eventIndex]))
        .toEqual([[8000000, 22], [8000000, 32], [8000001, 4]])
      // txnIndex is fixed: 68% of Hydration fills come from block hooks with no
      // extrinsic at all, and hook events sort AFTER the block's extrinsics, so
      // no per-block transaction index orders the whole stream. eventIndex does.
      expect(events.every((e: { txnIndex: number }) => e.txnIndex === 0)).toBe(true)
    })
  })

  it('caps the block range and rejects an inverted one', async () => {
    await withApp(fakeClient(), async app => {
      expect((await app.inject('/dexscreener/events?fromBlock=1&toBlock=10000')).statusCode).toBe(200)
      const tooWide = await app.inject('/dexscreener/events?fromBlock=1&toBlock=10001')
      expect(tooWide.statusCode).toBe(400)
      expect(tooWide.json().error.message).toMatch(/10000 blocks/)
      expect((await app.inject('/dexscreener/events?fromBlock=100&toBlock=99')).statusCode).toBe(400)
      expect((await app.inject('/dexscreener/events?fromBlock=100')).statusCode).toBe(400)
    })
  })

  it('rejects a range too dense to serve instead of silently truncating it', async () => {
    const { MAX_EVENTS } = await import('../../src/public/services/dexscreener.ts')
    const flood: Row[] = Array.from({ length: MAX_EVENTS + 1 }, (_, i) => ({
      ...OMNIPOOL_EVENT_ROWS[0], block_height: 8000000 + i, event_index: 1,
    }))
    const client = fakeClient({ 'pub:ds:events:omnipool': flood })
    await withApp(client, async app => {
      const res = await app.inject('/dexscreener/events?fromBlock=8000000&toBlock=8009999')
      expect(res.statusCode).toBe(400)
      expect(res.json().error.message).toMatch(/narrower/)
    })
  })
})

describe('the events queries', () => {
  async function queriesFor(url: string): Promise<Seen[]> {
    const client = fakeClient()
    await withApp(client, async app => { await app.inject(url) })
    return client.seen.filter(s => s.query.includes('pub:ds:events:'))
  }

  it('collapses the swap-leg replacement key before folding a fill', async () => {
    for (const { query } of await queriesFor('/dexscreener/events?fromBlock=1&toBlock=10')) {
      // pool_swap_legs is ReplacingMergeTree(ingested_at): re-indexing a range
      // inserts a second copy of every leg. Grouping on the table's own ORDER BY
      // (minus the venue the WHERE fixes) is what keeps a replayed block from
      // reporting each of its fills twice.
      expect(query).toMatch(/GROUP BY pool_key, block_height, event_index, leg_kind, leg_index/)
      expect(query).toMatch(/argMax\(asset_id, ingested_at\)/)
      expect(query).toMatch(/argMax\(amount, ingested_at\)/)
    }
  })

  it('binds the block range as parameters and bounds the reserve scan with it', async () => {
    const queries = await queriesFor('/dexscreener/events?fromBlock=9000000&toBlock=9000100')
    expect(queries).toHaveLength(3)
    for (const { query, params } of queries) {
      expect(params.fromBlock).toBe(9000000)
      expect(params.toBlock).toBe(9000100)
      // The reserve history is only read from one staleness window below the
      // request, so a delisted asset's ancient final row is never scanned, and
      // the join stays a bounded read rather than a whole-table ASOF.
      expect(params.reserveFrom).toBe(9000000 - 1200)
      expect(query).toMatch(/ASOF LEFT JOIN/)
      expect(query).toMatch(/block_height >= \{reserveFrom:UInt32\}/)
    }
  })

  it('drops a fill whose side is not a single asset rather than guessing one', async () => {
    for (const { query } of await queriesFor('/dexscreener/events?fromBlock=1&toBlock=10')) {
      expect(query).toMatch(/uniqExactIf\(asset_id, leg_kind = 'in'\) = 1/)
      expect(query).toMatch(/uniqExactIf\(asset_id, leg_kind = 'out'\) = 1/)
    }
  })

  it('reads only the three AMM venues, never the money-market or OTC facades', async () => {
    const venues = (await queriesFor('/dexscreener/events?fromBlock=1&toBlock=10'))
      .map(({ query }) => /venue = '(\w+)'/.exec(query)?.[1])
    expect(venues.sort()).toEqual(['omnipool', 'stableswap', 'xyk'])
  })
})

// Asset 1000021 is registered in the XYK pool registry but absent from
// price_data.assets — the shape a permissionless AssetHub external takes before
// its metadata is indexed.
const UNREGISTERED_ASSET = 1000021

describe('assets the registry cannot resolve', () => {
  const unresolvable: Row[] = [{ ...XYK_EVENT_ROWS[0], in_asset: 0, out_asset: UNREGISTERED_ASSET, asset_b: UNREGISTERED_ASSET }]

  it('skips the fill rather than pricing it on an assumed scale', async () => {
    const client = fakeClient({ 'pub:ds:events:xyk': unresolvable, 'pub:ds:events:omnipool': OMNIPOOL_EVENT_ROWS })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await withApp(client, async app => {
        const { events } = (await app.inject('/dexscreener/events?fromBlock=8000000&toBlock=8000010')).json()
        // The resolvable Omnipool fill still comes through; only the unpriceable one is dropped.
        expect(events).toHaveLength(1)
        expect(events[0].pairId).toBe(`${OMNIPOOL_ACCOUNT}-1-5`)
      })
      expect(warn.mock.calls.flat().join(' ')).toContain(String(UNREGISTERED_ASSET))
    } finally { warn.mockRestore() }
  })

  it('never emits a pair whose asset would 404 on /asset', async () => {
    const client = fakeClient({ 'pub:ds:events:xyk': unresolvable })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await withApp(client, async app => {
        const { events } = (await app.inject('/dexscreener/events?fromBlock=8000000&toBlock=8000010')).json()
        expect(events).toEqual([])
        expect((await app.inject(`/dexscreener/asset?id=${UNREGISTERED_ASSET}`)).statusCode).toBe(404)
        // The XYK registry fixture pairs this asset with asset 0, so the pool
        // genuinely holds it — the 404 has to come from the registry check.
        expect((await app.inject(`/dexscreener/pair?id=${XYK_ACCOUNT}-0-${UNREGISTERED_ASSET}`)).statusCode).toBe(404)
      })
    } finally { warn.mockRestore() }
  })
})

describe('reserves that would read zero', () => {
  it('omits both sides rather than reporting an HDX-quoted XYK pool as empty', async () => {
    // xyk_pool_reserve_history reads 0 for native HDX (it lives in System.Account,
    // not Tokens), so every HDX-quoted pool's HDX side is 0 while the pool trades.
    const hdxSide: Row[] = [{ ...XYK_EVENT_ROWS[0], reserve_a_raw: '0' }]
    const client = fakeClient({ 'pub:ds:events:xyk': hdxSide })
    await withApp(client, async app => {
      const { events } = (await app.inject('/dexscreener/events?fromBlock=8000000&toBlock=8000010')).json()
      expect(events).toHaveLength(1)
      expect(events[0].reserves).toBeUndefined()
      // The trade itself is still published in full.
      expect(events[0].priceNative).toBe('0.002')
    })
  })

  it('applies the same rule to the other venues', async () => {
    const client = fakeClient({ 'pub:ds:events:omnipool': [{ ...OMNIPOOL_EVENT_ROWS[0], hub_reserve_raw: '0' }] })
    await withApp(client, async app => {
      const { events } = (await app.inject('/dexscreener/events?fromBlock=8000000&toBlock=8000010')).json()
      expect(events[0].reserves).toBeUndefined()
    })
  })
})

describe('block-number bounds', () => {
  it('rejects a height past UInt32 instead of letting ClickHouse wrap it', async () => {
    // A UInt32 query parameter wraps MOD 2^32 in silence: 4294967300 binds as
    // block 4, which would answer 200 for an entirely different window.
    await withApp(fakeClient(), async app => {
      const res = await app.inject('/dexscreener/events?fromBlock=4294967300&toBlock=4294967300')
      expect(res.statusCode).toBe(400)
      expect((await app.inject('/dexscreener/events?fromBlock=1&toBlock=4294967296')).statusCode).toBe(400)
      // The largest legal height is still accepted.
      expect((await app.inject('/dexscreener/events?fromBlock=4294967295&toBlock=4294967295')).statusCode).toBe(200)
    })
  })

  it('rejects a blank or non-numeric height instead of reading it as genesis', async () => {
    await withApp(fakeClient(), async app => {
      expect((await app.inject('/dexscreener/events?fromBlock=&toBlock=10')).statusCode).toBe(400)
      expect((await app.inject('/dexscreener/events?fromBlock=abc&toBlock=10')).statusCode).toBe(400)
      expect((await app.inject('/dexscreener/events?fromBlock=-1&toBlock=10')).statusCode).toBe(400)
      expect((await app.inject('/dexscreener/events?fromBlock=1.5&toBlock=10')).statusCode).toBe(400)
    })
  })
})

describe('the identifier queries', () => {
  // Asserted as SQL text rather than through a request, the way the ticker SQL is
  // in coingecko.test.ts: both reads sit behind one long-lived cache entry, so a
  // request-driven test would only see them on the first call in the whole file.
  it('reads a local ERC-20 contract, never a foreign chain\'s', async () => {
    const { ERC20_CONTRACTS_SQL } = await import('../../src/public/services/dexscreener.ts')
    // An AccountKey20 junction under parents > 0 names a contract on ANOTHER
    // chain (asset 43 a Moonbeam one, asset 46 an Ethereum one). Publishing one of
    // those as this chain's asset id would name the wrong token entirely.
    expect(ERC20_CONTRACTS_SQL).toMatch(/l\.parents = 0/)
    expect(ERC20_CONTRACTS_SQL).toMatch(/l\.interior_kind = 'X1'/)
    expect(ERC20_CONTRACTS_SQL).toMatch(/l\.junction_kind = 'AccountKey20'/)
    expect(ERC20_CONTRACTS_SQL).toMatch(/t\.asset_type = 'Erc20'/)
    // The X1 payload is an object in older XCM versions and a one-element array in
    // newer ones. Reading only one form silently loses 10 of the 26 ERC-20 assets,
    // four of which trade daily (BIL, aSOL, aEURC, GSOL).
    expect(ERC20_CONTRACTS_SQL).toContain("'interior', 'value', 1, 'key'")
    expect(ERC20_CONTRACTS_SQL).toContain("'interior', 'value', 'key'")
    // The junction KIND is read out of the same two shapes, and it is what the
    // AccountKey20 condition tests — pinning only the key paths would let the kind
    // check silently start reading '' for every newer event and reject them all.
    expect(ERC20_CONTRACTS_SQL).toContain("'interior', 'value', 1, '__kind'")
    expect(ERC20_CONTRACTS_SQL).toContain("'interior', 'value', '__kind'")
  })

  it('keeps every Erc20 asset as a row so a missing contract is visible, not absent', async () => {
    const { ERC20_CONTRACTS_SQL } = await import('../../src/public/services/dexscreener.ts')
    // An asset dropped by the join re-keys its pairs to the registry id, which an
    // aggregator reads as a NEW pair rather than as an error. A LEFT JOIN with an
    // empty contract is what lets pairIdForms name it instead.
    expect(ERC20_CONTRACTS_SQL).toMatch(/LEFT JOIN locations l ON l\.asset_id = t\.asset_id/)
    expect(ERC20_CONTRACTS_SQL).not.toMatch(/INNER JOIN/)
  })

  it('reads the stableswap pool accounts at bounded block heights', async () => {
    const { STABLESWAP_ACCOUNTS_SQL } = await import('../../src/public/services/dexscreener.ts')
    // raw_events is ORDER BY (block_height, event_index) over 308M rows: the pool
    // account is only affordable per request because the read is a point lookup at
    // the ~17 heights pool_swap_legs names, never a scan for the event name.
    expect(STABLESWAP_ACCOUNTS_SQL).toMatch(/WHERE venue = 'stableswap'/)
    expect(STABLESWAP_ACCOUNTS_SQL).toContain('block_height IN (SELECT at_block FROM pools)')
    expect(STABLESWAP_ACCOUNTS_SQL).toContain("'fillerType', '__kind') = 'Stableswap'")
  })
})

// Both identifier maps fail SILENTLY in the response: an entity whose canonical form
// cannot be derived falls back to its numeric id, and a pair id that changes shape
// restarts an aggregator's price history instead of failing a request. These are the
// tripwires; they are quiet while everything resolves.
describe('the identifier tripwires', () => {
  // A fresh cache per case: the forms live behind one 300s entry, so a stored map
  // from an earlier case would answer instead of the fixture under test.
  async function forms(rows: Record<string, Row[]>, atMs: number) {
    const { pairIdForms } = await import('../../src/public/services/dexscreener.ts')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(atMs)
    try { return await pairIdForms(fakeClient(rows) as never) } finally { clock.mockRestore() }
  }

  it('names an Erc20 asset whose contract could not be read, and still serves the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const f = await forms({
        'pub:ds:erc20-contracts': [...ERC20_CONTRACT_ROWS, { asset_id: 420, contract: '' }],
      }, Date.now() + 3_600_000)
      // The resolvable asset is unaffected; only the unreadable one falls back.
      expect(f.contractByAssetId.get(222)).toBe(HOLLAR_CONTRACT)
      expect(f.contractByAssetId.has(420)).toBe(false)
      const message = warn.mock.calls.flat().join(' ')
      expect(message).toContain('420')
      expect(message).toContain('1 of 2 ERC-20 asset(s)')
    } finally { warn.mockRestore() }
  })

  it('throttles the warning rather than logging it once per cache refresh', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const rows = { 'pub:ds:erc20-contracts': [...ERC20_CONTRACT_ROWS, { asset_id: 420, contract: '' }] }
      // Two loads inside the throttle window: a cursor-driven consumer re-walks the
      // same windows forever, so an unthrottled warn is one line every TTL for good.
      await forms(rows, Date.now() + 7_200_000)
      await forms(rows, Date.now() + 7_300_000)
      expect(warn.mock.calls.filter(call => String(call[0]).includes('420'))).toHaveLength(1)
    } finally { warn.mockRestore() }
  })

  it('throws rather than caching an empty map when entities exist but none resolve', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // cached() stores nothing for a rejected loader, so the next request retries.
      // A cached empty map would re-key every ERC-20 pair for a full TTL.
      await expect(forms({
        'pub:ds:erc20-contracts': [{ asset_id: 222, contract: '' }],
      }, Date.now() + 10_800_000)).rejects.toThrow(/none resolved to a canonical form/)
      await expect(forms({
        'pub:ds:stableswap-accounts': [{ pool_id: 102, pool_account: '' }],
      }, Date.now() + 14_400_000)).rejects.toThrow(/stableswap pool\(s\)/)
    } finally { warn.mockRestore() }
  })

  it('caches an empty map when the SOURCE is empty, which is a correct answer', async () => {
    // A database with no ERC-20 asset and no stableswap pool has empty maps; that is
    // not the same failure and must not throw.
    const f = await forms({ 'pub:ds:erc20-contracts': [], 'pub:ds:stableswap-accounts': [] }, Date.now() + 18_000_000)
    expect(f.contractByAssetId.size).toBe(0)
    expect(f.accountByPoolId.size).toBe(0)
  })
})

describe('the adapter OpenAPI surface', () => {
  it('documents every /dexscreener route with a 200 schema', async () => {
    // openapi.test.ts's own coverage assertion filters to /v1 and /rest, so this
    // namespace would otherwise be able to ship undocumented. The guard lives
    // here rather than there because that file is shared with another in-flight
    // route group.
    await withApp(fakeClient(), async app => {
      const doc = (await app.inject('/openapi.json')).json()
      const paths = Object.keys(doc.paths ?? {}).filter(p => p.startsWith('/dexscreener/'))
      expect(paths.sort()).toEqual([
        '/dexscreener/asset', '/dexscreener/events', '/dexscreener/latest-block', '/dexscreener/pair',
      ])
      for (const path of paths) {
        expect(doc.paths[path].get?.responses?.['200'], path).toBeTruthy()
      }
    })
  })
})

describe('the adapter cache rules', () => {
  it('scopes each rule to the route it belongs to', async () => {
    const { PUBLIC_CACHE_CONTROL } = await import('../../src/public/cacheControl.ts')
    const ttl = (path: string) => PUBLIC_CACHE_CONTROL.find(([p]) => p.test(path))?.[1] ?? null
    expect(ttl('/dexscreener/latest-block')).toBe(3)
    expect(ttl('/dexscreener/asset')).toBe(60)
    expect(ttl('/dexscreener/pair')).toBe(60)
    expect(ttl('/dexscreener/events')).toBe(15)
    // A future sibling must declare its own freshness, not inherit one of these.
    expect(ttl('/dexscreener/pairs')).toBeNull()
    expect(ttl('/dexscreener/latest-block/extra')).toBeNull()
  })
})

// The 600-block pool-history grid is declared in THREE places that must agree:
// the MVs that materialize it, the indexer cadence guard that keeps every grid
// height populated, and this adapter's staleness bound that is expressed as a
// multiple of it. They are three different languages in three workspaces, so
// nothing but a test couples them — and a silent disagreement is invisible until
// a chart has holes or the adapter publishes reserves it should have dropped.
//
// This matters more, not less, at 2 s blocks: the grid is block-counted, so the
// relationship survives the cadence change only while all three sides stay
// block-counted and equal.
describe('the 600-block pool-history grid', () => {
  const repoFile = (path: string) =>
    readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8')

  it('is the same number in the MVs, the indexer cadence guard, and this adapter', async () => {
    const { RESERVE_GRID_BLOCKS } = await import('../../src/public/services/dexscreener.ts')

    // The MVs, read as text for the same reason schemaPublic.test.ts does: the
    // schema file is the declaration, not something importable.
    // ClickHouse's own SHOW CREATE parenthesises the modulo, so the schema file
    // (which is regenerated from it) spells this `(block_height % 600) = 0`.
    const mvGrids = [...repoFile('clickhouse/schema/003_materialized_views.sql')
      .matchAll(/block_height % (\d+)\)? = 0/g)].map(m => Number(m[1]))
    // Three pool-history MVs sample the grid; a fourth appearing without this
    // test being updated is exactly the drift being guarded against.
    expect(mvGrids).toHaveLength(3)
    for (const grid of mvGrids) expect(grid).toBe(RESERVE_GRID_BLOCKS)

    // The raw indexer's snapshot cadence must divide the same grid, or a grid
    // height gets no snapshot row and its sample is permanently missing.
    const cadence = repoFile('src/raw/snapshotCadence.ts')
    const declared = /export const MV_SNAPSHOT_GRID_BLOCKS = (\d+)/.exec(cadence)
    expect(declared, 'MV_SNAPSHOT_GRID_BLOCKS is not declared in src/raw/snapshotCadence.ts').toBeTruthy()
    expect(Number(declared![1])).toBe(RESERVE_GRID_BLOCKS)
  })

  it('bounds staleness at a whole number of grid steps, counted in blocks', async () => {
    const m = await import('../../src/public/services/dexscreener.ts')
    // Deliberately NOT wall clock. The grid it bounds is block-counted, so "two
    // grid steps" is 1,200 blocks at any cadence; 2 h would be two steps at 6 s
    // but six at 2 s, and the field would start publishing six-sample-old
    // reserves. Expressed as the product so the two cannot drift apart.
    expect(m.RESERVE_MAX_STALE_BLOCKS).toBe(m.RESERVE_MAX_STALE_GRID_STEPS * m.RESERVE_GRID_BLOCKS)
    expect(m.RESERVE_MAX_STALE_GRID_STEPS).toBe(2)
  })
})
