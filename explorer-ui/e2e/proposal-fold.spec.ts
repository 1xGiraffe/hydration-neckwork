import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'

// Governance batches run to thousands of calls, so a big proposal arrives as an outline of
// foldable headings. These cover what a reader does with it: open one call, open
// everything, and reach past a capped list — on desktop and on a 390px phone.
//
// A closed <details> keeps its subtree in the DOM, so these assert on what is VISIBLE
// rather than on what the markup contains.

// A batch entry as subsquid decodes it, wrapping an EVM call the way Dispatcher does.
function wrappedEvmCall(index: number) {
  return {
    __kind: 'Dispatcher',
    value: {
      __kind: 'dispatch_as_aave_manager',
      call: {
        __kind: 'EVM',
        value: {
          __kind: 'call',
          source: '0xaa7e0000000000000000000000000000000aa7e0',
          target: `0xa8bbc362fba60f81cb64e0e57cfea972b4c8${index.toString(16).padStart(4, '0')}`,
          input: '0xabfd531000000000000000000000000000000000000000000000000000000000000000',
          gasLimit: '100000',
        },
      },
    },
  }
}

async function installReferendum(page: Page, entryCount: number) {
  await page.route(/\/api\/explorer\/referendum\//, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      pallet: 'opengov', index: 371, title: 'Launch BIL',
      subsquareUrl: 'https://hydration.subsquare.io/referenda/371',
      track: 0, proposalHash: '0x1268295a7db315fd3fafbdd5c2c120162fc106864ef07909dd9341466de60d65',
      proposalCall: {
        pallet: 'Utility', callName: 'batch_all',
        args: { calls: Array.from({ length: entryCount }, (_, i) => wrappedEvmCall(i)) },
        encoded: '0x1a00', byteLength: 6431, decodeError: null,
      },
      status: 'deciding', submittedAt: null, concludedAt: null,
      asset: { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: 2034 },
      onChainTally: null,
      directTally: {
        ayes: '0', nays: '0', rawAyes: '0', rawNays: '0', support: '0',
        ayeVoters: 0, nayVoters: 0, splitVoters: 0, voters: 0,
      },
      indirectTally: null, voters: [], votesShown: 0, votesTotal: 0,
    }),
  }))
}

const PANEL = '.pc-panel'
// The batch's own entries, not the calls they wrap.
const ENTRY = '.pc-panel > .pc-call > .pc-args > .pc-arg > .pc-val > .pc-list > li > details.pc-fold'
const OPEN_FOLD = '.pc-panel details.pc-fold[open]'

function panelHeight(page: Page) {
  return page.locator(PANEL).evaluate(el => el.getBoundingClientRect().height)
}

function horizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

test.describe('big proposal folding', () => {
  test('arrives as an outline and opens one call at a time', async ({ page }) => {
    await installReferendum(page, 28)
    await page.goto('/referendum/opengov/371')
    await expect(page.locator(PANEL)).toBeVisible()

    // Every batch entry is a heading, none of them open, and each names what it wraps.
    const entries = page.locator(ENTRY)
    await expect(entries).toHaveCount(28)
    await expect(page.locator(OPEN_FOLD)).toHaveCount(0)
    await expect(entries.first()).toContainText('Dispatcher.dispatch_as_aave_manager')
    await expect(entries.first()).toContainText('→ EVM.call')

    // The outline fits a screen where the expanded tree ran past 8,000px.
    expect(await panelHeight(page)).toBeLessThan(1400)

    // Opening one entry reveals its arguments, and the call it wraps is still a heading.
    const first = entries.first()
    await first.locator('summary').first().click()
    await expect(first).toHaveAttribute('open', '')
    const inner = first.locator('details.pc-fold')
    await expect(inner).toHaveCount(1)
    await expect(inner).toBeVisible()
    await expect(inner).not.toHaveAttribute('open', '')

    // The wrapped call's own arguments only appear on the second click.
    const gasLimit = first.locator('.pc-key', { hasText: /^gasLimit$/ })
    await expect(gasLimit).toBeHidden()
    await inner.locator('summary').first().click()
    await expect(gasLimit).toBeVisible()
    // Opening one entry left the other 27 alone.
    await expect(page.locator(OPEN_FOLD)).toHaveCount(2)
  })

  test('expand all restores the whole tree, and collapses back', async ({ page }) => {
    await installReferendum(page, 28)
    await page.goto('/referendum/opengov/371')
    const folded = await panelHeight(page)

    await page.getByRole('button', { name: 'Expand all' }).click()
    // No disclosures left: every argument is in the page, so find-in-page reaches it.
    await expect(page.locator('.pc-panel details.pc-fold')).toHaveCount(0)
    await expect(page.locator(`${PANEL} .pc-key`, { hasText: /^gasLimit$/ }).first()).toBeVisible()
    expect(await panelHeight(page)).toBeGreaterThan(folded * 3)

    await page.getByRole('button', { name: 'Collapse all' }).click()
    await expect(page.locator(ENTRY)).toHaveCount(28)
    await expect(page.locator(`${PANEL} .pc-key`, { hasText: /^gasLimit$/ }).first()).toBeHidden()
  })

  test('caps a very long batch until the reader asks for the rest', async ({ page }) => {
    await installReferendum(page, 120)
    await page.goto('/referendum/opengov/371')
    await expect(page.locator(ENTRY)).toHaveCount(50)

    const more = page.getByRole('button', { name: 'Show remaining 70 calls' })
    await expect(more).toBeVisible()
    // The cap holds the page down even though the batch is over twice the size.
    expect(await panelHeight(page)).toBeLessThan(2200)

    await more.click()
    await expect(page.locator(ENTRY)).toHaveCount(120)
    await expect(more).toBeHidden()
  })

  test('a folded call toggles from the keyboard', async ({ page }) => {
    await installReferendum(page, 28)
    await page.goto('/referendum/opengov/371')
    const first = page.locator(ENTRY).first()
    await first.locator('summary').first().focus()
    await page.keyboard.press('Enter')
    await expect(first).toHaveAttribute('open', '')
    await page.keyboard.press('Enter')
    await expect(first).not.toHaveAttribute('open', '')
  })

  test('the outline fits a 390px phone without sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await installReferendum(page, 28)
    await page.goto('/referendum/opengov/371')
    await expect(page.locator(PANEL)).toBeVisible()
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)

    // Opening the deepest call keeps long EVM calldata inside the viewport too.
    const first = page.locator(ENTRY).first()
    await first.locator('summary').first().click()
    await first.locator('details.pc-fold').locator('summary').first().click()
    await expect(first.locator('.pc-key', { hasText: /^gasLimit$/ })).toBeVisible()
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  })
})
