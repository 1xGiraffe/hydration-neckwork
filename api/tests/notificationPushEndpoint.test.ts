import { describe, it, expect, vi } from 'vitest'

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>()
  const answers: Record<string, Array<{ address: string; family: number }>> = {
    'fcm.googleapis.com': [{ address: '142.250.0.10', family: 4 }, { address: '2a00:1450:4001::5f', family: 6 }],
    'wns2-x.notify.windows.com': [{ address: '10.1.2.3', family: 4 }],
    'web.push.apple.com': [{ address: '17.0.0.1', family: 4 }, { address: '::1', family: 6 }],
  }
  return {
    ...actual,
    lookup: (hostname: string, options: { all?: boolean }, callback: (err: Error | null, address: unknown, family?: number) => void) => {
      const found = answers[hostname] ?? []
      if (options.all) callback(null, found)
      else callback(null, found[0]?.address, found[0]?.family)
    },
  }
})

const { isAllowedPushEndpoint, isPublicAddress, publicOnlyLookup } = await import('../src/notifications/pushEndpoint.ts')

describe('push endpoint allow-list', () => {
  it('accepts the push services browsers use', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://wns2-db5p.notify.windows.com/w/?token=abc',
      'https://web.push.apple.com/QH-abc',
      'https://api.push.apple.com/3/device/abc',
    ]) expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(true)
  })

  it('refuses anything else', () => {
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc',              // not https
      'https://fcm.googleapis.com:8443/fcm/send/abc',        // explicit port
      'https://user:pw@fcm.googleapis.com/fcm/send/abc',     // credentials
      'https://fcm.googleapis.com.example.org/x',            // lookalike suffix
      'https://evilnotify.windows.com/x',                    // not a subdomain
      'https://notify.windows.com/x',                        // the bare suffix
      'https://192.0.2.1/push',
      'https://[::1]/push',
      'https://localhost/push',
      'not a url',
    ]) expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(false)
  })
})

describe('public address check', () => {
  it('accepts global unicast and refuses private, loopback, reserved and tunnelled ranges', () => {
    expect(isPublicAddress('142.250.0.10')).toBe(true)
    expect(isPublicAddress('2a00:1450:4001::5f')).toBe(true)
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0',
      '::1', '::', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '2001:db8::1', '2002:a00:1::1', 'not-an-ip']) {
      expect(isPublicAddress(ip), ip).toBe(false)
    }
  })

  it('fails a lookup when any answer is not public', async () => {
    const run = (host: string, all: boolean) => new Promise<{ err: NodeJS.ErrnoException | null }>(resolve => {
      publicOnlyLookup(host, { all }, err => resolve({ err }))
    })
    expect((await run('fcm.googleapis.com', true)).err).toBeNull()
    expect((await run('fcm.googleapis.com', false)).err).toBeNull()
    expect((await run('wns2-x.notify.windows.com', false)).err?.code).toBe('ENOTPUBLIC')
    expect((await run('web.push.apple.com', true)).err?.code).toBe('ENOTPUBLIC')
  })
})
