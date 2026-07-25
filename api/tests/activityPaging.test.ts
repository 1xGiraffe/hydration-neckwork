import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { explorerRoutes } from '../src/routes/explorer.ts'
import { scopedListTotalKey } from '../src/services/explorerService.ts'

// The global feed's bound is per category because the cost is. Measured warm at
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
    for (const type of ['stake', 'otc']) {
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

  // Account and tag activity pages are bounded by the builder's candidate ceiling,
  // not by the offset: it grows one window until the classified feed is complete, so
  // the depth of a page changes only which slice of that window is returned. That is
  // the same window the exact total is counted from, which is what makes every page a
  // real total implies servable — the pager can offer the last page of any feed it
  // could count. The route bound only stays above any countable feed length.
  it('serves account and tag activity pages far past the wide-feed bound', async () => {
    for (const route of ['/explorer/address/alice/activity', '/explorer/tag/whales/activity']) {
      for (const offset of [10001, 90_000, 900_000]) {
        const response = await app.inject(`${route}?offset=${offset}`)

        expect(response.statusCode, `${route} offset ${offset}`).not.toBe(400)
      }
    }
  })

  it('still refuses an offset no countable feed can reach', async () => {
    for (const route of ['/explorer/address/alice/activity', '/explorer/tag/whales/activity']) {
      const response = await app.inject(`${route}?offset=900001`)

      expect(response.statusCode, route).toBe(400)
      expect(response.json()).toEqual({ error: 'Activity offset must be between 0 and 900000' })
    }
  })
})

// The pager's total must move with the filters the list is showing, so the cached
// total is keyed on every one of them. A filter missing from the key would serve one
// filter's total under another's — the pager would then advertise pages the filtered
// feed does not hold.
describe('list total cache key', () => {
  const base = { tab: 'activity' as const }

  it('separates the four lists', () => {
    const keys = (['activity', 'extrinsics', 'events', 'votes'] as const).map(tab => scopedListTotalKey('addr:0x01', { tab }))

    expect(new Set(keys).size).toBe(4)
  })

  it('separates two accounts asking for the same list', () => {
    expect(scopedListTotalKey('addr:0x01', base)).not.toBe(scopedListTotalKey('addr:0x02', base))
    expect(scopedListTotalKey('tag:whales', base)).not.toBe(scopedListTotalKey('addr:0x01', base))
  })

  it('changes for every filter a list can apply', () => {
    const variants = [
      { ...base, type: 'trade' },
      { ...base, action: 'Swap' },
      { ...base, value: { token: 'HDX' } },
      { ...base, value: { min: 100 } },
      { ...base, value: { min: 100, unit: 'token' as const } },
      { ...base, extrinsic: { call: 'Balances.transfer' } },
      { ...base, extrinsic: { result: 'failed' as const } },
      { ...base, extrinsic: { origin: 'proxy' as const } },
      { ...base, event: { event: 'Balances.Transfer' } },
      { ...base, from: '2024-01-01' },
      { ...base, to: '2024-01-01' },
    ]
    const keys = variants.map(query => scopedListTotalKey('addr:0x01', query))

    expect(new Set([...keys, scopedListTotalKey('addr:0x01', base)]).size).toBe(variants.length + 1)
  })

  it('treats a cleared filter as absent, so it shares the unfiltered total', () => {
    expect(scopedListTotalKey('addr:0x01', { ...base, action: undefined, value: {}, event: {} }))
      .toBe(scopedListTotalKey('addr:0x01', base))
  })
})
