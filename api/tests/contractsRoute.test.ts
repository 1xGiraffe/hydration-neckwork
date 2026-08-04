import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { contractsRoutes } from '../src/routes/contracts.ts'

// The contracts directory is served entirely from the in-memory registry; the
// route's job is param hygiene: clamped offset/limit, a validated sort token,
// and a stable {contracts, total} envelope. Hoisted mock rather than a
// per-test resetModules/doMock cycle: re-importing the route graph per test
// raced under load and handed a test the previous generation's module.
const { getContracts, getContractTransactions, getContractEvents } = vi.hoisted(() => ({
  getContracts: vi.fn(),
  getContractTransactions: vi.fn(),
  getContractEvents: vi.fn(),
}))
vi.mock('../src/services/explorerService.ts', () => ({ getContracts, getContractTransactions, getContractEvents }))

beforeEach(() => {
  getContracts.mockReset().mockImplementation((offset: number, limit: number, sort: string) => ({
    contracts: [{ address: '0x531a654d1696ed52e7275a8cede955e82620f99a' }],
    total: 1,
    echo: { offset, limit, sort },
  }))
  getContractTransactions.mockReset().mockResolvedValue({ transactions: [], total: 0 })
  getContractEvents.mockReset().mockResolvedValue({ events: [], total: 0 })
})

async function contractsResponse(url: string) {
  const app = Fastify()
  await app.register(contractsRoutes)
  const response = await app.inject(url)
  await app.close()
  return { response, getContracts }
}

describe('/explorer/contracts', () => {
  it('defaults to offset 0, limit 50, sort created', async () => {
    const { response, getContracts } = await contractsResponse('/explorer/contracts')
    expect(response.statusCode).toBe(200)
    expect(getContracts).toHaveBeenCalledWith(0, 50, 'created')
    expect(response.json()).toMatchObject({ total: 1 })
  })

  it('passes validated params through', async () => {
    const { getContracts } = await contractsResponse('/explorer/contracts?offset=100&limit=25&sort=txs')
    expect(getContracts).toHaveBeenCalledWith(100, 25, 'txs')
  })

  it('refuses a negative offset and falls back on an unknown sort or oversized limit', async () => {
    const { response } = await contractsResponse('/explorer/contracts?offset=-1')
    expect(response.statusCode).toBe(400)

    const { getContracts } = await contractsResponse('/explorer/contracts?limit=99999&sort=bogus')
    expect(getContracts).toHaveBeenCalledWith(0, 50, 'created')
  })
})

// The two contract-tab activity pages share the artifact routes' address
// hygiene (normalize, reject non-H160) and answer 404 for a non-contract, so
// the tab cannot be probed against arbitrary addresses.
describe('/explorer/contract/:address/(transactions|events)', () => {
  const ADDR = '0x531a654d1696ed52e7275a8cede955e82620f99a'

  it('passes validated paging through and returns the envelope', async () => {
    const { response } = await contractsResponse(`/explorer/contract/${ADDR.toUpperCase().replace('0X', '0x')}/transactions?offset=25&limit=25`)
    expect(response.statusCode).toBe(200)
    expect(getContractTransactions).toHaveBeenCalledWith(ADDR, 25, 25)
    expect(response.json()).toEqual({ transactions: [], total: 0 })

    const { response: events } = await contractsResponse(`/explorer/contract/${ADDR}/events`)
    expect(events.statusCode).toBe(200)
    expect(getContractEvents).toHaveBeenCalledWith(ADDR, 0, 25)
  })

  it('rejects a malformed address and an out-of-range offset', async () => {
    const { response } = await contractsResponse('/explorer/contract/not-an-address/transactions')
    expect(response.statusCode).toBe(400)
    expect(getContractTransactions).not.toHaveBeenCalled()

    const { response: badOffset } = await contractsResponse(`/explorer/contract/${ADDR}/events?offset=-2`)
    expect(badOffset.statusCode).toBe(400)
  })

  it('answers 404 for a non-contract address', async () => {
    getContractTransactions.mockResolvedValue(null)
    getContractEvents.mockResolvedValue(null)
    const { response } = await contractsResponse(`/explorer/contract/${ADDR}/transactions`)
    expect(response.statusCode).toBe(404)
    const { response: events } = await contractsResponse(`/explorer/contract/${ADDR}/events`)
    expect(events.statusCode).toBe(404)
  })
})
