// Wallet connection for login only — enable an injected extension, list its
// accounts, sign one message. No SDK: substrate extensions all speak the tiny
// window.injectedWeb3 protocol, EVM wallets announce via EIP-6963 (with a
// window.ethereum fallback for older injectors). WalletConnect is deliberately not
// supported (its client's dependency tree; see AGENTS.md § Dependencies): a phone
// reaches the explorer through a wallet app's in-app browser instead, which injects
// the same extension API (`walletAppLink` below opens this page in one).

// `id` is the catalog identity (React key, e2e selector target) — unique per
// tile. `injectedKey` is which `window.injectedWeb3[...]` entry actually
// backs it, which is NOT always the same: Nova acts as polkadot-js inside its
// in-app browser, so it gets its OWN visual tile (distinct name/icon/install
// link) while still connecting, and reporting installed, through the shared
// 'polkadot-js' key.
export interface SubstrateWalletInfo { id: string; title: string; installUrl: string; icon: string; injectedKey: string; installed: boolean; shortlist: boolean }
// `type` is the key type the extension reports; 'ethereum' marks an H160 account
// held in a substrate extension (Talisman, SubWallet, Nova), which cannot sign
// Hydration extrinsics (the chain's accounts are AccountId32 with MultiSignature).
export interface InjectedAccount { address: string; name?: string; type?: string }
// The injected signer also carries signPayload (extrinsic signing, used by
// the contract Write tab through dedot); only signRaw is typed here because
// it is all this module calls itself.
export interface InjectedExtension {
  accounts: { get(): Promise<InjectedAccount[]> }
  signer: { signRaw(payload: { address: string; data: string; type: 'bytes' }): Promise<{ signature: string }> }
}
interface InjectedWindow { injectedWeb3?: Record<string, { enable(origin: string): Promise<InjectedExtension> }> }

// The extension registry hydration-ui supports, minus wallets without a
// desktop story. Icons copied from galacticcouncil/hydration-ui
// (packages/web3-connect/src/wallets/<Name>/logo.svg, Apache-2.0) into
// public/wallet-icons/, same convention as public/tag-icons/.
//
// `shortlist` wallets (Talisman, Nova, SubWallet, in that order) show in the
// grid by default; everything else sits behind the dialog's "Other wallets"
// toggle. Declared in final render order — shortlist entries first, in the
// exact order they should appear — so listSubstrateWallets only needs to
// stable-sort each GROUP by installed status, never re-order across groups.
const SUBSTRATE_WALLETS: { id: string; title: string; installUrl: string; icon: string; injectedKey: string; shortlist: boolean }[] = [
  { id: 'talisman', title: 'Talisman', installUrl: 'https://talisman.xyz/download', icon: '/wallet-icons/talisman.svg', injectedKey: 'talisman', shortlist: true },
  { id: 'nova', title: 'Nova Wallet', installUrl: 'https://novawallet.io/', icon: '/wallet-icons/nova.svg', injectedKey: 'polkadot-js', shortlist: true },
  { id: 'subwallet-js', title: 'SubWallet', installUrl: 'https://www.subwallet.app/download.html', icon: '/wallet-icons/subwallet-js.svg', injectedKey: 'subwallet-js', shortlist: true },
  { id: 'polkadot-js', title: 'Polkadot{.js}', installUrl: 'https://polkadot.js.org/extension/', icon: '/wallet-icons/polkadot-js.svg', injectedKey: 'polkadot-js', shortlist: false },
  { id: 'aleph-zero', title: 'Aleph Zero Signer', installUrl: 'https://alephzero.org/signer', icon: '/wallet-icons/aleph-zero.svg', injectedKey: 'aleph-zero', shortlist: false },
  { id: 'enkrypt', title: 'Enkrypt', installUrl: 'https://www.enkrypt.com/', icon: '/wallet-icons/enkrypt.svg', injectedKey: 'enkrypt', shortlist: false },
  { id: 'fearless-wallet', title: 'Fearless Wallet', installUrl: 'https://fearlesswallet.io/', icon: '/wallet-icons/fearless-wallet.svg', injectedKey: 'fearless-wallet', shortlist: false },
  { id: 'polkagate', title: 'PolkaGate', installUrl: 'https://polkagate.xyz/', icon: '/wallet-icons/polkagate.svg', injectedKey: 'polkagate', shortlist: false },
  { id: 'manta-wallet-js', title: 'Manta Wallet', installUrl: 'https://chrome.google.com/webstore/detail/manta-wallet/enabgbdfcbaehmbigakijjabdpdnimlg', icon: '/wallet-icons/manta-wallet-js.svg', injectedKey: 'manta-wallet-js', shortlist: false },
]

/** Nova Wallet's in-app browser injects as `polkadot-js` and flags itself here. */
export function isNovaBrowser(): boolean {
  return !!(window as { walletExtension?: { isNovaWallet?: boolean } }).walletExtension?.isNovaWallet
}

// Installed-first within each group (shortlist, then the rest) — an
// install-link wallet never outranks one the visitor can actually click, but
// a shortlisted wallet never drops behind the toggle just because it's not
// installed. Array#filter is stable, so declaration order is the tiebreak
// within a group with no explicit sort needed.
//
// Nova and Polkadot{.js} share the 'polkadot-js' injected key, so which one is
// answering is decided by Nova's own flag, never by the key: inside Nova's
// browser the Nova tile is the installed one and the Polkadot{.js} tile is
// hidden; everywhere else the extension IS Polkadot{.js} — its tile reads
// installed and joins the shortlist, and Nova is only an install link.
export function listSubstrateWallets(): SubstrateWalletInfo[] {
  const injected = (window as InjectedWindow).injectedWeb3 ?? {}
  const nova = isNovaBrowser()
  const withStatus = SUBSTRATE_WALLETS
    .filter(w => !(nova && w.id === 'polkadot-js'))
    .map(w => {
      const present = w.injectedKey in injected
      if (w.id === 'nova') return { ...w, installed: present && nova }
      if (w.id === 'polkadot-js') return { ...w, installed: present, shortlist: present }
      return { ...w, installed: present }
    })
  const byInstalled = (group: typeof withStatus) => [...group.filter(w => w.installed), ...group.filter(w => !w.installed)]
  return [...byInstalled(withStatus.filter(w => w.shortlist)), ...byInstalled(withStatus.filter(w => !w.shortlist))]
}

