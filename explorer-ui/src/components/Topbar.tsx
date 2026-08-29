import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { Route } from '../router'
import { Link, paths } from '../router'
import { SearchBar } from './SearchBar'
import { useConnectRequest } from '../connectDialog'
import { useTheme } from '../hooks/useTheme'
import { useSession } from '../session'
import { useMe, useTagMapSync, logout } from '../hooks/useUser'
import { useNotificationsOverview, usePendingNotificationHandoff } from '../hooks/useNotifications'
import { AccountEmoji, ShortAddr, showIconFallback } from './ui'
import { NotificationBell } from './NotificationBell'
import type { AccountRef } from '../types'

// Radix + the dialog itself are only needed once a visitor actually tries to
// sign in, so it's a route-chunk-style lazy import (like every page in App.tsx)
// rather than a static one — otherwise every visitor's entry chunk would carry
// it, logged in or out.
const ConnectDialog = lazy(() => import('./ConnectDialog').then(m => ({ default: m.ConnectDialog })))
// Same lazy treatment: the devices list (and its QR renderer) only loads when
// a logged-in visitor opens it.
const DevicesDialog = lazy(() => import('./DevicesDialog').then(m => ({ default: m.DevicesDialog })))

// Navigation: direct links plus dropdown groups. A group's trigger navigates
// to its primary page (Chain → Blocks, Assets → Assets) while hovering/focusing
// reveals the rest; `menuItems` orders the dropdown independently of the
// trigger/highlight `items`. Every route is still reachable so deep links /
// bookmarks keep working.
type NavItem = { to: string; label: string; match: Route['name'][] }
type NavGroup = { label: string; items: NavItem[]; menuItems?: NavItem[] }
const IT = {
  activity: { to: paths.activity(), label: 'Activity', match: ['activity'] } as NavItem,
  accounts: { to: paths.accounts(), label: 'Accounts', match: ['accounts', 'account', 'tags', 'tags-hydration', 'tag', 'lists', 'list'] } as NavItem,
  assets: { to: paths.assets(), label: 'Assets', match: ['assets', 'asset', 'holders'] } as NavItem,
  // Pools live under Liquidity, so a pool or the Omnipool highlights there.
  liquidity: { to: paths.liquidity(), label: 'Liquidity', match: ['liquidity', 'pool', 'omnipool'] } as NavItem,
  hdx: { to: paths.hdx(), label: 'HDX', match: ['hdx'] } as NavItem,
  hollar: { to: paths.hollar(), label: 'HOLLAR', match: ['hollar'] } as NavItem,
  revenue: { to: paths.revenue(), label: 'Revenue', match: ['revenue'] } as NavItem,
  blocks: { to: paths.blocks(), label: 'Blocks', match: ['blocks', 'block'] } as NavItem,
  extrinsics: { to: paths.extrinsics(), label: 'Extrinsics', match: ['extrinsics', 'extrinsic'] } as NavItem,
  events: { to: paths.events(), label: 'Events', match: ['events', 'event'] } as NavItem,
  contracts: { to: paths.contracts(), label: 'Contracts', match: ['contracts'] } as NavItem,
  security: { to: paths.security(), label: 'Security', match: ['security'] } as NavItem,
  governance: { to: paths.governance(), label: 'Governance', match: ['governance', 'referendum'] } as NavItem,
}
// Liquidity lives under Assets at every width; the trigger navigates to Assets
// so the menu lists only Liquidity. Security leads the Chain menu (it is the
// entry a returning operator wants first) while the trigger keeps Blocks.
const ASSETS_GROUP: NavGroup = { label: 'Assets', items: [IT.assets, IT.liquidity], menuItems: [IT.liquidity] }
const CHAIN_GROUP: NavGroup = {
  label: 'Chain',
  items: [IT.blocks, IT.extrinsics, IT.events, IT.contracts, IT.security, IT.governance],
  menuItems: [IT.security, IT.governance, IT.blocks, IT.extrinsics, IT.events, IT.contracts],
}
// Mid-width fold (861–1119px, CSS-gated): HDX/HOLLAR/Revenue and the Assets
// group collapse into this single wider Assets dropdown so the topbar search
// keeps a usable width. Direct links carry .nav-fold and hide in that window;
// the permanent Assets group carries .nav-unfold-group and hides there too;
// this group is hidden everywhere else.
const FOLDABLE = new Set(['HDX', 'HOLLAR', 'Revenue'])
const ASSETS_FOLD_GROUP: NavGroup = {
  label: 'Assets',
  items: [IT.assets, IT.liquidity, IT.hdx, IT.hollar, IT.revenue],
  menuItems: [IT.liquidity, IT.hdx, IT.hollar, IT.revenue],
}
// The desktop nav in visual order; the drawer keeps every destination flat.
const NAV_ENTRIES: Array<{ kind: 'link'; item: NavItem } | { kind: 'group'; group: NavGroup; fold?: 'only' | 'hidden' }> = [
  { kind: 'link', item: IT.activity },
  { kind: 'link', item: IT.accounts },
  { kind: 'group', group: ASSETS_GROUP, fold: 'hidden' },
  { kind: 'link', item: IT.hdx },
  { kind: 'link', item: IT.hollar },
  { kind: 'link', item: IT.revenue },
  { kind: 'group', group: ASSETS_FOLD_GROUP, fold: 'only' },
  { kind: 'group', group: CHAIN_GROUP },
]
const DRAWER_LINKS: NavItem[] = [IT.activity, IT.accounts, IT.assets, IT.liquidity, IT.hdx, IT.hollar, IT.revenue]
const DRAWER_GROUPS: NavGroup[] = [CHAIN_GROUP]

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

