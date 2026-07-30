import { describe, it, expect, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AddrPill, UserTagPill } from '../src/components/ui'
import { ListsSection, TaggedInHint } from '../src/pages/Account'
import { Lists } from '../src/pages/Lists'
import { Tags } from '../src/pages/Tags'
import { ListDetail } from '../src/pages/ListDetail'
import { ListTagDetail } from '../src/pages/ListTagDetail'
import { TagDetail } from '../src/pages/TagDetail'
import { setTagMap, setTagMapError } from '../src/userTags'
import { parseRoute, paths } from '../src/router'
import { MOCK_LISTS, MOCK_LIST_DETAIL, MOCK_LIST_TAG_DETAIL } from './fixtures/mockApi'
import type { AccountRef, ListSummaryRef } from '../src/types'
import type { Session } from '../src/session'

// Finds the single anchor wrapping `text` (lists render an icon + name
// inside one <a>, so the href never sits right next to the visible text) and
// returns its href, same intent as `screen.getByText(text).closest('a')` in a
// harness with jsdom/@testing-list/react — neither is set up here (see the
// AddrPill precedence tests above), so every render test in this file asserts
// on the static markup string instead.
function hrefOf(html: string, text: string): string | undefined {
  const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
  return anchors.find(m => m[2].includes(text))?.[1]
}

// No jsdom/@testing-list/react in this repo's test setup (see
// tests/render.test.tsx) — render tests assert on the static markup string,
// same as every other component test.
const ACC = '0x' + 'ab'.repeat(32)
const base: AccountRef = { accountId: ACC, address: '15xx', emoji: '🦊', tag: null, identity: null, profile: null }

