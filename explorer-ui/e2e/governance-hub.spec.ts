import type { Route } from '@playwright/test'
import { expect, test } from './fixtures/test'

// The governance hub: each live card carries the reader's own state (how a followed
// account voted, or a Vote button), the hub links are one footer line, an empty
// "Coming up" is hidden, and the archive shows one collection at a time.

const FOLLOWED = '15393VqXBSpxYDXALvGxbaeZoHwfDmh3jgG2t2iGK9vSAx7K'
const FOLLOWED_ID = '0xb2927ffd2bbb0a73a317ab830e2dccd5e30cb0231c3ce7224be0f233b330742f'

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

const progress = (phase: 'confirming' | 'deciding', approval: number, support: number) => ({
  phase, decisionDepositPlaced: true, submittedBlock: 1000, decisionStartBlock: 2000, decisionEndBlock: 300_000,
  confirmStartBlock: phase === 'confirming' ? 10_000 : null, confirmEndBlock: phase === 'confirming' ? 30_000 : null,
  earliestDecisionBlock: null, timeoutBlock: null,
  approval: { currentPerbill: approval, thresholdPerbill: 800_000_000, passing: approval >= 800_000_000, source: 'chain' },
  support: { currentPerbill: support, thresholdPerbill: 150_000_000, passing: support >= 150_000_000, source: 'chain' },
  projection: { state: phase === 'confirming' ? 'passing' : 'on-track', confirmableAtBlock: phase === 'confirming' ? null : 25_000 },
})

const card = (index: number, title: string, phase: 'confirming' | 'deciding', track: { id: number; name: string }) => ({
  index, title, status: phase, track, proposer: null,
  submittedAt: { blockHeight: 1000, extrinsicIndex: 2, timestamp: '2026-11-06 10:10:18' },
  progress: progress(phase, 950_000_000, phase === 'confirming' ? 160_000_000 : 120_000_000),
  tally: { ayes: '3000000000000000000000', nays: '40000000000000000000', support: '600000000000000000000', source: 'live' },
})

const discussion = (n: number) => ({
  postId: `s${n}`, title: `Discussion ${n}`, excerpt: 'An excerpt that the overview leaves out.', labels: [], linked: [], hasPoll: false,
  author: { account: { accountId: FOLLOWED_ID, address: FOLLOWED, emoji: '🦒', tag: null, identity: { display: 'Giraffe', verified: true }, profile: null }, legacyName: null },
  createdAt: '2026-10-01T10:00:00.000Z', lastActivityAt: '2026-11-01T10:00:00.000Z', commentsCount: n, upvotes: 0,
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript(([k, a]) => { localStorage.setItem(k, JSON.stringify([a])) }, ['explorer-gov-watch', FOLLOWED])
  const now = Date.now()
  await page.route(/\/api\/explorer\/governance(\?|$)/, route => json(route, {
    active: [card(450, 'Register the HOLLAR PSM', 'confirming', { id: 9, name: 'economic_parameters' }), card(448, 'List NEAR in the money market', 'deciding', { id: 0, name: 'root' })],
    counts: { opengov: 451, democracy: 208, tcMotions: 422, councilMotions: 232, tips: 164 },
    discussions: [1, 2, 3, 4, 5].map(discussion),
    endingSoon: [],
  }))
  await page.route(/\/api\/explorer\/governance\/clock/, route => json(route, { headBlock: 5000, headTs: new Date(now).toISOString(), msPerBlock: 6000, nominalMsPerBlock: 6000, source: 'measured', window: { fromBlock: 1, toBlock: 5000 } }))
  await page.route(/\/api\/explorer\/governance\/needs-vote/, route => json(route, {
    asOfBlock: 5000,
    referenda: [
      { index: 448, title: 'List NEAR in the money market', track: { id: 0, name: 'root' }, status: 'deciding', ends: { kind: 'decision-end', at: { block: 300_000, ts: new Date(now + 4 * 86_400_000).toISOString(), exact: false } } },
    ],
    accounts: [{ input: FOLLOWED, accountId: FOLLOWED_ID, needsVote: [448], voted: [{ index: 450, side: 'Aye', conviction: 6, balance: '1000000000000000' }], delegated: [] }],
  }))
  await page.route(/\/api\/explorer\/governance\/calendar\?/, route => json(route, { from: '', to: '', asOfBlock: 5000, events: [] }))
})