// The account's self-authored avatar image when it has one (cache-busted by
// avatarVersion), else the same snakewatch/custom-icon emoji AddrPill uses
// elsewhere, else a plain placeholder before the profile has loaded.
function ProfileAvatar({ account }: { account?: AccountRef }) {
  const profile = account?.profile
  if (account && profile && profile.avatarVersion > 0) {
    return (
      <span className="topbar-avatar" style={{ padding: 0, overflow: 'hidden' }}>
        <img className="emoji-img" src={`/api/explorer/profile-avatar/${encodeURIComponent(account.accountId)}?v=${profile.avatarVersion}`} alt="" onError={showIconFallback} />
        <span className="icon-fallback" style={{ display: 'none' }}>{account.emoji || '👤'}</span>
      </span>
    )
  }
  if (account) return <AccountEmoji account={account} className="topbar-avatar" />
  return <span className="topbar-avatar">👤</span>
}

// Desktop compact login control: a Connect button logged out, or the account's
// avatar + name opening a small menu (My account / Lists / Log out) logged
// in. Escape and an outside click close the menu, same as the drawer below.
function AccountMenuButton({ session, account, invites, apiAdmin, theme, onToggleTheme, onConnect, onDevices }: {
  session: ReturnType<typeof useSession>
  account: AccountRef | undefined
  invites: number
  apiAdmin: boolean
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  onConnect: () => void
  onDevices: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      btnRef.current?.focus()
    }
    const closeOnOutsideClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      document.removeEventListener('mousedown', closeOnOutsideClick)
    }
  }, [open])
  // Also close on a real navigation (browser back/forward), matching the
  // topbar drawer/nav-dropdown behavior above.
  useEffect(() => {
    const closeOnNavigate = () => setOpen(false)
    window.addEventListener('popstate', closeOnNavigate)
    window.addEventListener('explorer:navigation', closeOnNavigate)
    return () => {
      window.removeEventListener('popstate', closeOnNavigate)
      window.removeEventListener('explorer:navigation', closeOnNavigate)
    }
  }, [])

  if (!session) {
    return <button type="button" className="btn connect-btn" onClick={onConnect}>Log in</button>
  }

  return (
    <div className="account-control" ref={rootRef}>
      <button ref={btnRef} type="button" className="account-btn" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <ProfileAvatar account={account} />
        {/* Same precedence a pill uses (minus tag/module — this IS the viewer):
            profile name, else on-chain identity, else the canonical short
            address. Plain weight/upright — the italic profile voice belongs to
            pills, not chrome. */}
        <span className="account-label">{account?.profile?.name || account?.identity?.display || <ShortAddr addr={account?.address ?? session.address} />}</span>
        {invites > 0 && <span className="invite-badge">{invites}</span>}
      </button>
      {open && (
        <div className="account-menu">
          <Link to={paths.account(session.address)} onClick={() => setOpen(false)}>My account</Link>
          <Link to={paths.lists()} onClick={() => setOpen(false)}>Lists{invites > 0 && <span className="invite-badge">{invites}</span>}</Link>
          <Link to={paths.apiTokens()} onClick={() => setOpen(false)}>API tokens</Link>
          {apiAdmin && <Link to={paths.apiAdmin()} onClick={() => setOpen(false)}>API admin</Link>}
          <button type="button" className="menu-row" onClick={() => { setOpen(false); onDevices() }}>Devices</button>
          {/* The standalone topbar toggle is hidden while logged in — the menu
              is its home then, so the chrome stays one control shorter. */}
          <button type="button" className="menu-row" onClick={onToggleTheme}>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
          <button type="button" className="menu-row" onClick={() => { setOpen(false); void logout() }}>Log out</button>
        </div>
      )}
    </div>
  )
}

