// Hydration's Wormhole NTT managers, in both of the modes a manager can run in.
//
// A BURNING manager (the asset is minted here — WETH, USDC, PRIME, …) is registered
// with the runtime (`EVMAccounts.NttMinterSet`): a send is a transfer of the asset to
// the manager's account followed by a burn, an arrival is a mint (Currencies.Deposited).
//
// A LOCKING manager (the asset is native here and minted on the far chain — HDX and
// HOLLAR, bridged to Robinhood) never needs minting rights and so is not in that
// registry. A send moves the asset INTO the manager's custody and an arrival releases
// it OUT again: an ordinary transfer each way. For a pallet asset (HDX) that transfer
// is a Balances/Currencies event; for an Erc20 registry asset (HOLLAR, which lives in
// EVM storage) the manager moves it with transferFrom/transfer, so its ERC-20
// `Transfer` log is the ONLY trace — no pallet event is emitted at all.
//
// Either way the rule is the same and is stated once here: a movement of an NTT asset
// to or from that asset's own manager is the NTT send or arrival, never a plain
// transfer. The explorer's transfer reads exclude exactly the legs its cross-chain
// reads render (one rule, two sides), so a leg is always exactly one of the two.

export type NttManagerMode = 'burn' | 'lock'

export interface NttManagerRef {
  assetId: number
  /** The manager contract (bare H160, lowercase). */
  manager: string
  /** The ETH\0-widened account id the manager holds custody in (or burns from). */
  account: string
  mode: NttManagerMode
  /**
   * For a LOCKING manager of an Erc20 registry asset: the token contract whose
   * `Transfer` logs carry its lock and release legs. null otherwise.
   */
  erc20: string | null
}

// ERC-20 Transfer(address indexed from, address indexed to, uint256 value).
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export interface Erc20Transfer { from: string; to: string; value: string }

export function decodeErc20Transfer(topics: readonly string[], data: string): Erc20Transfer | null {
  if (topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC || topics.length < 3) return null
  const addr = (topic: string | undefined): string | null => {
    const t = (topic ?? '').toLowerCase()
    return /^0x[0-9a-f]{64}$/.test(t) ? '0x' + t.slice(-40) : null
  }
  const from = addr(topics[1])
  const to = addr(topics[2])
  const body = (data ?? '').replace(/^0x/, '')
  if (!from || !to || body.length < 64 || /[^0-9a-fA-F]/.test(body.slice(0, 64))) return null
  return { from, to, value: BigInt('0x' + body.slice(0, 64)).toString() }
}

/** The ETH\0-widened account id of a bare H160 (as NttMinterSet's minter is widened). */
export function nttManagerAccount(h160: string): string {
  return '0x45544800' + h160.replace(/^0x/, '').toLowerCase() + '0'.repeat(16)
}

/** The bare H160 back out of a widened account id. */
export function nttManagerH160(account: string): string {
  return '0x' + account.toLowerCase().slice(10, 50)
}

/**
 * One asset moving to or from a candidate manager inside one of that manager's OWN
 * NTT extrinsics (an extrinsic in which it logged TransferSent or TransferRedeemed).
 */
export interface NttLockObservation {
  manager: string
  assetId: number
  /** `block:extrinsic` — counted once per extrinsic. */
  extrinsic: string
  /** The ERC-20 contract the movement was logged by, for an EVM-side movement. */
  erc20?: string | null
}

export interface ResolvedLockManager { assetId: number; erc20: string | null }

/**
 * Which asset each non-minter manager locks, read off the movements in its own NTT
 * extrinsics. A manager's `token()` is immutable, so its lock legs only ever move
 * that one asset; the asset seen in the most of its extrinsics wins, and a tie is
 * left unresolved rather than guessed. A manager with no movement (a deployment that
 * has not carried a transfer yet, or one whose token is not a registry asset — the
 * NTTUSD test deployment) resolves to nothing: it has no rows to show.
 */
