import { describe, expect, it } from 'vitest'
import { UNTRUSTED_REL, untrustedEmailHref, untrustedWebHref, xHandle } from '../src/utils/untrustedLinks'

// On-chain identity fields and tip reasons are written by whoever owns the account:
// a link only for a plain address of its kind, never another scheme, never one into
// the reader's own network.

describe('untrustedWebHref', () => {
  it('keeps an http(s) URL and gives a bare domain https://', () => {
    expect(untrustedWebHref('https://example.org/about')).toBe('https://example.org/about')
    expect(untrustedWebHref('http://example.org')).toBe('http://example.org/')
    expect(untrustedWebHref('example.org')).toBe('https://example.org/')
    expect(untrustedWebHref('  www.example.org/team?x=1 ')).toBe('https://www.example.org/team?x=1')
  })

  it('refuses every other scheme and anything that is not one address', () => {
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd',
      '//example.org', '/account/x', 'ftp://example.org', 'example', 'example .org', 'https://exa mple.org', 'https:\\\\example.org', '', '   ']) {
      expect(untrustedWebHref(bad), bad).toBeNull()
    }
    expect(untrustedWebHref(null)).toBeNull()
    expect(untrustedWebHref(undefined)).toBeNull()
  })

  it('refuses a target in the reader’s own network or machine, and credentials', () => {
    for (const bad of ['http://localhost/', 'http://127.0.0.1/', 'https://192.168.1.1/admin', 'http://10.0.0.1', 'http://[::1]/',
      'http://router.local/', 'http://printer/', 'https://example.org:8443/', '192.168.0.1', 'http://2130706433/', 'https://user:pw@example.org/']) {
      expect(untrustedWebHref(bad), bad).toBeNull()
    }
  })

  it('opens with the forum’s rel', () => {
    expect(UNTRUSTED_REL).toBe('noopener noreferrer nofollow ugc')
  })
})

describe('untrustedEmailHref', () => {
  it('links one plain address', () => {
    expect(untrustedEmailHref('alice@example.org')).toBe('mailto:alice@example.org')
    expect(untrustedEmailHref(' alice.b+x@mail.example.org ')).toBe('mailto:alice.b+x@mail.example.org')
  })

  it('refuses queries, escapes, extra recipients and non-addresses', () => {
    for (const bad of ['alice@example.org?subject=x', 'alice@example.org,bob@example.org', 'a%0Ab@example.org', 'alice', 'alice@', '@example.org',
      'alice@localhost', 'javascript:alert(1)//@example.org', 'alice@exa mple.org']) {
      expect(untrustedEmailHref(bad), bad).toBeNull()
    }
  })
})

describe('xHandle', () => {
  it('reads a handle with or without its @', () => {
    expect(xHandle('@alice_1')).toBe('alice_1')
    expect(xHandle('alice')).toBe('alice')
  })

  it('refuses anything that is not a handle', () => {
    for (const bad of ['../../evil', 'alice/status/1', 'https://x.com/alice', 'a'.repeat(16), '', '@']) {
      expect(xHandle(bad), bad).toBeNull()
    }
  })
})
