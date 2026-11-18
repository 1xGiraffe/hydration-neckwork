import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures/test'

// Governance deposits without a chain: a referendum waiting for its decision deposit
// offers to place it (a neutral button; Vote stays the page's primary), a concluded
// one lists each deposit with its state and a Refund where the outcome allows one, an
// account lists its open deposits with one "Refund all", and a refund put in the cart
// is what the cart then signs. The wallet rejects every request and the node is
// unreachable, so nothing can be signed: the Sign button stays disabled and the
// wallet is never asked.

const FOLLOWED = '15393VqXBSpxYDXALvGxbaeZoHwfDmh3jgG2t2iGK9vSAx7K'
const FOLLOWED_ID = '0xb2927ffd2bbb0a73a317ab830e2dccd5e30cb0231c3ce7224be0f233b330742f'
const SIGNER = '15U8rqSKTZuNz1doFgiaiCzeRTbEpxmHGAPQi1nRc6oamXQV'
const HDX = { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: 2034 }
const ACCOUNT = { accountId: FOLLOWED_ID, address: FOLLOWED, emoji: '🦒', tag: null, identity: { display: 'Giraffe', verified: true }, profile: null }
const at = (b: number) => ({ blockHeight: b, extrinsicIndex: 2, timestamp: '2026-09-11T14:30:12.000Z' })

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

function referendum(index: number, preparing: boolean) {
  const sub = { index, kind: 'submission', who: FOLLOWED_ID, amount: '100000000000000', placedAt: at(1000), state: preparing ? 'held' : 'refundable', refundedAt: null, account: ACCOUNT }
  const dec = { index, kind: 'decision', who: FOLLOWED_ID, amount: '750000000000000000', placedAt: at(1100), state: 'refunded', refundedAt: at(9000), account: ACCOUNT }
  return {
    pallet: 'opengov', index, title: preparing ? 'Raise the HOLLAR cap' : 'Approve the WBTC listing', proposer: ACCOUNT, track: 9,
    proposalHash: null, proposalCall: null, status: preparing ? 'submitted' : 'approved', enactment: null,
    submittedAt: at(1000), concludedAt: preparing ? null : at(8000), asset: HDX, onChainTally: null,
    directTally: { ayes: '0', nays: '0', rawAyes: '0', rawNays: '0', support: '0', ayeVoters: 0, nayVoters: 0, splitVoters: 0, voters: 0 },
    indirectTally: null, voters: [], votesShown: 0, votesTotal: 0,
    timeline: [{ event: 'Referenda.Submitted', blockHeight: 1000, extrinsicIndex: 2, timestamp: '2026-09-11 14:30:12' }], timelineTruncated: false,
    trackInfo: { id: 9, name: 'economic_parameters', preparePeriod: 1800, decisionPeriod: 302400, confirmPeriod: 21600, minEnactmentPeriod: 300, decisionDeposit: '750000000000000000' },
    liveTally: null,
    progress: preparing ? {
      phase: 'preparing', decisionDepositPlaced: false, submittedBlock: 4000, decisionStartBlock: null, decisionEndBlock: null,
      confirmStartBlock: null, confirmEndBlock: null, earliestDecisionBlock: 5800, timeoutBlock: 90_400, approval: null, support: null, projection: null,
    } : null,
    forum: null,
    deposits: { index, status: preparing ? 'submitted' : 'approved', needsDecisionDeposit: preparing, submission: sub, decision: preparing ? null : dec },
  }
}

const refDeposit = (index: number, kind: 'submission' | 'decision', state: string, amount = '100000000000000') =>
  ({ index, kind, who: FOLLOWED_ID, amount, placedAt: at(1000), state, refundedAt: null, status: state === 'held' ? 'deciding' : 'approved', title: `Referendum title ${index}` })

const ACCOUNT_DEPOSITS = {
  referenda: [
    refDeposit(450, 'submission', 'held'),
    refDeposit(404, 'submission', 'refundable'),
    refDeposit(398, 'decision', 'refundable', '750000000000000000'),
    refDeposit(390, 'submission', 'refundable'),
    refDeposit(200, 'submission', 'kept'),
  ],
  preimages: [
    { hash: '0x83e892ce7481986830f8b0ead67944e7fe0de6854a8aa9fa61be233a1ba20cb0', owner: FOLLOWED_ID, amount: '436690000000000', len: 1159, requested: false, usedBy: [{ index: 404, status: 'approved' }], refundable: true, blocked: null, legacy: true },
    { hash: '0x9dc4c5144f7826b96d3b32c7c76156e59ce940242a1c0c06db85258f1e084f12', owner: FOLLOWED_ID, amount: '410500000000000', len: 286, requested: false, usedBy: [{ index: 450, status: 'deciding' }], refundable: false, blocked: 'Referendum #450 still needs this call: removing it now would leave nothing to enact.' },
  ],
  preimagesAsOfBlock: 5000,
  totals: { held: '751447190000000000', refundable: '750636690000000000' },
}

