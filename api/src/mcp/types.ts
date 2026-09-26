/**
 * Wire shapes of the explorer api, as this MCP server consumes them.
 *
 * These are HAND-WRITTEN mirrors of `api/src/services/explorerService.ts` and
 * `explorer-ui/src/types.ts` — nothing generates them, and nothing imports the
 * explorer's own declarations (the `src/mcp/` tree is a pure HTTP client, so it
 * may not reach into the service layer). The contract they encode is the set of
 * recorded live responses the design was derived from: when a field here and a
 * sample disagree, the sample wins and this file is wrong.
 *
 * Two rules keep the drift honest:
 *  - anything a sample showed as sometimes-absent is optional here;
 *  - anything large or unverified is `unknown` with a note, never a guessed
 *    field name. A wrong name reads as data and silently renders nothing.
 *
 * Units, uniformly (catalogue § 0):
 *  - token amounts are RAW integer decimal strings, scaled by the row's own
 *    `AssetRef.decimals` — never by a global assumption;
 *  - `*Usd` fields are JS numbers, `null` when unpriced;
 *  - timestamps are ClickHouse UTC strings `"YYYY-MM-DD HH:MM:SS"` with no zone
 *    marker, except where a field is documented as unix seconds;
 *  - money-market `*Base` figures are 1e8-scaled decimal strings, and `'inf'`
 *    is a real value there (it means "no debt").
 */

/* ============ assets and accounts ============ */

/** Where a foreign asset's metadata and artwork live. */
export interface AssetOrigin {
  ecosystem: string
  chainId: string
  assetId: string | null
}

/**
 * The asset every amount is denominated in. A CROSS-CHAIN DESTINATION carries a
 * NEGATIVE sentinel `assetId` (-1, -2, …): it is not a registry asset and that
 * number is not routable. Route such a row by its `xcDestination.platform`.
 */
export interface AssetRef {
  assetId: number
  iconAssetId?: number
  /** Member assets of a pool SHARE token. Present only on pool shares. */
  iconAssetIds?: number[]
  symbol: string
  name?: string | null
  decimals: number
  parachainId?: number | null
  origin?: AssetOrigin | null
}

export interface TagRef {
  id: string
  name: string
  color: string
  icon: string
  memberCount?: number
}

/** On-chain `Identity.IdentityOf` plus whether a registrar judged it. */
export interface AccountIdentity {
  display: string
  verified: boolean
  email?: string
  web?: string
  twitter?: string
}

/** A wallet-login profile the account owner set themselves. */
export interface ProfileRef { name: string; avatarVersion?: number }

/**
 * An account as every feed carries it. `address` is the POLKADOT-format SS58 or
 * the EVM H160 — not the Hydration (prefix 63) SS58, which only
 * `AddressDetail.ss58` carries. `accountId` is the raw AccountId32 public key
 * and is the key to dedupe on, never a label (AGENTS.md § Explorer semantics:
 * display canonical SS58 or H160, never raw public-key hex).
 */
export interface AccountRef {
  accountId: string
  address: string
  emoji?: string
  emojiName?: string
  emojiUrl?: string
  tag?: TagRef | null
  identity?: AccountIdentity | null
  profile?: ProfileRef | null
  isContract?: boolean
  contractName?: string
  /** Set on a cross-chain counterparty: its page on the destination's explorer. */
  subscanUrl?: string | null
}

/**
 * A cross-chain transfer's far end. `accountId` is the canonical id to key on —
 * for an AccountKey20 destination `raw`/`address` may be a bare H160.
 */
export interface XcmAccountRef extends AccountRef {
  kind?: 'AccountId32' | 'AccountKey20'
  raw?: string
}

/* ============ chain head and lists ============ */

export interface ExplorerStats {
  headBlock: number
  finalizedBlock: number
  headTime: string
  /** The MEASURED pace; it moves with elastic scaling. */
  avgBlockSec: number
  /** The runtime's NOMINAL slot time — the rate every block-count constant is stated at. */
  nominalBlockSec: number
  transfers24h: number
  extrinsics24h: number
  activeAccounts24h: number
  hdxPrice: number | null
}

export interface ExplorerCounts {
  blocks: number
  extrinsics: number
  events: number
  transfers: number
  contracts: number
  /** How deep the SQL-paged lists can be walked; past it the route 400s. */
  maxOffset: number
}

export interface BlockSummary {
  /** false = served from the pending-head layer (may reorg, `author` is null). Absent = finalized. */
  finalized?: boolean
  height: number
  timestamp: string
  hash: string
  author: AccountRef | null
  specVersion: number
  extrinsicCount: number
  eventCount: number
}

export interface BlockEventRow {
  eventIndex: number
  extrinsicIndex: number | null
  name: string
  /** Decoded event arguments. Shape is per-event; the tools render it as JSON. */
  args?: unknown
  /** Verified-ABI decode of an EVM log. Shape not mirrored here. */
  evmDecoded?: unknown
}

export interface BlockDetail extends BlockSummary {
  parentHash: string
  stateRoot: string | null
  extrinsicsRoot: string | null
  extrinsics: ExtrinsicSummary[]
  /** Capped at 400 per block; compare `eventsShown` with `eventCount`. */
  events: BlockEventRow[]
  eventsShown?: number
}

export interface FailureReason { label: string; docs: string | null }

