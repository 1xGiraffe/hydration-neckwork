import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { pageMeta, renderHead, renderPage, renderBody, PUBLIC_URL } from '../src/routes/seo.ts'

// The real shell this rewrites, not a stand-in: what matters is that the regex
// finds the tags THIS file actually ships, so the test has to read it.
const shell = readFileSync(new URL('../../explorer-ui/index.html', import.meta.url), 'utf8')

const HOST = 'https://hydration-explorer.neckwork.net'

describe('pageMeta names the page', () => {
  it('describes a hub from fixed copy', () => {
    expect(pageMeta('/accounts').title).toBe('Accounts')
    expect(pageMeta('/accounts').description).toMatch(/directory/i)
    expect(pageMeta('/accounts').crawlerExcluded).toBeUndefined()
  })

  it('treats a trailing slash as the same page', () => {
    expect(pageMeta('/accounts/')).toEqual(pageMeta('/accounts'))
  })

  it('names a block from its id alone, and marks the class crawlers are kept out of', () => {
    const meta = pageMeta('/block/14871261')
    expect(meta.title).toBe('Block #14,871,261')
    expect(meta.crawlerExcluded).toBe(true)
  })

  it('marks every unbounded id space, and no entity page', () => {
    for (const path of ['/block/1', '/extrinsic/1-2', '/event/1-2', '/swap/1-2', '/transfer/1-2', '/dca/30104', '/intent/12345', '/liquidate/1-e2']) {
      expect(pageMeta(path).crawlerExcluded, path).toBe(true)
    }
    for (const path of ['/', '/accounts', '/asset/5', '/tag/kraken', '/referendum/opengov/411', '/account/0xabc']) {
      expect(pageMeta(path).crawlerExcluded, path).toBeUndefined()
    }
  })

  it('refuses to name a page whose id names nothing, and keeps it out of the index', () => {
    // Before this, the head asserted a page existed for any string in these
    // shapes — "notanaddress · Hydration Explorer" for a malformed address, and
    // a confident title for a referendum index far past the last real one. Both
    // are soft 404s, which Google counts against the whole site.
    for (const path of ['/list/not-a-public-list', '/account/notanaddress', '/somewhere']) {
      const meta = pageMeta(path)
      expect(meta.notFound, path).toBe(true)
      expect(meta.title, path).toBe('Hydration Explorer')
    }
  })

  it('claims absence only where absence is KNOWN, never where the lookup was unavailable', () => {
    // The asset registry is empty in a unit test. "Not in an empty registry" is
    // not evidence of anything, so an asset id must NOT be called missing here —
    // an unloaded registry would otherwise noindex every asset page on the site.
    expect(pageMeta('/asset/999999').notFound).toBeUndefined()
    // Same for a referendum with no titles loaded: there is no highest index to
    // compare against, so nothing can be called out of range.
    expect(pageMeta('/referendum/opengov/999999').notFound).toBeUndefined()
    // ...and for a tag with no tag index loaded.
    expect(pageMeta('/tag/does-not-exist').notFound).toBeUndefined()
  })

  it('reads an asset out of the registry, and says nothing about an unknown id', () => {
    // Asset 0 is HDX in every deployment; the registry is loaded at boot, and an
    // unloaded registry must degrade to the generic shell rather than invent.
    const known = pageMeta('/asset/0')
    const unknown = pageMeta('/asset/999999')
    expect(unknown.title).toBe('Hydration Explorer')
    expect(known.title === 'Hydration Explorer' || known.title.includes('—')).toBe(true)
  })

  it('builds a breadcrumb trail that stops before the page itself', () => {
    expect(pageMeta('/block/1').crumbs).toEqual([['Home', '/'], ['Blocks', '/blocks']])
    expect(pageMeta('/referendum/opengov/411').crumbs).toEqual([['Home', '/'], ['Governance', '/governance']])
    expect(pageMeta('/').crumbs).toEqual([])
  })
})

