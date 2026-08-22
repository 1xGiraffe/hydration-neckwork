import { expect, test } from './fixtures/test'

// Two things are worth holding in a real browser: the fuse grid's geometry (the
// page's one bold element) and the tab structure, whose content the server-rendered
// unit test cannot reach because the tab lives in the query string.

test.describe('Security page — desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('one fuse per rate-limited asset, wrapped into a grid', async ({ page }) => {
    await page.goto('/security/cross-chain')
    const fuses = page.locator('.fuse-grid .fuse')
    await expect(fuses.first()).toBeVisible()
    await expect(fuses).toHaveCount(7)

    const rows = new Set(await fuses.evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().y))))
    expect(rows.size, 'seven gauges fit one row at 1440px').toBe(1)

    // A gauge is taller than it is wide — it reads as a meter, not a chip.
    const box = await fuses.first().boundingBox()
    expect(box!.height).toBeGreaterThan(box!.width)
  })

  test('fuse fills scale with load and a locked fuse is full', async ({ page }) => {
    await page.goto('/security/cross-chain')
    await expect(page.locator('.fuse-grid .fuse').first()).toBeVisible()
    // The fills animate in, so the measurement is polled until it settles.
    const measure = () => page.locator('.fuse').evaluateAll(els => els.map(e => {
      const body = e.querySelector('.fuse-body')!.getBoundingClientRect()
      const fill = e.querySelector('.fuse-fill')!.getBoundingClientRect()
      return { locked: e.classList.contains('locked'), pct: Math.round((fill.height / body.height) * 100) }
    }))
    // Sorted worst-first, so the locked fuse leads at a full body.
    await expect.poll(async () => (await measure())[0]).toEqual({ locked: true, pct: 100 })

    const heights = await measure()
    // Descending load, and an unloaded fuse draws no fill at all.
    const unlocked = heights.slice(1).map(h => h.pct)
    expect(unlocked).toEqual([...unlocked].sort((a, b) => b - a))
    expect(unlocked.at(-1)).toBe(0)
  })

  test('a fuse links to its asset', async ({ page }) => {
    await page.goto('/security/cross-chain')
    const fuse = page.locator('.fuse').first()
    await expect(fuse).toBeVisible()
    await fuse.click()
    await expect(page).toHaveURL(/\/asset\/\d+$/)
  })

  // The overview is a summary: a wall of cold gauges is the detail page's job, so it
  // draws only the fuses actually carrying load — and says how many it left out.
  test('the overview shows only the fuses carrying load', async ({ page }) => {
    await page.goto('/security')
    const shown = page.locator('.fuse-grid .fuse')
    await expect(shown.first()).toBeVisible()
    // Of the fixture's seven, three are loaded and one is locked.
    await expect(shown).toHaveCount(4)
    await expect(page.getByText('showing the 4 carrying load of 7')).toBeVisible()
    // And it offers the way in to the rest.
    await expect(page.getByRole('link', { name: /See the ingress detail/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /See the egress detail/ })).toBeVisible()
  })

  test('the egress meter fills to its real share of the budget', async ({ page }) => {
    await page.goto('/security')
    await expect(page.locator('.load-meter .lm-fill')).toBeVisible()
    const width = await page.locator('.load-meter .lm-fill').evaluate(el => el.getBoundingClientRect().width)
    const track = await page.locator('.load-meter').evaluate(el => el.getBoundingClientRect().width)
    // 4.18% used — a small but visible sliver, not a full or empty bar.
    expect(width / track).toBeGreaterThan(0.02)
    expect(width / track).toBeLessThan(0.08)
  })

  test('each section is its own page, reachable from the nav', async ({ page }) => {
    await page.goto('/security')
    // The overview leads with the instruments and one card per area.
    await expect(page.locator('.sec-title', { hasText: 'Value leaving the chain' })).toBeVisible()
    await expect(page.locator('.sec-ov-card')).toHaveCount(10)
    // No nav row on the overview — the tiles are the way in.
    await expect(page.locator('.sec-section-nav')).toHaveCount(0)

    const cases: [string, string, string][] = [
      ['Cross-chain', 'cross-chain', 'Withdraw limit'],
      ['Wormhole', 'wormhole', 'Backing, per asset'],
      ['Omnipool', 'omnipool', 'Per-block limits'],
      ['Money market', 'money-market', 'Solvency'],
      ['Freezes', 'freezes', 'Freezes & pauses'],
      ['Ledger', 'ledger', 'Safety ledger'],
      ['Guardians', 'guardians', 'Assurance'],
    ]
    await page.goto('/security/cross-chain')
    for (const [label, slug, heading] of cases) {
      await page.locator('.sec-nav-link', { hasText: label }).first().click()
      await expect(page).toHaveURL(new RegExp(`/security/${slug}$`))
      await expect(page.locator('.sec-title', { hasText: heading }).first()).toBeVisible()
    }

    await page.locator('.sec-nav-link', { hasText: 'Overview' }).click()
    await expect(page).toHaveURL(/\/security$/)
  })

  test('a deep link opens its section directly', async ({ page }) => {
    await page.goto('/security/money-market')
    await expect(page.locator('.sec-title', { hasText: 'Solvency' })).toBeVisible()
    // Isolated markets are reported separately, never blended.
    await expect(page.locator('.tbl', { hasText: 'Money Market' }).first()).toBeVisible()
    await expect(page.getByText('isolated').first()).toBeVisible()
    // The Omnipool's own numbers live on their own page, not mixed in here.
    await expect(page.locator('.sec-title', { hasText: 'Largest liquidity moves' })).toHaveCount(0)
  })

  // An under-water position is EITHER still covered or short of collateral, never
  // both, so the two columns describe disjoint sets and nothing needs a caveat.
  test('splits under-water debt into two disjoint columns', async ({ page }) => {
    await page.goto('/security/money-market')
    const head = page.locator('.sec-tbl').first().locator('thead')
    await expect(head).toContainText('Liquidatable')
    await expect(head).toContainText('Bad debt')
    // Neither column nests inside the other, so no "of which" and no caveat.
    await expect(head).not.toContainText('of which')
    await expect(page.getByText(/not additive/)).toHaveCount(0)

    // The near-threshold column names its own exclusion, and the cell repeats it —
    // without it the figure is dominated by loops that live there on purpose.
    await expect(head).toContainText('Within 5%')
    await expect(head).toContainText('excl. loops')
    await expect(page.locator('.sec-tbl td[data-label="Within 5% excl. loops"]').first())
      .toHaveAttribute('title', /e-mode and isolation-mode/)

    // Each column says what its set is, so a reader knows why they differ.
    await expect(page.locator('.sec-tbl td[data-label="Liquidatable"]').first())
      .toHaveAttribute('title', /collateral still covers the debt/)
    await expect(page.locator('.sec-tbl td[data-label="Bad debt"]').first())
      .toHaveAttribute('title', /no longer covers the debt/)

    // The counts partition the under-water population.
    await expect(page.getByText(/positions in the primary market are under water/)).toBeVisible()
  })

  // The tiles sit far down the overview. As tabs this kept the scroll offset, so a
  // shorter section clamped to its end and opened at the bottom.
  test('an overview tile opens its section at the top', async ({ page }) => {
    await page.goto('/security')
    // A short viewport guarantees the destination is taller than the screen, so
    // "opened at the top" is a real claim rather than a page that simply fits.
    await page.setViewportSize({ width: 1440, height: 360 })
    const tile = page.locator('.sec-ov-card', { hasText: 'Bad debt' })
    await expect(tile).toBeVisible()

    await tile.click()
    await expect(page).toHaveURL(/\/security\/money-market$/)
    const heading = page.locator('.sec-title', { hasText: 'Solvency' })
    await expect(heading).toBeVisible()
    // As a tab switch this landed at whatever offset the tile sat at, which on a
    // shorter section clamped to its end — the heading was off-screen above.
    await expect(heading).toBeInViewport()
    // Polled: the click itself scrolls the tile into view, so the reset settles a
    // frame after the navigation commits.
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('a ribbon number opens the section that explains it', async ({ page }) => {
    await page.goto('/security')
    await page.locator('.sec-ribbon-cell', { hasText: 'Egress used' }).click()
    await expect(page).toHaveURL(/\/security\/cross-chain$/)
    await expect(page.locator('.sec-title', { hasText: 'Withdraw limit' })).toBeVisible()
  })

  test('the safety ledger pages in the rest of the record', async ({ page }) => {
    await page.goto('/security/ledger')
    const rows = page.locator('.sec-dot-cell')
    await expect(rows.first()).toBeVisible()
    const before = await rows.count()
    expect(before).toBe(25)

    await page.locator('.sec-more button', { hasText: 'Show more' }).click()
    await expect(rows).toHaveCount(31)
    await expect(page.locator('.sec-more button', { hasText: 'Show more' })).toHaveCount(0)
  })

  test('the lockdown history expands and collapses again', async ({ page }) => {
    await page.goto('/security/cross-chain')
    const expander = page.locator('.sec-more button', { hasText: 'Show all' })
    await expect(expander).toBeVisible()
    const rows = page.locator('.sec-title', { hasText: 'Lockdowns' }).locator('~ .panel').first().locator('tbody tr')
    await expect(rows).toHaveCount(10)

    await expander.click()
    await expect(rows).toHaveCount(12)
    await page.locator('.sec-more button', { hasText: 'Show fewer' }).click()
    await expect(rows).toHaveCount(10)
  })
})

