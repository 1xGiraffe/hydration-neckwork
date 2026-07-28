import { lazy, Suspense, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { userApi } from '../api/explorer'
import { AccountPicker } from '../components/AccountPicker'
import { useSession } from '../session'
import { useLibrary, useUserMutation } from '../hooks/useUser'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { navigate, paths } from '../router'
import { Crumbs, AddrPill, TagIcon, Copy, EmptyRow, ProfilePageSkeleton } from '../components/ui'
import type { LibrarySummaryRef, LibraryTagDetail } from '../types'

const LibraryFormDialog = lazy(() => import('../components/LibraryFormDialog').then(m => ({ default: m.LibraryFormDialog })))

// Duplicated (in full) from Libraries.tsx rather than imported: both pages are
// separate route chunks, and importing across them would drag the whole
// Libraries page — its Discover table, its own hooks — into this one just for
// a three-line badge.
function visibilityChip(lib: Pick<LibrarySummaryRef, 'isPersonal' | 'visibility'>) {
  const [label, color] = lib.isPersonal ? ['personal', 'var(--amber)'] : lib.visibility === 'public' ? ['public', 'var(--sky)'] : ['private', 'var(--neutral)']
  return <span className="badge" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{label}</span>
}

const TAG_COLORS = ['#5865f2', '#22c55e', '#f97316', '#7b6cf6', '#ef4444', '#06b6d4', '#eab308', '#74C742']

function DeleteLibraryDialog({ open, onOpenChange, name, pending, error, onConfirm }: {
  open: boolean; onOpenChange: (open: boolean) => void; name: string; pending: boolean; error: string | null; onConfirm: () => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog" style={{ width: 'min(420px, 94vw)' }}>
          <div className="dialog-head">
            <Dialog.Title asChild><h2>Delete library</h2></Dialog.Title>
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

function NewTagDialog({ open, onOpenChange, libraryId }: { open: boolean; onOpenChange: (open: boolean) => void; libraryId: string }) {
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
      await mutation.mutateAsync([libraryId, { name: name.trim(), color, icon: icon.trim() || undefined }])
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
            <Dialog.Description className="dialog-hint">Group accounts inside this library under one label.</Dialog.Description>
            {error && <div className="dialog-error">{error}</div>}
            <div className="field">
              <label htmlFor="tag-name-input">Name</label>
              <input id="tag-name-input" value={name} maxLength={40} onChange={e => setName(e.target.value)} disabled={mutation.isPending} />
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
              <input id="tag-icon-input" value={icon} maxLength={4} placeholder="🏷️" onChange={e => setIcon(e.target.value)} disabled={mutation.isPending} />
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
// rename/delete + inline color/emoji editing) and a member table (owner-only
// per-row remove + an add-members textarea).
function TagPanel({ libraryId, tag, isOwner }: { libraryId: string; tag: LibraryTagDetail; isOwner: boolean }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(tag.name)
  const [color, setColor] = useState(tag.color)
  const [icon, setIcon] = useState(tag.icon)
  const [addAddrs, setAddAddrs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const updateTagMutation = useUserMutation(userApi.updateTag)
  const deleteTagMutation = useUserMutation(userApi.deleteTag)
  const membersMutation = useUserMutation(userApi.setTagMembers)

  function startEdit() {
    setName(tag.name); setColor(tag.color); setIcon(tag.icon); setError(null); setEditing(true)
  }
  async function saveEdit() {
    setError(null)
    try {
      await updateTagMutation.mutateAsync([libraryId, tag.tagId, { name: name.trim(), color, icon }])
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the tag')
    }
  }
  async function removeTag() {
    if (!window.confirm(`Delete the "${tag.name}" tag? Its members stay in the library — only the tag is removed.`)) return
    setError(null)
    try { await deleteTagMutation.mutateAsync([libraryId, tag.tagId]) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not delete the tag') }
  }
  async function removeMember(address: string) {
    setError(null)
    try { await membersMutation.mutateAsync([libraryId, tag.tagId, { remove: [address] }]) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not remove that account') }
  }
  async function addMembers() {
    if (!addAddrs.length) return
    setError(null)
    try {
      await membersMutation.mutateAsync([libraryId, tag.tagId, { add: addAddrs }])
      setAddAddrs([])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add those accounts')
    }
  }

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        {editing ? (
          <span className="row gap6" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={icon} onChange={e => setIcon(e.target.value)} style={{ width: 48 }} aria-label="Tag icon" maxLength={4} disabled={updateTagMutation.isPending} />
            <input value={name} onChange={e => setName(e.target.value)} aria-label="Tag name" maxLength={40} disabled={updateTagMutation.isPending} />
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
              <TagIcon icon={tag.icon} title={tag.name} />
              <span className="tag" style={{ color: tag.color }}>{tag.name}</span>
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
      <table className="tbl">
        <thead><tr><th>Account</th>{isOwner && <th className="r">Remove</th>}</tr></thead>
        <tbody>
          {!tag.members.length ? <EmptyRow cols={isOwner ? 2 : 1}>No accounts yet</EmptyRow> : tag.members.map(m => (
            <tr key={m.accountId}>
              <td data-label="Account">
                <span className="row gap6" style={{ alignItems: 'center' }}>
                  <AddrPill account={m} noTag noCopy />
                  <Copy text={m.address} />
                </span>
              </td>
              {isOwner && (
                <td data-label="Remove" className="r">
                  <button type="button" className="btn sm" aria-label={`Remove ${m.address}`} disabled={membersMutation.isPending} onClick={() => void removeMember(m.address)}>✕</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {isOwner && (
        <div style={{ padding: 16 }}>
          <div className="field">
            <label htmlFor={`add-members-${tag.tagId}`}>Add accounts</label>
            <AccountPicker inputId={`add-members-${tag.tagId}`} values={addAddrs} onChange={setAddAddrs} placeholder="Search accounts or paste addresses" disabled={membersMutation.isPending} />
          </div>
          <button type="button" className="btn sm primary" style={{ marginTop: 8 }} disabled={membersMutation.isPending || !addAddrs.length} onClick={() => void addMembers()}>Add</button>
        </div>
      )}
    </div>
  )
}

export function LibraryDetail({ libraryId }: { libraryId: string }) {
  const session = useSession()
  const { data, isLoading, isError } = useLibrary(libraryId, !!session)
  useDocumentTitle(data?.name)
  const isOwner = !!session && !!data && session.accountId === data.owner.accountId

  const [editOpen, setEditOpen] = useState(false)
  const [editMounted, setEditMounted] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [newTagOpen, setNewTagOpen] = useState(false)
  const [shareAddrs, setShareAddrs] = useState<string[]>([])
  const [shareError, setShareError] = useState<string | null>(null)

  const updateMutation = useUserMutation(userApi.updateLibrary)
  const deleteMutation = useUserMutation(userApi.deleteLibrary)
  const subscribeMutation = useUserMutation(userApi.subscribe)
  const unsubscribeMutation = useUserMutation(userApi.unsubscribe)
  const inviteMutation = useUserMutation(userApi.invite)
  const revokeMutation = useUserMutation(userApi.revokeInvite)

  // Chips submit sequentially so one bad address reports its own error while
  // the rest still land; successfully-sent chips leave the picker.
  async function invite() {
    setShareError(null)
    for (const addr of shareAddrs) {
      try { await inviteMutation.mutateAsync([libraryId, addr]) }
      catch (e) { setShareError(e instanceof Error ? `${addr}: ${e.message}` : 'Could not send the invite'); return }
      setShareAddrs(prev => prev.filter(a => a !== addr))
    }
  }
  async function revoke() {
    setShareError(null)
    for (const addr of shareAddrs) {
      try { await revokeMutation.mutateAsync([libraryId, addr]) }
      catch (e) { setShareError(e instanceof Error ? `${addr}: ${e.message}` : 'Could not revoke that address'); return }
      setShareAddrs(prev => prev.filter(a => a !== addr))
    }
  }
  async function confirmDelete() {
    setDeleteError(null)
    try {
      await deleteMutation.mutateAsync([libraryId])
      setDeleteOpen(false)
      navigate(paths.libraries())
    } catch (e) {
      // Surfaced inline via DeleteLibraryDialog's `error` prop; the dialog stays
      // open (closing on a failed delete would hide the only sign it failed).
      setDeleteError(e instanceof Error ? e.message : 'Could not delete the library')
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
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Libraries', to: paths.libraries() }, { label: data?.name ?? 'Library' }]} />
      </div>

      {isError ? (
        <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Library not found</div>
      ) : isLoading || !data ? <ProfilePageSkeleton /> : (() => {
        const icon = data.tags[0]?.icon || '🗂️'
        return (
          <>
            <div className="acct-head">
              <div className="acct-avatar"><TagIcon icon={icon} title={data.name} className="acct-avatar-icon" /></div>
              <div className="acct-meta">
                <div className="tag">{data.name} <span className="em">· library</span></div>
                <div className="full row gap6" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <AddrPill account={data.owner} noCopy />
                  {visibilityChip(data)}
                </div>
                {data.note && <div className="muted" style={{ marginTop: 4 }}>{data.note}</div>}
                <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>{data.subscriberCount} subscriber{data.subscriberCount === 1 ? '' : 's'}</div>
              </div>
              <div className="row gap6">
                {isOwner ? (
                  <>
                    <button type="button" className="btn" onClick={() => { setEditMounted(true); setEditOpen(true) }}>Edit</button>
                    {!data.isPersonal && <button type="button" className="btn danger" onClick={() => { setDeleteError(null); setDeleteOpen(true) }}>Delete</button>}
                  </>
                ) : data.visibility === 'public' && session ? (
                  data.subscribed
                    ? <button type="button" className="btn" disabled={unsubscribeMutation.isPending} onClick={() => unsubscribeMutation.mutate([libraryId])}>Unsubscribe</button>
                    : <button type="button" className="btn primary" disabled={subscribeMutation.isPending} onClick={() => subscribeMutation.mutate([libraryId])}>Subscribe</button>
                ) : null}
              </div>
            </div>

            {isOwner && (
              <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
                <div className="sec-title" style={{ margin: '0 0 12px' }}>Invites</div>
                {shareError && <div className="dialog-error" style={{ marginBottom: 8 }}>{shareError}</div>}
                <div className="row gap6" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <AccountPicker values={shareAddrs} onChange={setShareAddrs} placeholder="Search accounts or paste addresses" disabled={inviteMutation.isPending || revokeMutation.isPending} />
                  <button type="button" className="btn sm primary" disabled={inviteMutation.isPending || !shareAddrs.length} onClick={() => void invite()}>Invite</button>
                  <button type="button" className="btn sm" disabled={revokeMutation.isPending || !shareAddrs.length} onClick={() => void revoke()}>Revoke</button>
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>Invite lets these accounts see and accept this private library; Revoke removes a pending invite or an existing subscriber.</div>
              </div>
            )}

            {isOwner ? (
              <>
                <div className="sec-title">Tags · {data.tags.length}</div>
                {!data.tags.length && <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12, marginBottom: 16 }}>No tags yet.</div>}
                {data.tags.map(tag => <TagPanel key={tag.tagId} libraryId={libraryId} tag={tag} isOwner={isOwner} />)}
                <div className="ext-link-row"><button type="button" className="ext-link" style={{ cursor: 'pointer' }} onClick={() => setNewTagOpen(true)}>+ New tag</button></div>
              </>
            ) : (
              /* Another user's curation is theirs: the API ships no tag names
                 or member lists here, only the statistics. Subscribing applies
                 the labels across the explorer without exposing the list. */
              <div className="panel" style={{ padding: 16 }}>
                <div className="lib-stats">
                  <div><span className="lib-stat-num">{data.tagCount}</span><span className="lib-stat-label">Tag{data.tagCount === 1 ? '' : 's'}</span></div>
                  <div><span className="lib-stat-num">{data.accountCount}</span><span className="lib-stat-label">Account{data.accountCount === 1 ? '' : 's'}</span></div>
                  <div><span className="lib-stat-num">{data.subscriberCount}</span><span className="lib-stat-label">Subscriber{data.subscriberCount === 1 ? '' : 's'}</span></div>
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
                  Tag names and member lists stay with the library's owner. {data.visibility === 'public' ? 'Subscribe to apply its labels across the explorer.' : ''}
                </div>
              </div>
            )}

            {isOwner && <NewTagDialog open={newTagOpen} onOpenChange={setNewTagOpen} libraryId={libraryId} />}
            {isOwner && !data.isPersonal && (
              <DeleteLibraryDialog open={deleteOpen} onOpenChange={closeDelete} name={data.name} pending={deleteMutation.isPending} error={deleteError} onConfirm={() => void confirmDelete()} />
            )}
            {editMounted && (
              <Suspense fallback={null}>
                <LibraryFormDialog
                  open={editOpen}
                  onOpenChange={setEditOpen}
                  title="Edit library"
                  hint="Rename it, add a note, or change who can see it."
                  initial={{ name: data.name, note: data.note, visibility: data.visibility }}
                  submitLabel="Save"
                  pending={updateMutation.isPending}
                  onSubmit={async values => { await updateMutation.mutateAsync([libraryId, values]); setEditOpen(false) }}
                />
              </Suspense>
            )}
          </>
        )
      })()}
    </div>
  )
}
