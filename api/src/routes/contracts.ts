import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getContracts } from '../services/explorerService.ts'
import { CONTRACT_SORTS, type ContractSort } from '../services/contractRegistryService.ts'
import {
  getContractAbiPayload,
  getContractSourcesPayload,
  isH160,
  normalizeAddressParam,
} from '../services/contractVerificationService.ts'
import { listCompilerVersions } from '../services/verifierClient.ts'
import { cached } from '../services/cache.ts'

// Explorer-facing contract endpoints. The directory is served entirely from
// the in-memory contract registry — no ClickHouse on the request path; the
// verified-artifact payloads are lazy primary-key reads behind a long cache
// (extrinsic-bytes pattern). The Sourcify-compatible verification API lives
// separately in verification.ts.
const offsetSchema = z.coerce.number().int().min(0).max(20_000_000).optional()
const limitSchema = z.coerce.number().int().min(1).max(250).optional()

export async function contractsRoutes(fastify: FastifyInstance) {
  fastify.get('/explorer/contracts', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    const offset = offsetSchema.safeParse(q.offset)
    if (!offset.success) return reply.status(400).send({ error: 'Invalid offset' })
    const limit = limitSchema.safeParse(q.limit)
    const sort = (CONTRACT_SORTS as string[]).includes(String(q.sort)) ? String(q.sort) as ContractSort : 'created'
    return getContracts(offset.data ?? 0, limit.success ? limit.data ?? 50 : 50, sort)
  })

  // Static segment, so find-my-way matches it ahead of the :address routes.
  // Feeds the verify form's version picker; the verifier's list only changes
  // when solc releases, so an hour of cache is conservative.
  fastify.get('/explorer/contract/compiler-versions', async () => {
    return { versions: await cached('contract:compiler-versions', 3_600_000, listCompilerVersions) }
  })

  fastify.get('/explorer/contract/:address/abi', async (req, reply) => {
    const address = normalizeAddressParam(String((req.params as { address: string }).address ?? ''))
    if (!isH160(address)) return reply.status(400).send({ error: 'Invalid contract address' })
    const payload = await getContractAbiPayload(address)
    if (!payload) return reply.status(404).send({ error: 'Contract is not verified' })
    return payload
  })

  fastify.get('/explorer/contract/:address/sources', async (req, reply) => {
    const address = normalizeAddressParam(String((req.params as { address: string }).address ?? ''))
    if (!isH160(address)) return reply.status(400).send({ error: 'Invalid contract address' })
    const payload = await getContractSourcesPayload(address)
    if (!payload) return reply.status(404).send({ error: 'Contract is not verified' })
    return payload
  })
}
