import { useEffect, useRef, useState } from 'react'
import type { Route } from '../router'
import { Link, paths } from '../router'
import { SearchBar } from './SearchBar'
import { useLive, toggleLive } from '../live'
import { useTheme } from '../hooks/useTheme'

// Navigation: direct links plus one dropdown group (Chain) for the raw chain
// data pages. A group's trigger navigates to its primary page (Chain → Blocks)
// while hovering/focusing reveals the rest. Every route is still reachable so
// deep links / bookmarks keep working.
type NavItem = { to: string; label: string; match: Route['name'][] }
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Chain',
    items: [
      { to: paths.blocks(), label: 'Blocks', match: ['blocks', 'block'] },
      { to: paths.extrinsics(), label: 'Extrinsics', match: ['extrinsics', 'extrinsic'] },
      { to: paths.events(), label: 'Events', match: ['events', 'event'] },
    ],
  },
]
const NAV_LINKS: NavItem[] = [
  { to: paths.activity(), label: 'Activity', match: ['activity'] },
  { to: paths.accounts(), label: 'Accounts', match: ['accounts', 'account', 'tags', 'tag'] },
  { to: paths.assets(), label: 'Assets', match: ['assets', 'asset', 'holders'] },
  { to: paths.hdx(), label: 'HDX', match: ['hdx'] },
  { to: paths.hollar(), label: 'HOLLAR', match: ['hollar'] },
]
// Mid-width fold (861–1119px, CSS-gated): Assets/HDX/HOLLAR collapse into one
// dropdown so the topbar search keeps a usable width. The direct links carry
// .nav-fold and hide in that window; this group is hidden everywhere else.
// The trigger itself navigates to Assets, so the menu lists only HDX/HOLLAR —
// an "Assets" entry under a group named Assets would be redundant.
const FOLDABLE = new Set(['Assets', 'HDX', 'HOLLAR'])
const ASSETS_FOLD_GROUP: { label: string; items: NavItem[]; menuItems?: NavItem[] } = {
  label: 'Assets',
  items: NAV_LINKS.filter(it => FOLDABLE.has(it.label)),
  menuItems: NAV_LINKS.filter(it => it.label === 'HDX' || it.label === 'HOLLAR'),
}

function matches(item: NavItem, route: Route): boolean {
  return item.match.includes(route.name)
}

// Sun/moon theme switch — rendered in the topbar on desktop and inside the
// drawer on mobile (≤860px hides the topbar instance).
function ThemeToggle({ onClick }: { onClick: () => void }) {
  return (
    <button className="theme-toggle" onClick={onClick} aria-label="Toggle theme">
      <svg className="ic-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>
      <svg className="ic-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
    </button>
  )
}

