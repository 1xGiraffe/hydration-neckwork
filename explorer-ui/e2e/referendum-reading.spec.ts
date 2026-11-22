import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures/test'

// A referendum page read lightly: the description without its repeated title, the
// timeline open right after it, the status in one line, every voter in the table with
// its filters, a thread's first threads and replies with the rest on request, and
// everything else under one closed "More details" — on desktop and on a 390px phone.

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
const TITLE = 'Register the HOLLAR PSM as a facilitator'
const HDX = { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: 2034 }

function voter(i: number, side: 'Aye' | 'Nay') {
  const weighted = `${(30 - i) * 1_000_000}000000000000`
  return {
    account: { accountId: `0x${String(i).padStart(2, '0').repeat(32)}`, address: `15Voter${String(i).padStart(2, '0')}${'x'.repeat(39)}`, emoji: '🐍', tag: null, identity: null, profile: null },
    kind: 'Standard', side, conviction: 'Locked6x', convictionIndex: 6,
    balance: weighted, ayeBalance: side === 'Aye' ? weighted : '0', nayBalance: side === 'Nay' ? weighted : '0', abstainBalance: '0',
    weightedAye: side === 'Aye' ? weighted : '0', weightedNay: side === 'Nay' ? weighted : '0', weighted, valueUsd: null,
    blockHeight: 1000 + i, eventIndex: 0, extrinsicIndex: 1, timestamp: '2026-11-06 10:00:00', removed: false,
  }
}
const VOTERS = Array.from({ length: 24 }, (_, i) => voter(i, i % 5 === 4 ? 'Nay' : 'Aye'))

function comment(id: string, replies: unknown[] = [], body = `Comment ${id}`) {
  return {
    commentId: id, parentId: null, replyToId: null, author: { account: null, legacyName: `writer-${id}` }, body, bodyFormat: 'markdown',
    hidden: false, hiddenReason: null, deleted: false, createdAt: '2026-11-06T11:00:00.000Z', editedAt: null, revision: 0, upvotes: 0,
    source: null, position: null, media: {}, replies,
  }
}

