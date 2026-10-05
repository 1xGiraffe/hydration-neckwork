import '../styles/revenueColors.css'
import { lockColor } from './lockColors'
import type { RevenueStream, StakerPot, UserRevenueFlowResponse } from '../types'
import type { RiverLegendItem } from './RevenueFlow'

// ONE colour system for both revenue sides — Protocol Revenue (what the
// protocol earns) and User Revenue (what users earn) — read by both rivers,
// every chart, legend and breakdown table, and the /revenue/users and
// /revenue/protocol pages. No surface picks a revenue colour of its own.
//
//  * A colour means the same SOURCE on both sides. Omnipool trading fees (the
//    protocol's share) and Omnipool LP fees (the LPs' share) are both Omnipool
//    blue, the venue colour /volume uses; Uniswap v3 pool fees and v3 LP fees
//    share one v3 pink; the money market's reserve factor (the protocol's cut
//    of borrow interest) and lending interest (the suppliers' cut of the same
//    interest) share the borrow gold. A stream tied to one asset wears that
//    asset's colour: HOLLAR interest is HOLLAR's own app-wide resolved colour
//    (--rv-hollar, published by useRevenueHollarColor), and so is a user's
//    "HOLLAR interest" (mm_borrow_interest_hollar) on every User Revenue
//    surface — the same interest from the payer's side, under the same name. HSM revenue is the HSM's own venue green (--vol-hsm), a deep shade of
//    the HOLLAR green. Network fees wear the brand primary (--accent).
//  * Sign is not a colour. A user COST (exit fees, borrow interest, staking
//    forfeits) is a deep shade of its source's family, and a marker that
//    stands for a cost is drawn hollow (a ring) whatever its stream.
//  * A stream with no counterpart has a hue nothing else uses: XCM in the
//    cross-chain neutral of its activity badge, ICE in the intent violet, the
//    liquidation pair in vermilion and brick (clear of the brand pink), farms
//    in cyan, token accrual in sky, staking in the stake violets, referrers in
//    a neutral grey.
//
// Validated with the dataviz palette validator (OKLab ΔE×100; Machado 2009
// deuteranopia/protanopia) against both theme surfaces: in the stack orders
// below every adjacent pair keeps ΔE ≥ 19 (protocol) and ≥ 14 (user) under
// normal vision AND both simulations, in both themes. Inside one river the
// closest non-adjacent pairs sit at ΔE 10.6–11.9 (cyan farm vs sky accrual,
// HOLLAR sage vs borrow gold, XCM grey vs Omnipool blue) — different hue
// families, and each river's legend and pill labels name them. Changing a
// value or an order re-opens that check. The per-theme values live in
// styles/revenueColors.css (--rv-*); shared tokens come from global.css.
export const REVENUE_STREAM_COLOR: Record<RevenueStream, string> = {
  omnipool_asset_fee: 'var(--vol-omnipool)',
  // The H2O (hub) protocol fee: Omnipool blue's pale (dark theme) / deep (light) shade.
  omnipool_protocol_fee: 'var(--rv-omnipool-hub)',
  liquidation_penalty: 'var(--rv-liquidation)',
  pepl_liquidation_profit: 'var(--rv-liquidator)',
  asset_reserve: 'var(--cat-borrow)',
  hollar_borrow: 'var(--rv-hollar)',
  hsm_revenue: 'var(--vol-hsm)',
  ice_matched_fee: 'var(--cat-intent)',
  // The protocol's take from the concentrated-liquidity pools (a Gamma vault's fee
  // share to the Treasury; a pool's protocol fee once referendum 403 enables it).
  uniswap_v3_fee: 'var(--rv-uniswap)',
  network_fee: 'var(--accent)',
  xcm_execution_fee: 'var(--cat-xcm)',
}

