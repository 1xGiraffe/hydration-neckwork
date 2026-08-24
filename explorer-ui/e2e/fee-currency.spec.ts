import { expect, test } from './fixtures/test'

// A fee is charged in the signer's nominated fee currency, so for roughly a fifth
// of extrinsics the HDX figure the chain computes names an asset that never left
// the account. Every surface that states a fee has to state the asset it was
// actually debited in — and must not print the HDX number beside it, which would
// read as a second charge.

const feeRow = (page: import('@playwright/test').Page, label: RegExp) =>
  page.locator('.detail-card').first().locator('.dt', { hasText: label }).locator('xpath=following-sibling::*[1]')

test('an extrinsic that paid in DOT states DOT, not HDX', async ({ page }) => {
  await page.goto('/extrinsic/12848613-3')

  const fee = feeRow(page, /^Fee$/)
  await expect(fee.locator('.asset-chip')).toContainText('DOT')
  await expect(fee).not.toContainText('HDX')
  // The rounded figure is the visible one; the exact debit stays on the title, so
  // a fee small enough to round away is still recoverable.
  await expect(fee.locator('[title]').first()).toHaveAttribute('title', /DOT$/)

  // The tip belongs to the same charge and so to the same asset — the runtime
  // converts both through one price and deposits them as one amount.
  await expect(feeRow(page, /^Tip$/).locator('.asset-chip')).toContainText('DOT')
})

test('an HDX-paying extrinsic reads in the same shape', async ({ page }) => {
  await page.goto('/extrinsic/12848613-2')

  // Same icon-ticker-amount convention as every other asset, so the fee row does
  // not change shape depending on which currency paid it.
  const fee = feeRow(page, /^Fee$/)
  await expect(fee.locator('.asset-chip')).toContainText('HDX')
  await expect(fee.locator('[title]').first()).toHaveAttribute('title', /HDX$/)
  await expect(feeRow(page, /^Tip$/).locator('.asset-chip')).toContainText('HDX')
})

test('an EVM transaction states its WETH gas charge and no tip', async ({ page }) => {
  await page.goto('/extrinsic/12848608-5')

  // Ethereum.transact emits no TransactionFeePaid, so this row used to be a dash:
  // the cost is the gas the EVM charged in the account's fee currency.
  const fee = feeRow(page, /^Fee$/)
  await expect(fee.locator('.asset-chip')).toContainText('WETH')
  // Its priority fee is bundled into that gas charge and cannot be separated, so
  // the tip is unknown — never a zero standing in for a number nobody has.
  await expect(feeRow(page, /^Tip$/)).toHaveText('—')
})

test('a curated surface shows the tip beside the fee, and only when there is one', async ({ page }) => {
  // A swap states the tip beside the fee, in whichever asset the charge settled
  // in — here HDX, from the trade's own tip figure.
  await page.goto('/swap/12848613-4')
  await expect(feeRow(page, /^Fee$/).locator('.asset-chip')).toContainText('HDX')
  await expect(feeRow(page, /^Tip$/).locator('.asset-chip')).toContainText('HDX')

  // And a nominated-currency payer tips in that currency: one deposit split into
  // the two rows, never one row in HDX beside the other in USDT.
  await page.goto('/extrinsic/12848613-4')
  await expect(feeRow(page, /^Fee$/).locator('.asset-chip')).toContainText('USDT')
  await expect(feeRow(page, /^Tip$/).locator('.asset-chip')).toContainText('USDT')
})

test('the extrinsic hover card and the raw JSON carry the paid asset too', async ({ page }) => {
  await page.goto('/extrinsics')

  await page.locator('a[href="/extrinsic/12848613-3"]').first().hover()
  const card = page.locator('.hovercard')
  await expect(card).toContainText('DOT')
  // 12848613-3 does not tip, so the card spends no line saying so — the predicate
  // that adds the row is the same one the detail surfaces use.
  await expect(card.locator('.hc-row', { hasText: /^Fee/ })).toHaveCount(1)
  await expect(card.locator('.hc-row', { hasText: /^Tip/ })).toHaveCount(0)

  await page.goto('/extrinsic/12848613-3')
  await page.locator('.tabs button', { hasText: 'Raw JSON' }).click()
  const json = page.locator('div.json').first()
  await expect(json).toContainText('fee_asset')
  await expect(json).toContainText('DOT')
  // The HDX-equivalent the chain reported stays in the payload beside it: the two
  // are different facts, and only the display picks one.
  await expect(json).toContainText('fee_paid')
})
