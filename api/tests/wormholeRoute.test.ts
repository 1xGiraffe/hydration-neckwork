import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

// The route is a pass-through onto the cached snapshot composer, so the thing
// worth pinning is that it exists under the security path, takes no parameters,
// and hands the composer's envelope back untouched. Hoisted mock rather than a
// per-test resetModules cycle, matching contractsRoute.test.ts.
const { getWormholeBridgeDetail } = vi.hoisted(() => ({ getWormholeBridgeDetail: vi.fn() }))
vi.mock('../src/services/wormholeNttService.ts', () => ({
  getWormholeBridgeDetail,
  getWormholeSummary: vi.fn(async () => null),
  initWormholeNttService: vi.fn(),
  refreshWormholeBacking: vi.fn(async () => {}),
  wormholeSnapshotGeneration: 0,
}))

const { explorerRoutes } = await import('../src/routes/explorer.ts')

const emptyDetail = {
  assets: [],
  inflight: [],
  queued: [],
  recent: [],
  totals: { lockedUsd: null, issuanceUsd: null, inflightUsd: null, deficitUsd: null, surplusUsd: null },
  chains: [],
  scan: { configured: true, ok: false, asOf: null },
  hydrationChainId: 73,
  asOf: null,
  indexedThrough: null,
}

async function wormholeResponse(detail: unknown) {
  getWormholeBridgeDetail.mockReset().mockResolvedValue(detail)
  const app = Fastify()
  await app.register(explorerRoutes)
  const response = await app.inject('/explorer/security/wormhole')
  await app.close()
  return response
}

describe('GET /explorer/security/wormhole', () => {
  it('serves the composer envelope as-is', async () => {
    const response = await wormholeResponse({
      ...emptyDetail,
      assets: [{ assetId: '21', symbol: 'USDC', status: 'ok', locked: '227031998904', issuance: '227031998904', residual: '0' }],
      asOf: '2026-08-22T09:00:00.000Z',
      indexedThrough: { block: 13_728_047, at: '2026-08-22 08:59:00' },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.hydrationChainId).toBe(73)
    expect(body.assets[0]).toMatchObject({ assetId: '21', status: 'ok', residual: '0' })
    expect(body.indexedThrough.block).toBe(13_728_047)
    expect(getWormholeBridgeDetail).toHaveBeenCalledTimes(1)
  })

  it('carries the queued releases through untouched', async () => {
    const response = await wormholeResponse({
      ...emptyDetail,
      queued: [{
        digest: '0x319c998f9e8ab534fb886dbfc4db6fccf0d10101cdb687f1a6657f79cb83d41c',
        assetId: '1000745',
        symbol: 'sUSDS',
        amount: '79998966424310000000000',
        amountUsd: 87198.87,
        chainId: 2,
        recipient: '0xe84121cad17d2da9e0220aa8453f85396e73aa3e',
        queuedAt: '2026-08-20T12:20:35.000Z',
        releasableAt: '2026-08-21T12:20:35.000Z',
        releasable: true,
      }],
    })
    expect(response.json().queued[0]).toMatchObject({
      digest: '0x319c998f9e8ab534fb886dbfc4db6fccf0d10101cdb687f1a6657f79cb83d41c',
      amount: '79998966424310000000000',
      releasable: true,
    })
  })

  it('answers before any snapshot has run, with nulls rather than zeroes', async () => {
    const response = await wormholeResponse(emptyDetail)
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.asOf).toBeNull()
    expect(body.totals.lockedUsd).toBeNull()
    expect(body.totals.issuanceUsd).toBeNull()
    expect(body.assets).toEqual([])
  })
})
