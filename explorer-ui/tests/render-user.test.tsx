import { describe, it, expect, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AddrPill } from '../src/components/ui'
import { LibrariesSection } from '../src/pages/Account'
import { setTagMap } from '../src/userTags'
import type { AccountRef, LibrarySummaryRef } from '../src/types'

// Finds the single anchor wrapping `text` (libraries render an icon + name
// inside one <a>, so the href never sits right next to the visible text) and
// returns its href, same intent as `screen.getByText(text).closest('a')` in a
// harness with jsdom/@testing-library/react — neither is set up here (see the
// AddrPill precedence tests above), so every render test in this file asserts
// on the static markup string instead.
function hrefOf(html: string, text: string): string | undefined {
  const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
  return anchors.find(m => m[2].includes(text))?.[1]
}

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

describe('LibrariesSection — account page tag libraries', () => {
  const publicLib: LibrarySummaryRef = { libraryId: 'l1', name: 'Whales', note: '', visibility: 'public', isPersonal: false, owner: base, tagCount: 2, accountCount: 5, subscriberCount: 3 }
  const privateLib: LibrarySummaryRef = { libraryId: 'l2', name: 'Personal', note: '', visibility: 'private', isPersonal: true, owner: base, tagCount: 1, accountCount: 2, subscriberCount: 0 }

  it('lists an account’s public libraries and marks private ones on the own page', () => {
    const libs = [publicLib]
    const own = [...libs, privateLib]
    const html = renderToStaticMarkup(<LibrariesSection publicLibraries={libs} ownLibraries={own} isOwn />)
    expect(html).toContain('Whales')
    expect(html).toContain('Personal')
    expect(html).toMatch(/only you/i)      // private marker
    expect(hrefOf(html, 'Whales')).toBe('/library/l1')
    // The public "Whales" library is owned by the viewer, so it's present in
    // BOTH lists — it must still render as one row, not two. (The icon's
    // title="Whales" attribute repeats the name, so match the visible text
    // node — >Whales< — rather than every occurrence of the word.)
    expect(html.match(/>Whales</g)).toHaveLength(1)
  })

  it('shows only the public list — no private marker, no manage link — on someone else’s page', () => {
    const html = renderToStaticMarkup(<LibrariesSection publicLibraries={[publicLib]} ownLibraries={[]} isOwn={false} />)
    expect(html).toContain('Whales')
    expect(html).not.toMatch(/only you/i)
    expect(html).not.toContain('Manage libraries')
  })

  it('renders nothing for a foreign account with no public libraries', () => {
    const html = renderToStaticMarkup(<LibrariesSection publicLibraries={[]} ownLibraries={[]} isOwn={false} />)
    expect(html).toBe('')
  })

  it('still renders — empty — with a manage link on an empty own page', () => {
    const html = renderToStaticMarkup(<LibrariesSection publicLibraries={[]} ownLibraries={[]} isOwn />)
    expect(html).toContain('Manage libraries')
    expect(hrefOf(html, 'Manage libraries')).toBe('/libraries')
  })
})
