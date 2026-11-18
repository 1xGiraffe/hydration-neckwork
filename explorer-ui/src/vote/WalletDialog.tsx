import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/explorer'
import { connectEvmWallet, connectSubstrateWallet, disconnectWallet, evmProviderName, reconnectRemembered, signingSubstrateWallets, useChainWallets } from '../chainWallet'
import type { ChainAccount, ConnectedWallet } from '../chainWallet'
import { useEvmProviders } from '../hooks/useEvmProviders'
import { AccountEmoji, Amt, CopyTextButton, ShortAddr } from '../components/ui'
import { WALLET_APP_LINKS, isTouchBrowser } from '../wallets'
import { openWallets } from './voteBus'
import { useActorState, useSignerIds } from './useVoting'
import { totalBalance } from './voteMath'
import { toSs58 } from './chainWrite'

// Connecting wallets for signing. Several can be connected at once; their accounts
// are remembered on this device (addresses only) and come back after a reload
// without a prompt. Each account shows who it is and the HDX it can vote with.
// Connecting signs nothing.

function AccountRow({ account, runtimeId }: { account: ChainAccount; runtimeId: string | null }) {
  const ref = useQuery({
    queryKey: ['account-ref', runtimeId ?? account.address],
    queryFn: async () => (await api.accountRefs([runtimeId ? toSs58(runtimeId) : account.address]))[0] ?? null,
    enabled: account.kind !== 'substrate-h160',
    staleTime: 300_000,
  })
  const state = useActorState(runtimeId)
  const name = ref.data?.profile?.name || ref.data?.identity?.display || account.name
  return (
    <li className={`wallet-acct${account.kind === 'substrate-h160' ? ' off' : ''}`}>
      {ref.data ? <AccountEmoji account={ref.data} className="emoji id voter-emoji" /> : <span className="emoji id voter-emoji" aria-hidden="true">👤</span>}
      <span className="voter-text">
        <span className="voter-name">{name ?? <span className="mono"><ShortAddr addr={ref.data?.address ?? account.address} /></span>}</span>
        <span className="voter-sub mono">
          {account.kind === 'evm'
            ? <>EVM <ShortAddr addr={account.address} />{runtimeId ? <> · Hydration <ShortAddr addr={toSs58(runtimeId)} /></> : null}</>
            : <ShortAddr addr={ref.data?.address ?? account.address} />}
        </span>
        {account.kind === 'substrate-h160' && <span className="voter-why">An Ethereum account inside a Polkadot extension cannot sign on Hydration. Connect {account.walletName}’s EVM side under “Ethereum wallets” instead.</span>}
      </span>
      <span className="voter-bal">{state.data ? <><Amt raw={totalBalance(state.data.hdx).toString()} dec={12} /> <span className="muted">HDX</span></> : account.kind === 'substrate-h160' ? null : <span className="skeleton voter-bal-sk" />}</span>
    </li>
  )
}

function WalletCard({ wallet, runtimeIds }: { wallet: ConnectedWallet; runtimeIds: Map<string, string> }) {
  return (
    <div className="wallet-card">
      <div className="wallet-card-head">
        {wallet.entry.icon ? <img src={wallet.entry.icon} alt="" className="wallet-tile-icon" /> : <span className="wallet-tile-icon" aria-hidden="true" />}
        <strong>{wallet.entry.name}</strong>
        <span className={`wallet-state ${wallet.status}`}>{wallet.status === 'live' ? 'connected' : 'not connected in this tab'}</span>
        {wallet.status === 'remembered' && <button type="button" className="link-btn" onClick={() => void reconnectRemembered(150)}>Reconnect</button>}
        <button type="button" className="link-btn" onClick={() => disconnectWallet(wallet.entry.id)}>Disconnect</button>
      </div>
      {wallet.accounts.length ? (
        <ul className="wallet-accts">{wallet.accounts.map(a => <AccountRow key={a.id} account={a} runtimeId={runtimeIds.get(a.id) ?? null} />)}</ul>
      ) : <p className="vote-note">This wallet shares no accounts with the site. Allow at least one in the wallet.</p>}
    </div>
  )
}

// On a phone with no wallet injected: open this page inside a wallet app's own
// browser (which injects one), or copy the address to paste into it.
function OpenInWalletApp() {
  const url = window.location.href
  return (
    <section className="vote-block">
      <div className="vote-label">On a phone</div>
      <p className="vote-note">Wallet apps connect from their own built-in browser. Open this page there:</p>
      <div className="wallet-grid">
        {WALLET_APP_LINKS.map(w => (
          <a key={w.id} className="wallet-tile not-installed" href={w.link(url)} rel="noopener noreferrer">
            <img className="wallet-tile-icon" src={w.icon} alt="" />
            <span className="wallet-tile-name">{w.title}</span>
            <span className="wallet-tile-status">Open in app ↗</span>
          </a>
        ))}
      </div>
      <p className="vote-note">In Nova Wallet or Talisman, open the app's browser and paste this page's address <CopyTextButton label="page address" text={url} /></p>
    </section>
  )
}

