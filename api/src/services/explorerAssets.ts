import type { ClickHouseClient } from '../db/client.ts'

// Full asset registry (all 113 assets), independent of the trading-filtered
// cache in assetsService.ts. The Explorer must resolve symbol/decimals for every
// asset_id that can appear in balances/transfers, including foreign and aToken
// assets that the price UI hides.
export interface AssetOrigin {
  ecosystem: string
  chainId: string
  assetId: string | null
}

export interface ExplorerAsset {
  assetId: number
  iconAssetId: number
  // A POOL SHARE token's member assets, so a surface can draw the pool the way the
  // Hydration UI does — a cluster of what is in it — instead of one borrowed icon.
  // Absent on every ordinary asset. Each member is already resolved through
  // iconAssetIdFor, so an aToken member shows its reserve's artwork.
  iconAssetIds?: number[]
  symbol: string
  name: string | null
  decimals: number
  parachainId: number | null
  origin: AssetOrigin | null
}

interface AssetRow {
  asset_id: number
  symbol: string
  name: string
  decimals: number
  parachain_id: number | null
  origin_ecosystem: string | null
  origin_chain_id: string | null
  origin_asset_id: string | null
  evm_address: string | null
}

const cache = new Map<number, ExplorerAsset>()
let refreshTimer: ReturnType<typeof setInterval> | null = null
let loadInflight: Promise<void> | null = null
// The Omnipool hub asset. The on-chain registry still spells it LRNA / Lerna;
// every surface names it H2O (AGENTS.md), so both registry loaders — this one
// and the preis/market-stats loader in assetsService — rename it on load.
export const H2O_ASSET_ID = 1

// Every stableswap pool's member assets, keyed by the pool's SHARE token id (a
// pool's id IS its share token's registry id). Read from the MV-fed state history,
// which is the generic source: a pool registered tomorrow is covered with no code
// change, unlike the hand-kept alias maps below.
//
// This is what gives the multi-asset share tokens an icon at all. A pool with one
// dominant asset can borrow that asset's artwork (SHARE_TOKEN_UNDERLYING_ID), but
// 2-Pool is USDT+USDC and 4-Pool is four stablecoins — there is no single asset
// they could borrow from, so they rendered the letter placeholder.
//
// 17 rows, so the read is trivial and rides the registry's own refresh.
async function loadStableswapMembers(client: ClickHouseClient): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>()
  try {
    const res = await client.query({
      query: `SELECT pool_id, argMax(asset_ids, block_height) AS members
              FROM price_data.stableswap_pool_state_history GROUP BY pool_id`,
      format: 'JSONEachRow',
    })
    for (const row of await res.json<{ pool_id: number; members: number[] }>()) {
      if (Array.isArray(row.members) && row.members.length) out.set(Number(row.pool_id), row.members.map(Number))
    }
  } catch (err) {
    // A share token without its members renders as it did before — a borrowed icon
    // or the letter — so a failed read costs artwork, never correctness.
    console.error('[ExplorerAssets] stableswap member read failed:', err)
  }
  return out
}


/**
 * Pair every money-market aToken with the reserve it wraps, from the Aave reserve
 * map we already index — so a reserve opened on a new asset is priced and iconed
 * the moment the map sees it, with no code change.
 *
 * The table above is the SEED, not the whole truth: its entries are deliberate
 * exceptions the map cannot express (BIL is the traded leg while its underlying
 * uBIL has no feed at all; GIGAHDX prices off stHDX), so a discovered pair never
 * overwrites one. It only fills gaps.
 *
 * An underlying is named in the map by its ERC-20 precompile, whose low four bytes
 * ARE the asset id — `0x…0100000069` is asset 105. A reserve naming a contract this
 * chain has no asset for is skipped rather than guessed at.
 *
 * Measured: the Treasury wrapped four pool shares on 2026-09-16 into aTokens
 * registered in the same block, and every one of them reached the explorer with no
 * price and no icon because this pairing was hand-written.
 */
const PRECOMPILE_ASSET_RE = /^0x0{31}1([0-9a-f]{8})$/
function underlyingAssetIdOf(address: string, byContract: Map<string, number>): number | undefined {
  const addr = (address ?? '').toLowerCase()
  const precompiled = PRECOMPILE_ASSET_RE.exec(addr)
  if (precompiled) {
    const id = Number.parseInt(precompiled[1], 16)
    return Number.isSafeInteger(id) ? id : undefined
  }
  return byContract.get(addr)
}

