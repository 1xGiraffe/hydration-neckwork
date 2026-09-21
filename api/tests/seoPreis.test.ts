import { describe, it, expect } from 'vitest'
import { preisMeta, renderPreisHead, preisSitemap, PREIS_ROBOTS } from '../src/routes/seoPreis.ts'

const HOST = 'https://hydration-preis.neckwork.net'

describe('a Preis chart names itself', () => {
  it('describes the site at the root', () => {
    const meta = preisMeta('/')
    expect(meta.title).toContain('Hydration Preis')
    expect(meta.canonicalPath).toBe('/')
    expect(meta.notFound).toBeUndefined()
  })

  it('collapses every interval of a pair onto one canonical chart', () => {
    // Eight intervals of one pair are eight views of one chart. Without this the
    // same data competes with itself eight times.
    for (const interval of ['5min', '15min', '30min', '1h', '4h', '1d', '1w', '1M']) {
      expect(preisMeta(`/0-10/${interval}`).canonicalPath, interval).toBe('/0-10/1h')
    }
    expect(preisMeta('/0-10').canonicalPath).toBe('/0-10/1h')
  })

  it('marks a URL the app rewrites away as naming no page', () => {
    // An unparseable pair or an unknown interval is rewritten to the default
    // chart by the app, so the URL is a soft 404 rather than a page.
    for (const path of ['/not-a-pair/1h', '/0-10/99years', '/nonsense']) {
      expect(preisMeta(path).notFound, path).toBe(true)
    }
  })

  it('claims nothing about a numerically valid pair while the asset list is empty', () => {
    // Same rule as the explorer: absent from an unloaded list is not absent.
    expect(preisMeta('/0-10/1h').notFound).toBeUndefined()
  })
})

describe('the rendered head', () => {
  it('points the canonical at the canonical path, not the requested one', () => {
    const html = renderPreisHead(preisMeta('/0-10/4h'))
    expect(html).toContain(`<link rel="canonical" href="${HOST}/0-10/1h" />`)
  })

  it('noindexes a page that names nothing, and nothing else', () => {
    expect(renderPreisHead(preisMeta('/nonsense'))).toContain('content="noindex"')
    expect(renderPreisHead(preisMeta('/'))).not.toContain('name="robots"')
  })

  it('escapes into attributes', () => {
    const html = renderPreisHead({ title: '"><script>', description: "a & b", canonicalPath: '/' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&amp; b')
  })
})

describe('the Preis sitemap covers this host and only this host', () => {
  it('is absolute and on the charts host', () => {
    const xml = preisSitemap()
    expect(xml).toContain('<urlset')
    expect(xml).toContain(`<loc>${HOST}/</loc>`)
    for (const loc of [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])) {
      expect(loc.startsWith(`${HOST}/`), loc).toBe(true)
    }
  })

  it('offers one interval per pair, never the same chart eight times', () => {
    const locs = [...preisSitemap().matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])
    for (const loc of locs.filter(l => l !== `${HOST}/`)) {
      expect(loc, loc).toMatch(/\/\d+-10\/1h$/)
    }
    expect(new Set(locs).size).toBe(locs.length)
  })

  it('is advertised by a robots.txt on the same host', () => {
    expect(PREIS_ROBOTS).toContain(`Sitemap: ${HOST}/sitemap.xml`)
    expect(PREIS_ROBOTS).toContain('Allow: /')
  })
})
