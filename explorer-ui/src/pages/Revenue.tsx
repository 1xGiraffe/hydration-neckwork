import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useRevenueDashboard, useUserRevenueSummary } from '../hooks/useExplorerData'
import { Usd } from '../components/ui'
import { DashboardSectionTitle as SecTitle } from '../components/DashboardPrimitives'
import { RevenueFlow } from '../components/RevenueFlow'
import { UserRevenueFlow } from '../components/UserRevenueFlow'
import { userRevenueLagNote } from '../components/userRevenueLabels'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useRiverFullscreen, type RiverFullscreenMode } from '../hooks/useRiverFullscreen'
import { paths } from '../router'
import { useRef, type ReactNode, type Ref } from 'react'
import type { RevenueDashboard, UserRevenueSummary } from '../types'

// /revenue — the overview: two rivers, watchable live, each with its headline
// windows and a link to its own breakdown page.
//
//  * User Revenue — what users EARN on Hydration, net (LP fees, lending
//    interest, farm and staking rewards, token accrual, less borrow interest
//    and other costs), booked per closed hour: its windows are "the last N
//    closed hours through HH:00 UTC", never a raw tail.
//  * Protocol Revenue — what the protocol earns from usage, current to the
//    indexed head.
//
// The two are NOT additive (an Omnipool fee's LP-retained part is user revenue,
// its protocol part protocol revenue, and the HDX sub-pool's POL is both), so
// the page never shows a combined total. One shared frame loop drives both
// rivers, and they split one particle budget: 90 + 90 on desktop, 40 in total
// on phones.
//
// Full screen: either river's button opens ONE view holding both rivers, User
// Revenue above Protocol Revenue (the page's order) as two equal bands at every
// aspect ratio, still never summed. It is all animation: the titles, legends,
// window figures and as-of lines stay on the page (hidden by the stylesheet);
// each band keeps only a one-word label, its live counter and the exit
// control, overlaid. The budget grows with the canvas (a full-width half-screen
// band each; the protocol river alone used to get 160), and a phone or a short
// landscape screen keeps a phone-sized budget.

const BUDGET = { desktop: 90, mobile: 20 } as const
const FULLSCREEN_BUDGET = { desktop: 140, mobile: 40 } as const
const FULLSCREEN_COMPACT_BUDGET = { desktop: 36, mobile: 36 } as const

const fmtThrough = (iso: string): string => `${iso.slice(11, 16)} UTC ${iso.slice(0, 10)}`

function Ribbon({ cells }: { cells: { k: string; v: number | null | undefined; title?: string }[] }) {
  return (
    <div className="ribbon rev-hero-ribbon">
      {cells.map(c => (
        <div className="cell" key={c.k} title={c.title}>
          <div className="k">{c.k}</div>
          <div className="v">{c.v != null ? <Usd v={c.v} /> : '—'}</div>
        </div>
      ))}
    </div>
  )
}

function RiverHead({ title, subtitle, to, linkLabel }: { title: string; subtitle: ReactNode; to: string; linkLabel: string }) {
  return (
    <div className="sec-title-row rev-river-head">
      <SecTitle title={title} subtitle={subtitle} />
      <a className="rev-more" href={to}>{linkLabel} →</a>
    </div>
  )
}

/**
 * Both river sections. Exported for tests: the page owns the full-screen state
 * and passes it in, so the markup of either mode is renderable without a DOM.
 */
