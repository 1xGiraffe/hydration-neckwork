import type { Locator, Page } from '@playwright/test'
import { E2E_TOKEN, INVALID_TAG_MEMBER_ADDRESS, expect, seedSession, test } from './fixtures/test'
import type { UserMockState } from './fixtures/test'
import { MOCK_LISTS } from '../tests/fixtures/mockApi'
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
// The fox's and the owl's accountIds, copied from `A.fox`/`A.owl` in
// tests/fixtures/mockApi.ts — the /accounts fixture's own $1.24M and $410k
// rows. Neither carries a system tag (unlike Treasury above), which is
// exactly what the directory-fold spec needs: two ordinary account rows to
// fold into one, with nothing else already folding them server-side.
const FOX_ACCOUNT_ID = '0xaa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899'
const OWL_ACCOUNT_ID = '0xbb22cc33dd44ee55ff6677889900aabbccddeeff0011223344556677889900aa'
// A real user tag id is a UUID (userListService mints them with
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
// reached does. Clicks the Nova tile rather than Polkadot{.js} — Nova is in
// the default shortlist (C1) and shares the same stubbed 'polkadot-js'
// injected key, so it exercises the exact same connect path without first
// opening "Other wallets" (that toggle gets its own dedicated coverage below).
async function loginFlow(page: Page): Promise<void> {
  await page.goto('/')
  await openConnectDialog(page)

  const walletRow = page.locator('.wallet-tile', { hasText: 'Nova Wallet' })
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

// C1: the wallet grid shows only a shortlist (Talisman, Nova, SubWallet) by
// default; every other substrate wallet — including Polkadot{.js}, whose
// injected key Nova's own tile shares — sits behind an "Other wallets"
// toggle until it's opened, and the toggle resets closed on every reopen.
test('the wallet grid shows a shortlist by default, and "Other wallets" reveals the rest', async ({ page, userMock, injectedWallet }) => {
  void userMock; void injectedWallet
  await page.goto('/')
  await openConnectDialog(page)

  const grid = page.locator('.dialog-body .wallet-grid').first()
  await expect(grid.locator('.wallet-tile')).toHaveCount(3)
  await expect(grid).toContainText('Talisman')
  await expect(grid).toContainText('Nova Wallet')
  await expect(grid).toContainText('SubWallet')
  await expect(page.locator('.dialog-body')).not.toContainText('Polkadot{.js}')
  await expect(page.locator('.dialog-body')).not.toContainText('Aleph Zero')

  // A stable class-based locator, not a role+name query — the button's own
  // accessible NAME changes with its label ("Other wallets" → "Fewer
  // wallets"), so re-querying by the old name after the click would find
  // nothing.
  const toggle = page.locator('.wallet-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toHaveText('Other wallets')
  await toggle.click()

  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(toggle).toHaveText('Fewer wallets')
  const otherTile = page.locator('.wallet-tile', { hasText: 'Polkadot{.js}' })
  await expect(otherTile).toContainText('Installed')
  await expect(page.locator('.wallet-tile', { hasText: 'Aleph Zero Signer' })).toBeVisible()

  // Closing and reopening the dialog resets the toggle, not just the wallet stage.
  await page.keyboard.press('Escape')
  await openConnectDialog(page)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.dialog-body')).not.toContainText('Polkadot{.js}')

  // The revealed tile still completes the same connect flow as a shortlisted one.
  await toggle.click()
  await page.locator('.wallet-tile', { hasText: 'Polkadot{.js}' }).click()
  await expect(page.locator('.account-btn .account-label')).toHaveText('E2E User')
})

// C12: a public list's Subscribe affordance shows for logged-out visitors
// too — same button, appearance and label as the logged-in one — and opens
// the login dialog rather than a dead end. /tags' own ConnectDialog instance
// was removed in favor of the shared requestConnect() store Topbar consumes
// (see connectDialog.ts), so this also pins that the two components are
// actually wired together, not just independently rendering the right label.
test('logged out, clicking Subscribe on a /tags row opens the login dialog', async ({ page }) => {
  await page.goto('/tags')
  const row = page.locator('.tbl tbody tr', { hasText: 'DeFi desks' })
  const subscribeBtn = row.getByRole('button', { name: 'Subscribe', exact: true })
  await expect(subscribeBtn).toBeVisible()
  await expect(page.locator('.dialog')).toHaveCount(0)

  await subscribeBtn.click()

  await expect(page.locator('.dialog-head h2')).toHaveText('Log in with your wallet')
})

// A lone on-page match still becomes the TAG's own aggregated row (a real
// group row, group values), never a member row wearing the tag's pill over
// Treasury's own — that mismatch is exactly the bug this feature exists to
// fix, so even one match must behave like a system tag's own single-member
// group row already does: the group row, with group values, full stop. The
// fold happens server-side now (GET /user/accounts, mirroring accountsPage's
// own gkey grouping) — logged in with a session and a tag map that has this
// member is all a spec needs to seed; useAccounts (useExplorerData.ts)
// switches endpoints on its own, and the mock's buildAccountsForViewer walks
// the SAME tag map the real directoryFoldFor would.
test('a user tag outranks the system tag — even with a single member, it becomes the tag\'s own aggregated row — and the system tag returns on logout', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    lists: [
      { listId: 'lib1', name: 'My list', tags: [
        { tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
      ] },
      { listId: 'system', name: 'Hydration', tags: [] },
    ],
  }

  await page.goto('/accounts')
  const row = page.locator('.accounts-tbl tbody tr', { hasText: 'Mine' })
  await expect(row).toHaveCount(1)
  const pill = row.locator('a.addr-pill')
  await expect(pill).toContainText('Mine')
  // The tag's own aggregate view, sharing the system /tag/:id namespace.
  await expect(pill).toHaveAttribute('href', `/tag/${USER_TAG_ID}`)
  // A single-member fold sums to exactly that member's own value (Treasury's
  // real $980k) — the exact-fold design means this is no longer a
  // deliberately-different number standing in for "the fold ran"; the row
  // simply not being labeled "Treasury" anywhere is the signal instead.
  await expect(row.locator('td[data-label="Value"]')).toContainText('980k')
  await expect(page.locator('.accounts-tbl tbody tr', { hasText: 'Treasury' })).toHaveCount(0)

  await page.locator('.account-btn').click()
  await page.locator('.account-menu button', { hasText: 'Log out' }).click()

  // Logged out: the fold is gone, and Treasury's own system-tag row — with
  // its own real $980k — is back.
  await expect(page.locator('.accounts-tbl tbody tr', { hasText: 'Mine' })).toHaveCount(0)
  const treasuryRow = page.locator('.accounts-tbl tbody tr', { has: page.locator('td[data-label="Value"]', { hasText: '980k' }) })
  const treasuryPill = treasuryRow.locator('a.addr-pill')
  await expect(treasuryPill).toContainText('Treasury')
  await expect(treasuryPill).toHaveAttribute('href', '/tag/treasury')
})

// The directory folds a viewer's own tag INSIDE the ranking query now — same
// gkey grouping a system tag gets — so two of the viewer's own tagged
// accounts landing on the same page collapse into one row with their VALUES
// SUMMED, not a separately-fetched aggregate. Restored on logout, same as the
// single-member case above.
test('a user tag holding two on-page accounts folds them into one row, and unfolds on logout', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    lists: [
      { listId: 'lib1', name: 'My list', tags: [
        { tagId: USER_TAG_ID, name: 'Whales', color: '#22c55e', icon: '🐳', members: [FOX_ACCOUNT_ID, OWL_ACCOUNT_ID] },
      ] },
      { listId: 'system', name: 'Hydration', tags: [] },
    ],
  }

  await page.goto('/accounts')
  const row = page.locator('.accounts-tbl tbody tr', { hasText: 'Whales' })
  await expect(row).toHaveCount(1)
  const pill = row.locator('a.addr-pill')
  await expect(pill).toContainText('Whales')
  await expect(pill).toContainText('·2')
  // The tag's own aggregate page, exactly like a system tag's TagGroupPill.
  await expect(pill).toHaveAttribute('href', `/tag/${USER_TAG_ID}`)
  // $1.24M (fox) + $410k (owl), summed exactly — not fetched from a separate
  // aggregate the way the old client-side fold needed to.
  await expect(row.locator('td[data-label="Value"]')).toContainText('1.65M')
  // Both member rows are gone — their own values no longer appear at all.
  await expect(page.locator('.accounts-tbl tbody tr', { hasText: '1.24M' })).toHaveCount(0)
  await expect(page.locator('.accounts-tbl tbody tr', { hasText: '410k' })).toHaveCount(0)

  await page.locator('.account-btn').click()
  await page.locator('.account-menu button', { hasText: 'Log out' }).click()

  await expect(page.locator('.accounts-tbl tbody tr', { hasText: 'Whales' })).toHaveCount(0)
  await expect(page.locator('.accounts-tbl tbody tr', { has: page.locator('td[data-label="Value"]', { hasText: '1.24M' }) })).toHaveCount(1)
  await expect(page.locator('.accounts-tbl tbody tr', { has: page.locator('td[data-label="Value"]', { hasText: '410k' }) })).toHaveCount(1)
})

