import type { Page, Route } from '@playwright/test'
import { expect, test as base } from '@playwright/test'
import { mockSync } from '../../tests/fixtures/mockApi'
import type {
  AccountRef, ListDetailResponse, ListTagDetail, ListSummaryRef, MeResponse, TagMapResponse, TagDetail,
} from '../../src/types'

// The wallet-login identity every mock session resolves to, and the bearer
// token `/user/auth/verify` hands back for it — fixed strings so a spec can
// seed `localStorage['explorer-session']` directly (skip the wallet dialog
// for tests that only need to already be logged in) and still line up with
// whatever `userMock`'s own auth check expects.
export const E2E_ADDRESS = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'
export const E2E_TOKEN = 'e2e-session-token'
const E2E_NONCE = 'e2e-nonce'
const SESSION_STORAGE_KEY = 'explorer-session'

function freshAccount(): AccountRef {
  return { accountId: E2E_ADDRESS, address: E2E_ADDRESS, emoji: '🧪', tag: null, identity: null, profile: { name: 'E2E User', avatarVersion: 0 } }
}

// A plain address the real service has never seen becomes exactly this shape
// server-side too: an account ref with nothing beyond the address itself —
// no tag, no identity, no profile. Good enough for "does a member row
// appear", which is all the list-management flow checks.
function accountRefFromAddress(address: string): AccountRef {
  return { accountId: address, address, emoji: '👤', tag: null }
}

// A deterministic way to make one address in an add() batch fail, standing in
// for the real service's address validation (checksums etc. aren't worth
// reproducing here) — exercises the tag member editor's sequential-submit,
// name-the-failure, restore-the-rest path against a real rejection.
export const INVALID_TAG_MEMBER_ADDRESS = 'not-a-real-address'

// Best-effort mirror of the real tagDisplayIcon fallback (explicit icon →
// first member's emoji/emojiUrl → 🏷️) — the mock has no profile-avatar
// simulation, so it never derives a URL, but every mutation path below
// recomputes this so `displayIcon` is always a valid non-empty string
// wherever the real API would ship one (TagIcon renders it unconditionally).
function mockDisplayIcon(icon: string, members: AccountRef[]): string {
  if (icon) return icon
  const first = members[0]
  return (first && (first.emojiUrl || first.emoji)) || '🏷️'
}

// Mirrors compareTagRefsByName (api/src/routes/user.ts): the real
// listDetailResponse always serves tags alphabetically, case-insensitive,
// tagId-tiebroken — never creation order. `lib.tags` here is pushed to in
// creation order (see the create-tag handler below), so a GET that skipped
// this would let a spec's "tags come back alphabetical" assertion pass for
// the wrong reason (a mock that happens to insert in order) instead of the
// real one (the server actively re-sorts).
function sortedTags(tags: ListTagDetail[]): ListTagDetail[] {
  return [...tags].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.tagId.localeCompare(b.tagId))
}

// A subscription entry may optionally carry the same tag/member detail an
// owned list does — a subscribed (not owned) list's tags are still
// real, curated by ITS owner, and a spec exercising the aggregate view of a
// subscribed tag (e.g. the provenance pill for a non-owner viewer) needs
// somewhere to seed them. Optional so the many specs that only need the
// plain summary (subscribe/unsubscribe, Discover rows) don't have to fill it in.
export type MockListEntry = ListSummaryRef & { tags?: ListTagDetail[] }

// Per-test mutable backing store for everything under `/api/user/**`. Kept
// intentionally small (no ClickHouse, no real ids) — `lists`/`tagMap` are
// the two a spec actually reaches into; the rest exists so the full
// `userApi` surface has somewhere to read from and write to without 404ing.
export interface UserMockState {
  loggedIn: boolean
  account: AccountRef
  lists: ListDetailResponse[]
  subscriptions: MockListEntry[]
  invites: ListSummaryRef[]
  order: string[]
  tagMap: TagMapResponse
  // Per-tag override merged onto a list tag's own `?summary=1` response (the
  // accounts directory's fold, and HoverCard, both read this endpoint) — the
  // plain buildListTagDetail() below always answers zeroed-out numbers, which
  // is fine for every OTHER spec (none read them), but a spec proving the
  // fold shows a real aggregate value needs the summary to carry one. Keyed
  // `${listId}:${tagId}` so two folds in one spec can't collide.
  listTagSummaryOverrides: Record<string, Partial<TagDetail>>
}

