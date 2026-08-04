import { lazy, Suspense, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { userApi } from '../api/explorer'
import { AccountPicker } from '../components/AccountPicker'
import { useSession } from '../session'
import { requestConnect } from '../connectDialog'
import { useList, useUserMutation } from '../hooks/useUser'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, navigate, paths, setQuery, useQueryValue } from '../router'
import { AddrPill, Crumbs, DetailTabs, ProfilePageSkeleton, TagIcon, noAutofill } from '../components/ui'
import type { AccountRef, ListSummaryRef, ListTagDetail } from '../types'

const ListFormDialog = lazy(() => import('../components/ListFormDialog').then(m => ({ default: m.ListFormDialog })))

// Duplicated (in full) from Lists.tsx rather than imported: both pages are
// separate route chunks, and importing across them would drag the whole
// Lists page — its Discover table, its own hooks — into this one just for
// a three-line badge. Always public/private — `isPersonal` (auto-created,
// not deletable) is a backend/ownership fact, not a visibility state, and
// showing it as a third chip value read as if a personal list were
// neither public nor private, even on ones a viewer had made public.
function visibilityChip(lib: Pick<ListSummaryRef, 'visibility'>) {
  const [label, color] = lib.visibility === 'public' ? ['public', 'var(--sky)'] : ['private', 'var(--neutral)']
  return <span className="badge" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{label}</span>
}

const TAG_COLORS = ['#5865f2', '#22c55e', '#f97316', '#7b6cf6', '#ef4444', '#06b6d4', '#eab308', '#74C742']