// The per-viewer fold is a strict enhancement over the shared directory,
// never a requirement for it to render at all — a failing /user/accounts
// (a cold rebuild timing out, a transient 5xx, anything) must fall back to
// exactly the page a logged-out visitor would see, not an empty table.
test('a failing per-viewer fold falls back to the shared directory instead of rendering empty', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    lists: [
      { listId: 'lib1', name: 'My list', tags: [
        { tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
      ] },
      { listId: 'system', name: 'Hydration', tags: [] },
    ],
  }
  await page.route(/\/api\/user\/accounts(\?.*)?$/, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }))

  await page.goto('/accounts')

  // The table is not empty, and Treasury's own row is exactly the shared
  // page's plain, single-account row — its real $980k, not doubled or
  // dropped — proving the fallback served the shared /explorer/accounts
  // fixture rather than an empty or partial one. Its PILL legitimately still
  // reads "Mine" here: AddrPill resolves every account reference against the
  // viewer's own tag map independently of which directory endpoint answered
  // (the same mechanism a vote/activity/holder row's pill already uses
  // everywhere else), and that map loaded fine — only the FOLDED, combined
  // directory ROW failed to load and fell back. A single real, correctly
  // valued row is the property this test exists to prove either way.
  await expect(page.locator('.accounts-tbl tbody tr')).not.toHaveCount(0)
  const treasuryRow = page.locator('.accounts-tbl tbody tr', { has: page.locator('td[data-label="Value"]', { hasText: '980k' }) })
  await expect(treasuryRow).toHaveCount(1)
})

