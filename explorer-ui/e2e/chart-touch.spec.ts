import { expect, test } from './fixtures/test'
import type { Locator } from '@playwright/test'

// Mobile chart interaction: touch drags scrub the crosshair (instead of the
// browser claiming the gesture), the tap-set point sticks after the finger
// lifts, and the tooltip is clamped inside the chart so it can never widen
// the page into horizontal scroll on narrow screens.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

// Dispatch a pointer event of the given type at a horizontal fraction of the
// chart. Synthetic (isTrusted:false) events still drive React's on-root
// pointer listeners, which is what the chart handlers hang off.
async function pointerAt(wrap: Locator, type: string, frac: number, pointerType = 'touch') {
  const box = await wrap.boundingBox()
  if (!box) throw new Error('chart not laid out')
  await wrap.dispatchEvent(type, {
    pointerId: 7,
    pointerType,
    isPrimary: true,
    clientX: box.x + box.width * frac,
    clientY: box.y + box.height / 2,
  })
}

async function noHorizontalOverflow(wrap: Locator) {
  const overflow = await wrap.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page must not scroll horizontally').toBeLessThanOrEqual(0)
}

test('touch drag scrubs the peg chart crosshair and sticks after lift', async ({ page }) => {
  await page.goto('/hollar')
  const wrap = page.locator('.apx-wrap').first()
  await expect(wrap).toBeVisible()

  // The chart owns horizontal touch gestures; vertical swipes still scroll.
  await expect(wrap).toHaveCSS('touch-action', 'pan-y')

  await pointerAt(wrap, 'pointerdown', 0.25)
  const tip = page.locator('.apx-tip')
  await expect(tip).toBeVisible()
  const before = await tip.textContent()

  await pointerAt(wrap, 'pointermove', 0.75)
  await expect(tip).not.toHaveText(before ?? '')

  // Lifting the finger fires pointerup + pointerleave (pointerType touch);
  // the tapped point must stay visible, unlike a mouse leaving the chart.
  await pointerAt(wrap, 'pointerup', 0.75)
  await pointerAt(wrap, 'pointerleave', 0.75)
  await expect(tip).toBeVisible()
})

test('peg chart tooltip is clamped inside the page at both edges', async ({ page }) => {
  await page.goto('/hollar')
  const wrap = page.locator('.apx-wrap').first()
  await expect(wrap).toBeVisible()
  const tip = page.locator('.apx-tip')

  await pointerAt(wrap, 'pointerdown', 1)
  await expect(tip).toBeVisible()
  let box = (await tip.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await noHorizontalOverflow(wrap)

  await pointerAt(wrap, 'pointermove', 0)
  box = (await tip.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  await noHorizontalOverflow(wrap)
})

test('asset price chart scrubs by touch and clamps its tooltip', async ({ page }) => {
  await page.goto('/asset/5')
  const wrap = page.locator('.apx-wrap').first()
  await expect(wrap).toBeVisible()
  await expect(wrap).toHaveCSS('touch-action', 'pan-y')
  const tip = page.locator('.apx-tip')

  await pointerAt(wrap, 'pointerdown', 0.3)
  await expect(tip).toBeVisible()
  const before = await tip.textContent()

  // The price tooltip (date + price + EMA) is the widest one — the classic
  // horizontal-scroll trigger near the right edge on a phone.
  await pointerAt(wrap, 'pointermove', 1)
  await expect(tip).not.toHaveText(before ?? '')
  const box = (await tip.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await noHorizontalOverflow(wrap)
})

// Real (trusted) mouse input here: React synthesizes onPointerLeave from native
// pointerout/over pairs, which a synthetic pointerleave dispatch never produces.
test('mouse hover still clears when the pointer leaves the chart', async ({ page }) => {
  await page.goto('/hollar')
  const wrap = page.locator('.apx-wrap').first()
  await expect(wrap).toBeVisible()
  const box = (await wrap.boundingBox())!

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.locator('.apx-tip')).toBeVisible()

  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 60)
  await expect(page.locator('.apx-tip')).toHaveCount(0)
})