export const REVENUE_STREAM_LABEL: Record<RevenueStream, string> = {
  omnipool_asset_fee: 'Omnipool trade fees',
  omnipool_protocol_fee: 'H2O protocol fee',
  liquidation_penalty: 'Liquidation penalty',
  pepl_liquidation_profit: 'Liquidator profit',
  // The reserve-factor cut of non-HOLLAR borrow interest (the rest pays suppliers).
  asset_reserve: 'Borrow interest share',
  hollar_borrow: 'HOLLAR interest',
  hsm_revenue: 'HSM revenue',
  // The 200 ppm protocol fee on intent-to-intent matched volume, swept per solution.
  ice_matched_fee: 'ICE matched fee',
  uniswap_v3_fee: 'Uniswap v3 pool fees',
  network_fee: 'Network fees',
  // What the XCM weight trader charged a message (an inbound transfer, a local
  // PolkadotXcm.execute) for its execution here, paid to the treasury.
  xcm_execution_fee: 'XCM execution fees',
}

/**
 * Stacking/legend order, fixed and never cycled: the order the palette was
 * validated in (see above) — reordering it re-opens that check.
 */
export const REVENUE_STREAMS_ORDERED: RevenueStream[] = [
  'network_fee', 'ice_matched_fee', 'asset_reserve', 'omnipool_protocol_fee', 'pepl_liquidation_profit',
  'omnipool_asset_fee', 'liquidation_penalty', 'uniswap_v3_fee', 'hsm_revenue', 'hollar_borrow', 'xcm_execution_fee',
]

// The staker-distribution stack wears the /hdx lock palette (lockColors.ts) —
// the SAME entity keeps the SAME hue on every chart: legacy staking is stake
// violet, the GIGAHDX yield pot wears the GIGAHDX brand black, and voting
// rewards wear vote lavender (they are earned by voting).
export const STAKER_POT_COLOR: Record<StakerPot, string> = {
  staking: lockColor('staking'),
  gigahdx: lockColor('gigahdx'),
  gigarwd: lockColor('vote'),
}

export const STAKER_POT_LABEL: Record<StakerPot, string> = {
  staking: 'Legacy staking',
  gigahdx: 'GIGAHDX yield',
  gigarwd: 'GIGAHDX voting rewards',
}

/** Stacking/legend order: the pots in the order they historically appeared. */
export const STAKER_POTS_ORDERED: StakerPot[] = ['staking', 'gigahdx', 'gigarwd']

// ---- User Revenue (what users earn) ----
// The same system (see the top of this file): each LP-fee stream wears its
// venue's colour, lending the borrow family, staking the stake family; a cost
// is the deep shade of its source's family. Unknown ids fall back to the neutral.
export const USER_REVENUE_STREAM_COLOR: Record<string, string> = {
  lp_fee_omnipool: 'var(--vol-omnipool)',
  lp_fee_stableswap: 'var(--vol-stableswap)',
  lp_fee_xyk: 'var(--vol-xyk)',
  lp_fee_uniswap_v3: 'var(--rv-uniswap)',
  // Cost: exit and imbalance fees an LP pays leaving a pool — the liquidity blue, deep.
  lp_exit_fee: 'var(--rv-lp-cost)',
  farm_rewards: 'var(--rv-farm)',
  mm_supply_interest: 'var(--cat-borrow)',
  // Cost: borrow interest on every asset but HOLLAR — the borrow gold, deep.
  mm_borrow_interest: 'var(--rv-mm-cost)',
  // Cost: borrow interest on HOLLAR (every market) — HOLLAR's own colour, as Protocol Revenue's HOLLAR interest.
  mm_borrow_interest_hollar: REVENUE_STREAM_COLOR.hollar_borrow,
  mm_incentives: 'var(--rv-mm-incentive)',
  token_accrual: 'var(--rv-accrual)',
  token_accrual_catchup: 'var(--rv-accrual-dated)',
  staking_legacy: 'var(--rv-staking)',
  // Cost: staking rewards forfeited — the stake violet, deep.
  staking_forfeit: 'var(--rv-staking-cost)',
  // Black in both themes; ringed on the dark ground, see styles/revenueColors.css.
  gigahdx_yield: 'var(--rv-gigahdx)',
  gigahdx_voting: 'var(--rv-voting)',
  referral_commissions: 'var(--rv-referral)',
}