export function WalletPanel({ onDone }: { onDone?: () => void }) {
  const { wallets, accounts } = useChainWallets()
  const ids = useSignerIds(accounts)
  const runtimeIds = useMemo(() => new Map(accounts.flatMap((a, i) => (ids[i]?.data ? [[a.id, ids[i].data as string] as [string, string]] : []))), [accounts, ids])
  const evm = useEvmProviders(true)
  const substrate = useMemo(() => signingSubstrateWallets(), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const connectedIds = new Set(wallets.map(w => w.entry.id))
  const shortlist = substrate.filter(w => w.shortlist || w.installed)
  const rest = substrate.filter(w => !w.shortlist && !w.installed)

  async function run(id: string, f: () => Promise<unknown>) {
    setBusy(id); setError(null)
    try { await f() } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(/reject|denied|cancel/i.test(msg) ? 'The wallet declined the connection. Nothing was shared.' : msg)
    } finally { setBusy(null) }
  }

  return (
    <div className="wallet-panel">
      {wallets.length > 0 && (
        <section className="vote-block">
          <div className="vote-label">Connected</div>
          {wallets.map(w => <WalletCard key={w.entry.id} wallet={w} runtimeIds={runtimeIds} />)}
          {onDone && accounts.some(a => a.kind !== 'substrate-h160') && <button type="button" className="vote-sign" onClick={onDone}>Continue</button>}
        </section>
      )}
      {error && <div className="dialog-error" role="alert">{error}</div>}
      {!wallets.length && !substrate.some(w => w.installed) && isTouchBrowser() && <OpenInWalletApp />}
      <section className="vote-block">
        <div className="vote-label">{wallets.length ? 'Add another wallet' : 'Polkadot wallets'}</div>
        <div className="wallet-grid">
          {shortlist.map(w => w.installed ? (
            <button key={w.id} type="button" className="wallet-tile installed" disabled={!!busy || connectedIds.has(`substrate:${w.injectedKey}`)} onClick={() => void run(w.id, () => connectSubstrateWallet(w))}>
              <img className="wallet-tile-icon" src={w.icon} alt="" />
              <span className="wallet-tile-name">{w.title}</span>
              <span className="wallet-tile-status">{connectedIds.has(`substrate:${w.injectedKey}`) ? 'Connected' : busy === w.id ? 'Waiting…' : 'Installed'}</span>
            </button>
          ) : (
            <a key={w.id} className="wallet-tile not-installed" href={w.installUrl} target="_blank" rel="noopener noreferrer">
              <img className="wallet-tile-icon" src={w.icon} alt="" />
              <span className="wallet-tile-name">{w.title}</span>
              <span className="wallet-tile-status">Get it ↗</span>
            </a>
          ))}
        </div>
        {rest.length > 0 && <button type="button" className="btn sm wallet-toggle" aria-expanded={more} onClick={() => setMore(m => !m)}>{more ? 'Fewer wallets' : 'Other wallets'}</button>}
        {more && (
          <div className="wallet-grid">
            {rest.map(w => (
              <a key={w.id} className="wallet-tile not-installed" href={w.installUrl} target="_blank" rel="noopener noreferrer">
                <img className="wallet-tile-icon" src={w.icon} alt="" />
                <span className="wallet-tile-name">{w.title}</span>
                <span className="wallet-tile-status">Get it ↗</span>
              </a>
            ))}
          </div>
        )}
      </section>
      <section className="vote-block">
        <div className="vote-label">Ethereum wallets</div>
        {evm.length ? (
          <div className="wallet-grid">
            {evm.map(p => (
              <button key={p.info.rdns} type="button" className="wallet-tile installed" disabled={!!busy || connectedIds.has(`evm:${p.info.rdns}`)} onClick={() => void run(p.info.rdns, () => connectEvmWallet(p))}>
                {p.info.icon ? <img className="wallet-tile-icon" src={p.info.icon} alt="" /> : <span className="wallet-tile-icon" aria-hidden="true" />}
                <span className="wallet-tile-name">{evmProviderName(p)}</span>
                <span className="wallet-tile-status">{connectedIds.has(`evm:${p.info.rdns}`) ? 'Connected' : busy === p.info.rdns ? 'Waiting…' : 'Installed'}</span>
              </button>
            ))}
          </div>
        ) : <p className="vote-note">No Ethereum wallet was found in this browser. MetaMask, Rabby, Talisman, SubWallet and other EVM wallets show here once installed.</p>}
      </section>
      <p className="vote-fine">Connecting shares your addresses with this page only; it signs nothing. WalletConnect (phone wallets by QR code) is not available here yet.</p>
    </div>
  )
}

export function NoWallet({ reason }: { reason: string }) {
  return (
    <div className="vote-nowallet">
      <p>{reason}</p>
      <button type="button" className="vote-sign" onClick={() => openWallets()}>Connect a wallet</button>
    </div>
  )
}