// Takes the INJECTED key (SubstrateWalletInfo.injectedKey), not the catalog
// id — Nova's tile passes 'polkadot-js' here, same as the Polkadot{.js} tile.
export async function connectSubstrate(injectedKey: string): Promise<{ accounts: InjectedAccount[]; ext: InjectedExtension }> {
  const injected = (window as InjectedWindow).injectedWeb3?.[injectedKey]
  if (!injected) throw new Error('Wallet not installed')
  const ext = await injected.enable('Hydration Explorer')
  const accounts = await ext.accounts.get()
  if (!accounts.length) throw new Error('No accounts — check the wallet allows this site')
  return { accounts, ext }
}

export function toHexMessage(message: string): string {
  return '0x' + Array.from(new TextEncoder().encode(message)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function signSubstrate(ext: InjectedExtension, address: string, message: string): Promise<string> {
  const { signature } = await ext.signer.signRaw({ address, data: toHexMessage(message), type: 'bytes' })
  return signature
}

// ---- EVM (EIP-6963 discovery + window.ethereum fallback) ----
export interface Eip1193Provider { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
export interface EvmProviderDetail { info: { rdns: string; name: string; icon: string }; provider: Eip1193Provider }

export function discoverEvmProviders() {
  const found = new Map<string, EvmProviderDetail>()
  const onAnnounce = (e: Event) => {
    const detail = (e as CustomEvent<EvmProviderDetail>).detail
    if (detail?.info?.rdns) found.set(detail.info.rdns, detail)
  }
  window.addEventListener('eip6963:announceProvider', onAnnounce)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  return {
    list(): EvmProviderDetail[] {
      const list = [...found.values()]
      const eth = (window as { ethereum?: Eip1193Provider }).ethereum
      if (!list.length && eth) list.push({ info: { rdns: 'injected', name: 'Browser wallet', icon: '' }, provider: eth })
      return list
    },
    stop() { window.removeEventListener('eip6963:announceProvider', onAnnounce) },
  }
}

export async function connectEvm(provider: Eip1193Provider): Promise<string[]> {
  return await provider.request({ method: 'eth_requestAccounts' }) as string[]
}
export async function signEvm(provider: Eip1193Provider, address: string, message: string): Promise<string> {
  return await provider.request({ method: 'personal_sign', params: [toHexMessage(message), address] }) as string
}

// How a wallet account renders in the connect dialog — the same precedence an
// account pill uses (profile → identity → wallet-given name), with the
// CANONICAL display address from the server ref (Polkadot SS58 / H160), never
// the extension's generic substrate encoding. `ref === undefined` means the
// refs are still loading: show the wallet name alone rather than flashing the
// raw form; `ref === null` means the lookup failed — degrade to the raw input
// so the row is still identifiable. `kind` says which won, so the caller can
// style the name the way an AddrPill would (profile → amber italic, identity →
// plain) rather than every source reading identically.
export interface AccountRowLabel { primary: string | null; kind: 'profile' | 'identity' | 'name' | null; address: string | null }
export function accountRowLabel(
  ref: { address: string; profile?: { name: string } | null; identity?: { display: string } | null } | null | undefined,
  extensionName: string | undefined,
  rawAddress?: string,
): AccountRowLabel {
  if (ref === undefined) return { primary: extensionName ?? null, kind: extensionName ? 'name' : null, address: null }
  if (ref === null) return { primary: extensionName ?? null, kind: extensionName ? 'name' : null, address: rawAddress ?? null }
  if (ref.profile?.name) return { primary: ref.profile.name, kind: 'profile', address: ref.address }
  if (ref.identity?.display) return { primary: ref.identity.display, kind: 'identity', address: ref.address }
  return { primary: extensionName ?? null, kind: extensionName ? 'name' : null, address: ref.address }
}

// "Open this page in the wallet app": a link that opens a URL inside a mobile
// wallet's in-app browser, where the wallet injects the extension API the
// connectors above already speak. Only links each wallet documents or ships and
// that we verified are listed:
//   - SubWallet: https://mobile.subwallet.app/browser?url=<encoded>, the universal
//     link its own app and its official deeplink tool (Koniverse/SubWallet-Deeplinks)
//     build; the domain's apple-app-site-association and assetlinks.json claim
//     /browser for app.subwallet.mobile.
//   - Nova Wallet documents https://app.novawallet.io/open/dapp?url=… but it works
//     only for a dApp listed in Nova's catalog (nova-utils), which this explorer is
//     not, so it is left out until it is.
//   - Talisman's mobile app documents no such link.
export const WALLET_APP_LINKS: readonly { id: string; title: string; icon: string; link: (pageUrl: string) => string }[] = [
  { id: 'subwallet-js', title: 'SubWallet', icon: '/wallet-icons/subwallet-js.svg', link: url => `https://mobile.subwallet.app/browser?url=${encodeURIComponent(url)}` },
]

/** Whether this looks like a phone or tablet browser (a coarse pointer and no hover), where the in-app-browser links help. */
export function isTouchBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(hover: hover)').matches
}
