import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isLocalNetworkHref } from '../src/services/localNetwork.ts'
import { localNetworkUrls } from '../src/services/forumText.ts'

// Native forum writes refuse links into a private or local network; the explorer renders
// any that exist (imported text) as inert text. Both decide with the same file.

describe('the local-network check is one rule in two places', () => {
  it('is byte-identical in the api and the explorer', () => {
    const api = readFileSync(new URL('../src/services/localNetwork.ts', import.meta.url), 'utf8')
    const ui = readFileSync(new URL('../../explorer-ui/src/markdown/localNetwork.ts', import.meta.url), 'utf8')
    expect(api).toBe(ui)
  })

  it('flags internal-service style targets and leaves public links alone', () => {
    for (const u of ['http://db:8123/?query=SELECT%201', 'https://10.0.2.1/x.png', 'https://storage:5001/api/v0/version',
      'https://db./x.png', 'http://[::1]/', 'http://169.254.169.254/latest', 'http://nas.local/']) expect(isLocalNetworkHref(u), u).toBe(true)
    for (const u of ['https://hydration.net', 'https://example.org/img.png', 'https://8.8.8.8/']) expect(isLocalNetworkHref(u), u).toBe(false)
  })
})

describe('localNetworkUrls', () => {
  it('finds them in markdown links and images, autolinks, bare URLs and HTML attributes', () => {
    const text = [
      '![c](http://db:8123/?query=SELECT%201)', '[router](http://192.168.1.1/admin "t")', '<http://localhost:3000/x>',
      'see https://10.0.2.1/x.png.', '<img src="https://storage:5001/api/v0/version">', 'HTTP://127.0.0.1/',
      'fine: https://hydration.net/x and https://github.com/a/b',
    ].join('\n')
    expect(localNetworkUrls(text)).toEqual([
      'http://db:8123/?query=SELECT%201', 'http://192.168.1.1/admin', 'http://localhost:3000/x',
      'https://10.0.2.1/x.png', 'https://storage:5001/api/v0/version', 'HTTP://127.0.0.1/',
    ])
  })

  it('finds nothing in ordinary text', () => {
    expect(localNetworkUrls('A referendum about https://hydration.net and https://app.hydration.net/trade, no more.')).toEqual([])
  })
})
