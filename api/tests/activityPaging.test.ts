import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { explorerRoutes } from '../src/routes/explorer.ts'
import { scopedListTotalKey } from '../src/services/explorerService.ts'

// The global feed's bound is per category because the cost is, and it is the depth
// each category was measured to actually answer — a bound above that advertises
// pages the feed then refuses. At offset 2500, with and without the page's default
// $10 floor: trade 0.3/0.8s, mm 1.5/1.8s, liquidity 1.2/4.7s, transfer 1.9/6.6s,
// xcm 3.3/8.1s, all 10.0/9.9s; at 5000 the merged and trade feeds refuse because
// their candidate windows widen past the ceiling. The deep set is the categories the
// feed pages in SQL over one small source (vote_activity 121,092 rows,
// staking_activity 192,060, otc_activity 4,473), where a deep offset cannot explode:
// at offset 190,000, vote 0.11s, staking 1.26s, otc 0.19s. That is what withheld
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
    const response = await app.inject('/explorer/activity?offset=2501')

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: "Activity offset must be between 0 and 2500 for type 'all'" })
  })

  it('names the category in the error so the bound is not a mystery', async () => {
    const response = await app.inject('/explorer/activity?offset=2501&type=transfer')

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: "Activity offset must be between 0 and 2500 for type 'transfer'" })
  })

  // The pager offers pages up to maxOffset and no further, so the bound the count
  // publishes has to be the same one the feed enforces — otherwise the last offered
  // page is a 400.
  it('publishes the same bound the feed enforces, per category', async () => {
    for (const [type, maxOffset] of [['all', 2500], ['transfer', 2500], ['vote', 250_000], ['stake', 250_000]] as const) {
      const count = await app.inject(`/explorer/activity/count?type=${type}`)
      const lastPage = await app.inject(`/explorer/activity?type=${type}&offset=${maxOffset}`)
      const pastEnd = await app.inject(`/explorer/activity?type=${type}&offset=${maxOffset + 1}`)

      // A countable category reads its total from ClickHouse, which these route-level
      // tests do not have; its bound is asserted through the feed's own refusal below.
      if (count.statusCode === 200) expect(count.json().maxOffset, type).toBe(maxOffset)
      expect(lastPage.statusCode, `${type} offset ${maxOffset}`).not.toBe(400)
      expect(pastEnd.statusCode, `${type} offset ${maxOffset + 1}`).toBe(400)
    }
  })

  // Counting a category means counting exactly the rows its pages hold. Only the
  // single-source SQL-paged feeds can do that, so the rest say so rather than
  // publishing a number the pages would not match.
  it('reports no total for the categories it cannot count', async () => {
    for (const type of ['all', 'trade', 'transfer', 'liquidity', 'mm', 'xcm', 'stake', 'otc']) {
      const response = await app.inject(`/explorer/activity/count?type=${type}`)

      expect(response.json(), type).toMatchObject({ total: null, complete: false })
    }
  })

  it('cannot count a category under an action filter, which is decided on built rows', async () => {
    const response = await app.inject('/explorer/activity/count?type=vote&action=Aye')

    expect(response.json()).toMatchObject({ total: null, complete: false })
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
  // not by the offset: it grows one window until the classified feed ends or the
  // ceiling is reached, and pages come only from the rows above that window's
  // frontier. Those are the same rows the published total counts, which is what makes
  // every page a real total numbers servable — the pager can offer the last page of
  // any feed it could count. The route bound only stays above any countable feed
  // length.
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

  // The SQL-paged lists used to answer an out-of-range offset with page one's rows
  // under the reader's page number: /explorer/events?offset=99999999 returned the
  // three newest events. A refusal is the only honest answer, and the pagers now
  // stop at the published bound so they never ask for one.
  it('refuses an out-of-range list offset instead of serving page one', async () => {
    for (const route of ['/explorer/blocks', '/explorer/extrinsics', '/explorer/events', '/explorer/accounts', '/explorer/holders/0', '/explorer/referenda']) {
      const response = await app.inject(`${route}?offset=20000001`)

      expect(response.statusCode, route).toBe(400)
      expect(response.json()).toEqual({ error: 'Offset must be between 0 and 20000000' })
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