export function RevenueRivers({ user, protocol, mode, onToggleFullscreen, compact = false, viewRef }: {
  user: UserRevenueSummary | undefined
  protocol: RevenueDashboard | undefined
  mode: RiverFullscreenMode
  onToggleFullscreen: () => void
  /** A phone-sized screen (narrow, or a short landscape one): phone budget in full screen. */
  compact?: boolean
  viewRef?: Ref<HTMLDivElement>
}) {
  const fullscreen = mode !== 'off'
  const budget = !fullscreen ? BUDGET : compact ? FULLSCREEN_COMPACT_BUDGET : FULLSCREEN_BUDGET
  const incomplete = 'Not every hour of this window is published yet'

  return (
    <div
      ref={viewRef}
      className={`rev-duo${fullscreen ? ' rev-duo-fs' : ''}${mode === 'css' ? ' rev-duo-pseudo' : ''}`}
      aria-label={fullscreen ? 'User Revenue and Protocol Revenue, full screen' : undefined}
    >
      <section className="rev-duo-cell">
        <RiverHead title="User Revenue" subtitle="what users earn on Hydration, net" to={paths.revenueUsers()} linkLabel="User Revenue breakdown" />
        <div className="panel rev-hero">
          <span className="rev-band-label" aria-hidden={!fullscreen}>User Revenue</span>
          <UserRevenueFlow maxActive={budget} fullscreen={fullscreen} onToggleFullscreen={onToggleFullscreen} />
          <Ribbon cells={[
            { k: '24H', v: user?.totals.day, title: user?.totals.day == null ? incomplete : 'The last 24 closed hours' },
            { k: '7D', v: user?.totals.week, title: user?.totals.week == null ? incomplete : 'The last 168 closed hours' },
            { k: '30D', v: user?.totals.month, title: user?.totals.month == null ? incomplete : 'The last 720 closed hours' },
            { k: 'All time', v: user?.totals.allTime, title: user?.totals.allTime == null ? incomplete : undefined },
          ]} />
        </div>
      </section>

      <section className="rev-duo-cell">
        <RiverHead title="Protocol Revenue" subtitle="what the protocol earns from usage" to={paths.revenueProtocol()} linkLabel="Protocol Revenue breakdown" />
        <div className="panel rev-hero">
          <span className="rev-band-label" aria-hidden={!fullscreen}>Protocol Revenue</span>
          {/* Full screen stacks both rivers in one view: ONE exit control, the top river's (top-right of the screen). */}
          <RevenueFlow maxActive={budget} fullscreen={fullscreen} onToggleFullscreen={fullscreen ? undefined : onToggleFullscreen} />
          <Ribbon cells={[
            { k: '24H', v: protocol?.totals.day },
            { k: '7D', v: protocol?.totals.week },
            { k: '30D', v: protocol?.totals.month },
            { k: 'All time', v: protocol?.totals.allTime },
          ]} />
        </div>
      </section>
    </div>
  )
}

// How current each river's figures are, stated once under the page rather than
// under each ribbon: User Revenue counts completed hours (the newest can still be
// restated), Protocol Revenue runs to the indexed head with HOLLAR interest a
// little behind.
function FreshnessNote({ user, protocol }: { user: UserRevenueSummary | undefined; protocol: RevenueDashboard | undefined }) {
  if (!user?.publishedThrough && !protocol) return null
  return (
    <p className="rev-note">
      {user?.publishedThrough && <>User Revenue covers completed hours through {fmtThrough(user.publishedThrough)}{userRevenueLagNote(user.publishedThrough)}; the newest can still change. </>}
      {protocol && <>Protocol Revenue is current as of {fmtThrough(protocol.asOf)}, with HOLLAR interest up to two hours behind.</>}
    </p>
  )
}

export function Revenue() {
  useDocumentTitle('Revenue')
  const { data: user } = useUserRevenueSummary()
  const { data: protocol } = useRevenueDashboard('30d')
  const viewRef = useRef<HTMLDivElement>(null)
  const { mode, toggle } = useRiverFullscreen(viewRef)
  const compact = useMediaQuery('(max-width: 720px), (max-height: 500px)')

  return (
    <div className="wrap">
      <div className="page-head">
        <h1 className="page-title">Revenue</h1>
      </div>

      <RevenueRivers user={user} protocol={protocol} mode={mode} onToggleFullscreen={toggle} compact={compact} viewRef={viewRef} />

      <p className="rev-note">
        User Revenue is what accounts earn — liquidity-provider fees, lending interest and incentives, farm
        and staking rewards, yield-bearing token accrual and referrer commissions — net of what they pay
        (borrow interest, exit fees, forfeited staking rewards), booked as it accrues. Protocol Revenue is
        what the protocol earns from that same usage. The two are not additive: part of one trade fee is
        user revenue and part protocol revenue, and protocol-owned liquidity counts on both sides, so they
        are never summed here.
      </p>
      <FreshnessNote user={user} protocol={protocol} />
    </div>
  )
}
