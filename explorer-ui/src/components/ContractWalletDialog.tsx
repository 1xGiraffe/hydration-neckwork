import { useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { api } from '../api/explorer'
import { connectEvm, connectSubstrate, listSubstrateWallets, accountRowLabel } from '../wallets'
import type { EvmProviderDetail, InjectedAccount, InjectedExtension } from '../wallets'
import { setContractWallet } from '../contractWallet'
import { AccountRowLabelView, EvmProviderTile, SubstrateWalletTile } from './WalletPicker'
import { useEvmProviders } from '../hooks/useEvmProviders'
import type { AccountRef } from '../types'

// The Write tab's wallet connection dialog. Same tiles, account rows and
// stage machine as the login ConnectDialog — but connection-only: no
// challenge, no signature, no session. It stores the chosen account in the
// contractWallet store (in-memory + sessionStorage) and closes; the login
// session (session.ts / userApi) is deliberately unreachable from here.
// Substrate accounts write through EVM.call, so picking one derives its
// truncated H160 source via the lazy dedot chunk (substrateWrite.ts) — that
// import is what starts the chunk download, nothing loads it earlier.

type Pending =
  | { kind: 'evm'; key: string; walletName: string; detail: EvmProviderDetail }
  | { kind: 'substrate'; key: string; walletName: string; ext: InjectedExtension }

type Stage = 'wallets' | 'accounts'

export function ContractWalletDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [stage, setStage] = useState<Stage>('wallets')
  const [pending, setPending] = useState<Pending | null>(null)
  const [accounts, setAccounts] = useState<InjectedAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const evmProviders = useEvmProviders(open)
  const substrateWallets = useMemo(() => (open ? listSubstrateWallets() : []), [open])
  // Display refs keyed by the RAW extension address — same degrade ladder as
  // the login dialog: undefined = loading, null = lookup failed.
  const [refs, setRefs] = useState<Record<string, AccountRef | null>>({})
  const [showOtherWallets, setShowOtherWallets] = useState(false)

  // Reset to a clean first screen on every open (prop-change-reset pattern,
  // same as ConnectDialog) so a previous attempt's error never leaks forward.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setStage('wallets'); setPending(null); setAccounts([]); setError(null); setBusy(false); setRefs({}); setShowOtherWallets(false)
    }
  }
  const attemptRef = useRef(0)
  useEffect(() => { attemptRef.current++ }, [open])

  function loadRefs(addresses: string[]) {
    const attempt = attemptRef.current
    void api.accountRefs(addresses)
      .then(found => {
        if (attemptRef.current !== attempt) return
        setRefs(prev => {
          const next = { ...prev }
          addresses.forEach((a, i) => { next[a] = found[i] ?? null })
          return next
        })
      })
      .catch(() => {
        if (attemptRef.current !== attempt) return
        setRefs(prev => {
          const next = { ...prev }
          for (const a of addresses) next[a] = null
          return next
        })
      })
  }

  async function finish(next: Pending, address: string) {
    if (next.kind === 'evm') {
      setContractWallet({
        kind: 'evm', key: next.key, address, walletName: next.walletName,
        evmFrom: address, provider: next.detail.provider,
      })
      onOpenChange(false)
      return
    }
    // Substrate: the truncated-H160 derivation lives in the dedot chunk —
    // connecting a substrate wallet is exactly when it should load.
    setBusy(true)
    try {
      const { deriveEvmSource } = await import('../substrateWrite')
      setContractWallet({
        kind: 'substrate', key: next.key, address, walletName: next.walletName,
        evmFrom: deriveEvmSource(address), signer: next.ext.signer,
      })
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not derive the account\'s EVM address')
    } finally {
      setBusy(false)
    }
  }

  function offerAccounts(next: Pending, found: InjectedAccount[]) {
    setPending(next)
    loadRefs(found.map(a => a.address))
    if (found.length === 1) {
      void finish(next, found[0].address)
    } else {
      setAccounts(found)
      setStage('accounts')
    }
  }

  async function connectProvider(detail: EvmProviderDetail) {
    setError(null)
    setBusy(true)
    try {
      const addrs = await connectEvm(detail.provider)
      if (!addrs.length) throw new Error('No accounts — check the wallet allows this site')
      offerAccounts({ kind: 'evm', key: detail.info.rdns, walletName: detail.info.name, detail }, addrs.map(a => ({ address: a })))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect wallet')
    } finally {
      setBusy(false)
    }
  }

  async function connectWallet(injectedKey: string, walletName: string) {
    setError(null)
    setBusy(true)
    try {
      const { accounts: found, ext } = await connectSubstrate(injectedKey)
      offerAccounts({ kind: 'substrate', key: injectedKey, walletName, ext }, found)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect wallet')
    } finally {
      setBusy(false)
    }
  }

  const shortlistWallets = substrateWallets.filter(w => w.shortlist)
  const otherWallets = substrateWallets.filter(w => !w.shortlist)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title asChild><h2>Connect a wallet</h2></Dialog.Title>
            <Dialog.Close asChild>
              <button className="theme-toggle" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </Dialog.Close>
          </div>
          <div className="dialog-body">
            <Dialog.Description className="dialog-hint">
              {stage === 'wallets'
                ? 'This connection only signs contract transactions from this tab — it is separate from the explorer login and never signs you in.'
                : 'Choose the account to write with.'}
            </Dialog.Description>
            {error && <div className="dialog-error">{error}</div>}

            {stage === 'wallets' && (
              <>
                <div className="wallet-group">
                  <div className="wallet-group-label">Substrate</div>
                  <div className="wallet-grid">
                    {shortlistWallets.map(w => <SubstrateWalletTile key={w.id} wallet={w} busy={busy} onConnect={key => void connectWallet(key, w.title)} />)}
                  </div>
                  {otherWallets.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="btn sm wallet-toggle"
                        aria-expanded={showOtherWallets}
                        onClick={() => setShowOtherWallets(v => !v)}
                      >
                        {showOtherWallets ? 'Fewer wallets' : 'Other wallets'}
                      </button>
                      {showOtherWallets && (
                        <div className="wallet-grid">
                          {otherWallets.map(w => <SubstrateWalletTile key={w.id} wallet={w} busy={busy} onConnect={key => void connectWallet(key, w.title)} />)}
                        </div>
                      )}
                    </>
                  )}
                </div>
                {evmProviders.length > 0 && (
                  <div className="wallet-group">
                    <div className="wallet-group-label">Ethereum</div>
                    <div className="wallet-grid">
                      {evmProviders.map(p => <EvmProviderTile key={p.info.rdns} detail={p} busy={busy} onConnect={d => void connectProvider(d)} />)}
                    </div>
                  </div>
                )}
              </>
            )}

            {stage === 'accounts' && (
              <>
                <div className="wallet-group">
                  {accounts.map(a => {
                    const ref = refs[a.address]
                    const label = accountRowLabel(ref, a.name, a.address)
                    return (
                      <button key={a.address} type="button" className="wallet-row account-row" disabled={busy} onClick={() => pending && void finish(pending, a.address)}>
                        <AccountRowLabelView account={ref} label={label} />
                      </button>
                    )
                  })}
                </div>
                <button type="button" className="btn" onClick={() => { setStage('wallets'); setPending(null); setAccounts([]); setError(null) }}>Back</button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
