import { useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { api, userApi } from '../api/explorer'
import { setSession } from '../session'
import {
  listSubstrateWallets, connectSubstrate, signSubstrate,
  discoverEvmProviders, connectEvm, signEvm, accountRowLabel,
} from '../wallets'
import type { InjectedAccount, EvmProviderDetail, Eip1193Provider, AccountRowLabel } from '../wallets'
import { AccountEmoji, ShortAddr } from './ui'
import type { AccountRef } from '../types'

// The emoji/avatar + name + mono address a wallet account renders as, shared
// by the account-picker rows and the signing screen so a chosen account looks
// identical on both — the same pill-in-a-list treatment an AddrPill gets
// elsewhere (profile name amber-italic, on-chain identity plain), just without
// the account-page link a real AddrPill would carry (there's nowhere to link
// to mid sign-in).
function AccountRowLabelView({ account, label }: { account: AccountRef | null | undefined; label: AccountRowLabel }) {
  return (
    <>
      {account
        ? <AccountEmoji account={account} className="emoji id account-row-emoji" />
        : <span className="emoji id account-row-emoji">👤</span>}
      {label.primary && (
        label.kind === 'profile' ? <span className="tag profile-name">{label.primary}</span>
          : label.kind === 'identity' ? <span className="tag">{label.primary}</span>
          : <span className="wallet-name">{label.primary}</span>
      )}
      <span className="wallet-status mono">{label.address ? <ShortAddr addr={label.address} /> : '···'}</span>
    </>
  )
}

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
  // Display refs keyed by the RAW extension address: undefined = still
  // loading (the raw substrate encoding is never flashed), null = lookup
  // failed (degrade to the raw form), ref = canonical pill-style display.
  const [refs, setRefs] = useState<Record<string, AccountRef | null>>({})

  // Bumped on every reset (dialog close/reopen, "choose a different wallet")
  // so an in-flight doSign can tell it's been superseded. Closing the dialog
  // mid-signature must never let a stale challenge/verify round trip resolve
  // into setSession/onOpenChange(false) after the visitor has backed out and
  // started over — a `busy` check alone can't catch that, since a NEW attempt
  // can also be `busy` by the time the OLD one's await settles.
  const attemptRef = useRef(0)

  // Reset to a clean first screen every time the dialog opens, so a previous
  // attempt's error/account list never leaks into the next one. Adjusted
  // during render (React's prop-change-reset pattern) rather than an effect,
  // so there's no extra round trip where the stale screen is visible.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setStage('wallets'); setPending(null); setAccounts([]); setAddress(null); setError(null); setBusy(false); setRefs({})
    }
  }
  // Refs can't be touched during render (only event handlers/effects), so the
  // open/close edge above bumps the attempt counter here instead — still well
  // before any new doSign a later click could trigger.
  useEffect(() => { attemptRef.current++ }, [open])

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

  // Resolve wallet addresses to display refs (canonical Polkadot/H160 form +
  // identity/profile) so the picker and the signing screen show accounts the
  // way pills do everywhere else. Best-effort: on failure every entry becomes
  // null and the rows degrade to wallet name + raw address.
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

  async function doSign(next: Pending, addr: string) {
    const attempt = attemptRef.current
    const stale = () => attemptRef.current !== attempt
    setBusy(true)
    setError(null)
    try {
      const { nonce, message } = await userApi.challenge(addr)
      if (stale()) return
      const signature = next.kind === 'substrate'
        ? await signSubstrate(next.ext, addr, message)
        : await signEvm(next.provider, addr, message)
      if (stale()) return
      const { token, me } = await userApi.verify(addr, nonce, signature)
      if (stale()) return
      setSession({ token, accountId: me.account.accountId, address: me.account.address })
      setBusy(false)
      onOpenChange(false)
    } catch (e) {
      if (stale()) return
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
      loadRefs(found.map(a => a.address))
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
      loadRefs(addrs)
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
    attemptRef.current++
    setStage('wallets'); setPending(null); setAccounts([]); setAddress(null); setError(null)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title asChild><h2>Log in with your wallet</h2></Dialog.Title>
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
                  <div className="wallet-grid">
                    {substrateWallets.map(w => w.installed ? (
                      <button key={w.id} type="button" className="wallet-tile installed" disabled={busy} onClick={() => void connectWallet(w.id)}>
                        <img className="wallet-tile-icon" src={w.icon} alt="" />
                        <span className="wallet-tile-name">{w.title}</span>
                        <span className="wallet-tile-status">Installed</span>
                      </button>
                    ) : (
                      <a key={w.id} className="wallet-tile not-installed" href={w.installUrl} target="_blank" rel="noreferrer">
                        <img className="wallet-tile-icon" src={w.icon} alt="" />
                        <span className="wallet-tile-name">{w.title}</span>
                        <span className="wallet-tile-status">Install ↗</span>
                      </a>
                    ))}
                  </div>
                </div>
                {evmProviders.length > 0 && (
                  <div className="wallet-group">
                    <div className="wallet-group-label">Ethereum</div>
                    <div className="wallet-grid">
                      {evmProviders.map(p => (
                        <button key={p.info.rdns} type="button" className="wallet-tile installed" disabled={busy} onClick={() => void connectProvider(p)}>
                          {p.info.icon ? <img className="wallet-tile-icon" src={p.info.icon} alt="" /> : <span className="wallet-tile-icon" aria-hidden="true" />}
                          <span className="wallet-tile-name">{p.info.name}</span>
                        </button>
                      ))}
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
                      <button key={a.address} type="button" className="wallet-row account-row" onClick={() => pickAccount(a.address)}>
                        <AccountRowLabelView account={ref} label={label} />
                      </button>
                    )
                  })}
                </div>
                <button type="button" className="btn" onClick={backToWallets}>Back</button>
              </>
            )}

            {stage === 'signing' && address && (
              <div className="wallet-row account-row static">
                <AccountRowLabelView account={refs[address]} label={accountRowLabel(refs[address], accounts.find(a => a.address === address)?.name, address)} />
              </div>
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