async function discoverATokenUnderlyings(client: ClickHouseClient, rows: readonly AssetRow[]): Promise<void> {
  const byContract = new Map<string, number>()
  for (const r of rows) {
    const addr = (r.evm_address ?? '').toLowerCase()
    if (addr) byContract.set(addr, r.asset_id)
  }
  let reserves: { asset_address: string; atoken: string; market_key: string }[]
  try {
    const res = await client.query({
      query: `SELECT asset_address, atoken, market_key FROM price_data.atoken_reserve_map FINAL WHERE atoken != ''`,
      format: 'JSONEachRow',
    })
    reserves = await res.json<{ asset_address: string; atoken: string; market_key: string }>()
  } catch (err) {
    // The map is an enrichment, never a gate: without it the seeded pairs still work.
    console.error('[ExplorerAssets] aToken reserve map unavailable:', err)
    return
  }
  for (const reserve of reserves) {
    const aTokenId = byContract.get((reserve.atoken ?? '').toLowerCase())
    if (aTokenId == null) continue
    const underlyingId = underlyingAssetIdOf(reserve.asset_address, byContract)
    // A reserve over a pool share is that share's wrapper whatever the alias
    // direction below decides — the map is the only source of the pairing.
    if (underlyingId != null && underlyingId !== aTokenId && isStableswapShareToken(underlyingId) && MM_MARKETS.some(m => m.key === reserve.market_key)) {
      SHARE_WRAPPER[underlyingId] = { aTokenId, marketKey: reserve.market_key }
    }
    // A hand-written pairing wins: it encodes a direction the map cannot.
    if (ATOKEN_UNDERLYING_ID[aTokenId] != null) continue
    if (underlyingId == null || underlyingId === aTokenId) continue
    // Never invert an alias that already runs the other way. The map calls
    // 2-Pool-GDOT the reserve of GDOT, while the share table prices the pool share
    // OFF GDOT; taking both would alias the pair in a cycle, and priceAssetId would
    // walk it to its hop bound and land on whichever end the parity chose.
    if (PRICE_ALIAS_ID[underlyingId] === aTokenId) continue
    ATOKEN_UNDERLYING_ID[aTokenId] = underlyingId
    if (PRICE_ALIAS_ID[aTokenId] == null) PRICE_ALIAS_ID[aTokenId] = underlyingId
    if (UNDERLYING_TO_ATOKEN_ID[underlyingId] == null) UNDERLYING_TO_ATOKEN_ID[underlyingId] = aTokenId
    console.log(`[ExplorerAssets] aToken ${aTokenId} → underlying ${underlyingId} (from the reserve map)`)
  }
}

async function loadExplorerAssetsUncached(client: ClickHouseClient): Promise<void> {
  const res = await client.query({
    query: `SELECT asset_id, symbol, name, decimals, parachain_id, origin_ecosystem, origin_chain_id, origin_asset_id, evm_address FROM price_data.assets FINAL`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<AssetRow>()
  const poolMembers = await loadStableswapMembers(client)
  // Additive only: a failed member read must not make a known share token look like
  // an ordinary asset, which would let currentPriceAssetId alias it again.
  for (const poolId of poolMembers.keys()) STABLESWAP_SHARE_IDS.add(poolId)
  // Before the cache is built: iconAssetIdFor reads the pairing, so a newly
  // discovered aToken must know its reserve to borrow that reserve's artwork.
  await discoverATokenUnderlyings(client, rows)
  cache.clear()
  for (const r of rows) {
    const symbol = r.asset_id === H2O_ASSET_ID ? 'H2O' : r.symbol
    const name = NAME_OVERRIDES[r.asset_id] ?? (r.asset_id === H2O_ASSET_ID ? 'H2O' : r.name)
    // A wrapper over a pool share inherits the pool's member cluster. a3-Pool is an
    // aToken whose reserve is 3-Pool, and 3-Pool is a multi-member pool with no single
    // asset to borrow artwork from — so resolving the wrapper to its reserve only moves
    // the problem: the reserve's icon IS the cluster, which was filed under the reserve's
    // id and never reached the wrapper. Own id wins, so a share token that is itself a
    // pool (2-Pool-GDOT) keeps its own members rather than its underlying's.
    const members = poolMembers.get(r.asset_id) ?? poolMembers.get(iconAssetIdFor(r.asset_id))
    cache.set(r.asset_id, {
      assetId: r.asset_id,
      iconAssetId: iconAssetIdFor(r.asset_id),
      ...(members && members.length > 1 ? { iconAssetIds: members.map(iconAssetIdFor) } : {}),
      symbol,
      name: name === symbol ? null : name,
      decimals: r.decimals,
      parachainId: r.parachain_id ?? null,
      origin: r.origin_ecosystem && r.origin_chain_id
        ? { ecosystem: r.origin_ecosystem, chainId: r.origin_chain_id, assetId: r.origin_asset_id ?? null }
        : null,
    })
  }
  inheritATokenOrigins()
  await injectBonds(client)
  buildDisplayFaces()
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      loadExplorerAssets(client).catch(err => console.error('[ExplorerAssets] refresh failed:', err))
    }, 300_000)
    refreshTimer.unref()
  }
}

