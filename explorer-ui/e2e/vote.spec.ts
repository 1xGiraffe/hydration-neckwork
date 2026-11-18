import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'

// The voting sheets without a chain: the referendum's Vote button opens the
// composer, a wallet connects without signing anything, an Ethereum key inside a
// Polkadot extension is listed as unable to sign, the cart keeps its draft across a
// reload, and with the node unreachable nothing can be signed — the Sign button
// stays disabled and the wallet is never asked. The sheet is usable from the
// keyboard, keeps its explanations in one closed Details, and the cart button
// shows only on the pages votes are made from. The chain-backed flows (fee,
// dry-run, the exact call each one signs) are in vote-chain.spec.ts.

const VOTER = '15U8rqSKTZuNz1doFgiaiCzeRTbEpxmHGAPQi1nRc6oamXQV'
const ETH_IN_EXTENSION = '0x1234567890abcdef1234567890abcdef12345678'

async function setup(page: Page) {
  // No node in a browser test: every chain read fails fast.
  await page.routeWebSocket(/hydration-rpc\.neckwork\.net/, ws => ws.close())
  await page.route(/hydration-rpc\.neckwork\.net/, route => route.abort())
  await page.route(/\/api\/explorer\/referendum\/opengov\/450(\?|$)/, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      pallet: 'opengov', index: 450, title: 'Register the HOLLAR PSM',
      track: 9, proposalHash: null, proposalCall: null, status: 'deciding', enactment: null, submittedAt: null, concludedAt: null,
      asset: { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: 2034 },
      onChainTally: null,
      directTally: { ayes: '0', nays: '0', rawAyes: '0', rawNays: '0', support: '0', ayeVoters: 0, nayVoters: 0, splitVoters: 0, voters: 0 },
      indirectTally: null, voters: [], votesShown: 0, votesTotal: 0, timeline: [], trackInfo: null, liveTally: null,
      progress: {
        phase: 'deciding', decisionDepositPlaced: true, submittedBlock: 16_685_021, decisionStartBlock: 16_737_920, decisionEndBlock: 17_040_320,
        confirmStartBlock: null, confirmEndBlock: null, earliestDecisionBlock: null, timeoutBlock: null, approval: null, support: null, projection: null,
      },
    }),
  }))
  await page.addInitScript(([voter, eth]) => {
    const w = window as unknown as { __signRequests: unknown[]; injectedWeb3: unknown }
    w.__signRequests = []
    const accounts = [{ address: voter, name: 'Voter', type: 'sr25519' }, { address: eth, name: 'Eth key', type: 'ethereum' }]
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
  }, [VOTER, ETH_IN_EXTENSION] as [string, string])
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('Vote opens the composer, connects a wallet without signing, and never signs without a chain', async ({ page }) => {
      await setup(page)
      await page.goto('/referendum/opengov/450')
      const entry = viewport.name === 'phone' ? page.locator('.gov-mobile-bar .gov-vote-btn') : page.locator('.gov-ref-aside .gov-vote-btn')
      await entry.click()
      const sheet = page.locator('.vote-sheet')
      await expect(sheet).toContainText('Vote on #450')
      await sheet.getByRole('button', { name: 'Connect a wallet' }).click()
      await sheet.locator('.wallet-tile', { hasText: 'Talisman' }).click()

      // Both accounts are listed; the Ethereum key says why it cannot sign here.
      await expect(sheet.locator('.wallet-acct')).toHaveCount(2)
      await expect(sheet.locator('.wallet-acct.off')).toContainText('cannot sign on Hydration')
      await sheet.getByRole('button', { name: 'Continue' }).click()

      await expect(sheet.locator('.vote-dirs')).toBeVisible()
      await sheet.getByRole('radio', { name: /Aye/ }).click()
      await sheet.locator('#vote-amount').fill('10')
      await expect(sheet.locator('.vote-sign')).toBeDisabled()
      expect(await page.evaluate(() => (window as unknown as { __signRequests: unknown[] }).__signRequests.length)).toBe(0)

      // The connection is remembered on this device (addresses only), never as a session.
      const stored = await page.evaluate(() => localStorage.getItem('explorer-chain-wallets'))
      expect(stored).toContain('15U8rqSKTZuNz1doFgiaiCzeRTbEpxmHGAPQi1nRc6oamXQV')
      expect(await page.evaluate(() => localStorage.getItem('explorer-session'))).toBeNull()

      // No horizontal overflow in the sheet at this width.
      const overflow = await sheet.locator('.vote-sheet-body').evaluate(el => el.scrollWidth - el.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
    })

    test('the cart keeps a draft across a reload and opens from its button', async ({ page }) => {
      await setup(page)
      await page.goto('/referendum/opengov/450')
      const entry = viewport.name === 'phone' ? page.locator('.gov-mobile-bar .gov-vote-btn') : page.locator('.gov-ref-aside .gov-vote-btn')
      await entry.click()
      await page.locator('.vote-sheet').getByRole('button', { name: 'Connect a wallet' }).click()
      await page.locator('.wallet-tile', { hasText: 'Talisman' }).click()
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.getByRole('radio', { name: /Nay/ }).click()
      await page.getByRole('button', { name: 'Add to cart' }).click()
      await page.keyboard.press('Escape')
      await expect(page.locator('.vote-cart-fab')).toContainText('1')

      await page.reload()
      await expect(page.locator('.vote-cart-fab')).toContainText('1')
      await page.locator('.vote-cart-fab').click()
      const sheet = page.locator('.vote-sheet')
      await expect(sheet).toContainText('Vote cart')
      await expect(sheet.locator('.cart-list li')).toContainText('#450')
      await expect(sheet.getByRole('radio', { name: 'Nay' })).toHaveAttribute('aria-checked', 'true')
    })

    test('the composer works from the keyboard: Enter opens it, arrows choose the side, Escape hands focus back', async ({ page }) => {
      await setup(page)
      await page.goto('/referendum/opengov/450')
      const entry = viewport.name === 'phone' ? page.locator('.gov-mobile-bar .gov-vote-btn') : page.locator('.gov-ref-aside .gov-vote-btn')
      const sheet = page.locator('.vote-sheet')
      await entry.click()
      await sheet.getByRole('button', { name: 'Connect a wallet' }).click()
      await sheet.locator('.wallet-tile', { hasText: 'Talisman' }).click()
      await sheet.getByRole('button', { name: 'Continue' }).click()
      await expect(sheet.locator('.vote-dirs')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(sheet).toHaveCount(0)
      await expect(entry).toBeFocused()

      await page.keyboard.press('Enter')
      await expect(sheet.locator('.vote-sheet-title')).toBeFocused()
      const aye = sheet.getByRole('radio', { name: 'Aye' })
      await aye.focus()
      await page.keyboard.press('ArrowRight')
      await expect(sheet.getByRole('radio', { name: 'Nay' })).toBeFocused()
      await expect(sheet.getByRole('radio', { name: 'Nay' })).toHaveAttribute('aria-checked', 'true')
      await page.keyboard.press('ArrowLeft')
      await expect(aye).toHaveAttribute('aria-checked', 'true')

      // The amount field says what is wrong next to itself.
      await sheet.locator('#vote-amount').fill('abc')
      await expect(sheet.locator('#vote-amount')).toHaveAttribute('aria-invalid', 'true')
      await expect(sheet.locator('#vote-amount-error')).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(sheet).toHaveCount(0)
      await expect(entry).toBeFocused()
    })

    test('the sheet keeps its explanations in one closed Details, and wallets are managed from the account menu', async ({ page }) => {
      await setup(page)
      await page.goto('/referendum/opengov/450')
      const entry = viewport.name === 'phone' ? page.locator('.gov-mobile-bar .gov-vote-btn') : page.locator('.gov-ref-aside .gov-vote-btn')
      await entry.click()
      const sheet = page.locator('.vote-sheet')
      await sheet.getByRole('button', { name: 'Connect a wallet' }).click()
      await sheet.locator('.wallet-tile', { hasText: 'Talisman' }).click()
      await sheet.getByRole('button', { name: 'Continue' }).click()
      await sheet.getByRole('radio', { name: 'Aye' }).click()
      await expect(sheet.locator('.conv-say')).toContainText(/Locked ~[\d.]+ (days|hours) if Aye wins/)
      // At most one Details, closed; no restated card above Sign.
      expect(await sheet.locator('details.vote-details').count()).toBeLessThanOrEqual(1)
      await expect(sheet.locator('details.vote-details[open]')).toHaveCount(0)
      await expect(sheet.locator('.vote-restate')).toHaveCount(0)
      await expect(sheet.locator('.vote-sheet-head')).not.toContainText('Manage wallets')
      await sheet.locator('.voter-current').click()
      await sheet.getByRole('button', { name: 'Manage wallets…' }).click()
      await expect(sheet.locator('.vote-sheet-title')).toHaveText('Wallets for signing')
    })

    test('the cart button shows only where votes are made, and never over the referendum bar', async ({ page }) => {
      await setup(page)
      await page.addInitScript(() => sessionStorage.setItem('explorer-vote-cart', JSON.stringify([{ index: 450, title: 'Register the HOLLAR PSM', track: 9, direction: 'aye' }])))
      await page.goto('/referendum/opengov/450')
      const fab = page.locator('.vote-cart-fab')
      await expect(fab).toContainText('1')
      if (viewport.name === 'phone') {
        const [f, bar] = [await fab.boundingBox(), await page.locator('.gov-mobile-bar').boundingBox()]
        expect(f!.y + f!.height).toBeLessThanOrEqual(bar!.y)
      }
      await page.goto('/intents')
      await expect(page.locator('h1')).toBeVisible()
      await expect(fab).toHaveCount(0)
    })
  })
}
