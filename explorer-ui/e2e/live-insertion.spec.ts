import { expect, test } from './fixtures/test'
import { mockSync } from '../tests/fixtures/mockApi'
import type { Page } from '@playwright/test'
import type { BlockSummary } from '../src/types'

// A newest-first feed prepends whatever the six-second poll brought. At the top
// of the page that IS the live view. Below the top it shoves the rows the reader
// is reading down, over and over — the app's largest layout-shift source — so
// there the arrivals are held until the reader comes back up.
//
// The head is advanced by re-asking the deterministic fixture for a lower
// offset: `/blocks?limit=60&offset=-3` is the same feed three blocks later, so
// these are real prepends of real rows, not a hand-written diff.

const ADVANCE = 3
const PAGE = 25

async function advancingBlocks(page: Page) {
  const state = { advance: 0, servedSince: 0 }
  await page.route(/\/api\/explorer\/blocks(\?|$)/, async route => {
    const params = new URL(route.request().url()).searchParams
    const limit = Number(params.get('limit') ?? 25)
    const offset = Number(params.get('offset') ?? 0) - state.advance
    const rows = mockSync<BlockSummary[]>(`/explorer/blocks?limit=${limit}&offset=${offset}`)!
    state.servedSince++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) })
  })
  return {
    // Move the chain on, then wait until the app has actually been served the
    // newer head at least once, so the assertions face a delivered poll.
    async advanceHead(by: number) {
      state.advance += by
      state.servedSince = 0
      await expect.poll(() => state.servedSince, { timeout: 20_000 }).toBeGreaterThan(0)
      await page.waitForTimeout(400)
    },
  }
}

const heights = (page: Page) =>
  page.locator('.panel table.tbl tbody tr').evaluateAll(rows =>
    rows.map(row => row.querySelector('td')!.textContent!.trim()))

const scrollTo = (page: Page, top: number) =>
  page.evaluate(y => { window.scrollTo({ top: y, behavior: 'instant' }) }, top)

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]] as const) {
  test.describe(`live block insertion (${name})`, () => {
    test.use({ viewport })
    test.slow()

    test('holds new rows below the top, then flushes them in order', async ({ page }) => {
      const feed = await advancingBlocks(page)
      await page.goto('/blocks')
      await expect(page.locator('.panel table.tbl tbody tr').first()).toBeVisible()
      const held = await heights(page)
      expect(held).toHaveLength(PAGE)

      // Somewhere in the middle of the list, where a prepend would push the row
      // under the reader's eyes down by ADVANCE rows.
      const marker = page.locator('.panel table.tbl tbody tr').nth(8)
      await scrollTo(page, (await marker.boundingBox())!.y - 100)
      // The block number only: the neighbouring "time ago" cell ticks on its own.
      const markerText = (await marker.locator('td').first().textContent())!.trim()
      const { y: markerTop, height: rowHeight } = (await marker.boundingBox())!
      const scrollY = await page.evaluate(() => window.scrollY)

      await feed.advanceHead(ADVANCE)
      await feed.advanceHead(ADVANCE)

      expect(await heights(page), 'the list must not move under the reader').toEqual(held)
      expect((await marker.locator('td').first().textContent())!.trim(), 'same row in the same slot').toBe(markerText)
      // A prepend would push this row down by whole rows. The page head settles by
      // a pixel or two on its own over this many seconds, so a fraction of a row
      // is the meaningful bound.
      expect(Math.abs((await marker.boundingBox())!.y - markerTop)).toBeLessThan(rowHeight / 2)
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollY)
      expect(await overflow(page), 'no sideways scroll while rows are held').toBe(0)

      await scrollTo(page, 0)
      await expect(page.locator('.panel table.tbl tbody tr.row-new')).toHaveCount(2 * ADVANCE)
      const flushed = await heights(page)
      expect(flushed).toHaveLength(PAGE)
      expect(new Set(flushed).size, 'every row once').toBe(PAGE)
      // Newest first, and continuous with what was on screen: the held window
      // reappears whole, pushed down by exactly the rows that arrived.
      const numbers = flushed.map(h => Number(h.replace(/\D/g, '')))
      expect(numbers).toEqual([...numbers].sort((a, b) => b - a))
      expect(flushed.slice(2 * ADVANCE)).toEqual(held.slice(0, PAGE - 2 * ADVANCE))
      expect(numbers[0], 'the head moved by what arrived').toBe(Number(held[0].replace(/\D/g, '')) + 2 * ADVANCE)
      expect(await overflow(page)).toBe(0)

      // A row that was held and then flushed is still a working link.
      await page.locator('.panel table.tbl tbody tr').first().locator('a.hash').click()
      await expect(page).toHaveURL(new RegExp(`/block/${numbers[0]}$`))
    })

    test('still prepends immediately at the top — that is the live view', async ({ page }) => {
      const feed = await advancingBlocks(page)
      await page.goto('/blocks')
      await expect(page.locator('.panel table.tbl tbody tr').first()).toBeVisible()
      const before = await heights(page)

      await feed.advanceHead(ADVANCE)

      const after = await heights(page)
      expect(Number(after[0].replace(/\D/g, ''))).toBe(Number(before[0].replace(/\D/g, '')) + ADVANCE)
      expect(after.slice(ADVANCE)).toEqual(before.slice(0, PAGE - ADVANCE))
      await expect(page.locator('.panel table.tbl tbody tr.row-new')).toHaveCount(ADVANCE)
    })

    test('the pager still works while the reader is scrolled down', async ({ page }) => {
      const feed = await advancingBlocks(page)
      await page.goto('/blocks')
      await expect(page.locator('.panel table.tbl tbody tr').first()).toBeVisible()

      await scrollTo(page, 400)
      await feed.advanceHead(ADVANCE)
      await page.locator('.pager').getByRole('button', { name: 'Next page' }).click()

      await expect(page).toHaveURL(/page=1/)
      const second = await heights(page)
      expect(second).toHaveLength(PAGE)
      expect(second[0], 'page two starts where page one ended').not.toBe('')
      expect(await overflow(page)).toBe(0)
    })
  })
}

test('a category picked while scrolled down replaces the held rows', async ({ page }) => {
  await page.goto('/activity')
  const badges = page.locator('.panel table.tbl tbody tr .pill-badge')
  await expect(badges.first()).toBeVisible()
  const mixed = await badges.allTextContents()
  expect(new Set(mixed).size, 'the unfiltered feed must mix categories').toBeGreaterThan(1)

  await scrollTo(page, 500)
  await page.getByRole('button', { name: 'Transfer', exact: true }).click()
  await expect.poll(async () => new Set(await badges.allTextContents()).size).toBe(1)
  await expect(badges.first()).toHaveText('Transfer')

  // Back to the unfiltered feed, which is still cached: a held window must not
  // outlive the list the reader asked to leave.
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await expect.poll(async () => new Set(await badges.allTextContents()).size).toBeGreaterThan(1)
})