export function loadExplorerAssets(client: ClickHouseClient): Promise<void> {
  if (loadInflight) return loadInflight
  const request = loadExplorerAssetsUncached(client).finally(() => {
    if (loadInflight === request) loadInflight = null
  })
  loadInflight = request
  return request
}

export function stopExplorerAssetsRefresh(): void {
  if (!refreshTimer) return
  clearInterval(refreshTimer)
  refreshTimer = null
}

export function allExplorerAssets(): ExplorerAsset[] {
  return [...cache.values()]
}

// Resolve an asset id to a lightweight descriptor, falling back to a synthetic
// entry for ids not in the registry so the UI always has a symbol + decimals.
// Whether the registry has this asset at all — `assetDescriptor` answers with a
// placeholder otherwise, and a caller about to scale an amount by its decimals
// must know the difference between a real 12 and the placeholder's.
export function knownExplorerAsset(assetId: number): boolean {
  return cache.has(assetId)
}

// The asset's decimals, or null when the registry has never seen the id. Callers
// doing ARITHMETIC across two assets must use this rather than
// `assetDescriptor(id).decimals`: the descriptor answers an unknown id with a
// 12-decimal placeholder, which is fine for a label but silently scales a
// computed rate by orders of magnitude.
export function assetDecimalsOrNull(assetId: number): number | null {
  return cache.get(assetId)?.decimals ?? null
}

export function assetDescriptor(assetId: number): ExplorerAsset {
  return cache.get(assetId) ?? {
    assetId,
    iconAssetId: iconAssetIdFor(assetId),
    symbol: `#${assetId}`,
    name: null,
    decimals: 12,
    parachainId: null,
    origin: null,
  }
}

// Parse an env-supplied id→id map (JSON object of numeric-string keys/values),
// used to extend hardcoded asset aliases without a deploy. Invalid entries are
// ignored rather than poisoning the whole registry.
function envIdMap(name: string): Record<number, number> {
  const raw = process.env[name]?.trim()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<number, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      const key = Number(k)
      const val = Number(v)
      if (Number.isInteger(key) && Number.isInteger(val)) out[key] = val
    }
    return out
  } catch {
    console.error(`[ExplorerAssets] ${name} is not valid JSON; ignoring`)
    return {}
  }
}

// Curated display names for registry entries whose on-chain name is empty or
// unhelpful. Applied at registry load; extend as new unnamed assets surface.
export const NAME_OVERRIDES: Record<number, string> = {
  67: 'Giga HDX',
  670: 'Staked HDX',
}

// Money-market aTokens are 1:1 with their reserve asset. This is the single
// source for price aliases, display metadata, holder reconstruction, and reverse
// reserve lookup. Extend it for future registered aTokens through the environment.
export const ATOKEN_UNDERLYING_ID: Record<number, number> = {
  1001: 5,        // aDOT   → DOT
  1002: 10,       // aUSDT  → USDT
  1003: 22,       // aUSDC  → USDC
  1004: 19,       // aWBTC  → WBTC
  1005: 15,       // avDOT  → vDOT
  1006: 1000765,  // atBTC  → tBTC
  1007: 34,       // aETH   → ETH
  1008: 103,      // a3-Pool→ 3-Pool
  1009: 1000752,  // aSOL   → SOL
  1039: 39,       // aPAXG  → PAXG
  1043: 43,       // aPRIME → PRIME
  1044: 44,       // aEURC  → EURC
  1046: 46,       // aapyUSD→ apyUSD
  1816: 816,      // aSIGIL → SIGIL (no price feed yet, included for completeness)
  67: 670,        // GIGAHDX→ stHDX (the gigahdx market's aToken — HDX staking receipt)
  55: 550,        // BIL    → uBIL (the bil market's aToken — Brazilian invoice receivables)
  ...envIdMap('EXPLORER_EXTRA_ATOKEN_UNDERLYING'),
}

// Money-market reserve contracts that aren't the standard ERC-20 precompile (HOLLAR).
// Extend via EXPLORER_EXTRA_MM_CONTRACT_ASSET ({"0x…":<assetId>}) when a new market adds a
// deployed-token reserve. Read once at module load, like EXPLORER_EXTRA_ATOKEN_UNDERLYING,
// in every process that imports this leaf (api, derivations, api-public, api-data);
// docker-compose.yml passes both variables to exactly those four services. api-mcp
// imports no service leaf (it answers over HTTP from `api`), so it needs neither.
function envContractAssetMap(): Record<string, number> {
  const raw = process.env.EXPLORER_EXTRA_MM_CONTRACT_ASSET?.trim()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      const id = Number(v)
      if (/^0x[0-9a-fA-F]{40}$/.test(k) && Number.isInteger(id)) out[k.toLowerCase()] = id
    }
    return out
  } catch {
    console.error('[ExplorerAssets] EXPLORER_EXTRA_MM_CONTRACT_ASSET is not valid JSON; ignoring')
    return {}
  }
}
export const MM_CONTRACT_ASSET: Readonly<Record<string, number>> = { '0x531a654d1696ed52e7275a8cede955e82620f99a': 222, ...envContractAssetMap() }

