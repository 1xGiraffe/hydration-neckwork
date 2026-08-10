import { expect, seedSession, test } from './fixtures/test'

// Every activity list can be narrowed to the accounts a reader can recognise —
// a system tag, an on-chain identity, a profile name or a verified contract —
// or to everyone else. The filter is decided on the row's actor server-side, so
// it survives paging rather than trimming a page the server already sent.

test('the activity page offers the filter and puts it in the URL', async ({ page }) => {
  await page.goto('/activity')
  await page.getByRole('button', { name: /^Filters/ }).click()   // the zone starts collapsed
  const select = page.locator('select[aria-label="identity"]')
  await expect(select).toBeVisible()
  await expect(select).toHaveValue('')                 // no filter by default

  await select.selectOption('named')
  await expect(page).toHaveURL(/[?&]identity=named/)   // shareable, survives reload
  await select.selectOption('unnamed')
  await expect(page).toHaveURL(/[?&]identity=unnamed/)
  await select.selectOption('')
  await expect(page).not.toHaveURL(/identity=/)
})

test('the filter reaches the request, for the rows and for the count', async ({ page }) => {
  const asked: string[] = []
  page.on('request', r => { const u = r.url(); if (u.includes('/explorer/activity')) asked.push(u) })
  await page.goto('/activity?identity=named')
  await expect(page.locator('table.tbl tbody tr').first()).toBeVisible()

  expect(asked.some(u => u.includes('/explorer/activity?') && u.includes('identity=named'))).toBe(true)
  // The pager's total has to move with the filter, or it offers empty pages.
  expect(asked.some(u => u.includes('/activity/count') && u.includes('identity=named'))).toBe(true)
})

test('a scoped list carries the filter too', async ({ page }) => {
  const asked: string[] = []
  page.on('request', r => { const u = r.url(); if (u.includes('/activity')) asked.push(u) })
  await page.goto('/tag/kraken?view=activity&identity=unnamed')
  // Wait for the tag's own activity request rather than a fixed pause.
  await expect.poll(() => asked.some(u => /\/tag\/[^/]+\/activity/.test(u)), { timeout: 15_000 }).toBe(true)
  const scoped = asked.filter(u => /\/tag\/[^/]+\/activity/.test(u))
  expect(scoped.every(u => u.includes('identity=unnamed'))).toBe(true)
})

// A viewer's OWN and subscribed tags are names too — to them. The public feed
// cannot know them, so a logged-in reader's filter goes to the viewer endpoint,
// which resolves the tags from the session rather than trusting the client.
const TREASURY_ACCOUNT_ID = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'
const USER_TAG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

test('a logged-in reader filters against their own tags', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    lists: [
      { listId: 'lib1', name: 'My list', tags: [
        { tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
      ] },
      { listId: 'system', name: 'Hydration', tags: [] },
    ],
  }

  const asked: string[] = []
  page.on('request', r => { const u = r.url(); if (u.includes('/activity')) asked.push(u) })
  await page.goto('/activity?identity=named')
  await expect(page.locator('table.tbl tbody tr').first()).toBeVisible()

  // The viewer endpoint is the one asked, and the public one is not used for
  // the filtered rows — the answer differs per viewer, so a shared cached page
  // would be the wrong one.
  await expect.poll(() => asked.some(u => u.includes('/user/activity') && u.includes('identity=named'))).toBe(true)
})

test('without the filter a logged-in reader still gets the shared public feed', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    lists: [{ listId: 'lib1', name: 'My list', tags: [
      { tagId: USER_TAG_ID, name: 'Mine', color: '#22c55e', icon: '👀', members: [TREASURY_ACCOUNT_ID] },
    ] }, { listId: 'system', name: 'Hydration', tags: [] }],
  }
  const asked: string[] = []
  page.on('request', r => { const u = r.url(); if (u.includes('/activity')) asked.push(u) })
  await page.goto('/activity')
  await expect(page.locator('table.tbl tbody tr').first()).toBeVisible()

  // Only the identity filter's answer depends on the viewer; everything else is
  // the same page for everyone and must keep using the shared cached feed.
  expect(asked.some(u => u.includes('/explorer/activity'))).toBe(true)
  expect(asked.some(u => u.includes('/user/activity'))).toBe(false)
})
