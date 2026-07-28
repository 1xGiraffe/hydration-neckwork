import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { userApi } from '../api/explorer'
import { setSession } from '../session'
import {
  listSubstrateWallets, connectSubstrate, signSubstrate,
  discoverEvmProviders, connectEvm, signEvm,
} from '../wallets'
import type { InjectedAccount, EvmProviderDetail, Eip1193Provider } from '../wallets'
import { ShortAddr } from './ui'

// The extension handle or EVM provider a chosen address will sign with, kept
// around from the connect step so the account picker and a signing retry both
// have it without reconnecting.
type Pending =
  | { kind: 'substrate'; ext: Parameters<typeof signSubstrate>[0] }
  | { kind: 'evm'; provider: Eip1193Provider }

type Stage = 'wallets' | 'accounts' | 'signing'

function describeStage(stage: Stage, busy: boolean, hasError: boolean): string {
  if (stage === 'wallets') return 'Sign a message with your wallet to prove you own the address — no transaction, no fee.'
  if (stage === 'accounts') return 'Choose the account to sign in with.'
  if (hasError) return 'Sign-in failed.'
  return busy ? 'Waiting for a signature in your wallet…' : 'Signing you in…'
}

// Wallet connect + sign-in: pick a wallet, pick an account (skipped when the
// wallet only has one), sign the login challenge. Every failure — a rejected
// signature, a dead API — lands back on the same stage with an inline error;
// the wallet/account rows stay clickable (wallets/accounts stages) or an
// explicit Retry appears (signing stage), so there's never a dead end.
// setSession only ever runs after `verify` succeeds, so there is no
// partial/half-authenticated session.
export function ConnectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [stage, setStage] = useState<Stage>('wallets')
  const [pending, setPending] = useState<Pending | null>(null)
  const [accounts, setAccounts] = useState<InjectedAccount[]>([])
  const [address, setAddress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [evmProviders, setEvmProviders] = useState<EvmProviderDetail[]>([])

  // Reset to a clean first screen every time the dialog opens, so a previous
  // attempt's error/account list never leaks into the next one. Adjusted
  // during render (React's prop-change-reset pattern) rather than an effect,
  // so there's no extra round trip where the stale screen is visible.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setStage('wallets'); setPending(null); setAccounts([]); setAddress(null); setError(null); setBusy(false)
    }
  }

  // EIP-6963 providers announce asynchronously; re-poll the same discovery
  // handle's list() whenever another one arrives while the dialog is open.
  // `onAnnounce` both seeds the initial snapshot and serves as the ongoing
  // subscription callback, so this stays "subscribe to an external store".
  useEffect(() => {
    if (!open) return
    const discovery = discoverEvmProviders()
    const onAnnounce = () => setEvmProviders(discovery.list())
    onAnnounce()
    window.addEventListener('eip6963:announceProvider', onAnnounce)
    return () => { window.removeEventListener('eip6963:announceProvider', onAnnounce); discovery.stop() }
  }, [open])

  const substrateWallets = useMemo(() => (open ? listSubstrateWallets() : []), [open])

  async function doSign(next: Pending, addr: string) {
    setBusy(true)
    setError(null)
    try {
      const { nonce, message } = await userApi.challenge(addr)
      const signature = next.kind === 'substrate'
        ? await signSubstrate(next.ext, addr, message)
        : await signEvm(next.provider, addr, message)
      const { token, me } = await userApi.verify(addr, nonce, signature)
      setSession({ token, accountId: me.account.accountId, address: me.account.address })
      setBusy(false)
      onOpenChange(false)
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : 'Sign-in failed')
    }
  }

  async function connectWallet(id: string) {
    setError(null)
    try {
      const { accounts: found, ext } = await connectSubstrate(id)
      const next: Pending = { kind: 'substrate', ext }
      setPending(next)
      if (found.length === 1) {
        setAddress(found[0].address)
        setStage('signing')
        void doSign(next, found[0].address)
      } else {
        setAccounts(found)
        setStage('accounts')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect wallet')
    }
  }

  async function connectProvider(detail: EvmProviderDetail) {
    setError(null)
    try {
      const addrs = await connectEvm(detail.provider)
      const next: Pending = { kind: 'evm', provider: detail.provider }
      setPending(next)
      if (addrs.length === 1) {
        setAddress(addrs[0])
        setStage('signing')
        void doSign(next, addrs[0])
      } else {
        setAccounts(addrs.map(a => ({ address: a })))
        setStage('accounts')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect wallet')
    }
  }

  function pickAccount(addr: string) {
    if (!pending) return
    setAddress(addr)
    setError(null)
    setStage('signing')
    void doSign(pending, addr)
  }

  function retry() {
    if (!pending || !address) return
    void doSign(pending, address)
  }

  function backToWallets() {
    setStage('wallets'); setPending(null); setAccounts([]); setAddress(null); setError(null)
  }

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
            <Dialog.Description className="dialog-hint">{describeStage(stage, busy, !!error)}</Dialog.Description>
            {error && <div className="dialog-error">{error}</div>}

            {stage === 'wallets' && (
              <>
                <div className="wallet-group">
                  <div className="wallet-group-label">Substrate</div>
                  {substrateWallets.map(w => w.installed ? (
                    <button key={w.id} type="button" className="wallet-row" disabled={busy} onClick={() => void connectWallet(w.id)}>
                      <span className="wallet-name">{w.title}</span>
                      <span className="wallet-status">Installed</span>
                    </button>
                  ) : (
                    <a key={w.id} className="wallet-row wallet-row-install" href={w.installUrl} target="_blank" rel="noreferrer">
                      <span className="wallet-name">{w.title}</span>
                      <span className="wallet-status">Install ↗</span>
                    </a>
                  ))}
                </div>
                {evmProviders.length > 0 && (
                  <div className="wallet-group">
                    <div className="wallet-group-label">Ethereum</div>
                    {evmProviders.map(p => (
                      <button key={p.info.rdns} type="button" className="wallet-row" disabled={busy} onClick={() => void connectProvider(p)}>
                        {p.info.icon ? <img className="wallet-icon" src={p.info.icon} alt="" /> : null}
                        <span className="wallet-name">{p.info.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {stage === 'accounts' && (
              <>
                <div className="wallet-group">
                  {accounts.map(a => (
                    <button key={a.address} type="button" className="wallet-row account-row" onClick={() => pickAccount(a.address)}>
                      {a.name && <span className="wallet-name">{a.name}</span>}
                      <span className="wallet-status mono"><ShortAddr addr={a.address} /></span>
                    </button>
                  ))}
                </div>
                <button type="button" className="btn" onClick={backToWallets}>Back</button>
              </>
            )}

            {stage === 'signing' && address && (
              <p className="dialog-hint mono"><ShortAddr addr={address} /></p>
            )}
          </div>
          {stage === 'signing' && error && (
            <div className="dialog-foot">
              <button type="button" className="btn" onClick={backToWallets}>Choose a different wallet</button>
              <button type="button" className="btn primary" onClick={retry}>Retry</button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
