import { lazy, Suspense, useEffect } from 'react'
import { useRoute, Link, paths, redirect } from './router'
import { Topbar } from './components/Topbar'
import { HoverCards } from './components/HoverCard'

// Route-level chunks keep account analytics, HDX charts, and detail views out of
// the landing-page bundle. Each page still exposes a named export for tests.
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })))
const Activity = lazy(() => import('./pages/Activity').then(m => ({ default: m.Activity })))
const Blocks = lazy(() => import('./pages/Blocks').then(m => ({ default: m.Blocks })))
const BlockDetail = lazy(() => import('./pages/BlockDetail').then(m => ({ default: m.BlockDetail })))
const Extrinsics = lazy(() => import('./pages/Extrinsics').then(m => ({ default: m.Extrinsics })))
const ExtrinsicDetail = lazy(() => import('./pages/ExtrinsicDetail').then(m => ({ default: m.ExtrinsicDetail })))
const TradeDetailPage = lazy(() => import('./pages/TradeDetail').then(m => ({ default: m.TradeDetailPage })))
const DcaSchedule = lazy(() => import('./pages/DcaSchedule').then(m => ({ default: m.DcaSchedule })))
const DcaResolve = lazy(() => import('./pages/DcaSchedule').then(m => ({ default: m.DcaResolve })))
const ActivityDetailPage = lazy(() => import('./pages/ActivityDetail').then(m => ({ default: m.ActivityDetailPage })))
const Events = lazy(() => import('./pages/Events').then(m => ({ default: m.Events })))
const EventDetail = lazy(() => import('./pages/EventDetail').then(m => ({ default: m.EventDetail })))
const Accounts = lazy(() => import('./pages/Accounts').then(m => ({ default: m.Accounts })))
const Account = lazy(() => import('./pages/Account').then(m => ({ default: m.Account })))
const Tags = lazy(() => import('./pages/Tags').then(m => ({ default: m.Tags })))
const TagDetail = lazy(() => import('./pages/TagDetail').then(m => ({ default: m.TagDetail })))
const Assets = lazy(() => import('./pages/Assets').then(m => ({ default: m.Assets })))
const AssetDetail = lazy(() => import('./pages/AssetDetail').then(m => ({ default: m.AssetDetail })))
const Hdx = lazy(() => import('./pages/Hdx').then(m => ({ default: m.Hdx })))
const Hollar = lazy(() => import('./pages/Hollar').then(m => ({ default: m.Hollar })))

// Consolidated top-level URLs are replaced with the matching Activity tab.
function LegacyRedirect({ to }: { to: string }) {
  useEffect(() => redirect(to), [to])
  return null
}

export default function App() {
  const route = useRoute()

  // Keep the theme initialised (data-theme is bootstrapped in index.html).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && e.target instanceof HTMLElement && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault()
        const el = document.getElementById('heroSearchInput') || document.getElementById('topbarSearchInput')
        el?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  function renderPage() {
    switch (route.name) {
      case 'dashboard': return <Dashboard />
      case 'activity': return <Activity />
      case 'legacy': return <LegacyRedirect to={route.to} />
      case 'blocks': return <Blocks />
      case 'block': return <BlockDetail height={route.height} />
      case 'extrinsics': return <Extrinsics />
      case 'extrinsic': return <ExtrinsicDetail id={route.id} />
      case 'activity-detail':
        return route.slug === 'swap'
          ? <TradeDetailPage id={route.id} slug="swap" />
          : <ActivityDetailPage slug={route.slug} id={route.id} />
      case 'dca-schedule': return <DcaSchedule scheduleId={route.scheduleId} />
      case 'dca-resolve': return <DcaResolve height={route.height} index={route.index} kind={route.kind} />
      case 'events': return <Events />
      case 'event': return <EventDetail id={route.id} />
      case 'accounts': return <Accounts />
      case 'account': return <Account address={route.address} />
      case 'tags': return <Tags />
      case 'tag': return <TagDetail tagId={route.tagId} />
      case 'assets': return <Assets />
      case 'hdx': return <Hdx />
      case 'hollar': return <Hollar />
      case 'asset': return <AssetDetail assetId={route.assetId} />
      case 'holders': return <AssetDetail assetId={route.assetId} initialTab="holders" />
      case 'notfound': return (
        <div className="wrap"><div className="page-head"><div className="page-title">Not found</div></div>
          <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>
            No page matching <span className="mono" style={{ color: 'var(--text-high)' }}>{route.path}</span>.
            <div style={{ marginTop: 16 }}><Link className="hash" to={paths.dashboard()}>← Back to start</Link></div>
          </div></div>
      )
    }
  }

  return (
    <>
      <Topbar route={route} />
      <main id="view">
        <Suspense fallback={<div className="wrap"><div className="skeleton" style={{ height: 160, marginTop: 32 }} /></div>}>
          {renderPage()}
        </Suspense>
      </main>
      <HoverCards />
    </>
  )
}
