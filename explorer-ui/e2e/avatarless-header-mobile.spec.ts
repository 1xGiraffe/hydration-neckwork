import type { Page } from '@playwright/test'
import { expect, seedSession, test } from './fixtures/test'

// The phone header inlines a 28px avatar in front of the name and pulls every
// meta row after it back by that avatar's 38px indent, so the address/note
// rows sit on the card's own left edge. Two headers render no avatar at all —
// a list's and the Hydration Tags hero — and the pull-back has nothing to
// undo there: unscoped, it dragged every row but the title 38px OUTSIDE the
// card. Measured against the header's content box, which is where a meta row
// belongs on every one of these surfaces.
test.use({ viewport: { width: 390, height: 844 } })

const FOX = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'
// Someone other than the logged-in viewer, so the list renders its non-owner
// surface: header plus the read-only stats panel, no tag panels.
const OTHER_OWNER = '15393VqXBSpxYDXALvGxbaeZoHwfDmh3jgG2t2iGK9vSAx7K'

async function metaRowLefts(page: Page): Promise<{ contentLeft: number; rows: number[] }> {
  return page.evaluate(() => {
    const head = document.querySelector('.acct-head')!
    const cs = getComputedStyle(head)
    const box = head.getBoundingClientRect()
    return {
      contentLeft: box.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
      rows: Array.from(head.querySelector('.acct-meta')!.children)
        .map(c => c.getBoundingClientRect())
        .filter(r => r.width > 0)
        .map(r => r.left),
    }
  })
}

test('a list header keeps every meta row inside the card', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.lists.push({
    listId: 'list-pub', name: 'Giraffe', note: 'Based on publicly available information & evidence.',
    visibility: 'public', isPersonal: false,
    owner: { accountId: OTHER_OWNER, address: OTHER_OWNER, emoji: '🦒', tag: null },
    tagCount: 77, accountCount: 347, subscriberCount: 4, tags: [], subscribed: false,
  })

  await page.goto('/list/list-pub')
  await expect(page.locator('.acct-meta .tag')).toContainText('Giraffe')
  await expect(page.locator('.acct-head .acct-avatar')).toHaveCount(0)

  const { contentLeft, rows } = await metaRowLefts(page)
  expect(rows.length).toBeGreaterThan(1)
  for (const left of rows) expect(left).toBeGreaterThanOrEqual(contentLeft - 0.5)
})

test('the Hydration Tags hero keeps its subtitle inside the card', async ({ page }) => {
  await page.goto('/tags')
  const hero = page.locator('.acct-head', { hasText: 'Hydration Tags' })
  await expect(hero).toBeVisible()
  await expect(hero.locator('.acct-avatar')).toHaveCount(0)

  const { contentLeft, rows } = await metaRowLefts(page)
  expect(rows.length).toBeGreaterThan(1)
  for (const left of rows) expect(left).toBeGreaterThanOrEqual(contentLeft - 0.5)
})

test('an account header still pulls its rows back off the inline avatar', async ({ page }) => {
  await page.goto(`/account/${FOX}`)
  await expect(page.locator('.acct-head .acct-avatar')).toBeVisible()

  const { contentLeft, rows } = await metaRowLefts(page)
  expect(rows.length).toBeGreaterThan(1)
  // The name clears the inline avatar; every row after it lands back on the
  // card's own left edge — the pull-back this fix scopes, not removes.
  expect(rows[0]).toBeGreaterThan(contentLeft + 20)
  for (const left of rows.slice(1)) expect(left).toBeCloseTo(contentLeft, 0)
})