// Mobile drawer login section: the same destinations as the desktop menu, as
// plain drawer rows — the drawer is already the expanded surface, so a nested
// popover would be one flyout too many. Notifications is deliberately absent
// here and in the desktop menu: the topbar bell is always visible, so a menu
// row would be a second door to the same room.
function DrawerAccountSection({ session, invites, apiAdmin, onConnect, onDevices, onNavigate }: {
  session: ReturnType<typeof useSession>
  invites: number
  apiAdmin: boolean
  onConnect: () => void
  onDevices: () => void
  onNavigate: () => void
}) {
  if (!session) {
    return (
      <div className="drawer-sec">
        <button type="button" className="btn primary drawer-connect-btn" onClick={onConnect}>Log in</button>
      </div>
    )
  }
  return (
    <div className="drawer-sec">
      <div className="sec-lbl">Account</div>
      <Link to={paths.account(session.address)} onClick={onNavigate}>My account</Link>
      <Link to={paths.lists()} onClick={onNavigate}>Lists{invites > 0 && <span className="invite-badge">{invites}</span>}</Link>
      <Link to={paths.apiTokens()} onClick={onNavigate}>API tokens</Link>
      {apiAdmin && <Link to={paths.apiAdmin()} onClick={onNavigate}>API admin</Link>}
      <button type="button" className="drawer-row" onClick={() => { onNavigate(); onDevices() }}>Devices</button>
      <button type="button" className="drawer-row" onClick={() => { onNavigate(); void logout() }}>Log out</button>
    </div>
  )
}

export function Topbar({ route }: { route: Route }) {
  // Pushes the viewer's tag map into the resolution store — mounted here once
  // so every account pill on every page resolves through it.
  useTagMapSync()
  const session = useSession()
  const me = useMe()
  const account = me.data?.account
  const invites = me.data?.invites.length ?? 0
  const apiAdmin = me.data?.apiAdmin === true
  // The unread badge and the logged-out→login→create handoff both belong to the
  // one component that is mounted on every page.
  const notifications = useNotificationsOverview()
  const unread = session ? notifications.data?.unread ?? 0 : 0
  usePendingNotificationHandoff()
  const { theme, toggle: toggleTheme } = useTheme()
  const isDashboard = route.name === 'dashboard'
  const [drawer, setDrawer] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  // Once true, stays true: the dialog module is only fetched the first time a
  // visitor opens it, then stays mounted (closing just hides it) so reopening
  // doesn't re-import or lose Suspense's already-resolved chunk.
  const [connectMounted, setConnectMounted] = useState(false)
  const openConnect = () => { setConnectMounted(true); setConnectOpen(true) }
  const [devicesOpen, setDevicesOpen] = useState(false)
  const [devicesMounted, setDevicesMounted] = useState(false)
  const openDevices = () => { setDevicesMounted(true); setDevicesOpen(true) }
  // Any other page (a /tags Subscribe row, a public list's own detail
  // page when logged out, ...) opens THIS dialog via requestConnect() rather
  // than mounting a second instance of its own.
  useConnectRequest(openConnect)
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
          {NAV_ENTRIES.map(entry => {
            if (entry.kind === 'link') {
              const it = entry.item
              return <Link key={it.to} to={it.to} className={`nav-link${FOLDABLE.has(it.label) ? ' nav-fold' : ''}${matches(it, route) ? ' active' : ''}`}>{it.label}</Link>
            }
            const { group, fold } = entry
            const active = group.items.some(it => matches(it, route))
            const key = `${group.label}:${fold ?? 'always'}`
            return (
              <div
                className={`nav-group${fold === 'only' ? ' nav-fold-group' : ''}${fold === 'hidden' ? ' nav-unfold-group' : ''}${openGroup === key ? ' open' : ''}`}
                key={key}
                onMouseEnter={() => setOpenGroup(key)}
                onMouseLeave={() => setOpenGroup(null)}
                onFocus={() => setOpenGroup(key)}
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
          {!session && <ThemeToggle onClick={toggleTheme} />}
          <NotificationBell unread={unread} />
          <AccountMenuButton session={session} account={account} invites={invites} apiAdmin={apiAdmin} theme={theme} onToggleTheme={toggleTheme} onConnect={openConnect} onDevices={openDevices} />
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
            <DrawerAccountSection session={session} invites={invites} apiAdmin={apiAdmin} onConnect={() => { setDrawer(false); openConnect() }} onDevices={() => { setDrawer(false); openDevices() }} onNavigate={() => setDrawer(false)} />
            <div className="drawer-sec">
              <div className="sec-lbl">Explore</div>
              {DRAWER_LINKS.map(it => (
                <Link key={it.to} to={it.to} className={matches(it, route) ? 'active' : ''}>{it.label}</Link>
              ))}
            </div>
            {DRAWER_GROUPS.map(group => (
              <div className="drawer-sec" key={group.label}>
                <div className="sec-lbl">{group.label}</div>
                {(group.menuItems ?? group.items).map(it => (
                  <Link key={it.to} to={it.to} className={matches(it, route) ? 'active' : ''}>{it.label}</Link>
                ))}
              </div>
            ))}
            <div className="drawer-sec drawer-controls">
              <ThemeToggle onClick={toggleTheme} />
            </div>
          </nav>
        </div>
      )}
      {connectMounted && (
        <Suspense fallback={null}>
          <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
        </Suspense>
      )}
      {devicesMounted && (
        <Suspense fallback={null}>
          <DevicesDialog open={devicesOpen} onOpenChange={setDevicesOpen} />
        </Suspense>
      )}
    </>
  )
}
