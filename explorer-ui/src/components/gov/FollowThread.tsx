import { useState } from 'react'
import { userApi } from '../../api/explorer'
import { useSession } from '../../session'
import { useNotificationMutation, useNotificationsOverview } from '../../hooks/useNotifications'
import { findEquivalentRule } from '../../notificationKinds'
import { requestConnect } from '../../connectDialog'
import { BellIcon } from '../NotifyButton'

// "Follow" on a forum thread: a `forum-thread` alert rule for the signed-in
// account, read back from the rules it already has (so it reads "Following" on a
// cold load and on every device), and switched off again with one click — a
// follow carries no settings worth confirming the loss of, and Follow brings it
// straight back. Signed out it opens the sign-in dialog; the reader presses Follow
// again once signed in, still on the thread.
//
// With no push or Telegram channel connected the alerts still arrive in the
// notifications inbox (the bell in the top bar); the title says so.
// `variant="icon"`: the bell alone, for a thread's header row; its name says what it does.
export function FollowThread({ threadKey, title, variant = 'btn' }: { threadKey: string; title: string; variant?: 'btn' | 'icon' }) {
  const session = useSession()
  const overview = useNotificationsOverview()
  const create = useNotificationMutation(userApi.createNotificationRule)
  const remove = useNotificationMutation(userApi.deleteNotificationRule)
  const [error, setError] = useState<string | null>(null)
  const want = { kind: 'forum-thread' as const, params: { threadKey } }
  const existing = session ? findEquivalentRule(overview.data?.rules ?? [], want) : undefined
  const busy = create.isPending || remove.isPending || (!!session && overview.isLoading)
  const hasChannel = (overview.data?.channels.length ?? 0) > 0
  const name = `Thread: ${title.trim() || threadKey}`.slice(0, 48)

  const hint = !session
    ? 'Sign in to follow this thread'
    : existing
      ? 'Following — click to stop'
      : hasChannel
        ? 'Get an alert for every new comment here'
        : 'Get an alert for every new comment here — it lands in your notifications inbox; connect push or Telegram on the Notifications page to be told elsewhere'

  return (
    <span className="notify-wrap">
      <button
        type="button"
        className={`${variant === 'icon' ? 'gov-icon-btn notify-icon' : 'btn sm notify-btn'}${existing ? ' on' : ''}`}
        disabled={busy}
        aria-pressed={session ? !!existing : undefined}
        title={hint}
        onClick={() => {
          setError(null)
          if (!session) { requestConnect(); return }
          if (existing) {
            remove.mutateAsync([existing.id]).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Couldn’t stop following'))
            return
          }
          create.mutateAsync([{ kind: want.kind, params: want.params, name }])
            .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Couldn’t follow this thread'))
        }}
      >
        {variant === 'icon'
          ? <><BellIcon /><span className="sr-only">{existing ? 'Following this thread' : 'Follow this thread: alert me about new comments'}</span></>
          : <><BellIcon /> {existing ? 'Following' : 'Follow'}</>}
      </button>
      {error && <span className="notify-error" role="alert">{error}</span>}
    </span>
  )
}
