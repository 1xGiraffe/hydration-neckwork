import type { Locator, Page } from '@playwright/test'
import { E2E_TOKEN, INVALID_TAG_MEMBER_ADDRESS, expect, seedSession, test } from './fixtures/test'
import type { UserMockState } from './fixtures/test'
import type { AccountRef } from '../src/types'

// Treasury's accountId, copied from `A.treasury` in tests/fixtures/mockApi.ts
// (the module account behind Hydration's Treasury pallet — not exported from
// there, so kept here as a literal). It already carries a system tag
// ("Treasury"), which is exactly what makes it a good login-flow target: a
// user tag can be shown outranking it, and removing the user tag must bring
// back that very same system tag, not nothing.
const TREASURY_ACCOUNT_ID = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'
// A recognizable EVM address (Binance's, from the same fixture file) to add
// as a tag member — any well-formed address works for the mock, but reusing
// one already meaningful elsewhere in the suite beats inventing a new one.
const BINANCE_ADDRESS = '0x2c1F9eB7a4D0c83E5f6A1b9D2c7E04aF8b3D16C9'
// A real user tag id is a UUID (userLibraryService mints them with
// randomUUID()) — TagDetail's routing treats that SHAPE as the signal that an
// id might be a user tag at all (see userTags.looksLikeUserTagId), so specs
// that navigate straight to a user tag's own /tag/:id page need an id that
// actually looks like one, not a short stand-in like 't1'.
const USER_TAG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

// Regression coverage for the account-picker dropdown fix: the diagnosed bug
// was a translucent background (var(--panel), meant for a wash over content —
// not a dropdown that needs to read as opaque) plus the containing `.panel`'s
// own corner-clipping `overflow: hidden` cutting the dropdown off wherever it
// pokes past the panel's edge. Exercised on both surfaces that host an
// AccountPicker (Invites, a tag's member editor) at both viewports.
//
// Checks the fix's two mechanisms directly rather than pixel geometry (how far
// the dropdown happens to extend past the panel's OTHER content varies with
// how many members/hint text a given panel has, so it isn't a stable signal;
// the computed styles are exactly what the CSS fix changed).
async function assertDropdownReadsLikeSearchDropdown(panel: Locator): Promise<void> {
  const dropdown = panel.locator('.acct-picker-results')
  await expect(dropdown).toBeVisible()

  const bg = await dropdown.evaluate(el => getComputedStyle(el).backgroundColor)
  // A translucent color always ends in ", <fraction>)"; the fix's solid
  // var(--bg-elev) never does (opaque rgb()/rgba(..., 1)).
  expect(bg).not.toMatch(/,\s*0(\.\d+)?\s*\)$/)

  // The panel's own corner-clipping overflow is lifted for exactly as long as
  // the dropdown it would otherwise clip is in the DOM (see
  // `.panel:has(.acct-picker-results)` in global.css) — this is what lets the
  // dropdown paint over the panel's edge instead of being cut off at it.
  const panelOverflow = await panel.evaluate(el => getComputedStyle(el).overflow)
  expect(panelOverflow).toBe('visible')
}

// The topbar's login control collapses into the burger/drawer below 860px
// (global.css's own breakpoint) — decide from the viewport Playwright is
// already configured with rather than probing DOM visibility, which would
// race the app's first render.
async function openConnectDialog(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? 1280
  if (width <= 860) {
    await page.locator('.nav-burger').click()
    await page.locator('.drawer-connect-btn').click()
  } else {
    await page.locator('.connect-btn').click()
  }
}

// Connect → wallet list shows the installed extension → pick the (only)
// account → the topbar resolves the mocked profile name and the session
// token lands in localStorage. Shared by the desktop and mobile variants
// below — the dialog's own contents don't depend on viewport, only how it's
// reached does.
async function loginFlow(page: Page): Promise<void> {
  await page.goto('/')
  await openConnectDialog(page)

  const walletRow = page.locator('.wallet-tile', { hasText: 'Polkadot{.js}' })
  await expect(walletRow).toContainText('Installed')
  await walletRow.click()

  await expect(page.locator('.account-btn .account-label')).toHaveText('E2E User')

  const stored = await page.evaluate(() => window.localStorage.getItem('explorer-session'))
  const session = stored ? (JSON.parse(stored) as { token?: string }) : null
  expect(session?.token).toBe(E2E_TOKEN)
}