// Regression coverage for HoverCard's tag/list-tag disambiguation: since
// user and system tags now share the plain /tag/:id href form, the hover
// card has to tell them apart the same way TagDetail's own routing does —
// via the viewer's tag map — rather than a URL shape unique to list tags.
test('hovering a user-tag pill shows its own aggregate card, not the system tag lookup', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    lists: [
      { listId: 'lib1', name: 'My list', tags: [
        { tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
      ] },
      { listId: 'system', name: 'Hydration', tags: [] },
    ],
  }
  // The management-page shape of the same tag, so GET /user/list-tag/lib1/<id>
  // (the hover card's own summary request) has real data to answer with.
  userMock.state.lists.push({
    listId: 'lib1', name: 'My list', note: '', visibility: 'private', isPersonal: false,
    owner: userMock.state.account, tagCount: 1, accountCount: 1, subscriberCount: 0,
    tags: [{
      tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', displayIcon: '👀', note: '',
      members: [{ accountId: TREASURY_ACCOUNT_ID, address: TREASURY_ACCOUNT_ID, emoji: '👤', tag: null }],
    }],
  })

  await page.goto('/accounts')
  // Treasury's own row is now the tag's aggregated row (a lone on-page match
  // still folds — see Accounts()), so it's located by the tag's name, not by
  // Treasury's own (no longer shown here) $980k value.
  const row = page.locator('.accounts-tbl tbody tr', { hasText: 'Mine' })
  await row.locator('a.addr-pill').hover()

  const card = page.locator('.hovercard')
  await expect(card).toContainText('Mine')
  await expect(card).toContainText('1 account')
})

test('a user-tag pill opens its own aggregate page, header included', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    lists: [
      { listId: 'lib1', name: 'My list', tags: [
        { tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
      ] },
      { listId: 'system', name: 'Hydration', tags: [] },
    ],
  }
  // The management-page shape of the same tag, so GET /user/list-tag/lib1/<id>
  // (buildListTagDetail in fixtures/test.ts) has real data to answer with.
  userMock.state.lists.push({
    listId: 'lib1', name: 'My list', note: '', visibility: 'private', isPersonal: false,
    owner: userMock.state.account, tagCount: 1, accountCount: 1, subscriberCount: 0,
    tags: [{
      tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', displayIcon: '👀', note: '',
      members: [{ accountId: TREASURY_ACCOUNT_ID, address: TREASURY_ACCOUNT_ID, emoji: '👤', tag: null }],
    }],
  })

  await page.goto('/accounts')
  // Treasury's own row is now the tag's aggregated row (a lone on-page match
  // still folds — see Accounts()), so it's located by the tag's name, not by
  // Treasury's own (no longer shown here) $980k value.
  const row = page.locator('.accounts-tbl tbody tr', { hasText: 'Mine' })
  await row.locator('a.addr-pill').click()

  await expect(page).toHaveURL(new RegExp(`/tag/${USER_TAG_ID}$`))
  await expect(page.locator('.acct-meta > .tag')).toContainText('Mine')
  await expect(page.locator('.acct-meta')).toContainText('1 accounts')
})

