import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Security } from '../src/pages/Security'
import { WORMHOLE_SEVERITY, WORMHOLE_STATUS, wormholeExplorerLink } from '../src/utils/security'
import type { SecuritySection } from '../src/router'
import { buildSecurityWormhole, mockSync } from './fixtures/mockApi'
import type { SecurityDashboard, WormholeBridgeDetail, WormholeStatus } from '../src/types'

const dashboard = () => mockSync<SecurityDashboard>('/explorer/security')!

// The section reads its own query, so a render seeds both: the dashboard the
// page frame needs, and the backing snapshot the section draws.
function render(section: SecuritySection | null, detail?: WormholeBridgeDetail | null, dash: SecurityDashboard = dashboard()): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(['security-dashboard'], dash)
  if (detail) queryClient.setQueryData(['security-wormhole'], detail)
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}><Security section={section} /></QueryClientProvider>)
}

describe('Wormhole overview card', () => {
  it('opens the section as a real link and leads with the deficit', () => {
    const html = render(null)
    expect(html).toContain('href="/security/wormhole"')
    expect(html).toContain('Wormhole backing')
    // The fixture's one real shortfall: 0.02 WBTC, which is the number the card exists to show.
    expect(html).toContain('$1.36k backing deficit')
    expect(html).toContain('color:var(--red)')
    expect(html).toContain('6 assets · $7.26M locked · 2 in flight · 2 queued')
  })

  it('leaves the release queue out of the card when nothing is queued', () => {
    const d = dashboard()
    const html = render(null, null, { ...d, wormhole: { ...d.wormhole!, queuedCount: 0, queuedUsd: 0 } })
    expect(html).toContain('6 assets · $7.26M locked · 2 in flight')
    expect(html).not.toContain('queued')
  })

  it('renders the card with a dash before the first snapshot, never a zero', () => {
    const html = render(null, null, { ...dashboard(), wormhole: null })
    expect(html).toContain('href="/security/wormhole"')
    expect(html).toContain('no custody snapshot yet')
    expect(html).not.toContain('backing deficit')
    expect(html).not.toContain('Fully backed')
    // The card holds its place rather than dropping out of the grid.
    expect((html.match(/sec-ov-card/g) ?? []).length).toBe(10)
  })

  it('says fully backed in green when nothing is short', () => {
    const d = dashboard()
    const html = render(null, null, {
      ...d,
      wormhole: { ...d.wormhole!, worstStatus: 'ok', deficitUsd: 0 },
    })
    expect(html).toContain('Fully backed')
    expect(html).toContain('color:var(--green)')
  })

  it('states a deficit it cannot price without inventing a $0 figure', () => {
    // A shortfall in an asset with no live price: the verdict stands while the
    // USD total has nothing to show for it.
    const d = dashboard()
    const html = render(null, null, { ...d, wormhole: { ...d.wormhole!, worstStatus: 'deficit', deficitUsd: 0 } })
    expect(html).toContain('Backing deficit')
    expect(html).toContain('color:var(--red)')
    expect(html).not.toContain('$0')
  })

  it('reports unread custody as unread, not as backed', () => {
    const d = dashboard()
    for (const worstStatus of ['unconfigured', 'unverified'] as const) {
      const html = render(null, null, { ...d, wormhole: { ...d.wormhole!, worstStatus, deficitUsd: 0 } })
      expect(html, worstStatus).toContain('Custody unread')
      expect(html, worstStatus).toContain('color:var(--text-low)')
    }
  })
})