// A money-market reserve address → its registry asset id: the ERC-20 precompile
// (0x…01 + 8-hex asset id) encodes the id, and a deployed contract (HOLLAR) is looked up.
export function assetIdFromMmAddress(addr: string): number | null {
  const h = (addr ?? '').toLowerCase().replace(/^0x/, '')
  if (MM_CONTRACT_ASSET['0x' + h] != null) return MM_CONTRACT_ASSET['0x' + h]
  if (h.length === 40 && /^0{30}01/.test(h)) return parseInt(h.slice(32), 16)
  return null
}

// The reverse: every reserve address an asset (or its aToken) can be filed under — the
// standard precompile plus any deployed contract mapped to the same id.
export function mmReserveAddressForAsset(assetId: number): string[] {
  const reserveId = ATOKEN_UNDERLYING_ID[assetId] ?? assetId
  const standard = '0x' + '0'.repeat(30) + '01' + reserveId.toString(16).padStart(8, '0')
  const deployed = Object.entries(MM_CONTRACT_ASSET)
    .filter(([, id]) => id === reserveId)
    .map(([addr]) => addr)
  return [...new Set([standard, ...deployed])]
}

// aTokens normally borrow their reserve asset's artwork (aDOT → DOT). Branded
// product tokens are the exception: they ship their own CDN icon, so they must NOT
// alias to the underlying's — GIGAHDX's underlying stHDX has no icon at all, which
// is why the alias left GIGAHDX iconless, and BIL's own art is the listed brand
// while uBIL's marks the wrapped receivable. Price aliasing (priceAssetId) is
// unaffected.
const OWN_ICON_ASSET_IDS = new Set<number>([67, 55]) // GIGAHDX, BIL
// A wrapper with no artwork of its own borrows its underlying's, the same rule the
// Hydration UI applies (an asset without `iconSrc` that is an aToken, a bond or a
// stableswap share resolves through `underlyingAssetId`). aTokens and bonds already
// carried it; pool SHARE tokens are folded here too, so 2-Pool-GDOT shows GDOT and
// 2-Pool-WETH shows ETH rather than the letter placeholder their own ids resolve to.
// Single-hop on purpose: the two maps never chain, and a share token whose underlying
// is itself iconless (the Hollar-wrapped stables) resolves to the id the UI holds a
// composite for.
export function iconAssetIdFor(assetId: number): number {
  if (OWN_ICON_ASSET_IDS.has(assetId)) return assetId
  return ATOKEN_UNDERLYING_ID[assetId] ?? SHARE_TOKEN_UNDERLYING_ID[assetId] ?? assetId
}

// An aToken uses its reserve asset's artwork, so its origin badge must describe
// that same reserve too. Keep explicit aToken metadata authoritative if the
// registry gains it later, and only fill fields that are currently absent.
function inheritATokenOrigins(): void {
  for (const [aTokenId, underlyingId] of Object.entries(ATOKEN_UNDERLYING_ID)) {
    const aToken = cache.get(Number(aTokenId))
    const underlying = cache.get(underlyingId)
    if (!aToken || !underlying) continue

    const parachainId = aToken.parachainId ?? underlying.parachainId
    const origin = aToken.origin ?? underlying.origin
    if (parachainId === aToken.parachainId && origin === aToken.origin) continue
    cache.set(aToken.assetId, { ...aToken, parachainId, origin })
  }
}