function freshState(): UserMockState {
  return {
    loggedIn: false,
    account: freshAccount(),
    lists: [],
    subscriptions: [],
    invites: [],
    order: [],
    tagMap: { lists: [{ listId: 'system', name: 'Hydration', tags: [] }] },
    listTagSummaryOverrides: {},
  }
}

// A list tag's own aggregate view, built from either an OWNED list
// (`state.lists`) or a SUBSCRIBED one that was seeded with tag detail
// (`state.subscriptions`, see MockListEntry) — so a tag created/edited
// through the UI, or a subscribed foreign list's tag, is immediately
// reachable at its own aggregate URL too. Feeds (activity/extrinsics/events/
// votes/value-events) answer empty elsewhere in this handler; only the detail
// needs the tag's real presentation fields and members.
function buildListTagDetail(state: UserMockState, listId: string, tagId: string): TagDetail | null {
  const lib = state.lists.find(l => l.listId === listId) ?? state.subscriptions.find(l => l.listId === listId)
  const tag = lib?.tags?.find(t => t.tagId === tagId)
  if (!tag) return null
  return {
    // The aggregate view is display-only — mirror the real API's
    // visibleTagMembers and ship the DERIVED icon under `icon` here.
    tagId: tag.tagId, name: tag.name, color: tag.color, note: tag.note, icon: tag.displayIcon,
    members: tag.members, balances: [], topAssets: [], portfolioUsd: 0,
    moneyMarket: [], liquidityPositions: [], activeDcas: [], portfolioSeries: [], portfolioDates: [], balanceHistory: [],
  }
}