describe('renderHead', () => {
  const meta = { title: 'Kraken', description: 'Seven tagged accounts.', crumbs: [['Home', '/'], ['Tags', '/tags']] as [string, string][] }

  it('suffixes the site name once, and never onto a title that already opens with it', () => {
    expect(renderHead(meta, '/tag/kraken')).toContain('<title>Kraken · Hydration Explorer</title>')
    expect(renderHead({ title: 'Hydration Explorer', description: 'x' }, '/')).toContain('<title>Hydration Explorer</title>')
    expect(renderHead({ title: 'Hydration Explorer — blocks', description: 'x' }, '/')).toContain('<title>Hydration Explorer — blocks</title>')
  })

  it('points the canonical at the bare path on the public host', () => {
    expect(renderHead(meta, '/tag/kraken')).toContain(`<link rel="canonical" href="${HOST}/tag/kraken" />`)
  })

  it('never marks a robots.txt-closed page noindex — the two must not both claim it', () => {
    // A disallowed URL is never fetched, so a noindex on it could not be read;
    // emitting both is the one combination Google tells you not to ship.
    expect(renderHead(meta, '/tag/kraken')).not.toContain('name="robots"')
    expect(renderHead({ ...meta, crawlerExcluded: true }, '/block/1')).not.toContain('name="robots"')
  })

  it('marks a page whose id names nothing noindex, which IS reachable and so can read it', () => {
    expect(renderHead({ ...meta, notFound: true }, '/asset/999999')).toContain('<meta name="robots" content="noindex" />')
  })

  it('claims the site identity on the home page only', () => {
    const home = renderHead({ title: 'Hydration Explorer', description: 'x' }, '/')
    expect(home).toContain('"@type":"WebSite"')
    expect(home).toContain('"@type":"Organization"')
    // Deliberately absent: the sitelinks search box it drove was retired in 2024.
    expect(home).not.toContain('SearchAction')
    expect(renderHead(meta, '/tag/kraken')).not.toContain('"@type":"WebSite"')
  })

  it('escapes page data, including into attributes', () => {
    // A tag name is written by a user and lands inside a content="…" attribute.
    const hostile = { title: '"><script>alert(1)</script>', description: "Bobby's <b>tag</b> & co" }
    const html = renderHead(hostile, '/tag/x')
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
    expect(html).toContain('&amp; co')
    expect(html).toContain('&#39;s')
  })

  it('emits a BreadcrumbList ending at the page, escaped so it cannot close its own script', () => {
    const html = renderHead({ ...meta, title: '</script><img>' }, '/tag/x')
    const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)
    expect(json).not.toBeNull()
    expect(html).not.toContain('</script><img>')
    const data = JSON.parse(json![1].replace(/\\u003c/g, '<'))
    expect(data['@type']).toBe('BreadcrumbList')
    expect(data.itemListElement).toHaveLength(3)
    expect(data.itemListElement[2]).toMatchObject({ position: 3, item: `${HOST}/tag/x` })
  })
})

describe('renderPage rewrites the shell rather than appending to it', () => {
  const out = renderPage(shell, '/block/14871261')

  it('leaves exactly one of each tag a crawler reads', () => {
    for (const [label, re] of [
      ['title', /<title>/g],
      ['og:title', /property="og:title"/g],
      ['og:description', /property="og:description"/g],
      ['description', /name="description"/g],
      ['twitter:title', /name="twitter:title"/g],
      ['canonical', /rel="canonical"/g],
    ] as const) {
      expect(out.match(re)?.length ?? 0, label).toBe(1)
    }
  })

  it('drops the shell’s generic copy for the page’s own', () => {
    expect(shell).toContain('Live block explorer for the Hydration network')
    expect(out).not.toContain('Live block explorer for the Hydration network')
    expect(out).toContain('<title>Block #14,871,261 · Hydration Explorer</title>')
  })

  it('keeps everything else in the shell — the bundle, the icons, the theme script', () => {
    expect(out).toContain('/src/main.tsx') // dev shell; the built one carries the hashed bundle
    expect(out).toContain('rel="manifest"')
    expect(out).toContain('apple-touch-icon')
    expect(out).toContain('GazpachoMedium-latin.woff2')
    expect(out).toContain("localStorage.getItem('explorer-theme')")
    expect(out).toContain('<div id="root"></div>')
  })

  it('closes the head it opened', () => {
    expect(out.match(/<\/head>/g)).toHaveLength(1)
    expect(out.indexOf('rel="canonical"')).toBeLessThan(out.indexOf('</head>'))
  })

  it('works for a path the allowlist let through but nothing identifies', () => {
    const generic = renderPage(shell, '/somewhere')
    expect(generic).toContain('<title>Hydration Explorer</title>')
    expect(generic.match(/<title>/g)).toHaveLength(1)
  })
})

