import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The explorer's nginx configuration, read as shipped. nginx itself is not run here;
// these pin the shapes that keep a hostile URL from reaching the api raw, the
// image hosts the CSP admits, and the per-client brakes.

const conf = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8')
const seoPage = readFileSync(new URL('../seo_page.conf', import.meta.url), 'utf8')

/** Every `location` with its modifier, pattern and body (nested blocks included in the body). */
function locations(text: string): { mod: string; pattern: string; body: string }[] {
  const out: { mod: string; pattern: string; body: string }[] = []
  for (const m of text.matchAll(/location\s+(=|~\*?|\^~)?\s*("[^"]+"|[^\s{]+)\s*\{/g)) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') depth--
    }
    out.push({ mod: m[1] ?? '', pattern: m[2].replace(/^"|"$/g, ''), body: text.slice(m.index + m[0].length, i - 1) })
  }
  return out
}

const all = locations(conf)
const byPattern = (p: string) => {
  const found = all.find(l => l.pattern === p)
  if (!found) throw new Error(`no location ${p}`)
  return found
}
// Comments stripped, so prose that mentions a directive is never mistaken for one.
const code = (s: string) => s.replace(/#[^\n]*/g, '')

describe('page URLs sent to the head renderer', () => {
  const pageLocations = all.filter(l => l.body.includes('include /etc/nginx/seo_page.conf;'))

  it('sets the upstream path by rewrite, never by a URI inside proxy_pass', () => {
    // A variable in proxy_pass's URI is sent exactly as it expands, and $uri is
    // decoded; a rewrite under a bare proxy_pass is escaped again on the way out.
    const body = code(seoPage)
    expect(body).toMatch(/^rewrite \^ \/seo\/page\$uri\? break;$/m)
    // `break` ends the rewrite module: the bundle id must be set before it.
    expect(body.indexOf("include /etc/nginx/bundle_id.conf;")).toBeGreaterThanOrEqual(0)
    expect(body.indexOf("include /etc/nginx/bundle_id.conf;")).toBeLessThan(body.indexOf("rewrite ^"))
    expect(body).toMatch(/^proxy_pass http:\/\/\$api_upstream;$/m)
    expect(body).not.toMatch(/proxy_pass[^;]*\$uri/)
  })

  it('never writes a decoded path into any proxy_pass URI', () => {
    for (const m of code(conf).matchAll(/proxy_pass\s+([^;]+);/g)) {
      expect(m[1], m[0]).not.toMatch(/\$uri|\$request_uri|\$document_uri/)
    }
  })

  it('matches no page URL holding whitespace or a line break', () => {
    const regexes = pageLocations.filter(l => l.mod === '~').map(l => new RegExp(l.pattern))
    expect(regexes.length).toBeGreaterThanOrEqual(4)
    const matched = (path: string) => regexes.some(r => r.test(path))
    for (const ok of ['/account/7KTFfPoa44KxwZsa5N3syqxoSPddApcioLEMUEjYY8cohVos', '/asset/xc/near', '/oracle/dia:0xab:DOT/USD', '/governance/tip/0xab@12', '/activity']) {
      expect(matched(ok), ok).toBe(true)
    }
    for (const bad of ['/account/a b', '/account/a\r\nX-Injected: 1', '/account/a\nb', '/asset/xc/a\tb', '/oracle/a b/c', '/oracle/a/b\r\n', '/governance/tip/a\rb']) {
      expect(matched(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('writes only an id’s characters into the /tx/ redirect', () => {
    // A redirect's Location carries the capture as nginx decoded it.
    const tx = all.find(l => l.pattern.startsWith('^/tx/'))!
    expect(tx.body.trim()).toBe('return 301 /extrinsic/$1;')
    const re = new RegExp(tx.pattern)
    expect(re.test('/tx/0xab12')).toBe(true)
    expect(re.test('/tx/123-4')).toBe(true)
    expect(re.test('/tx/a\rX-Evil: 1')).toBe(false)
    expect(re.test('/tx/a\r\nSet-Cookie: x=1')).toBe(false)
  })

  it('sends every other capture into a redirect or proxy_pass only from a closed character set', () => {
    for (const l of all) {
      const target = /(?:return 30[12]|proxy_pass)\s+[^;]*\$[1-9]/.exec(code(l.body))
      if (!target) continue
      // Each capture group of the pattern is a character class or literal list without `.`.
      expect(l.pattern, l.pattern).not.toMatch(/\(\.[+*]\)|\[\^[^\]]*\][+*]\)/)
    }
  })
})

describe('the per-user api surface', () => {
  const user = byPattern('/api/user/')

  it('refuses an encoded slash or backslash in the path, and only in the path', () => {
    const m = /if \(\$request_uri ~\* "([^"]+)"\) \{\s*return 400;\s*\}/.exec(user.body)
    expect(m).not.toBeNull()
    const refused = new RegExp(m![1], 'i')
    expect(refused.test('/api/user/lists/x%2F..%2F..%2Fsessions')).toBe(true)
    expect(refused.test('/api/user/lists/x%2f..%2fsessions')).toBe(true)
    expect(refused.test('/api/user/lists/x%5C..%5Csessions')).toBe(true)
    expect(refused.test('/api/user/lists/7c9e6679-7425-40de-944b-e07fc1f90ae7/tags')).toBe(false)
    expect(refused.test('/api/user/activity?token=a%2Fb')).toBe(false)
  })

  it('never enters the shared cache', () => {
    expect(code(user.body)).not.toMatch(/proxy_cache\s+api_cache/)
  })
})

describe('the shared /api/ cache', () => {
  it('neither serves nor stores a request that carries credentials', () => {
    const api = code(byPattern('/api/').body)
    expect(api).toMatch(/proxy_no_cache \$http_authorization;/)
    expect(api).toMatch(/proxy_cache_bypass \$http_authorization;/)
  })
})

describe('the heavy-read brake', () => {
  const map = conf.slice(conf.indexOf('map "$api_client_exempt:$uri" $explorer_heavy_key {'))
  const keyed = [...map.slice(0, map.indexOf('}')).matchAll(/"~\^0:([^"]+)" \$api_client;/g)].map(m => new RegExp(`^${m[1]}`))
  const heavy = (uri: string) => keyed.some(r => r.test(uri))

  it('counts a list tag’s reads on both surfaces', () => {
    expect(heavy('/explorer/list-tag/7c9e6679-7425-40de-944b-e07fc1f90ae7/activity')).toBe(true)
    expect(heavy('/api/explorer/list-tag/abc/history')).toBe(true)
    expect(heavy('/user/list-tag/list-1/tag-1/events')).toBe(true)
    expect(heavy('/user/lists')).toBe(false)
    expect(heavy('/explorer/stats')).toBe(false)
  })

  it('applies on the per-user surface, where the owner’s list-tag reads go', () => {
    expect(code(byPattern('/api/user/').body)).toMatch(/limit_req zone=explorer_heavy_sustained/)
  })

  it('caps one client’s concurrent live streams', () => {
    expect(conf).toMatch(/limit_conn_zone \$api_live_key zone=explorer_live_conn:\d+m;/)
    expect(code(byPattern('/api/explorer/live').body)).toMatch(/limit_conn explorer_live_conn 8;/)
  })
})

describe('the CSP', () => {
  const csp = /add_header Content-Security-Policy "([^"]+)" always;/.exec(conf)![1]
  const directive = (name: string) => csp.split(';').map(s => s.trim()).find(s => s.startsWith(`${name} `))

  it('loads images only from this origin and the hosts the app names', () => {
    expect(directive('img-src')).toBe("img-src 'self' data: blob: https://cdn.jsdelivr.net https://raw.githubusercontent.com https://cdn.discordapp.com")
  })

  it('keeps every image host the code uses on that list', () => {
    const ui = readFileSync(new URL('../src/components/ui.tsx', import.meta.url), 'utf8')
    for (const m of ui.matchAll(/const (?:ICON_CDN|METADATA_CDN|METADATA_RAW) = '(https:\/\/[^/']+)/g)) {
      expect(directive('img-src'), m[1]).toContain(m[1])
    }
  })
})