// Bond tokens (Bonds pallet) aren't published to the asset registry the way ordinary
// assets are, so they otherwise reach the explorer as a bare `#id` with no name,
// icon or price. Each bond maps 1:1 to an underlying asset + a maturity via
// Bonds.TokenCreated, so we synthesise a registry entry that borrows the underlying's
// icon / decimals / origin and prices through it (a bond redeems 1:1 for the
// underlying at maturity). Runs on every registry refresh, so new bonds appear
// automatically. Best-effort: a failed lookup leaves bonds as bare ids, never the
// rest of the registry.
// bond id → the asset it redeems for, one entry per Bonds.TokenCreated. The bond
// activity builders read it to tell a bond from any other aliased asset and to list
// the underlying beside the bond in a row's asset references.
export const BOND_UNDERLYING_ID: Record<number, number> = {}
async function injectBonds(client: ClickHouseClient): Promise<void> {
  let rows: { bond_id: number; underlying: number; maturity: string }[]
  try {
    const res = await client.query({
      query: `SELECT JSONExtractInt(args_json,'bondId') AS bond_id,
                     JSONExtractInt(args_json,'assetId') AS underlying,
                     toString(JSONExtractUInt(args_json,'maturity')) AS maturity
              FROM price_data.raw_events
              WHERE event_name = 'Bonds.TokenCreated'`,
      format: 'JSONEachRow',
    })
    rows = await res.json<{ bond_id: number; underlying: number; maturity: string }>()
  } catch (err) {
    console.error('[ExplorerAssets] bond registry load failed:', err instanceof Error ? err.message : err)
    return
  }
  for (const r of rows) {
    const bondId = Number(r.bond_id)
    if (!Number.isInteger(bondId) || bondId <= 0) continue
    const base = cache.get(Number(r.underlying)) ?? assetDescriptor(Number(r.underlying))
    const maturityMs = Number(r.maturity)
    const matures = Number.isFinite(maturityMs) && maturityMs > 0 ? new Date(maturityMs).toISOString().slice(0, 10) : null
    cache.set(bondId, {
      assetId: bondId,
      iconAssetId: base.iconAssetId,
      symbol: `${base.symbol}b`,
      name: `${base.name ?? base.symbol} Bond${matures ? ` · matures ${matures}` : ''}`,
      decimals: base.decimals,
      parachainId: base.parachainId,
      origin: base.origin,
    })
    // Price/value through the underlying (feeds priceAssetId + the SQL alias).
    PRICE_ALIAS_ID[bondId] = Number(r.underlying)
    BOND_UNDERLYING_ID[bondId] = Number(r.underlying)
  }
}

// Stableswap/pool SHARE tokens (2-Pool-GDOT, 2-Pool-HUSDC, …) → the main asset they
// display as (displayAssetId) and borrow artwork from. For HISTORICAL valuation
// (candles) the share also prices through it — a unit-price proxy, not NAV, since a
// share has no redeemable-value history. CURRENT valuation never uses this alias: a
// share's current price is its derived redeemable value (see currentPriceAssetId).
export const SHARE_TOKEN_UNDERLYING_ID: Record<number, number> = {
  104: 34,     // 2-Pool-WETH   → ETH
  110: 1110,   // 2-Pool-HUSDC  → HUSDC
  111: 1111,   // 2-Pool-HUSDT  → HUSDT
  112: 1112,   // 2-Pool-HUSDS  → HUSDS
  113: 1113,   // 2-Pool-HUSDe  → HUSDe
  143: 43,     // 2-Pool-PRIME  → PRIME
  146: 46,     // 2-Pool-apyUSD → apyUSD
  10055: 55,   // 2-Pool-BIL    → BIL
  690: 69,     // 2-Pool-GDOT   → GDOT
  4200: 420,   // 2-Pool-GETH   → GETH
  10044: 4444, // 2-Pool-HEURC  → HEURC
  90001: 9001, // 2-Pool-GSOL   → GSOL
}
// Duplicate/wrapped registry entries whose economic price should follow the
// canonical listed asset. They keep their own balances/holders; only price and
// price history are aliased.
const DUPLICATE_PRICE_ALIAS_ID: Record<number, number> = {
  42: 44,        // EURC          → EURC (Moonbeam Wormhole)
  1000746: 44,   // EURC.s        → EURC (Moonbeam Wormhole)
  // stHDX is staked HDX (pallet-gigahdx): the HDX↔stHDX rate is floored at
  // 1:1 and drifts up only as staking yield accrues, so the HDX price is a
  // tight floor for it (and transitively for GIGAHDX, its aToken).
  670: 0,        // stHDX         → HDX
  // BIL inverts the usual aToken direction: the aToken IS the liquid traded leg
  // (HSM/router trades quote BIL directly) while its underlying uBIL never
  // trades. The self-entry overrides the ATOKEN_UNDERLYING_ID spread so BIL
  // keeps its own feed, and uBIL — an Aave underlying, always 1:1 with its
  // rebasing aToken — values through it. Without the self-entry the pair would
  // alias in both directions and priceAssetId's hop bound would leave uBIL
  // resolving to itself, unpriced.
  55: 55,        // BIL           → itself (own feed)
  550: 55,       // uBIL          → BIL
}
// Every asset that should be priced via another asset (aTokens + pool shares).
export const PRICE_ALIAS_ID: Record<number, number> = { ...ATOKEN_UNDERLYING_ID, ...SHARE_TOKEN_UNDERLYING_ID, ...DUPLICATE_PRICE_ALIAS_ID }

