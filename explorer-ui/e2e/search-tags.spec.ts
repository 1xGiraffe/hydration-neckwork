import { expect, seedSession, test } from './fixtures/test'

// The identity name below is chosen to substring-match the SAME query text as
// the viewer's own list tag ("Kraken") — the exact shape of the complaint this
// spec guards: identities crowding out a matching tag. The server's own
// ordering fix (explorerService.searchUncached) is covered by
// api/tests/searchTags.test.ts; this proves the CLIENT merge in SearchBar
// keeps the viewer's own list-tag hit (searchUserTags, resolved with no
// network round trip) ahead of the server's address/identity hits once both
// arrive, not just that each half individually ranks tags first.
test('a user-list tag result renders above an identity match for the same query', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.tagMap = {
    lists: [
      { listId: 'lib1', name: 'My list', tags: [
        { tagId: 'user-tag-1', name: 'Kraken Watch', color: '#22c55e', icon: '👀', members: [] },
      ] },
      { listId: 'system', name: 'Hydration', tags: [] },
    ],
  }
  await page.route(/\/api\/explorer\/search(\?.*)?$/, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      { type: 'address', value: '0x' + '11'.repeat(32), label: '15xKrakenValidatorAddr', emoji: '🦑', identity: { display: 'Kraken Node Validator', verified: false } },
    ]),
  }))

  await page.goto('/')
  const input = page.getByLabel('Search explorer')
  await input.fill('Kraken')

  const items = page.locator('.sr-item')
  await expect(items).toHaveCount(2)
  await expect(items.nth(0).locator('.sr-type')).toHaveText('Tag')
  await expect(items.nth(0)).toContainText('Kraken Watch')
  await expect(items.nth(1).locator('.sr-type')).toHaveText('Account')
  await expect(items.nth(1)).toContainText('Kraken Node Validator')
})
