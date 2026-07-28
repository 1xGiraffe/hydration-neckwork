import { describe, it, expect, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AddrPill } from '../src/components/ui'
import { setTagMap } from '../src/userTags'
import type { AccountRef } from '../src/types'

// No jsdom/@testing-library/react in this repo's test setup (see
// tests/render.test.tsx) — render tests assert on the static markup string,
// same as every other component test.
const ACC = '0x' + 'ab'.repeat(32)
const base: AccountRef = { accountId: ACC, address: '15xx', emoji: '🦊', tag: null, identity: null, profile: null }

describe('AddrPill precedence with profiles and user tags', () => {
  beforeEach(() => setTagMap(null))

  it('shows the profile name above identity, without a verified mark', () => {
    const html = renderToStaticMarkup(<AddrPill account={{ ...base, profile: { name: 'Maf', avatarVersion: 0 }, identity: { display: 'Chain Name', verified: true, email: '', web: '', twitter: '' } }} />)
    expect(html).toContain('Maf')
    expect(html).toContain('profile-name')
    expect(html).not.toContain('Chain Name')
    expect(html).not.toContain('Verified identity')
  })

  it('renders the self-set avatar image (cache-busted by avatarVersion) alongside the profile name', () => {
    const html = renderToStaticMarkup(<AddrPill account={{ ...base, profile: { name: 'Maf', avatarVersion: 3 } }} />)
    expect(html).toContain(`/api/explorer/profile-avatar/${ACC}?v=3`)
  })

  it('a user tag out-prioritizes the system tag and links to its library', () => {
    setTagMap({ libraries: [
      { libraryId: 'lib1', name: 'Personal', tags: [{ tagId: 't1', name: 'Mine', color: '#0f0', icon: '', members: [ACC] }] },
      { libraryId: 'system', name: 'Hydration', tags: [] },
    ] })
    const html = renderToStaticMarkup(<AddrPill account={{ ...base, tag: { id: 'kraken', name: 'Kraken', color: '#a78bfa', icon: '🦑' } }} />)
    expect(html).toContain('Mine')
    expect(html).toContain('/library/lib1')
    expect(html).not.toContain('Kraken')
  })

  it('identity still wins over the bare address when no profile exists', () => {
    const html = renderToStaticMarkup(<AddrPill account={{ ...base, identity: { display: 'Chain Name', verified: true, email: '', web: '', twitter: '' } }} />)
    expect(html).toContain('Chain Name')
  })

  it('the system tag still wins when no user library claims the account (logged out)', () => {
    const html = renderToStaticMarkup(<AddrPill account={{ ...base, tag: { id: 'kraken', name: 'Kraken', color: '#a78bfa', icon: '🦑' } }} noCopy />)
    expect(html).toContain('Kraken')
    expect(html).toContain('/tag/kraken')
  })
})