test.describe('Security page — mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('lays out without horizontal overflow and keeps the grid multi-column', async ({ page }) => {
    await page.goto('/security')
    await expect(page.locator('.fuse-grid .fuse').first()).toBeVisible()

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)

    // Narrow gauges still tile several to a row rather than becoming a list.
    const perRow = await page.locator('.fuse-grid .fuse').evaluateAll(els => {
      const rows = new Map<number, number>()
      for (const e of els) {
        const y = Math.round(e.getBoundingClientRect().y)
        rows.set(y, (rows.get(y) ?? 0) + 1)
      }
      return Math.max(...rows.values())
    })
    expect(perRow).toBeGreaterThanOrEqual(4)
  })

  test('stat cards and the meter stay inside the viewport', async ({ page }) => {
    await page.goto('/security')
    const widest = await page.locator('.pf-card, .panel, .ribbon').evaluateAll(els =>
      Math.max(...els.map(e => e.getBoundingClientRect().right)))
    expect(widest).toBeLessThanOrEqual(390)
  })

  // The section tabs cannot fit one 390px row, and the shared bar scrolls with no
  // visible affordance — destinations were simply unreachable. The bar wraps here.
  test('every section is reachable without a sideways scroll', async ({ page }) => {
    await page.goto('/security/omnipool')
    const buttons = page.locator('.sec-section-nav .sec-nav-link')
    await expect(buttons).toHaveCount(8)

    const geometry = await buttons.evaluateAll(els => els.map(e => {
      const r = e.getBoundingClientRect()
      return { right: Math.round(r.right), row: Math.round(r.y) }
    }))
    expect(geometry.every(g => g.right <= 390), 'no tab sits off-screen').toBe(true)
    expect(new Set(geometry.map(g => g.row)).size, 'the bar wraps rather than scrolling').toBeGreaterThan(1)

    const barScroll = await page.locator('.sec-section-nav .tabs').evaluate(el => el.scrollWidth - el.clientWidth)
    expect(barScroll).toBeLessThanOrEqual(0)
  })

  test('no section overflows the page or clips a cell', async ({ page }) => {
    for (const tab of ['', 'cross-chain', 'wormhole', 'omnipool', 'money-market', 'freezes', 'ledger', 'guardians']) {
      await page.goto('/security' + (tab ? `/${tab}` : ''))
      await expect(page.locator('.sec-title').first()).toBeVisible()

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `${tab || 'overview'} scrolls sideways`).toBeLessThanOrEqual(0)

      // A labelled cell whose value is wider than the space the floated label
      // leaves is silently cut off by the shared `overflow: hidden`.
      const clipped = await page.locator('.tbl tbody td[data-label]').evaluateAll(els =>
        els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => `${e.getAttribute('data-label')}: ${(e.textContent ?? '').trim().slice(0, 40)}`))
      expect(clipped, `${tab || 'overview'} clips a cell`).toEqual([])
    }
  })

  // A row of em-dashes was most of a card's height, so a cell with nothing in it
  // drops out — the same treatment the accounts directory gets.
  test('cards drop their empty cells and lead with a title', async ({ page }) => {
    await page.goto('/security/money-market')
    const cards = page.locator('.tbl.sec-tbl').first().locator('tbody tr')
    await expect(cards.first()).toBeVisible()

    // The market with nothing borrowed keeps its name and its zero, nothing else.
    const bil = cards.filter({ hasText: 'BIL' }).first()
    const labels = await bil.locator('td[data-label]:visible').evaluateAll(els => els.map(e => e.getAttribute('data-label')))
    expect(labels).toEqual(['Market', 'Borrowers'])

    // The first cell is the card's title: left-aligned, and its column label is gone.
    const title = cards.first().locator('td[data-label]').first()
    await expect(title).toHaveCSS('text-align', 'left')
    const label = await title.evaluate(el => getComputedStyle(el, '::before').display)
    expect(label).toBe('none')
  })

  test('the ledger leads each card with the action, not a colour dot', async ({ page }) => {
    await page.goto('/security/ledger')
    const row = page.locator('.tbl.sec-tbl tbody tr').first()
    await expect(row).toBeVisible()
    await expect(row.locator('.sec-dot-cell')).toBeHidden()
    const action = row.locator('td[data-label="Action"]')
    await expect(action).toHaveCSS('text-align', 'left')
    expect(await action.evaluate(el => getComputedStyle(el, '::before').display)).toBe('none')
  })
})
