import type { AccountRowLabel, EvmProviderDetail, SubstrateWalletInfo } from '../wallets'
import { AccountEmoji, ShortAddr } from './ui'
import type { AccountRef } from '../types'

// The building blocks the two wallet dialogs share — the login ConnectDialog
// and the contract tab's ContractWalletDialog: wallet tiles and the
// account-row label (EIP-6963 discovery lives in hooks/useEvmProviders.ts).
// Deliberately free of any session/auth concern: the contract dialog's
// isolation from the login session is a hard requirement, pinned by
// tests/contract-wallet.test.ts.

// The emoji/avatar + name + mono address a wallet account renders as, shared
// by the account-picker rows and the signing screen so a chosen account looks
// identical on both — the same pill-in-a-list treatment an AddrPill gets
// elsewhere (profile name amber-italic, on-chain identity plain), just without
// the account-page link a real AddrPill would carry (there's nowhere to link
// to mid connect).
export function AccountRowLabelView({ account, label }: { account: AccountRef | null | undefined; label: AccountRowLabel }) {
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

// One substrate-extension tile: connectable when installed, an install link
// otherwise. `onConnect` receives the INJECTED key (see wallets.ts on why the
// catalog id and the injected key differ for Nova).
export function SubstrateWalletTile({ wallet, busy, onConnect }: { wallet: SubstrateWalletInfo; busy: boolean; onConnect: (injectedKey: string) => void }) {
  return wallet.installed ? (
    <button type="button" className="wallet-tile installed" disabled={busy} onClick={() => onConnect(wallet.injectedKey)}>
      <img className="wallet-tile-icon" src={wallet.icon} alt="" />
      <span className="wallet-tile-name">{wallet.title}</span>
      <span className="wallet-tile-status">Installed</span>
    </button>
  ) : (
    <a className="wallet-tile not-installed" href={wallet.installUrl} target="_blank" rel="noreferrer">
      <img className="wallet-tile-icon" src={wallet.icon} alt="" />
      <span className="wallet-tile-name">{wallet.title}</span>
      <span className="wallet-tile-status">Install ↗</span>
    </a>
  )
}

export function EvmProviderTile({ detail, busy, onConnect }: { detail: EvmProviderDetail; busy: boolean; onConnect: (detail: EvmProviderDetail) => void }) {
  return (
    <button type="button" className="wallet-tile installed" disabled={busy} onClick={() => onConnect(detail)}>
      {detail.info.icon ? <img className="wallet-tile-icon" src={detail.info.icon} alt="" /> : <span className="wallet-tile-icon" aria-hidden="true" />}
      <span className="wallet-tile-name">{detail.info.name}</span>
    </button>
  )
}

