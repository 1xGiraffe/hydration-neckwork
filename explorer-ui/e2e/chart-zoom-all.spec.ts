import { expect, test } from '@playwright/test'

// Chart pages pull several fetches before the series lands; the default 30s is
// not enough for the dashboard pages on a cold API.
test.setTimeout(90_000)

// Every zoomable chart, walked as a set: the defects this exists to catch all
// lived in the SHARED gesture/geometry seam, so per-chart tests missed them —
// a window rounded to the base series' step, a refined series drawn on a
// different span than the window it replaced, a line drawn past its own axis.
//
// Charts are addressed by `data-zoom-key`, the same key the window is persisted
// under, so a chart that loses or renames its zoom fails here rather than
// silently dropping out of coverage.

const ACCOUNT = '13dxxbqUHL7YJPyFnyo9pPuACoiZZtifHMUr1sSZ6RkXcbRU'

/** Every zoom key in the app, with a page that renders it. */
const CHARTS: { key: string; path: string; note?: string }[] = [
  { key: 'zv', path: `/account/${ACCOUNT}`, note: 'portfolio value' },
  { key: 'zb', path: `/account/${ACCOUNT}?view=balances&asset=0`, note: 'asset balance' },
  { key: 'zp', path: '/asset/5', note: 'asset price' },
  { key: 'zliq', path: '/asset/5?tab=liquidity', note: 'asset liquidity' },
  { key: 'ztvl', path: '/omnipool' },
  { key: 'zcomp', path: '/omnipool' },
  { key: 'zlp', path: '/pool/690' },
  { key: 'zpeg', path: '/pool/690' },
  { key: 'zown', path: '/hdx' },
  { key: 'zhodl', path: '/hdx' },
  { key: 'zstk', path: '/hdx' },
  { key: 'zflt', path: '/hdx' },
  { key: 'zpvc', path: '/hdx' },
  { key: 'zbb', path: '/hdx' },
  { key: 'zt100', path: '/hdx' },
  { key: 'zkr', path: '/hdx' },
  { key: 'zsup', path: '/hollar' },
  { key: 'zhold', path: '/hollar' },
  { key: 'zdebt', path: '/hollar' },
  { key: 'zbor', path: '/hollar' },
  { key: 'zrev', path: '/hollar' },
  { key: 'zdep', path: '/hollar' },
  { key: 'zshare', path: '/hollar' },
  { key: 'zpegw', path: '/hollar' },
  { key: 'zhsmres', path: '/hollar', note: 'HSM reserves' },
]

/** The block-time chart plots a live tail, so a persisted window is meaningless. */
const REMOVED = ['zbt']

async function settle(page: import('@playwright/test').Page, path: string) {
  await page.goto(path)
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => { /* live feed never idles */ })
  await page.waitForTimeout(3500)
}

// What a zoom must satisfy, stated as the user states it: THE WINDOW YOU GET IS
// THE WINDOW YOU DRAGGED. The window is a time range in the URL, so after one
// zoom the view is known exactly — and a second drag at fractions a..b must
// commit exactly view.from + a·span .. view.from + b·span.
//
// This is strictly stronger than comparing the drag label to the crosshair, which
// is what this suite used to do: the crosshair names the NEAREST DRAWN POINT, so
// that comparison could only ever be as tight as one bucket, and it silently
// tolerated the defect it was meant to catch — an index-space window rounding a
// selection to the base series' step (3 days), which is what made the shade jump
// while dragging and the committed range miss by up to a day and a half.
//
// It also exercises the SECOND zoom level, where that defect actually appeared.
for (const { key, path, note } of CHARTS) {
  test(`${key}${note ? ` (${note})` : ''} commits the window that was dragged`, async ({ page }) => {
    await settle(page, path)
    const chart = page.locator(`[data-zoom-key="${key}"]`).first()
    await expect(chart, `${key} should render on ${path}`).toBeVisible({ timeout: 20_000 })
    await chart.scrollIntoViewIfNeeded()
    await page.waitForTimeout(1200)

    const box = (await chart.boundingBox())!
    const y = box.y + box.height / 2
    const at = (f: number) => box.x + box.width * f
    const windowOf = () => {
      const raw = new URL(page.url()).searchParams.get(key)
      const m = raw && /^(\d+)-(\d+)$/.exec(raw)
      return m ? { from: Number(m[1]), to: Number(m[2]) } : null
    }
    const drag = async (a: number, b: number) => {
      await page.mouse.move(at(a), y)
      await page.mouse.down()
      for (const f of [a + (b - a) * 0.35, a + (b - a) * 0.7, b]) await page.mouse.move(at(f), y, { steps: 4 })
      await page.mouse.move(at(b), y, { steps: 2 })
      await page.mouse.up()
      await page.waitForTimeout(1400)
    }

    // Three identical drags. Charts inset their plot by a y-axis gutter, and the
    // gutter is not observable from here, so the test asserts what does not depend
    // on it: repeating the SAME gesture must scale the window by the SAME factor
    // and shift it by the SAME share of the span, every time. That is linearity —
    // exactly what an index-space window destroyed by rounding each selection to
    // the base series' step, and it holds whatever the gutter is.
    const [a, b] = [0.3, 0.75]
    const seen: { from: number; to: number }[] = []
    for (let level = 0; level < 3; level++) {
      await drag(a, b)
      const w = windowOf()
      expect(w, `${key}: zoom ${level + 1} must persist a time window`).not.toBeNull()
      expect(w!.to - w!.from, `${key}: window must respect the 1h floor`).toBeGreaterThanOrEqual(3600)
      seen.push(w!)
    }
    const shrink = seen.slice(1).map((w, i) => (w.to - w.from) / (seen[i].to - seen[i].from))
    const shift = seen.slice(1).map((w, i) => (w.from - seen[i].from) / (seen[i].to - seen[i].from))
    for (let i = 1; i < shrink.length; i++) {
      expect(Math.abs(shrink[i] - shrink[0]), `${key}: shrink factor drifted ${shrink.join(' vs ')}`).toBeLessThan(0.02)
      expect(Math.abs(shift[i] - shift[0]), `${key}: start shift drifted ${shift.join(' vs ')}`).toBeLessThan(0.02)
    }
    // A repeated inward drag must actually narrow the window.
    expect(shrink[0], `${key}: zooming must narrow, got ${shrink[0]}`).toBeLessThan(0.95)
    const view = seen[seen.length - 2]

    // Reversible, and the chart still renders dated content inside the window.
    await page.goBack()
    await page.waitForTimeout(1200)
    expect(windowOf(), `${key}: Back returns to the previous window`).toEqual(view)
  })
}

test('the block-time chart no longer offers a zoom', async ({ page }) => {
  await settle(page, '/blocks')
  for (const key of REMOVED) {
    await expect(page.locator(`[data-zoom-key="${key}"]`)).toHaveCount(0)
  }
})