// The asset id whose price/value should be used for `assetId`: itself, unless it
// is an aToken or pool-share token, in which case its priced underlying.
export function priceAssetId(assetId: number): number {
  // Aliases can chain (GIGAHDX → stHDX → HDX); resolve transitively with a
  // small bound so a (mis)configured cycle can't loop forever.
  let id = assetId
  for (let hop = 0; hop < 4; hop++) {
    const next = PRICE_ALIAS_ID[id]
    if (next == null || next === id) return id
    id = next
  }
  return id
}

// Every stableswap share token (a pool's id IS its share token's registry id): the
// hand-kept SHARE_TOKEN_UNDERLYING_ID keys plus every pool the state history has ever
// seen, added at each registry load (loadStableswapMembers), so a pool registered
// tomorrow is recognised with no code change.
const STABLESWAP_SHARE_IDS = new Set<number>(Object.keys(SHARE_TOKEN_UNDERLYING_ID).map(Number))
export function isStableswapShareToken(assetId: number): boolean {
  return STABLESWAP_SHARE_IDS.has(assetId)
}
/** Test seam: register a share token id the way a registry load would. */
export function registerStableswapShareToken(assetId: number): void {
  STABLESWAP_SHARE_IDS.add(assetId)
}

// The id whose CURRENT price values `assetId` when it has no entry of its own:
// priceAssetId's alias walk, stopped at the first stableswap share token. A share's
// current price is never borrowed from an underlying — each current price map
// carries the share's own derived redeemable value (lpMath.stableswapSharePrices)
// under the share's id, or nothing when a leg is unpriced — so an aToken over a
// share (a3-Pool → 3-Pool) without a feed of its own values through the share, and
// the share itself resolves to itself. Look prices up through currentPriceOf, which
// applies the one precedence rule; this is the alias half of it. priceAssetId keeps
// the full walk for HISTORICAL (candle) valuation: a share has no redeemable-value
// history, and its underlying's close stays the documented proxy there.
export function currentPriceAssetId(assetId: number): number {
  let id = assetId
  for (let hop = 0; hop < 4; hop++) {
    if (STABLESWAP_SHARE_IDS.has(id)) return id
    const next = PRICE_ALIAS_ID[id]
    if (next == null || next === id) return id
    id = next
  }
  return id
}

/**
 * The CURRENT price of `assetId` in a surface's current price map — the ONE lookup
 * rule every current-value surface (explorer price map, public /v1/accounts/balances,
 * Data API) applies: the asset's OWN entry first (its feed, or for a share token its
 * derived redeemable value), else the entry of the asset currentPriceAssetId
 * resolves it to. So an aToken with a feed of its own (GDOT, over the 2-Pool-GDOT
 * share) values at that feed, and one without values through its alias — a share
 * where the walk reaches one. A share with no entry is unpriced: currentPriceAssetId
 * resolves a share to itself, so it is never walked on to an underlying.
 */
export function currentPriceOf<T>(prices: ReadonlyMap<number, T>, assetId: number): T | undefined {
  return prices.get(assetId) ?? prices.get(currentPriceAssetId(assetId))
}

// The asset id under which `assetId` should be DISPLAYED in per-account holdings:
// a held Stableswap pool-share token (2-Pool-GDOT, …) is shown as its underlying
// main asset (GDOT), mirroring preis-ui which hides "-Pool" tokens. Unlike
// priceAssetId this folds ONLY share tokens, never aTokens (aToken / money-market
// collateral is folded separately via the MM path). Aggregate holder/supply views
// may fold these only when the hidden share id is removed from presentation and a
// money-market custody balance is replaced—not added to—its beneficial aToken
// holders; otherwise the vault would be double-counted.
export function displayAssetId(assetId: number): number {
  return SHARE_TOKEN_UNDERLYING_ID[assetId] ?? assetId
}

// Reverse of ATOKEN_UNDERLYING_ID: underlying reserve asset id → its aToken id.
// Used to label money-market collateral with the aToken the user actually holds
// (e.g. a DOT supply shows as aDOT, matching the Hydration wallet/borrow UI).
export const UNDERLYING_TO_ATOKEN_ID: Record<number, number> = Object.fromEntries(
  Object.entries(ATOKEN_UNDERLYING_ID).map(([aToken, underlying]) => [underlying, Number(aToken)]),
)

