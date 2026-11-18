import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures/test'

// My governance with a wallet whose extension hands its accounts over in the generic
// SS58 format ("5…"): every account shows, links and filters in the Polkadot format
// the rest of the explorer uses, an account followed in another spelling is not
// listed twice, the menu's count is the "Needs your vote" list's length, and
// narrowing to one account says what the others still have to vote on.

const MAIN = '15393VqXBSpxYDXALvGxbaeZoHwfDmh3jgG2t2iGK9vSAx7K'
const MAIN_GENERIC = '5G6quAaTKfZV6gWePHDxTRpQwfx1XU8ufBXYijium4tuzNYC'
const MAIN_ID = '0xb2927ffd2bbb0a73a317ab830e2dccd5e30cb0231c3ce7224be0f233b330742f'
const PROXY = '13dxxbqUHL7YJPyFnyo9pPuACoiZZtifHMUr1sSZ6RkXcbRU'
const PROXY_GENERIC = '5EhfpGaQRYr4rrxjqLk9gF51MBiusbAXCrkMraTCYLj1SGHq'
const PROXY_ID = '0x74a9accd4e9b0d530c7047e0ede0a6b1d1d8ba5ccc8827c47f09ffa7fe95c33c'

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

async function setup(page: Page) {
  await page.routeWebSocket(/hydration-rpc\.neckwork\.net/, ws => ws.close())
  await page.route(/hydration-rpc\.neckwork\.net/, route => route.abort())
  await page.addInitScript(([main, proxy]) => {
    const accounts = [{ address: main, name: 'Main', type: 'sr25519' }, { address: proxy, name: 'Voter', type: 'sr25519' }]
    const w = window as unknown as { injectedWeb3: unknown }
    w.injectedWeb3 = {
      talisman: {
        enable: async () => ({
          accounts: { get: async () => accounts },
          signer: { signPayload: async () => { throw new Error('Rejected') }, signRaw: async () => { throw new Error('Rejected') } },
        }),
      },
    }
    // Remembered from an earlier visit in the wallet's own spelling, and the main
    // account also followed in that spelling.
    localStorage.setItem('explorer-chain-wallets', JSON.stringify({ wallets: [{
      entry: { id: 'substrate:talisman', kind: 'substrate', key: 'talisman', name: 'Talisman', icon: '' },
      accounts: accounts.map(a => ({ id: `substrate:talisman|${a.address}`, walletId: 'substrate:talisman', walletName: 'Talisman', walletIcon: '', kind: 'substrate', address: a.address, name: a.name })),
    }] }))
    localStorage.setItem('explorer-gov-watch', JSON.stringify([main]))
  }, [MAIN_GENERIC, PROXY_GENERIC] as [string, string])
  const ends = { kind: 'decision-end', at: { block: 300_000, ts: new Date(Date.now() + 4 * 86_400_000).toISOString(), exact: false } }
  await page.route(/\/api\/explorer\/governance\/needs-vote/, route => {
    const asked = (route.request().postDataJSON() as { accounts: string[] }).accounts
    return json(route, {
      asOfBlock: 5000,
      referenda: [{ index: 450, title: 'Register the HOLLAR PSM', track: { id: 9, name: 'economic_parameters' }, status: 'confirming', ends }, { index: 448, title: 'List NEAR in the money market', track: { id: 0, name: 'root' }, status: 'deciding', ends }],
      accounts: asked.map(input => input === PROXY
        ? { input, accountId: PROXY_ID, needsVote: [], voted: [{ index: 448, side: 'Aye', conviction: 1, balance: '1' }, { index: 450, side: 'Aye', conviction: 1, balance: '1' }], delegated: [] }
        : { input, accountId: input === MAIN ? MAIN_ID : null, needsVote: input === MAIN ? [448, 450] : [], voted: [], delegated: [] }),
    })
  })
  await page.route(/\/api\/explorer\/address\/[^/]+\/governance/, route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Address not recognized"}' }))
  await page.route(/\/api\/explorer\/account-refs/, route => json(route, []))
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('wallet accounts show in the explorer format, once each, and the menu counts what the page lists', async ({ page }) => {
      await setup(page)
      await page.goto('/governance/me')
      const chips = page.getByRole('group', { name: 'Accounts in view' })
      // All, then the main account and the voter: the followed copy of the main account is the same account.
      await expect(chips.getByRole('button')).toHaveCount(3)
      await expect(chips).toContainText('15393')
      await expect(page.locator('.gov-me')).not.toContainText('5G6qu')
      await expect(page.locator('.gov-me')).not.toContainText('5Ehfp')

      const needs = page.locator('.gov-needs')
      await expect(needs.locator('.gov-needs-row')).toHaveCount(2)
      // Both Vote buttons look alike.
      for (const b of await needs.getByRole('button', { name: 'Vote' }).all()) await expect(b).toHaveClass(/gov-btn-primary/)
      await expect(page.locator('.nav-count').first()).toHaveAttribute('title', '2 referenda need your vote')

      // The voter's chip narrows to it (in the URL as the explorer spells it), and the
      // page says the other account still has two to vote on.
      await chips.getByRole('button', { name: /Voter/ }).click()
      await expect(page).toHaveURL(new RegExp(`account=${PROXY}`))
      await expect(page.locator('.gov-needs-elsewhere')).toHaveText(/2 more referenda need a vote from your other accounts/)
      await page.getByRole('button', { name: 'Show all accounts' }).click()
      await expect(page).not.toHaveURL(/account=/)
      await expect(needs.locator('.gov-needs-row')).toHaveCount(2)
    })

    test('the wallet dialog makes no claim about EVM gas', async ({ page }) => {
      await setup(page)
      await page.goto('/governance/me')
      await page.getByRole('button', { name: 'Manage accounts' }).click()
      await expect(page.locator('.gov-manage .gov-pop')).toContainText('15393')
      await expect(page.locator('.gov-manage .gov-pop')).not.toContainText('5G6qu')
      await page.getByRole('button', { name: 'Manage wallets' }).click()
      const sheet = page.locator('.vote-sheet')
      await expect(sheet).toContainText('Ethereum wallets')
      await expect(sheet).not.toContainText('Using MetaMask')
      await expect(sheet).not.toContainText('no gas')
    })
  })
}
