import type { ClickHouseClient } from '../db/client.ts'

// Full asset registry (all 113 assets), independent of the trading-filtered
// cache in assetsService.ts. The Explorer must resolve symbol/decimals for every
// asset_id that can appear in balances/transfers, including foreign and aToken
// assets that the price UI hides.
interface AssetOrigin {
  ecosystem: string
  chainId: string
  assetId: string | null
}

export interface ExplorerAsset {
  assetId: number
  iconAssetId: number
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
}

const cache = new Map<number, ExplorerAsset>()
let refreshTimer: ReturnType<typeof setInterval> | null = null
let loadInflight: Promise<void> | null = null
const H2O_ASSET_ID = 1

async function loadExplorerAssetsUncached(client: ClickHouseClient): Promise<void> {
  const res = await client.query({
    query: `SELECT asset_id, symbol, name, decimals, parachain_id, origin_ecosystem, origin_chain_id, origin_asset_id FROM price_data.assets FINAL`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<AssetRow>()
  cache.clear()
  for (const r of rows) {
    const symbol = r.asset_id === H2O_ASSET_ID ? 'H2O' : r.symbol
    const name = NAME_OVERRIDES[r.asset_id] ?? (r.asset_id === H2O_ASSET_ID ? 'H2O' : r.name)
    cache.set(r.asset_id, {
      assetId: r.asset_id,
      iconAssetId: iconAssetIdFor(r.asset_id),
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
  ...envIdMap('EXPLORER_EXTRA_ATOKEN_UNDERLYING'),
}

// aTokens normally borrow their reserve asset's artwork (aDOT → DOT). GIGA-branded
// tokens are the exception: they ship their own CDN icon, so they must NOT alias to
// the underlying's — GIGAHDX's underlying stHDX has no icon at all, which is why the
// alias left GIGAHDX iconless. Price aliasing (priceAssetId) is unaffected.
const OWN_ICON_ASSET_IDS = new Set<number>([67]) // GIGAHDX
export function iconAssetIdFor(assetId: number): number {
  return OWN_ICON_ASSET_IDS.has(assetId) ? assetId : (ATOKEN_UNDERLYING_ID[assetId] ?? assetId)
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
  }
}

// Stableswap/pool SHARE tokens (2-Pool-GDOT, 2-Pool-HUSDC, …) carry no price feed
// of their own, so they inherit their main underlying's display price. Per-share value
// is approximately the underlying value for these near-peg two-asset pools; this is a
// unit-price proxy, not exact NAV.
export const SHARE_TOKEN_UNDERLYING_ID: Record<number, number> = {
  104: 34,     // 2-Pool-WETH   → ETH
  110: 1110,   // 2-Pool-HUSDC  → HUSDC
  111: 1111,   // 2-Pool-HUSDT  → HUSDT
  112: 1112,   // 2-Pool-HUSDS  → HUSDS
  113: 1113,   // 2-Pool-HUSDe  → HUSDe
  143: 43,     // 2-Pool-PRIME  → PRIME
  146: 46,     // 2-Pool-apyUSD → apyUSD
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

// The asset id under which `assetId` should be DISPLAYED in per-account holdings:
// a held Stableswap pool-share token (2-Pool-GDOT, …) is shown as its underlying
// main asset (GDOT), mirroring preis-ui which hides "-Pool" tokens. Unlike
// priceAssetId this folds ONLY share tokens, never aTokens (aToken / money-market
// collateral is folded separately via the MM path). Use for per-account balances
// only — NOT for aggregate/supply views (asset directory totals, holder lists),
// where folding a pool's TVL into the Giga token would double-count the vault that
// backs it.
export function displayAssetId(assetId: number): number {
  return SHARE_TOKEN_UNDERLYING_ID[assetId] ?? assetId
}

// Reverse of ATOKEN_UNDERLYING_ID: underlying reserve asset id → its aToken id.
// Used to label money-market collateral with the aToken the user actually holds
// (e.g. a DOT supply shows as aDOT, matching the Hydration wallet/borrow UI).
export const UNDERLYING_TO_ATOKEN_ID: Record<number, number> = Object.fromEntries(
  Object.entries(ATOKEN_UNDERLYING_ID).map(([aToken, underlying]) => [underlying, Number(aToken)]),
)