export interface ExtrinsicOrigin {
  kind: 'proxy' | 'multisig'
  state?: 'pending' | 'executed' | 'cancelled'
  threshold?: number
  signatories?: number
  approvals?: number
  callHash?: string
  initiator?: AccountRef
  timeline?: {
    account: AccountRef
    action: 'initiated' | 'approved' | 'executed' | 'cancelled'
    timestamp: string
    extrinsicId: string
  }[]
}

export interface ExtrinsicSummary {
  /** false = unfinalized (pending-head layer). Absent = finalized. */
  finalized?: boolean
  /** true = still in the transaction pool: `blockHeight`/`index` are 0 placeholders and the outcome is a dry-run PROJECTION. */
  mempool?: boolean
  projected?: 'ok' | 'fail' | 'unknown'
  includability?: 'includable' | 'queued' | 'rejected' | 'unknown'
  unincludableReason?: string | null
  replacedBy?: string
  blockHeight: number
  index: number
  hash: string
  timestamp: string
  signer: AccountRef | null
  success: boolean
  callName: string
  /** Raw HDX planck, or null when the chain charged nothing. */
  fee: string | null
  origin?: ExtrinsicOrigin
  errorReason?: FailureReason | null
}

/** The fee as actually paid, when the signer's fee currency is not HDX. */
export interface FeePayment {
  asset: AssetRef
  amount: string
  tipAmount: string | null
}

export interface ExtrinsicEventRow {
  eventIndex: number
  name: string
  args?: unknown
  decoded?: boolean
  evmDecoded?: unknown
}

export interface ExtrinsicDetail extends ExtrinsicSummary {
  version: number
  tip: string | null
  feePayment?: FeePayment
  /** Decoded call arguments; per-call shape, rendered as JSON. */
  callArgs?: unknown
  error?: unknown
  errorReason: FailureReason | null
  events: ExtrinsicEventRow[]
  /** Verified-ABI decodes of the extrinsic's EVM calls. Shape not mirrored. */
  evmCalls?: unknown[]
  /** Present only on `Ethereum.transact`. */
  evmTx?: { txHash: string; exitKind: string; exitDetail: string | null; extraData: string | null }
  /** Present only on `ICE.submit_solution`; large, and rendered by the tool that asks for it. */
  iceSolution?: unknown
}

export interface EventRow {
  finalized?: boolean
  /** true = a dry-run PROJECTION of what a pool transaction would emit. */
  mempool?: boolean
  hash?: string
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  name: string
  args?: unknown
  decoded?: boolean
  evmDecoded?: unknown
}

export interface EventDetail extends EventRow {
  /** `ApplyExtrinsic(n)` or `Finalization`. */
  phase: string
  extrinsic: ExtrinsicSummary | null
}

/* ============ activity ============ */

/** Protocol revenue the activity's EXTRINSIC generated. */
export interface ActivityRevenue {
  protocolUsd: number
  lpUsd: number
  streams: { stream: string; usd: number }[]
}

/** What an outbound cross-chain send cost besides its payload. */
export interface XcmFeeLeg {
  kind: 'delivery' | 'relayer'
  asset: AssetRef
  amount: string
  valueUsd: number | null
  settlement?: 'source' | 'destination'
  purchase?: { asset: AssetRef; amount: string; valueUsd: number | null } | null
}

/** The value a row's own `type` field can take (12 values — `dca` rows arrive typed `trade`). */
export type ActivityRowType =
  | 'transfer' | 'trade' | 'xcm' | 'liquidity' | 'mm' | 'dca'
  | 'staking' | 'vote' | 'otc' | 'bond' | 'intent' | 'xcswap'

/**
 * One classified economic action — the explorer's highest-level reading of what
 * a user did, with the plumbing legs suppressed. Every per-family extra below is
 * optional because a row only carries its own family's fields.
 */
export interface ActivityRow {
  type: ActivityRowType
  /** Absent when the revenue model has not booked the block yet — NOT "earned nothing". */
  revenue?: ActivityRevenue
  /** false = unfinalized (may reorg away). Absent = finalized. */
  finalized?: boolean
  /** true = still in the transaction pool; `blockHeight`/indices are 0 placeholders. */
  mempool?: boolean
  /** A mempool row's identity while it has no block coordinates. */
  hash?: string
  blockHeight: number
  timestamp: string
  eventIndex?: number | null
  extrinsicIndex: number | null
  who: AccountRef | null
  to: AccountRef | null
  /** Single-asset families (transfer, liquidity, mm, staking, vote, bond). */
  asset: AssetRef | null
  /** Two-leg families (trade, otc, intent, xcswap). */
  assetIn: AssetRef | null
  assetOut: AssetRef | null
  amount: string | null
  amountIn: string | null
  amountOut: string | null
  valueUsd: number | null
  /** Every asset the source event touched — what a `token` filter matches against. */
  assetRefs?: number[]

  /** Where the row's own detail page lives. Null → the row links to its block. */
  linkBlock?: number | null
  linkIndex?: number | null

  // trade / DCA
  dca?: boolean
  dcaScheduleId?: number
  /** `'failed'` or absent; some feeds send an explicit `null` for "not failed". */
  dcaStatus?: 'failed' | null
  dcaError?: string