// Regression coverage for a cold load racing the tag-map fetch: TagDetail
// used to fall through to the system lookup (and its "Tag not found") the
// instant `listForTag` came back empty, without knowing WHY it was
// empty — logged out, or just not loaded yet. Holding the tag-map response
// makes that "not loaded yet" window observable instead of racing past it.
test('a cold logged-in load of a user-tag URL never flashes "Tag not found" while the tag map is in flight', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    lists: [
      { listId: 'lib1', name: 'My list', tags: [
        { tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
      ] },
      { listId: 'system', name: 'Hydration', tags: [] },
    ],
  }
  userMock.state.lists.push({
    listId: 'lib1', name: 'My list', note: '', visibility: 'private', isPersonal: false,
    owner: userMock.state.account, tagCount: 1, accountCount: 1, subscriberCount: 0,
    tags: [{
      tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', displayIcon: '👀', note: '',
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
// routing does (both read tagMapStatus()/listForTag() over a /tag/:id
// href) — verify it actually guards against it rather than assuming the fix
// above covers it. A real pill's OWN href/tag resolution (resolveTag) is
// ALSO tag-map-sensitive, so a genuine account pill would just show the
// account's system tag meanwhile and never exercise this path; a synthetic
// /tag/:id link isolates the hover card's guard from that.
test('the hover card shows nothing for a UUID /tag/:id link while the tag map is still loading, then resolves once it arrives', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    lists: [
      { listId: 'lib1', name: 'My list', tags: [
        { tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
      ] },
      { listId: 'system', name: 'Hydration', tags: [] },
    ],
  }
  userMock.state.lists.push({
    listId: 'lib1', name: 'My list', note: '', visibility: 'private', isPersonal: false,
    owner: userMock.state.account, tagCount: 1, accountCount: 1, subscriberCount: 0,
    tags: [{
      tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', displayIcon: '👀', note: '',
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

// The provenance pill reads the list's owner off the VIEWER's own /user/me
// (see ListTagDetail.tsx) — every prior fixture made the viewer the
// owner, which could hide a bug that shows the viewer's own name/avatar no
// matter whose list it actually is. A subscribed (not owned) list with
// a different owner is the case that would have caught it.
test('the provenance pill shows a subscribed list\'s real owner, not the viewer', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  const foreignOwner: AccountRef = {
    accountId: '0x' + 'cd'.repeat(32), address: '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',
    emoji: '🦉', tag: null, identity: null, profile: { name: 'Foreign Owner', avatarVersion: 0 },
  }
  userMock.state.tagMap = {
    lists: [
      { listId: 'foreign-list', name: 'Whales', tags: [
        { tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
      ] },
      { listId: 'system', name: 'Hydration', tags: [] },
    ],
  }
  // Subscribed, not owned: pushed to `subscriptions`, never `lists`.
  userMock.state.subscriptions.push({
    listId: 'foreign-list', name: 'Whales', note: '', visibility: 'public', isPersonal: false,
    owner: foreignOwner, tagCount: 1, accountCount: 1, subscriberCount: 5,
    tags: [{
      tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', displayIcon: '👀', note: '',
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

test('create a list, tag a known address, and reorder', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  // A second owned list, seeded directly so the reorder step swaps two
  // REAL entries.
  userMock.state.lists.push({
    listId: 'seed', name: 'Existing', note: '', visibility: 'private', isPersonal: false,
    owner: userMock.state.account, tagCount: 0, accountCount: 0, subscriberCount: 0, tags: [],
  })
  userMock.state.order.push('seed')

  await page.goto('/lists')
  await page.getByRole('button', { name: '+ New list' }).click()
  await page.locator('#list-name-input').fill('E2E List')
  await page.locator('.dialog-foot button', { hasText: 'Create' }).click()

  // `state.lists.length` was 1 (the seed) when the create handler ran,
  // so the new list is deterministically 'list-2'.
  await expect(page).toHaveURL(/\/list\/list-2$/)
  // Direct child, not `.acct-meta .tag`: the owner AddrPill just below also
  // renders a `.tag` span (the mock owner has a profile name too), so the
  // descendant-combinator version matches both and trips strict mode.
  await expect(page.locator('.acct-meta > .tag')).toContainText('E2E List')

  await page.getByRole('button', { name: '+ New tag' }).click()
  await page.locator('#tag-name-input').fill('E2E Tag')
  await page.locator('.dialog-foot button', { hasText: 'Create' }).click()

  const tagPanel = page.locator('.panel', { hasText: 'E2E Tag' })
  // New user request: the tag header (icon + name) links to its own
  // aggregate page — the mock mints this list's first tag as 'tag-1'.
  await expect(tagPanel.locator('.tag-panel-link')).toHaveAttribute('href', '/tag/tag-1')
  await expect(tagPanel).toContainText('No accounts yet')
  // No Add button and no table: an address-shaped Enter commits the member
  // immediately, and it renders as a chip.
  await expect(tagPanel.locator('table')).toHaveCount(0)
  await expect(tagPanel.getByRole('button', { name: 'Add' })).toHaveCount(0)
  await tagPanel.locator('.acct-picker input').fill(BINANCE_ADDRESS)
  await tagPanel.locator('.acct-picker input').press('Enter')
  await expect(tagPanel.locator('.tag-member-chips .addr-pill')).toHaveCount(1)
  await expect(tagPanel).not.toContainText('No accounts yet')

  await page.goto('/lists')
  // New user request: the ▲▼ buttons are gone — each row's own drag handle
  // is a real, focusable <button> instead, and ArrowUp/ArrowDown while it's
  // focused is the keyboard path (dragging itself isn't reliably driveable
  // by keyboard). The built-in 'system' slot is a real, draggable/
  // reorderable row too (see the drag-reorder test below) — this commits the
  // FULL resolved order, system included, not just the two real list ids
  // moved past.
  await page.locator('tbody tr', { hasText: 'E2E List' }).getByRole('button', { name: 'Reorder E2E List' }).focus()
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => userMock.state.order).toEqual(['list-2', 'seed', 'system'])
})

// New user request: rows can be reordered by dragging their own handle, in
// addition to the keyboard path above — same underlying commit
// (`PUT /user/list-order`), just a different gesture. Playwright's `dragTo`
// drives a real HTML5 drag over Chromium (dispatching dragstart/dragover/
// drop, not synthetic events this spec constructs itself), so this exercises
// the actual `<button className="row-handle" draggable>` wiring in
// Lists.tsx rather than assuming it works because the unit-level shape
// matches ListDetail's chip precedent. Dragging from the HANDLE rather than
// the row itself is also what keeps the row's own name link — a native
// anchor, draggable by the browser on its own — from ever competing with
// this gesture for the same mouse-down.
test('drags a row\'s handle to reorder the list, including the system row, and commits the full order', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.lists.push(
    { listId: 'lib-a', name: 'Alpha', note: '', visibility: 'private', isPersonal: false, owner: userMock.state.account, tagCount: 0, accountCount: 0, subscriberCount: 2, tags: [] },
    { listId: 'lib-b', name: 'Bravo', note: '', visibility: 'private', isPersonal: false, owner: userMock.state.account, tagCount: 0, accountCount: 0, subscriberCount: 7, tags: [] },
  )
  userMock.state.order.push('lib-a', 'lib-b')

  await page.goto('/lists')
  // Scoped to Your lists' own panel (the first on the page, above Public
  // lists) — /lists now renders two `.tbl` tables, and an unscoped `tbody
  // tr` would count both.
  const rows = page.locator('.panel').first().locator('tbody tr')
  await expect(rows).toHaveCount(3) // Alpha, Bravo, and the fixed system row

  // The new Subscribers column, right-aligned/mono, reads straight off
  // subscriberCount for a real list row and shows the em-dash placeholder
  // (like Tags/Accounts) on the system row, which has no subscriber concept.
  await expect(page.locator('tbody tr', { hasText: 'Alpha' }).locator('td[data-label="Subscribers"]')).toHaveText('2')
  await expect(page.locator('tbody tr', { hasText: 'Bravo' }).locator('td[data-label="Subscribers"]')).toHaveText('7')
  await expect(page.locator('tbody tr', { hasText: 'Hydration tags' }).locator('td[data-label="Subscribers"]')).toHaveText('—')

  // No ▲▼ buttons left in the Order/Reorder column — just the one handle.
  await expect(page.locator('tbody tr', { hasText: 'Alpha' }).getByRole('button', { name: 'Move up' })).toHaveCount(0)

  // Starting order is Alpha, Bravo, system (creation order). Drag the system
  // row's handle up to the top, past both real lists.
  let orderRequestBody: { listIds: string[] } | null = null
  await page.route(/\/api\/user\/list-order$/, async route => {
    orderRequestBody = route.request().postDataJSON()
    await route.fallback()
  })

  const systemRow = page.locator('tbody tr', { hasText: 'Hydration tags' })
  await systemRow.getByRole('button', { name: 'Reorder Hydration tags' }).dragTo(rows.first())

  await expect.poll(() => orderRequestBody).toEqual({ listIds: ['system', 'lib-a', 'lib-b'] })
  await expect.poll(() => userMock.state.order).toEqual(['system', 'lib-a', 'lib-b'])
  // Reflected immediately (optimistic), not just in the eventual request —
  // the system row now reads first.
  await expect(rows.first()).toContainText('Hydration tags')

  // The keyboard path keeps working against this CURRENT (dragged) order,
  // not the order the page loaded with.
  await rows.nth(1).getByRole('button', { name: 'Reorder Alpha' }).focus()
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => userMock.state.order).toEqual(['lib-a', 'system', 'lib-b'])
})

// New user request: /lists browses and subscribes to public lists too, not
// just /tags — PublicListsPanel is the exact same shared component either
// page renders, so this pins that /lists actually wires it up (not just that
// the component itself works, which the /tags specs already cover) and that
// a subscribe click reaches the real endpoint from here.
test('/lists browses public lists and subscribes to one, same as /tags', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  await page.goto('/lists')

  await expect(page.locator('.sec-title', { hasText: 'Public lists' })).toBeVisible()
  const row = page.locator('tbody tr', { hasText: 'Exchange wallets' })
  await expect(row).toBeVisible()
  await expect(row.locator('td[data-label="Owner"]')).toBeVisible()
  await expect(row.locator('td[data-label="Subscribers"]')).toHaveText('7')

  let subscribeBody: { listId: string } | null = null
  await page.route(/\/api\/user\/subscriptions$/, async route => {
    subscribeBody = route.request().postDataJSON()
    await route.fallback()
  })
  await row.getByRole('button', { name: 'Subscribe', exact: true }).click()
  await expect.poll(() => subscribeBody).toEqual({ listId: 'exchange-wallets' })
})

// The mock's own POST /user/subscriptions is deliberately a no-op (see its
// comment in fixtures/test.ts) — a real subscribed row has to be seeded
// directly, same as any other spec that needs one. Pushing the exact
// MOCK_LISTS entry /explorer/lists already answers with keeps the row's
// other fields (name, note, counts) consistent between the two fetches.
test('an already-subscribed public list shows Unsubscribe on /lists, and unsubscribing calls the right endpoint', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  const exchangeWallets = MOCK_LISTS.find(l => l.listId === 'exchange-wallets')!
  userMock.state.subscriptions.push(exchangeWallets)

  await page.goto('/lists')
  const row = page.locator('tbody tr', { hasText: 'Exchange wallets' })
  const unsubscribeBtn = row.getByRole('button', { name: 'Unsubscribe' })
  await expect(unsubscribeBtn).toBeVisible()
  await expect(row.getByRole('button', { name: 'Subscribe', exact: true })).toHaveCount(0)

  await unsubscribeBtn.click()
  await expect.poll(() => userMock.state.subscriptions.some(l => l.listId === 'exchange-wallets')).toBe(false)
  // The mutation's own invalidate → refetch cycle flips the row back to
  // Subscribe, not just the server-side state checked above.
  await expect(row.getByRole('button', { name: 'Subscribe', exact: true })).toBeVisible()
})

// New user request: logged out, /lists must not gate the public data behind
// the "log in to manage" prompt — /explorer/lists needs no session, so the
// table stays visible and its Subscribe button opens the login dialog, same
// as the existing /tags coverage above.
test('logged out, /lists still shows Public lists (with a real Subscribe → log-in flow) alongside the log-in prompt for Your lists', async ({ page }) => {
  await page.goto('/lists')

  await expect(page.locator('.detail-card', { hasText: 'Log in to manage your lists' })).toBeVisible()

  const row = page.locator('tbody tr', { hasText: 'DeFi desks' })
  const subscribeBtn = row.getByRole('button', { name: 'Subscribe', exact: true })
  await expect(subscribeBtn).toBeVisible()
  await expect(page.locator('.dialog')).toHaveCount(0)

  await subscribeBtn.click()

  await expect(page.locator('.dialog-head h2')).toHaveText('Log in with your wallet')
})

// New user request: "I want to be able to click on my lists in /lists on the
// bottom and /tags too to go to the detail. But only mine." — /explorer/lists
// is a fixed fixture (MOCK_LISTS) unaffected by userMock.state, so making one
// entry read as the viewer's own has to happen at the route level: rewrite
// its `owner` to the logged-in viewer's own account (the exact ownership
// comparison PublicListsPanel makes) rather than trying to match a hardcoded
// fixture accountId. DeFi desks (fox-owned in the fixture) stays foreign, so
// the same page proves both halves of "only mine" at once.
test('an owned public list links to its detail page on /lists; a non-owned one stays plain text', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  await page.route(/\/api\/explorer\/lists(\?.*)?$/, async route => {
    const rewritten = MOCK_LISTS.map(l => l.listId === 'exchange-wallets' ? { ...l, owner: userMock.state.account } : l)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rewritten) })
  })

  await page.goto('/lists')
  const ownRow = page.locator('tbody tr', { hasText: 'Exchange wallets' })
  const foreignRow = page.locator('tbody tr', { hasText: 'DeFi desks' })

  await expect(ownRow.locator('td[data-label="List"] a.addr-pill')).toHaveAttribute('href', '/list/exchange-wallets')
  // Ownership reads through to the Action cell too — no Subscribe/Unsubscribe
  // on your own row, same "Yours" label the pre-existing logic already gave
  // an owned row (this pins that isOwnList didn't diverge from that).
  await expect(ownRow.getByRole('button', { name: /^(Subscribe|Unsubscribe)$/ })).toHaveCount(0)
  await expect(ownRow).toContainText('Yours')

  // The non-owned row's name stays the plain, non-clickable span — no
  // anchor at all inside its List cell.
  await expect(foreignRow.locator('td[data-label="List"] a')).toHaveCount(0)
  await expect(foreignRow.locator('td[data-label="List"] span.addr-pill')).toBeVisible()
})

// The same check on /tags, proving the shared PublicListsPanel component (not
// a per-page reimplementation) is what makes the owned-link behavior work
// wherever it's rendered.
test('an owned public list also links to its detail page on /tags (same shared PublicListsPanel)', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  await page.route(/\/api\/explorer\/lists(\?.*)?$/, async route => {
    const rewritten = MOCK_LISTS.map(l => l.listId === 'defi-desks' ? { ...l, owner: userMock.state.account } : l)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rewritten) })
  })

  await page.goto('/tags')
  const row = page.locator('tbody tr', { hasText: 'DeFi desks' })
  await expect(row.locator('td[data-label="List"] a.addr-pill')).toHaveAttribute('href', '/list/defi-desks')
})

// Seeds an owned list with one (empty) tag — enough surface for both
// AccountPicker hosts (a tag's member editor, and the Invites tab) without
// running the full list/tag creation flow.
function seedOneTagList(userMock: { state: UserMockState }): void {
  userMock.state.lists.push({
    listId: 'lib1', name: 'My list', note: '', visibility: 'private', isPersonal: false,
    owner: userMock.state.account, tagCount: 1, accountCount: 0, subscriberCount: 0,
    tags: [{ tagId: 't1', name: 'Watch', color: '#22c55e', icon: '👀', displayIcon: '👀', note: '', members: [] }],
  })
}

// New user request: a tag created mid-session stays pinned at the BOTTOM of
// the list, in creation order, even once its name would sort ahead of an
// existing tag — the server's alphabetical order (listDetailResponse) is
// still correct on a fresh load, so re-fetching the page (reload, or leaving
// and reopening) must show it there instead. Both new tags sort before the
// seeded 'Watch', which is exactly what would otherwise pull them up the
// list mid-session.
test('a newly created tag stays at the bottom until the page reloads', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  seedOneTagList(userMock)

  await page.goto('/list/lib1')
  const panels = page.locator('.panel')
  await expect(panels).toHaveCount(1)

  async function createTag(name: string) {
    await page.getByRole('button', { name: '+ New tag' }).click()
    await page.locator('#tag-name-input').fill(name)
    await page.locator('.dialog-foot button', { hasText: 'Create' }).click()
    await expect(page.locator('.dialog')).toHaveCount(0)
  }

  await createTag('Aardvark')
  await createTag('Bumblebee')

  // Alphabetical would read Aardvark, Bumblebee, Watch — but mid-session the
  // two just-created tags stay below the pre-existing one, in the order they
  // were created.
  await expect(panels).toHaveCount(3)
  await expect(panels.nth(0)).toContainText('Watch')
  await expect(panels.nth(1)).toContainText('Aardvark')
  await expect(panels.nth(2)).toContainText('Bumblebee')

  await page.reload()

  // A fresh load has no session memory of what was just created — plain
  // alphabetical, matching the server's own order.
  await expect(panels).toHaveCount(3)
  await expect(panels.nth(0)).toContainText('Aardvark')
  await expect(panels.nth(1)).toContainText('Bumblebee')
  await expect(panels.nth(2)).toContainText('Watch')
})

// Regression for a stacking bug: lifting the host panel's own corner-clipping
// overflow (see assertDropdownReadsLikeSearchDropdown above) is not enough
// once there's a FOLLOWING sibling panel for the dropdown to poke past — every
// `.panel` is `position: static`, so plain DOM/paint order (not the dropdown's
// own z-index, which only competes within whatever stacking context it lands
// in) decided who painted on top, and a later sibling always won. Seeds two
// tags and a multi-result search (the default mock's own /explorer/search
// only ever returns one hit for a bare address — not tall enough to reach the
// second panel) so the open dropdown genuinely overlaps the second tag's
// panel, then hit-tests every row that falls within that overlap via
// elementFromPoint — the real, pixel-level symptom, not just "the dropdown is
// in the DOM somewhere". Asserts the overlap set is non-empty first, so this
// can't silently pass by testing nothing if the layout changes later.
test('a tag picker dropdown paints over a FOLLOWING tag panel, not under it', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.lists.push({
    listId: 'lib1', name: 'My list', note: '', visibility: 'private', isPersonal: false,
    owner: userMock.state.account, tagCount: 2, accountCount: 0, subscriberCount: 0,
    tags: [
      { tagId: 't1', name: 'Watch A', color: '#22c55e', icon: '👀', displayIcon: '👀', note: '', members: [] },
      { tagId: 't2', name: 'Watch B', color: '#f97316', icon: '🔥', displayIcon: '🔥', note: '', members: [] },
    ],
  })
  const manyResults = Array.from({ length: 6 }, (_, i) => ({
    type: 'address', value: `0x${String(i).padStart(2, '0')}${'11'.repeat(19)}`, label: `0x${String(i).padStart(2, '0')}${'11'.repeat(19)}`, emoji: '🏦',
  }))
  await page.route(/\/api\/explorer\/search(\?.*)?$/, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manyResults) }))

  await page.goto('/list/lib1')
  const panelA = page.locator('.panel', { hasText: 'Watch A' })
  const panelB = page.locator('.panel', { hasText: 'Watch B' })
  await panelA.locator('.acct-picker input').fill('0x')
  await assertDropdownReadsLikeSearchDropdown(panelA)

  const overlap = await page.evaluate(() => {
    const dropdown = document.querySelector('.acct-picker-results')!
    const rows = [...dropdown.querySelectorAll('.acct-picker-row')]
    const panelBEl = [...document.querySelectorAll('.panel')].find(p => p.textContent?.includes('Watch B'))!
    const bRect = panelBEl.getBoundingClientRect()
    const overlapping = rows.filter(row => {
      const r = row.getBoundingClientRect()
      const cy = r.top + r.height / 2
      return cy > bRect.top && cy < bRect.bottom
    })
    return overlapping.map(row => {
      const r = row.getBoundingClientRect()
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2
      const hit = document.elementFromPoint(cx, cy)
      return { hitIsRow: hit === row || row.contains(hit) }
    })
  })
  // The test setup itself must produce a real overlap, or the check below
  // would trivially pass having tested nothing.
  expect(overlap.length).toBeGreaterThan(0)
  expect(overlap.every(r => r.hitIsRow)).toBe(true)

  // Not a fluke of the second panel merely lacking its own picker: it has one
  // too, and it's untouched — closing the first dropdown leaves the second
  // panel fully interactive.
  await expect(panelB.locator('.acct-picker input')).toBeVisible()
})

