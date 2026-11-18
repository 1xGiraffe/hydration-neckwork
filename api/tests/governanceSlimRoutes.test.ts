import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

// The two slim reads exist so a page can show one fact without downloading the
// payload it lives in: the conviction table without every track's curves, and the
// Technical Committee without the whole security dashboard. Pinned: each answers
// from the same source as the full read, and carries only its own fields.
const { getGovernanceTracks, getTechCommittee } = vi.hoisted(() => ({ getGovernanceTracks: vi.fn(), getTechCommittee: vi.fn() }))
vi.mock('../src/services/governanceRead.ts', async (orig) => ({ ...(await orig() as object), getGovernanceTracks }))
vi.mock('../src/services/securityService.ts', async (orig) => ({ ...(await orig() as object), getTechCommittee }))

const { governanceRoutes } = await import('../src/routes/governance.ts')
const { explorerRoutes } = await import('../src/routes/explorer.ts')

describe('slim governance reads', () => {
  it('GET /explorer/governance/convictions carries the conviction table only', async () => {
    const convictions = [{ conviction: 0, name: 'None', multiplierTenths: 1, lockPeriods: 0, lockBlocks: 0, lockDays: 0 }, { conviction: 1, name: 'Locked1x', multiplierTenths: 10, lockPeriods: 1, lockBlocks: 100800, lockDays: 7 }]
    getGovernanceTracks.mockResolvedValue({ voteLockingPeriod: 100800, msPerBlock: 6000, undecidingTimeout: 1, maxVotesPerClass: 25, convictions, tracks: [{ id: 0, curve: [1, 2, 3] }] })
    const app = Fastify()
    await app.register(governanceRoutes)
    const res = await app.inject('/explorer/governance/convictions')
    await app.close()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ voteLockingPeriod: 100800, msPerBlock: 6000, convictions })
  })

  it('GET /explorer/security/committee hands the committee view back as-is', async () => {
    const view = { techCommittee: { members: [{ accountId: '0x01', address: '7K' }], size: 1, majority: 1, superMajority: 1 }, memberSetAtBlock: 42 }
    getTechCommittee.mockResolvedValue(view)
    const app = Fastify()
    await app.register(explorerRoutes)
    const res = await app.inject('/explorer/security/committee')
    await app.close()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(view)
    expect(getTechCommittee).toHaveBeenCalledTimes(1)
  })
})
