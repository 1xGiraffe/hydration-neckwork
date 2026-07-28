// Wallet connection for login only — enable an injected extension, list its
// accounts, sign one message. No SDK: substrate extensions all speak the tiny
// window.injectedWeb3 protocol, EVM wallets announce via EIP-6963 (with a
// window.ethereum fallback for older injectors). WalletConnect is out of scope
// for v1 (needs a relay origin the CSP forbids and a heavy dependency).

export interface SubstrateWalletInfo { id: string; title: string; installUrl: string; icon: string; installed: boolean }
export interface InjectedAccount { address: string; name?: string }
interface InjectedExtension {
  accounts: { get(): Promise<InjectedAccount[]> }
  signer: { signRaw(payload: { address: string; data: string; type: 'bytes' }): Promise<{ signature: string }> }
}
interface InjectedWindow { injectedWeb3?: Record<string, { enable(origin: string): Promise<InjectedExtension> }> }

// The extension registry hydration-ui supports, minus wallets without a
// desktop story. Nova acts as polkadot-js inside its in-app browser — it
// shares the SAME injected key, so it gets no separate registry entry; the
// title just names both. Icons copied from galacticcouncil/hydration-ui
// (packages/web3-connect/src/wallets/<Name>/logo.svg, Apache-2.0) into
// public/wallet-icons/, same convention as public/tag-icons/.
const SUBSTRATE_WALLETS: { id: string; title: string; installUrl: string; icon: string }[] = [
  { id: 'polkadot-js', title: 'Polkadot{.js} / Nova', installUrl: 'https://polkadot.js.org/extension/', icon: '/wallet-icons/polkadot-js.svg' },
  { id: 'talisman', title: 'Talisman', installUrl: 'https://talisman.xyz/download', icon: '/wallet-icons/talisman.svg' },
  { id: 'subwallet-js', title: 'SubWallet', installUrl: 'https://www.subwallet.app/download.html', icon: '/wallet-icons/subwallet-js.svg' },
  { id: 'aleph-zero', title: 'Aleph Zero Signer', installUrl: 'https://alephzero.org/signer', icon: '/wallet-icons/aleph-zero.svg' },
  { id: 'enkrypt', title: 'Enkrypt', installUrl: 'https://www.enkrypt.com/', icon: '/wallet-icons/enkrypt.svg' },
  { id: 'fearless-wallet', title: 'Fearless Wallet', installUrl: 'https://fearlesswallet.io/', icon: '/wallet-icons/fearless-wallet.svg' },
  { id: 'polkagate', title: 'PolkaGate', installUrl: 'https://polkagate.xyz/', icon: '/wallet-icons/polkagate.svg' },
]

export function listSubstrateWallets(): SubstrateWalletInfo[] {
  const injected = (window as InjectedWindow).injectedWeb3 ?? {}
  const withStatus = SUBSTRATE_WALLETS.map(w => ({ ...w, installed: w.id in injected }))
  // Installed wallets first (so an install-link wallet never outranks one the
  // visitor can actually click), declaration order as the tiebreak within
  // each group — Array#filter is stable, so this needs no explicit sort.
  return [...withStatus.filter(w => w.installed), ...withStatus.filter(w => !w.installed)]
}

export async function connectSubstrate(id: string): Promise<{ accounts: InjectedAccount[]; ext: InjectedExtension }> {
  const injected = (window as InjectedWindow).injectedWeb3?.[id]
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