// A stableswap share that is itself a money-market reserve → the aToken minted
// over it and the market it is in: the Hydration app's "Hydrated" pools (HUSDT
// over 2-Pool-HUSDT, GDOT over 2-Pool-GDOT, a3-Pool over 3-Pool), whose
// add-liquidity flow supplies the share and hands the holder the aToken. Filled
// from the reserve map at registry load (discoverATokenUnderlyings) as a fact
// about the reserve, recorded whichever way the price alias runs — which is why
// UNDERLYING_TO_ATOKEN_ID (the alias direction) cannot serve: the share prices
// OFF its wrapper there, so the pair is skipped. The wrapper NAMES the pool
// (`named`) exactly when the share already displays as it (SHARE_TOKEN_UNDERLYING_ID,
// the balances fold): HUSDT and GDOT, never a3-Pool.
export interface ShareWrapper { aTokenId: number; marketKey: string }
export const SHARE_WRAPPER: Record<number, ShareWrapper> = {}
export function shareWrapperOf(shareId: number): (ShareWrapper & { named: boolean }) | undefined {
  const w = SHARE_WRAPPER[shareId]
  return w ? { ...w, named: SHARE_DISPLAY_FACE[shareId] === w.aTokenId } : undefined
}
/** Test seam: pair a share with its wrapper the way a registry load would. */
export function registerShareWrapper(shareId: number, wrapper: ShareWrapper | null): void {
  if (wrapper) SHARE_WRAPPER[shareId] = wrapper
  else delete SHARE_WRAPPER[shareId]
  refreshDisplayFace(shareId)
}

// ─── Display face ─────────────────────────────────────────────────────────────
// The ONE display-name rule for pool shares: a stableswap share whose money-market
// wrapper is a NAMED PRODUCT shows under the wrapper's face — its symbol and its
// artwork — on every reader-facing explorer surface, while keeping its own id,
// decimals and amounts. That is the Hydration app's naming: the app lists the
// "Hydrated" pool as HUSDT, GDOT, GETH, HEURC, GSOL… and never shows the
// 2-Pool-… share the aToken is minted over, so a reader who supplied "GDOT" finds
// the same word on the Borrow tab (the reserve IS the share), on the Liquidity
// tab, on every activity row that moves the share (a money-market supply, an
// add-liquidity, a trade routed through it) and in the MCP renderer.
//
// A wrapper carries a product name when its registry symbol is not the aToken
// default — `a` + the share's symbol: HUSDT over 2-Pool-HUSDT and GDOT over
// 2-Pool-GDOT are products, a3-Pool over 3-Pool and a2-Pool-PRIME over
// 2-Pool-PRIME are not, and those shares keep their own name. Both ends must be
// registry rows; a placeholder never names anything. Read at registry load from
// the reserve map (SHARE_WRAPPER), so a Hydrated pool opened tomorrow is named
// with no code change.
//
// The face changes the NAME only. The share's on-chain name stays in `name`
// (2-Pool-GDOT), so an asset or pool page still states which registry entry it
// is, and `assetDescriptor` still answers the registry's own symbol for the
// public and Data APIs, whose contracts are frozen. Folding a HOLDING into the
// wrapper's row (displayAssetId / SHARE_TOKEN_UNDERLYING_ID, which is also the
// historical price proxy) is a separate, hand-kept rule; this one names, it
// never merges or prices.
export const SHARE_DISPLAY_FACE: Record<number, number> = {}
const displayFaces = new Map<number, ExplorerAsset>()
/** Whether an aToken's symbol names a product rather than restating its reserve (`a<reserve>`). */
export function isProductWrapperSymbol(wrapperSymbol: string, reserveSymbol: string): boolean {
  return wrapperSymbol.trim().toLowerCase() !== `a${reserveSymbol.trim()}`.toLowerCase()
}
function refreshDisplayFace(shareId: number): void {
  delete SHARE_DISPLAY_FACE[shareId]
  displayFaces.delete(shareId)
  const w = SHARE_WRAPPER[shareId]
  const share = w && cache.get(shareId)
  const wrapper = w && cache.get(w.aTokenId)
  if (!share || !wrapper || !isProductWrapperSymbol(wrapper.symbol, share.symbol)) return
  SHARE_DISPLAY_FACE[shareId] = wrapper.assetId
  // Own id, decimals and origin; the wrapper's symbol and artwork (both icon
  // fields, so the share draws exactly as the wrapper does); the on-chain name kept.
  const { iconAssetIds: _own, ...own } = share
  displayFaces.set(shareId, {
    ...own,
    symbol: wrapper.symbol,
    name: share.name ?? share.symbol,
    iconAssetId: wrapper.iconAssetId,
    ...(wrapper.iconAssetIds ? { iconAssetIds: wrapper.iconAssetIds } : {}),
  })
}
function buildDisplayFaces(): void {
  for (const id of new Set([...Object.keys(SHARE_DISPLAY_FACE), ...Object.keys(SHARE_WRAPPER)].map(Number))) refreshDisplayFace(id)
}
/**
 * The descriptor a reader-facing explorer surface shows for `assetId`: the registry
 * entry, or for a pool share with a product-named wrapper its display face (above).
 * The explorer's AssetRef builder and every explorer-only renderer read this;
 * `assetDescriptor` stays the registry's own name.
 */
