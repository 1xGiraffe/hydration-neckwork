import { expect, test } from './fixtures/test'

// Overlapped asset icons read as one holding rather than a list of things, and
// hovering fans them apart enough to count. The fan must be a transform: as a
// margin it changed the cell's width, which reflowed every column in the table
// — hovering /liquidity's Omnipool row grew its icon box 90 -> 110px and slid
// TVL and Share out from under the cursor.

async function columnWidths(page: import('@playwright/test').Page, table: string) {
  return page.locator(`${table} thead th`).evaluateAll(ths => ths.map(th => Math.round(th.getBoundingClientRect().width)))
}

test('hovering a pool row moves no column', async ({ page }) => {
  await page.goto('/liquidity')
  const row = page.locator('table.liq-tbl tbody tr').first()
  await expect(row).toBeVisible()

  const before = await columnWidths(page, 'table.liq-tbl')
  const nameBefore = await row.locator('.liq-title').boundingBox()
  await row.hover()
  await page.waitForTimeout(300)                     // past the 160ms fan
  expect(await columnWidths(page, 'table.liq-tbl')).toEqual(before)
  // The name beside the stack must not be pushed along either.
  const nameAfter = await row.locator('.liq-title').boundingBox()
  expect(Math.round(nameAfter!.x)).toBe(Math.round(nameBefore!.x))
})

test('the icons do fan on hover — the effect is real, not removed', async ({ page }) => {
  await page.goto('/liquidity')
  const row = page.locator('table.liq-tbl tbody tr').first()
  const second = row.locator('.icon-stack > *').nth(1)
  await expect(second).toBeVisible()

  const at = async () => (await second.boundingBox())!.x
  const rest = await at()
  await row.hover()
  await page.waitForTimeout(300)
  expect(await at()).toBeGreaterThan(rest)
})

test('account holdings stack, and say how many they leave out', async ({ page }) => {
  await page.goto('/accounts')
  const cells = page.locator('table.tbl tbody tr td[data-label="Holdings"]')
  await expect(cells.first()).toBeVisible()

  // Overlapped, not spaced: the second icon starts before the first one ends.
  // An account holding nothing shows a dash, so take the first cell that has a
  // stack rather than assuming the top row does.
  const stack = page.locator('table.tbl tbody tr td[data-label="Holdings"] .icon-stack').first()
  const boxes = await stack.locator('> .token-icons-item').evaluateAll(els => els.map(e => e.getBoundingClientRect()).map(r => ({ x: r.x, right: r.right })))
  expect(boxes.length).toBeGreaterThan(1)
  expect(boxes[1].x).toBeLessThan(boxes[0].right)

  // The count is the OTHER holdings over $10, so it only appears where there are some.
  const more = page.locator('table.tbl tbody tr .stack-more')
  await expect(more.first()).toHaveText(/^\+\d+$/)
  await expect(more.first()).toHaveAttribute('title', /worth over \$10/)
  expect(await more.count()).toBeLessThan(await cells.count())
})

test('hovering an account row moves no column either', async ({ page }) => {
  await page.goto('/accounts')
  const row = page.locator('table.tbl tbody tr').first()
  await expect(row).toBeVisible()
  const before = await columnWidths(page, 'table.tbl')
  await row.hover()
  await page.waitForTimeout(300)
  expect(await columnWidths(page, 'table.tbl')).toEqual(before)
})

// The accounts directory behaves like every other one here: a row reacts to the
// pointer and opens what it names. It used to be the only list whose rows were
// inert, so a reader learned the pattern everywhere else and it failed here.
test('an accounts row hovers and opens the account it names', async ({ page }) => {
  await page.goto('/accounts')
  const row = page.locator('table.tbl tbody tr').filter({ has: page.locator('.addr-pill') }).first()
  await expect(row).toHaveClass(/clickable/)

  // Clicking blank row space navigates; the pills inside keep their own targets.
  await row.locator('td[data-label="Value"]').click()
  await expect(page).toHaveURL(/\/(account|tag)\//)
})