async function install(page: Page, pallet: 'opengov' | 'democracy' = 'opengov') {
  await page.routeWebSocket(/hydration-rpc\.neckwork\.net/, ws => ws.close())
  const concluded = pallet === 'democracy'
  await page.route(/\/api\/explorer\/referendum\/(opengov|democracy)\/\d+(\?|$)/, route => json(route, {
    pallet, index: 371, title: TITLE, proposer: null, track: concluded ? null : 0, proposalHash: null, proposalCall: null,
    status: concluded ? 'not passed' : 'deciding', enactment: null,
    submittedAt: { blockHeight: 900, extrinsicIndex: 1, timestamp: '2026-11-05 10:00:00' },
    concludedAt: concluded ? { blockHeight: 2000, extrinsicIndex: null, timestamp: '2026-11-07 10:00:00' } : null,
    asset: HDX, onChainTally: null,
    directTally: { ayes: concluded ? '0' : '500000000000000000000', nays: '147249455136186080651', rawAyes: '0', rawNays: '0', support: '0', ayeVoters: concluded ? 0 : 19, nayVoters: 5, splitVoters: 0, voters: 24 },
    indirectTally: null, voters: VOTERS, votesShown: 24, votesTotal: 24,
    timeline: [{ event: concluded ? 'Democracy.Started' : 'Referenda.Submitted', blockHeight: 900, extrinsicIndex: 1, timestamp: '2026-11-05 10:00:00' }],
    trackInfo: concluded ? null : { id: 0, name: 'root', preparePeriod: 100, decisionPeriod: 100800, confirmPeriod: 7200, minEnactmentPeriod: 7200, decisionDeposit: '750000000000000000' },
    liveTally: null, progress: null,
    forum: { postId: `${pallet}:371`, threadKey: `${pallet}:371`, commentsCount: 9, upvotes: 0, hasDescription: true, authority: 'native', source: null },
  }))
  await page.route(/\/api\/explorer\/referendum\/[a-z]+\/\d+\/votes(\?|$)/, route => json(route, {
    total: VOTERS.length, totalAll: VOTERS.length, rows: VOTERS.map(v => ({ ...v })),
  }))
  await page.route(/\/api\/explorer\/referendum\/[a-z]+\/\d+\/tally-history(\?|$)/, route => json(route, { points: [], thresholds: [], concludedBlock: null }))
  await page.route(/\/api\/explorer\/forum\/post\/[a-z]+%3A371(\?|$)/, route => json(route, {
    postId: `${pallet}:371`, kind: pallet, title: TITLE, body: `# ${TITLE}\n\nThis proposal registers the facilitator.\n\n## Why\n\nBecause.`, bodyFormat: 'markdown', tldr: '', labels: [], linked: [],
    author: { account: null, legacyName: 'proposer' }, authority: 'native', revision: 0, createdAt: '2026-11-05T10:00:00.000Z', editedAt: null,
    lastActivityAt: '2026-11-05T10:00:00.000Z', commentsCount: 9, updatesCount: 0, upvotes: 0, threadKey: `${pallet}:371`, source: null, bannerCid: null, poll: null,
    media: {}, locked: false, hidden: false, generation: 'g1',
  }))
  const replies = ['r1', 'r2', 'r3', 'r4'].map(id => ({ ...comment(id), parentId: 'c1' }))
  await page.route(/\/api\/explorer\/forum\/thread\/[a-z]+%3A371(\?|$)/, route => json(route, {
    requested: `${pallet}:371`, threadKey: `${pallet}:371`, generation: 'g1', total: 5,
    rows: [comment('c1', replies), comment('c2'), comment('c3', [], Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long comment.`).join('\n\n')), comment('c4'), comment('c5')],
    updates: [], nextCursor: null, positionsComplete: null, locked: false,
  }))
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('the page reads lightly and keeps everything one step away', async ({ page }) => {
      await install(page)
      await page.goto('/referendum/opengov/371')
      await expect(page.locator('#description .gov-post-md')).toContainText('This proposal registers the facilitator')
      // The description's own opening heading repeated the page title; only the h1 says it now.
      await expect(page.getByRole('heading', { name: TITLE })).toHaveCount(1)
      await expect(page.locator('#description .gov-post-md h3, #description .gov-post-md h2').first()).toHaveText('Why')

      // The nav keeps the reading order: the timeline sits right after the description.
      const nav = (await page.locator('.gov-section-nav .gov-section-link').allInnerTexts()).map(t => t.replace(/\d+$/, '').trim())
      expect(nav).toEqual(['Description', 'Timeline', 'Status', 'Discussion', 'Votes', 'Details'])
      // Open, not folded, and directly after the description.
      const timeline = page.locator('#timeline')
      await expect(timeline.locator('.ref-timeline')).toBeVisible()
      await expect(timeline).toContainText('Submitted')
      expect(await page.locator('#description').evaluate(e => e.nextElementSibling?.id)).toBe('timeline')

      // "submitted …" in the meta line opens the extrinsic that submitted the referendum.
      await expect(page.locator('.gov-ref-meta .gov-ref-submitted')).toHaveAttribute('href', '/extrinsic/900-1')
      // The header carries no alert bell and no copy-link button.
      await expect(page.locator('.gov-ref-meta .gov-ref-actions')).toHaveCount(0)
      await expect(page.locator('.gov-ref-meta').getByRole('button')).toHaveCount(0)

      // Every voter, in the table with its filters, from the start; no legend under the map.
      await expect(page.getByRole('button', { name: /Show all \d+ voters/ })).toHaveCount(0)
      await expect(page.locator('.gov-bubbles-legend')).toHaveCount(0)
      await expect(page.getByRole('group', { name: 'Filter votes by side' })).toBeVisible()
      const tableRows = page.locator('.votes-tbl tbody tr')
      await expect(tableRows).toHaveCount(24)
      // On a phone a vote is one line, not a four-row card.
      if (viewport.name === 'phone') expect(await tableRows.first().evaluate(e => e.getBoundingClientRect().height)).toBeLessThan(48)

      // Three threads, two replies each, then the rest on request; a long comment shows its first lines.
      await expect(page.locator('.cmt-list > .cmt')).toHaveCount(3)
      const first = page.locator('.cmt-list > .cmt').first()
      await expect(first.locator('.cmt-replies > .cmt')).toHaveCount(2)
      await first.getByRole('button', { name: 'Show 2 more replies' }).click()
      await expect(first.locator('.cmt-replies > .cmt')).toHaveCount(4)
      // A long comment folds like the description: its opening under a fade, the faded
      // text itself the control (the keyboard's way in is the fade's button); a short one does not.
      const long = page.locator('#c-c3')
      await expect(long.locator('.gov-post-fold.clamped')).toHaveCount(1)
      await expect(long.getByRole('button', { name: 'Show the full text' })).toHaveCount(1)
      await expect(page.locator('#c-c2 .gov-post-fold.clamped')).toHaveCount(0)
      await long.locator('.cmt-md').click()
      await expect(long.locator('.gov-post-fold.clamped')).toHaveCount(0)
      await expect(long.locator('.cmt-md')).toContainText('Line 30 of a long comment.')
      await page.getByRole('button', { name: 'Show all 5 threads' }).click()
      await expect(page.locator('.cmt-list > .cmt')).toHaveCount(5)

      // The order menu holds the sort and the voters-only filter.
      await page.getByRole('button', { name: /Order of comments: Oldest/ }).click()
      const menu = page.getByRole('group', { name: 'Order and filter comments' })
      await expect(menu.getByRole('button', { name: 'Newest' })).toBeVisible()
      await expect(menu.getByRole('checkbox', { name: 'Voters only' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)

      // More details is closed until asked for; the nav's Details opens it.
      const details = page.locator('#details > details')
      await expect(details).not.toHaveAttribute('open', '')
      await page.locator('.gov-section-link', { hasText: 'Details' }).click()
      await expect(details).toHaveAttribute('open', '')
      await expect(details).toContainText('Decision deposit')

      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    })

    test('a Democracy referendum is read by its tally, never by approval and support', async ({ page }) => {
      await install(page, 'democracy')
      await page.goto('/referendum/democracy/371')
      const status = page.locator('#verdict')
      await expect(status).toContainText('Rejected')
      await expect(status).toContainText('0 aye, 147M nay votes')
      await expect(status).not.toContainText(/approval|support/i)
    })
  })
}
