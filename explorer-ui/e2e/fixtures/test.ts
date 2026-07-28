import type { Page, Route } from '@playwright/test'
import { expect, test as base } from '@playwright/test'
import { mockSync } from '../../tests/fixtures/mockApi'
import type {
  AccountRef, LibraryDetailResponse, LibraryTagDetail, LibrarySummaryRef, MeResponse, TagMapResponse, TagDetail,
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
// appear", which is all the library-management flow checks.
function accountRefFromAddress(address: string): AccountRef {
  return { accountId: address, address, emoji: '👤', tag: null }
}

// A deterministic way to make one address in an add() batch fail, standing in
// for the real service's address validation (checksums etc. aren't worth
// reproducing here) — exercises the tag member editor's sequential-submit,
// name-the-failure, restore-the-rest path against a real rejection.
export const INVALID_TAG_MEMBER_ADDRESS = 'not-a-real-address'

// A subscription entry may optionally carry the same tag/member detail an
// owned library does — a subscribed (not owned) library's tags are still
// real, curated by ITS owner, and a spec exercising the aggregate view of a
// subscribed tag (e.g. the provenance pill for a non-owner viewer) needs
// somewhere to seed them. Optional so the many specs that only need the
// plain summary (subscribe/unsubscribe, Discover rows) don't have to fill it in.
export type MockLibraryEntry = LibrarySummaryRef & { tags?: LibraryTagDetail[] }

// Per-test mutable backing store for everything under `/api/user/**`. Kept
// intentionally small (no ClickHouse, no real ids) — `libraries`/`tagMap` are
// the two a spec actually reaches into; the rest exists so the full
// `userApi` surface has somewhere to read from and write to without 404ing.
export interface UserMockState {
  loggedIn: boolean
  account: AccountRef
  libraries: LibraryDetailResponse[]
  subscriptions: MockLibraryEntry[]
  invites: LibrarySummaryRef[]
  order: string[]
  tagMap: TagMapResponse
}

function freshState(): UserMockState {
  return {
    loggedIn: false,
    account: freshAccount(),
    libraries: [],
    subscriptions: [],
    invites: [],
    order: [],
    tagMap: { libraries: [{ libraryId: 'system', name: 'Hydration', tags: [] }] },
  }
}

// A library tag's own aggregate view, built from either an OWNED library
// (`state.libraries`) or a SUBSCRIBED one that was seeded with tag detail
// (`state.subscriptions`, see MockLibraryEntry) — so a tag created/edited
// through the UI, or a subscribed foreign library's tag, is immediately
// reachable at its own aggregate URL too. Feeds (activity/extrinsics/events/
// votes/value-events) answer empty elsewhere in this handler; only the detail
// needs the tag's real presentation fields and members.
function buildLibraryTagDetail(state: UserMockState, libraryId: string, tagId: string): TagDetail | null {
  const lib = state.libraries.find(l => l.libraryId === libraryId) ?? state.subscriptions.find(l => l.libraryId === libraryId)
  const tag = lib?.tags?.find(t => t.tagId === tagId)
  if (!tag) return null
  return {
    tagId: tag.tagId, name: tag.name, color: tag.color, note: tag.note, icon: tag.icon,
    members: tag.members, balances: [], topAssets: [], portfolioUsd: 0,
    moneyMarket: [], liquidityPositions: [], activeDcas: [], portfolioSeries: [], portfolioDates: [], balanceHistory: [],
  }
}

function buildMe(state: UserMockState): MeResponse {
  return {
    account: state.account,
    profile: state.account.profile ?? null,
    libraries: state.libraries,
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
// library is there on the next `GET /user/libraries/:id`, a reordered list
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

  if (method === 'GET' && (m = path.match(/^\/user\/libraries\/([^/]+)$/))) {
    const lib = state.libraries.find(l => l.libraryId === decodeURIComponent(m![1]))
    if (lib) await fulfillJson(route, 200, lib)
    else await fulfillJson(route, 404, { error: 'not found' })
    return
  }
  if (method === 'POST' && path === '/user/libraries') {
    const { name, note, visibility } = bodyOf(route) as { name: string; note?: string; visibility?: 'private' | 'public' }
    const libraryId = `lib-${state.libraries.length + 1}`
    const lib: LibraryDetailResponse = {
      libraryId, name, note: note ?? '', visibility: visibility ?? 'private', isPersonal: false,
      owner: state.account, tagCount: 0, accountCount: 0, subscriberCount: 0, tags: [],
    }
    state.libraries.push(lib)
    state.order.push(libraryId)
    await fulfillJson(route, 200, lib)
    return
  }
  if (method === 'PATCH' && (m = path.match(/^\/user\/libraries\/([^/]+)$/))) {
    const lib = state.libraries.find(l => l.libraryId === decodeURIComponent(m![1]))
    if (!lib) { await fulfillJson(route, 404, { error: 'not found' }); return }
    const body = bodyOf(route) as { name?: string; note?: string; visibility?: 'private' | 'public' }
    if (body.name != null) lib.name = body.name
    if (body.note != null) lib.note = body.note
    if (body.visibility != null) lib.visibility = body.visibility
    await fulfillJson(route, 200, lib)
    return
  }
  if (method === 'DELETE' && (m = path.match(/^\/user\/libraries\/([^/]+)$/))) {
    const id = decodeURIComponent(m![1])
    state.libraries = state.libraries.filter(l => l.libraryId !== id)
    state.order = state.order.filter(o => o !== id)
    await fulfillJson(route, 200, { ok: true })
    return
  }

  if (method === 'POST' && (m = path.match(/^\/user\/libraries\/([^/]+)\/tags$/))) {
    const lib = state.libraries.find(l => l.libraryId === decodeURIComponent(m![1]))
    if (!lib) { await fulfillJson(route, 404, { error: 'not found' }); return }
    const { name, color, icon, note } = bodyOf(route) as { name: string; color?: string; icon?: string; note?: string }
    const tag: LibraryTagDetail = { tagId: `tag-${lib.tags.length + 1}`, name, color: color ?? '#5865f2', icon: icon ?? '', note: note ?? '', members: [] }
    lib.tags.push(tag)
    lib.tagCount = lib.tags.length
    await fulfillJson(route, 200, tag)
    return
  }
  if (method === 'PATCH' && (m = path.match(/^\/user\/libraries\/([^/]+)\/tags\/([^/]+)$/))) {
    const lib = state.libraries.find(l => l.libraryId === decodeURIComponent(m![1]))
    const tag = lib?.tags.find(t => t.tagId === decodeURIComponent(m![2]))
    if (!tag) { await fulfillJson(route, 404, { error: 'not found' }); return }
    const body = bodyOf(route) as { name?: string; color?: string; icon?: string; note?: string }
    if (body.name != null) tag.name = body.name
    if (body.color != null) tag.color = body.color
    if (body.icon != null) tag.icon = body.icon
    if (body.note != null) tag.note = body.note
    await fulfillJson(route, 200, tag)
    return
  }
  if (method === 'DELETE' && (m = path.match(/^\/user\/libraries\/([^/]+)\/tags\/([^/]+)$/))) {
    const lib = state.libraries.find(l => l.libraryId === decodeURIComponent(m![1]))
    if (lib) { lib.tags = lib.tags.filter(t => t.tagId !== decodeURIComponent(m![2])); lib.tagCount = lib.tags.length }
    await fulfillJson(route, 200, { ok: true })
    return
  }
  if (method === 'PUT' && (m = path.match(/^\/user\/libraries\/([^/]+)\/tags\/([^/]+)\/members$/))) {
    const lib = state.libraries.find(l => l.libraryId === decodeURIComponent(m![1]))
    const tag = lib?.tags.find(t => t.tagId === decodeURIComponent(m![2]))
    if (!lib || !tag) { await fulfillJson(route, 404, { error: 'not found' }); return }
    const { add, remove } = bodyOf(route) as { add?: string[]; remove?: string[] }
    if ((add ?? []).includes(INVALID_TAG_MEMBER_ADDRESS)) { await fulfillJson(route, 400, { error: 'not a recognized address' }); return }
    for (const addr of remove ?? []) tag.members = tag.members.filter(mm => mm.address !== addr)
    for (const addr of add ?? []) if (!tag.members.some(mm => mm.address === addr)) tag.members.push(accountRefFromAddress(addr))
    lib.accountCount = new Set(lib.tags.flatMap(t => t.members.map(mm => mm.accountId))).size
    await fulfillJson(route, 200, tag)
    return
  }
  if (method === 'PUT' && (m = path.match(/^\/user\/libraries\/([^/]+)\/tags\/([^/]+)\/member-order$/))) {
    const lib = state.libraries.find(l => l.libraryId === decodeURIComponent(m![1]))
    const tag = lib?.tags.find(t => t.tagId === decodeURIComponent(m![2]))
    if (!lib || !tag) { await fulfillJson(route, 404, { error: 'not found' }); return }
    const { accountIds } = bodyOf(route) as { accountIds?: string[] }
    const ids = accountIds ?? []
    const current = new Set(tag.members.map(mm => mm.accountId))
    const isPermutation = ids.length === current.size && new Set(ids).size === ids.length && ids.every(id => current.has(id))
    if (!isPermutation) { await fulfillJson(route, 400, { error: 'Member order must list every current member exactly once' }); return }
    const byId = new Map(tag.members.map(mm => [mm.accountId, mm]))
    tag.members = ids.map(id => byId.get(id)!)
    await fulfillJson(route, 200, tag)
    return
  }

  if (method === 'POST' && (m = path.match(/^\/user\/libraries\/([^/]+)\/invites$/))) { await fulfillJson(route, 200, { ok: true }); return }
  if (method === 'DELETE' && (m = path.match(/^\/user\/libraries\/([^/]+)\/invites\/([^/]+)$/))) { await fulfillJson(route, 200, { ok: true }); return }
  if (method === 'POST' && (m = path.match(/^\/user\/invites\/([^/]+)\/(accept|decline)$/))) {
    const id = decodeURIComponent(m![1])
    const invite = state.invites.find(i => i.libraryId === id)
    state.invites = state.invites.filter(i => i.libraryId !== id)
    if (invite && m![2] === 'accept') state.subscriptions.push(invite)
    await fulfillJson(route, 200, { ok: true })
    return
  }
  if (method === 'POST' && path === '/user/subscriptions') {
    // No public-library catalogue lives in this store; a spec that needs a
    // real subscribed row pushes it into `state.subscriptions` directly.
    await fulfillJson(route, 200, { ok: true })
    return
  }
  if (method === 'DELETE' && (m = path.match(/^\/user\/subscriptions\/([^/]+)$/))) {
    state.subscriptions = state.subscriptions.filter(l => l.libraryId !== decodeURIComponent(m![1]))
    await fulfillJson(route, 200, { ok: true })
    return
  }
  if (method === 'PUT' && path === '/user/library-order') {
    const { libraryIds } = bodyOf(route) as { libraryIds: string[] }
    state.order = libraryIds
    await fulfillJson(route, 200, { order: state.order })
    return
  }

  // A library tag's own aggregate page. Deterministic empty feeds are enough to
  // prove the page renders (the computation itself is the real API's concern,
  // covered by api/tests/libraryTagRoutes.test.ts) — only the detail needs real
  // tag data, from buildLibraryTagDetail above.
  if (method === 'GET' && (m = path.match(/^\/user\/library-tag\/([^/]+)\/([^/]+)\/counts$/))) {
    await fulfillJson(route, 200, { extrinsics: 0, extrinsicsOnBehalf: 0, events: 0, votes: 0 })
    return
  }
  if (method === 'GET' && (m = path.match(/^\/user\/library-tag\/([^/]+)\/([^/]+)\/list-count$/))) {
    await fulfillJson(route, 200, { total: 0, complete: true })
    return
  }
  if (method === 'GET' && (m = path.match(/^\/user\/library-tag\/([^/]+)\/([^/]+)\/(?:activity|extrinsics|events|votes|value-events)$/))) {
    await fulfillJson(route, 200, [])
    return
  }
  if (method === 'GET' && (m = path.match(/^\/user\/library-tag\/([^/]+)\/([^/]+)$/))) {
    const detail = buildLibraryTagDetail(state, decodeURIComponent(m[1]), decodeURIComponent(m[2]))
    if (detail) await fulfillJson(route, 200, detail)
    else await fulfillJson(route, 404, { error: 'not found' })
    return
  }

  await fulfillJson(route, 404, { error: `No user-mock route for ${method} ${path}` })
}

// Seeds an already-logged-in session for specs that only need to exercise
// what happens AFTER login (tag resolution, library management) — the wallet
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