test('the tag member editor and the private Subscribers tab both show tabs, and the list page deep-links to Subscribers', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  seedOneTagList(userMock)

  await page.goto('/list/lib1')
  // Tags is the default tab — no ?view= needed to land on it.
  await expect(page.locator('.tabs.detail-tabs button.active')).toHaveText(/Tags/)
  const tagPanel = page.locator('.panel', { hasText: 'Watch' })
  await tagPanel.locator('.acct-picker input').fill(BINANCE_ADDRESS)
  await assertDropdownReadsLikeSearchDropdown(tagPanel)

  await page.locator('.tabs.detail-tabs button', { hasText: 'Subscribers' }).click()
  await expect(page).toHaveURL(/\?view=subscribers$/)
  await expect(page.locator('.tabs.detail-tabs button.active')).toHaveText(/Subscribers/)
  await expect(tagPanel).toHaveCount(0) // the Tags tab's panels are gone, not just hidden
  const subscribersPanel = page.locator('.panel', { hasText: 'invites it to this private list' })
  await subscribersPanel.locator('.acct-picker input').fill(BINANCE_ADDRESS)
  await assertDropdownReadsLikeSearchDropdown(subscribersPanel)

  // Deep link straight to the Subscribers tab.
  await page.goto('/list/lib1?view=subscribers')
  await expect(page.locator('.tabs.detail-tabs button.active')).toHaveText(/Subscribers/)

  // C10: the tab used to be called Invites at `?view=invites` — that value
  // isn't aliased, it just falls back to the default Tags tab like any other
  // unrecognized `view`.
  await page.goto('/list/lib1?view=invites')
  await expect(page.locator('.tabs.detail-tabs button.active')).toHaveText(/Tags/)
})

