import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { explorerRoutes } from '../src/routes/explorer.ts'

// The bound is per category because the cost is. Measured warm at
// /explorer/activity?limit=25&offset=10000: otc 0.007s, staking 0.027s, vote 0.051s,
// trade 0.093s, liquidity 0.267s, dca 0.319s, mm 0.413s, all 1.153s, transfer 4.233s,
// xcm 37.806s — against max_execution_time 20s. The deep set is the categories whose
// source is small enough that the whole feed is reachable (vote_activity 121,078 rows,
// staking_activity 192,006, otc_activity 4,473); the wide feeds read multi-million-row
// sources and keep the conservative bound. This is what withheld
// /activity?tab=vote&page=490 — 92% of the vote feed, at 51ms a page.
describe('activity paging bounds', () => {
  const app = Fastify()

  beforeAll(async () => {
    await app.register(explorerRoutes)
  })

  afterAll(async () => {
    await app.close()
  })

  it('rejects oversized offsets on the wide feeds instead of allocating the full prefix', async () => {
    const response = await app.inject('/explorer/activity?offset=10001')

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: "Activity offset must be between 0 and 10000 for type 'all'" })
  })

  it('names the category in the error so the bound is not a mystery', async () => {
    const response = await app.inject('/explorer/activity?offset=10001&type=transfer')

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: "Activity offset must be between 0 and 10000 for type 'transfer'" })
  })

  it('lets the narrow categories page far past the wide-feed bound', async () => {
    // The page the user could not reach: /activity?tab=vote&page=490 -> offset 12250.
    for (const offset of [10001, 12250, 250_000]) {
      const response = await app.inject(`/explorer/activity?offset=${offset}&type=vote`)

      expect(response.statusCode, `vote offset ${offset}`).not.toBe(400)
    }
    for (const type of ['staking', 'otc']) {
      for (const offset of [10001, 250_000]) {
        const response = await app.inject(`/explorer/activity?offset=${offset}&type=${type}`)

        expect(response.statusCode, `${type} offset ${offset}`).not.toBe(400)
      }
    }
  })

  it('still bounds the narrow categories above their own row counts', async () => {
    const response = await app.inject('/explorer/activity?offset=250001&type=vote')

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: "Activity offset must be between 0 and 250000 for type 'vote'" })
  })

  it('applies the narrow bound to the dedicated votes feeds', async () => {
    for (const route of ['/explorer/address/alice/votes', '/explorer/tag/whales/votes']) {
      const ok = await app.inject(`${route}?offset=12250`)
      const tooDeep = await app.inject(`${route}?offset=250001`)

      expect(ok.statusCode, route).not.toBe(400)
      expect(tooDeep.statusCode, route).toBe(400)
      expect(tooDeep.json()).toEqual({ error: 'Votes offset must be between 0 and 250000' })
    }
  })

  it('rejects an oversized account tail explicitly, naming the category bound', async () => {
    const response = await app.inject('/explorer/address/alice/activity?tail=6001')

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: "Activity offset/tail exceeds the supported 10000/6000 row window for type 'all'" })
  })

  it('reports the narrow bound on the account activity feed too', async () => {
    const response = await app.inject('/explorer/address/alice/activity?offset=250001&type=vote')

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: "Activity offset/tail exceeds the supported 250000/6000 row window for type 'vote'" })
  })
})
