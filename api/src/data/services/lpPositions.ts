import type { ClickHouseClient } from '../../db/client.ts'
import { assetDescriptor, priceAssetId } from '../../services/explorerAssets.ts'
import { HUB_ASSET_ID, OMNI_FIXED, omnipoolRemoveLiquidity, stableswapShareLegs, xykShareLegs } from '../../services/lpMath.ts'
import { renderUsd } from '../../services/valuation.ts'
import type { ParsedAddress } from './address.ts'
import { freshPriceMap } from './assetsData.ts'
import { poolSnapshot } from './poolSnapshot.ts'
import { xykLpAssetIds } from './poolsData.ts'

// The account's CURRENT liquidity positions across the three venues, each
// stated as what redeeming it now would return, at the pool state of the
// per-block snapshot and fresh current prices:
//
//  * Omnipool — one position per NFT the account holds directly (collection
//    1337) or through a liquidity-mining deposit (collection 2584, `farmed`),
//    from the MV-maintained nft_owner_latest / farm_deposit_latest /
//    omnipool_position_latest folds (the explorer's own reconstruction, exact
//    from genesis). Legs are the node's full-position removal (asset leg plus
//    the H2O hub leg where the price moved against the position).
//  * Stableswap — the account's share-token balance per pool, redeemed
//    pro-rata over every reserve (the peg-independent proportional withdraw).
//  * XYK — the account's LP-token balance (direct) and its open farm-deposit
//    principal (`farmed`, from the LP reconstruction the derivations service
//    refreshes), each redeemed pro-rata against the pool's reserves and total
//    shares.
//
// USD is at the current price (positions are holdings, not flows); an asset
// with no fresh price leaves `valueUsd` null on its leg and the position.

export interface LpLeg { assetId: string; amount: string; valueUsd: string | null }

export interface LpPositionItem {
  venue: 'omnipool' | 'stableswap' | 'xyk'
  farmed: boolean
  positionId: string | null
  poolKey: string
  shareAssetId: string | null
  shares: string
  legs: LpLeg[]
  valueUsd: string | null
}

export interface LpPositionsResult {
  items: LpPositionItem[]
  asOfBlock: number
  totals: { valueUsd: string }
}

const big = (value: unknown): bigint => {
  const text = String(value ?? '0')
  return /^\d+$/.test(text) ? BigInt(text) : 0n
}

function legOf(assetId: number, amount: bigint, prices: Map<number, bigint>): { leg: LpLeg; usd: bigint | null } {
  const price = prices.get(assetId) ?? prices.get(priceAssetId(assetId))
  const usd = price == null ? null : (amount * price) / 10n ** BigInt(assetDescriptor(assetId).decimals)
  return { leg: { assetId: String(assetId), amount: amount.toString(), valueUsd: usd == null ? null : renderUsd(usd) }, usd }
}

// The item plus its USD total in the valuation module's scaled integer form,
// so the account total is summed exactly and rendered once.
function assemble(venue: LpPositionItem['venue'], farmed: boolean, positionId: string | null, poolKey: string, shareAssetId: string | null, shares: bigint, legs: Array<{ assetId: number; amount: bigint }>, prices: Map<number, bigint>): { item: LpPositionItem; usd: bigint | null } {
  let total: bigint | null = 0n
  const out: LpLeg[] = []
  for (const { assetId, amount } of legs) {
    const { leg, usd } = legOf(assetId, amount, prices)
    out.push(leg)
    total = total == null || usd == null ? null : total + usd
  }
  return { item: { venue, farmed, positionId, poolKey, shareAssetId, shares: shares.toString(), legs: out, valueUsd: total == null ? null : renderUsd(total) }, usd: total }
}

interface OmnipoolPositionRow { position_id: string; farmed: number; asset_id: number; shares: string; amount: string; price: string }