test('connect a wallet and sign in', async ({ page, userMock, injectedWallet }) => {
  void userMock; void injectedWallet // fixtures wire the mocked auth + wallet stub; the flow itself is exercised below
  await loginFlow(page)
})

// Nova shares the 'polkadot-js' injected key (it acts as polkadot-js inside
// its own in-app browser) but gets a separate visual tile — distinct name,
// icon and install link — rather than folding into the Polkadot{.js} tile.
// Both must read "Installed" off the one stubbed extension, and either tile
// must be able to complete the same connect/sign flow.
test('Nova Wallet has its own tile and connects through the shared polkadot-js key', async ({ page, userMock, injectedWallet }) => {
  void userMock; void injectedWallet
  await page.goto('/')
  await openConnectDialog(page)

  const novaTile = page.locator('.wallet-tile', { hasText: 'Nova Wallet' })
  await expect(novaTile).toContainText('Installed')
  await novaTile.click()

  await expect(page.locator('.account-btn .account-label')).toHaveText('E2E User')
})

test('a user tag outranks the system tag, and the system tag returns on logout', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    libraries: [
      { libraryId: 'lib1', name: 'My library', tags: [
        { tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
      ] },
      { libraryId: 'system', name: 'Hydration', tags: [] },
    ],
  }

  await page.goto('/accounts')
  // Treasury is the fixture's account row with a $980k portfolio value — a
  // literal, deterministic amount in the mock (unlike every other row's
  // value, none of which contain "980") — so it locates the row without
  // depending on sort position.
  const row = page.locator('.accounts-tbl tbody tr', { has: page.locator('td[data-label="Value"]', { hasText: '980' }) })
  const pill = row.locator('a.addr-pill')
  await expect(pill).toContainText('Mine')
  // The tag's own aggregate view, sharing the system /tag/:id namespace.
  await expect(pill).toHaveAttribute('href', `/tag/${USER_TAG_ID}`)

  await page.locator('.account-btn').click()
  await page.locator('.account-menu button', { hasText: 'Log out' }).click()

  await expect(pill).toContainText('Treasury')
  await expect(pill).toHaveAttribute('href', '/tag/treasury')
})

// Regression coverage for HoverCard's tag/library-tag disambiguation: since
// user and system tags now share the plain /tag/:id href form, the hover
// card has to tell them apart the same way TagDetail's own routing does —
// via the viewer's tag map — rather than a URL shape unique to library tags.
test('hovering a user-tag pill shows its own aggregate card, not the system tag lookup', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    libraries: [
      { libraryId: 'lib1', name: 'My library', tags: [
        { tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
      ] },
      { libraryId: 'system', name: 'Hydration', tags: [] },
    ],
  }
  // The management-page shape of the same tag, so GET /user/library-tag/lib1/<id>
  // (the hover card's own summary request) has real data to answer with.
  userMock.state.libraries.push({
    libraryId: 'lib1', name: 'My library', note: '', visibility: 'private', isPersonal: false,
    owner: userMock.state.account, tagCount: 1, accountCount: 1, subscriberCount: 0,
    tags: [{
      tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', note: '',
      members: [{ accountId: TREASURY_ACCOUNT_ID, address: TREASURY_ACCOUNT_ID, emoji: '👤', tag: null }],
    }],
  })

  await page.goto('/accounts')
  const row = page.locator('.accounts-tbl tbody tr', { has: page.locator('td[data-label="Value"]', { hasText: '980' }) })
  await row.locator('a.addr-pill').hover()

  const card = page.locator('.hovercard')
  await expect(card).toContainText('Mine')
  await expect(card).toContainText('1 account')
})

