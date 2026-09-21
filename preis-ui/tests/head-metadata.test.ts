import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// What a crawler or a link scraper receives from this app: one shell served
// for every path (nginx.conf falls back to index.html), whose head is the
// only metadata a client that runs no scripts ever sees. The pair and the
// price reach `document.title` from App.tsx later, so the static head has to
// stand on its own.

const ORIGIN = 'https://hydration-preis.neckwork.net'
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const head = html.slice(0, html.indexOf('</head>'))

function meta(attr: 'name' | 'property', key: string): string | null {
  const match = new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(head)
  return match ? match[1] : null
}

describe('the static head', () => {
  it('names the app and describes it', () => {
    expect(head).toContain('<title>Hydration Preis</title>')
    const description = meta('name', 'description')
    expect(description).toBeTruthy()
    // A result snippet is cut at roughly 160 characters; a longer one is
    // shown truncated mid-sentence.
    expect(description!.length).toBeLessThanOrEqual(160)
  })

  it('points every path at the one canonical URL', () => {
    expect(head).toContain(`<link rel="canonical" href="${ORIGIN}/" />`)
  })

  it('carries one consistent card for both scrapers', () => {
    expect(meta('property', 'og:title')).toBe('Hydration Preis')
    expect(meta('name', 'twitter:title')).toBe('Hydration Preis')
    expect(meta('property', 'og:description')).toBe(meta('name', 'description'))
    expect(meta('name', 'twitter:description')).toBe(meta('name', 'description'))
    expect(meta('name', 'twitter:card')).toBe('summary_large_image')
    // Both card images absolute: X renders no image from a relative path.
    expect(meta('property', 'og:image')).toBe(`${ORIGIN}/og-image.png`)
    expect(meta('name', 'twitter:image')).toBe(`${ORIGIN}/og-image.png`)
    expect(existsSync(new URL('../public/og-image.png', import.meta.url))).toBe(true)
    expect([meta('property', 'og:image:width'), meta('property', 'og:image:height')]).toEqual(['1200', '630'])
  })
})

describe('robots.txt and sitemap.xml come from the API, not the image', () => {
  const nginx = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8')

  it('ships no static copy that would shadow the served one', () => {
    // Both are generated: the sitemap lists one URL per chartable pair, which
    // only the live asset list knows, and robots.txt has to point at it. A file
    // in public/ would win over these locations and freeze both.
    expect(existsSync(new URL('../public/robots.txt', import.meta.url))).toBe(false)
    expect(existsSync(new URL('../public/sitemap.xml', import.meta.url))).toBe(false)
  })

  it('routes both to the API', () => {
    expect(nginx).toMatch(/location = \/robots\.txt \{\s*proxy_pass [^;]*\/seo\/preis\/robots\.txt;/)
    expect(nginx).toMatch(/location = \/sitemap\.xml \{\s*proxy_pass [^;]*\/seo\/preis\/sitemap\.xml;/)
  })

  it('falls back to the shell when the API cannot answer', () => {
    // The charts must keep loading when the renderer is down; only the metadata
    // is allowed to be lost.
    expect(readFileSync(new URL('../preis_seo.conf', import.meta.url), 'utf8')).toContain('error_page 404 500 502 503 504 = @spa;')
    expect(nginx).toMatch(/location @spa \{/)
  })
})