// The account's position NFTs (direct and via farm deposits) joined to each
// position's newest state. The candidates are every position/deposit NFT the
// account was ever named on (nft_owner_events_by_account, account-first);
// each is re-checked against its CURRENT owner by primary key, so a
// transferred or burned NFT drops out and nothing outside the account's own
// rows is merged.
async function omnipoolPositions(client: ClickHouseClient, accountId: string): Promise<OmnipoolPositionRow[]> {
  const res = await client.query({
    query: `-- data:lp:omnipool-positions
        WITH
          candidates AS (
            SELECT DISTINCT collection, item
            FROM price_data.nft_owner_events_by_account
            WHERE account = {account:String} AND collection IN ('1337', '2584')
          ),
          own AS (
            SELECT collection, item
            FROM price_data.nft_owner_latest
            WHERE (collection, item) IN (SELECT collection, item FROM candidates)
            GROUP BY collection, item
            HAVING argMaxMerge(owner) = {account:String}
          ),
          deposits AS (
            SELECT deposit_id, argMaxMerge(position_id) AS position_id
            FROM price_data.farm_deposit_latest
            WHERE deposit_id IN (SELECT item FROM own WHERE collection = '2584')
            GROUP BY deposit_id
          ),
          held AS (
            SELECT item AS position_id, 0 AS farmed FROM own WHERE collection = '1337'
            UNION ALL
            SELECT position_id, 1 AS farmed FROM deposits
          )
        SELECT held.position_id AS position_id, held.farmed AS farmed,
               argMaxMerge(state.asset_id) AS asset_id, argMaxMerge(state.shares) AS shares,
               argMaxMerge(state.amount) AS amount, argMaxMerge(state.price) AS price
        FROM price_data.omnipool_position_latest AS state
        INNER JOIN held ON state.position_id = held.position_id
        GROUP BY held.position_id, held.farmed
        ORDER BY position_id`,
    query_params: { account: accountId },
    format: 'JSONEachRow',
  })
  return res.json<OmnipoolPositionRow>()
}

// The account's substrate balances that are LP share tokens: stableswap pool
// ids (a pool's share token IS its pool id) and XYK LP asset ids.
async function shareBalances(client: ClickHouseClient, accountId: string, shareAssetIds: number[]): Promise<Map<number, bigint>> {
  const out = new Map<number, bigint>()
  if (!shareAssetIds.length) return out
  const res = await client.query({
    query: `-- data:lp:share-balances
        SELECT asset_id, argMaxMerge(total_state) AS total
        FROM price_data.account_asset_latest_balances
        WHERE account_id = {account:String} AND asset_id IN {ids:Array(String)}
        GROUP BY asset_id`,
    query_params: { account: accountId, ids: shareAssetIds.map(String) },
    format: 'JSONEachRow',
  })
  for (const row of await res.json<{ asset_id: string; total: string | null }>()) {
    const total = big(row.total)
    if (total > 0n) out.set(Number(row.asset_id), total)
  }
  return out
}

async function xykFarmedShares(client: ClickHouseClient, accountId: string): Promise<Map<number, bigint>> {
  const res = await client.query({
    query: `-- data:lp:xyk-farmed
        SELECT lp_asset_id, toString(sum(toInt256(principal_shares_raw))) AS shares
        FROM price_data.xyk_farm_principal_intervals FINAL
        WHERE account_id = {account:String} AND valid_to_block = 0
        GROUP BY lp_asset_id`,
    query_params: { account: accountId },
    format: 'JSONEachRow',
  })
  const out = new Map<number, bigint>()
  for (const row of await res.json<{ lp_asset_id: number; shares: string }>()) {
    const shares = big(row.shares)
    if (shares > 0n) out.set(Number(row.lp_asset_id), shares)
  }
  return out
}

