import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, userApi } from '../api/explorer'
import { useSession } from '../session'
import { useMe } from '../hooks/useUser'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useNow } from '../hooks/useNow'
import { paths } from '../router'
import { AddrPill, Crumbs, EmptyRow, F, TableSkeleton } from '../components/ui'
import type { ApiUserRow } from '../types'

// Data API administration: every account holding an active token, its usage,
// and its rate limits. The me.apiAdmin gate here is purely cosmetic — the
// server checks the allowlist itself and 404s everyone else, which this page
// renders as "not available".

function LimitsDialog({ row, defaults, onOpenChange }: {
  row: ApiUserRow | null
  defaults: { perMinute: number; perDay: number }
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [perMinute, setPerMinute] = useState('')
  const [perDay, setPerDay] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Seed the form from the row each time a row is picked (prop-change-reset).
  const [seededFor, setSeededFor] = useState<string | null>(null)
  if (row && row.account.accountId !== seededFor) {
    setSeededFor(row.account.accountId)
    setPerMinute(String(row.limits.perMinute))
    setPerDay(String(row.limits.perDay))
    setNote(row.limits.note)
    setError(null)
  }
  if (!row && seededFor !== null) setSeededFor(null)

  const done = () => {
    setError(null)
    onOpenChange(false)
    void qc.invalidateQueries({ queryKey: ['user', 'api-users'] })
  }
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not save the limits')
  const save = useMutation({
    mutationFn: () => userApi.setApiUserLimits(row!.account.accountId, { perMinute: Number(perMinute), perDay: Number(perDay), note }),
    onSuccess: done,
    onError: fail,
  })
  const clear = useMutation({
    mutationFn: () => userApi.clearApiUserLimits(row!.account.accountId),
    onSuccess: done,
    onError: fail,
  })
  const pending = save.isPending || clear.isPending

  return (
    <Dialog.Root open={row != null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog" style={{ width: 'min(440px, 94vw)' }}>
          <div className="dialog-head">
            <Dialog.Title asChild><h2>Rate limits</h2></Dialog.Title>
            <Dialog.Close asChild>
              <button className="theme-toggle" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </Dialog.Close>
          </div>
          <div className="dialog-body">
            {row && (
              <>
                <div style={{ marginBottom: 10 }}><AddrPill account={row.account} /></div>
                <Dialog.Description className="dialog-hint">
                  All of an account's tokens share this budget. Defaults are {defaults.perMinute}/min and {F.count(defaults.perDay)}/day;
                  an override replaces both until it is reset.
                </Dialog.Description>
                <div className="row gap6" style={{ flexWrap: 'wrap' }}>
                  <label className="field" style={{ flex: 1, minWidth: 130 }}>
                    <span className="muted" style={{ fontSize: 12 }}>Requests per minute</span>
                    <input className="input" inputMode="numeric" value={perMinute} onChange={e => setPerMinute(e.target.value)} />
                  </label>
                  <label className="field" style={{ flex: 1, minWidth: 130 }}>
                    <span className="muted" style={{ fontSize: 12 }}>Requests per day</span>
                    <input className="input" inputMode="numeric" value={perDay} onChange={e => setPerDay(e.target.value)} />
                  </label>
                </div>
                <label className="field" style={{ display: 'block', marginTop: 8 }}>
                  <span className="muted" style={{ fontSize: 12 }}>Note (why this override exists)</span>
                  <input className="input" style={{ width: '100%' }} maxLength={400} value={note} onChange={e => setNote(e.target.value)} />
                </label>
                {error && <div className="dialog-error" style={{ marginTop: 8 }}>{error}</div>}
              </>
            )}
          </div>
          <div className="dialog-foot">
            {row?.limits.override && (
              <button type="button" className="btn" disabled={pending} onClick={() => clear.mutate()}>Reset to defaults</button>
            )}
            <button type="button" className="btn" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</button>
            <button type="button" className="btn primary" disabled={pending} onClick={() => save.mutate()}>Save</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function usageCell(requests: number, rejected?: number) {
  return (
    <>
      {F.count(requests)}
      {rejected ? <span className="muted"> ({F.count(rejected)} rejected)</span> : null}
    </>
  )
}

export function ApiAdmin() {
  useDocumentTitle('API admin')
  const session = useSession()
  const me = useMe()
  const now = useNow()
  const users = useQuery({
    queryKey: ['user', 'api-users', session?.accountId],
    queryFn: ({ signal }) => userApi.apiUsers(signal),
    enabled: !!session && me.data?.apiAdmin === true,
    staleTime: 15_000,
    retry: false,
  })
  const [editRow, setEditRow] = useState<ApiUserRow | null>(null)

  const available = !!session && (me.data == null || me.data.apiAdmin === true)
  const rows = users.data?.users ?? []
  const defaults = users.data?.defaults ?? { perMinute: 30, perDay: 20_000 }

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'API admin' }]} />
        <div className="page-title">
          API admin <span className="sub">Data API accounts, usage and limits</span>
        </div>
      </div>

      {!available || users.isError ? (
        <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>
          This page is not available for this account.
        </div>
      ) : (
        <>
          <div className="sec-title-row">
            <div className="sec-title">API users{rows.length ? ` · ${rows.length}` : ''}</div>
            <span className="muted" style={{ fontSize: 12 }}>defaults: {defaults.perMinute}/min · {F.count(defaults.perDay)}/day</span>
          </div>
          <div className="panel"><table className="tbl">
            <thead><tr><th>Account</th><th>Tokens</th><th className="r">24h</th><th className="r">7d</th><th className="r">30d</th><th>Limits</th><th className="r">Last active</th><th className="r"></th></tr></thead>
            <tbody>
              {users.isLoading ? <TableSkeleton cols={8} rows={3} />
                : !rows.length ? <EmptyRow cols={8}>Nobody holds an active API token yet.</EmptyRow>
                  : rows.map(row => (
                    <tr key={row.account.accountId}>
                      <td data-label="Account"><AddrPill account={row.account} /></td>
                      <td data-label="Tokens">
                        {row.tokenCount}
                        {row.labels.length > 0 && <span className="muted" style={{ fontSize: 12 }}> · {row.labels.slice(0, 3).join(', ')}{row.labels.length > 3 ? ', …' : ''}</span>}
                      </td>
                      <td data-label="24h" className="r mono">{usageCell(row.usage.requests24h, row.usage.rejected24h)}</td>
                      <td data-label="7d" className="r mono">{F.count(row.usage.requests7d)}</td>
                      <td data-label="30d" className="r mono">{F.count(row.usage.requests30d)}</td>
                      <td data-label="Limits">
                        {row.limits.perMinute}/min · {F.count(row.limits.perDay)}/day
                        {row.limits.override && <span className="badge pending" style={{ marginLeft: 6 }} title={row.limits.note || undefined}>override</span>}
                      </td>
                      <td data-label="Last active" className="r muted">{row.usage.lastActiveHour ? F.ago(row.usage.lastActiveHour, now) : 'never'}</td>
                      <td data-label="Actions" className="r">
                        <button type="button" className="btn sm" onClick={() => setEditRow(row)}>Edit</button>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table></div>
        </>
      )}

      <LimitsDialog row={editRow} defaults={defaults} onOpenChange={open => { if (!open) setEditRow(null) }} />
    </div>
  )
}