test('a live card shows how the reader voted, or a Vote button; the rest of the hub stays quiet', async ({ page }) => {
  await page.goto('/governance')
  await expect(page.locator('.detail-tabs button')).toHaveText([/^Overview/, /^Referenda/, /^Committee/, /^Archive/, /^Stats/])

  const voted = page.locator('.gov-card', { hasText: 'Register the HOLLAR PSM' })
  await expect(voted.locator('.gov-card-voted')).toHaveText('Voted Aye 6×')
  await expect(voted.getByRole('button', { name: 'Vote' })).toHaveCount(0)
  const open = page.locator('.gov-card', { hasText: 'List NEAR in the money market' })
  // A card the reader still has to vote on carries the Vote button in the vote lavender.
  await expect(open.getByRole('button', { name: 'Vote' })).toHaveClass(/gov-btn-primary/)
  await expect(page.locator('.gov-card .proposer, .gov-card-proposer')).toHaveCount(0)

  await expect(page.getByRole('button', { name: 'Alert me about new referenda' })).toBeVisible()
  // Discussions: four, title and one meta line, no excerpt.
  await expect(page.locator('.gov-disc.compact')).toHaveCount(4)
  await expect(page.locator('.gov-disc-excerpt')).toHaveCount(0)
  // Nothing scheduled: no "Coming up" heading.
  await expect(page.getByRole('heading', { name: 'Coming up' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'More governance' }).getByRole('link')).toHaveText(['My governance', 'Discussions', 'New proposal', 'Referenda feed'])

  // The card's title is its link; the Vote button beside it is not inside it.
  await expect(open.locator('a .gov-btn, a button')).toHaveCount(0)
  await open.getByRole('link', { name: 'List NEAR in the money market' }).click()
  await expect(page).toHaveURL(/\/referendum\/opengov\/448$/)
})

test('the Terms fold replaces the in-flow explainers', async ({ page }) => {
  await page.goto('/governance')
  await expect(page.getByText('What are approval and support?')).toHaveCount(0)
  const terms = page.locator('details.gov-terms')
  await expect(terms).toHaveCount(1)
  await terms.locator('summary').click()
  await expect(terms.locator('dt')).toContainText(['Approval', 'Support'])
})

