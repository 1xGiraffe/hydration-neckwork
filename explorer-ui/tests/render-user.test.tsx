import { describe, it, expect, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AddrPill, UserTagPill } from '../src/components/ui'
import { LibrariesSection } from '../src/pages/Account'
import { Libraries } from '../src/pages/Libraries'
import { Tags } from '../src/pages/Tags'
import { LibraryDetail } from '../src/pages/LibraryDetail'
import { LibraryTagDetail } from '../src/pages/LibraryTagDetail'
import { TagDetail } from '../src/pages/TagDetail'
import { setTagMap, setTagMapError } from '../src/userTags'
import { parseRoute, paths } from '../src/router'
import { MOCK_LIBRARIES, MOCK_LIBRARY_DETAIL, MOCK_LIBRARY_TAG_DETAIL } from './fixtures/mockApi'
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

describe('library routes', () => {
  it('parses the library routes', () => {
    expect(parseRoute('/libraries')).toEqual({ name: 'libraries' })
    expect(parseRoute('/library/abc-123')).toEqual({ name: 'library', libraryId: 'abc-123' })
    expect(parseRoute('/library')).toEqual({ name: 'libraries' })
    expect(paths.libraries()).toBe('/libraries')
  })
})

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

  it('a user tag out-prioritizes the system tag and links to its own aggregate page', () => {
    setTagMap({ libraries: [
      { libraryId: 'lib1', name: 'Personal', tags: [{ tagId: 't1', name: 'Mine', color: '#0f0', icon: '', members: [ACC] }] },
      { libraryId: 'system', name: 'Hydration', tags: [] },
    ] })
    const html = renderToStaticMarkup(<AddrPill account={{ ...base, tag: { id: 'kraken', name: 'Kraken', color: '#a78bfa', icon: '🦑' } }} />)
    expect(html).toContain('Mine')
    // The tag's own combined view, sharing the system /tag/:id namespace —
    // not the library management page (/library/:libraryId).
    expect(hrefOf(html, 'Mine')).toBe('/tag/t1')
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

  it('a multi-member user tag disambiguates the pill with the member\'s last three address characters', () => {
    setTagMap({ libraries: [
      { libraryId: 'lib1', name: 'Personal', tags: [{ tagId: 't1', name: 'Mine', color: '#0f0', icon: '', members: [ACC, '15yy'] }] },
      { libraryId: 'system', name: 'Hydration', tags: [] },
    ] })
    const html = renderToStaticMarkup(<AddrPill account={{ ...base }} />)
    expect(html).toContain('Mine')
    expect(html).toContain('tag-member-suffix')
    expect(html).toContain(`·${base.address.slice(-3)}`)
  })

  it('a single-member user tag renders no member-disambiguation suffix', () => {
    setTagMap({ libraries: [
      { libraryId: 'lib1', name: 'Personal', tags: [{ tagId: 't1', name: 'Mine', color: '#0f0', icon: '', members: [ACC] }] },
      { libraryId: 'system', name: 'Hydration', tags: [] },
    ] })
    const html = renderToStaticMarkup(<AddrPill account={{ ...base }} />)
    expect(html).toContain('Mine')
    expect(html).not.toContain('tag-member-suffix')
  })

  it('a system tag with more than one member also gets the disambiguation suffix', () => {
    const html = renderToStaticMarkup(<AddrPill account={{ ...base, tag: { id: 'kraken', name: 'Kraken', color: '#a78bfa', icon: '🦑', memberCount: 2 } }} noCopy />)
    expect(html).toContain('Kraken')
    expect(html).toContain('tag-member-suffix')
    expect(html).toContain(`·${base.address.slice(-3)}`)
  })

  // Account.tsx's own associations row passes this: the page already names the
  // one account above, and a system tag there carries no memberCount at all
  // (unlike a user tag), so showing the suffix on some chips and not others in
  // that same row would read as an inconsistency rather than useful info.
  it('noMemberSuffix drops the disambiguator even when the tag has multiple members', () => {
    const html = renderToStaticMarkup(
      <UserTagPill tag={{ kind: 'system', id: 'kraken', name: 'Kraken', color: '#a78bfa', icon: '🦑', memberCount: 2 }} address={base.address} noCopy noMemberSuffix />,
    )
    expect(html).toContain('Kraken')
    expect(html).not.toContain('tag-member-suffix')
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

// useSession()'s useSyncExternalStore reads its SERVER snapshot (`() => null`)
// under renderToStaticMarkup — see router.tsx's useRoute for the same pattern —
// so every page render in this harness is necessarily the logged-out view.
// These are smoke tests for the anonymous path; the logged-in panels (Your
// libraries, Invites, owner controls) are exercised by hand per the task brief
// and by the e2e suite, matching how Account.tsx/TagDetail.tsx have no
// full-page render test here either.
describe('Tags hub — smoke render (logged out)', () => {
  it('renders the Hydration Tags hero and at least one (unclickable) public-library row', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['libraries'], MOCK_LIBRARIES)
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><Tags /></QueryClientProvider>)
    expect(html).toContain('Tags')
    // The one clickable "library" row: the built-in directory, promoted above
    // every user-made library.
    expect(html).toContain('Hydration Tags')
    expect(hrefOf(html, 'Hydration Tags')).toBe('/tags/hydration')
    expect(html).toContain('DeFi desks')
    // User-confirmed: a library row itself is not clickable — no anchor wraps
    // the name (only the nested owner pill and the subscribe button are).
    expect(hrefOf(html, 'DeFi desks')).toBeUndefined()
    // Logged out: no reorder/new-library affordances, but a real Subscribe
    // button (C12) — same appearance as the logged-in one, opening the login
    // dialog instead of a dead "log in first" prompt.
    expect(html).not.toContain('New library')
    expect(html).toContain('Subscribe')
    expect(html).not.toContain('Log in to subscribe')
  })
})

describe('Libraries — smoke render (logged out)', () => {
  it('is pure management now — no discover/invites, just a log-in prompt', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><Libraries /></QueryClientProvider>)
    expect(html).toContain('Libraries')
    expect(html).toMatch(/log in/i)
    expect(html).not.toContain('New library')
    expect(html).not.toContain('Subscribe')
  })
})