  // xcm
  xcmDir?: 'in' | 'out'
  xcmFees?: XcmFeeLeg[]
  xcmExecuted?: boolean
  xcmLegIndex?: number
  destChain?: string
  destParachainId?: number | null
  destAccount?: XcmAccountRef
  fromChain?: string
  fromParachainId?: number | null
  fromAccount?: XcmAccountRef
  messageId?: string | null
  fromTxUrl?: string | null
  destTxUrl?: string | null
  /** 'Snowbridge' | 'Wormhole' | 'Basejump' — how it crossed, when not plain XCM. */
  bridge?: string | null

  // money market
  mmAction?: string
  mmMarketKey?: string
  mmMarket?: string

  // staking
  stakingAction?: string

  // bonds — `asset`/`amount` are the BOND token, `bondFee` is in the underlying
  bondAction?: 'Issue' | 'Redeem'
  bondFee?: string | null
  bondUnderlying?: AssetRef | null

  // governance votes
  votePallet?: string
  voteRefPallet?: 'opengov' | 'democracy' | null
  voteRefTitle?: string | null
  voteAction?: string
  voteRef?: string | null
  voteSide?: string
  voteConviction?: string | null

  // liquidity
  liqAction?: 'Add' | 'Remove' | 'Create' | 'Claim' | 'ClaimReferral' | 'Destroy' | 'CollectFees' | 'Rebalance'
  poolAddress?: string
  v3TokenId?: string
  v3Vault?: string

  // OTC — cancellation is called Pull in product copy
  otcAction?: 'Place' | 'Pull' | 'Fill'
  otcOrderId?: number
  otcPartial?: boolean
  otcPartiallyFillable?: boolean
  otcFee?: string

  // ICE intents — `intentId` is a u128 decimal string, `intentSeq` its low 64 bits
  intentId?: string
  intentSeq?: number
  intentKind?: 'swap' | 'dca'
  intentAction?: 'Place' | 'Fill' | 'PartialFill' | 'DcaTrade' | 'Cancel' | 'Expire'
  intentPartial?: boolean
  intentDeadline?: string | null
  intentRemainingBudget?: string | null
  intentMigratedFrom?: number | null
  intentForward?: string | null

  // cross-chain swap out through NEAR Intents — the destination is not a
  // registry asset, so it travels as its own fields, never as `assetOut`
  xcswapDepositAddress?: string
  xcswapSequence?: number
  xcswapEthOut?: string
  xcswapMaxRelayFee?: string
  xcswapStatus?: 'KNOWN_DEPOSIT_TX' | 'PENDING_DEPOSIT' | 'INCOMPLETE_DEPOSIT' | 'PROCESSING' | 'SUCCESS' | 'REFUNDED' | 'FAILED' | null
  xcswapDestAsset?: string | null
  xcswapDestSymbol?: string | null
  xcswapDestChain?: string | null
  xcswapDestOrigin?: AssetOrigin | null
  xcswapDestDecimals?: number | null
  xcswapDestAmount?: string | null
  xcswapDestAmountUsd?: number | null
  /** In the DESTINATION chain's own address format (a NEAR account name, a Zcash address). */
  xcswapRecipient?: string | null
  xcswapDestTxHash?: string | null
  xcswapRefundReason?: string | null
}

/** What `/explorer/activity/count` answers. `total` is non-null only for `type=vote`. */
export interface ActivityCount {
  total: number | null
  complete: boolean
  maxOffset: number
}

/* ============ search ============ */

export interface SearchResult {
  type: 'block' | 'extrinsic' | 'address' | 'asset' | 'tag' | 'referendum' | 'pool' | 'xcDestination'
  /**
   * The identifier the hit resolves to — a height, a hash, an accountId, an
   * asset id, a tagId, a pool id or an xc-destination platform slug. For a
   * `referendum` hit it is the title key `"<pallet>:<index>"` and NOT a URL
   * segment: build that route from `pallet` + `index`.
   */
  value: string
  label?: string
  desc?: string
  asset?: AssetRef
  emoji?: string
  emojiName?: string
  emojiUrl?: string
  identity?: AccountIdentity | null
  icon?: string
  color?: string
  pallet?: 'opengov' | 'democracy'
  index?: number
  status?: string
  poolKind?: 'omnipool' | 'stableswap' | 'xyk' | 'uniswapv3'
  tvlUsd?: number | null
}

/* ============ accounts ============ */

export interface BalanceLockTranche {
  state: 'releasable' | 'scheduled' | 'active'
  amount: string
  until?: string
  linear?: boolean
}
export interface BalanceLockComponent {
  kind: 'lock' | 'reserve' | 'hold' | 'deposit'
  source: string
  amount: string
  claimable?: string
  tranches?: BalanceLockTranche[]
}
export interface BalanceUnlockSlice {
  state: 'releasable' | 'scheduled' | 'active'
  cause: string
  amount: string
  until?: string
  linear?: boolean
  conditional?: boolean
}

/**
 * One asset's balance. `frozen`, `breakdown` and `timeline` come from the
 * background lock snapshot and are omitted under `summary=1`. `uncounted` is
 * the part of `total` the explorer deliberately values at nothing — the
 * Omnipool's own H2O reserve, priced off the pooled assets the value already
 * counts — so `valueUsd` covers only the rest.
 */
export interface AddressBalance {
  asset: AssetRef
  total: string
  free: string
  reserved: string
  frozen?: string
  breakdown?: BalanceLockComponent[]
  timeline?: BalanceUnlockSlice[]
  lastBlock: number
  valueUsd: number | null
  uncounted?: { amount: string; reason: 'pool-hub-reserve' }
}

