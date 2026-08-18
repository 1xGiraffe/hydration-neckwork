import { Link, paths } from '../router'

// The topbar's link to /notifications, with the unread count as the same
// `invite-badge` pill the account button already uses for pending list invites —
// two counters in the same chrome should not look like two different systems.
//
// Renders logged out too (no badge): the page it leads to is the teaser, and a
// bell that appears only after login is a feature nobody discovers.
export function NotificationBell({ unread, onNavigate }: { unread: number; onNavigate?: () => void }) {
  const has = unread > 0
  return (
    <Link
      to={paths.notifications()}
      className="topbar-bell"
      title={has ? `${unread} unread ${unread === 1 ? 'notification' : 'notifications'}` : 'Notifications'}
      ariaLabel={has ? `Notifications — ${unread} unread` : 'Notifications'}
      onClick={onNavigate}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
      {/* Three digits is the widest the pill stays round at; anything more says
          "a lot", which is all a badge ever means. */}
      {has && <span className="invite-badge">{unread > 99 ? '99+' : unread}</span>}
    </Link>
  )
}
