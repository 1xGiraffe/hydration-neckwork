import type { Page } from '@playwright/test'
import { E2E_TOKEN, expect, seedSession, test } from './fixtures/test'

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

  const walletRow = page.locator('.wallet-row', { hasText: 'Polkadot{.js} / Nova' })
  await expect(walletRow).toContainText('Installed')
  await walletRow.click()

  await expect(page.locator('.account-btn .profile-name')).toHaveText('E2E User')

  const stored = await page.evaluate(() => window.localStorage.getItem('explorer-session'))
  const session = stored ? (JSON.parse(stored) as { token?: string }) : null
  expect(session?.token).toBe(E2E_TOKEN)
}

test('connect a wallet and sign in', async ({ page, userMock, injectedWallet }) => {
  void userMock; void injectedWallet // fixtures wire the mocked auth + wallet stub; the flow itself is exercised below
  await loginFlow(page)
})

test('a user tag outranks the system tag, and the system tag returns on logout', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    libraries: [
      { libraryId: 'lib1', name: 'My library', tags: [
        { tagId: 't1', name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
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
  await expect(pill).toHaveAttribute('href', '/library/lib1')

  await page.locator('.account-btn').click()
  await page.locator('.account-menu button', { hasText: 'Log out' }).click()

  await expect(pill).toContainText('Treasury')
  await expect(pill).toHaveAttribute('href', '/tag/treasury')
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
  await tagPanel.locator('textarea').fill(BINANCE_ADDRESS)
  await tagPanel.locator('button', { hasText: 'Add' }).click()
  await expect(tagPanel.locator('tbody a.addr-pill')).toHaveCount(1)

  await page.goto('/libraries')
  await page.locator('tbody tr', { hasText: 'E2E Library' }).locator('button[aria-label="Move up"]').click()
  await expect.poll(() => userMock.state.order).toEqual(['lib-2', 'seed'])
})

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('connect a wallet and sign in', async ({ page, userMock, injectedWallet }) => {
    void userMock; void injectedWallet
    await loginFlow(page)
  })
})
