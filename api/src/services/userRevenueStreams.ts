// The ONE definition of User Revenue's streams, holder classes and coverage —
// imported by the derivations job (services/userRevenueFold.ts), and by every
// surface that reads price_data.user_revenue_hourly /
// price_data.account_user_revenue_daily (clickhouse/schema/016_user_revenue.sql).
// A surface never keeps a second copy of the stream list.
//
// User Revenue is what users EARN on Hydration, NET, booked when it ACCRUES —
// the amount the chain's own arithmetic says an account is owed as of now — and
// never when it is claimed (a claim realizes, it reconciles; it is no income).
// A later chain decision that less is owed (a forfeit, a farm termination) is a
// NEGATIVE fact at the deciding block. Trading P&L (price moves, swap P&L,
// impermanent loss) is out, and so are swap/network fees, liquidations,
// collator rewards, grants, vesting, airdrops, LBP fees, bonds and trader
// rebates. Protocol Revenue keeps its own meaning; the two are not additive.

/**
 * The Omnipool's trade events carry their fee amounts from this block on
 * (2023-08-04 11:04:24, the first fee leg); before it the fee is in no event and
 * Omnipool LP fees are unmeasured — stated, never 0.
 */
export const OMNIPOOL_FEE_COVERAGE_FROM_BLOCK = 3_112_604

/** Aave's money markets are covered from the B0 anchor block on (2025-07-04 21:25:42 UTC). */
export const MM_COVERAGE_FROM_BLOCK = 8_200_000

/** The first stableswap and XYK trades (their first fee legs): the venues' LP-fee coverage starts there. */
export const STABLESWAP_FEE_COVERAGE_FROM_BLOCK = 3_640_154
export const XYK_FEE_COVERAGE_FROM_BLOCK = 3_934_664

/**
 * Bumped whenever a stream's definition changes; folded into every bucket's
 * fingerprint, so a rule change re-marks every computed bucket (a definition
 * change moves no ingest time, so nothing else would).
 */
export const USER_REVENUE_RULE_VERSION = 5

export type UserRevenueSign = 'earned' | 'paid' | 'both'

export interface UserRevenueStreamDef {
  id: string
  label: string
  /**
   * The signs a stream's facts can carry: 'earned' ≥ 0, 'paid' ≤ 0, 'both'
   * either. Every stream that can reach its holder through a custody is 'both':
   * the claims rule passes a wrapper's income to its suppliers + and its
   * borrowers −, and a capture can be negative (a token's give-back passed
   * through the Omnipool). Surfaces render each fact by its own sign.
   */
  sign: UserRevenueSign
  /** Figures a later chain event can still move (a farm sync re-marks back to the previous sync; a voting record lands days after its allocation). */
  revisable: boolean
  /** A separate, toggle-able line on the breakdowns (referrer commissions, lead decision). */
  toggle?: boolean
  /** Where the stream's coverage starts, as the surfaces state it. */
  coverage: string
}