async function setup(page: Page) {
  await page.routeWebSocket(/hydration-rpc\.neckwork\.net/, ws => ws.close())
  await page.route(/hydration-rpc\.neckwork\.net/, route => route.abort())
  await page.route(/\/api\/explorer\/referendum\/opengov\/451(\?|$)/, route => json(route, referendum(451, true)))
  await page.route(/\/api\/explorer\/referendum\/opengov\/404(\?|$)/, route => json(route, referendum(404, false)))
  await page.route(/\/api\/explorer\/referendum\/opengov\/\d+\/tally-history/, route => json(route, { points: [], thresholds: [], concludedBlock: null }))
  await page.route(/\/api\/explorer\/governance\/clock/, route => json(route, { headBlock: 5000, headTs: new Date().toISOString(), msPerBlock: 2000, nominalMsPerBlock: 2000, source: 'measured', window: { fromBlock: 1, toBlock: 5000 } }))
  await page.route(/\/api\/explorer\/governance\/needs-vote/, route => json(route, { asOfBlock: 5000, referenda: [], accounts: [{ input: FOLLOWED, accountId: FOLLOWED_ID, needsVote: [], voted: [], delegated: [] }] }))
  await page.route(/\/api\/explorer\/address\/[^/]+\/governance(\?|$)/, route => json(route, {
    account: ACCOUNT, related: [FOLLOWED_ID], asOfBlock: 5000, votes: [], classes: [], locks: [],
    delegations: { in: [], out: [] }, proxies: { canActFor: [], actedForBy: [], pure: null },
    history: { referendaVoted: 3, lastVote: null, lastStandardVote: null, source: 'voting-state+direct-calls', observedFrom: 1 },
    forum: { posts: 0, comments: 0, upvotesReceived: 0 }, deposits: ACCOUNT_DEPOSITS, gigahdxPendingRewards: null,
  }))
  await page.addInitScript(([k, a, signer]) => {
    localStorage.setItem(k, JSON.stringify([a]))
    const w = window as unknown as { __signRequests: unknown[]; injectedWeb3: unknown }
    w.__signRequests = []
    const accounts = [{ address: signer, name: 'Signer', type: 'sr25519' }]
    w.injectedWeb3 = {
      talisman: {
        enable: async () => ({
          accounts: { get: async () => accounts },
          signer: {
            signPayload: async (p: unknown) => { w.__signRequests.push(p); throw new Error('Rejected') },
            signRaw: async (p: unknown) => { w.__signRequests.push(p); throw new Error('Rejected') },
          },
        }),
      },
    }
  }, ['explorer-gov-watch', FOLLOWED, SIGNER] as [string, string, string])
}