export function Topbar({ route }: { route: Route }) {
  const live = useLive()
  const { toggle: toggleTheme } = useTheme()
  const isDashboard = route.name === 'dashboard'
  const [drawer, setDrawer] = useState(false)
  const drawerTriggerRef = useRef<HTMLButtonElement>(null)
  // Which desktop dropdown is open (by group label), or null. Driven by JS rather
  // than :hover/:focus-within so only one is ever open, and a click closes it.
  const [openGroup, setOpenGroup] = useState<string | null>(null)

  // Close transient navigation UI after any History API navigation. Route
  // objects are derived values, so subscribing to the same events as the router
  // avoids mirroring them in component state.
  useEffect(() => {
    const closeNavigation = () => {
      setDrawer(false)
      setOpenGroup(null)
    }
    const closeOnDesktopResize = () => {
      if (window.innerWidth > 860) setDrawer(false)
    }
    window.addEventListener('popstate', closeNavigation)
    window.addEventListener('explorer:navigation', closeNavigation)
    window.addEventListener('resize', closeOnDesktopResize)
    return () => {
      window.removeEventListener('popstate', closeNavigation)
      window.removeEventListener('explorer:navigation', closeNavigation)
      window.removeEventListener('resize', closeOnDesktopResize)
    }
  }, [])
  // Lock body scroll while the drawer is open.
  useEffect(() => {
    if (!drawer) return
    const prev = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setDrawer(false)
      drawerTriggerRef.current?.focus()
    }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [drawer])

  return (
    <>
    <header className={`topbar${isDashboard ? ' topbar-dash' : ''}`}>
      <div className="wrap topbar-inner">
        <Link className="brand" to={paths.dashboard()}>
          <svg className="logo" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M18.0532 11.3604C18.2827 11.1319 18.5778 10.8381 18.8718 10.5463C19.5265 9.89543 19.5265 8.83853 18.8718 8.18664L18.1782 7.49598C15.6959 9.96786 11.982 10.4637 9.00484 8.98646C11.017 9.35678 13.1028 9.06807 14.951 8.0785C16.1876 7.41641 16.4222 5.74741 15.4295 4.75886L11.3366 0.683262C10.4217 -0.227754 8.93928 -0.227754 8.02542 0.683262L3.61392 5.07613C6.51941 3.84682 10.0089 4.4171 12.3714 6.78594C8.76716 5.04349 4.30136 5.66171 1.3088 8.64164C1.07931 8.87016 0.78323 9.16499 0.490223 9.45676C-0.163408 10.1086 -0.163408 11.1645 0.490223 11.8154L1.18279 12.505C3.66515 10.0332 7.37896 9.53735 10.3562 11.0146C8.34404 10.6442 6.25816 10.933 4.40996 11.9225C3.17339 12.5846 2.93878 14.2536 3.93152 15.2422L8.0244 19.3178C8.93928 20.2288 10.4217 20.2288 11.3356 19.3178L15.7471 14.9249C12.8416 16.1542 9.35215 15.5839 6.98965 13.2151C10.5938 14.9575 15.0596 14.3393 18.0522 11.3594L18.0532 11.3604Z" />
          </svg>
          <span className="wm">Hydration</span>
          <span className="pr">explorer</span>
        </Link>

        <nav className="nav" aria-label="Primary">
          {NAV_LINKS.map(it => (
            <Link key={it.to} to={it.to} className={`nav-link${FOLDABLE.has(it.label) ? ' nav-fold' : ''}${matches(it, route) ? ' active' : ''}`}>{it.label}</Link>
          ))}
          {[ASSETS_FOLD_GROUP, ...NAV_GROUPS].map((group: typeof ASSETS_FOLD_GROUP) => {
            const active = group.items.some(it => matches(it, route))
            const isFold = group === ASSETS_FOLD_GROUP
            return (
              <div
                className={`nav-group${isFold ? ' nav-fold-group' : ''}${openGroup === group.label ? ' open' : ''}`}
                key={group.label}
                onMouseEnter={() => setOpenGroup(group.label)}
                onMouseLeave={() => setOpenGroup(null)}
                onFocus={() => setOpenGroup(group.label)}
                onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpenGroup(null) }}
              >
                <Link to={group.items[0].to} className={`nav-trigger${active ? ' active' : ''}`} onClick={() => setOpenGroup(null)}>
                  {group.label}<span className="caret" aria-hidden="true">▾</span>
                </Link>
                <div className="nav-menu">
                  {(group.menuItems ?? group.items).map(it => (
                    <Link key={it.to} to={it.to} className={matches(it, route) ? 'active' : ''} onClick={() => setOpenGroup(null)}>{it.label}</Link>
                  ))}
                </div>
              </div>
            )
          })}
        </nav>

        <div className={`topbar-search ${isDashboard ? 'hidden' : ''}`}>
          {!isDashboard && <SearchBar variant="topbar" />}
        </div>

        <div className="topbar-right">
          <button className={`live-toggle ${live ? 'on' : ''}`} onClick={toggleLive} aria-label="Toggle live updates" aria-pressed={live}>
            <span className="dot" /><span className="lab">{live ? 'Live' : 'Paused'}</span>
          </button>
          <ThemeToggle onClick={toggleTheme} />
          <button ref={drawerTriggerRef} className="nav-burger" onClick={() => setDrawer(true)} aria-label="Open menu" aria-expanded={drawer} aria-haspopup="dialog">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
          </button>
        </div>
      </div>
    </header>

      {drawer && (
        <div className="drawer-scrim" onClick={() => setDrawer(false)}>
          <nav className="drawer" role="dialog" aria-modal="true" aria-label="Menu" onClick={e => e.stopPropagation()}>
            <div className="drawer-head">
              <span className="brand">
                <span className="wm">Hydration</span><span className="pr">explorer</span>
              </span>
              <button className="theme-toggle" onClick={() => setDrawer(false)} aria-label="Close menu">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <div className="drawer-sec">
              <div className="sec-lbl">Explore</div>
              {NAV_LINKS.map(it => (
                <Link key={it.to} to={it.to} className={matches(it, route) ? 'active' : ''}>{it.label}</Link>
              ))}
            </div>
            {NAV_GROUPS.map(group => (
              <div className="drawer-sec" key={group.label}>
                <div className="sec-lbl">{group.label}</div>
                {group.items.map(it => (
                  <Link key={it.to} to={it.to} className={matches(it, route) ? 'active' : ''}>{it.label}</Link>
                ))}
              </div>
            ))}
            <div className="drawer-sec drawer-controls">
              <button className={`live-toggle ${live ? 'on' : ''}`} onClick={toggleLive} aria-pressed={live} aria-label="Toggle live updates">
                <span className="dot" /><span className="lab">{live ? 'Live' : 'Paused'}</span>
              </button>
              <ThemeToggle onClick={toggleTheme} />
            </div>
          </nav>
        </div>
      )}
    </>
  )
}