export const USER_REVENUE_STREAMS: readonly UserRevenueStreamDef[] = [
  { id: 'lp_fee_omnipool', label: 'Omnipool LP fees', sign: 'both', revisable: false, coverage: `from block ${OMNIPOOL_FEE_COVERAGE_FROM_BLOCK.toLocaleString('en-US')} (2023-08-04), the first trade event carrying its fee amounts; the position captures c(x) of its pro-rata slice` },
  { id: 'lp_fee_stableswap', label: 'Stableswap LP fees', sign: 'both', revisable: false, coverage: `from block ${STABLESWAP_FEE_COVERAGE_FROM_BLOCK.toLocaleString('en-US')} (2023-10-18), the first stableswap trade` },
  { id: 'lp_fee_xyk', label: 'XYK LP fees', sign: 'both', revisable: false, coverage: `from block ${XYK_FEE_COVERAGE_FROM_BLOCK.toLocaleString('en-US')} (2023-11-29), the first XYK trade` },
  { id: 'lp_fee_uniswap_v3', label: 'Uniswap v3 LP fees', sign: 'both', revisable: false, coverage: 'first v3 pool' },
  { id: 'lp_exit_fee', label: 'LP exit and imbalance fees paid', sign: 'paid', revisable: false, coverage: 'chain start; a share bought or sold along a route pays a swap fee (out)' },
  { id: 'farm_rewards', label: 'Liquidity-mining rewards', sign: 'both', revisable: true, coverage: 'chain start; a termination is a negative fact' },
  { id: 'mm_supply_interest', label: 'Lending interest earned', sign: 'both', revisable: false, coverage: `from block ${MM_COVERAGE_FROM_BLOCK.toLocaleString('en-US')} (B0)` },
  { id: 'mm_borrow_interest', label: 'Borrow interest paid', sign: 'paid', revisable: false, coverage: `from block ${MM_COVERAGE_FROM_BLOCK.toLocaleString('en-US')} (B0)` },
  { id: 'mm_incentives', label: 'Lending incentives', sign: 'both', revisable: false, coverage: `from block ${MM_COVERAGE_FROM_BLOCK.toLocaleString('en-US')} (B0)` },
  { id: 'token_accrual', label: 'Yield-bearing token accrual', sign: 'both', revisable: true, coverage: "each token's first peg row; a move's rise is spread over the interval since the previous move; each peg source is judged alone (a source change at a new level is no move); what is not yet decided is stated unmeasured; PRIME before its first peg row (2026-01-27 → 2026-02-19) at its issuer's published NAV (Hastra's Solana vault), anchored to end at that row (via external-rate:hastra-nav)" },
  { id: 'token_accrual_catchup', label: 'Yield-bearing token accrual, dated back', sign: 'both', revisable: true, coverage: 'the catch-up that ends a ≥ 14-day stale peg, spread over the stretch it ends (via catchup-spread)' },
  // Booked GROSS: the payable share depends on the position's action points (its governance votes as the pallet
  // processes them), which no event states and the index does not reconstruct — so it is decided at the claim or
  // exit, where the unpaid part is booked negative (staking_forfeit). An open position's figure overstates its pay.
  { id: 'staking_legacy', label: 'HDX staking rewards (gross, before the payable share is decided)', sign: 'earned', revisable: false, coverage: 'staking launch; booked gross as it accrues — the payable share is decided at the claim or exit, where the unpaid part is booked as forfeited, so an open position\'s figure overstates what it will be paid' },
  { id: 'staking_forfeit', label: 'HDX staking rewards forfeited', sign: 'paid', revisable: false, coverage: 'staking launch' },
  { id: 'gigahdx_yield', label: 'GIGAHDX yield', sign: 'earned', revisable: false, coverage: 'GIGAHDX launch' },
  { id: 'gigahdx_voting', label: 'GIGAHDX voting rewards', sign: 'earned', revisable: true, coverage: 'GIGAHDX launch' },
  { id: 'referral_commissions', label: 'Referrer commissions', sign: 'earned', revisable: false, toggle: true, coverage: 'booked at claim (no per-trade event)' },
] as const

export type UserRevenueStream = (typeof USER_REVENUE_STREAMS)[number]['id']
export const USER_REVENUE_STREAM_IDS: readonly string[] = USER_REVENUE_STREAMS.map(s => s.id)

// ── display streams ─────────────────────────────────────────────────────────────

/** HOLLAR's registry id (revenueStreams.ts HOLLAR_ASSET_ID; restated here so this module stays import-free). */
export const USER_REVENUE_HOLLAR_ASSET_ID = 222
/** The display stream of borrow interest on HOLLAR, in every market (core, GIGAHDX, BIL). */
export const HOLLAR_INTEREST_STREAM = 'mm_borrow_interest_hollar'