/** One reserve of a money-market position. Amounts are raw units of that reserve. */
export interface MmReserve {
  assetId: number
  iconAssetId?: number
  iconAssetIds?: number[]
  symbol: string
  decimals: number
  parachainId?: number | null
  origin?: AssetOrigin | null
  supplied: string
  debt: string
  suppliedUsd: number | null
  debtUsd: number | null
  collateral: boolean
  marketKey?: string
}

/**
 * One ISOLATED market's position. The markets never blend — a health factor
 * belongs to exactly one of them, and the set of them (`core`, `gigahdx` and
 * `bil` today) grows, so the rule is per market rather than a list. Every
 * `*Base` figure is a 1e8-scaled decimal string, and `healthFactor` is `'inf'`
 * when there is no debt. Risk math uses `totalCollateralBase`, not
 * `totalSuppliedBase`.
 */
export interface MoneyMarketPosition {
  marketKey: string
  market: string
  role: 'primary' | 'supplemental'
  defiSimSupported: boolean
  stakingBacked?: boolean
  blockHeight: number
  timestamp: string
  totalCollateralBase: string
  totalSuppliedBase?: string
  totalDebtBase: string
  availableBorrowsBase: string
  liquidationThreshold: string
  ltv: string
  healthFactor: string
  simAccount?: string
  reserves?: MmReserve[]
  /** Claimable incentives accruing on this market's aTokens (display; counted once, via AddressDetail.moneyMarketRewards). */
  unclaimedRewards?: MoneyMarketRewardItem[]
}

/** One (holder, reward asset) claimable money-market incentive: the chain's own getAllUserRewards. */
export interface MoneyMarketRewardItem {
  marketKey: string
  holder: string
  asset: AssetRef
  /** Raw integer in the reward asset's decimals: what one claimAllRewards would pay now. */
  claimable: string
  claimableUsd: number | null
  /** Whether the indexed log arithmetic reproduces the chain's amount (false: a gap; the history cannot state it). */
  reconciled: boolean
  /** 0 < claimable < the reward asset's existential deposit: claimAllRewards including it reverts until the account holds that deposit. Owed, not forfeited. */
  belowExistentialDeposit: boolean
  legs: Array<{ aToken: AssetRef | null; aTokenAddress: string; pending: string }>
}

/**
 * The account's claimable money-market incentives. `totalUsd` (priced items only)
 * IS inside `portfolioUsd`; absent when nothing is claimable or no fresh snapshot.
 */
export interface MoneyMarketRewards { asOfBlock: number; items: MoneyMarketRewardItem[]; totalUsd: number }

/** A concentrated-liquidity position holds two tokens: `asset`/`amount` is token0. */
export interface LpPosition {
  positionId: string
  asset: AssetRef
  amount: string
  hubAmount?: string
  shares: string
  valueUsd: number | null
  venue: string
  assetB?: AssetRef
  amountB?: string
  poolAddress?: string
  tokenId?: string
  /**
   * Farmed rows only: the claimable-now rewards of the farm entries behind the
   * position. Beside `valueUsd`, never in it — though the account's
   * `portfolioUsd` does count them (see AddressDetail.farmRewards).
   */
  unclaimedRewards?: LpUnclaimedReward[]
}

export interface LpUnclaimedReward {
  depositId: string
  globalFarmId: number
  yieldFarmId: number
  asset: AssetRef
  amount: string
  valueUsd: number | null
  projected: boolean
  belowExistentialDeposit?: boolean
  /** false: below the existential deposit with the owner holding less — a claim pays nothing, so `valueUsd` is 0. */
  payable?: boolean
}

/** One farm entry (deposit, yield farm) of the account's liquidity-mining deposits. */
export interface FarmRewardItem {
  depositId: string
  positionId: string | null
  globalFarmId: number
  yieldFarmId: number
  venue: 'Omnipool Farm' | 'XYK Farm'
  farmState: 'active' | 'stopped' | 'terminated'
  asset: AssetRef
  /** Raw integer in the reward asset's decimals: what one claim would pay now. */
  claimable: string
  claimableUsd: number | null
  forfeitIfWithdrawnNow: string
  /** false: an active farm whose runtime projection failed; the amount is as of its last sync (a lower bound). */
  projected: boolean
  belowExistentialDeposit: boolean
  /** false: below the existential deposit with the owner holding less — a claim pays nothing, so `claimableUsd` is 0 and it is not counted. */
  payable?: boolean
  loyaltyPct: number
  lastSyncPeriod: number
}

/**
 * The account's unclaimed liquidity-mining rewards. `totalUsd` (priced entries
 * only) IS inside `portfolioUsd`; absent when there is no farm entry or no fresh
 * snapshot (and then no reward is in the value either).
 */
export interface FarmRewards { asOfBlock: number; items: FarmRewardItem[]; totalUsd: number }

export interface ActiveDca {
  /** A schedule id, or a DCA intent's short "#n" handle — `intentId` decides which. */
  id: number
  intentId?: string
  assetIn: AssetRef
  assetOut: AssetRef
  direction: string
  amountPerTrade: string
  totalAmount: string
  filledAmount: string
  remainingAmount: string | null
  executionsDone: number
  /** A BLOCK count. Turn it into a duration with `nominalBlockSec`, or prefer `periodSeconds`. */
  period: number
  /** Seconds actually observed between trades; null before the second trade. */
  periodSeconds: number | null
  nextExecutionBlock: number | null
  valueUsd: number | null
  budgetUsd: number | null
  fundingBalance: string | null
  fundingUsd?: number | null
  scheduleBlock?: number
  scheduleIndex?: number | null
  who?: AccountRef
}

