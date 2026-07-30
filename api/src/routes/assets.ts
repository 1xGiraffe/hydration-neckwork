import type { FastifyInstance } from 'fastify'
import { getAllAssets } from '../services/assetsService.ts'

export async function assetsRoutes(fastify: FastifyInstance) {
  fastify.get('/assets', async () => {
    return getAllAssets()
  })
}