/** Short names for the river legend (the breakdowns carry the API's full labels). */
export const USER_REVENUE_STREAM_LABEL: Record<string, string> = {
  lp_fee_omnipool: 'Omnipool LP fees',
  lp_fee_stableswap: 'Stableswap LP fees',
  lp_fee_xyk: 'XYK LP fees',
  lp_fee_uniswap_v3: 'Uniswap v3 LP fees',
  lp_exit_fee: 'LP exit fees',
  farm_rewards: 'Farm rewards',
  mm_supply_interest: 'Lending interest',
  mm_borrow_interest: 'Borrow interest',
  mm_borrow_interest_hollar: 'HOLLAR interest',
  mm_incentives: 'Lending incentives',
  token_accrual: 'Token accrual',
  token_accrual_catchup: 'Token accrual, dated back',
  staking_legacy: 'HDX staking',
  staking_forfeit: 'Staking forfeits',
  gigahdx_yield: 'GIGAHDX yield',
  gigahdx_voting: 'GIGAHDX voting',
  referral_commissions: 'Referrer commissions',
}

/**
 * Stacking/legend order of the user streams, fixed: the earned streams in the
 * order the palette was validated in, then the four costs (HOLLAR interest
 * between exit fees and the borrow gold: ΔE ≥ 27 to both neighbours, in both
 * themes and both simulations).
 */
export const USER_REVENUE_STREAMS_ORDERED: string[] = [
  'lp_fee_omnipool', 'mm_incentives', 'lp_fee_uniswap_v3', 'gigahdx_yield', 'staking_legacy', 'lp_fee_xyk',
  'gigahdx_voting', 'referral_commissions', 'token_accrual_catchup', 'lp_fee_stableswap', 'token_accrual',
  'mm_supply_interest', 'farm_rewards',
  'lp_exit_fee', 'mm_borrow_interest_hollar', 'mm_borrow_interest', 'staking_forfeit',
]
const USER_RANK = new Map(USER_REVENUE_STREAMS_ORDERED.map((s, i) => [s, i]))
/** Sort key for user streams: the fixed order, unknown ids last. */
export const userRevenueStreamRank = (stream: string): number => USER_RANK.get(stream) ?? USER_REVENUE_STREAMS_ORDERED.length

/** HOLLAR's registry id: the asset whose own colour HOLLAR interest wears. */
export const HOLLAR_ASSET_ID = 222

/**
 * A user stream's colour. The api serves User Revenue under its DISPLAY streams
 * (api services/userRevenueStreams.ts), so a HOLLAR loan's interest already
 * arrives as `mm_borrow_interest_hollar` everywhere — no surface refines by asset.
 */
export const userRevenueColor = (stream: string): string =>
  USER_REVENUE_STREAM_COLOR[stream] ?? 'var(--chart-neutral)'

/**
 * The legend names every stream that can flow this hour — the drips are exactly what
 * the scheduler emits from, all of them earnings — one entry per display stream, in
 * the palette's order.
 */
export function userRevenueLegendItems(drips: UserRevenueFlowResponse['drips']): RiverLegendItem[] {
  const seen = new Map<string, RiverLegendItem & { rank: number }>()
  for (const d of drips) {
    if (!Number.isFinite(d.usdPerBlock) || d.usdPerBlock <= 0 || seen.has(d.stream)) continue
    seen.set(d.stream, {
      key: d.stream,
      label: USER_REVENUE_STREAM_LABEL[d.stream] ?? d.label.split(' · ')[0],
      color: userRevenueColor(d.stream),
      rank: userRevenueStreamRank(d.stream),
    })
  }
  return [...seen.values()].sort((a, b) => a.rank - b.rank).map(({ key, label, color }) => ({ key, label, color }))
}