test('a user-tag pill opens its own aggregate page, header included', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    libraries: [
      { libraryId: 'lib1', name: 'My library', tags: [
        { tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
      ] },
      { libraryId: 'system', name: 'Hydration', tags: [] },
    ],
  }
  // The management-page shape of the same tag, so GET /user/library-tag/lib1/<id>
  // (buildLibraryTagDetail in fixtures/test.ts) has real data to answer with.
  userMock.state.libraries.push({
    libraryId: 'lib1', name: 'My library', note: '', visibility: 'private', isPersonal: false,
    owner: userMock.state.account, tagCount: 1, accountCount: 1, subscriberCount: 0,
    tags: [{
      tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', note: '',
      members: [{ accountId: TREASURY_ACCOUNT_ID, address: TREASURY_ACCOUNT_ID, emoji: '👤', tag: null }],
    }],
  })

  await page.goto('/accounts')
  const row = page.locator('.accounts-tbl tbody tr', { has: page.locator('td[data-label="Value"]', { hasText: '980' }) })
  await row.locator('a.addr-pill').click()

  await expect(page).toHaveURL(new RegExp(`/tag/${USER_TAG_ID}$`))
  await expect(page.locator('.acct-meta > .tag')).toContainText('Mine')
  await expect(page.locator('.acct-meta')).toContainText('1 accounts')
})

// Regression coverage for a cold load racing the tag-map fetch: TagDetail
// used to fall through to the system lookup (and its "Tag not found") the
// instant `libraryForTag` came back empty, without knowing WHY it was
// empty — logged out, or just not loaded yet. Holding the tag-map response
// makes that "not loaded yet" window observable instead of racing past it.
test('a cold logged-in load of a user-tag URL never flashes "Tag not found" while the tag map is in flight', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    libraries: [
      { libraryId: 'lib1', name: 'My library', tags: [
        { tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
      ] },
      { libraryId: 'system', name: 'Hydration', tags: [] },
    ],
  }
  userMock.state.libraries.push({
    libraryId: 'lib1', name: 'My library', note: '', visibility: 'private', isPersonal: false,
    owner: userMock.state.account, tagCount: 1, accountCount: 1, subscriberCount: 0,
    tags: [{
      tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', note: '',
      members: [{ accountId: TREASURY_ACCOUNT_ID, address: TREASURY_ACCOUNT_ID, emoji: '👤', tag: null }],
    }],
  })

  let releaseTagMap = () => {}
  const held = new Promise<void>(resolve => { releaseTagMap = resolve })
  await page.route(/\/api\/user\/tag-map(?:\?.*)?$/, async route => {
    await held
    await route.fallback()
  })

  await page.goto(`/tag/${USER_TAG_ID}`)
  // The map is still gated: this must read as "waiting", never "not found".
  await expect(page.locator('.acct-head-skeleton')).toBeVisible()
  await expect(page.locator('.detail-card', { hasText: 'Tag not found' })).toHaveCount(0)

  releaseTagMap()
  await expect(page.locator('.acct-meta > .tag')).toContainText('Mine')
})

// Regression for a "loading forever" bug in the fix above: a session whose
// /user/tag-map fetch fails OUTRIGHT (every retry exhausted, not just "still
// in flight") must still let a UUID-shaped /tag/:id page settle. Before this,
// tagMapStatus() had no way to tell "errored" apart from "still loading" (both
// left the map's own data undefined), so useTagMapSync's effect — keyed off
// [session, q.data] — never fired again after the failure and the page's
// skeleton never resolved at all.
test('a UUID tag URL settles — never stays on the skeleton — when the tag-map fetch fails outright', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  await page.route(/\/api\/user\/tag-map(?:\?.*)?$/, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }))

  await page.goto(`/tag/${USER_TAG_ID}`)
  // Right after navigation, the map is still retrying — the skeleton is the
  // correct, honest state to be in at this instant.
  await expect(page.locator('.acct-head-skeleton')).toBeVisible()

  // Past the retry backoff (shouldRetryQuery allows 2 retries on a 5xx,
  // exponential ~1s + ~2s), the fetch has failed outright and the page must
  // have moved on to a real, rendered state — never stuck on the skeleton.
  await expect(page.locator('.acct-head-skeleton')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('.acct-meta .tag')).toBeVisible()
})

