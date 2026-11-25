import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { Writable } from 'node:stream'
import { redactLoggedUrl, requestLogSerializers } from '../src/routes/logRedaction.ts'

const WALLET_A = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'
const WALLET_B = '0x' + 'ab'.repeat(20)

describe('redactLoggedUrl', () => {
  it('drops the wallet list of an account-refs lookup', () => {
    expect(redactLoggedUrl(`/explorer/account-refs?addresses=${WALLET_A},${WALLET_B}`)).toBe('/explorer/account-refs?[redacted]')
    expect(redactLoggedUrl('/explorer/account-refs')).toBe('/explorer/account-refs')
    expect(redactLoggedUrl(`/explorer/governance/needs-vote?accounts=${WALLET_A},${WALLET_B}`)).toBe('/explorer/governance/needs-vote?[redacted]')
  })

  it('drops whatever follows a /link segment, in the path or the query', () => {
    expect(redactLoggedUrl('/user/notifications/channels/telegram/link/abc123secret')).toBe('/user/notifications/channels/telegram/link/[redacted]')
    expect(redactLoggedUrl('/user/notifications/channels/telegram/link/status/abc123secret?x=1')).toBe('/user/notifications/channels/telegram/link/[redacted]')
    expect(redactLoggedUrl('/user/notifications/channels/telegram/link?id=abc123secret')).toBe('/user/notifications/channels/telegram/link/[redacted]')
    // The bare path names nothing secret.
    expect(redactLoggedUrl('/user/notifications/channels/telegram/link')).toBe('/user/notifications/channels/telegram/link')
  })

  it('leaves every other URL as requested', () => {
    for (const url of [
      `/explorer/address/${WALLET_A}?tab=activity`,
      '/explorer/activity?type=trade&action=swap',
      '/explorer/linked-accounts/x',
      '/explorer/search?q=link',
    ]) expect(redactLoggedUrl(url)).toBe(url)
  })
})

describe('request log serializer', () => {
  it('keeps the redacted URL out of the request log line', async () => {
    const logs: string[] = []
    const stream = new Writable({ write(chunk, _enc, done) { logs.push(String(chunk)); done() } })
    const app = Fastify({ logger: { level: 'info', stream, serializers: requestLogSerializers } })
    app.get('/explorer/account-refs', async () => [])
    app.get('/user/notifications/channels/telegram/link/:code', async () => ({ linked: false }))
    await app.inject(`/explorer/account-refs?addresses=${WALLET_A},${WALLET_B}`)
    await app.inject('/user/notifications/channels/telegram/link/abc123secret')
    const lines = logs.map(line => JSON.parse(line) as { req?: { url: string; method: string } })
    const urls = lines.flatMap(line => (line.req ? [line.req.url] : []))
    expect(urls).toEqual(['/explorer/account-refs?[redacted]', '/user/notifications/channels/telegram/link/[redacted]'])
    expect(lines.find(line => line.req)?.req?.method).toBe('GET')
    const all = logs.join('')
    expect(all).not.toContain(WALLET_A)
    expect(all).not.toContain(WALLET_B)
    expect(all).not.toContain('abc123secret')
  })
})