export function displayDescriptor(assetId: number): ExplorerAsset {
  return displayFaces.get(assetId) ?? assetDescriptor(assetId)
}

// Reverse of SHARE_TOKEN_UNDERLYING_ID: main asset id → the pool-share token ids
// that display as it. The share token can be what a protocol actually holds while
// the page a reader visits is the main asset — the money market's GDOT reserve is
// 2-Pool-GDOT (690), not GDOT (69) — so a reserve lookup has to be able to reach the
// share token from the main id. A list, since nothing stops two pools folding into
// one main asset. Decimals are NOT shared across the pair (2-Pool-PRIME carries 18
// where PRIME carries 6), so callers must read each id's own descriptor.
export const UNDERLYING_TO_SHARE_IDS: Record<number, number[]> = (() => {
  const out: Record<number, number[]> = {}
  for (const [share, underlying] of Object.entries(SHARE_TOKEN_UNDERLYING_ID)) {
    (out[underlying] ??= []).push(Number(share))
  }
  return out
})()

// ─── Money-market markets ─────────────────────────────────────────────────────
// AAVE v3 markets are isolated pools: getUserAccountData(user) on one pool returns
// ONLY that pool's aggregate, with its OWN health factor. A borrower in two markets
// (e.g. core + GIGAHDX) therefore has TWO independent positions/health factors — they
// are never blended, since liquidation is per market. Core is primary; GIGAHDX and BIL
// are built-in supplemental markets; EXPLORER_MM_MARKETS adds future deployments (read
// once at module load in every process that imports this leaf).
// `stakingBacked` marks a market (GIGAHDX) whose collateral (stHDX) is backed by HDX
// that stays LOCKED IN THE WALLET — so its collateral is display-only and must not be
// added to an account's value (the locked HDX is already counted).
export interface MmMarket {
  key: string
  label: string
  poolProxy: string
  role: 'primary' | 'supplemental'
  defiSimSupported: boolean
  stakingBacked: boolean
}
export const CORE_MM_MARKET: MmMarket = {
  key: 'core', label: 'Money Market', poolProxy: '0x1b02e051683b5cfac5929c25e84adb26ecf87b38',
  role: 'primary', defiSimSupported: true, stakingBacked: false,
}
export const GIGAHDX_MM_MARKET: MmMarket = {
  key: 'gigahdx', label: 'GIGAHDX', poolProxy: '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923',
  role: 'supplemental', defiSimSupported: false, stakingBacked: true,
}
// Isolated BIL market (Decentral × DUX Group invoice factoring): uBIL + HOLLAR
// reserves, BIL (asset 55) as the uBIL reserve's aToken. Deposits are ordinary
// EVM pool supplies — no staking pallet moves collateral — so unlike GIGAHDX it
// is not staking-backed and its Supply/Withdraw rows are real user acts.
export const BIL_MM_MARKET: MmMarket = {
  key: 'bil', label: 'BIL', poolProxy: '0x69310fda58c819ad82df7d2cb61841c853337a53',
  role: 'supplemental', defiSimSupported: false, stakingBacked: false,
}
function envMmMarkets(): MmMarket[] {
  const raw = process.env.EXPLORER_MM_MARKETS?.trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: MmMarket[] = []
    parsed.forEach((e, i) => {
      const r = (e ?? {}) as Record<string, unknown>
      const poolProxy = typeof r.poolProxy === 'string' && /^0x[0-9a-fA-F]{40}$/.test(r.poolProxy) ? r.poolProxy.toLowerCase() : null
      if (!poolProxy) { console.error(`[ExplorerAssets] EXPLORER_MM_MARKETS[${i}].poolProxy invalid; skipping`); return }
      const key = typeof r.key === 'string' && r.key.trim() ? r.key.trim() : `market${i + 1}`
      out.push({
        key, label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : key, poolProxy,
        role: 'supplemental', defiSimSupported: false, stakingBacked: r.stakingBacked === true,
      })
    })
    return out
  } catch {
    console.error('[ExplorerAssets] EXPLORER_MM_MARKETS is not valid JSON; ignoring')
    return []
  }
}
/** The configured markets in display order: core first, then the rest, deduped by pool proxy and key. */
export const MM_MARKETS: readonly MmMarket[] = (() => {
  const seen = new Set<string>(); const out: MmMarket[] = []
  const keys = new Set<string>()
  for (const m of [CORE_MM_MARKET, GIGAHDX_MM_MARKET, BIL_MM_MARKET, ...envMmMarkets()]) {
    if (!seen.has(m.poolProxy) && !keys.has(m.key)) { seen.add(m.poolProxy); keys.add(m.key); out.push(m) }
  }
  return out
})()
