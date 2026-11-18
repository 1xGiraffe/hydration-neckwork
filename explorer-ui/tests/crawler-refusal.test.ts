import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// nginx refuses a robots.txt-ignoring crawler exactly the URLs robots.txt disallows
// ($refuse_crawler in nginx.conf). The two lists must stay one list: a path closed in
// robots.txt but missing from the map keeps costing api reads, and a path in the map
// that robots.txt allows would refuse a page that crawler is entitled to.

const conf = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8')
const robots = readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8')

const disallowed = robots.split('\n').filter(l => l.startsWith('Disallow:')).map(l => l.slice('Disallow:'.length).trim())
const mapBody = conf.slice(conf.indexOf('map "$robots_ignoring_crawler:$uri" $refuse_crawler {'))
const pattern = mapBody.match(/"~\^1:(\/[^"]+)" 1;/)![1]
// nginx matches `<flag>:<uri>`; the pattern after `1:` is the URI part.
const refused = (uri: string) => new RegExp(`^${pattern}`).test(uri)

describe('the robots.txt-ignoring crawler refusal', () => {
  it('refuses every disallowed path, and nothing robots.txt leaves open', () => {
    expect(disallowed.length).toBeGreaterThan(10)
    for (const d of disallowed) {
      const sample = d.endsWith('/') ? `${d}123` : d
      expect(refused(sample), sample).toBe(true)
    }
    for (const open of ['/', '/account/7L53bUTBbfuj14UpdCNPwmgzzHSsrsTWBHX5pys32mVWM3C1', '/asset/0', '/governance', '/discussions', '/referendum/opengov/461', '/blocks', '/extrinsics', '/link-devices', '/blockchain/1', '/api/explorer/live']) {
      expect(refused(open), open).toBe(false)
    }
  })

  it('names exactly the robots.txt list, in its order', () => {
    const dirs = disallowed.filter(d => d.endsWith('/')).map(d => d.slice(1, -1))
    const exact = disallowed.filter(d => !d.endsWith('/')).map(d => d.slice(1))
    expect(pattern).toBe(`/((${dirs.join('|')})/|(${exact.join('|')})$)`)
  })

  it('applies only to the named crawler, before any location is chosen', () => {
    expect(conf).toMatch(/map \$http_user_agent \$robots_ignoring_crawler \{\n {4}default 0;\n {4}"~\*meta-externalagent" 1;\n\}/)
    const server = conf.slice(conf.indexOf('server {'))
    expect(server.indexOf('if ($refuse_crawler)')).toBeLessThan(server.indexOf('location '))
  })
})
