import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { contractsRoutes } from '../src/routes/contracts.ts'

// Lazy heavy payloads (extrinsic-bytes pattern): the route's job is address
// hygiene, a stable payload passthrough, and a 404 for unverified contracts.
const { getContractAbiPayload, getContractSourcesPayload } = vi.hoisted(() => ({
  getContractAbiPayload: vi.fn(),
  getContractSourcesPayload: vi.fn(),
}))

vi.mock('../src/services/explorerService.ts', () => ({ getContracts: vi.fn(() => ({ contracts: [], total: 0 })) }))
vi.mock('../src/services/contractVerificationService.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/contractVerificationService.ts')>()
  return { ...actual, getContractAbiPayload, getContractSourcesPayload }
})
vi.mock('../src/services/verifierClient.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/verifierClient.ts')>()
  return { ...actual, listCompilerVersions: vi.fn(async () => ['v0.8.19+commit.7dd6d404']) }
})

const ADDRESS = '0x531a654d1696ed52e7275a8cede955e82620f99a'

async function buildApp() {
  const app = Fastify()
  await app.register(contractsRoutes)
  return app
}

beforeEach(() => {
  getContractAbiPayload.mockReset().mockResolvedValue(null)
  getContractSourcesPayload.mockReset().mockResolvedValue(null)
})

describe('/explorer/contract/:address/abi', () => {
  it('serves the ABI payload for a verified contract', async () => {
    const payload = { address: ADDRESS, abi: [{ type: 'function', name: 'totalSupply' }], source: 'verified', contractName: 'GhoToken' }
    getContractAbiPayload.mockResolvedValue(payload)
    const app = await buildApp()
    const res = await app.inject(`/explorer/contract/${ADDRESS}/abi`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(payload)
    expect(getContractAbiPayload).toHaveBeenCalledWith(ADDRESS)
    await app.close()
  })

  it('404s for an unverified contract and 400s for a malformed address', async () => {
    const app = await buildApp()
    const missing = await app.inject(`/explorer/contract/${ADDRESS}/abi`)
    expect(missing.statusCode).toBe(404)
    const bad = await app.inject('/explorer/contract/not-hex/abi')
    expect(bad.statusCode).toBe(400)
    expect(getContractAbiPayload).toHaveBeenCalledTimes(1)
    await app.close()
  })
})

describe('/explorer/contract/:address/sources', () => {
  it('serves the source files with the compiler card', async () => {
    const payload = {
      address: ADDRESS,
      files: [{ path: 'src/GhoToken.sol', content: 'contract GhoToken {}' }],
      compiler: { version: 'v0.8.10', evmVersion: 'london', optimizerEnabled: true, optimizerRuns: 200, constructorArguments: '0x', settings: null },
    }
    getContractSourcesPayload.mockResolvedValue(payload)
    const app = await buildApp()
    const res = await app.inject(`/explorer/contract/${ADDRESS}/sources`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(payload)
    await app.close()
  })

  it('404s when no sources are stored', async () => {
    const app = await buildApp()
    const res = await app.inject(`/explorer/contract/${ADDRESS}/sources`)
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('accepts an uppercase address by normalizing it', async () => {
    getContractSourcesPayload.mockResolvedValue({ address: ADDRESS, files: [], compiler: {} })
    const app = await buildApp()
    const res = await app.inject(`/explorer/contract/${ADDRESS.toUpperCase().replace('0X', '0x')}/sources`)
    expect(res.statusCode).toBe(200)
    expect(getContractSourcesPayload).toHaveBeenCalledWith(ADDRESS)
    await app.close()
  })
})

describe('/explorer/contract/compiler-versions', () => {
  it('serves the version list without colliding with the :address routes', async () => {
    const app = await buildApp()
    const res = await app.inject('/explorer/contract/compiler-versions')
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json().versions)).toBe(true)
    expect(getContractAbiPayload).not.toHaveBeenCalled()
    await app.close()
  })
})