export function resolveLockManagers(observations: readonly NttLockObservation[]): Map<string, ResolvedLockManager> {
  const byManager = new Map<string, Map<number, { extrinsics: Set<string>; erc20: string | null }>>()
  for (const o of observations) {
    const manager = o.manager.toLowerCase()
    const assets = byManager.get(manager) ?? new Map()
    const entry = assets.get(o.assetId) ?? { extrinsics: new Set<string>(), erc20: null }
    entry.extrinsics.add(o.extrinsic)
    if (o.erc20) entry.erc20 = o.erc20.toLowerCase()
    assets.set(o.assetId, entry)
    byManager.set(manager, assets)
  }
  const out = new Map<string, ResolvedLockManager>()
  for (const [manager, assets] of byManager) {
    const ranked = [...assets].sort((a, b) => b[1].extrinsics.size - a[1].extrinsics.size)
    const [top, second] = ranked
    if (!top || (second && second[1].extrinsics.size === top[1].extrinsics.size)) continue
    out.set(manager, { assetId: top[0], erc20: top[1].erc20 })
  }
  return out
}

/**
 * The manager set: every burning manager from the minter registry, plus each resolved
 * locking manager whose asset no minter claims (where both claim one asset, the
 * registry's wins — the runtime only lets a minter mint).
 */
export function buildNttManagers(minters: ReadonlyMap<number, string>, locking: ReadonlyMap<string, ResolvedLockManager>): NttManagerRef[] {
  const refs: NttManagerRef[] = []
  for (const [assetId, account] of minters) {
    refs.push({ assetId, manager: nttManagerH160(account), account: account.toLowerCase(), mode: 'burn', erc20: null })
  }
  const minterManagers = new Set(refs.map(r => r.manager))
  for (const [manager, { assetId, erc20 }] of [...locking].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (minters.has(assetId) || minterManagers.has(manager)) continue
    refs.push({ assetId, manager, account: nttManagerAccount(manager), mode: 'lock', erc20 })
  }
  return refs
}

/** `(assetId,'account'),…` — the (asset, manager account) pairs a leg is matched by. */
export function nttLegPairsSql(managers: readonly NttManagerRef[]): string {
  return managers.map(m => `(${m.assetId},'${m.account}')`).join(',')
}

/**
 * The transfer family's half of the rule, for every transfer read site and the
 * transfer count arm: a transfer of an NTT asset TO its manager (a send — burn or
 * lock) or FROM it (a locking manager's release) is the cross-chain row's own leg.
 * `toExpr` is lowercased here; `fromExpr` is compared as given, because the read
 * models' `from_account` is lowercase throughout history (and lower() on it costs
 * several times the scan CPU) — a raw-events caller passes its own lower(…).
 */
export function nttLegExclusionSql(
  managers: readonly NttManagerRef[],
  assetExpr = 'asset_id',
  toExpr = 'to_account',
  fromExpr = 'from_account',
): string {
  if (!managers.length) return ''
  const pairs = nttLegPairsSql(managers)
  return `AND (toUInt32(${assetExpr}), lower(${toExpr})) NOT IN (${pairs}) AND (toUInt32(${assetExpr}), ${fromExpr}) NOT IN (${pairs})`
}

/** The manager a pallet transfer leg of `assetId` touching `account` belongs to, if any. */
export function nttManagerOfLeg(managers: readonly NttManagerRef[], assetId: number, account: string | null | undefined): NttManagerRef | undefined {
  if (!account) return undefined
  const acc = account.toLowerCase()
  return managers.find(m => m.assetId === assetId && m.account === acc)
}

/** The locking manager whose ERC-20 `token` moved to or from `h160`, if any. */
export function nttErc20ManagerOf(managers: readonly NttManagerRef[], token: string, h160: string): NttManagerRef | undefined {
  const t = token.toLowerCase()
  const a = h160.toLowerCase()
  return managers.find(m => m.erc20 === t && m.manager === a)
}