// Compose passes EXPLORER_PUBLIC_URL through as an empty string when it is not
// set, and `??` treats that as a value — which shipped relative <loc> elements
// in the sitemap and a relative og:url, both invalid.
describe('the canonical origin survives an unset environment', () => {
  it('is absolute', () => {
    expect(PUBLIC_URL).toMatch(/^https:\/\/[^/]+$/)
    expect(PUBLIC_URL).not.toMatch(/\/$/)
  })

  it('puts an absolute URL in every place that requires one', () => {
    const html = renderHead({ title: 'Accounts', description: 'x' }, '/accounts')
    for (const attr of [/<link rel="canonical" href="([^"]+)"/, /property="og:url" content="([^"]+)"/, /property="og:image" content="([^"]+)"/]) {
      expect(attr.exec(html)?.[1], String(attr)).toMatch(/^https:\/\//)
    }
  })
})

// An account answers to several strings that share no prefix — the Polkadot
// SS58, the Hydration SS58, the 32-byte account id, an H160 where there is one.
// Only the first ever appeared anywhere, so pasting either of the others into a
// search engine matched nothing.
describe('every form of an address is stated, not just the one the page shows', () => {
  // A real substrate account: 32-byte id, and the two SS58 encodings of it.
  const ACCOUNT_ID = '0xa32d0f5749bd74dcddfed48e959f42529f8365c5bf321378d7d5209342f1eca1'
  const POLKADOT = '14gxC4rWay5HmsPuZtFtbapekZvnpcZ1ZZjKHafK3Z7H1ebc'

  it('keeps the short address in the title, and the full one where it is matched', () => {
    // Every explorer titles an account page with the truncated address, and the
    // client sets the same string on hydration, so the two never disagree. What
    // a search engine matches on is the URL, the description and the body.
    const meta = pageMeta(`/account/${POLKADOT}`)
    expect(meta.title).toBe('14gxC4…1ebc')
    expect(meta.description).toContain(POLKADOT)
  })

  it('lists the other encodings as facts', () => {
    const labels = (pageMeta(`/account/${POLKADOT}`).facts ?? []).map(([label]) => label)
    expect(labels).toContain('Polkadot (SS58)')
    expect(labels).toContain('Hydration (SS58)')
    expect(labels).toContain('Account ID')
  })

  it('states each one exactly once, and never the same string twice', () => {
    const values = (pageMeta(`/account/${POLKADOT}`).facts ?? []).map(([, value]) => value)
    expect(new Set(values).size).toBe(values.length)
    expect(values).toContain(ACCOUNT_ID)
    expect(values).toContain(POLKADOT)
  })

  it('renders them where something that does not run JS can read them, and a browser never paints them', () => {
    const html = renderPage(shell, `/account/${POLKADOT}`)
    // In <noscript>, NOT inside #root: React replaces #root's children only once
    // its module script has mounted, so a block there flashed unstyled on every
    // load. A browser running JavaScript does not render <noscript> at all.
    expect(html).toContain('<div id="root"></div>')
    const block = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)
    expect(block).not.toBeNull()
    expect(block![1]).toContain(ACCOUNT_ID)
    expect(block![1]).toContain(POLKADOT)
    expect(html.indexOf('<noscript>')).toBeGreaterThan(html.indexOf('<div id="root">'))
  })

  it('escapes a fact, which can carry a user-written name', () => {
    expect(renderBody({ title: 't', description: 'd', facts: [['Name', '<script>x</script>']] })).not.toContain('<script>')
  })

  it('adds nothing at all for a page with nothing to state', () => {
    expect(renderPage(shell, '/blocks')).not.toContain('<noscript>')
  })
})
