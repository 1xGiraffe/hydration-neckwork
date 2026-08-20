/* eslint-disable react-refresh/only-export-components -- the page plus the pure tab helpers its tests exercise directly */
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { userApi } from '../api/explorer'
import { useSession } from '../session'
import { requestConnect } from '../connectDialog'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useNow } from '../hooks/useNow'
import { useAssetFilterOptions } from '../hooks/useExplorerData'
import { refreshNotifications, useNotificationInbox, useNotificationMutation, useNotificationsOverview } from '../hooks/useNotifications'
import { Link, paths, setQuery, useQueryValue } from '../router'
import { Ago, Copy, Crumbs, DetailTabs, EmptyRow, F, TableSkeleton, TagIcon } from '../components/ui'
import type { DetailTab } from '../components/ui'
import { NotifyButton } from '../components/NotifyButton'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { cooldownLabel, deleteRuleConfirmBody, ruleTagTarget } from '../notificationKinds'
import { disablePush, enablePush, isStandalone, pushAvailability } from '../push'
import type { NotificationChannel, NotificationInboxRow, NotificationRule, NotificationRuleInput } from '../types'

// Alerts: where the ones already sent are read (the inbox, the default tab),
// where the rules that produce them are managed, and where the channels that
// carry them are linked. Logged out this is the conversion surface every "Get
// notified" button on every other page leads to, so the teaser has to say what
// alerts are FOR, not merely that they exist — and carries no tabs at all,
// since none of the three has anything to show without a session.

const NewAlertDialog = lazy(() => import('../components/NewAlertDialog').then(m => ({ default: m.NewAlertDialog })))

const INBOX_PAGE = 50

const NOTIFICATION_TABS = ['inbox', 'alerts', 'channels'] as const
export type NotificationTab = typeof NOTIFICATION_TABS[number]

// The inbox is the default and carries no `?tab=` at all — the bell in the
// topbar leads to the plain URL, and what it is a badge FOR is the inbox.
export function notificationTab(param: string): NotificationTab {
  return (NOTIFICATION_TABS as readonly string[]).includes(param) && param !== 'inbox' ? param as NotificationTab : 'inbox'
}

// The tab bar's own affordances, kept pure so what each one signals is testable
// without a page: the inbox wears the unread pill, alerts its rule count, and
// channels an attention dot when rules exist with nowhere to deliver — alerts
// still land in the inbox, which is exactly the state that is easy to miss.
export function notificationTabs({ unread, ruleCount, channelCount }: { unread: number; ruleCount: number; channelCount: number }): DetailTab[] {
  return [
    {
      key: 'inbox',
      label: 'Inbox',
      badge: unread > 0 ? <span className="invite-badge">{unread > 99 ? '99+' : unread}</span> : undefined,
    },
    { key: 'alerts', label: 'Alerts', ...(ruleCount > 0 ? { count: ruleCount } : {}) },
    {
      key: 'channels',
      label: 'Channels',
      dot: ruleCount > 0 && channelCount === 0,
      ...(ruleCount > 0 && channelCount === 0 ? { title: 'No channel linked — alerts only land in your inbox' } : {}),
    },
  ]
}

