import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  REVENUE_STREAM_COLOR, REVENUE_STREAMS_ORDERED, USER_REVENUE_STREAM_COLOR, USER_REVENUE_STREAMS_ORDERED,
  USER_REVENUE_STREAM_LABEL, userRevenueColor,
} from '../src/components/revenueColors'
import { colorDistance } from '../src/utils/seriesColors'

// The revenue colour system (revenueColors.ts): one meaning per colour across
// both revenue sides, and the stack orders' adjacent pairs kept apart in both
// themes. The CVD half of the check was run with the dataviz validator when the
// values were chosen; this pins the normal-vision floor and the semantics.

const css = ['../src/styles/global.css', '../src/styles/revenueColors.css']
  .map(f => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8')).join('\n')
// Top-level blocks only (the tokens are never inside @media).
const blocks = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }))
function token(name: string, theme: 'dark' | 'light'): string {
  let found: string | undefined
  for (const b of blocks) {
    const isLight = b.sel.includes('data-theme="light"')
    const isDark = !isLight && /^(:root|html)/.test(b.sel)
    if ((theme === 'light' && !isLight) || (theme === 'dark' && !isDark)) continue
    const m = b.body.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`))
    if (m) found = m[1].trim()
  }
  if (!found) throw new Error(`no --${name} for ${theme}`)
  const v = found.match(/^var\(--([\w-]+)\)$/)
  return v ? token(v[1], theme) : found
}
const resolve = (color: string, theme: 'dark' | 'light') => token(color.match(/^var\(--([\w-]+)\)$/)![1], theme)

const backgrounds = { dark: token('bg', 'dark'), light: token('bg', 'light') }

describe('revenue colour system', () => {
  // GIGAHDX yield is black in BOTH themes. On the dark ground black alone
  // is all but invisible, so there it carries a thin light ring on every mark
  // (styles/revenueColors.css) — the fill never changes.
  it('draws GIGAHDX yield black in both themes, ringed on the dark ground', () => {
    expect(USER_REVENUE_STREAM_COLOR.gigahdx_yield).toBe('var(--rv-gigahdx)')
    expect(resolve(USER_REVENUE_STREAM_COLOR.gigahdx_yield, 'dark')).toBe('#000000')
    expect(resolve(USER_REVENUE_STREAM_COLOR.gigahdx_yield, 'light')).toBe('#000000')
    expect(token('rv-gigahdx-ring', 'dark')).toMatch(/^rgba\(255, 255, 255, 0\.[5-9]\d*\)$/)
    expect(css).toContain(':root:not([data-theme="light"]) [style*="var(--rv-gigahdx)"]:not(.rev-pill):not(.rev-dot-out) {\n  box-shadow: 0 0 0 1px var(--rv-gigahdx-ring);')
    expect(css).toContain(':root:not([data-theme="light"]) [fill="var(--rv-gigahdx)"] {\n  stroke: var(--rv-gigahdx-ring);')
  })

  for (const theme of ['dark', 'light'] as const) {
    it(`keeps every user stream clear of the page ground (${theme})`, () => {
      for (const [stream, color] of Object.entries(USER_REVENUE_STREAM_COLOR)) {
        // The one documented exception: GIGAHDX yield is black by ruling, ΔE ~14 from the
        // dark ground, and is kept legible by its ring (the test above), not by its fill.
        if (theme === 'dark' && stream === 'gigahdx_yield') continue
        expect(colorDistance(resolve(color, theme), backgrounds[theme]), `${stream} on ${theme}`).toBeGreaterThanOrEqual(15)
      }
    })
  }

  it('gives the same source the same colour on both sides', () => {
    expect(USER_REVENUE_STREAM_COLOR.lp_fee_omnipool).toBe(REVENUE_STREAM_COLOR.omnipool_asset_fee)
    expect(USER_REVENUE_STREAM_COLOR.lp_fee_uniswap_v3).toBe(REVENUE_STREAM_COLOR.uniswap_v3_fee)
    expect(USER_REVENUE_STREAM_COLOR.mm_supply_interest).toBe(REVENUE_STREAM_COLOR.asset_reserve)
    // A HOLLAR loan's interest is HOLLAR interest seen from the payer: its own display stream, HOLLAR's colour and name.
    expect(userRevenueColor('mm_borrow_interest_hollar')).toBe(REVENUE_STREAM_COLOR.hollar_borrow)
    expect(userRevenueColor('mm_borrow_interest')).toBe('var(--rv-mm-cost)')
    expect(USER_REVENUE_STREAM_LABEL.mm_borrow_interest_hollar).toBe('HOLLAR interest')
    expect(USER_REVENUE_STREAM_LABEL.mm_borrow_interest).toBe('Borrow interest')
    expect(REVENUE_STREAM_COLOR.hollar_borrow).toBe('var(--rv-hollar)')
    expect(REVENUE_STREAM_COLOR.hsm_revenue).toBe('var(--vol-hsm)')
    expect(REVENUE_STREAM_COLOR.network_fee).toBe('var(--accent)')
  })

  it('keeps one colour per stream within each side and stacks every stream once', () => {
    for (const map of [REVENUE_STREAM_COLOR, USER_REVENUE_STREAM_COLOR]) {
      const colors = Object.values(map)
      expect(new Set(colors).size).toBe(colors.length)
    }
    expect([...USER_REVENUE_STREAMS_ORDERED].sort()).toEqual(Object.keys(USER_REVENUE_STREAM_COLOR).sort())
  })

  for (const theme of ['dark', 'light'] as const) {
    it(`separates adjacent stacked streams and the liquidation penalty from network fees (${theme})`, () => {
      const pairs = (order: string[], map: Record<string, string>) => order.slice(1).map((s, i) => [order[i], s, colorDistance(resolve(map[order[i]], theme), resolve(map[s], theme))] as const)
      const earned = USER_REVENUE_STREAMS_ORDERED.slice(0, -4)
      const costs = USER_REVENUE_STREAMS_ORDERED.slice(-4)
      expect(costs).toEqual(['lp_exit_fee', 'mm_borrow_interest_hollar', 'mm_borrow_interest', 'staking_forfeit'])
      for (const [a, b, d] of [...pairs(REVENUE_STREAMS_ORDERED, REVENUE_STREAM_COLOR), ...pairs(earned, USER_REVENUE_STREAM_COLOR), ...pairs(costs, USER_REVENUE_STREAM_COLOR)]) {
        expect(d, `${a} / ${b}`).toBeGreaterThanOrEqual(14)
      }
      const pen = resolve(REVENUE_STREAM_COLOR.liquidation_penalty, theme)
      expect(colorDistance(pen, resolve(REVENUE_STREAM_COLOR.network_fee, theme))).toBeGreaterThanOrEqual(15)
      // HSM revenue is a clearly separate shade of the HOLLAR family.
      expect(colorDistance(resolve(REVENUE_STREAM_COLOR.hsm_revenue, theme), resolve(REVENUE_STREAM_COLOR.hollar_borrow, theme))).toBeGreaterThanOrEqual(20)
    })
  }
})