describe('Wormhole section', () => {
  it('draws a beam per asset, with a custody tick and the uncovered stretch', () => {
    const html = render('wormhole', buildSecurityWormhole())
    expect((html.match(/class="wh-beam[ "]/g) ?? []).length).toBe(6)
    // The four shapes the beam has to tell apart.
    expect(html).toContain('wh-seg wh-minted')
    expect(html).toContain('wh-seg wh-flight')
    expect(html).toContain('wh-seg wh-gap')      // WBTC is short
    expect(html).toContain('wh-seg wh-spare')    // sUSDS is over-funded
    expect(html).toContain('class="wh-tick"')
    // A chain nobody configured has no tick to place.
    expect(html).toContain('class="wh-beam unread"')
  })

  it('carries the exact amounts in the beam tooltip', () => {
    const html = render('wormhole', buildSecurityWormhole())
    expect(html).toContain('Minted on Hydration')
    expect(html).toContain('Locked on Ethereum')
    // F.exact, not the rough scale: 12 WBTC against 11.98 in custody.
    expect(html).toContain('12.0000')
    expect(html).toContain('11.9800')
  })

  it('shows every parity verdict with its own badge', () => {
    const html = render('wormhole', buildSecurityWormhole())
    for (const label of ['Backed', 'Surplus', 'Attention', 'Deficit', 'Unconfigured']) {
      expect(html, label).toContain(`>${label}</span>`)
    }
    // Each verdict keeps its own tone class, so a deficit never renders green.
    expect(html).toContain('badge fail')
    expect(html).toContain('badge pending')
    expect(html).toContain('badge wh-quiet')
  })

  it('renders a verdict the live snapshot does not currently produce', () => {
    const d = buildSecurityWormhole()
    d.assets[0] = { ...d.assets[0], status: 'unverified', statusDetail: 'In-flight transfers are unchecked, so the shortfall cannot be explained.' }
    const html = render('wormhole', d)
    expect(html).toContain('>Unverified</span>')
    expect(html).toContain('In-flight transfers are unchecked')
  })

  it('colours the shortfall red and leaves the surplus quiet', () => {
    const html = render('wormhole', buildSecurityWormhole())
    // The signed difference: 0.02 WBTC missing, worth $1.34k.
    expect(html).toContain('-$1.34k')
    expect(html).toContain('color:var(--red)')
    // A surplus is expected, so it is stated with a + and no alarm colour.
    expect(html).toContain('+$80k')
  })

  it('dims an asset whose origin chain is not configured instead of showing a zero', () => {
    const html = render('wormhole', buildSecurityWormhole())
    expect(html).toContain('Solana is not configured on this deployment')
    expect(html).toContain('<tr class="dim">')
    // Nothing about that asset's custody is invented.
    expect(html).not.toContain('0 locked')
  })

  it('names each in-flight transfer by its route and links it to Wormholescan', () => {
    const html = render('wormhole', buildSecurityWormhole())
    expect(html).toContain('Ethereum <span class="wh-arrow">→</span> Hydration')
    expect(html).toContain('Hydration <span class="wh-arrow">→</span> Ethereum')
    expect(html).toContain('https://wormholescan.io/#/tx/')
    expect(html).not.toContain('Nothing in flight')
  })

  it('draws the queued stretch only on the assets that have one', () => {
    const d = buildSecurityWormhole()
    // sUSDS and USDC each hold one release at the origin rate limiter.
    expect(d.assets.filter(a => a.queued != null && a.queued !== '0')).toHaveLength(2)
    const html = render('wormhole', d)
    expect((html.match(/wh-seg wh-queued/g) ?? []).length).toBe(2)
    expect(html).toContain('queued at rate limit')
    expect(html).toContain('Queued at rate limit')  // the beam tooltip's own line

    // Clearing the queue removes the segment; nothing else about the beam moves.
    const none = buildSecurityWormhole()
    none.assets = none.assets.map(a => ({ ...a, queued: a.queued == null ? null : '0', queuedCount: a.queuedCount == null ? null : 0 }))
    expect(render('wormhole', none)).not.toContain('wh-seg wh-queued')
  })

  it('counts a queued release in the in-flight cell and splits it in the tooltip', () => {
    const html = render('wormhole', buildSecurityWormhole())
    // USDC: 5k in flight plus 1.8k held back — one figure, both counted.
    expect(html).toContain('6.8k')
    expect(html).toContain('title="5,000 USDC in flight · 1,800 USDC queued at the origin rate limit"')
    // sUSDS has nothing in flight, so its cell is the queued amount alone.
    expect(html).toContain('title="0 sUSDS in flight · 2,500 sUSDS queued at the origin rate limit"')
  })

  it('shows a queued release that is already free to complete', () => {
    const html = render('wormhole', buildSecurityWormhole())
    expect(html).toContain('Hydration <span class="wh-arrow">→</span> Ethereum')
    expect(html).toContain('Releasable now — anyone can call completeInboundQueuedTransfer')
    expect(html).toMatch(/wh-release ready"[^>]*>releasable <span title="[^"]*">2h 0m ago<\/span>/)
    // The digest names a message, not a transaction: shortened, and copyable.
    const digest = buildSecurityWormhole().queued[1].digest
    expect(html).toContain(`${digest.slice(0, 8)}…${digest.slice(-6)}`)
    expect(html).toContain('class="copy"')
  })

  it('counts down a queued release the rate limiter still holds', () => {
    const html = render('wormhole', buildSecurityWormhole())
    expect(html).toContain('releases in 4 h')
    // Only the freed one is toned green.
    expect((html.match(/wh-release ready/g) ?? []).length).toBe(1)
  })

  it('says so quietly when in-flight transfers are not checked at all', () => {
    const d = buildSecurityWormhole()
    d.scan = { configured: false, ok: false, asOf: null }
    const html = render('wormhole', d)
    expect(html).toContain('In-flight transfers are not checked on this deployment')
    expect(html).toContain('Wormholescan is not configured')
    // The panel is replaced, not left empty-looking.
    expect(html).not.toContain('Nothing in flight')
  })

  it('says every transfer is settled when nothing is moving', () => {
    const d = buildSecurityWormhole()
    d.inflight = []
    d.queued = []
    const html = render('wormhole', d)
    expect(html).toContain('Nothing in flight — every transfer is settled.')
  })

  it('keeps the panel for a release the origin rate limiter is still holding', () => {
    const d = buildSecurityWormhole()
    d.inflight = []
    const html = render('wormhole', d)
    expect(html).not.toContain('Nothing in flight')
    expect((html.match(/wh-queued-row/g) ?? []).length).toBe(2)
  })

  it('warns once, and only when no origin chain is configured at all', () => {
    const banner = 'Origin-chain custody is not configured on this deployment, so backing cannot be verified.'
    expect(render('wormhole', buildSecurityWormhole())).not.toContain(banner)

    const d = buildSecurityWormhole()
    d.chains = d.chains.map(c => ({ ...c, configured: false, ok: false, asOf: null }))
    const html = render('wormhole', d)
    expect(html).toContain(banner)
    expect((html.match(/sec-warn/g) ?? []).length).toBe(1)
  })

  it('formats every figure on the shared scale', () => {
    const html = render('wormhole', buildSecurityWormhole())
    expect(html).toContain('$7.26M')     // locked across the configured chains
    expect(html).toContain('$10.3M')     // minted on Hydration
    expect(html).toContain('$13k')       // in flight
    expect(html).toContain('$1.36k')     // the deficit the page exists to keep at zero
  })

  it('lists recent transfers in both directions, each linked to its moment', () => {
    const html = render('wormhole', buildSecurityWormhole())
    expect(html).toContain('minted in')
    expect(html).toContain('burned out')
    expect(html).toContain('Recent transfers')
    expect(html).toContain('href="/extrinsic/')
  })

  it('states where each number was read from', () => {
    const html = render('wormhole', buildSecurityWormhole())
    expect(html).toContain('Custody read from')
    expect(html).toContain('Issuance read from chain state')
    expect(html).toContain('Solana is not configured')
    expect(html).toContain('History indexed through block')
    expect(html).toContain('legacy remainder')
    // The page's chain-state footnote is about the dashboard, not this section.
    expect(html).not.toContain('Limits and consumption read from chain state')
  })

  it('excludes supply burned at the dead address from the equation, but names it', () => {
    const html = render('wormhole', buildSecurityWormhole())
    // sUSDS: 1,240,012 minted with 12 burned — the +80k surplus is unchanged
    // because burned supply places no claim on custody.
    expect(html).toContain('Burned at the dead address  12.0000')
    expect(html).toContain('12 burned')
    expect(html).toContain('burned at the dead address (needs no custody)')
    expect(html).toContain('+$80k')
    // Assets with nothing burned say nothing about it.
    expect((html.match(/burned at the dead address/gi) ?? []).length).toBeLessThanOrEqual(3)
  })

  it('puts only the loaded Wormhole fuses on the security overview, linking the detail', () => {
    // The default fixture carries at least one origin fuse with real usage.
    const html = render(null, buildSecurityWormhole())
    expect(html).toContain('Wormhole rate limits')
    // The fixture's sUSDS manager is paused, so the count says so instead of
    // calling a locked leg "load".
    expect(html).toMatch(/showing the \d+ of \d+ origin fuses carrying load or locked/)
    expect(html).toContain('See the Wormhole detail →')
    expect(html).toContain('href="/security/wormhole"')
    // Mixed directions share one grid, so the plate names the leg.
    expect(html).toMatch(/fuse-plate">[A-Za-z]+ (in|out)</)
  })

  it('keeps the overview quiet when no Wormhole fuse carries load', () => {
    const calm = (paused: boolean) => {
      const d = buildSecurityWormhole()
      d.assets = d.assets.map(a => ({
        ...a,
        pausedOrigin: a.pausedOrigin == null ? null : paused,
        limits: a.limits && {
          ...a.limits,
          in: a.limits.in && { ...a.limits.in, capacity: a.limits.in.limit, utilizationPct: 0 },
          out: a.limits.out && { ...a.limits.out, capacity: a.limits.out.limit, utilizationPct: 0 },
        },
      }))
      return d
    }
    expect(render(null, calm(false))).not.toContain('Wormhole rate limits')
    // A paused origin manager keeps the strip up even with nothing consumed —
    // a locked fuse is the loudest state the board has.
    expect(render(null, calm(true))).toContain('Wormhole rate limits')
    // And before the detail snapshot has answered at all, the strip stays away too.
    expect(render(null)).not.toContain('Wormhole rate limits')
  })

  it('names an asset whose USD value is missing instead of dropping it silently', () => {
    const d = buildSecurityWormhole()
    const priced = d.assets.findIndex(a => a.issuance != null && a.issuanceUsd != null)
    d.assets[priced] = { ...d.assets[priced], issuanceUsd: null, lockedUsd: null, residualUsd: null }
    const html = render('wormhole', d)
    expect(html).toContain(`${d.assets[priced].symbol} has no current price, so the dollar totals leave it out.`)
    // With every asset priced, the sentence stays away.
    expect(render('wormhole', buildSecurityWormhole())).not.toContain('no current price')
  })

  it('keeps the headline red when the only shortfall has no live price', () => {
    const d = buildSecurityWormhole()
    const short = d.assets.findIndex(a => a.status === 'deficit')
    d.assets[short] = { ...d.assets[short], issuanceUsd: null, lockedUsd: null, residualUsd: null }
    // What the API reports when the one graded shortfall is unpriced: the
    // other assets were measured, so the total is $0 rather than unknown.
    d.totals = { ...d.totals, deficitUsd: 0 }
    const html = render('wormhole', d)
    // The card block: value first (with its tone), then the sub line.
    const card = html.split('Backing deficit')[1].slice(0, 400)
    expect(card).toContain('color:var(--red)')
    expect(card).toContain('shortfall in an asset with no live price')
    expect(card).not.toContain('$0')
    expect(card).not.toContain('every token is backed')
  })

  it('shows skeletons, not an empty page, before the snapshot answers', () => {
    const html = render('wormhole')
    expect(html).toContain('chart-skeleton')
    expect(html).toContain('sk-tr')
    expect(html).not.toContain('Nothing in flight')
    // The rate-limit board holds its slot in the skeleton too, so the page does
    // not reflow a whole block into place once the snapshot lands.
    expect(html).toContain('Rate limits')
    expect((html.match(/chart-skeleton/g) ?? []).length).toBe(3)
  })

  // The bridge has no alert of its own: it is part of the one security
  // subscription, so this button and the Security overview's create the same
  // rule and read as subscribed together.
  it('offers the one security alert in the page head, not inside the section', () => {
    const html = render('wormhole', buildSecurityWormhole())
    // The subscribe button lives beside the page title on every /security view…
    expect(html).toContain('sec-page-title-row')
    expect(html).toContain('Alert me on every circuit breaker, pause, freeze, lockdown, and Wormhole backing or rate-limit event')
    expect((html.match(/Get notified/g) ?? []).length).toBe(1)
    // …and the section body carries none of its own.
    expect(html.split('sec-page-title-row')[1]).not.toContain('sec-title-row')
  })
})

// The rate-limit board reuses the Security page's fuse tiles verbatim, so the
// two boards read as the same instrument. What is tested here is that each leg
// lands on the right tile, that an unread chain stays unread instead of
// reporting an untouched limiter, and that the exact figures are on the tile.
describe('Wormhole rate limits', () => {
  const fuseBlock = (html: string) =>
    html.slice(html.indexOf('sec-title">Rate limits'), html.indexOf('sec-title">In flight'))

  it('draws one fuse per asset in each direction', () => {
    const d = buildSecurityWormhole()
    const block = fuseBlock(render('wormhole', d))
    expect(block).toContain('Into Hydration')
    expect(block).toContain('Out of Hydration — release leg')
    expect((block.match(/class="fuse-grid"/g) ?? []).length).toBe(2)
    // Every asset appears on both boards, unread chains included.
    expect((block.match(/class="fuse[ "]/g) ?? []).length).toBe(d.assets.length * 2)
  })

  it('renders a paused origin manager as a locked fuse', () => {
    // sUSDS's origin manager is paused in the fixture: both its legs read full,
    // red and numberless — a verdict, not a utilization.
    const block = fuseBlock(render('wormhole', buildSecurityWormhole()))
    expect(block).toContain('rate limit, origin manager paused')
    expect(block).toContain('class="fuse locked"')
    expect(block).toContain('The origin manager is paused — every transfer is refused until it resumes')
    expect(block).not.toContain('class="fuse-pct on-fill">100</span>')
  })

  it('fills each gauge to its consumption and colours it on the shared load scale', () => {
    // Unpause sUSDS so its hot release leg reads as consumption, not as locked.
    const d = buildSecurityWormhole()
    d.assets = d.assets.map(a => a.symbol === 'sUSDS' ? { ...a, pausedOrigin: false } : a)
    const block = fuseBlock(render('wormhole', d))
    // WETH's entry leg is two thirds spent — amber, labelled, filled to 66%.
    expect(block).toContain('style="color:var(--amber)"')
    expect(block).toContain('style="height:66%"')
    expect(block).toContain('>66</span>')
    // sUSDS's release leg is the one that queued a transfer: red, and past the
    // label zone, so the number takes a backdrop rather than its own hue.
    expect(block).toContain('style="color:var(--red)"')
    expect(block).toContain('class="fuse-pct on-fill">80</span>')
    // Plenty of room left reads green.
    expect(block).toContain('style="color:var(--green)"')
    // Under ~4% the number would not fit, so the tile keeps only its fill —
    // floored at 3% so a real trickle is still visible.
    expect(block).toContain('style="height:3%"')
  })

  it('links every tile to the asset it limits', () => {
    const block = fuseBlock(render('wormhole', buildSecurityWormhole()))
    expect(block).toContain('href="/asset/22"')
    expect(block).toContain('class="fuse-plate">USDC</span>')
  })

  it('leaves an unread chain dormant rather than reporting an untouched limiter', () => {
    const block = fuseBlock(render('wormhole', buildSecurityWormhole()))
    // Solana is unconfigured in the fixture: one dormant tile per board.
    expect((block.match(/class="fuse dormant"/g) ?? []).length).toBe(2)
    expect(block).toContain('A limit nobody could read is not a limit of zero.')
    expect(block).toContain('SOL entry rate limit, not configured')
    expect(block).not.toContain('SOL entry rate limit, 0% consumed')
  })

  it('carries the exact limit and what a full bucket means in the tooltip', () => {
    const block = fuseBlock(render('wormhole', buildSecurityWormhole()))
    // F.exact, not the rough scale — the probe's own USDC numbers.
    expect(block).toContain('Limit 100,000 USDC per 24 h')
    expect(block).toContain('Available now 93,411.58 USDC · 6.59% consumed')
    expect(block).toContain('Refills fully over 24 h')
    expect(block).toContain('A transfer beyond the available headroom is held for 24 h, not lost')
    // A leg nothing has touched says so instead of dating itself.
    expect(block).toContain('Never consumed')
    expect(block).toMatch(/Last consumed [^\n"]+ ago/)
  })

  it('names the window and the hottest leg from the data', () => {
    const html = render('wormhole', buildSecurityWormhole())
    expect(html).toContain('origin-chain fuses · 24 h rolling window · sUSDS exit fuse at 80%')

    // A half-hour window, or nothing consumed at all, and the subtitle says so.
    const quiet = buildSecurityWormhole()
    quiet.assets = quiet.assets.map(a => a.limits == null ? a : {
      ...a,
      limits: {
        ...a.limits,
        in: { ...a.limits.in!, capacity: a.limits.in!.limit, utilizationPct: 0, durationSec: 1800 },
        out: { ...a.limits.out!, capacity: a.limits.out!.limit, utilizationPct: 0, durationSec: 1800 },
      },
    })
    const html2 = render('wormhole', quiet)
    expect(html2).toContain('origin-chain fuses · 30 min rolling window')
    expect(html2).not.toContain('fuse at')
  })

  it('says from the local limits that only the origin side can bind', () => {
    const html = render('wormhole', buildSecurityWormhole())
    // 184,467,440,737 tokens against a 100k origin limit — stated as the ratio
    // on the shared rough scale (an exact eleven-digit integer would swallow
    // the sentence) and the smallest local allowance, both read off the rows.
    expect(html).toContain('1.84M× above the origin limit on the same asset')
    expect(html).toContain('184B')
    expect(html).toContain('so the origin chain&#x27;s limiter is the only fuse that can bind')
    // And what a transfer that does not fit actually does.
    expect(html).toContain('is held for 24 h rather than lost: inbound always, and outbound when the sender asked to be queued')
  })

  it('says nothing could be read rather than drawing empty gauges', () => {
    const d = buildSecurityWormhole()
    d.assets = d.assets.map(a => ({ ...a, limits: null }))
    const html = render('wormhole', d)
    expect(html).toContain('No origin chain&#x27;s rate limiter could be read')
    expect(html).not.toContain('fuse-grid')
    expect(html).not.toContain('rolling window')
  })
})

describe('Wormhole status table', () => {
  it('ranks a deficit above every other verdict and a surplus below an unread chain', () => {
    const order = (['deficit', 'attention', 'unverified', 'unconfigured', 'surplus', 'ok'] as WormholeStatus[])
      .map(s => WORMHOLE_SEVERITY[s])
    expect(order).toEqual([...order].sort((a, b) => b - a))
    expect(WORMHOLE_SEVERITY.unconfigured).toBeGreaterThan(WORMHOLE_SEVERITY.surplus)
  })

  it('gives every verdict a label and a tone', () => {
    for (const status of Object.keys(WORMHOLE_SEVERITY) as WormholeStatus[]) {
      expect(WORMHOLE_STATUS[status].label, status).toBeTruthy()
      expect(WORMHOLE_STATUS[status].tone, status).toMatch(/^var\(--/)
    }
  })

  it('sends each custody handle to the explorer that can show it', () => {
    expect(wormholeExplorerLink(2, '0xabc')?.href).toBe('https://etherscan.io/address/0xabc')
    expect(wormholeExplorerLink(30, '0xabc')?.href).toBe('https://basescan.org/address/0xabc')
    expect(wormholeExplorerLink(1, 'So111')?.href).toBe('https://solscan.io/account/So111')
    expect(wormholeExplorerLink(21, '0xobj')?.href).toBe('https://suivision.xyz/object/0xobj')
    // An unknown chain, or a peer that was never read, links nowhere rather than guessing.
    expect(wormholeExplorerLink(999, '0xabc')).toBeNull()
    expect(wormholeExplorerLink(2, null)).toBeNull()
  })
})
