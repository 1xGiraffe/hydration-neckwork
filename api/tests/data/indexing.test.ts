import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { DOCS_CANONICAL_URL, DOCS_DESCRIPTION, DOCS_TITLE, isAuthExempt } from '../../src/data/app.ts'
import { dataConfig } from '../../src/data/config.ts'
import { fakeDataClient, freshDataApp } from './helpers.ts'

// The docs portal is the one page on this host meant to be found by a search
// engine, so what a crawler receives — no token, and often no script
// execution — is pinned here: a real title, description and canonical URL in
// the INITIAL HTML rather than applied later by the Scalar bundle, a robots.txt
// that opens exactly the documents a token-less client can read, and a
// sitemap naming the portal.

let app: FastifyInstance

beforeAll(async () => {
  app = await freshDataApp(fakeDataClient())
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

describe('the docs portal as a crawler sees it', () => {
  it('sends /docs to /docs/, the canonical form', async () => {
    const res = await app.inject('/docs')
    expect(res.statusCode).toBe(301)
    expect(res.headers.location).toBe('/docs/')
    expect(DOCS_CANONICAL_URL).toBe(`${dataConfig.publicUrl}/docs/`)
  })

  it('carries title, description and canonical in the served HTML', async () => {
    const res = await app.inject('/docs/')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
    const head = res.body.slice(0, res.body.indexOf('</head>'))
    expect(head).toContain(`<title>${DOCS_TITLE}</title>`)
    // The plugin's default title is what the page showed before `pageTitle`
    // was set; the bundle would only correct it after the crawler has left.
    expect(head).not.toContain('Scalar API Reference')
    expect(head).toContain(`<meta name="description" content="${DOCS_DESCRIPTION}" />`)
    expect(head).toContain(`<link rel="canonical" href="${DOCS_CANONICAL_URL}" />`)
    // The splice lands exactly once, inside <head>.
    expect(res.body.split('rel="canonical"').length - 1).toBe(1)
  })

  it('hashes the spliced document, not the plugin\'s', async () => {
    // The splice runs before @fastify/etag, so the validator matches the body a
    // client actually holds — otherwise a revalidation would confirm a body
    // that was never sent.
    const res = await app.inject('/docs/')
    const digest = createHash('sha1').update(res.body).digest('base64')
    expect(res.headers.etag).toBe(`"${digest}"`)
  })

  it('leaves every other document alone', async () => {
    for (const url of ['/openapi.json', '/llms.txt', '/robots.txt', '/sitemap.xml']) {
      const res = await app.inject(url)
      expect(res.statusCode, url).toBe(200)
      expect(res.body, url).not.toContain('rel="canonical"')
    }
  })
})

describe('/robots.txt', () => {
  it('opens the token-free documents, forbids the rest, and names the sitemap', async () => {
    const res = await app.inject('/robots.txt')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    expect(res.headers['cache-control']).toBe('public, max-age=3600')
    expect(res.body).toBe([
      'User-agent: *',
      'Allow: /docs',
      'Allow: /openapi.json',
      'Allow: /llms.txt',
      'Allow: /sitemap.xml',
      'Disallow: /',
      '',
      `Sitemap: ${dataConfig.publicUrl}/sitemap.xml`,
      '',
    ].join('\n'))
  })

  it('allows only paths that answer without a token', async () => {
    // A crawler carries no token, so an Allow on an authenticated path would
    // invite it to index a 401. The Allow set must stay inside AUTH_EXEMPT —
    // the two lists live apart and this is what keeps them from drifting.
    const body = (await app.inject('/robots.txt')).body
    const allowed = body.split('\n').filter(line => line.startsWith('Allow: ')).map(line => line.slice('Allow: '.length))
    expect(allowed.length).toBeGreaterThan(0)
    for (const path of allowed) {
      expect(isAuthExempt(path), path).toBe(true)
    }
    // /docs is the one Allow that is a PREFIX rather than a single file: the
    // portal is a page plus the bundle it renders itself with, and a crawler
    // that could fetch the page but not the script would index an empty shell.
    expect(isAuthExempt('/docs/')).toBe(true)
    expect(isAuthExempt('/docs/js/scalar.js')).toBe(true)
  })
})

describe('/sitemap.xml', () => {
  it('lists the docs portal and nothing else', async () => {
    const res = await app.inject('/sitemap.xml')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/xml/)
    expect(res.headers['cache-control']).toBe('public, max-age=3600')
    expect(res.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(res.body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    const locs = [...res.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])
    expect(locs).toEqual([DOCS_CANONICAL_URL])
  })
})
