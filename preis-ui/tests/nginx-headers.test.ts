import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The preis host's nginx configuration, read as shipped: its security headers reach
// every response, the per-user api does not exist here, and no decoded path is
// written into an upstream request.

const conf = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8')
const headers = readFileSync(new URL('../preis_headers.conf', import.meta.url), 'utf8')
const seo = readFileSync(new URL('../preis_seo.conf', import.meta.url), 'utf8')
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

const code = (s: string) => s.replace(/#[^\n]*/g, '')
const INCLUDE = 'include /etc/nginx/preis_headers.conf;'

function locations(text: string): { pattern: string; body: string }[] {
  const out: { pattern: string; body: string }[] = []
  for (const m of text.matchAll(/location\s+(?:=|~\*?|\^~)?\s*("[^"]+"|[^\s{]+)\s*\{/g)) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') depth--
    }
    out.push({ pattern: m[1].replace(/^"|"$/g, ''), body: code(text.slice(m.index + m[0].length, i - 1)) })
  }
  return out
}

describe('security headers', () => {
  const csp = /add_header Content-Security-Policy "([^"]+)" always;/.exec(headers)![1]
  const directive = (name: string) => csp.split(';').map(s => s.trim()).find(s => s.startsWith(`${name} `))

  it('sets the explorer’s baseline', () => {
    expect(directive('default-src')).toBe("default-src 'self'")
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'")
    expect(directive('object-src')).toBe("object-src 'none'")
    expect(directive('base-uri')).toBe("base-uri 'self'")
    expect(directive('connect-src')).toBe("connect-src 'self'")
    expect(headers).toContain('add_header X-Content-Type-Options "nosniff" always;')
    expect(headers).toContain('add_header X-Frame-Options "DENY" always;')
    expect(headers).toContain('add_header Referrer-Policy "strict-origin-when-cross-origin" always;')
    expect(headers).toMatch(/add_header Permissions-Policy "camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)" always;/)
  })

  it('allows scripts from this origin and the one inline bootstrap by hash, never unsafe-inline', () => {
    expect(directive('script-src')).toBe("script-src 'self' __CSP_SCRIPT_HASH__")
    // The Dockerfile hashes the built index.html's inline script into the placeholder
    // and fails the build unless it was replaced.
    expect(dockerfile).toContain('COPY preis_headers.conf /etc/nginx/preis_headers.conf')
    expect(dockerfile).toMatch(/sed -i "s\|__CSP_SCRIPT_HASH__\|\$\(cat \/tmp\/csp_script_hash\)\|" \/etc\/nginx\/preis_headers\.conf/)
    const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(m => !/\bsrc=/.test(m[1]))
    expect(inline).toHaveLength(1)
  })

  it('loads images only from this origin and the hosts the app names', () => {
    expect(directive('img-src')).toBe("img-src 'self' data: blob: https://cdn.jsdelivr.net https://cdn.discordapp.com")
    const icons = readFileSync(new URL('../src/utils/iconUrls.ts', import.meta.url), 'utf8')
    const host = /const ICON_CDN = '(https:\/\/[^/']+)/.exec(icons)![1]
    expect(directive('img-src')).toContain(host)
  })

  it('reaches every response: the server block and every location with an add_header of its own', () => {
    const server = code(conf.slice(conf.indexOf('server {')))
    expect(server.slice(0, server.indexOf('location '))).toContain(INCLUDE)
    const own = locations(conf).filter(l => /\badd_header\b/.test(l.body))
    expect(own.length).toBeGreaterThanOrEqual(5)
    for (const l of own) expect(l.body, l.pattern).toContain(INCLUDE)
    // The api-rendered pages take the server block's headers: no add_header there.
    expect(code(seo)).not.toMatch(/\badd_header\b/)
    expect(code(seo)).toMatch(/proxy_hide_header Content-Security-Policy;/)
    expect(code(seo)).toMatch(/proxy_hide_header X-Content-Type-Options;/)
  })
})

describe('upstream requests', () => {
  it('refuses the per-user api', () => {
    const user = locations(conf).find(l => l.pattern === '/api/user/')!
    expect(user.body.trim()).toBe('return 404;')
  })

  it('never writes a decoded path into a proxy_pass URI', () => {
    for (const m of code(conf).matchAll(/proxy_pass\s+([^;]+);/g)) {
      expect(m[1], m[0]).not.toMatch(/\$uri|\$request_uri|\$document_uri/)
    }
  })

  it('caps one client’s concurrent live streams', () => {
    const live = locations(conf).find(l => l.pattern === '/api/explorer/live')!
    expect(live.body).toMatch(/limit_conn preis_live_conn 8;/)
  })
})
