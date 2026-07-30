import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const routes = readFileSync(new URL('../src/routes/explorer.ts', import.meta.url), 'utf8')
const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
const nginx = readFileSync(new URL('../../explorer-ui/nginx.conf', import.meta.url), 'utf8')

const fn = (source: string, name: string) => {
  const at = source.indexOf(`function ${name}(`)
  expect(at, name).toBeGreaterThan(-1)
  return source.slice(at, source.indexOf('\n}\n', at))
}

// Two responses can be asked for narrower: the account history without the per-asset
// balance history (98-99% of it on a real account, and read only by the Balances
// treemap), and the asset directory without prices, totals or sparklines (57% of
// 74 kB, and read only by the Assets page). Both are opt-in, and both keep serving
// the wider shape by default — these pin the properties that make that true, because
// a caller pinned to the old response must not be able to tell the change happened.
describe('the account history narrows only on an explicit series=1', () => {
  it('reads the flag once, as an exact match, so anything else serves the full shape', () => {
    expect([...routes.matchAll(/\?\.series === '1'/g)]).toHaveLength(1)
    expect(routes).toContain("const seriesOnly = (req.query as { series?: string })?.series === '1'")
    expect(routes).toContain('getAddressHistory(params.data.address, { seriesOnly })')
  })

  it('can empty balanceHistory and nothing else', () => {
    const history = fn(explorerService, 'getAddressHistory')
    // The two series are computed the same way for both shapes, so the Overview's
    // chart — series, dates and the pinned final point — is byte-identical either way.
    expect(history).toContain('balanceHistory: opts.seriesOnly ? [] : history.balanceHistory')
    expect([...history.matchAll(/opts\.seriesOnly/g)]).toHaveLength(1)
    expect(history).toContain('portfolioDates: history.portfolioDates')
    expect(history).toContain('if (portfolioSeries.length) portfolioSeries[portfolioSeries.length - 1] = +(detail.portfolioUsd - debtUsd).toFixed(2)')
  })

  it('still shares the one cached walk, so this trims bytes and not query work', () => {
    const history = fn(explorerService, 'getAddressHistory')
    expect([...history.matchAll(/getAccountHistoryShared\(/g)]).toHaveLength(1)
    // No branch skips the reconstruction: the flag is a projection, not a cheaper path.
    expect(history).not.toMatch(/seriesOnly[^\n]*getAccountHistoryShared/)
  })
})

describe('the asset directory narrows only on an explicit fields=filter', () => {
  it('serves the full directory for an absent or unrecognized fields', () => {
    const reads = [...routes.matchAll(/\?\.fields === 'filter'/g)]
    expect(reads).toHaveLength(1)
    expect(routes).toContain("(req.query as { fields?: string })?.fields === 'filter' ? getAssetFilterOptions() : getAssets()")
  })

  it('projects the same cached, same-ordered directory rather than querying again', () => {
    const projection = fn(explorerService, 'getAssetFilterOptions')
    expect(projection).toContain('(await getAssets()).map(')
    // No second sort and no second read: the filter's option order is the directory's.
    expect(projection).not.toContain('.sort(')
    expect(projection).not.toContain('cached(')
    expect(projection).toContain('assetId: a.assetId, symbol: a.symbol, name: a.name')
  })
})

describe('a narrowed request is cached exactly as long, and apart', () => {
  it('picks the max-age from the path, so the query parameter cannot lose the TTL', () => {
    expect([...server.matchAll(/req\.url\.split\('\?'\)\[0\]/g)]).toHaveLength(1)
    expect(server).toContain('[/^\\/explorer\\/address\\/[^/]+\\/history/, 120],')
    expect(server).toContain('[/^\\/explorer\\/assets/, 30],')
  })

  it('keys the shared proxy cache on the full request URI, so the shapes never mix', () => {
    expect([...nginx.matchAll(/proxy_cache_key\s+"\$request_uri";/g)]).toHaveLength(1)
    expect(nginx).not.toContain('proxy_cache_key "$uri"')
  })
})