describe('list routes', () => {
  it('parses the list routes', () => {
    expect(parseRoute('/lists')).toEqual({ name: 'lists' })
    expect(parseRoute('/list/abc-123')).toEqual({ name: 'list', listId: 'abc-123' })
    expect(parseRoute('/list')).toEqual({ name: 'lists' })
    expect(paths.lists()).toBe('/lists')
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
    setTagMap({ lists: [
      { listId: 'lib1', name: 'Personal', tags: [{ tagId: 't1', name: 'Mine', color: '#0f0', icon: '', members: [ACC] }] },
      { listId: 'system', name: 'Hydration', tags: [] },
    ] })
    const html = renderToStaticMarkup(<AddrPill account={{ ...base, tag: { id: 'kraken', name: 'Kraken', color: '#a78bfa', icon: '🦑' } }} />)
    expect(html).toContain('Mine')
    // The tag's own combined view, sharing the system /tag/:id namespace —
    // not the list management page (/list/:listId).
    expect(hrefOf(html, 'Mine')).toBe('/tag/t1')
    expect(html).not.toContain('Kraken')
  })

  it('identity still wins over the bare address when no profile exists', () => {
    const html = renderToStaticMarkup(<AddrPill account={{ ...base, identity: { display: 'Chain Name', verified: true, email: '', web: '', twitter: '' } }} />)
    expect(html).toContain('Chain Name')
  })

  it('the system tag still wins when no user list claims the account (logged out)', () => {
    const html = renderToStaticMarkup(<AddrPill account={{ ...base, tag: { id: 'kraken', name: 'Kraken', color: '#a78bfa', icon: '🦑' } }} noCopy />)
    expect(html).toContain('Kraken')
    expect(html).toContain('/tag/kraken')
  })

  it('a multi-member user tag disambiguates the pill with the member\'s last three address characters', () => {
    setTagMap({ lists: [
      { listId: 'lib1', name: 'Personal', tags: [{ tagId: 't1', name: 'Mine', color: '#0f0', icon: '', members: [ACC, '15yy'] }] },
      { listId: 'system', name: 'Hydration', tags: [] },
    ] })
    const html = renderToStaticMarkup(<AddrPill account={{ ...base }} />)
    expect(html).toContain('Mine')
    expect(html).toContain('tag-member-suffix')
    expect(html).toContain(`·${base.address.slice(-3)}`)
  })

  it('a single-member user tag renders no member-disambiguation suffix', () => {
    setTagMap({ lists: [
      { listId: 'lib1', name: 'Personal', tags: [{ tagId: 't1', name: 'Mine', color: '#0f0', icon: '', members: [ACC] }] },
      { listId: 'system', name: 'Hydration', tags: [] },
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

describe('ListsSection — account page tag lists (owned public lists)', () => {
  const publicLib: ListSummaryRef = { listId: 'l1', name: 'Whales', note: '', visibility: 'public', isPersonal: false, owner: base, tagCount: 2, accountCount: 5, subscriberCount: 3 }
  const privateLib: ListSummaryRef = { listId: 'l2', name: 'Personal', note: '', visibility: 'private', isPersonal: true, owner: base, tagCount: 1, accountCount: 2, subscriberCount: 0 }

  it('lists an account’s public lists and marks private ones on the own page', () => {
    const libs = [publicLib]
    const own = [...libs, privateLib]
    const html = renderToStaticMarkup(<ListsSection publicLists={libs} ownLists={own} isOwn />)
    expect(html).toContain('Whales')
    expect(html).toContain('Personal')
    expect(html).toMatch(/only you/i)      // private marker
    expect(hrefOf(html, 'Whales')).toBe('/list/l1')
    // The public "Whales" list is owned by the viewer, so it's present in
    // BOTH lists — it must still render as one row, not two. (The icon's
    // title="Whales" attribute repeats the name, so match the visible text
    // node — >Whales< — rather than every occurrence of the word.)
    expect(html.match(/>Whales</g)).toHaveLength(1)
  })

  it('shows only the public list — no private marker, no manage link — on someone else’s page', () => {
    const html = renderToStaticMarkup(<ListsSection publicLists={[publicLib]} ownLists={[]} isOwn={false} />)
    expect(html).toContain('Whales')
    expect(html).not.toMatch(/only you/i)
    expect(html).not.toContain('Manage lists')
  })

  it('renders nothing for a foreign account with no public lists', () => {
    const html = renderToStaticMarkup(<ListsSection publicLists={[]} ownLists={[]} isOwn={false} />)
    expect(html).toBe('')
  })

  it('still renders — empty — with a manage link on an empty own page', () => {
    const html = renderToStaticMarkup(<ListsSection publicLists={[]} ownLists={[]} isOwn />)
    expect(html).toContain('Manage lists')
    expect(hrefOf(html, 'Manage lists')).toBe('/lists')
  })
})

// TaggedInHint is intentionally a SEPARATE component from ListsSection above:
// ownership (ListsSection) and being tagged as a member of someone ELSE's
// public list (this) are different questions, sourced from different
// endpoints (/lists vs /tagged-in) — an account can own zero public lists
// while still being tagged in one, which none of the ListsSection tests
// above exercise at all.
describe('TaggedInHint — logged-out "tagged in a public list" nudge', () => {
  const oneTag: ListSummaryRef = { listId: 'l1', name: 'Whales', note: '', visibility: 'public', isPersonal: false, owner: base, tagCount: 2, accountCount: 5, subscriberCount: 3 }
  const secondTag: ListSummaryRef = { listId: 'l3', name: 'DeFi desks', note: '', visibility: 'public', isPersonal: false, owner: base, tagCount: 1, accountCount: 9, subscriberCount: 1 }
  const OTHER_SESSION: Session = { token: 't2', accountId: '0x' + 'cd'.repeat(32), address: '15yy' }

  // Isolates the hint's own markup, scoped to its own span so it can't
  // false-positive against unrelated markup elsewhere on a real page.
  function hintTextOf(html: string): string | undefined {
    return html.match(/<span class="muted lists-login-hint">([\s\S]*?)<\/span>$/)?.[1]
  }

  // State 1: logged out, tagged in a public list — one fixed line that names
  // NOTHING (no list name, no count; the contents stay behind the login),
  // separated by a middle dot, with a real login action (a <button>, never a
  // dead link) wired to the same requestConnect() flow every other
  // logged-out subscribe affordance uses.
  it('renders the fixed nameless line with a working login action, logged out', () => {
    const html = renderToStaticMarkup(<TaggedInHint taggedIn={[oneTag]} session={null} />)
    const hint = hintTextOf(html)
    expect(hint).toMatch(/^Tags available for this account · /)
    expect(hint).toMatch(/login to subscribe/)
    expect(hint).toContain('<button')
    expect(hint).not.toContain('Whales')
  })

  // Several lists change nothing — same fixed line, still no names, no count.
  it('renders the identical line regardless of how many lists tag the account', () => {
    const one = renderToStaticMarkup(<TaggedInHint taggedIn={[oneTag]} session={null} />)
    const two = renderToStaticMarkup(<TaggedInHint taggedIn={[oneTag, secondTag]} session={null} />)
    expect(two).toBe(one)
    expect(hintTextOf(two)).not.toContain('DeFi desks')
  })

  // State 2: logged out, but tagged in no public list at all.
  it('renders nothing when logged out but tagged in no public list', () => {
    const html = renderToStaticMarkup(<TaggedInHint taggedIn={[]} session={null} />)
    expect(html).toBe('')
  })

  // State 3: logged in — owner or not, the hint disappears either way, even
  // though the same taggedIn data would have triggered it while logged out.
  it('renders nothing once logged in, regardless of who', () => {
    const html = renderToStaticMarkup(<TaggedInHint taggedIn={[oneTag]} session={OTHER_SESSION} />)
    expect(html).toBe('')
  })
})

// useSession()'s useSyncExternalStore reads its SERVER snapshot (`() => null`)
// under renderToStaticMarkup — see router.tsx's useRoute for the same pattern —
// so every page render in this harness is necessarily the logged-out view.
// These are smoke tests for the anonymous path; the logged-in panels (Your
// lists, Invites, owner controls) are exercised by hand per the task brief
// and by the e2e suite, matching how Account.tsx/TagDetail.tsx have no
// full-page render test here either.
describe('Tags hub — smoke render (logged out)', () => {
  it('renders the Hydration Tags hero and at least one (unclickable) public-list row', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['lists'], MOCK_LISTS)
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><Tags /></QueryClientProvider>)
    expect(html).toContain('Tags')
    // The one clickable "list" row: the built-in directory, promoted above
    // every user-made list.
    expect(html).toContain('Hydration Tags')
    expect(hrefOf(html, 'Hydration Tags')).toBe('/tags/hydration')
    expect(html).toContain('DeFi desks')
    // User-confirmed: a public list row is clickable only when the VIEWER
    // owns it — logged out (this harness's every render, see the comment
    // above this describe block), that's never true, so no anchor wraps the
    // name here (only the nested owner pill and the subscribe button are).
    // The owned case is session-dependent and covered by e2e instead (see
    // login-lists.spec.ts's "an owned public list links to its detail page").
    expect(hrefOf(html, 'DeFi desks')).toBeUndefined()
    // Logged out: no reorder/new-list affordances, but a real Subscribe
    // button (C12) — same appearance as the logged-in one, opening the login
    // dialog instead of a dead "log in first" prompt.
    expect(html).not.toContain('New list')
    expect(html).toContain('Subscribe')
    expect(html).not.toContain('Log in to subscribe')
  })
})

describe('Lists — smoke render (logged out)', () => {
  it('gates Your lists behind a log-in prompt, but public lists stay browsable/subscribable like /tags', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['lists'], MOCK_LISTS)
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><Lists /></QueryClientProvider>)
    expect(html).toContain('Lists')
    expect(html).toMatch(/log in/i)
    // Owned-list management stays gated: no reorder/new-list affordances.
    expect(html).not.toContain('New list')
    // New user request: public lists are no longer Tags-hub-only — the same
    // browsable/subscribable table (PublicListsPanel) now renders here too,
    // logged out included, with a real Subscribe button (C12) rather than a
    // dead "log in first" prompt.
    expect(html).toContain('Public lists')
    expect(html).toContain('DeFi desks')
    expect(html).toContain('Subscribe')
    expect(html).not.toContain('Log in to subscribe')
  })
})

describe('ListDetail — smoke render (logged out)', () => {
  it('shows another user\'s list as statistics only — never its tags or members', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // The public endpoint ships no tag contents for a foreign list — only
    // the summary statistics. Mirror that shape here.
    queryClient.setQueryData(['list', 'defi-desks', false], { ...MOCK_LIST_DETAIL, tags: [] })
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><ListDetail listId="defi-desks" /></QueryClientProvider>)
    expect(html).toContain('DeFi desks')
    // No "· list" suffix and no decorative avatar/icon block next to the name.
    expect(html).not.toContain('· list')
    expect(html).not.toContain('acct-avatar')
    // Statistics panel, not tag panels.
    expect(html).toContain('list-stats')
    expect(html).toContain('Subscriber')
    expect(html).not.toContain('Active traders')
    // Anonymous viewer: no owner-only affordances.
    expect(html).not.toContain('New tag')
    expect(html).not.toContain('Remove')
    // C12: a public list shows a real Subscribe button even logged out —
    // same appearance as the logged-in one (`>Subscribe<` pins the button's
    // own text node, not the "Subscriber" stat label above, which contains
    // "Subscribe" as a substring).
    expect(html).toContain('>Subscribe<')
  })

  // C4: the visibility badge is always public/private — `isPersonal` (an
  // auto-created, non-deletable list, unrelated to who can see it) used to
  // render a THIRD "personal" chip value here, which read as if the list
  // were neither public nor private even though it's a plain public one.
  it('never shows a "personal" badge, even for the personal list — only public/private', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['list', 'defi-desks', false], { ...MOCK_LIST_DETAIL, tags: [], isPersonal: true })
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><ListDetail listId="defi-desks" /></QueryClientProvider>)
    expect(html).toContain('>public<')
    expect(html).not.toContain('personal')
  })
})