test('the archive shows one collection at a time, with a table where the chain keeps one', async ({ page }) => {
  await page.route(/\/api\/explorer\/forum\/discussions\?/, route => {
    const kind = new URL(route.request().url()).searchParams.get('kind')
    return json(route, { generation: 'g', total: kind === 'council' ? 232 : 3, rows: kind === 'council' ? [{ ...discussion(7), postId: 'council:7', title: 'Council motion 7' }] : [], nextCursor: null })
  })
  await page.route(/\/api\/explorer\/governance\/motions\?/, route => json(route, { total: 0, rows: [] }))
  await page.goto('/governance?tab=archive&kind=council')
  const chips = page.getByRole('group', { name: 'Collection' })
  await expect(chips.getByRole('button', { name: /^Council motions/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(chips.getByRole('button', { name: /^Council motions/ })).toContainText('232')
  await expect(page.getByRole('link', { name: 'Council motion 7' })).toBeVisible()
  // Only the selected collection is on the page: no stacked Democracy/Tips sections.
  await expect(page.getByRole('heading', { name: /Treasury tips/ })).toHaveCount(0)

  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Table' }).click()
  await expect(page).toHaveURL(/show=table/)
  await expect(page.getByText('No motions')).toBeVisible()

  // A collection with records only has no List/Table toggle.
  await chips.getByRole('button', { name: /^External/ }).click()
  await expect(page).toHaveURL(/kind=external/)
  await expect(page.getByRole('group', { name: 'View' })).toHaveCount(0)
})

test('the Stats tab reads light: a ribbon, three charts and the pass rates, loaded only when asked for', async ({ page }) => {
  const statsCalls: string[] = []
  await page.route(/\/api\/explorer\/governance\/stats/, route => {
    statsCalls.push(route.request().url())
    const months = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11']
    return json(route, {
      asOf: new Date().toISOString(),
      turnout: [1, 2, 3, 4, 5].map(i => ({ index: 440 + i, track: 0, status: 'approved', concludedAt: `2026-10-0${i} 10:00:00`, submittedAt: `2026-09-2${i} 10:00:00`, voters: 100 + i * 20, ayeVoters: 90, nayVoters: 10, splitVoters: 0, ayeCapital: '1000000000000000000000', nayCapital: '5000000000000000000', support: '1000000000000000000000' })),
      activeVoters: months.map((m, i) => ({ month: m, voters: 200 + i * 40, votes: 3000 + i })),
      locked: { now: '1700000000000000000000', accounts: 1346, since: 15622703, weekly: [{ week: '2026-10-12', locked: '1680000000000000000000', accounts: 1350 }, { week: '2026-10-19', locked: '1690000000000000000000', accounts: 1348 }, { week: '2026-10-26', locked: '1700000000000000000000', accounts: 1346 }] },
      tracks: [{ id: 0, name: 'root', approved: 91, rejected: 1, cancelled: 4, timedOut: 3, killed: 0, ongoing: 1, passRate: 91 / 92 }, { id: 5, name: 'treasurer', approved: 20, rejected: 4, cancelled: 0, timedOut: 1, killed: 0, ongoing: 0, passRate: 20 / 24 }],
    })
  })
  await page.goto('/governance')
  await expect(page.locator('.gov-card').first()).toBeVisible()
  expect(statsCalls).toHaveLength(0)
  await page.locator('.detail-tabs button', { hasText: /^Stats/ }).click()
  await expect(page).toHaveURL(/tab=stats/)
  await expect(page.locator('.gov-stats .ribbon .cell')).toHaveCount(4)
  await expect(page.locator('.gov-stats .ribbon')).toContainText('1.7B HDX')
  await expect(page.locator('.stats-turnout circle')).toHaveCount(5)
  await expect(page.getByRole('heading', { name: /Active voters/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: /HDX locked in votes/ })).toContainText('15,622,703')
  await expect(page.locator('.stats-pass tbody tr')).toHaveCount(2)
  // One Terms fold, which says why support is not shown for past referenda.
  const terms = page.locator('details.gov-terms')
  await expect(terms).toHaveCount(1)
  await terms.locator('summary').click()
  await expect(terms).toContainText('active issuance is not indexed')
})

test('every card still needing a vote shows the same Vote button', async ({ page }) => {
  await page.route(/\/api\/explorer\/governance\/needs-vote/, route => json(route, {
    asOfBlock: 5000,
    referenda: [450, 448].map(index => ({ index, title: null, track: { id: 0, name: 'root' }, status: 'deciding', ends: null })),
    accounts: [{ input: FOLLOWED, accountId: FOLLOWED_ID, needsVote: [448, 450], voted: [], delegated: [] }],
  }))
  await page.goto('/governance')
  const votes = page.locator('.gov-card').getByRole('button', { name: 'Vote' })
  await expect(votes).toHaveCount(2)
  for (const b of await votes.all()) await expect(b).toHaveClass(/gov-btn-primary/)
})

test('the referenda tab has no status or track filter, and its feed popover opens above the table', async ({ page }) => {
  await page.route(/\/api\/explorer\/governance\/referenda\?/, route => json(route, {
    total: 2,
    rows: [450, 448].map(index => ({ pallet: 'opengov', index, title: `Referendum ${index}`, status: 'deciding', track: { id: 0, name: 'root' }, blockHeight: 1000, timestamp: '2026-11-06 10:10:18', commentsCount: 0, enactment: null })),
  }))
  await page.goto('/governance?tab=referenda')
  await expect(page.locator('.gov-list-tbl tbody tr')).toHaveCount(2)
  await expect(page.locator('.gov-filters select')).toHaveCount(0)
  await page.getByRole('button', { name: 'Referenda feed' }).click()
  const pop = page.locator('.gov-pop')
  await expect(pop).toBeVisible()
  // Whatever sits under the popover's middle is the popover, not the table after it.
  const onTop = await pop.evaluate(el => {
    const r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height - 8))
  })
  expect(onTop).toBe(true)
})

test('the tracks, calendar and treasury pages are gone, with nothing pointing at them', async ({ page }) => {
  for (const path of ['/governance/tracks', '/governance/tracks/0', '/governance/calendar', '/governance/treasury', '/calendar']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  }
  await page.goto('/governance')
  await expect(page.locator('a[href^="/governance/tracks"], a[href^="/governance/calendar"], a[href="/governance/treasury"], a[href^="/governance/treasury#"]')).toHaveCount(0)
})