export function Notifications() {
  useDocumentTitle('Notifications')
  const session = useSession()
  const overview = useNotificationsOverview()
  const tab = notificationTab(useQueryValue('tab'))
  // The inbox is fetched only when it is on screen: it is also what MARKS the
  // rows read, and a background fetch on another tab would clear the badge the
  // reader never looked at.
  const inbox = useNotificationInbox(INBOX_PAGE, 0, tab === 'inbox')
  const assets = useAssetFilterOptions()
  const now = useNow()
  const createRule = useNotificationMutation(userApi.createNotificationRule)
  const patchRule = useNotificationMutation(userApi.updateNotificationRule)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogMounted, setDialogMounted] = useState(false)
  // The rule the dialog is editing; null = the dialog creates. Cleared when the
  // dialog closes so "+ New alert" never opens seeded with the last edit.
  const [editRule, setEditRule] = useState<NotificationRule | null>(null)
  const openDialog = () => { setDialogMounted(true); setDialogOpen(true) }
  const channels = overview.data?.channels ?? []
  const rules = overview.data?.rules ?? []

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Notifications' }]} />
        <div className="page-title">
          Notifications <span className="sub">alerts for what you watch</span>
        </div>
      </div>

      {!session ? <NotificationsTeaser /> : (
        <>
          <DetailTabs
            tabs={notificationTabs({ unread: overview.data?.unread ?? 0, ruleCount: rules.length, channelCount: channels.length })}
            active={tab}
            onChange={k => setQuery({ tab: k === 'inbox' ? null : k })}
          />

          {tab === 'inbox' && (
            <InboxSection rows={inbox.data?.rows ?? []} unread={inbox.data?.unread ?? 0} loading={inbox.isLoading} now={now} />
          )}

          {tab === 'alerts' && (
            <RulesSection
              rules={rules}
              channels={channels}
              loading={overview.isLoading}
              onNew={openDialog}
              onEdit={rule => { setEditRule(rule); setDialogMounted(true); setDialogOpen(true) }}
            />
          )}

          {tab === 'channels' && (
            <ChannelsSection
              channels={channels}
              vapidPublicKey={overview.data?.vapidPublicKey ?? ''}
              telegramBot={overview.data?.telegramBot ?? ''}
              loading={overview.isLoading}
              onChanged={() => { void overview.refetch() }}
            />
          )}
        </>
      )}

      {dialogMounted && (
        <Suspense fallback={null}>
          <NewAlertDialog
            open={dialogOpen}
            onOpenChange={open => { setDialogOpen(open); if (!open) setEditRule(null) }}
            assets={assets.data ?? []}
            pending={createRule.isPending || patchRule.isPending}
            editRule={editRule}
            onSubmit={async (input: NotificationRuleInput) => {
              if (editRule) {
                // The dialog rebuilt the full params, so the patch replaces them
                // wholesale; name and frequency arrive always, so clearing sticks.
                await patchRule.mutateAsync([editRule.id, { params: input.params, name: input.name ?? '', cooldownS: input.cooldownS ?? 0 }])
              } else {
                await createRule.mutateAsync([input])
              }
              setDialogOpen(false)
              setEditRule(null)
            }}
          />
        </Suspense>
      )}
    </div>
  )
}

/* ── logged out ─────────────────────────────────────────────────────────── */

// Concrete alerts, in the words of the people who asked for them — a list of
// trigger TYPES ("account activity", "event matcher") describes the machinery,
// not the reason anyone would want it.
const PERSONAS: { who: string; want: string; how: string }[] = [
  { who: 'Treasury watcher', want: 'Tell me when the treasury moves', how: 'Account activity over $50k on one address' },
  { who: 'Borrower', want: 'Warn me before I get liquidated', how: 'Health factor below 1.1 on my position' },
  { who: 'Trader', want: 'Ping me when HDX crosses my price', how: 'Price alert, above or below, on any token' },
  { who: 'Whale spotter', want: 'Show me the big trades as they land', how: 'Any trade over $10k, chain-wide or per token' },
  { who: 'Voter', want: 'Do not let me miss a referendum', how: 'Referenda entering the phases you pick' },
  { who: 'Risk desk', want: 'Tell me the moment a fuse trips', how: 'Every circuit breaker, pause, freeze and lockdown' },
]

export function NotificationsTeaser() {
  return (
    <>
      <div className="notif-hero detail-card">
        <div className="notif-hero-copy">
          <h2>Get told the moment it happens.</h2>
          <p>
            Pick what matters — an address, a token, a position, a referendum, a circuit breaker — and the explorer
            watches every finalized block for you. Alerts arrive as a browser or home-screen push, on Telegram, or
            both, and every one of them is also kept here in your inbox.
          </p>
          <div className="notif-hero-actions">
            <button type="button" className="btn primary" onClick={requestConnect}>Log in to set up alerts</button>
            <span className="muted notif-hero-note">Your wallet is the login — no email, no password.</span>
          </div>
        </div>
        <div className="notif-hero-channels">
          <span className="notif-channel-badge">Browser push</span>
          <span className="notif-channel-badge">Installed app</span>
          <span className="notif-channel-badge">Telegram</span>
        </div>
      </div>

      <div className="sec-title">What people watch</div>
      <div className="notif-personas">
        {PERSONAS.map(p => (
          <div key={p.who} className="notif-persona">
            <div className="notif-persona-who">{p.who}</div>
            <div className="notif-persona-want">“{p.want}”</div>
            <div className="notif-persona-how">{p.how}</div>
          </div>
        ))}
      </div>

      <div className="muted notif-foot-note">
        Alerts only ever fire forward, on finalized blocks — a backfill or a repair can never wake you up.
      </div>
    </>
  )
}