function DeleteListDialog({ open, onOpenChange, name, pending, error, onConfirm }: {
  open: boolean; onOpenChange: (open: boolean) => void; name: string; pending: boolean; error: string | null; onConfirm: () => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog" style={{ width: 'min(420px, 94vw)' }}>
          <div className="dialog-head">
            <Dialog.Title asChild><h2>Delete list</h2></Dialog.Title>
            <Dialog.Close asChild>
              <button className="theme-toggle" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </Dialog.Close>
          </div>
          <div className="dialog-body">
            <Dialog.Description className="dialog-hint">Delete "{name}"? Its tags, subscriptions and invites are removed. This cannot be undone.</Dialog.Description>
            {error && <div className="dialog-error">{error}</div>}
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn" onClick={() => onOpenChange(false)}>Cancel</button>
            <button type="button" className="btn danger" disabled={pending} onClick={onConfirm}>Delete</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function NewTagDialog({ open, onOpenChange, listId, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; listId: string; onCreated: (tagId: string) => void }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(TAG_COLORS[0])
  const [icon, setIcon] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mutation = useUserMutation(userApi.createTag)

  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) { setName(''); setColor(TAG_COLORS[0]); setIcon(''); setError(null) }
  }

  async function create() {
    setError(null)
    try {
      const created = await mutation.mutateAsync([listId, { name: name.trim(), color, icon: icon.trim() || undefined }])
      onCreated(created.tagId)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the tag')
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title asChild><h2>New tag</h2></Dialog.Title>
            <Dialog.Close asChild>
              <button className="theme-toggle" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </Dialog.Close>
          </div>
          <div className="dialog-body">
            <Dialog.Description className="dialog-hint">Group accounts inside this list under one label.</Dialog.Description>
            {error && <div className="dialog-error">{error}</div>}
            <div className="field">
              <label htmlFor="tag-name-input">Name</label>
              <input {...noAutofill} id="tag-name-input" value={name} maxLength={40} onChange={e => setName(e.target.value)} disabled={mutation.isPending} />
            </div>
            <div className="field">
              <label id="tag-color-label">Color</label>
              <div className="swatches" role="group" aria-labelledby="tag-color-label">
                {TAG_COLORS.map(c => (
                  <button key={c} type="button" className={`swatch${c === color ? ' on' : ''}`} style={{ background: c }} aria-label={`Color ${c}`} aria-pressed={c === color} onClick={() => setColor(c)} disabled={mutation.isPending} />
                ))}
              </div>
            </div>
            <div className="field">
              <label htmlFor="tag-icon-input">Icon (emoji, optional)</label>
              <input {...noAutofill} id="tag-icon-input" value={icon} maxLength={4} placeholder="🏷️" onChange={e => setIcon(e.target.value)} disabled={mutation.isPending} />
            </div>
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn primary" onClick={() => void create()} disabled={mutation.isPending || !name.trim()}>Create</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// One tag's panel: header (icon, colored name, member count, owner-only
// rename/delete + inline color/emoji editing) and its members as ONE token
// surface — an AccountPicker in immediate-commit mode whose chips are the
// tag's current members, so the input sits right after the last chip inside
// the very same bordered box (no separate chip list under a separate input
// bar). No table, no separate Add step: picking a suggestion or hitting
// Enter on an address-shaped token adds it right away.
function TagPanel({ listId, tag, isOwner }: { listId: string; tag: ListTagDetail; isOwner: boolean }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(tag.name)
  const [color, setColor] = useState(tag.color)
  const [icon, setIcon] = useState(tag.icon)
  const [error, setError] = useState<string | null>(null)

  const updateTagMutation = useUserMutation(userApi.updateTag)
  const deleteTagMutation = useUserMutation(userApi.deleteTag)
  const membersMutation = useUserMutation(userApi.setTagMembers)
  const orderMutation = useUserMutation(userApi.setMemberOrder)

  // Local, optimistic display order for drag/keyboard reorder. Reset
  // whenever the server's own member list changes shape (add, remove, or a
  // reorder that round-tripped) — comparing the joined id list rather than
  // array identity means a reorder that hasn't landed yet (mid-drag, mid-
  // mutation) never gets clobbered by an unrelated re-render of this panel.
  const serverIds = tag.members.map(m => m.accountId)
  const [order, setOrder] = useState(serverIds)
  const [knownServerIds, setKnownServerIds] = useState(serverIds)
  if (serverIds.join('\n') !== knownServerIds.join('\n')) {
    setKnownServerIds(serverIds)
    setOrder(serverIds)
  }
  const memberById = new Map(tag.members.map(m => [m.accountId, m]))
  const orderedMembers = order.map(id => memberById.get(id)).filter((m): m is AccountRef => !!m)
  const reorderPending = orderMutation.isPending
  // An add/remove in flight can change the member set the moment it lands —
  // reordering against that stale local `order` in the meantime could drop
  // or duplicate an id, so dragging/keyboard-moving is disabled for either
  // mutation, not just its own.
  const chipsLocked = reorderPending || membersMutation.isPending
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  async function commitOrder(next: string[]) {
    const prev = order
    setOrder(next)
    try {
      await orderMutation.mutateAsync([listId, tag.tagId, next])
    } catch (e) {
      setOrder(prev)
      setError(e instanceof Error ? e.message : 'Could not save the new order')
    }
  }
  function moveBy(accountId: string, delta: number) {
    const i = order.indexOf(accountId)
    const j = i + delta
    if (i < 0 || j < 0 || j >= order.length) return
    const next = order.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    void commitOrder(next)
  }
  function dropOn(targetId: string) {
    setDraggingId(null); setDragOverId(null)
    if (!draggingId || draggingId === targetId) return
    const from = order.indexOf(draggingId)
    const to = order.indexOf(targetId)
    if (from < 0 || to < 0) return
    const next = order.slice()
    next.splice(from, 1)
    next.splice(to, 0, draggingId)
    void commitOrder(next)
  }
  // Alt/Meta+Arrow while any part of the chip (its AddrPill link, or the ×
  // button) has focus — mirrors the mouse drag without needing a dedicated
  // drag handle. `aria-keyshortcuts`/`aria-label` on the chip announce it.
  function onChipKeyDown(e: React.KeyboardEvent, accountId: string) {
    if (!(e.altKey || e.metaKey) || chipsLocked) return
    if (e.key === 'ArrowLeft') { e.preventDefault(); moveBy(accountId, -1) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); moveBy(accountId, 1) }
  }

  function startEdit() {
    setName(tag.name); setColor(tag.color); setIcon(tag.icon); setError(null); setEditing(true)
  }
  async function saveEdit() {
    setError(null)
    try {
      await updateTagMutation.mutateAsync([listId, tag.tagId, { name: name.trim(), color, icon }])
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the tag')
    }
  }
  async function removeTag() {
    if (!window.confirm(`Delete the "${tag.name}" tag? Its members stay in the list — only the tag is removed.`)) return
    setError(null)
    try { await deleteTagMutation.mutateAsync([listId, tag.tagId]) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not delete the tag') }
  }
  async function removeMember(address: string) {
    setError(null)
    try { await membersMutation.mutateAsync([listId, tag.tagId, { remove: [address] }]) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not remove that account') }
  }
  // Submitted one address at a time — `setTagMembers` validates a whole `add`
  // array atomically, so batching a multi-token paste into one call would let
  // a single bad address reject every good one alongside it, and by the time
  // that failure came back the picker's input (immediate-commit mode has no
  // staging list of its own) would already have cleared it. Sequential calls
  // mirror how Invites submits its chips: whatever landed before the failure
  // stays landed, the error names the address that didn't, and — since there's
  // no chip list here to leave the rest sitting in — the failed address plus
  // everything still unsent is handed back for the picker to restore as text.
  async function addMembers(addresses: string[]): Promise<string[] | void> {
    setError(null)
    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i]
      try {
        await membersMutation.mutateAsync([listId, tag.tagId, { add: [addr] }])
      } catch (e) {
        setError(`${addr}: ${e instanceof Error ? e.message : 'could not add that account'}`)
        return addresses.slice(i)
      }
    }
  }

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        {editing ? (
          <span className="row gap6" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <input {...noAutofill} className="input sm" value={icon} onChange={e => setIcon(e.target.value)} style={{ width: 48 }} aria-label="Tag icon" maxLength={4} disabled={updateTagMutation.isPending} />
            <input {...noAutofill} className="input sm" value={name} onChange={e => setName(e.target.value)} aria-label="Tag name" maxLength={40} disabled={updateTagMutation.isPending} />
            <span className="swatches" role="group" aria-label="Tag color">
              {TAG_COLORS.map(c => (
                <button key={c} type="button" className={`swatch${c === color ? ' on' : ''}`} style={{ background: c, width: 20, height: 20 }} aria-label={`Color ${c}`} aria-pressed={c === color} onClick={() => setColor(c)} disabled={updateTagMutation.isPending} />
              ))}
            </span>
            <button type="button" className="btn sm primary" onClick={() => void saveEdit()} disabled={updateTagMutation.isPending || !name.trim()}>Save</button>
            <button type="button" className="btn sm" onClick={() => setEditing(false)} disabled={updateTagMutation.isPending}>Cancel</button>
          </span>
        ) : (
          <>
            <span className="t row gap6" style={{ alignItems: 'center' }}>
              {/* Same target a resolved tag pill uses (UserTagPill) — the link
                  wraps only the icon+name, not the member count or the whole
                  header row, so it can't swallow the Edit/Delete buttons into
                  a nested anchor. */}
              <Link to={paths.tag(tag.tagId)} className="row gap6 tag-panel-link">
                <TagIcon icon={tag.displayIcon} title={tag.name} className="emoji id tag-panel-icon" />
                <span className="tag" style={{ color: tag.color }}>{tag.name}</span>
              </Link>
              <span className="muted" style={{ fontWeight: 400 }}>· {tag.members.length} accounts</span>
            </span>
            {isOwner && (
              <span className="row gap6">
                <button type="button" className="btn sm" onClick={startEdit}>Edit</button>
                <button type="button" className="btn sm danger" onClick={() => void removeTag()} disabled={deleteTagMutation.isPending}>Delete</button>
              </span>
            )}
          </>
        )}
      </div>
      {error && <div className="dialog-error" style={{ margin: '12px 16px 0' }}>{error}</div>}
      <div style={{ padding: 16 }}>
        {isOwner ? (
          <AccountPicker
            inputId={`add-members-${tag.tagId}`}
            onCommit={addMembers}
            placeholder="Search accounts or paste addresses"
            disabled={chipsLocked}
            chips={
              <div className="tag-member-chips">
                {!orderedMembers.length
                  ? <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12 }}>No accounts yet</div>
                  : orderedMembers.map(m => (
                    <span
                      key={m.accountId}
                      className={`acct-chip tag-member-chip tag-member-chip-draggable${draggingId === m.accountId ? ' dragging' : ''}${dragOverId === m.accountId && draggingId !== m.accountId ? ' drag-over' : ''}`}
                      draggable={!chipsLocked}
                      tabIndex={0}
                      role="group"
                      aria-label={`${m.address} — press Alt+ArrowLeft or Alt+ArrowRight to move it`}
                      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                      onDragStart={() => setDraggingId(m.accountId)}
                      onDragEnd={() => { setDraggingId(null); setDragOverId(null) }}
                      onDragOver={e => { if (draggingId && draggingId !== m.accountId) { e.preventDefault(); setDragOverId(m.accountId) } }}
                      onDragLeave={() => setDragOverId(prev => (prev === m.accountId ? null : prev))}
                      onDrop={e => { e.preventDefault(); dropOn(m.accountId) }}
                      onKeyDown={e => onChipKeyDown(e, m.accountId)}
                    >
                      <AddrPill account={m} noTag noCopy />
                      <button type="button" className="acct-chip-x" aria-label={`Remove ${m.address}`} disabled={membersMutation.isPending} onClick={() => void removeMember(m.address)}>×</button>
                    </span>
                  ))}
              </div>
            }
          />
        ) : (
          <div className="tag-member-chips">
            {!tag.members.length
              ? <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12 }}>No accounts yet</div>
              : tag.members.map(m => (
                <span key={m.accountId} className="acct-chip tag-member-chip">
                  <AddrPill account={m} noTag noCopy />
                </span>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

// The Subscribers tab's rows, shared by both its surfaces: a private
// list's editable chips (an `onRevoke` handler and its ✕ button) and a
// public list's plain read-only list (neither passed — no ✕, since a
// public list has no invite to revoke, only a subscription the account
// itself controls). "invited" gets a small "pending" badge; "active" reads
// plain, same as a tag's member chip.
function ShareChips({ shares, onRevoke, revoking }: {
  shares: { account: AccountRef; status: 'invited' | 'active' }[]
  onRevoke?: (address: string) => void
  revoking?: boolean
}) {
  if (!shares.length) return <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12 }}>No subscribers yet</div>
  return (
    <div className="tag-member-chips">
      {shares.map(s => (
        <span key={s.account.accountId} className="acct-chip tag-member-chip">
          <AddrPill account={s.account} noTag noCopy />
          {s.status === 'invited' && <span className="badge pending">pending</span>}
          {onRevoke && (
            <button type="button" className="acct-chip-x" aria-label={`Revoke ${s.account.address}`} disabled={revoking} onClick={() => onRevoke(s.account.address)}>×</button>
          )}
        </span>
      ))}
    </div>
  )
}

export function ListDetail({ listId }: { listId: string }) {
  const session = useSession()
  const { data, isLoading, isError } = useList(listId, !!session)
  useDocumentTitle(data?.name)
  const isOwner = !!session && !!data && session.accountId === data.owner.accountId
  // Owner-only tabs (Tags/Subscribers); deep-links via ?view= like Account.tsx's
  // profile tabs. The non-owner view has no tabs, only its stats panel. The tab
  // used to be called Invites at `?view=invites` — that value isn't aliased,
  // it just falls back to the default 'tags' tab, same as any other unknown
  // `view`; a stale deep link losing its tab selection is low-stakes.
  const view = useQueryValue('view', 'tags')
  const activeView = view === 'subscribers' ? 'subscribers' : 'tags'

  const [editOpen, setEditOpen] = useState(false)
  const [editMounted, setEditMounted] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [newTagOpen, setNewTagOpen] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)
  // Ids of tags created during THIS mount, in creation order. The server
  // always sorts tags alphabetically (correct for a fresh load — see
  // listDetailResponse), but re-sorting after every create would make a
  // just-created tag jump straight into the middle of the list the instant
  // its name sorts before an existing one, reading as if it moved or briefly
  // vanished. Pinning it to the bottom instead — until the page unmounts,
  // since this state (like a ref) starts fresh on remount, so navigating
  // away/reopening/reloading always shows the honest alphabetical order —
  // keeps a session's own creations predictable without touching the
  // server's stable ordering. Plain state rather than a ref: the ordering
  // below feeds directly into JSX, and reading a ref's value to compute
  // render output is exactly what react-hooks/refs forbids.
  const [sessionNewTagIds, setSessionNewTagIds] = useState<string[]>([])

  const updateMutation = useUserMutation(userApi.updateList)
  const deleteMutation = useUserMutation(userApi.deleteList)
  const subscribeMutation = useUserMutation(userApi.subscribe)
  const unsubscribeMutation = useUserMutation(userApi.unsubscribe)
  const inviteMutation = useUserMutation(userApi.invite)
  const revokeMutation = useUserMutation(userApi.revokeInvite)
  const sharesLocked = inviteMutation.isPending || revokeMutation.isPending

  // Private list's Subscribers tab is a token surface like a tag's member
  // editor (AccountPicker immediate-commit mode): an Enter/pick on the input
  // invites right away, no staging list, no separate Invite button. Submitted
  // sequentially — like setTagMembers' addMembers — so one bad address in a
  // multi-token paste reports itself while every address ahead of it still
  // lands, and whatever never got submitted is handed back for the picker to
  // restore as text rather than silently dropping it.
  async function inviteAddresses(addresses: string[]): Promise<string[] | void> {
    setShareError(null)
    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i]
      try { await inviteMutation.mutateAsync([listId, addr]) }
      catch (e) { setShareError(`${addr}: ${e instanceof Error ? e.message : 'could not invite that account'}`); return addresses.slice(i) }
    }
  }
  async function revokeOne(address: string) {
    setShareError(null)
    try { await revokeMutation.mutateAsync([listId, address]) }
    catch (e) { setShareError(e instanceof Error ? e.message : 'Could not revoke that account') }
  }
  async function confirmDelete() {
    setDeleteError(null)
    try {
      await deleteMutation.mutateAsync([listId])
      setDeleteOpen(false)
      navigate(paths.lists())
    } catch (e) {
      // Surfaced inline via DeleteListDialog's `error` prop; the dialog stays
      // open (closing on a failed delete would hide the only sign it failed).
      setDeleteError(e instanceof Error ? e.message : 'Could not delete the list')
    }
  }
  // Clearing on close (Cancel/Escape/overlay-click, not just the Cancel button)
  // keeps a stale error from a previous failed attempt from flashing before the
  // reset effect would otherwise run on next open.
  function closeDelete(open: boolean) {
    setDeleteOpen(open)
    if (!open) setDeleteError(null)
  }

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Lists', to: paths.lists() }, { label: data?.name ?? 'List' }]} />
      </div>

      {isError ? (
        <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>List not found</div>
      ) : isLoading || !data ? <ProfilePageSkeleton /> : (() => {
        // Render order: the server's alphabetical tags minus this session's
        // new ones, then the new ones in creation order at the end. Resolved
        // against `data.tags` (not cached) on every render, so a session-new
        // tag that got deleted just drops out (no ghost panel) and one that
        // got renamed stays pinned at the bottom under its unchanged tagId.
        const isSessionNew = new Set(sessionNewTagIds)
        const tagById = new Map(data.tags.map(t => [t.tagId, t]))
        const orderedTags = [
          ...data.tags.filter(t => !isSessionNew.has(t.tagId)),
          ...sessionNewTagIds.map(id => tagById.get(id)).filter((t): t is ListTagDetail => !!t),
        ]
        return (
          <>
            <div className="acct-head">
              <div className="acct-meta">
                <div className="tag">{data.name}</div>
                <div className="full row gap6" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <AddrPill account={data.owner} noCopy />
                  {visibilityChip(data)}
                </div>
                {data.note && <div className="muted" style={{ marginTop: 4 }}>{data.note}</div>}
                <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>{data.subscriberCount} subscriber{data.subscriberCount === 1 ? '' : 's'}</div>
              </div>
              <div className="row gap6" style={{ marginLeft: 'auto' }}>
                {isOwner ? (
                  <>
                    <button type="button" className="btn" onClick={() => { setEditMounted(true); setEditOpen(true) }}>Edit</button>
                    {!data.isPersonal && <button type="button" className="btn danger" onClick={() => { setDeleteError(null); setDeleteOpen(true) }}>Delete</button>}
                  </>
                ) : data.visibility === 'public' ? (
                  !session ? (
                    // Same appearance as the logged-in Subscribe button below —
                    // clicking opens the login dialog rather than subscribing
                    // directly; the mutation itself needs a session either way.
                    <button type="button" className="btn primary" onClick={requestConnect}>Subscribe</button>
                  ) : data.subscribed ? (
                    <button type="button" className="btn" disabled={unsubscribeMutation.isPending} onClick={() => unsubscribeMutation.mutate([listId])}>Unsubscribe</button>
                  ) : (
                    <button type="button" className="btn primary" disabled={subscribeMutation.isPending} onClick={() => subscribeMutation.mutate([listId])}>Subscribe</button>
                  )
                ) : null}
              </div>
            </div>

            {isOwner && (
              <DetailTabs
                tabs={[{ key: 'tags', label: 'Tags', count: data.tags.length }, { key: 'subscribers', label: 'Subscribers', count: data.shares?.length ?? 0 }]}
                active={activeView}
                onChange={k => setQuery({ view: k === 'tags' ? null : k })}
              />
            )}

            {isOwner && activeView === 'subscribers' && (
              <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
                {shareError && <div className="dialog-error" style={{ marginBottom: 8 }}>{shareError}</div>}
                {data.visibility === 'private' ? (
                  <AccountPicker
                    inputId="subscribers-input"
                    onCommit={inviteAddresses}
                    placeholder="Search accounts or paste addresses"
                    disabled={sharesLocked}
                    chips={<ShareChips shares={data.shares ?? []} onRevoke={revokeOne} revoking={revokeMutation.isPending} />}
                  />
                ) : (
                  <ShareChips shares={data.shares ?? []} />
                )}
                <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                  {data.visibility === 'private'
                    ? 'Adding an account invites it to this private list; × revokes a pending invite or an existing subscriber.'
                    : 'Public lists are open-subscription — anyone can subscribe without an invite.'}
                </div>
              </div>
            )}

            {isOwner && activeView === 'tags' && (
              <>
                {!data.tags.length && <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12, marginBottom: 16 }}>No tags yet.</div>}
                {orderedTags.map(tag => <TagPanel key={tag.tagId} listId={listId} tag={tag} isOwner={isOwner} />)}
                <div className="ext-link-row"><button type="button" className="ext-link" style={{ cursor: 'pointer' }} onClick={() => setNewTagOpen(true)}>+ New tag</button></div>
              </>
            )}

            {!isOwner && (
              /* Another user's curation is theirs: the API ships no tag names
                 or members here, only the statistics. Subscribing applies
                 the labels across the explorer without exposing the list. */
              <div className="panel" style={{ padding: 16 }}>
                <div className="list-stats">
                  <div><span className="list-stat-num">{data.tagCount}</span><span className="list-stat-label">Tag{data.tagCount === 1 ? '' : 's'}</span></div>
                  <div><span className="list-stat-num">{data.accountCount}</span><span className="list-stat-label">Account{data.accountCount === 1 ? '' : 's'}</span></div>
                  <div><span className="list-stat-num">{data.subscriberCount}</span><span className="list-stat-label">Subscriber{data.subscriberCount === 1 ? '' : 's'}</span></div>
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
                  Tag names and members stay with the list's owner. {data.visibility === 'public' ? 'Subscribe to apply its labels across the explorer.' : ''}
                </div>
              </div>
            )}

            {isOwner && (
              <NewTagDialog
                open={newTagOpen}
                onOpenChange={setNewTagOpen}
                listId={listId}
                onCreated={tagId => setSessionNewTagIds(ids => [...ids, tagId])}
              />
            )}
            {isOwner && !data.isPersonal && (
              <DeleteListDialog open={deleteOpen} onOpenChange={closeDelete} name={data.name} pending={deleteMutation.isPending} error={deleteError} onConfirm={() => void confirmDelete()} />
            )}
            {editMounted && (
              <Suspense fallback={null}>
                <ListFormDialog
                  open={editOpen}
                  onOpenChange={setEditOpen}
                  title="Edit list"
                  hint="Rename it, add a note, or change who can see it."
                  initial={{ name: data.name, note: data.note, visibility: data.visibility }}
                  submitLabel="Save"
                  pending={updateMutation.isPending}
                  onSubmit={async values => { await updateMutation.mutateAsync([listId, values]); setEditOpen(false) }}
                />
              </Suspense>
            )}
          </>
        )
      })()}
    </div>
  )
}