// C10: private list — the Subscribers tab is a token surface like a tag's
// member editor, not a staging list with Invite/Revoke buttons. Enter commits
// an invite immediately; the chip's own × revokes it.
test('the private Subscribers tab invites via Enter and revokes via the chip ×, with no Invite/Revoke buttons', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  seedOneTagList(userMock)   // visibility: 'private'

  await page.goto('/list/lib1?view=subscribers')
  const panel = page.locator('.panel', { hasText: 'invites it to this private list' })
  await expect(panel.getByRole('button', { name: 'Invite', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0)
  await expect(panel).toContainText('No subscribers yet')

  const input = panel.locator('.acct-picker input')
  await input.fill(BINANCE_ADDRESS)
  await input.press('Enter')

  const chip = panel.locator('.tag-member-chips .acct-chip')
  await expect(chip).toHaveCount(1)
  await expect(panel).not.toContainText('No subscribers yet')
  // A freshly invited (not yet accepted) share reads as pending.
  await expect(chip.locator('.badge.pending')).toHaveText('pending')

  await chip.locator('.acct-chip-x').click()
  await expect(chip).toHaveCount(0)
  await expect(panel).toContainText('No subscribers yet')
})

// C10: public list — the same tab shows the subscriber list read-only:
// no input, no ×, just account pills plus the count on the tab itself.
test('a public list shows its subscriber list read-only, with no input and no revoke', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.lists.push({
    listId: 'list-pub', name: 'Open list', note: '', visibility: 'public', isPersonal: false,
    owner: userMock.state.account, tagCount: 0, accountCount: 0, subscriberCount: 1,
    tags: [],
    shares: [{ account: { accountId: BINANCE_ADDRESS, address: BINANCE_ADDRESS, emoji: '🏦', tag: null }, status: 'active' }],
  })

  await page.goto('/list/list-pub?view=subscribers')
  await expect(page.locator('.tabs.detail-tabs button', { hasText: 'Subscribers' }).locator('.cnt')).toHaveText('1')
  const panel = page.locator('.panel', { hasText: 'open-subscription' })
  await expect(panel.locator('.acct-picker')).toHaveCount(0)
  await expect(panel.locator('.acct-chip-x')).toHaveCount(0)
  await expect(panel.locator('.tag-member-chips .acct-chip')).toHaveCount(1)
  await expect(panel.locator('.badge.pending')).toHaveCount(0)   // active, not invited
})