/**
 * The streams the explorer's User Revenue surfaces SHOW — the fold's streams
 * with one split taken at READ time, never folded: borrow interest on HOLLAR
 * (asset 222, every market) is "HOLLAR interest" — the payer's side of Protocol
 * Revenue's "HOLLAR interest", under the same name and HOLLAR's colour — apart
 * from "Borrow interest" on every other borrowed asset (the payer's side of
 * "Borrow interest share"). The pair is named without the fold's "paid" suffix,
 * so the two slices of one stream read alike; the fold's own label (the Data
 * API's) keeps "Borrow interest paid".
 * The two partition `mm_borrow_interest` by the fact's own `asset_id`, so they
 * sum to it exactly. The fold, the Data API's `stream` and every total keep
 * `mm_borrow_interest` whole (the Data API states the HOLLAR slice beside it).
 * Every explorer reader maps a fact through userRevenueDisplayStream /
 * userRevenueDisplayStreamSql — one rule, so every surface agrees.
 */
export const USER_REVENUE_DISPLAY_STREAMS: readonly UserRevenueStreamDef[] = USER_REVENUE_STREAMS.flatMap(s => s.id !== 'mm_borrow_interest' ? [s] : [
  { ...s, label: 'HOLLAR interest', id: HOLLAR_INTEREST_STREAM, coverage: `${s.coverage}; borrow interest on HOLLAR in every market` },
  { ...s, label: 'Borrow interest', coverage: `${s.coverage}; every borrowed asset but HOLLAR` },
])

/** A fact's display stream: HOLLAR's borrow interest apart, every other stream as folded. */
export const userRevenueDisplayStream = (stream: string, assetId: number): string =>
  stream === 'mm_borrow_interest' && assetId === USER_REVENUE_HOLLAR_ASSET_ID ? HOLLAR_INTEREST_STREAM : stream

/** The predicate of a HOLLAR-interest fact, over a fact table's columns. */
export const hollarInterestFactSql = (stream = 'stream', asset = 'asset_id'): string =>
  `(${stream} = 'mm_borrow_interest' AND ${asset} = ${USER_REVENUE_HOLLAR_ASSET_ID})`

/** userRevenueDisplayStream in SQL, over a fact table's columns. */
export const userRevenueDisplayStreamSql = (stream = 'stream', asset = 'asset_id'): string =>
  `if(${hollarInterestFactSql(stream, asset)}, '${HOLLAR_INTEREST_STREAM}', ${stream})`

export const HOLDER_CLASSES = ['user', 'protocol', 'unattributed'] as const
export type HolderClass = (typeof HOLDER_CLASSES)[number]

/**
 * Every named cause an unattributed amount (or a pass-through path) carries in
 * `via`. A custody path is `<kind>` or `<kind>:<id>` segments joined by '>' —
 * the leaf stream stays the stream, `via` says how it reached the holder.
 */
export const UNATTRIBUTED_VIA = {
  /** The part of an Omnipool sub-pool's inflow no position's payoff captures (c(x) < 1). */
  omnipoolHubChannel: 'omnipool-hub-channel',
  /** Cumulative-floor dust no holder's integer share took. */
  rounding: 'rounding',
  /** A GIGAHDX referendum allocation whose per-voter records have not landed. */
  votingUnrecorded: 'voting-unrecorded',
  /** A Uniswap v3 pool contract's rebasing aToken interest (owned by no position). */
  v3PoolSurplus: 'v3-pool-surplus',
  /** Another chain's sovereign account (sibl / para): custody, not a user. */
  sovereign: 'sovereign',
  /** A holding whose owner the indexed ownership records do not name (a position or deposit with no owner interval). */
  ownerUnknown: 'owner-unknown',
  /** A money-market reward accrued to a custody (a pool, vault or aToken contract): only its own key could claim it, none of its claimants. */
  incentivesUnclaimable: 'incentives-unclaimable',
  /** A bridge's custody account (Snowbridge, the Wormhole relay pools and forwarder): it holds what users bridged, it is no user. */
  bridgeCustody: 'bridge-custody',
} as const

