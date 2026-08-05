import { expect, test } from './fixtures/test'
import { MOCK_EVM_TX, MOCK_EVM_TX_HASH } from '../tests/fixtures/mockApi'

const EVM_TX_ID = `${MOCK_EVM_TX.height}-${MOCK_EVM_TX.index}`

// An Ethereum transaction hash is an alias, not a second URL: it resolves to the
// extrinsic that carries it and the address bar canonicalizes to that extrinsic's id,
// so one on-chain action keeps exactly one canonical URL.
test('an EVM transaction hash lands on its extrinsic and states the Ethereum facts', async ({ page }) => {
  await page.goto(`/extrinsic/${MOCK_EVM_TX_HASH}`)

  await expect(page).toHaveURL(`/extrinsic/${EVM_TX_ID}`)
  await expect(page.getByText('Extrinsic ID').locator('..')).toContainText(EVM_TX_ID)

  const card = page.locator('.detail-card').first()
  await expect(card).toContainText('EVM tx hash')
  await expect(card).toContainText(MOCK_EVM_TX_HASH)
  await expect(card).toContainText('EIP1559')
  await expect(card).toContainText('Succeed')
  // Gas arrives from the receipt after the page has already rendered.
  await expect(card).toContainText('355,638')
  await expect(card).toContainText('62.9%')
  await expect(card).toContainText('7,000,447 wei')

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

// Pasting a transaction hash offers the transaction — and no account. Both hash
// spaces are 64-hex, and the address fallback used to read one as an AccountId32 and
// offer an account page that does not exist.
test('searching an EVM transaction hash offers the extrinsic and no account', async ({ page }) => {
  await page.goto('/')
  const input = page.getByLabel('Search explorer')
  await input.fill(MOCK_EVM_TX_HASH)

  const items = page.locator('.sr-item')
  await expect(items).toHaveCount(1)
  await expect(items.first().locator('.sr-type')).toHaveText('Extrinsic')
  await expect(page.locator('.sr-type', { hasText: 'Account' })).toHaveCount(0)
  await items.first().click()
  await expect(page).toHaveURL(`/extrinsic/${EVM_TX_ID}`)
})

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the EVM group stays readable at 390px with no horizontal overflow', async ({ page }) => {
    await page.goto(`/extrinsic/${MOCK_EVM_TX_HASH}`)

    await expect(page).toHaveURL(`/extrinsic/${EVM_TX_ID}`)
    const card = page.locator('.detail-card').first()
    await expect(card).toContainText('EVM tx hash')
    await expect(card).toContainText('355,638')

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