function buildMe(state: UserMockState): MeResponse {
  return {
    account: state.account,
    profile: state.account.profile ?? null,
    lists: state.lists,
    subscriptions: state.subscriptions,
    invites: state.invites,
    order: state.order,
  }
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

// Best-effort JSON body — GET/DELETE requests usually carry none, and a
// missing/empty body must read as `{}` rather than throw.
function bodyOf(route: Route): Record<string, unknown> {
  try { return (route.request().postDataJSON() as Record<string, unknown>) ?? {} }
  catch { return {} }
}

// Handles every `userApi` call (`explorer-ui/src/api/explorer.ts`) against
// `state`, mirroring the real `/user/**` routes closely enough for the UI's
// own mutate → invalidate → refetch cycle to show real results: a created
// list is there on the next `GET /user/lists/:id`, a reordered list
// is there on the next `GET /user/me`, and so on. Auth is deliberately dumb —
// any signature verifies, and the only thing gating a request past the
// challenge/verify/logout routes is `state.loggedIn` plus the fixed bearer
// token — the wallet-signature math itself is proven by the api's own unit
// tests, not by this fixture.
async function handleUserApi(state: UserMockState, route: Route): Promise<void> {
  const request = route.request()
  const method = request.method()
  const url = new URL(request.url())
  const path = url.pathname.replace(/^\/api/, '')

  if (method === 'POST' && path === '/user/auth/challenge') {
    const { address } = bodyOf(route) as { address: string }
    await fulfillJson(route, 200, { nonce: E2E_NONCE, message: `Sign in to Hydration Explorer\naddress: ${address}\nnonce: ${E2E_NONCE}` })
    return
  }
  if (method === 'POST' && path === '/user/auth/verify') {
    const { address } = bodyOf(route) as { address: string }
    state.loggedIn = true
    state.account = { ...state.account, accountId: address, address }
    await fulfillJson(route, 200, { token: E2E_TOKEN, me: buildMe(state) })
    return
  }
  if (method === 'POST' && path === '/user/auth/logout') {
    state.loggedIn = false
    await fulfillJson(route, 200, { ok: true })
    return
  }

  // Every other route needs a live session: the fixed bearer token AND
  // `state.loggedIn` (so a real `logout()` — or a spec that never seeded a
  // session — actually gates access, not just an unrotated constant token).
  const auth = await request.headerValue('authorization')
  if (!state.loggedIn || auth !== `Bearer ${E2E_TOKEN}`) {
    await fulfillJson(route, 401, { error: 'Unauthorized' })
    return
  }

  if (method === 'GET' && path === '/user/me') { await fulfillJson(route, 200, buildMe(state)); return }
  if (method === 'GET' && path === '/user/tag-map') { await fulfillJson(route, 200, state.tagMap); return }
  if (method === 'GET' && path === '/user/invites') { await fulfillJson(route, 200, state.invites); return }

  if (method === 'PUT' && path === '/user/profile') {
    const { name } = bodyOf(route) as { name: string }
    state.account.profile = { name, avatarVersion: state.account.profile?.avatarVersion ?? 0 }
    await fulfillJson(route, 200, state.account.profile)
    return
  }
  if (method === 'PUT' && path === '/user/profile/avatar') {
    state.account.profile = { name: state.account.profile?.name ?? '', avatarVersion: (state.account.profile?.avatarVersion ?? 0) + 1 }
    await fulfillJson(route, 200, state.account.profile)
    return
  }
  if (method === 'DELETE' && path === '/user/profile/avatar') {
    state.account.profile = { name: state.account.profile?.name ?? '', avatarVersion: 0 }
    await fulfillJson(route, 200, state.account.profile)
    return
  }

  let m: RegExpMatchArray | null

  if (method === 'GET' && (m = path.match(/^\/user\/lists\/([^/]+)$/))) {
    const lib = state.lists.find(l => l.listId === decodeURIComponent(m![1]))
    if (lib) await fulfillJson(route, 200, { ...lib, tags: sortedTags(lib.tags) })
    else await fulfillJson(route, 404, { error: 'not found' })
    return
  }
  if (method === 'POST' && path === '/user/lists') {
    const { name, note, visibility } = bodyOf(route) as { name: string; note?: string; visibility?: 'private' | 'public' }
    const listId = `list-${state.lists.length + 1}`
    const lib: ListDetailResponse = {
      listId, name, note: note ?? '', visibility: visibility ?? 'private', isPersonal: false,
      owner: state.account, tagCount: 0, accountCount: 0, subscriberCount: 0, tags: [],
    }
    state.lists.push(lib)
    state.order.push(listId)
    await fulfillJson(route, 200, lib)
    return
  }
  if (method === 'PATCH' && (m = path.match(/^\/user\/lists\/([^/]+)$/))) {
    const lib = state.lists.find(l => l.listId === decodeURIComponent(m![1]))
    if (!lib) { await fulfillJson(route, 404, { error: 'not found' }); return }
    const body = bodyOf(route) as { name?: string; note?: string; visibility?: 'private' | 'public' }
    if (body.name != null) lib.name = body.name
    if (body.note != null) lib.note = body.note
    if (body.visibility != null) lib.visibility = body.visibility
    await fulfillJson(route, 200, lib)
    return
  }
  if (method === 'DELETE' && (m = path.match(/^\/user\/lists\/([^/]+)$/))) {
    const id = decodeURIComponent(m![1])
    state.lists = state.lists.filter(l => l.listId !== id)
    state.order = state.order.filter(o => o !== id)
    await fulfillJson(route, 200, { ok: true })
    return
  }

  if (method === 'POST' && (m = path.match(/^\/user\/lists\/([^/]+)\/tags$/))) {
    const lib = state.lists.find(l => l.listId === decodeURIComponent(m![1]))
    if (!lib) { await fulfillJson(route, 404, { error: 'not found' }); return }
    const { name, color, icon, note } = bodyOf(route) as { name: string; color?: string; icon?: string; note?: string }
    const tag: ListTagDetail = {
      tagId: `tag-${lib.tags.length + 1}`, name, color: color ?? '#5865f2',
      icon: icon ?? '', displayIcon: mockDisplayIcon(icon ?? '', []), note: note ?? '', members: [],
    }
    lib.tags.push(tag)
    lib.tagCount = lib.tags.length
    await fulfillJson(route, 200, tag)
    return
  }
  if (method === 'PATCH' && (m = path.match(/^\/user\/lists\/([^/]+)\/tags\/([^/]+)$/))) {
    const lib = state.lists.find(l => l.listId === decodeURIComponent(m![1]))
    const tag = lib?.tags.find(t => t.tagId === decodeURIComponent(m![2]))
    if (!tag) { await fulfillJson(route, 404, { error: 'not found' }); return }
    const body = bodyOf(route) as { name?: string; color?: string; icon?: string; note?: string }
    if (body.name != null) tag.name = body.name
    if (body.color != null) tag.color = body.color
    // The edit form seeds from and resubmits the RAW `icon` (never
    // `displayIcon`) — mirrors the real updateTag route, which is exactly
    // the bug this shape split fixed.
    if (body.icon != null) tag.icon = body.icon
    if (body.note != null) tag.note = body.note
    tag.displayIcon = mockDisplayIcon(tag.icon, tag.members)
    await fulfillJson(route, 200, tag)
    return
  }
  if (method === 'DELETE' && (m = path.match(/^\/user\/lists\/([^/]+)\/tags\/([^/]+)$/))) {
    const lib = state.lists.find(l => l.listId === decodeURIComponent(m![1]))
    if (lib) { lib.tags = lib.tags.filter(t => t.tagId !== decodeURIComponent(m![2])); lib.tagCount = lib.tags.length }
    await fulfillJson(route, 200, { ok: true })
    return
  }
  if (method === 'PUT' && (m = path.match(/^\/user\/lists\/([^/]+)\/tags\/([^/]+)\/members$/))) {
    const lib = state.lists.find(l => l.listId === decodeURIComponent(m![1]))
    const tag = lib?.tags.find(t => t.tagId === decodeURIComponent(m![2]))
    if (!lib || !tag) { await fulfillJson(route, 404, { error: 'not found' }); return }
    const { add, remove } = bodyOf(route) as { add?: string[]; remove?: string[] }
    if ((add ?? []).includes(INVALID_TAG_MEMBER_ADDRESS)) { await fulfillJson(route, 400, { error: 'not a recognized address' }); return }
    for (const addr of remove ?? []) tag.members = tag.members.filter(mm => mm.address !== addr)
    for (const addr of add ?? []) if (!tag.members.some(mm => mm.address === addr)) tag.members.push(accountRefFromAddress(addr))
    lib.accountCount = new Set(lib.tags.flatMap(t => t.members.map(mm => mm.accountId))).size
    tag.displayIcon = mockDisplayIcon(tag.icon, tag.members)
    await fulfillJson(route, 200, tag)
    return
  }
  if (method === 'PUT' && (m = path.match(/^\/user\/lists\/([^/]+)\/tags\/([^/]+)\/member-order$/))) {
    const lib = state.lists.find(l => l.listId === decodeURIComponent(m![1]))
    const tag = lib?.tags.find(t => t.tagId === decodeURIComponent(m![2]))
    if (!lib || !tag) { await fulfillJson(route, 404, { error: 'not found' }); return }
    const { accountIds } = bodyOf(route) as { accountIds?: string[] }
    const ids = accountIds ?? []
    const current = new Set(tag.members.map(mm => mm.accountId))
    const isPermutation = ids.length === current.size && new Set(ids).size === ids.length && ids.every(id => current.has(id))
    if (!isPermutation) { await fulfillJson(route, 400, { error: 'Member order must list every current member exactly once' }); return }
    const byId = new Map(tag.members.map(mm => [mm.accountId, mm]))
    tag.members = ids.map(id => byId.get(id)!)
    tag.displayIcon = mockDisplayIcon(tag.icon, tag.members)   // "first member" can change on reorder
    await fulfillJson(route, 200, tag)
    return
  }

  // Subscribers tab (C10): `shares` lives directly on the mock's own
  // ListDetailResponse object (like `tags`), mutated in place so the tab's
  // mutate → invalidate → refetch cycle sees a real result on the next GET,
  // same pattern setTagMembers above uses for a tag's own member list.
  if (method === 'POST' && (m = path.match(/^\/user\/lists\/([^/]+)\/invites$/))) {
    const lib = state.lists.find(l => l.listId === decodeURIComponent(m![1]))
    if (!lib) { await fulfillJson(route, 404, { error: 'not found' }); return }
    const { address } = bodyOf(route) as { address: string }
    if (address === INVALID_TAG_MEMBER_ADDRESS) { await fulfillJson(route, 400, { error: 'not a recognized address' }); return }
    lib.shares = lib.shares ?? []
    const existing = lib.shares.find(s => s.account.address === address)
    if (existing) existing.status = 'invited'
    else lib.shares.push({ account: accountRefFromAddress(address), status: 'invited' })
    await fulfillJson(route, 200, { ok: true })
    return
  }
  if (method === 'DELETE' && (m = path.match(/^\/user\/lists\/([^/]+)\/invites\/([^/]+)$/))) {
    const lib = state.lists.find(l => l.listId === decodeURIComponent(m![1]))
    if (lib) lib.shares = (lib.shares ?? []).filter(s => s.account.address !== decodeURIComponent(m![2]))
    await fulfillJson(route, 200, { ok: true })
    return
  }
  if (method === 'POST' && (m = path.match(/^\/user\/invites\/([^/]+)\/(accept|decline)$/))) {
    const id = decodeURIComponent(m![1])
    const invite = state.invites.find(i => i.listId === id)
    state.invites = state.invites.filter(i => i.listId !== id)
    if (invite && m![2] === 'accept') state.subscriptions.push(invite)
    await fulfillJson(route, 200, { ok: true })
    return
  }
  if (method === 'POST' && path === '/user/subscriptions') {
    // No public-list catalogue lives in this store; a spec that needs a
    // real subscribed row pushes it into `state.subscriptions` directly.
    await fulfillJson(route, 200, { ok: true })
    return
  }
  if (method === 'DELETE' && (m = path.match(/^\/user\/subscriptions\/([^/]+)$/))) {
    state.subscriptions = state.subscriptions.filter(l => l.listId !== decodeURIComponent(m![1]))
    await fulfillJson(route, 200, { ok: true })
    return
  }
  if (method === 'PUT' && path === '/user/list-order') {
    const { listIds } = bodyOf(route) as { listIds: string[] }
    state.order = listIds
    await fulfillJson(route, 200, { order: state.order })
    return
  }

  // A list tag's own aggregate page. Deterministic empty feeds are enough to
  // prove the page renders (the computation itself is the real API's concern,
  // covered by api/tests/listTagRoutes.test.ts) — only the detail needs real
  // tag data, from buildListTagDetail above.
  if (method === 'GET' && (m = path.match(/^\/user\/list-tag\/([^/]+)\/([^/]+)\/counts$/))) {
    await fulfillJson(route, 200, { extrinsics: 0, extrinsicsOnBehalf: 0, events: 0, votes: 0 })
    return
  }
  if (method === 'GET' && (m = path.match(/^\/user\/list-tag\/([^/]+)\/([^/]+)\/list-count$/))) {
    await fulfillJson(route, 200, { total: 0, complete: true })
    return
  }
  if (method === 'GET' && (m = path.match(/^\/user\/list-tag\/([^/]+)\/([^/]+)\/(?:activity|extrinsics|events|votes|value-events)$/))) {
    await fulfillJson(route, 200, [])
    return
  }
  if (method === 'GET' && (m = path.match(/^\/user\/list-tag\/([^/]+)\/([^/]+)$/))) {
    const listId = decodeURIComponent(m[1]), tagId = decodeURIComponent(m[2])
    const detail = buildListTagDetail(state, listId, tagId)
    if (!detail) { await fulfillJson(route, 404, { error: 'not found' }); return }
    const isSummary = url.searchParams.get('summary') === '1'
    const override = isSummary ? state.listTagSummaryOverrides[`${listId}:${tagId}`] : undefined
    await fulfillJson(route, 200, override ? { ...detail, ...override } : detail)
    return
  }

  await fulfillJson(route, 404, { error: `No user-mock route for ${method} ${path}` })
}

// Seeds an already-logged-in session for specs that only need to exercise
// what happens AFTER login (tag resolution, list management) — the wallet
// dialog itself is covered once, end to end, by the login spec. Must run via
// `page.addInitScript` (before any app code reads `localStorage`) and keep
// `userMock`'s own `state.loggedIn` in sync, since `handleUserApi` gates
// every non-auth route on both the token and that flag.
export async function seedSession(page: Page, userMock: { state: UserMockState }): Promise<void> {
  userMock.state.loggedIn = true
  await page.addInitScript(
    ([key, session]) => { window.localStorage.setItem(key, JSON.stringify(session)) },
    [SESSION_STORAGE_KEY, { token: E2E_TOKEN, accountId: userMock.state.account.accountId, address: userMock.state.account.address }] as [string, { token: string; accountId: string; address: string }],
  )
}

export const test = base.extend<{ mockApi: void; userMock: { state: UserMockState }; injectedWallet: void }>({
  mockApi: [async ({ page }, use) => {
    // Anchor the matcher at the origin root. A broad `**/api/**` glob also
    // catches Vite source modules such as `/src/api/explorer.ts`.
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      if (route.request().method() !== 'GET') {
        await route.fallback()
        return
      }

      const url = new URL(route.request().url())
      const path = `${url.pathname.replace(/^\/api/, '')}${url.search}`
      const response = mockSync<unknown>(path)
      if (response === undefined) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: `No test fixture for ${path}` }),
        })
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response),
      })
    })
    await use()
  }, { auto: true }],

  // Opt-in: only specs that log in need it. Depends on `mockApi` so its own
  // `/api/user/**` route registers AFTER `mockApi`'s broad `/api` one —
  // Playwright checks the most-recently-registered matching route first, so
  // this fixture's handler wins for `/user/**` and `route.fallback()`s
  // (unused here, since it owns every `/user/**` method) would otherwise
  // fall through to `mockApi`'s GET-only handling underneath it.
  userMock: [async ({ page, mockApi }, use) => {
    void mockApi // dependency only — guarantees this route registers (and so wins) after mockApi's
    const state = freshState()
    await page.route(/^https?:\/\/[^/]+\/api\/user(?:\/|$)/, route => handleUserApi(state, route))
    await use({ state })
  }, { auto: false }],

  // Installs the brief's wallet stub before any app code runs, so
  // `listSubstrateWallets()` sees `polkadot-js` as installed on the very
  // first render.
  injectedWallet: [async ({ page }, use) => {
    await page.addInitScript(() => {
      (window as unknown as { injectedWeb3: unknown }).injectedWeb3 = {
        'polkadot-js': {
          enable: async () => ({
            accounts: { get: async () => [{ address: '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ', name: 'E2E' }] },
            signer: { signRaw: async () => ({ signature: '0x' + 'ab'.repeat(64) }) },
          }),
        },
      }
    })
    await use()
  }, { auto: false }],
})

export { expect }