test('a bad address in a batch reports itself and restores the rest, without losing the good one ahead of it', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  seedOneTagList(userMock)

  await page.goto('/list/lib1')
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

// Regression: the edit form used to seed itself from the tag's DISPLAY icon
// (derived from the first member when the stored icon is '') and resubmit it
// unconditionally on save — a plain rename would then either 422 (a
// profile-avatar URL isn't emoji-shaped) or silently freeze the derived
// emoji as a permanent explicit icon. The header still shows the derived
// glyph; the edit field must show the RAW ('') one, and saving a rename must
// not disturb it.
test('editing a tag whose icon fell back to its first member seeds the raw icon, not the derived one', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  const member: AccountRef = { accountId: '0x' + '11'.repeat(32), address: '0x' + '11'.repeat(32), emoji: '🐘', tag: null }
  userMock.state.lists.push({
    listId: 'lib1', name: 'My list', note: '', visibility: 'private', isPersonal: false,
    owner: userMock.state.account, tagCount: 1, accountCount: 1, subscriberCount: 0,
    tags: [{ tagId: 't1', name: 'Watch', color: '#22c55e', icon: '', displayIcon: '🐘', note: '', members: [member] }],
  })

  await page.goto('/list/lib1')
  // A stable reference across the edit-mode transition: filtering `.panel`
  // by `hasText: 'Watch'` stops matching once editing swaps that text for an
  // `<input>` (input values aren't text content), and this fixture seeds
  // exactly one tag — the only `.panel` rendered by the default 'tags' view.
  const tagPanel = page.locator('.panel')
  await expect(tagPanel).toHaveCount(1)
  // The header shows the DERIVED icon (the member's emoji, not a blank tag glyph).
  await expect(tagPanel.locator('.panel-head .emoji')).toHaveText('🐘')

  await tagPanel.getByRole('button', { name: 'Edit' }).click()
  // ...but the edit field seeds from the RAW icon ('' here), never the derived one.
  await expect(tagPanel.locator('input[aria-label="Tag icon"]')).toHaveValue('')

  await tagPanel.locator('input[aria-label="Tag name"]').fill('Watchers')
  await tagPanel.getByRole('button', { name: 'Save' }).click()

  await expect(tagPanel).not.toContainText('Could not save the tag')
  await expect(tagPanel).toContainText('Watchers')
  // Unfrozen: still shows the derived icon after the rename, not whatever
  // would have been written had the edit form resubmitted the derived value.
  await expect(tagPanel.locator('.panel-head .emoji')).toHaveText('🐘')
})

