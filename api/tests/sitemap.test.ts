import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { __testing, SITEMAP_ACCOUNT_LIMIT, robotsTxt } from '../src/routes/sitemap.ts'
import { UNBOUNDED_PREFIXES, pageMeta, renderHead, PUBLIC_URL } from '../src/routes/seo.ts'

const { paginate, renderUrlSet, renderIndex, w3c } = __testing
const robots = readFileSync(new URL('../../explorer-ui/public/robots.txt', import.meta.url), 'utf8')

const urls = (n: number, prefix = '/account/a') => Array.from({ length: n }, (_, i) => ({ loc: `https://x/${prefix}${i}` }))

describe('a sitemap file says only what the protocol reads', () => {
  it('omits changefreq and priority, which Google and Bing both ignore', () => {
    const xml = renderUrlSet([{ loc: 'https://x/a' }])
    expect(xml).not.toContain('changefreq')
    expect(xml).not.toContain('priority')
  })

  it('emits lastmod only when a real timestamp was supplied', () => {
    expect(renderUrlSet([{ loc: 'https://x/a' }])).not.toContain('<lastmod>')
    expect(renderUrlSet([{ loc: 'https://x/a', lastmod: '2026-09-21T00:00:00.000Z' }])).toContain('<lastmod>2026-09-21T00:00:00.000Z</lastmod>')
  })

  it('refuses to invent a timestamp from an unusable value', () => {
    expect(w3c(null)).toBeUndefined()
    expect(w3c('')).toBeUndefined()
    expect(w3c('not a date')).toBeUndefined()
    expect(w3c('2026-09-21 12:00:00')).toBe('2026-09-21T12:00:00.000Z')
  })

  it('escapes a URL rather than emitting XML that will not parse', () => {
    const xml = renderUrlSet([{ loc: 'https://x/tag/a&b<c>"d\'e' }])
    expect(xml).toContain('a&amp;b&lt;c&gt;&quot;d&apos;e')
    expect(xml).not.toMatch(/loc>[^<]*[&][^a-z]/)
  })
})

describe('a section that outgrows the protocol limits splits instead of truncating', () => {
  it('keeps one file below 50,000 URLs', () => {
    const files = paginate('accounts', urls(50_000))
    expect(files.size).toBe(1)
    expect(files.get('sitemap-accounts.xml')?.match(/<url>/g)).toHaveLength(50_000)
  })

  it('numbers the parts past the ceiling, losing nothing', () => {
    const files = paginate('accounts', urls(50_001))
    expect([...files.keys()]).toEqual(['sitemap-accounts.xml', 'sitemap-accounts-2.xml'])
    const total = [...files.values()].reduce((n, xml) => n + (xml.match(/<url>/g)?.length ?? 0), 0)
    expect(total).toBe(50_001)
  })

  it('still produces a valid, empty file for a section with nothing in it', () => {
    const files = paginate('tags', [])
    expect(files.get('sitemap-tags.xml')).toContain('<urlset')
    expect(files.get('sitemap-tags.xml')).not.toContain('<url>')
  })
})

describe('the index points at its children on the canonical host', () => {
  it('lists every file it was given', () => {
    const xml = renderIndex(['sitemap-core.xml', 'sitemap-tags.xml'])
    expect(xml).toContain('<sitemapindex')
    expect(xml).toContain('https://hydration-explorer.neckwork.net/sitemap-core.xml')
    expect(xml).toContain('https://hydration-explorer.neckwork.net/sitemap-tags.xml')
    expect(xml.match(/<sitemap>/g)).toHaveLength(2)
  })
})

// The sitemap advertises pages; robots.txt closes URL spaces. They have to agree
// about which spaces those are, or the sitemap invites a crawler somewhere
// robots.txt turns it away — which Search Console reports as an error against
// the sitemap.
describe('robots.txt and the sitemap are written from one list', () => {
  it('disallows every unbounded prefix the head layer marks', () => {
    for (const prefix of UNBOUNDED_PREFIXES) {
      expect(robotsTxt(), prefix).toContain(`Disallow: /${prefix}/`)
    }
  })

  // The generated file is what the site serves; the one in the image is the
  // fallback nginx reaches only when the API cannot answer — and it must answer
  // SOMETHING, because a 5xx on robots.txt tells a crawler to stop crawling the
  // host. A fallback that disagrees would quietly open a space the live one
  // closes, so the two are pinned to the same rules.
  it('ships a fallback file that closes exactly what the generated one closes', () => {
    const rules = (text: string) => [...text.matchAll(/^(?:Allow|Disallow): (\S+)$/gm)].map(m => m[0]).sort()
    expect(rules(robots)).toEqual(rules(robotsTxt()))
  })

  it('builds the Sitemap line from the configured origin, never a fixed host', () => {
    // The generated one follows EXPLORER_PUBLIC_URL; only the fallback in the
    // image can name a host literally, because a file cannot read an env var.
    expect(robotsTxt()).toContain(`Sitemap: ${PUBLIC_URL}/sitemap.xml`)
  })

  it('disallows nothing the sitemap advertises', () => {
    const disallowed = [...robots.matchAll(/^Disallow: (\S+)$/gm)].map(m => m[1])
    for (const path of ['/accounts', '/assets', '/tag/kraken', '/asset/5', '/referendum/opengov/411', '/list/x', '/governance', '/']) {
      for (const rule of disallowed) {
        expect(path.startsWith(rule) && rule !== '/', `${path} vs ${rule}`).toBe(false)
      }
    }
  })

  it('points at the sitemap index', () => {
    expect(robotsTxt()).toContain('/sitemap.xml')
    expect(robots).toMatch(/^Sitemap: https:\/\/\S+\/sitemap\.xml$/m)
  })

  it('never pairs a Disallow with a robots meta tag on the same page', () => {
    // Shipping both is the combination Google documents as wrong: a disallowed
    // URL is never fetched, so the meta tag cannot be read. The tag IS used, for
    // soft 404s — those URLs are reachable, which is the whole difference.
    for (const path of ['/block/14871261', '/extrinsic/1-2', '/swap/1-2', '/dca/30104']) {
      const meta = pageMeta(path)
      expect(meta.crawlerExcluded, path).toBe(true)
      expect(renderHead(meta, path), path).not.toContain('name="robots"')
    }
  })
})

describe('the account slice is a ranked head, not the directory', () => {
  it('is capped far below the ~116,000 accounts that exist', () => {
    // Small on purpose twice over: the tail is thin content, and the directory
    // page this reads enriches every row it returns, so its cost scales with the
    // page size. The rest of the directory is one link away on /accounts.
    expect(SITEMAP_ACCOUNT_LIMIT).toBe(500)
    expect(SITEMAP_ACCOUNT_LIMIT).toBeLessThan(MAX_SECTION_URLS)
  })
})

const MAX_SECTION_URLS = 50_000
