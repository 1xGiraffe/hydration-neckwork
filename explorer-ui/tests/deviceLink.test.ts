import { describe, it, expect } from 'vitest'
import { deviceLinkUrl, extractDeviceLinkCode, DEVICE_LINK_PATH } from '../src/deviceLink'
import { parseRoute } from '../src/router'

const CODE = 'ab'.repeat(32)

describe('device-link URL round trip', () => {
  it('builds a fragment URL and extracts the code back out', () => {
    const url = deviceLinkUrl('https://hydration-explorer.neckwork.net', CODE)
    expect(url).toBe(`https://hydration-explorer.neckwork.net${DEVICE_LINK_PATH}#${CODE}`)
    expect(extractDeviceLinkCode(url)).toBe(CODE)
  })

  it('accepts a bare code, uppercase, and padding whitespace', () => {
    expect(extractDeviceLinkCode(CODE)).toBe(CODE)
    expect(extractDeviceLinkCode(` ${CODE.toUpperCase()} `)).toBe(CODE)
  })

  it('rejects foreign QR payloads', () => {
    expect(extractDeviceLinkCode('https://example.com/link-device#' + 'zz'.repeat(32))).toBeNull()
    expect(extractDeviceLinkCode('https://hydration-explorer.neckwork.net/account/xyz')).toBeNull()
    expect(extractDeviceLinkCode('WIFI:T:WPA;S:cafe;;')).toBeNull()
    expect(extractDeviceLinkCode('ab'.repeat(31))).toBeNull()
    expect(extractDeviceLinkCode('')).toBeNull()
  })
})

describe('router', () => {
  it('parses /link-device (the fragment never reaches the router)', () => {
    expect(parseRoute('/link-device')).toEqual({ name: 'link-device' })
  })
})