// The aggregate view has no anonymous form at all — useSession()'s SSR snapshot
// is always null here (see the file-level comment above), so this necessarily
// renders the logged-out branch. A seeded query cache proves that branch takes
// priority over any (unreachable, since the query is session-gated) data rather
// than crashing trying to read it.
describe('ListTagDetail — smoke render (logged out)', () => {
  it('hints to log in instead of showing "not found" or the tag data', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['list-tag', 'personal', 'personal-watch'], MOCK_LIST_TAG_DETAIL)
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><ListTagDetail listId="personal" tagId="personal-watch" /></QueryClientProvider>)
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

  it('routes to ListTagDetail once the map is ready and hits — not TagDetail\'s own anonymous hint', () => {
    setTagMap({ lists: [
      { listId: 'lib1', name: 'Personal', tags: [{ tagId: USER_TAG_ID, name: 'Mine', color: '#0f0', icon: '', members: [ACC] }] },
    ] })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><TagDetail tagId={USER_TAG_ID} /></QueryClientProvider>)
    // ListTagDetail itself still gates on a real session (useSession() is
    // always null under this SSR harness — see the file-level comment above),
    // so this can't reach the tag's real content here; it CAN prove routing
    // got past TagDetail's own anonymous-UUID hint (a real "Log in" BUTTON,
    // absent from ListTagDetail's own plain-text one) into ListTagDetail
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