// B3: drag & drop reorder has a keyboard fallback (Alt+ArrowLeft/Right on a
// focused chip) — keyboard is the reliable path in Playwright, and it
// exercises the exact same PUT .../member-order the mouse drag commits
// through, so this pins the request body rather than just the DOM.
test('reorders tag members with the keyboard and persists the new order', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  const memberA: AccountRef = { accountId: '0x' + '11'.repeat(32), address: '0x' + '11'.repeat(32), emoji: '🐵', tag: null }
  const memberB: AccountRef = { accountId: '0x' + '22'.repeat(32), address: '0x' + '22'.repeat(32), emoji: '🐶', tag: null }
  userMock.state.lists.push({
    listId: 'lib1', name: 'My list', note: '', visibility: 'private', isPersonal: false,
    owner: userMock.state.account, tagCount: 1, accountCount: 2, subscriberCount: 0,
    tags: [{ tagId: 't1', name: 'Watch', color: '#22c55e', icon: '👀', displayIcon: '👀', note: '', members: [memberA, memberB] }],
  })

  let orderRequestBody: { accountIds: string[] } | null = null
  await page.route(/\/api\/user\/lists\/lib1\/tags\/t1\/member-order$/, async route => {
    orderRequestBody = route.request().postDataJSON()
    await route.fallback()
  })

  await page.goto('/list/lib1')
  const tagPanel = page.locator('.panel', { hasText: 'Watch' })
  const chips = tagPanel.locator('.tag-member-chip')
  await expect(chips).toHaveCount(2)
  await expect(chips.nth(0)).toContainText('111') // memberA's last3
  await expect(chips.nth(1)).toContainText('222') // memberB's last3

  await chips.nth(0).focus()
  await page.keyboard.press('Alt+ArrowRight')

  await expect.poll(() => orderRequestBody).toEqual({ accountIds: [memberB.accountId, memberA.accountId] })
  // The swap is reflected immediately (optimistic), not just in the request.
  await expect(chips.nth(0)).toContainText('222')
  await expect(chips.nth(1)).toContainText('111')
})

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('connect a wallet and sign in', async ({ page, userMock, injectedWallet }) => {
    void userMock; void injectedWallet
    await loginFlow(page)
  })

  test('the account-picker dropdown still overlaps its panel at 390px', async ({ page, userMock }) => {
    await seedSession(page, userMock)
    seedOneTagList(userMock)

    await page.goto('/list/lib1')
    const tagPanel = page.locator('.panel', { hasText: 'Watch' })
    await tagPanel.locator('.acct-picker input').fill(BINANCE_ADDRESS)
    await assertDropdownReadsLikeSearchDropdown(tagPanel)
  })
})
