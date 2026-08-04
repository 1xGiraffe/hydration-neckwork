import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getContracts } from '../services/explorerService.ts'
import { CONTRACT_SORTS, type ContractSort } from '../services/contractRegistryService.ts'

// Explorer-facing contract endpoints. The directory is served entirely from
// the in-memory contract registry — no ClickHouse on the request path. The
// Sourcify-compatible verification API (Phase 2) lives separately in
// verification.ts when it lands.
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
}
