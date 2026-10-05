import { Suspense, useEffect } from 'react'
import { isChunkLoadError, lazyWithReload } from './lazyWithReload'
import { useNoindex } from './hooks/useDocumentTitle'
import { useRoute, Link, paths, redirect } from './router'
import { Topbar } from './components/Topbar'
import { HoverCards } from './components/HoverCard'
import { SectionBoundary } from './components/SectionBoundary'

// Route-level chunks keep account analytics, HDX charts, and detail views out of
// the landing-page bundle. Each page still exposes a named export for tests.
const Dashboard = lazyWithReload(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })))
const Activity = lazyWithReload(() => import('./pages/Activity').then(m => ({ default: m.Activity })))
const Blocks = lazyWithReload(() => import('./pages/Blocks').then(m => ({ default: m.Blocks })))
const BlockDetail = lazyWithReload(() => import('./pages/BlockDetail').then(m => ({ default: m.BlockDetail })))
const Extrinsics = lazyWithReload(() => import('./pages/Extrinsics').then(m => ({ default: m.Extrinsics })))
const ExtrinsicDetail = lazyWithReload(() => import('./pages/ExtrinsicDetail').then(m => ({ default: m.ExtrinsicDetail })))
const TradeDetailPage = lazyWithReload(() => import('./pages/TradeDetail').then(m => ({ default: m.TradeDetailPage })))
const DcaSchedule = lazyWithReload(() => import('./pages/DcaSchedule').then(m => ({ default: m.DcaSchedule })))
const Intent = lazyWithReload(() => import('./pages/Intent').then(m => ({ default: m.Intent })))
const Referendum = lazyWithReload(() => import('./pages/Referendum').then(m => ({ default: m.Referendum })))
const Governance = lazyWithReload(() => import('./pages/Governance').then(m => ({ default: m.Governance })))
const DcaResolve = lazyWithReload(() => import('./pages/DcaSchedule').then(m => ({ default: m.DcaResolve })))
const DcaExecution = lazyWithReload(() => import('./pages/DcaExecution').then(m => ({ default: m.DcaExecution })))
const ActivityDetailPage = lazyWithReload(() => import('./pages/ActivityDetail').then(m => ({ default: m.ActivityDetailPage })))
const Events = lazyWithReload(() => import('./pages/Events').then(m => ({ default: m.Events })))
const EventDetail = lazyWithReload(() => import('./pages/EventDetail').then(m => ({ default: m.EventDetail })))
const Accounts = lazyWithReload(() => import('./pages/Accounts').then(m => ({ default: m.Accounts })))
const Account = lazyWithReload(() => import('./pages/Account').then(m => ({ default: m.Account })))
const Contracts = lazyWithReload(() => import('./pages/Contracts').then(m => ({ default: m.Contracts })))
const Security = lazyWithReload(() => import('./pages/Security').then(m => ({ default: m.Security })))
const Tags = lazyWithReload(() => import('./pages/Tags').then(m => ({ default: m.Tags })))
const TagsHydration = lazyWithReload(() => import('./pages/Tags').then(m => ({ default: m.TagsHydration })))
const TagDetail = lazyWithReload(() => import('./pages/TagDetail').then(m => ({ default: m.TagDetail })))
const Lists = lazyWithReload(() => import('./pages/Lists').then(m => ({ default: m.Lists })))
const ListDetail = lazyWithReload(() => import('./pages/ListDetail').then(m => ({ default: m.ListDetail })))
const Assets = lazyWithReload(() => import('./pages/Assets').then(m => ({ default: m.Assets })))
const AssetDetail = lazyWithReload(() => import('./pages/AssetDetail').then(m => ({ default: m.AssetDetail })))
const PoolDetail = lazyWithReload(() => import('./pages/PoolDetail').then(m => ({ default: m.PoolDetail })))
const XcDestination = lazyWithReload(() => import('./pages/XcDestination').then(m => ({ default: m.XcDestination })))
const UniswapV3Pool = lazyWithReload(() => import('./pages/UniswapV3Pool').then(m => ({ default: m.UniswapV3Pool })))
const Omnipool = lazyWithReload(() => import('./pages/Omnipool').then(m => ({ default: m.Omnipool })))
const Liquidity = lazyWithReload(() => import('./pages/Liquidity').then(m => ({ default: m.Liquidity })))
const Hdx = lazyWithReload(() => import('./pages/Hdx').then(m => ({ default: m.Hdx })))
const Revenue = lazyWithReload(() => import('./pages/Revenue').then(m => ({ default: m.Revenue })))
const Volume = lazyWithReload(() => import('./pages/Volume').then(m => ({ default: m.Volume })))
const Oracles = lazyWithReload(() => import('./pages/Oracles').then(m => ({ default: m.Oracles })))
const OracleFeed = lazyWithReload(() => import('./pages/OracleFeed').then(m => ({ default: m.OracleFeed })))
const Hollar = lazyWithReload(() => import('./pages/Hollar').then(m => ({ default: m.Hollar })))
const Ice = lazyWithReload(() => import('./pages/Ice').then(m => ({ default: m.Ice })))
const LinkDevice = lazyWithReload(() => import('./pages/LinkDevice').then(m => ({ default: m.LinkDevice })))
const Notifications = lazyWithReload(() => import('./pages/Notifications').then(m => ({ default: m.Notifications })))
const ApiTokens = lazyWithReload(() => import('./pages/ApiTokens').then(m => ({ default: m.ApiTokens })))
const ApiAdmin = lazyWithReload(() => import('./pages/ApiAdmin').then(m => ({ default: m.ApiAdmin })))
const Mcp = lazyWithReload(() => import('./pages/Mcp').then(m => ({ default: m.Mcp })))