const signRequests = (page: Page) => page.evaluate(() => (window as unknown as { __signRequests: unknown[] }).__signRequests.length)
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('a referendum waiting for its decision deposit offers to place it, neutral beside Vote', async ({ page }) => {
      await setup(page)
      await page.goto('/referendum/opengov/451')
      const place = page.locator('#verdict').getByRole('button', { name: 'Place decision deposit (750k HDX)' })
      await expect(place).toBeVisible()
      await expect(place).not.toHaveClass(/gov-btn-primary/)
      await expect(page.locator('#verdict')).toContainText('Anyone can place it')
      expect(await overflow(page)).toBeLessThanOrEqual(1)

      await place.click()
      const sheet = page.locator('.vote-sheet')
      await expect(sheet.locator('.vote-sheet-title')).toHaveText('Place the decision deposit')
      await sheet.getByRole('button', { name: 'Connect a wallet' }).click()
      await sheet.locator('.wallet-tile', { hasText: 'Talisman' }).click()
      await sheet.getByRole('button', { name: 'Continue' }).click()
      await expect(sheet.locator('.action-list')).toContainText('Place the decision deposit of #451')
      await expect(sheet.locator('.action-list')).toContainText('750,000 HDX')
      // No node: nothing is checked, so nothing can be signed.
      await expect(sheet.locator('.vote-sign')).toBeDisabled()
      expect(await signRequests(page)).toBe(0)
    })

    test('a concluded referendum lists its deposits once, with a refund where the outcome allows one', async ({ page }) => {
      await setup(page)
      await page.goto('/referendum/opengov/404')
      const lines = page.locator('#verdict .gov-dep-line')
      await expect(lines).toHaveCount(2)
      await expect(lines.nth(0)).toContainText('Submission deposit · 100 HDX · refundable')
      await expect(lines.nth(1)).toContainText('Decision deposit · 750k HDX · refunded')
      await expect(lines.nth(1).getByRole('button')).toHaveCount(0)
      // The verdict's own deposit sentence is not said again.
      await expect(page.locator('#verdict')).not.toContainText('reclaimable by whoever placed it')

      // More details names the depositor and when it came back.
      await page.locator('.gov-section-link', { hasText: 'Details' }).click()
      await expect(page.locator('#details .gov-dep-fact')).toHaveCount(2)
      await expect(page.locator('#details .gov-dep-fact').first()).toContainText('Giraffe')

      // Add to cart: the cart button appears and its sheet lists the refund.
      await lines.nth(0).getByRole('button', { name: 'Add to cart' }).click()
      await expect(lines.nth(0).getByRole('button', { name: 'In cart' })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.vote-cart-fab')).toContainText('1 action in cart')
      await page.locator('.vote-cart-fab').click()
      const sheet = page.locator('.vote-sheet')
      await expect(sheet.locator('.vote-sheet-title')).toHaveText('Cart')
      await sheet.getByRole('button', { name: 'Connect a wallet' }).click()
      await sheet.locator('.wallet-tile', { hasText: 'Talisman' }).click()
      await sheet.getByRole('button', { name: 'Continue' }).click()
      await expect(sheet.locator('.action-list')).toContainText('Refund the submission deposit of #404')
      await expect(sheet.locator('.vote-sign')).toBeDisabled()
      expect(await signRequests(page)).toBe(0)
      expect(await overflow(page)).toBeLessThanOrEqual(1)
    })

    test('an account lists its open deposits with one Refund all', async ({ page }) => {
      await setup(page)
      await page.goto('/governance/me')
      const sec = page.locator('.gov-deposits-sec')
      // What the chain keeps for good (a rejected referendum's submission deposit) is said apart from what is held.
      await expect(sec.getByRole('heading', { name: /Deposits/ })).toContainText('751k HDX held · 100 HDX kept by the chain')
      // Five rows, then the rest on request.
      await expect(sec.locator('.gov-dep-row')).toHaveCount(5)
      await sec.getByRole('button', { name: 'Show 2 more' }).click()
      await expect(sec.locator('.gov-dep-row')).toHaveCount(7)
      // A preimage a running referendum still needs has no Refund.
      const needed = sec.locator('.gov-dep-row', { hasText: '0x9dc4…4f12' })
      await expect(needed).toContainText('stays while #450 runs')
      await expect(needed.getByRole('button', { name: 'Refund' })).toHaveCount(0)
      // A preimage noted under the pallet's older storage is refunded the same way, and says so.
      await expect(sec.locator('.gov-dep-row', { hasText: '0x83e8…0cb0' })).toContainText('old format')
      const kept = sec.locator('.gov-dep-row', { hasText: '#200' })
      await expect(kept).toContainText('kept by the chain')
      await expect(kept.getByRole('button')).toHaveCount(0)

      // Refund all: the three refundable referendum deposits and the free preimage, one signature.
      const all = sec.getByRole('button', { name: /^Refund all \(4 · / })
      await expect(all).not.toHaveClass(/gov-btn-primary/)
      await all.click()
      const sheet = page.locator('.vote-sheet')
      await expect(sheet.locator('.vote-sheet-title')).toHaveText('Refund deposits')
      await sheet.getByRole('button', { name: 'Connect a wallet' }).click()
      await sheet.locator('.wallet-tile', { hasText: 'Talisman' }).click()
      await sheet.getByRole('button', { name: 'Continue' }).click()
      // The preimage is its owner's to unnote, and no connected account is its owner.
      await expect(sheet).toContainText('Only the account that stored this preimage')
      expect(await signRequests(page)).toBe(0)
      expect(await overflow(page)).toBeLessThanOrEqual(1)
    })
  })
}