describe('LibraryDetail — smoke render (logged out)', () => {
  it('shows another user\'s library as statistics only — never its tags or members', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // The public endpoint ships no tag contents for a foreign library — only
    // the summary statistics. Mirror that shape here.
    queryClient.setQueryData(['library', 'defi-desks', false], { ...MOCK_LIBRARY_DETAIL, tags: [] })
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><LibraryDetail libraryId="defi-desks" /></QueryClientProvider>)
    expect(html).toContain('DeFi desks')
    // No "· library" suffix and no decorative avatar/icon block next to the name.
    expect(html).not.toContain('· library')
    expect(html).not.toContain('acct-avatar')
    // Statistics panel, not tag panels.
    expect(html).toContain('lib-stats')
    expect(html).toContain('Subscriber')
    expect(html).not.toContain('Active traders')
    // Anonymous viewer: no owner-only affordances.
    expect(html).not.toContain('New tag')
    expect(html).not.toContain('Remove')
    // C12: a public library shows a real Subscribe button even logged out —
    // same appearance as the logged-in one (`>Subscribe<` pins the button's
    // own text node, not the "Subscriber" stat label above, which contains
    // "Subscribe" as a substring).
    expect(html).toContain('>Subscribe<')
  })

  // C4: the visibility badge is always public/private — `isPersonal` (an
  // auto-created, non-deletable library, unrelated to who can see it) used to
  // render a THIRD "personal" chip value here, which read as if the library
  // were neither public nor private even though it's a plain public one.
  it('never shows a "personal" badge, even for the personal library — only public/private', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['library', 'defi-desks', false], { ...MOCK_LIBRARY_DETAIL, tags: [], isPersonal: true })
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><LibraryDetail libraryId="defi-desks" /></QueryClientProvider>)
    expect(html).toContain('>public<')
    expect(html).not.toContain('personal')
  })
})