/* ── channels ───────────────────────────────────────────────────────────── */

export function ChannelsSection({ channels, vapidPublicKey, telegramBot, loading, onChanged }: {
  channels: NotificationChannel[]
  vapidPublicKey: string
  telegramBot: string
  loading?: boolean
  onChanged: () => void
}) {
  const pushChannels = channels.filter(c => c.kind === 'webpush')
  const telegramChannels = channels.filter(c => c.kind === 'telegram')
  return (
    <>
      <div className="sec-title">Channels</div>
      <div className="panel notif-panel">
        <div className="notif-list">
          <PushChannels channels={pushChannels} vapidPublicKey={vapidPublicKey} loading={loading} onChanged={onChanged} />
          <TelegramChannels channels={telegramChannels} telegramBot={telegramBot} onChanged={onChanged} />
        </div>
      </div>
    </>
  )
}

function PushChannels({ channels, vapidPublicKey, loading, onChanged }: {
  channels: NotificationChannel[]
  vapidPublicKey: string
  loading?: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Availability is read once per render rather than in an effect: it is a
  // property of the browser, not of any state this page owns.
  const availability = pushAvailability()

  async function enable() {
    setBusy(true); setError(null)
    try {
      await enablePush(vapidPublicKey)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not enable push on this browser')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="notif-group-head">
        <span className="notif-group-title">Browser &amp; app push</span>
        {vapidPublicKey && availability === 'supported' && (
          <button type="button" className="btn sm primary" disabled={busy} onClick={() => void enable()}>
            {channels.length ? 'Add this browser' : 'Enable push'}
          </button>
        )}
      </div>
      {!vapidPublicKey ? (
        <div className="notif-note">Web Push is not configured on this deployment.</div>
      ) : availability === 'ios-install' ? (
        <div className="notif-note">
          On iPhone and iPad, push works only from an installed app: open the Share menu and choose
          “Add to Home Screen”, then enable push from there.
        </div>
      ) : availability === 'unsupported' ? (
        <div className="notif-note">This browser cannot receive push notifications. Telegram works everywhere.</div>
      ) : null}
      {error && <div className="dialog-error">{error}</div>}
      {loading && !channels.length ? null : channels.map(channel => (
        <ChannelRow key={channel.id} channel={channel} onChanged={onChanged} />
      ))}
      {!channels.length && vapidPublicKey && availability === 'supported' && (
        <div className="notif-note">
          No browser registered yet{isStandalone() ? ' for this installed app' : ''}. Each browser and device is its own channel.
        </div>
      )}
    </>
  )
}

function TelegramChannels({ channels, telegramBot, onChanged }: {
  channels: NotificationChannel[]
  telegramBot: string
  onChanged: () => void
}) {
  const [linking, setLinking] = useState(false)
  return (
    <>
      <div className="notif-group-head">
        <span className="notif-group-title">Telegram</span>
        {telegramBot && !channels.length && !linking && (
          <button type="button" className="btn sm primary" onClick={() => setLinking(true)}>Link Telegram</button>
        )}
      </div>
      {!telegramBot ? (
        <div className="notif-note">Telegram is not configured on this deployment.</div>
      ) : channels.length ? (
        channels.map(channel => <ChannelRow key={channel.id} channel={channel} onChanged={onChanged} />)
      ) : linking ? (
        <TelegramLinkPanel
          onCancel={() => setLinking(false)}
          onLinked={() => { setLinking(false); onChanged() }}
        />
      ) : (
        <div className="notif-note">Not linked. Linking opens a chat with @{telegramBot} and takes one tap.</div>
      )}
    </>
  )
}

const LINK_POLL_MS = 3000

// The link code is minted here, shown as a deep link (and as the code itself,
// for a desktop browser handing it to a phone), and polled until the bot
// reports it claimed. The code lives only inside this panel — leaving discards
// it, and it expires server-side on its own — mirroring the device-link QR.
function TelegramLinkPanel({ onCancel, onLinked }: { onCancel: () => void; onLinked: () => void }) {
  const [link, setLink] = useState<{ code: string; url: string; expiresAt: string } | null>(null)
  const [status, setStatus] = useState<'pending' | 'claimed' | 'expired'>('pending')
  const [error, setError] = useState<string | null>(null)
  // The page above this panel re-renders on the shared 1s clock (useNow), so
  // `onLinked` is a new function every second. Naming it in the poll effect's
  // dependencies would tear the interval down and rebuild it a full second
  // before its first tick — the poll would never fire at all, and a linked chat
  // would only ever show up after a manual reload.
  const onLinkedRef = useRef(onLinked)
  useEffect(() => { onLinkedRef.current = onLinked })

  useEffect(() => {
    let cancelled = false
    userApi.createTelegramLink()
      .then(l => { if (!cancelled) setLink(l) })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not create a link code') })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!link || status !== 'pending') return
    const poll = setInterval(() => {
      userApi.telegramLinkStatus(link.code)
        .then(({ status: next }) => {
          if (next === 'claimed') { setStatus('claimed'); onLinkedRef.current() }
          else if (next === 'expired') setStatus('expired')
        })
        .catch(() => { /* a missed poll is the next poll's problem */ })
    }, LINK_POLL_MS)
    return () => clearInterval(poll)
  }, [link, status])

  if (error) return <div className="dialog-error">{error}</div>
  if (status === 'claimed') return <div className="notif-linked">✓ Telegram linked.</div>
  if (status === 'expired') return <div className="notif-note">That code expired. Close this and link again.</div>
  if (!link) return <div className="notif-note">Creating a link code…</div>

  return (
    <div className="notif-link-panel">
      <a className="btn primary" href={link.url} target="_blank" rel="noopener">Open Telegram</a>
      <div className="notif-link-code">
        <span className="muted">or send</span>
        <span className="mono">/start {link.code}</span>
        <Copy text={`/start ${link.code}`} />
      </div>
      <div className="muted notif-note">Waiting for the bot to confirm… anyone holding this code can attach their chat, so keep it to yourself.</div>
      <button type="button" className="btn sm" onClick={onCancel}>Cancel</button>
    </div>
  )
}

function ChannelRow({ channel, onChanged }: { channel: NotificationChannel; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // Removing a channel cannot be undone — a browser has to grant permission and
  // subscribe again, a chat has to re-run /start — so it asks first, naming the
  // channel it is about to drop. (Muting a rule is one click: it is reversible.)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)

  async function test() {
    setBusy(true); setNote(null)
    try { await userApi.testNotificationChannel(channel.id); setNote('Test sent') }
    catch (e) { setNote(e instanceof Error ? e.message : 'Could not send a test') }
    finally { setBusy(false) }
  }
  async function remove() {
    setBusy(true); setConfirmError(null); setNote(null)
    try {
      if (channel.kind === 'webpush') await disablePush(channel.id)
      else await userApi.deleteNotificationChannel(channel.id)
      setConfirming(false)
      onChanged()
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : 'Could not remove the channel')
      setBusy(false)
    }
  }

  const telegram = channel.kind === 'telegram'
  const title = telegram
    ? (channel.username ? `@${channel.username}` : 'Telegram')
    : (channel.label || 'This browser')
  const meta = telegram ? 'Telegram' : (channel.endpointHost || 'push service')

  return (
    <div className="notif-row">
      <div className="notif-row-main">
        <div className="notif-row-title">
          {title}
          {!channel.verified && <span className="badge pending">unverified</span>}
        </div>
        <div className="notif-row-meta mono">{meta}{note ? ` · ${note}` : ''}</div>
      </div>
      <div className="notif-row-actions">
        <button type="button" className="btn sm" disabled={busy} onClick={() => void test()}>Test</button>
        <button type="button" className="btn sm danger" disabled={busy} onClick={() => { setConfirmError(null); setConfirming(true) }}>
          {telegram ? 'Unlink' : 'Remove'}
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={open => { setConfirming(open); if (!open) setBusy(false) }}
        title={telegram ? 'Unlink Telegram' : 'Remove channel'}
        body={telegram
          ? `Unlink "${title}"? Alerts stop arriving in that chat. Linking again takes one tap.`
          : `Remove "${title}"? Alerts stop arriving on that browser until it is registered again.`}
        confirmLabel={telegram ? 'Unlink' : 'Remove'}
        pending={busy}
        error={confirmError}
        onConfirm={() => void remove()}
      />
    </div>
  )
}

/* ── rules ──────────────────────────────────────────────────────────────── */

export function RulesSection({ rules, channels, loading, onNew, onEdit }: {
  rules: NotificationRule[]
  channels: NotificationChannel[]
  loading?: boolean
  onNew?: () => void
  onEdit?: (rule: NotificationRule) => void
}) {
  const update = useNotificationMutation(userApi.updateNotificationRule)
  const remove = useNotificationMutation(userApi.deleteNotificationRule)
  // Delete is the one action here nothing can undo (mute is a toggle), so it goes
  // through the shared confirm, naming the rule the same way the row does.
  const [confirmRule, setConfirmRule] = useState<NotificationRule | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const byId = new Map(channels.map(c => [c.id, c]))
  const channelName = (c: NotificationChannel) => (c.kind === 'telegram' ? (c.username ? `@${c.username}` : 'Telegram') : (c.label || c.endpointHost || 'Browser'))

  return (
    <>
      <div className="sec-title-row">
        <div className="sec-title">Alerts{rules.length ? ` · ${rules.length}` : ''}</div>
        {onNew && <button type="button" className="btn sm primary" onClick={onNew}>+ New alert</button>}
      </div>
      <div className="panel"><table className="tbl">
        <thead><tr><th>Alert</th><th>Channels</th><th className="r">Frequency</th><th className="r"></th></tr></thead>
        <tbody>
          {loading && !rules.length ? <TableSkeleton cols={4} rows={3} />
            : !rules.length ? <EmptyRow cols={4}>No alerts yet — “New alert”, or the bell on any account, asset or filter.</EmptyRow>
              : rules.map(rule => (
                <tr key={rule.id} className={rule.muted ? 'notif-rule-muted' : undefined}>
                  <td data-label="Alert">
                    <div className="notif-row-title">
                      <span className="badge notif-kind">{rule.kindLabel}</span>
                      <RuleTargetPill rule={rule} />
                      {rule.name || rule.summary}
                      {rule.muted && <span className="badge pending">muted</span>}
                    </div>
                    {rule.name ? <div className="notif-row-meta">{rule.summary}</div> : null}
                  </td>
                  {/* Which channels carry this rule is a fact about the CHANNELS
                      tab, so every chip is a way there — including the "all
                      channels" default, which is the one worth checking when
                      nothing is linked. */}
                  <td data-label="Channels">
                    {!rule.channels.length
                      ? <Link to={paths.notifications('channels')} className="muted" style={{ fontSize: 11 }}>All channels</Link>
                      : rule.channels.map(id => {
                        const channel = byId.get(id)
                        return <Link key={id} to={paths.notifications('channels')} className="notif-chip">{channel ? channelName(channel) : 'removed channel'}</Link>
                      })}
                  </td>
                  <td data-label="Frequency" className="r mono muted">{cooldownLabel(rule.cooldownS)}</td>
                  <td data-label="Actions" className="r">
                    <span className="notif-row-actions">
                      {onEdit && (
                        <button type="button" className="btn sm" onClick={() => onEdit(rule)}>Edit</button>
                      )}
                      <button type="button" className="btn sm" disabled={update.isPending}
                        aria-pressed={rule.muted}
                        onClick={() => update.mutate([rule.id, { muted: !rule.muted }])}>
                        {rule.muted ? 'Unmute' : 'Mute'}
                      </button>
                      <button type="button" className="btn sm danger" disabled={remove.isPending}
                        onClick={() => { setConfirmError(null); setConfirmRule(rule) }}>Delete</button>
                    </span>
                  </td>
                </tr>
              ))}
        </tbody>
      </table></div>
      {/* The subscriptions with no page of their own to sit on: these are
          chain-wide feeds, not a thing you are looking at when you want them.
          Technical Committee motions are here rather than folded into the
          referendum rule on purpose — committee business reaches nobody who did
          not ask for it by name. */}
      <div className="notif-quick-add">
        <span className="muted">Quick add</span>
        <NotifyButton rule={{ kind: 'referendum', params: {}, name: 'New referenda' }} label="Watch referenda" manage={false} />
        <NotifyButton rule={{ kind: 'tc-motion', params: {}, name: 'TC motions' }} label="Watch TC motions" manage={false} />
        <NotifyButton rule={{ kind: 'safety', params: {}, name: 'Safety actions' }} label="Watch safety actions" manage={false} />
      </div>
      {confirmRule && (
        <ConfirmDialog
          open
          onOpenChange={open => { if (!open) setConfirmRule(null) }}
          title="Delete alert"
          body={deleteRuleConfirmBody(confirmRule)}
          pending={remove.isPending}
          error={confirmError}
          onConfirm={() => {
            setConfirmError(null)
            remove.mutateAsync([confirmRule.id])
              .then(() => setConfirmRule(null))
              .catch((e: unknown) => setConfirmError(e instanceof Error ? e.message : 'Could not delete the alert'))
          }}
        />
      )}
    </>
  )
}

// A tag target renders as the tag itself — icon, its own colour and, when the
// tag stands for more than one account, how many. An address target says
// nothing here: the server's summary already spells the account out.
function RuleTargetPill({ rule }: { rule: NotificationRule }) {
  const target = ruleTagTarget(rule)
  if (!target || !rule.targetLabel) return null
  const to = target.kind === 'list-tag' || target.kind === 'tag' ? paths.tag(target.tagId) : null
  const body = (
    <>
      <TagIcon icon={rule.targetIcon ?? ''} title={rule.targetLabel} />
      <span className="tag" style={rule.targetColor ? { color: rule.targetColor } : undefined}>{rule.targetLabel}</span>
      {rule.targetMemberCount && rule.targetMemberCount > 1
        ? <span className="tag-member-suffix mono">·{F.int(rule.targetMemberCount)}</span>
        : null}
    </>
  )
  return to
    ? <Link to={to} className="addr-pill" title={`${rule.targetLabel} — open the tag`}>{body}</Link>
    : <span className="addr-pill">{body}</span>
}

/* ── inbox ──────────────────────────────────────────────────────────────── */

export function InboxSection({ rows, unread, loading, now }: {
  rows: NotificationInboxRow[]
  unread: number
  loading?: boolean
  now: number
}) {
  // Seeing the inbox IS reading it. Fires once per mount, and only when there
  // is something to mark — a repeated POST on every refetch would fight the
  // badge it is meant to clear. The family is invalidated afterwards so the
  // topbar's bell clears with the rows rather than on its own 60s poll.
  const qc = useQueryClient()
  const marked = useRef(false)
  useEffect(() => {
    if (marked.current || !unread || !rows.length) return
    marked.current = true
    void userApi.markNotificationsRead()
      .then(() => refreshNotifications(qc))
      .catch(() => {})
  }, [unread, rows.length, qc])

  // Emptying the history is not unsubscribing — the rules keep firing — and it
  // cannot be undone, which is exactly what the confirm has to say. Offered only
  // when there is something to clear.
  const clear = useNotificationMutation(userApi.clearNotificationInbox)
  const [confirming, setConfirming] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)

  return (
    <>
      <div className="sec-title-row">
        <div className="sec-title">Inbox{unread > 0 ? ` · ${F.int(unread)} unread` : ''}</div>
        {rows.length > 0 && (
          <button type="button" className="btn sm" disabled={clear.isPending}
            onClick={() => { setClearError(null); setConfirming(true) }}>Clear inbox</button>
        )}
      </div>
      <div className="panel"><table className="tbl">
        <thead><tr><th>Alert</th><th>What happened</th><th className="r">When</th></tr></thead>
        <tbody>
          {loading && !rows.length ? <TableSkeleton cols={3} rows={5} />
            : !rows.length ? (
              <EmptyRow cols={3}>
                Nothing yet — <Link to={paths.notifications('alerts')} className="hash">create an alert</Link> and every one it fires lands here.
              </EmptyRow>
            )
              : rows.map(row => (
                <tr key={row.id} className={row.read ? undefined : 'notif-unread'}>
                  <td data-label="Alert">
                    <span className="badge notif-kind">{row.kindLabel}</span>
                  </td>
                  <td data-label="What happened">
                    <div className="notif-row-title">
                      {row.url ? <Link to={row.url} className="hash">{row.title}</Link> : row.title}
                    </div>
                    {row.body && <div className="notif-row-meta">{row.body}</div>}
                  </td>
                  <td data-label="When" className="r mono muted"><Ago ts={row.createdAt} now={now} /></td>
                </tr>
              ))}
        </tbody>
      </table></div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Clear inbox"
        body={`Clear all ${F.int(rows.length)} notification${rows.length === 1 ? '' : 's'}? Alerts keep firing; this only empties the history.`}
        confirmLabel="Clear inbox"
        pending={clear.isPending}
        error={clearError}
        onConfirm={() => {
          setClearError(null)
          clear.mutateAsync([])
            .then(() => setConfirming(false))
            .catch((e: unknown) => setClearError(e instanceof Error ? e.message : 'Could not clear the inbox'))
        }}
      />
    </>
  )
}