// Consolidated top-level URLs are replaced with the matching Activity tab.
function LegacyRedirect({ to }: { to: string }) {
  useEffect(() => redirect(to), [to])
  return null
}

// A URL that matched no route. The app has already answered 200 — a SPA cannot
// do otherwise — so the page says so to a crawler itself rather than becoming
// another soft 404 counted against the site.
function NotFound({ path }: { path: string }) {
  useNoindex(true)
  return (
    <div className="wrap"><div className="page-head"><div className="page-title">Not found</div></div>
      <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>
        No page matching <span className="mono" style={{ color: 'var(--text-high)' }}>{path}</span>.
        <div style={{ marginTop: 16 }}><Link className="hash" to={paths.dashboard()}>← Back to start</Link></div>
      </div></div>
  )
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
      case 'intent': return <Intent intentId={route.intentId} />
      case 'referendum': return <Referendum pallet={route.pallet} index={route.index} />
      case 'governance': return <Governance />
      case 'dca-execution': return <DcaExecution height={route.height} eventIndex={route.eventIndex} />
      case 'dca-resolve': return <DcaResolve height={route.height} index={route.index} kind={route.kind} />
      case 'events': return <Events />
      case 'event': return <EventDetail id={route.id} />
      case 'accounts': return <Accounts />
      case 'account': return <Account address={route.address} />
      case 'contracts': return <Contracts />
      case 'security': return <Security section={route.section} />
      case 'tags': return <Tags />
      case 'tags-hydration': return <TagsHydration />
      case 'tag': return <TagDetail tagId={route.tagId} />
      case 'lists': return <Lists />
      case 'list': return <ListDetail listId={route.listId} />
      case 'assets': return <Assets />
      case 'hdx': return <Hdx />
      case 'revenue': return <Revenue />
      case 'volume': return <Volume />
      case 'oracles': return <Oracles />
      case 'oracle': return <OracleFeed feed={route.feed} />
      case 'hollar': return <Hollar />
      case 'ice': return <Ice />
      case 'asset': return <AssetDetail assetId={route.assetId} />
      case 'holders': return <AssetDetail assetId={route.assetId} initialTab="holders" />
      case 'pool': return <PoolDetail poolId={route.poolId} />
      case 'xcDestination': return <XcDestination slug={route.slug} />
      case 'v3pool': return <UniswapV3Pool address={route.address} />
      case 'omnipool': return <Omnipool />
      case 'liquidity': return <Liquidity />
      case 'link-device': return <LinkDevice />
      case 'notifications': return <Notifications />
      case 'api-tokens': return <ApiTokens />
      case 'api-admin': return <ApiAdmin />
      case 'mcp': return <Mcp />
      case 'notfound': return <NotFound path={route.path} />
    }
  }

  return (
    <>
      <Topbar route={route} />
      <main id="view">
        {/* A page that throws replaces only itself (the nav stays usable), and leaving it clears
            the error; a chunk-load failure still reaches the root's "new version" card. */}
        <SectionBoundary label="This page" resetKey={window.location.pathname} passThrough={isChunkLoadError}>
          <Suspense fallback={<div className="wrap"><div className="skeleton" style={{ height: 160, marginTop: 32 }} /></div>}>
            {renderPage()}
          </Suspense>
        </SectionBoundary>
      </main>
      <HoverCards />
    </>
  )
}
