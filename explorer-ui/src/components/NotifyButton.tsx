import { useState } from 'react'
import { userApi } from '../api/explorer'
import { useSession } from '../session'
import { useNotificationMutation, useNotificationsOverview } from '../hooks/useNotifications'
import { deleteRuleConfirmBody, findEquivalentRule, subscribedLabel } from '../notificationKinds'
import { requestConnect } from '../connectDialog'
import { stashPendingNotification, type PendingNotification } from '../pendingNotification'
import { Link, paths } from '../router'
import { ConfirmDialog } from './ConfirmDialog'

// The subscribe affordance every surface carries: one click turns whatever the
// reader is looking at — a safety timeline, an address, a tag, a token, the
// filters they just set — into an alert rule.
//
// Its state is READ FROM THE RULES the viewer already has, never from having
// clicked it: an equivalent rule (same kind, equivalent parameters — see
// findEquivalentRule) makes the button read "Alerting ✓" on a cold load, on
// another device, and on every other surface expressing the same subscription.
// Clicking it then removes that rule, so the button is a toggle rather than a
// one-way door that quietly makes duplicates.
//
// Logged out it is still a real button: the intended rule is parked in local
// storage and the login dialog opens, and the handoff (see
// usePendingNotificationHandoff) creates it and lands them on the alerts tab
// once the wallet round trip finishes. That is the point — a "log in first"
// dead end would lose exactly the context that made the alert worth wanting.
export function NotifyButton({ rule, label = 'Get notified', title, variant = 'btn', manage = true }: {
  rule: PendingNotification
  label?: string
  title?: string
  // 'link' matches the quiet `ext-link` row a detail page already has ("Open in
  // preis ↗"); 'btn' is the small pill used beside a section title or filter.
  variant?: 'btn' | 'link'
  // The alerts tab is where a subscribed button leads for anything more than
  // switching it off — except on the alerts tab itself, which passes false.
  manage?: boolean
}) {
  const session = useSession()
  const overview = useNotificationsOverview()
  const create = useNotificationMutation(userApi.createNotificationRule)
  const remove = useNotificationMutation(userApi.deleteNotificationRule)
  const [error, setError] = useState<string | null>(null)
  // Switching an alert off deletes it, which nothing can undo — so the toggle's
  // OFF direction asks first, in the same words and through the same dialog the
  // rules table uses. (Switching it on is idempotent and reversible: no confirm.)
  const [confirming, setConfirming] = useState(false)
  const className = variant === 'link' ? 'ext-link notify-link' : 'btn sm notify-btn'
  const existing = session ? findEquivalentRule(overview.data?.rules ?? [], rule) : undefined
  const busy = create.isPending || remove.isPending

  return (
    <span className="notify-wrap">
      <button
        type="button"
        className={`${className}${existing ? ' on' : ''}`}
        disabled={busy}
        aria-pressed={existing ? true : undefined}
        title={existing
          ? 'Alerting — click to stop'
          : (title ?? (session ? 'Create an alert for this' : 'Log in to get alerts for this'))}
        onClick={() => {
          setError(null)
          if (existing) { setConfirming(true); return }
          if (!session) {
            stashPendingNotification(rule)
            requestConnect()
            return
          }
          create.mutateAsync([{ kind: rule.kind, params: rule.params, ...(rule.name ? { name: rule.name } : {}) }])
            .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not create the alert'))
        }}
      >
        <BellIcon /> {existing ? subscribedLabel(label) : label}
      </button>
      {existing && manage && (
        <Link to={paths.notifications('alerts')} className="notify-manage" title="Manage your alerts">Manage</Link>
      )}
      {/* While the confirm is open it carries the error itself. */}
      {error && !confirming && <span className="notify-error" role="alert">{error}</span>}
      {existing && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Delete alert"
          body={deleteRuleConfirmBody(existing)}
          pending={remove.isPending}
          error={error}
          onConfirm={() => {
            setError(null)
            remove.mutateAsync([existing.id])
              .then(() => setConfirming(false))
              .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not remove the alert'))
          }}
        />
      )}
    </span>
  )
}

export function BellIcon() {
  return (
    <svg className="notify-bell" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}