/** A custody path segment for a custody this fold does not pass through (named, never silently protocol). */
export const custodyRemainderVia = (kind: string): string => `custody:${kind}`

// ── holder classes ─────────────────────────────────────────────────────────────

/** Pallet-account prefix (`modl…`), native and ETH-mapped (`0x45544800` + H160 + padding) forms. */
export const MODL_PREFIX = '0x6d6f646c'
export const MODL_ETH_MAPPED_PREFIX = '0x455448006d6f646c'
/** Sibling (`sibl`) and child (`para`) parachain sovereign accounts, and the relay chain's (`Parent`). */
export const SIBLING_SOVEREIGN_PREFIX = '0x7369626c'
export const PARA_SOVEREIGN_PREFIX = '0x70617261'
export const PARENT_SOVEREIGN_ACCOUNT = '0x506172656e740000000000000000000000000000000000000000000000000000'

/**
 * Tags of ANOTHER chain's treasury: its positions here are that treasury's own
 * investments (the Polkadot treasury's DOT in the Omnipool and money market,
 * held by the relay's `Parent` sovereign; Moonbeam's treasury through its
 * sibling sovereign) — an outside holder earning on Hydration, so `user`, ahead
 * of the sovereign-prefix rule. Hydration's own treasury is PROTOCOL_HOLDER_TAGS.
 */
export const FOREIGN_TREASURY_TAGS = ['polkadot-treasury', 'moonbeam-treasury'] as const
/** Tags of bridge custody accounts: what they hold is users' bridged funds in transit — unattributed (bridge-custody), never a user. */
export const BRIDGE_CUSTODY_TAGS = ['snowbridge', 'moonbeam-wormhole'] as const

/**
 * Tags whose members are the protocol's own balance sheet: the internal-payer
 * tags (revenueStreams.ts INTERNAL_PAYER_TAGS) plus the HSM. Read from
 * account_tags in both id forms.
 */
export const PROTOCOL_HOLDER_TAGS = [
  'treasury', 'hydration-multisig', 'pallet-pots', 'staking-pot', 'incentive-pot',
  'gigahdx-pots', 'fee-processor', 'fee-referrals', 'fee-staking-rewards', 'hollar-stability-module',
] as const

/** The Aave collector (reserve-factor accrual) and the PEPL/HSM EVM executor, ETH-mapped. */
export const PROTOCOL_FIXED_ACCOUNTS = [
  '0x45544800e52567ff06acd6cbe7ba94dc777a3126e180b6d90000000000000000',
  '0x45544800000000000000000000000000000000000000090a0000000000000000',
] as const

/** The tag-driven member sets the holder class reads, each in both id forms, lowercased. */
export interface HolderSets {
  /** PROTOCOL_HOLDER_TAGS members. */
  protocol: ReadonlySet<string>
  /** FOREIGN_TREASURY_TAGS members: user, whatever their prefix. */
  user?: ReadonlySet<string>
  /** BRIDGE_CUSTODY_TAGS members: unattributed (bridge-custody). */
  custody?: ReadonlySet<string>
}

const isSovereign = (a: string): boolean =>
  a.startsWith(SIBLING_SOVEREIGN_PREFIX) || a.startsWith(PARA_SOVEREIGN_PREFIX) || a === PARENT_SOVEREIGN_ACCOUNT

/**
 * The holder class of an account AFTER custody resolution (pool, vault, farm and
 * aToken custodies pass what they earn to their claimants first; only what
 * remains on a pallet account is the protocol's). Order: another chain's
 * treasury (tagged) is a user; a bridge custody (tagged) and an untagged
 * sovereign — sibling, child or the relay's Parent — are unattributed custody;
 * pallet accounts and tagged protocol members are the protocol's; everyone else
 * is a user. A bare set is the protocol set alone.
 */