// HoverCard.parseTarget has the SAME loading/anonymous ambiguity TagDetail's
// routing does (both read tagMapStatus()/libraryForTag() over a /tag/:id
// href) — verify it actually guards against it rather than assuming the fix
// above covers it. A real pill's OWN href/tag resolution (resolveTag) is
// ALSO tag-map-sensitive, so a genuine account pill would just show the
// account's system tag meanwhile and never exercise this path; a synthetic
// /tag/:id link isolates the hover card's guard from that.
test('the hover card shows nothing for a UUID /tag/:id link while the tag map is still loading, then resolves once it arrives', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    libraries: [
      { libraryId: 'lib1', name: 'My library', tags: [
        { tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
      ] },
      { libraryId: 'system', name: 'Hydration', tags: [] },
    ],
  }
  userMock.state.libraries.push({
    libraryId: 'lib1', name: 'My library', note: '', visibility: 'private', isPersonal: false,
    owner: userMock.state.account, tagCount: 1, accountCount: 1, subscriberCount: 0,
    tags: [{
      tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', note: '',
      members: [{ accountId: TREASURY_ACCOUNT_ID, address: TREASURY_ACCOUNT_ID, emoji: '👤', tag: null }],
    }],
  })

  let releaseTagMap = () => {}
  const held = new Promise<void>(resolve => { releaseTagMap = resolve })
  await page.route(/\/api\/user\/tag-map(?:\?.*)?$/, async route => { await held; await route.fallback() })

  await page.goto('/accounts')
  await page.evaluate(id => {
    const a = document.createElement('a')
    a.href = `/tag/${id}`
    a.className = 'addr-pill'
    a.id = 'probe-link'
    a.textContent = 'probe'
    document.body.appendChild(a)
  }, USER_TAG_ID)

  await page.locator('#probe-link').hover()
  await page.waitForTimeout(300) // past HOVER_DWELL_MS (180ms) with margin
  await expect(page.locator('.hovercard')).toHaveCount(0)

  releaseTagMap()
  await page.mouse.move(0, 0) // force a fresh mouseover on the re-hover below
  await page.locator('#probe-link').hover()
  await expect(page.locator('.hovercard')).toContainText('Mine')
})

// A UUID-shaped id can't be resolved client-side at all without a session
// (the tag map only ever loads for one) — that's a real "can't tell", not a
// "doesn't exist", so a logged-out visitor gets an invitation to log in
// rather than the flat 404-style message an actually-unknown id gets.
test('a logged-out visitor on a user-tag URL sees a log-in hint, not "Tag not found"', async ({ page }) => {
  await page.goto(`/tag/${USER_TAG_ID}`)

  const card = page.locator('.detail-card')
  await expect(card).toContainText(/log in/i)
  await expect(card).not.toContainText('Tag not found')

  // The affordance is real, not decorative text — it opens the actual dialog.
  // Scoped to the card: the topbar carries its own "Log in" button too.
  await card.getByRole('button', { name: 'Log in' }).click()
  await expect(page.locator('.dialog-head h2')).toHaveText('Log in with your wallet')
})