export interface OpenLimitOrder {
  intentId: string
  seq: number
  who: AccountRef
  assetIn: AssetRef
  assetOut: AssetRef
  amountIn: string
  amountOut: string
  filledIn: string
  filledOut: string
  remainingIn: string
  remainingOut: string
  fills: number
  partial: boolean
  /** assetOut units per one assetIn unit, on the amounts as placed. */
  limitPrice: number | null
  valueUsd: number | null
  placedBlock: number
  placedIndex: number | null
  timestamp: string
  deadline: string | null
}

export interface AddressAlias {
  accountId: string | null
  evmAddress: string | null
  primaryProfile: string
  relationship: string
  confidence: number
}

export interface ProxyRelation { account: AccountRef; proxyType: string; delay: number }
export interface AccountProxyInfo {
  isPure: { creator: AccountRef; proxyType: string; blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
  delegates: ProxyRelation[]
  delegatorOf: ProxyRelation[]
}
export interface PendingMultisigOp { callHash: string; depositor: AccountRef; approvals: AccountRef[]; sinceBlock: number }
export interface MultisigInfo { threshold: number; signatories: AccountRef[]; pending: PendingMultisigOp[] }
export interface MultisigMembership { account: AccountRef; threshold: number; signatories: number }

/**
 * One account's whole interpreted record. Every section below is scoped to the
 * account's RELATED SET (`relatedAccountIds`), not to the queried id alone.
 * Under `summary=1` the key shape is identical: the omitted sections come back
 * empty or null rather than missing.
 */
export interface AddressDetail {
  input: string
  kind: string
  accountId: string
  emoji?: string
  emojiName?: string
  emojiUrl?: string
  evmAddress: string | null
  /** Hydration SS58 (prefix 63). */
  ss58: string
  ss58Polkadot: string
  tag: TagRef | null
  identity: AccountIdentity | null
  profile?: ProfileRef | null
  relatedAccountIds: string[]
  aliases: AddressAlias[]
  balances: AddressBalance[]
  topAssets: { asset: AssetRef; valueUsd: number }[]
  portfolioUsd: number
  /** Present only for holders whose own token dominates the balance sheet. */
  portfolioExHdxUsd?: number
  tradingVolumeUsd?: number
  liquidationVolumeUsd?: number
  revenueUsd?: number
  moneyMarket: MoneyMarketPosition[]
  liquidityPositions?: LpPosition[]
  farmRewards?: FarmRewards
  moneyMarketRewards?: MoneyMarketRewards
  activeDcas?: ActiveDca[]
  openLimitOrders?: OpenLimitOrder[]
  /** null under `summary=1` — these are live node reads. */
  proxy?: AccountProxyInfo | null
  multisig?: MultisigInfo | null
  multisigMemberships?: MultisigMembership[]
  /** Present only for a deployed EVM contract. Large; not mirrored field by field. */
  contract?: unknown
  portfolioSeries?: number[]
  portfolioSeriesExHdx?: number[]
  portfolioDates?: string[]
  balanceHistory?: unknown[]
}

export interface TopAccountRow {
  account: AccountRef | null
  /** Set instead of `account` on a group row folding many accounts under a system tag. */
  tag: { tagId: string; name: string; color: string; icon: string; memberCount: number } | null
  portfolioUsd: number
  lastBlock: number
  suppliedUsd: number | null
  borrowedUsd: number | null
  healthFactor?: string | null
  identity?: string | null
  simAccount?: string | null
  supplementalMarket?: { marketKey: string; market: string; borrowedUsd: number; healthFactor?: string | null } | null
  sparkline?: number[]
  /** ABSENT means "not established", never 0. */
  activityCount?: number
  activityCountComplete?: boolean
  tradingVolumeUsd?: number
  liquidationVolumeUsd?: number
  revenueUsd?: number
  topAssets?: { asset: AssetRef; valueUsd: number }[]
  otherAssets?: number
}

export interface AccountsPage {
  rows: TopAccountRow[]
  total: number
  /** How many leading rows are provably ordered; absent = the whole ordering is. */
  rankedDepth?: number
}

export interface TabCounts {
  extrinsics: number
  extrinsicsOnBehalf: number
  events: number
  votes: number
}

/** `complete: false` = exact for the newest rows only; the list runs deeper. */
export interface ScopedListTotal { total: number | null; complete: boolean }

export interface AccountHistory {
  portfolioSeries: number[]
  portfolioSeriesExHdx?: number[]
  portfolioDates: string[]
  portfolioBlocks?: number[]
  /** Per-asset reconstructions; large, and rendered by the tool that asks for it. */
  balanceHistory: unknown[]
}

/**
 * `/explorer/address/:a/liquidity-history`: every LP position the account's
 * related set held, per bucket of the value chart's grid, stated as the legs a
 * redemption would have returned at the pool state sampled at or before the
 * bucket end and valued at the candle fully closed by then. USD is null (never
 * zero) where a leg has no price.
 */
export interface LiquidityHistoryLeg { asset: AssetRef; amount: string; valueUsd: number | null }
export interface LiquidityHistorySpan { fromBlock: number; fromTime: string | null; toBlock: number | null; toTime: string | null; kind: 'direct' | 'farmed' }
export interface LiquidityHistoryPosition {
  venue: 'omnipool' | 'stableswap' | 'xyk' | 'uniswapv3' | 'gamma'
  /** How the position was held at its last held bucket; `spans` carry every flip. */
  farmed: boolean
  positionId: string | null
  poolKey: string
  shareAsset: AssetRef | null
  spans: LiquidityHistorySpan[]
  /** `i` indexes the shared dates/blocks arrays; only the buckets where the position was held. */
  points: Array<{ i: number; shares: string; legs: LiquidityHistoryLeg[]; valueUsd: number | null; unclaimedRewards?: Array<{ asset: AssetRef; amount: string; valueUsd: number | null }> }>
}
export interface LiquidityHistory {
  stepSec: number
  priceGrain: '1h' | '1d'
  dates: string[]
  blocks: number[]
  /** Sum of every priced position per bucket. */
  valueUsd: number[]
  /** Positions held at the bucket end that are left out of valueUsd for want of a price or a pool state. */
  unpriced: number[]
  /** Priced unclaimed farm rewards of every entry held at the bucket end (settled); NOT in valueUsd. */
  unclaimedRewardsUsd?: number[]
  /** Farm entries held at the bucket end left out of unclaimedRewardsUsd (not stated, or unpriced). */
  rewardsIncomplete?: number[]
  /** Largest last-held value first, unpriced last; capped upstream. */
  positions: LiquidityHistoryPosition[]
  positionsOmitted: number
}

/**
 * `/explorer/address/:address/money-market-history` — per isolated market, the
 * account's reserves at each bucket end (balanceOf at that block, valued at the
 * closed candle; null before `reserveHistoryFrom`, never zero) beside the chain's own
 * getUserAccountData observation as of its block at or before the end.
 */
export interface MoneyMarketHistoryObservation {
  observedAtBlock: number
  timestamp: string | null
  healthFactor: string
  totalCollateralBase: string
  totalDebtBase: string
  availableBorrowsBase: string
  ltv: string
  liquidationThreshold: string
}
export interface MoneyMarketHistoryReserve {
  asset: AssetRef
  aToken: AssetRef | null
  reserveAddress: string
  points: Array<{ i: number; supplied: string; borrowed: string; suppliedUsd: number | null; borrowedUsd: number | null; collateral: boolean | null }>
}
export interface MoneyMarketHistoryMarket {
  marketKey: string
  market: string
  poolAddress: string
  role: 'primary' | 'supplemental'
  stakingBacked: boolean
  points: Array<{
    i: number
    suppliedUsd: number | null
    borrowedUsd: number | null
    netUsd: number | null
    unpriced: number
    observation: MoneyMarketHistoryObservation | null
    eModeCategoryId: number | null
    /** Settled unclaimed incentives under this market at the bucket end; never in the USD above. Absent from an older upstream. */
    unclaimedRewards?: Array<{ asset: AssetRef; amount: string; valueUsd: number | null; settledAtBlock: number | null }>
  }>
  reserves: MoneyMarketHistoryReserve[]
}
export interface MoneyMarketHistory {
  stepSec: number
  priceGrain: '1h' | '1d'
  dates: string[]
  blocks: number[]
  reserveHistoryFrom: { blockHeight: number; time: string | null } | null
  suppliedUsd: Array<number | null>
  borrowedUsd: Array<number | null>
  unpriced: number[]
  /** Priced settled incentives across markets; null before reserveHistoryFrom. Absent from an older upstream. */
  unclaimedRewardsUsd?: Array<number | null>
  rewardsIncomplete?: number[]
  markets: MoneyMarketHistoryMarket[]
}

export interface ValueEvent {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  kind: 'transfer-in' | 'transfer-out' | 'swap' | 'liquidity' | 'liquidation' | 'dca' | 'cross-chain' | 'price' | 'other'
  /** SIGNED for a 'price' marker, which annotates a value-line jump no event explains. */
  valueUsd: number
  asset: AssetRef | null
  counterparty: AccountRef | null
  direction?: 'in' | 'out'
  linkable?: boolean
  dcaScheduleId?: number
  dcaTrades?: number
  assetIn?: AssetRef | null
  assetOut?: AssetRef | null
  amount?: string
}

export interface RevenueBreakdown {
  totalUsd: number
  streams: {
    stream: string
    usd: number
    assets: { asset: AssetRef; usd: number }[]
    otherUsd?: number
    otherCount?: number
  }[]
}

/* ============ tags ============ */

export interface TagListRow {
  tagId: string
  name: string
  color: string
  note: string
  icon: string
  memberCount: number
}

/**
 * A tag's aggregate. `/explorer/tag/treasury` is the largest payload on the
 * whole surface (1.5 MB); `summary=1` cuts it to 56 KB by dropping the history,
 * LP and DCA sections.
 */
export interface TagDetail {
  tagId: string
  name: string
  color: string
  note: string
  icon: string
  members: AccountRef[]
  balances: AddressBalance[]
  topAssets: { asset: AssetRef; valueUsd: number }[]
  portfolioUsd: number
  portfolioExHdxUsd?: number
  tradingVolumeUsd?: number
  liquidationVolumeUsd?: number
  revenueUsd?: number
  moneyMarket: MoneyMarketPosition[]
  liquidityPositions?: LpPosition[]
  activeDcas?: ActiveDca[]
  openLimitOrders?: OpenLimitOrder[]
  portfolioSeries?: number[]
  portfolioSeriesExHdx?: number[]
  portfolioDates?: string[]
  portfolioBlocks?: number[]
  balanceHistory?: unknown[]
}

/* ============ assets, holders, cross-chain ============ */

export type ExplorerAssetType = 'Native' | 'Derivative' | 'Token' | 'Cross-chain'

/** A cross-chain destination — an asset reachable only by selling into it. */
export interface XcDestination {
  platform: string
  oneClickId: string
  symbol: string
  name: string
  decimals: number
  /** The registry key ('zec'); `chainName` is how people write it ('Zcash'). */
  chain: string
  chainName: string
  origin: AssetOrigin
}

export interface AssetListItem extends AssetRef {
  price: number | null
  /** A FRACTION (0.064 = +6.4%), not a percentage. */
  change24h: number | null
  change7d?: number | null
  type?: ExplorerAssetType
  amountUsd: number | null
  holderCount?: number
  sparkline?: number[]
  /** Present ONLY on a cross-chain destination, whose `assetId` is a negative sentinel. */
  xcDestination?: XcDestination
}

/**
 * `/explorer/asset/:id` does NOT 404 on an unknown-but-valid id — it answers a
 * shell of nulls. A tool must say so rather than render the shell as fact.
 */
export interface AssetDetail {
  asset: AssetListItem
  holderCount: number
  dcaCount: number
  limitOrderCount?: number
  totalUsd: number
  priceSeries: number[]
  priceDates?: string[]
  /** Only for an asset that is or was a primary money-market reserve. */
  liquidations?: unknown | null
  liquiditySourceCount?: number
}

export interface HolderRow {
  rank: number
  account: AccountRef | null
  tag: { tagId: string; name: string; color: string; icon: string; memberCount: number } | null
  balance: string
  lastBlock: number
  valueUsd?: number | null
  /** Fraction of the asset's supply. */
  share?: number
}

export interface HoldersPage {
  asset: AssetRef
  holders: HolderRow[]
  /** Rows in the list — a system tag's members fold into one row. */
  total: number
  totalUsd: number
  /** Accounts holding the asset (`get_asset`'s Holders figure). */
  holderCount?: number
}

export interface XcDestinationDetail {
  destination: XcDestination
  /** A REFERENCE price from a venue that lists the asset — never what a swap got. */
  referencePrice: number | null
  referenceSource: string
  swapCount: number
  settledCount: number
  /** Null rather than 0 when nothing has settled. */
  soldUsd: number | null
  deliveredUsd: number | null
  recipientCount: number
  firstAt: string | null
  lastAt: string | null
  soldAssets: { asset: AssetRef; swaps: number; amount: string; valueUsd: number | null }[]
  recent: ActivityRow[]
}

/* ============ pools ============ */

export type PoolKind = 'omnipool' | 'stableswap' | 'xyk' | 'uniswapv3'

export interface PoolCompositionEntry {
  asset: AssetRef
  amount: string
  usd: number | null
  sharePct: number | null
}

export interface PoolListEntry {
  kind: PoolKind
  /** The share/LP asset id; null for the Omnipool and for a v3 pool. */
  poolId: number | null
  /** A concentrated-liquidity pool's contract (kind 'uniswapv3'). */
  address?: string
  name: string
  tvlUsd: number | null
  sharePct: number | null
  composition: PoolCompositionEntry[]
  hasPegs: boolean
}

export interface PoolsIndex {
  totalTvlUsd: number | null
  pools: PoolListEntry[]
}

export interface PoolDetailAsset {
  asset: AssetRef
  amount: string
  usd: number | null
  sharePct: number | null
  peg: { num: string; den: string; price: number } | null
  pegSource: { kind: 'value' | 'oracle' | 'mmOracle'; source?: string; period?: string; oracleAsset?: AssetRef; address?: string } | null
}

export interface PoolParamEvent {
  blockHeight: number
  timestamp: string
  kind: 'created' | 'amplification' | 'fee' | 'peg-source' | 'max-peg-update' | 'destroyed'
  summary: string
}

/** `/explorer/pool/:poolId` — a stableswap or XYK pool. A v3 pool has its own route and shape. */
export interface PoolDetail {
  kind: 'stableswap' | 'xyk'
  poolId: number
  name: string
  account: AccountRef
  shareToken: AssetRef
  createdBlock: number | null
  createdAt: string | null
  destroyed: boolean
  tvlUsd: number | null
  totalIssuance: string
  feePermill: number | null
  amplification: { current: number; initial: number; final: number; initialBlock: number; finalBlock: number } | null
  maxPegUpdatePerbill: number | null
  assets: PoolDetailAsset[]
  paramEvents: PoolParamEvent[]
  /** Bucketed series; large, and rendered only when a tool asks for history. */
  history?: unknown
}

export interface PoolLpRow {
  account: AccountRef | null
  shares: string
  sharePct: number | null
  valueUsd: number | null
  /** Per-asset shape varies by venue; not mirrored field by field. */
  assets?: unknown
}

/* ============ money market ============ */

export interface MoneyMarketAccountRow {
  account: AccountRef
  supplyUsd: number
  debtUsd: number
  netWorthUsd: number
  /**
   * The SAME 1e18 scaling as `MoneyMarketPosition.healthFactor`, with the same
   * `'inf'` sentinel — verified live (`"81451985257"` on a position holding
   * $1.2e-6 of collateral against $12.52 of debt, i.e. 8.1e-8). Only `supplyUsd`
   * and `debtUsd` beside it are pre-divided out of their 1e8 base units, so read
   * this one through `formatHealthFactor` like every other health factor.
   */
  healthFactor: string
  blockHeight: number
}

/**
 * `/explorer/money-market`. NOTE: this route carries protocol totals and the
 * riskiest ACCOUNTS — it does not carry per-reserve supply/borrow/caps. Those
 * live on `MoneyMarketPosition.reserves` inside an address or tag detail.
 */
export interface MoneyMarketDashboard {
  totalSupplyUsd: number
  totalDebtUsd: number
  positions: MoneyMarketAccountRow[]
}

/* ============ governance ============ */

export interface GovernanceTrackRef { id: number; name: string }

export interface ReferendumListRow {
  pallet: 'opengov' | 'democracy'
  index: number
  title: string | null
  status: string
  voters: number | null
  blockHeight: number
  timestamp: string
  track: GovernanceTrackRef | null
  /** OpenGov only — a Democracy proposal was tabled from a queue and names no submitter. */
  proposer: AccountRef | null
  enactment: 'ok' | 'failed' | 'unavailable' | null
}

export interface ReferendaPage { total: number; rows: ReferendumListRow[] }

export interface ReferendumTally { ayes: string; nays: string; support: string | null }

/** The chain's own tally, with the provenance that says whether it still holds. */
export interface OnChainTally extends ReferendumTally {
  final: boolean
  blockHeight: number
  timestamp: string
}

export interface ReferendumVoter {
  account: AccountRef | null
  kind: 'Standard' | 'Split' | 'SplitAbstain'
  side: 'Aye' | 'Nay' | 'Split' | 'SplitAbstain'
  conviction: string | null
  convictionIndex: number | null
  balance: string
  ayeBalance: string
  nayBalance: string
  abstainBalance: string
  weightedAye: string
  weightedNay: string
  weighted: string
  valueUsd: number | null
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  removed: boolean
}

export interface ReferendumTimelineEntry {
  event: string
  blockHeight: number
  extrinsicIndex: number | null
  timestamp: string
  outcome?: 'ok' | 'failed' | 'unavailable'
  scheduled?: { depth: number; state: 'ran' | 'pending' | 'cancelled' | 'dropped' }
}

export interface ReferendumTrackRef {
  id: number
  name: string
  /** Parachain BLOCK counts — turn them into durations with `nominalBlockSec`. */
  preparePeriod: number
  decisionPeriod: number
  confirmPeriod: number
  minEnactmentPeriod: number
  decisionDeposit: string
}

/** The pallet's CURRENT tally from chain storage — conviction-weighted, delegation included. */
export interface LiveReferendumTally {
  ayes: string
  nays: string
  /** Support counts aye PLUS abstain capital; nay is excluded. */
  support: string
  electorate: string | null
}

export interface ReferendumDetail {
  pallet: 'opengov' | 'democracy'
  index: number
  title: string | null
  proposer: AccountRef | null
  subsquareUrl: string
  track: number | null
  proposalHash: string | null
  proposalCall: {
    pallet: string
    callName: string
    args?: unknown
    encoded: string | null
    byteLength: number
    decodeError: string | null
  } | null
  status: string
  enactment: 'ok' | 'failed' | 'unavailable' | null
  submittedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
  concludedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
  /** The asset the tally is denominated in (HDX). */
  asset: AssetRef
  onChainTally: OnChainTally | null
  directTally: {
    ayes: string; nays: string; rawAyes: string; rawNays: string; support: string
    ayeVoters: number; nayVoters: number; splitVoters: number; voters: number
  }
  indirectTally: ReferendumTally | null
  voters: ReferendumVoter[]
  votesShown: number
  votesTotal: number
  timeline: ReferendumTimelineEntry[]
  timelineTruncated?: boolean
  trackInfo: ReferendumTrackRef | null
  liveTally: LiveReferendumTally | null
  /** Phase progress against the track's periods. Shape not mirrored field by field. */
  progress?: unknown
}

/* ============ revenue ============ */

/** `t` is UNIX SECONDS, not a ClickHouse timestamp. */
export interface RevenuePoint { t: number; usd: number }

export interface RevenueDashboard {
  totals: { day: number; week: number; month: number; allTime: number }
  history: {
    range: string
    bucketSeconds: number
    series: { stream: string; points: RevenuePoint[] }[]
  }
  /** `share` is a FRACTION (0.4289 = 42.89%) — not the percent units `sharePct` carries. */
  breakdown: { stream: string; usd: number; share: number }[]
  topAccounts: { account: AccountRef; usd: number }[]
  /** ISO-8601 with a `Z` (`"2026-09-18T14:08:35.000Z"`), not the usual zone-less ClickHouse string. */
  asOf: string
}

/** `t` is UNIX SECONDS. */
export interface StakerPoint { t: number; hdx: number; usd: number }

export interface StakerDistributions {
  range: string
  bucketSeconds: number
  series: { pot: 'staking' | 'gigahdx' | 'gigarwd'; points: StakerPoint[] }[]
  totals: { hdx: number; usd: number }
  allTime: { hdx: number; usd: number }
}

/* ============ errors ============ */

/**
 * Every non-2xx body. On a block-addressed miss the two extra fields split
 * "not indexed yet" (retry) from "never existed" (fail fast).
 */
export interface ExplorerError {
  error: string
  blockIndexed?: boolean
  headBound?: number
}