// The aggregate view has no anonymous form at all — useSession()'s SSR snapshot
// is always null here (see the file-level comment above), so this necessarily
// renders the logged-out branch. A seeded query cache proves that branch takes
// priority over any (unreachable, since the query is session-gated) data rather
// than crashing trying to read it.
describe('LibraryTagDetail — smoke render (logged out)', () => {
  it('hints to log in instead of showing "not found" or the tag data', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['library-tag', 'personal', 'personal-watch'], MOCK_LIBRARY_TAG_DETAIL)
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><LibraryTagDetail libraryId="personal" tagId="personal-watch" /></QueryClientProvider>)
    expect(html).toMatch(/log in/i)
    expect(html).not.toContain('Watching')
    expect(html).not.toContain('Tag not found')
  })
})

// TagDetail's own routing between the system view and a user tag's aggregate
// view. A UUID-shaped id is a real "maybe" until the tag map answers, so the
// three states below (anonymous / loading / a slug that was never a maybe at
// all) each get their own case rather than trusting a race between requests.
describe('TagDetail — routing between system and user-tag views', () => {
  const USER_TAG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
  beforeEach(() => setTagMap(null))

  it('shows a log-in hint — not "Tag not found" — for a UUID-shaped id with no session', () => {
    // Default reset: no session at all, i.e. tagMapStatus() === 'anonymous'.
    const html = renderToStaticMarkup(<TagDetail tagId={USER_TAG_ID} />)
    expect(html).toMatch(/log in/i)
    expect(html).not.toContain('Tag not found')
  })

  it('shows the page skeleton — not "Tag not found" — for a UUID-shaped id while the tag map is loading', () => {
    setTagMap(null, true) // session exists, map not back yet: tagMapStatus() === 'loading'
    const html = renderToStaticMarkup(<TagDetail tagId={USER_TAG_ID} />)
    expect(html).toContain('acct-head-skeleton')
    expect(html).not.toContain('Tag not found')
    expect(html).not.toMatch(/log in/i)
  })

  it('routes to LibraryTagDetail once the map is ready and hits — not TagDetail\'s own anonymous hint', () => {
    setTagMap({ libraries: [
      { libraryId: 'lib1', name: 'Personal', tags: [{ tagId: USER_TAG_ID, name: 'Mine', color: '#0f0', icon: '', members: [ACC] }] },
    ] })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><TagDetail tagId={USER_TAG_ID} /></QueryClientProvider>)
    // LibraryTagDetail itself still gates on a real session (useSession() is
    // always null under this SSR harness — see the file-level comment above),
    // so this can't reach the tag's real content here; it CAN prove routing
    // got past TagDetail's own anonymous-UUID hint (a real "Log in" BUTTON,
    // absent from LibraryTagDetail's own plain-text one) into LibraryTagDetail
    // instead of stalling on TagDetail's — the e2e suite covers the full,
    // logged-in "shows the real tag" path this harness cannot reach.
    expect(html).not.toContain('<button')
    expect(html).toMatch(/log in/i)
  })

  it('never shows the user-tag anonymous hint for a slug-shaped id, even though tagMapStatus() is "anonymous" too', () => {
    // A slug can never be a user tag, so it must fast-path straight to
    // SystemTagDetail regardless of tag-map state — "log in to view this
    // tag" only ever comes from TagDetail's OWN anonymous-UUID branch, and
    // SystemTagDetail never renders that text under any of its own states
    // (loading/error/data), so its presence here would mean the UUID gate
    // didn't run before the tag-map check.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><TagDetail tagId="kraken" /></QueryClientProvider>)
    expect(html).not.toMatch(/log in/i)
  })

  // Regression for the "loading forever" bug: a failed tag-map fetch must
  // settle into the SAME fallback a genuine ready-but-missing id gets
  // (SystemTagDetail's own lookup), never stay on TagDetail's own skeleton —
  // 'error' is terminal. Both TagDetail's TagDetailSkeleton and
  // SystemTagDetail's own (still-loading) skeleton render the identical
  // `acct-head-skeleton` class, so the differentiator is the crumb: only
  // SystemTagDetail's 3-segment one names the tag id as its last crumb
  // (TagDetailSkeleton's is a bare 2-segment "Home / Tags").
  it('falls through to the system lookup — not TagDetail\'s own skeleton — once the tag map fetch has failed outright', () => {
    setTagMapError()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><TagDetail tagId={USER_TAG_ID} /></QueryClientProvider>)
    expect(html).not.toMatch(/log in/i)
    expect(html).toContain(`>${USER_TAG_ID}<`)
  })
})