// The provenance pill reads the library's owner off the VIEWER's own /user/me
// (see LibraryTagDetail.tsx) — every prior fixture made the viewer the
// owner, which could hide a bug that shows the viewer's own name/avatar no
// matter whose library it actually is. A subscribed (not owned) library with
// a different owner is the case that would have caught it.
test('the provenance pill shows a subscribed library\'s real owner, not the viewer', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  const foreignOwner: AccountRef = {
    accountId: '0x' + 'cd'.repeat(32), address: '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',
    emoji: '🦉', tag: null, identity: null, profile: { name: 'Foreign Owner', avatarVersion: 0 },
  }
  userMock.state.tagMap = {
    libraries: [
      { libraryId: 'foreign-lib', name: 'Whales', tags: [
        { tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
      ] },
      { libraryId: 'system', name: 'Hydration', tags: [] },
    ],
  }
  // Subscribed, not owned: pushed to `subscriptions`, never `libraries`.
  userMock.state.subscriptions.push({
    libraryId: 'foreign-lib', name: 'Whales', note: '', visibility: 'public', isPersonal: false,
    owner: foreignOwner, tagCount: 1, accountCount: 1, subscriberCount: 5,
    tags: [{
      tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', note: '',
      members: [{ accountId: TREASURY_ACCOUNT_ID, address: TREASURY_ACCOUNT_ID, emoji: '👤', tag: null }],
    }],
  })

  await page.goto(`/tag/${USER_TAG_ID}`)
  await expect(page.locator('.acct-meta > .tag')).toContainText('Mine')
  const pill = page.locator('.acct-meta a.addr-pill')
  await expect(pill).toContainText('Foreign Owner')
  await expect(pill).toContainText('Whales')
  await expect(pill).not.toContainText('E2E User')
})

test('create a library, tag a known address, and reorder', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  // A second owned library, seeded directly so the reorder step swaps two
  // REAL entries — the built-in 'system' slot that `Libraries.tsx` always
  // appends to the rendered rows is never actually IN `me.order`, so
  // reordering against it alone would be a no-op.
  userMock.state.libraries.push({
    libraryId: 'seed', name: 'Existing', note: '', visibility: 'private', isPersonal: false,
    owner: userMock.state.account, tagCount: 0, accountCount: 0, subscriberCount: 0, tags: [],
  })
  userMock.state.order.push('seed')

  await page.goto('/libraries')
  await page.getByRole('button', { name: '+ New library' }).click()
  await page.locator('#library-name-input').fill('E2E Library')
  await page.locator('.dialog-foot button', { hasText: 'Create' }).click()

  // `state.libraries.length` was 1 (the seed) when the create handler ran,
  // so the new library is deterministically 'lib-2'.
  await expect(page).toHaveURL(/\/library\/lib-2$/)
  // Direct child, not `.acct-meta .tag`: the owner AddrPill just below also
  // renders a `.tag` span (the mock owner has a profile name too), so the
  // descendant-combinator version matches both and trips strict mode.
  await expect(page.locator('.acct-meta > .tag')).toContainText('E2E Library')

  await page.getByRole('button', { name: '+ New tag' }).click()
  await page.locator('#tag-name-input').fill('E2E Tag')
  await page.locator('.dialog-foot button', { hasText: 'Create' }).click()

  const tagPanel = page.locator('.panel', { hasText: 'E2E Tag' })
  await expect(tagPanel).toContainText('No accounts yet')
  // No Add button and no table: an address-shaped Enter commits the member
  // immediately, and it renders as a chip.
  await expect(tagPanel.locator('table')).toHaveCount(0)
  await expect(tagPanel.getByRole('button', { name: 'Add' })).toHaveCount(0)
  await tagPanel.locator('.acct-picker input').fill(BINANCE_ADDRESS)
  await tagPanel.locator('.acct-picker input').press('Enter')
  await expect(tagPanel.locator('.tag-member-chips .addr-pill')).toHaveCount(1)
  await expect(tagPanel).not.toContainText('No accounts yet')

  await page.goto('/libraries')
  await page.locator('tbody tr', { hasText: 'E2E Library' }).locator('button[aria-label="Move up"]').click()
  await expect.poll(() => userMock.state.order).toEqual(['lib-2', 'seed'])
})

