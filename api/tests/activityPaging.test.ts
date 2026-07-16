import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { explorerRoutes } from '../src/routes/explorer.ts'

describe('activity paging bounds', () => {
  const app = Fastify()

  beforeAll(async () => {
    await app.register(explorerRoutes)
  })

  afterAll(async () => {
    await app.close()
  })

  it('rejects oversized global offsets instead of allocating the full prefix', async () => {
    const response = await app.inject('/explorer/activity?offset=10001')

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'Activity offset must be between 0 and 10000' })
  })

  it('rejects an oversized account tail explicitly', async () => {
    const response = await app.inject('/explorer/address/alice/activity?tail=6001')

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'Activity offset/tail exceeds the supported 10000/6000 row window' })
  })
})