// Total outstanding LP shares per XYK pool (the reconstructed step function's
// newest point), for the lp assets the account holds.
async function xykTotalShares(client: ClickHouseClient, lpAssetIds: number[]): Promise<Map<number, bigint>> {
  const out = new Map<number, bigint>()
  if (!lpAssetIds.length) return out
  const res = await client.query({
    query: `-- data:lp:xyk-total-shares
        SELECT lp_asset_id, argMax(total_shares_raw, block_height) AS total
        FROM price_data.xyk_lp_total_shares_history
        WHERE lp_asset_id IN {lps:Array(Int32)}
        GROUP BY lp_asset_id`,
    query_params: { lps: lpAssetIds },
    format: 'JSONEachRow',
  })
  for (const row of await res.json<{ lp_asset_id: number; total: string }>()) out.set(Number(row.lp_asset_id), big(row.total))
  return out
}

export async function liquidityPositions(client: ClickHouseClient, parsed: ParsedAddress): Promise<LpPositionsResult> {
  const [snapshot, prices, lpByPool, omni, farmed] = await Promise.all([
    poolSnapshot(client),
    freshPriceMap(client),
    xykLpAssetIds(client),
    omnipoolPositions(client, parsed.accountId),
    xykFarmedShares(client, parsed.accountId),
  ])
  const poolByLp = new Map<number, string>()
  for (const [pool, lp] of lpByPool) poolByLp.set(lp, pool)
  const shareIds = [...snapshot.stableswap.keys(), ...poolByLp.keys()]
  const held = await shareBalances(client, parsed.accountId, shareIds)

  const assembled: Array<{ item: LpPositionItem; usd: bigint | null }> = []

  for (const row of omni) {
    const assetId = Number(row.asset_id)
    const state = snapshot.omnipool.get(assetId)
    const shares = big(row.shares)
    if (!state || shares <= 0n) continue
    const { liquidity, hub } = omnipoolRemoveLiquidity(
      { reserve: state.reserve, hub: state.hubReserve, shares: state.shares },
      { assetId, amount: big(row.amount), shares, priceNum: big(row.price), priceDen: OMNI_FIXED },
    )
    const legs = [{ assetId, amount: liquidity }]
    if (hub > 0n) legs.push({ assetId: HUB_ASSET_ID, amount: hub })
    assembled.push(assemble('omnipool', Number(row.farmed) === 1, String(row.position_id), 'omnipool', null, shares, legs, prices))
  }

  for (const [poolId, pool] of snapshot.stableswap) {
    const shares = held.get(poolId)
    if (!shares) continue
    const amounts = stableswapShareLegs(shares, pool.reserves, pool.totalIssuance)
    const legs = pool.assetIds.map((assetId, i) => ({ assetId, amount: amounts[i] ?? 0n }))
    assembled.push(assemble('stableswap', false, null, String(poolId), String(poolId), shares, legs, prices))
  }

  const xykLps = [...new Set([...poolByLp.keys()].filter(lp => held.has(lp) || farmed.has(lp)))]
  const totals = await xykTotalShares(client, xykLps)
  for (const lp of xykLps) {
    const poolAccount = poolByLp.get(lp)
    const pool = poolAccount ? snapshot.xyk.get(poolAccount) : undefined
    const total = totals.get(lp)
    if (!pool || !poolAccount || !total || total <= 0n) continue
    for (const [shares, isFarmed] of [[held.get(lp) ?? 0n, false], [farmed.get(lp) ?? 0n, true]] as const) {
      if (shares <= 0n) continue
      const { amountA, amountB } = xykShareLegs(shares, pool.reserveA, pool.reserveB, total)
      assembled.push(assemble('xyk', isFarmed, null, poolAccount, String(lp), shares, [{ assetId: pool.assetA, amount: amountA }, { assetId: pool.assetB, amount: amountB }], prices))
    }
  }

  let totalUsd = 0n
  for (const { usd } of assembled) if (usd != null) totalUsd += usd
  // Largest first; unpriced positions last.
  assembled.sort((a, b) => (b.usd ?? -1n) > (a.usd ?? -1n) ? 1 : (b.usd ?? -1n) < (a.usd ?? -1n) ? -1 : 0)
  return { items: assembled.map(a => a.item), asOfBlock: snapshot.blockHeight, totals: { valueUsd: renderUsd(totalUsd) } }
}