export function holderClassOf(account: string, sets: ReadonlySet<string> | HolderSets): HolderClass {
  const s: HolderSets = sets instanceof Set ? { protocol: sets } : (sets as HolderSets)
  const a = account.toLowerCase()
  if (a === '') return 'unattributed'
  if (s.user?.has(a)) return 'user'
  if (s.custody?.has(a)) return 'unattributed'
  if (isSovereign(a)) return 'unattributed'
  if (a.startsWith(MODL_PREFIX) || a.startsWith(MODL_ETH_MAPPED_PREFIX)) return 'protocol'
  if (s.protocol.has(a) || (PROTOCOL_FIXED_ACCOUNTS as readonly string[]).includes(a)) return 'protocol'
  return 'user'
}

/** The named cause an unattributed DIRECT holder carries: no owner, a bridge's custody, or another chain's sovereign. */
export function unattributedHolderVia(account: string, sets: ReadonlySet<string> | HolderSets): string {
  const a = account.toLowerCase()
  if (a === '') return UNATTRIBUTED_VIA.ownerUnknown
  const s: HolderSets = sets instanceof Set ? { protocol: sets } : (sets as HolderSets)
  return s.custody?.has(a) ? UNATTRIBUTED_VIA.bridgeCustody : UNATTRIBUTED_VIA.sovereign
}

/** An H160 (0x + 40 hex) as the runtime's ETH-mapped substrate account form — the account_revenue convention. */
export const ethMappedAccount = (h160: string): string => `0x45544800${h160.toLowerCase().slice(2)}0000000000000000`

/** The H160 a 32-byte account is seen under on the EVM side (its first 20 bytes; the embedded H160 for an ETH-mapped one). */
export function h160Of(account: string): string {
  const a = account.toLowerCase()
  if (a.startsWith('0x45544800') && a.endsWith('0000000000000000')) return `0x${a.slice(10, 50)}`
  return a.slice(0, 42)
}

/**
 * What User Revenue does NOT measure, as every surface states it beside a total
 * ("unmeasured", never a silent 0): income that exists on chain but has no
 * indexed rate or amount the fold could book. A surface lists these with the
 * totals; the fold's own unpriced cells (a fact it booked but could not value)
 * are counted separately per stream.
 */
export interface UserRevenueUnmeasured {
  id: string
  label: string
  reason: string
  /**
   * 'era' — a whole era no source states (always listed); 'token' — a token's
   * accrual with no measurable rate, which the fold states itself as
   * zero-amount `unmeasured:<reason>` marker rows per (hour, token): a surface
   * lists these from those rows, and these static entries only until the fold
   * has written any.
   */
  scope: 'era' | 'token'
}
export const USER_REVENUE_UNMEASURED: readonly UserRevenueUnmeasured[] = [
  { id: 'omnipool-fees-before-fee-events', scope: 'era', label: 'Omnipool LP fees before 2023-08-04', reason: `trade events carry no fee amounts before block ${OMNIPOOL_FEE_COVERAGE_FROM_BLOCK.toLocaleString('en-US')}` },
  { id: 'money-market-before-b0', scope: 'era', label: 'Money-market interest and incentives before 2025-07-04', reason: `no aToken or debt balance is stated before the B0 anchor block ${MM_COVERAGE_FROM_BLOCK.toLocaleString('en-US')}; a Hydrated pool share's lending income before it is booked unattributed (mm-before-b0)` },
  { id: 'apyusd-accrual', scope: 'token', label: 'apyUSD token accrual', reason: 'its on-chain peg never moved (a static governance push), so no rate is measurable' },
  { id: 'unrated-accruing-tokens', scope: 'token', label: 'vASTR, LDOT, LBTC and sUSDat accrual', reason: 'no on-chain redemption rate is indexed for these tokens' },
  { id: 'stale-peg-stretches', scope: 'token', label: 'Token accrual not yet decided', reason: 'after a peg\'s last decided move the accrual is unmeasured until the next move states it; a catch-up after a stale stretch is then spread over that stretch' },
] as const
