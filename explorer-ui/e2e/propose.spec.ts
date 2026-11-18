import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'

// The proposal wizard without a chain: the description step holds Next until there is
// a title and a text, a discussion can seed it (its text copied, a link to it added),
// the draft survives a reload, and with the node unreachable the call cannot be built
// — the step says why and Next stays disabled, so nothing can get near a signature.
// The chain-backed walk to a refused signature (and the dry-run of every scenario) is
// propose-chain.spec.ts.

const HEAD = 16_780_000

async function setup(page: Page) {
  await page.routeWebSocket(/hydration-rpc\.neckwork\.net/, ws => ws.close())
  await page.route(/hydration-rpc\.neckwork\.net/, route => route.abort())
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/api\/explorer\/governance\/clock(\?|$)/, route => route.fulfill(json({ headBlock: HEAD, headTs: new Date().toISOString(), msPerBlock: 2160, nominalMsPerBlock: 2000, source: 'measured', window: 302400 })))
  await page.route(/\/api\/explorer\/forum\/discussions(\?|$)/, route => route.fulfill(json({
    generation: 'g1', total: 1, nextCursor: null,
    rows: [{ postId: '42', title: 'Fund the next audit round', excerpt: 'An audit', labels: ['Treasury'], author: null, createdAt: '2026-11-01T00:00:00Z', lastActivityAt: '2026-11-02T00:00:00Z', editedAt: null, commentsCount: 3, upvotes: 1, linked: [], source: null, bannerCid: null, hasPoll: false }],
  })))
  await page.route(/\/api\/explorer\/forum\/post\/42(\?|$)/, route => route.fulfill(json({
    postId: '42', kind: 'discussion', title: 'Fund the next audit round', body: 'We would like **300k HDX** for an audit.', tldr: '', labels: ['Treasury'], linked: [],
    author: null, createdAt: '2026-11-01T00:00:00Z', editedAt: null, lastActivityAt: '2026-11-02T00:00:00Z', commentsCount: 3, upvotes: 1, revision: 0, hidden: false, deleted: false, locked: false, media: {}, generation: 'g1',
  })))
  await page.addInitScript(() => {
    const w = window as unknown as { __signRequests: unknown[] }
    w.__signRequests = []
  })
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('describe, seed from a discussion, keep the draft, and stop at the call without a chain', async ({ page }) => {
      // The wizard waits 15 s for an unreachable node before it says so.
      test.setTimeout(60_000)
      await setup(page)
      await page.goto('/governance/propose')
      await expect(page.getByRole('heading', { level: 1 })).toContainText('New proposal')
      await expect(page.locator('.pp-steps [aria-current="step"]')).toContainText('Describe')
      const next = page.getByRole('button', { name: 'Next: the call' })
      await expect(next).toBeDisabled()

      // A discussion seeds the description: its text, and a line linking it.
      await page.getByText('Start from a discussion').click()
      await page.getByRole('button', { name: 'Fund the next audit round' }).click()
      await expect(page.getByLabel('Title')).toHaveValue('Fund the next audit round')
      await expect(page.locator('.pp-step-body textarea').first()).toHaveValue(/300k HDX[\s\S]*Discussed in \[Fund the next audit round\]\(\/discussions\/42\)/)
      await expect(page.locator('.pp-meta', { hasText: 'Started from' })).toBeVisible()
      await expect(next).toBeEnabled()

      // The draft is this browser's until the description is published.
      await page.waitForTimeout(600)
      await page.reload()
      await expect(page.getByLabel('Title')).toHaveValue('Fund the next audit round')

      await page.getByRole('button', { name: 'Next: the call' }).click()
      await expect(page.locator('.pp-steps [aria-current="step"]')).toContainText('The call')
      await page.getByLabel('Amount').fill('1000')
      await expect(page.locator('.pp-meta', { hasText: 'Tipper track' })).toBeVisible()
      await page.getByLabel('Beneficiary').fill('15U8rqSKTZuNz1doFgiaiCzeRTbEpxmHGAPQi1nRc6oamXQV')
      // "Days from now" is fixed to a block when it is chosen: a later head does not move it.
      await page.getByRole('radio', { name: 'Days from now' }).click()
      const stored = async () => page.evaluate(() => JSON.parse(localStorage.getItem('explorer-propose-draft') ?? '{}')?.call?.validFrom)
      await expect.poll(stored).toMatchObject({ mode: 'days', days: '30', block: HEAD + Math.round(30 * 86_400_000 / 2160) })
      const fixed = (await stored()).block
      await page.unroute(/\/api\/explorer\/governance\/clock(\?|$)/)
      await page.route(/\/api\/explorer\/governance\/clock(\?|$)/, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ headBlock: HEAD + 5_000, headTs: new Date().toISOString(), msPerBlock: 2160, nominalMsPerBlock: 2000, source: 'measured', window: 302400 }) }))
      await page.reload()
      await expect(page.getByLabel('Days from now')).toHaveValue('30')
      expect((await stored()).block).toBe(fixed)
      // No node: the call cannot be built against the runtime, and the wizard says so.
      await expect(page.locator('.vote-review-bad')).toContainText(/could not be reached|chain/i, { timeout: 20_000 })
      await expect(page.getByRole('button', { name: 'Next: the preimage' })).toBeDisabled()
      // Earlier steps stay one click away; later ones are not reachable yet.
      await expect(page.locator('.pp-steps button', { hasText: 'Describe' })).toBeVisible()
      await expect(page.locator('.pp-steps button', { hasText: 'Submit' })).toHaveCount(0)

      expect(await page.evaluate(() => (window as unknown as { __signRequests: unknown[] }).__signRequests.length)).toBe(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)

      await page.getByRole('button', { name: 'Discard it' }).click()
      // Discarding starts over: back at the first step, empty.
      await expect(page.locator('.pp-steps [aria-current="step"]')).toContainText('Describe')
      await expect(page.getByRole('button', { name: 'Next: the call' })).toBeDisabled()
      expect(await page.evaluate(() => localStorage.getItem('explorer-propose-draft') ?? '')).not.toContain('Fund the next audit round')
    })
  })
}
