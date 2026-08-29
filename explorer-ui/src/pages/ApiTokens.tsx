import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, userApi } from '../api/explorer'
import { useSession } from '../session'
import { requestConnect } from '../connectDialog'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useNow } from '../hooks/useNow'
import { paths } from '../router'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Copy, Crumbs, EmptyRow, F, TableSkeleton } from '../components/ui'
import type { ApiTokenInfo, CreatedApiToken } from '../types'

// Data API tokens: mint, recognize and revoke the bearer tokens the
// hydration-data host authenticates with. The raw `hdd_…` secret exists
// client-side exactly once — on the create response — so the create dialog is
// the only surface that ever shows it, and closing that dialog is final.

export const DATA_API_URL = 'https://hydration-data.neckwork.net'

function CreateTokenDialog({ open, onOpenChange, onCreated }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [label, setLabel] = useState('')
  const [created, setCreated] = useState<CreatedApiToken | null>(null)
  const [error, setError] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: (name: string) => userApi.createApiToken(name),
    onSuccess: token => { setCreated(token); setError(null); onCreated() },
    onError: e => setError(e instanceof ApiError ? e.message : 'Could not create the token'),
  })

  // Reset on every open (prop-change-reset, the DevicesDialog pattern) so a
  // previous run's secret can never greet the next open.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) { setLabel(''); setCreated(null); setError(null) }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title asChild><h2>{created ? 'Your new token' : 'Create API token'}</h2></Dialog.Title>
            <Dialog.Close asChild>
              <button className="theme-toggle" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </Dialog.Close>
          </div>
          <div className="dialog-body">
            {created ? (
              <>
                <Dialog.Description className="dialog-hint">
                  You won't see this token again — store it now. Anyone who has it can spend your API budget, so treat it like a password.
                </Dialog.Description>
                <div className="token-reveal mono">
                  <span className="token-reveal-value">{created.token}</span>
                  <Copy text={created.token} />
                </div>
                <div className="dialog-hint">
                  Try it: <code className="mono">curl -H "Authorization: Bearer {created.tokenPrefix}…" {DATA_API_URL}/v1/status</code>
                </div>
              </>
            ) : (
              <form onSubmit={e => { e.preventDefault(); if (!create.isPending) create.mutate(label) }}>
                <Dialog.Description className="dialog-hint">
                  A label helps you recognize the token later — “trading bot”, “tax export”, …
                </Dialog.Description>
                <input
                  className="input"
                  style={{ width: '100%' }}
                  placeholder="Label (optional)"
                  maxLength={100}
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  autoFocus
                />
                {error && <div className="dialog-error">{error}</div>}
              </form>
            )}
          </div>
          <div className="dialog-foot">
            {created ? (
              <button type="button" className="btn primary" onClick={() => onOpenChange(false)}>Done — I stored it</button>
            ) : (
              <>
                <button type="button" className="btn" onClick={() => onOpenChange(false)}>Cancel</button>
                <button type="button" className="btn primary" disabled={create.isPending} onClick={() => create.mutate(label)}>Create token</button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ApiTokensTeaser() {
  return (
    <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)', marginBottom: 16 }}>
      <p style={{ marginTop: 0 }}>Log in to create and manage your API tokens.</p>
      <button type="button" className="btn primary" onClick={requestConnect}>Log in</button>
    </div>
  )
}

export function ApiTokens() {
  useDocumentTitle('API tokens')
  const session = useSession()
  const qc = useQueryClient()
  const now = useNow()
  const tokens = useQuery({
    queryKey: ['user', 'api-tokens', session?.accountId],
    queryFn: ({ signal }) => userApi.apiTokens(signal),
    enabled: !!session,
    staleTime: 5000,
  })
  const [createOpen, setCreateOpen] = useState(false)
  const [confirmToken, setConfirmToken] = useState<ApiTokenInfo | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const revoke = useMutation({
    mutationFn: (id: string) => userApi.revokeApiToken(id),
    onSuccess: () => {
      setConfirmToken(null)
      setConfirmError(null)
      void qc.invalidateQueries({ queryKey: ['user', 'api-tokens'] })
    },
    onError: e => setConfirmError(e instanceof ApiError ? e.message : 'Could not revoke the token'),
  })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['user', 'api-tokens'] })

  const rows = tokens.data?.tokens ?? []
  const maxTokens = tokens.data?.maxTokens ?? 10
  const docsUrl = tokens.data?.docsUrl ?? `${DATA_API_URL}/docs`

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'API tokens' }]} />
        {/* The Lists page's head: title, and the one create action on the right. */}
        <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          API tokens
          {session && (
            <button type="button" className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => setCreateOpen(true)} disabled={rows.length >= maxTokens}>
              + Create token
            </button>
          )}
        </div>
      </div>

      <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12, marginBottom: 16 }}>
        Tokens authenticate against the Hydration Data API at <span className="mono">{DATA_API_URL}</span> — REST access to the
        full explorer dataset (balances, trades, pools, governance, …). Send one as <code className="mono">Authorization: Bearer hdd_…</code> on
        every request. All your tokens share one rate-limit budget, up to {maxTokens} active tokens.{' '}
        <a className="sec-inline-link" href={docsUrl} target="_blank" rel="noreferrer noopener">Read the API documentation ↗</a>
      </div>

      {!session ? <ApiTokensTeaser /> : (
        <>
          <div className="sec-title">Tokens{rows.length ? ` · ${rows.length}` : ''}</div>
          <div className="panel"><table className="tbl">
            <thead><tr><th>Label</th><th>Token</th><th className="r">Created</th><th className="r">Last used</th><th className="r"></th></tr></thead>
            <tbody>
              {tokens.isLoading && !rows.length ? <TableSkeleton cols={5} rows={2} />
                : !rows.length ? <EmptyRow cols={5}>No tokens yet — “Create token” mints your first. The secret is shown exactly once.</EmptyRow>
                  : rows.map(token => (
                    <tr key={token.id}>
                      <td data-label="Label">{token.label || <span className="muted">Unnamed token</span>}</td>
                      <td data-label="Token" className="mono">{token.tokenPrefix}…</td>
                      <td data-label="Created" className="r muted">{F.ago(token.createdAt, now)}</td>
                      <td data-label="Last used" className="r muted">{token.lastUsedAt ? F.ago(token.lastUsedAt, now) : 'never'}</td>
                      <td data-label="Actions" className="r">
                        <button type="button" className="btn sm" onClick={() => { setConfirmError(null); setConfirmToken(token) }}>Revoke</button>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table></div>
        </>
      )}

      <CreateTokenDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={invalidate} />
      <ConfirmDialog
        open={confirmToken != null}
        onOpenChange={open => { if (!open) setConfirmToken(null) }}
        title="Revoke API token"
        body={<>Revoke {confirmToken?.label ? <strong>{confirmToken.label}</strong> : 'this token'} (<span className="mono">{confirmToken?.tokenPrefix}…</span>)?
          Requests that authenticate with it stop working within seconds, and nothing can bring it back.</>}
        confirmLabel="Revoke"
        pending={revoke.isPending}
        error={confirmError}
        onConfirm={() => { if (confirmToken) revoke.mutate(confirmToken.id) }}
      />
    </div>
  )
}
