import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures/test'

const ACCOUNT = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'
const CANDIDATE = '0xF73a2B8c1D4e9A06b5C8f2E1a3D70c9B4e6F18aD'

function detailFor(address: string) {
  const evm = /^0x[0-9a-f]{40}$/i.test(address)
  const accountId = evm
    ? `0x45544800${address.slice(2).toLowerCase()}0000000000000000`
    : '0xaa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899'
  return {
    input: address, kind: evm ? 'evm' : 'ss58', accountId, emoji: '🦊', evmAddress: evm ? address : null,
    ss58: evm ? ACCOUNT : address, ss58Polkadot: evm ? ACCOUNT : address,
    tag: null, identity: null, relatedAccountIds: [accountId], aliases: [], balances: [], portfolioUsd: 0,
    moneyMarket: [], liquidityPositions: [], activeDcas: [], proxy: null, multisig: null,
    multisigMemberships: [], portfolioSeries: [], portfolioDates: [], balanceHistory: [],
  }
}

async function installAccountRoutes(page: Page, closeHandler: (route: Route, address: string) => Promise<void>) {
  await page.route('**/api/explorer/address/**', async route => {
    const path = new URL(route.request().url()).pathname
    const tail = path.slice(path.indexOf('/api/explorer/address/') + '/api/explorer/address/'.length)
    const suffix = ['/close-accounts', '/history', '/counts'].find(value => tail.endsWith(value)) ?? ''
    const address = decodeURIComponent(suffix ? tail.slice(0, -suffix.length) : tail)
    if (suffix === '/close-accounts') return closeHandler(route, address)
    if (suffix === '/history') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ portfolioSeries: [], portfolioDates: [], balanceHistory: [] }) })
    if (suffix === '/counts') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ extrinsics: 0, events: 0, activity: 0 }) })
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detailFor(address)) })
  })
}

function closeResponse() {
  return {
    accounts: [{
      account: {
        accountId: `0x45544800${CANDIDATE.slice(2).toLowerCase()}0000000000000000`, address: CANDIDATE, emoji: '🦑',
        tag: { id: 'kraken', name: 'Kraken', color: '#7b6cf6', icon: '/tag-icons/kraken.jpg' },
      },
      score: 0.91, confidence: 'strong', lastSeen: '2026-07-09 18:42:00',
      reasons: [
        { type: 'direct_transfers', count: 7, days: 4, valueUsd: 128_400, bidirectional: true },
        { type: 'near_signing', days: 9 },
      ],
    }],
    lookbackDays: null,
    disclaimer: 'Behavioral signals are not proof of common ownership.',
  }
}

test('close accounts loads only after keyboard disclosure and resets on address change', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const requested: string[] = []
  await installAccountRoutes(page, async (route, address) => {
    requested.push(address)
    await new Promise(resolve => setTimeout(resolve, 220))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(closeResponse()) })
  })

  await page.goto(`/account/${ACCOUNT}`)
  const disclosure = page.locator('.close-accounts')
  const summary = disclosure.locator('summary')
  await expect(summary).toBeVisible()
  expect(requested).toHaveLength(0)

  await summary.focus()
  await summary.press('Enter')
  await expect(disclosure).toHaveAttribute('open', '')
  await expect(page.getByText('Comparing activity signals…')).toBeVisible()
  await expect(page.getByText('7 direct transfers · $128.4k across 4 days · both directions')).toBeVisible()
  await expect(page.getByText('strong signal')).toBeVisible()
  await expect(page.getByText('Behavioral signals are not proof of common ownership.')).toBeVisible()
  expect(requested).toEqual([ACCOUNT])

  const candidateLink = disclosure.locator(`a[href="/account/${CANDIDATE}"]`)
  await expect(candidateLink).toBeVisible()
  await expect(disclosure.locator('a[href="/tag/kraken"]')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

  await candidateLink.click()
  await expect(page).toHaveURL(new RegExp(`/account/${CANDIDATE}$`, 'i'))
  await expect(page.locator('.close-accounts')).not.toHaveAttribute('open', '')
  expect(requested).toHaveLength(1)

  const nextSummary = page.locator('.close-accounts > summary')
  await nextSummary.focus()
  await nextSummary.press('Enter')
  await expect.poll(() => requested.length).toBe(2)
  expect(requested[1].toLowerCase()).toBe(CANDIDATE.toLowerCase())
})

test('close accounts distinguishes errors from empty results and supports retry', async ({ page }) => {
  let attempts = 0
  await installAccountRoutes(page, async route => {
    attempts++
    if (attempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporarily unavailable' }) })
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ accounts: [], lookbackDays: null, disclaimer: 'Behavioral signals are not proof of common ownership.' }),
    })
  })

  await page.goto(`/account/${ACCOUNT}`)
  await page.locator('.close-accounts > summary').click()
  await expect(page.getByRole('alert')).toContainText('Couldn’t load close accounts')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText('No sufficiently strong links found')).toBeVisible()
  await expect(page.getByText('No account passed the false-positive safeguards across the indexed history.')).toBeVisible()
  expect(attempts).toBe(2)
})

test('tag pages surface close accounts for the whole group', async ({ page }) => {
  await page.goto('/tag/kraken')
  const section = page.locator('.close-accounts')
  await expect(section).toBeVisible()
  await section.locator('summary').click()
  await expect(section.locator('.close-account-match')).toHaveCount(2)
  await expect(section).toContainText('strong signal')
})
