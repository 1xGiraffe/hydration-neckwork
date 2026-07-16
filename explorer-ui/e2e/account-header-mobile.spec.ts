import { expect, test } from './fixtures/test'

// Mobile account header: the account value sits on the right at the height of
// the emoji/name/address block, and the liquidation & trading volumes (when
// present) share a single line below the header row.
test.use({ viewport: { width: 390, height: 844 } })

const FOX = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'

test('value sits beside the identity; volumes share one line below', async ({ page }) => {
  await page.goto(`/account/${FOX}`)
  const avatar = page.locator('.acct-avatar')
  await expect(avatar).toBeVisible()

  const value = page.locator('.acct-stats .acct-bal:not(.subtle)')
  const a = (await avatar.boundingBox())!
  const v = (await value.boundingBox())!

  // Same top row: the value's vertical span overlaps the avatar's.
  expect(v.y, 'value should start above the avatar bottom').toBeLessThan(a.y + a.height)
  expect(v.y + v.height, 'value should end below the avatar top').toBeGreaterThan(a.y)
  // Right-aligned: the value block ends in the right half of the 390px viewport.
  expect(v.x + v.width).toBeGreaterThan(300)

  // Both volumes exist for this account and share ONE line below the address.
  const addr = (await page.locator('.acct-meta .full').boundingBox())!
  const volumes = page.locator('.acct-stats .acct-bal.subtle')
  await expect(volumes).toHaveCount(2)
  const b0 = (await volumes.nth(0).boundingBox())!
  const b1 = (await volumes.nth(1).boundingBox())!
  expect(b0.y, 'volumes below the address').toBeGreaterThan(addr.y + addr.height - 2)
  expect(b1.y, 'volumes below the address').toBeGreaterThan(addr.y + addr.height - 2)
  expect(Math.abs(b0.y - b1.y), 'volumes on one shared line').toBeLessThan(2)

  // The header must not widen the page.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

// EVM accounts: no "EVM" badge in the header address line — it forced the
// short address to wrap mid-token on phones, and the 0x prefix (plus the
// identities card's "EVM (H160)" row) already says it.
test('EVM account header shows the address on one unbroken line', async ({ page }) => {
  await page.goto('/account/0xf73a2b8c1d4e9a06b5c8f2e1a3d70c9b4e6f18ad')
  const full = page.locator('.acct-meta .full')
  await expect(full).toBeVisible()
  await expect(full.locator('.id-kind')).toHaveCount(0)
  const box = (await full.boundingBox())!
  expect(box.height, 'address must not wrap').toBeLessThan(26)
})