// Seeds an owned library with one (empty) tag — enough surface for both
// AccountPicker hosts (a tag's member editor, and the Invites tab) without
// running the full library/tag creation flow.
function seedOneTagLibrary(userMock: { state: UserMockState }): void {
  userMock.state.libraries.push({
    libraryId: 'lib1', name: 'My library', note: '', visibility: 'private', isPersonal: false,
    owner: userMock.state.account, tagCount: 1, accountCount: 0, subscriberCount: 0,
    tags: [{ tagId: 't1', name: 'Watch', color: '#22c55e', icon: '👀', note: '', members: [] }],
  })
}

test('the tag member editor and the invites picker both show tabs, and the library page deep-links to them', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  seedOneTagLibrary(userMock)

  await page.goto('/library/lib1')
  // Tags is the default tab — no ?view= needed to land on it.
  await expect(page.locator('.tabs.detail-tabs button.active')).toHaveText(/Tags/)
  const tagPanel = page.locator('.panel', { hasText: 'Watch' })
  await tagPanel.locator('.acct-picker input').fill(BINANCE_ADDRESS)
  await assertDropdownReadsLikeSearchDropdown(tagPanel)

  await page.locator('.tabs.detail-tabs button', { hasText: 'Invites' }).click()
  await expect(page).toHaveURL(/\?view=invites$/)
  await expect(page.locator('.tabs.detail-tabs button.active')).toHaveText(/Invites/)
  await expect(tagPanel).toHaveCount(0) // the Tags tab's panels are gone, not just hidden
  const invitesPanel = page.locator('.panel', { hasText: 'Revoke removes a pending invite' })
  await invitesPanel.locator('.acct-picker input').fill(BINANCE_ADDRESS)
  await assertDropdownReadsLikeSearchDropdown(invitesPanel)

  // Deep link straight to the Invites tab.
  await page.goto('/library/lib1?view=invites')
  await expect(page.locator('.tabs.detail-tabs button.active')).toHaveText(/Invites/)
})

test('a bad address in a batch reports itself and restores the rest, without losing the good one ahead of it', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  seedOneTagLibrary(userMock)

  await page.goto('/library/lib1')
  const tagPanel = page.locator('.panel', { hasText: 'Watch' })
  const input = tagPanel.locator('.acct-picker input')
  // One Enter on a multi-token line takes the same commit path a multi-address
  // paste does (tokenizeAddresses doesn't care which) — easier to drive here
  // than simulating a real clipboard event.
  await input.fill(`${BINANCE_ADDRESS} ${INVALID_TAG_MEMBER_ADDRESS} ${TREASURY_ACCOUNT_ID}`)
  await input.press('Enter')

  // Submitted sequentially, stopping at the first failure: the good address
  // ahead of it already landed, the error names the bad one, and — since
  // immediate-commit mode has no staging chips of its own to leave the rest
  // sitting in — the bad address plus everything still unsent (the second
  // good address) is restored into the input as text rather than dropped.
  await expect(tagPanel.locator('.tag-member-chips .addr-pill')).toHaveCount(1)
  await expect(tagPanel.locator('.dialog-error')).toContainText(INVALID_TAG_MEMBER_ADDRESS)
  await expect(input).toHaveValue(`${INVALID_TAG_MEMBER_ADDRESS} ${TREASURY_ACCOUNT_ID}`)

  // Dropping the bad one and resubmitting the rest lands it.
  await input.fill(TREASURY_ACCOUNT_ID)
  await input.press('Enter')
  await expect(tagPanel.locator('.tag-member-chips .addr-pill')).toHaveCount(2)
})

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('connect a wallet and sign in', async ({ page, userMock, injectedWallet }) => {
    void userMock; void injectedWallet
    await loginFlow(page)
  })

  test('the account-picker dropdown still overlaps its panel at 390px', async ({ page, userMock }) => {
    await seedSession(page, userMock)
    seedOneTagLibrary(userMock)

    await page.goto('/library/lib1')
    const tagPanel = page.locator('.panel', { hasText: 'Watch' })
    await tagPanel.locator('.acct-picker input').fill(BINANCE_ADDRESS)
    await assertDropdownReadsLikeSearchDropdown(tagPanel)
  })
})
