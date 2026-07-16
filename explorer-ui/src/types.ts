export interface AssetOrigin {
  ecosystem: string
  chainId: string
  assetId: string | null
}

export interface AssetRef {
  assetId: number
  iconAssetId?: number
  symbol: string
  name: string | null
  decimals: number
  parachainId: number | null
  origin?: AssetOrigin | null
}

export interface TagRef { id: string; name: string; color: string; icon: string }

export interface AccountIdentity {
  display: string
  verified: boolean
  email: string
  web: string
  twitter: string
}

export interface AccountRef {
  accountId: string
  address: string        // Polkadot SS58 or EVM 0x (never Hydration SS58)
  emoji: string          // Omniwatch/snakewatch identity emoji
  emojiName?: string     // human-readable name for the custom emoji/icon (e.g. Discord emoji name)
  emojiUrl?: string      // custom image icon (e.g. a Discord avatar) — render in place of the emoji char
  tag: TagRef | null
  identity?: AccountIdentity | null   // on-chain Identity.IdentityOf display + judgement status
}

export interface ExplorerStats {
  headBlock: number
  finalizedBlock: number
  headTime: string
  avgBlockSec: number
  transfers24h: number
  extrinsics24h: number
  activeAccounts24h: number
  hdxPrice: number | null
}

export type ExplorerAssetType = 'Native' | 'Derivative' | 'Token'
export interface AssetListItem extends AssetRef {
  price: number | null
  change24h: number | null
  change7d?: number | null
  type: ExplorerAssetType
  amountUsd: number | null
  holderCount?: number
  sparkline?: number[]
}

export interface TopAccountRow {
  account: AccountRef | null
  tag: { tagId: string; name: string; color: string; icon: string; memberCount: number } | null
  portfolioUsd: number
  lastBlock: number
  // Money-market enrichment (null when the account has no MM position).
  suppliedUsd: number | null
  borrowedUsd: number | null
  // Optional enrichments (design parity — populated where available).
  healthFactor?: string | null
  identity?: string | null
  // Account holding the group's worst-HF position (DefiSim link target for tags).
  simAccount?: string | null
  // Supplemental markets never replace the primary Money Market columns above.
  // This compact summary only makes the less-used credit line discoverable.
  supplementalMarket?: {
    marketKey: string
    market: string
    borrowedUsd: number
    healthFactor?: string | null
  } | null
  // 1Y weekly value sparkline (fixed length, zero-padded → same range for all rows).
  sparkline?: number[]
  activityCount?: number
  tradingVolumeUsd?: number
  liquidationVolumeUsd?: number
  // Up to 4 largest holdings (> $10, highest USD first) → icon cluster after value.
  topAssets?: { asset: AssetRef; valueUsd: number }[]
}

export type AccountSort = 'value' | 'supplied' | 'borrowed' | 'health' | 'identity' | 'activity' | 'volume' | 'liquidation'
export interface AccountsPage { rows: TopAccountRow[]; total: number }

// trade detail
export interface TradeHop {
  pool: string
  poolId: number | null
  assetIn: AssetRef
  assetOut: AssetRef
  amountIn: string | null
  amountOut: string | null
  fee: { amount: string; asset: AssetRef } | null
}
export interface TradeDetail {
  blockHeight: number
  timestamp: string
  extrinsicIndex: number | null
  eventIndex: number | null
  hash: string | null
  success: boolean
  who: AccountRef | null
  venue: string
  direction: 'Sell' | 'Buy'
  assetIn: AssetRef
  assetOut: AssetRef
  amountIn: string
  amountOut: string
  valueUsd: number | null
  executionPrice: number | null
  limit: { kind: 'minReceived' | 'maxPaid'; amount: string; asset: AssetRef; marginPct: number | null } | null
  extrinsicFee: string | null
  route: TradeHop[]
  dca: boolean
}

export interface DailyPoint { date: string; value: number }

export interface BlockSummary {
  height: number
  timestamp: string
  hash: string
  author: AccountRef | null
  specVersion: number
  extrinsicCount: number
  eventCount: number
}

export interface ExtrinsicSummary {
  blockHeight: number
  index: number
  hash: string
  timestamp: string
  signer: AccountRef | null
  success: boolean
  callName: string
  fee: string | null
}

export interface BlockEvent { eventIndex: number; extrinsicIndex: number | null; name: string; args: unknown }
export interface BlockDetail extends BlockSummary {
  parentHash: string
  stateRoot: string | null
  extrinsicsRoot: string | null
  extrinsics: ExtrinsicSummary[]
  events: BlockEvent[]
}

export interface ExtrinsicEvent { eventIndex: number; name: string; args: unknown; decoded?: boolean }
export interface ExtrinsicDetail extends ExtrinsicSummary {
  version: number
  tip: string | null
  callArgs: unknown
  error: unknown
  events: ExtrinsicEvent[]
}

export interface TransferRow {
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  from: AccountRef
  to: AccountRef
  amount: string
  asset: AssetRef
  valueUsd: number | null
}

export interface HolderRow {
  rank: number
  account: AccountRef | null
  tag: { tagId: string; name: string; color: string; icon: string; memberCount: number } | null
  balance: string
  lastBlock: number
  valueUsd?: number | null
  share?: number
}
export interface HoldersResponse { asset: AssetRef; holders: HolderRow[]; total: number; totalUsd: number }

export interface AddressBalance { asset: AssetRef; total: string; free: string; reserved: string; lastBlock: number; valueUsd: number | null }
export interface MmReserve {
  assetId: number
  iconAssetId?: number
  symbol: string
  decimals: number
  parachainId?: number | null
  origin?: AssetRef['origin']
  supplied: string
  debt: string
  suppliedUsd: number | null
  debtUsd: number | null
  collateral: boolean
}
export interface LpPosition { positionId: string; asset: AssetRef; amount: string; hubAmount?: string; shares: string; valueUsd: number | null; venue: string }
export interface ActiveDca {
  id: number; assetIn: AssetRef; assetOut: AssetRef; direction: string
  amountPerTrade: string; totalAmount: string; filledAmount: string; remainingAmount: string | null
  executionsDone: number; period: number; nextExecutionBlock: number | null
  valueUsd: number | null; scheduleBlock: number; scheduleIndex: number | null
}
export interface MoneyMarketPosition {
  marketKey: string
  market: string                 // display label, e.g. 'Money Market' or 'GIGAHDX'
  role: 'primary' | 'supplemental'
  defiSimSupported: boolean      // currently true only for the primary market
  stakingBacked?: boolean        // collateral backed by locked-in-wallet HDX (display-only in net worth)
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
}
export interface AddressAlias {
  accountId: string | null
  evmAddress: string | null
  primaryProfile: string
  relationship: string
  confidence: number
}
// Proxy & multisig relations (accounts resolved to displayable refs).
export interface ProxyRelation { account: AccountRef; proxyType: string; delay: number }
export interface AccountProxyInfo {
  isPure: { creator: AccountRef; proxyType: string; blockHeight: number; timestamp: string } | null
  delegates: ProxyRelation[]    // accounts that can act for this one
  delegatorOf: ProxyRelation[]  // accounts this one can act for
}
export interface PendingMultisigOp { callHash: string; depositor: AccountRef; approvals: AccountRef[]; sinceBlock: number }
export interface MultisigInfo { threshold: number; signatories: AccountRef[]; pending: PendingMultisigOp[] }
export interface MultisigMembership { account: AccountRef; threshold: number; signatories: number }

export interface AddressDetail {
  input: string
  kind: string
  accountId: string
  emoji: string
  emojiName?: string
  emojiUrl?: string
  evmAddress: string | null
  ss58: string
  ss58Polkadot: string
  tag: TagRef | null
  identity: AccountIdentity | null
  relatedAccountIds: string[]
  aliases: AddressAlias[]
  balances: AddressBalance[]
  // Up to 4 largest holdings (> $10 and ≥ 10% of held value) — shared by the
  // accounts list icons and the hover card.
  topAssets: { asset: AssetRef; valueUsd: number }[]
  portfolioUsd: number
  tradingVolumeUsd?: number
  liquidationVolumeUsd?: number
  moneyMarket: MoneyMarketPosition[]
  liquidityPositions?: LpPosition[]
  activeDcas?: ActiveDca[]
  proxy?: AccountProxyInfo | null
  multisig?: MultisigInfo | null
  multisigMemberships?: MultisigMembership[]
  portfolioSeries?: number[]
  portfolioDates?: string[]
  balanceHistory?: AssetBalanceHistory[]
}

export interface AssetBalancePoint { ts: string; blockHeight: number; balance: number }
export interface AssetBalanceHistory { asset: AssetRef; current: number; points: AssetBalancePoint[]; availableFrom?: string }
export interface AccountHistoryResponse { portfolioSeries: number[]; portfolioDates: string[]; balanceHistory: AssetBalanceHistory[] }

export type CloseAccountReason =
  | { type: 'direct_transfers'; count: number; days: number; valueUsd: number | null; bidirectional: boolean }
  | { type: 'near_signing'; days: number }
  | { type: 'shared_cex'; name: string }

export interface CloseAccountMatch {
  account: AccountRef
  score: number
  confidence: 'strong' | 'moderate'
  lastSeen: string
  reasons: CloseAccountReason[]
}

export interface CloseAccountsResponse {
  accounts: CloseAccountMatch[]
  lookbackDays: number | null   // null: unlimited — the full indexed history
  disclaimer: string
}

export interface SearchResult {
  type: 'block' | 'extrinsic' | 'address' | 'asset' | 'tag'
  value: string
  label?: string
  desc?: string   // asset-type: the descriptive name (e.g. DOT → "Polkadot")
  asset?: AssetRef
  // Address-type results carry the account's emoji + on-chain identity so the
  // dropdown can render the account pill directly.
  emoji?: string
  emojiName?: string
  emojiUrl?: string
  identity?: AccountIdentity | null
  // Tag-type results carry the tag's icon (URL/emoji glyph) and color so the
  // dropdown can render the tag's icon in front of the entry.
  icon?: string
  color?: string
}

export interface TagMember { accountId: string; address: string }
export interface Tag {
  tagId: string
  name: string
  color: string
  note: string
  icon: string
  members: TagMember[]
}

export interface IndexerStatus {
  blockHeight: number
  blockTimestamp: string
  lagSeconds: number
  chainBlockHeight: number
  blocksBehindHead: number
}

export interface EventRow {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  name: string
  args: unknown
  decoded: boolean
}

export interface EventDetail {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  name: string
  args: unknown
  decoded: boolean
  phase: string
  extrinsic: ExtrinsicSummary | null
}

export interface TradeRow {
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  who: AccountRef | null
  assetIn: AssetRef
  assetOut: AssetRef
  amountIn: string
  amountOut: string
  valueUsd: number | null
  venue: string
  dca?: boolean
  linkBlock?: number | null
  linkIndex?: number | null
}

export interface ActivityRow {
  type: 'transfer' | 'trade' | 'xcm' | 'liquidity' | 'mm' | 'dca' | 'staking' | 'vote' | 'otc'
  blockHeight: number
  timestamp: string
  eventIndex?: number | null
  extrinsicIndex: number | null
  who: AccountRef | null
  to: AccountRef | null
  asset: AssetRef | null
  assetIn: AssetRef | null
  assetOut: AssetRef | null
  amount: string | null
  amountIn: string | null
  amountOut: string | null
  valueUsd: number | null
  dcaScheduleId?: number
  destChain?: string
  destParachainId?: number | null
  // Destination account of a cross-chain transfer. `address` is always the
  // Polkadot-format SS58 (one identity per pubkey across chains); emoji fields,
  // tag, and identity are derived server-side exactly like local accounts'.
  destAccount?: {
    kind: 'AccountId32' | 'AccountKey20'; address: string; raw: string; subscanUrl: string | null
    emoji?: string; emojiName?: string; emojiUrl?: string
    tag?: TagRef | null
    identity?: { display: string; verified: boolean } | null
  }
  xcmDir?: 'in' | 'out'      // xcm: transfer direction relative to Hydration
  fromChain?: string         // xcm inbound: origin chain name
  fromParachainId?: number | null
  // Source account of an inbound transfer (best-effort — resolved server-side
  // from the Ocelloids crosschain index; absent for old rows or on API outage).
  fromAccount?: ActivityRow['destAccount']
  messageId?: string | null
  fromTxUrl?: string | null   // xcm inbound: origin-chain extrinsic on its explorer  // xcm inbound: message topic id
  bridge?: string | null
  mmAction?: string
  mmMarketKey?: string
  mmMarket?: string
  stakingAction?: string
  votePallet?: string
  voteAction?: string
  voteRef?: string | null
  voteSide?: string
  voteConviction?: string | null
  liqAction?: 'Add' | 'Remove' | 'Create' | 'Claim'   // Create = pool creation; Claim = LM rewards
  dca?: boolean
  dcaStatus?: 'failed'
  dcaError?: string
  linkBlock?: number | null
  linkIndex?: number | null
  otcAction?: 'Place' | 'Pull' | 'Fill'
  otcOrderId?: number
  otcPartial?: boolean            // fill came from OTC.PartiallyFilled
  otcPartiallyFillable?: boolean  // Placed order property
  otcFee?: string                 // fills; denominated in assetOut
}

export interface VoteRow {
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  account: AccountRef | null
  pallet: string
  action: string
  referendum: string | null
  side: string
  conviction: string | null
  amount: string | null
  asset: AssetRef
  valueUsd: number | null
}

export interface MoneyMarketRow {
  account: AccountRef
  supplyUsd: number
  debtUsd: number
  netWorthUsd: number
  healthFactor: string
  blockHeight: number
}
export interface MoneyMarketResponse {
  totalSupplyUsd: number
  totalDebtUsd: number
  positions: MoneyMarketRow[]
}

export interface AssetDetail {
  asset: AssetListItem
  holderCount: number
  totalUsd: number
  priceSeries: number[]
  priceDates?: string[]
}

export interface HdxCohort { key: string; label: string; minPct: number; minHdx: number; accounts: number; totalHdx: number }
export interface HdxLockType { key: string; label: string; accounts: number; totalHdx: number }
export interface HdxUnlockBucket { label: string; fromTs: string; toTs: string; gigahdx: number; vesting: number; vote: number }
export interface HdxDailyFlow { date: string; buyHdx: number; sellHdx: number; buyers: number; sellers: number }
export interface HdxMover { account: AccountRef; balanceHdx: number; boughtHdx: number; soldHdx: number; netHdx: number }
export interface HdxDashboard {
  price: number | null
  change24h: number | null
  supply: { totalHdx: number; protocolHdx: number; userHdx: number; holders: number }
  cohorts: HdxCohort[]   // Whale, Dolphin, Fish, Shrimp (in that order)
  // Vesting figures count only HDX still on schedule; vestedUnclaimedHdx is
  // the already-vested remainder that sits under a stale ormlvest lock.
  locks: { types: HdxLockType[]; totalLockedHdx: number; lockedPctOfUser: number; vestedUnclaimedHdx: number; snapshotAt: string | null }
  unlocks: {
    buckets: HdxUnlockBucket[]                     // 8 weekly then monthly buckets
    laterHdx: { gigahdx: number; vesting: number; vote: number }
    unlockableNowHdx: number
    activeVoteHdx: number
    stakingAnytimeHdx: number
    gigaPending: { count: number; totalHdx: number; nextUnlockTs: string | null }
  }
  flows: { daily: HdxDailyFlow[]; dca: { buy: { orders: number; hdxPerDay: number }; sell: { orders: number; hdxPerDay: number } } }
  churn: { weekly: { weekStart: string; newHolders: number; exitedHolders: number }[] }
  topMovers: { accumulators: HdxMover[]; distributors: HdxMover[] }
  gigaMarket: GigaMarketReserveStat[] | null
  gigaLiquidations: GigaLiquidations | null
}

export interface GigaMarketReserveStat { asset: AssetRef; supplied: number; suppliedUsd: number | null; debt: number; debtUsd: number | null; suppliers: number; borrowers: number }
export interface GigaLiquidations { currentPrice: number; points: { price: number; stHdx: number }[] }

export interface HollarPegPoint { ts: string; close: number }
export interface HollarCollateral {
  asset: AssetRef
  poolId: number
  holdings: string
  holdingsUsd: number | null
  purchaseFeePct: number
  buyBackFeePct: number
  maxBuyPrice: number
  buybackRatePct: number
  maxInHolding: string | null
  lastArbTs: string | null
  lastArbDirection: 'in' | 'out' | null
}
export interface HollarArbDay { date: string; hollarIn: number; hollarOut: number }
export interface HollarTradeDay { date: string; bought: number; sold: number }
export interface HollarPool {
  poolId: number
  tvlUsd: number | null
  hollar: { amount: number; usd: number | null }
  // One entry per non-HOLLAR asset in the pool — most pools have exactly one
  // partner, but N-asset pools exist (e.g. pool 105 = HOLLAR/USDC/USDT).
  partners: { asset: AssetRef; amount: number; usd: number | null }[]
  hollarSharePct: number | null
}
export interface HollarDashboard {
  price: number | null
  change24h: number | null
  pegDeviationBps: number | null
  peg: { hourly: HollarPegPoint[]; within25bpsPct: number | null; maxDevBps: number | null; min30d: number | null; max30d: number | null }
  supply: { total: number; holders: number; inStablepools: number; inOmnipool: number; other: number }
  hsm: {
    totalHoldingsUsd: number
    collaterals: HollarCollateral[]
    arbitrageDaily: HollarArbDay[]
    tradesDaily: HollarTradeDay[]
    lastArb: { ts: string; direction: 'in' | 'out'; asset: AssetRef; hollarAmount: number } | null
  }
  pools: HollarPool[]
}

export interface TagDetail {
  tagId: string
  name: string
  color: string
  note: string
  icon: string
  members: AccountRef[]
  balances: AddressBalance[]
  // Up to 4 largest combined holdings (see AddressDetail.topAssets).
  topAssets: { asset: AssetRef; valueUsd: number }[]
  portfolioUsd: number
  tradingVolumeUsd?: number
  liquidationVolumeUsd?: number
  moneyMarket: MoneyMarketPosition[]
  liquidityPositions?: LpPosition[]
  activeDcas?: ActiveDca[]
  portfolioSeries: number[]
  portfolioDates?: string[]
  balanceHistory: AssetBalanceHistory[]
}

export interface DcaScheduleDetail {
  scheduleId: number
  who: AccountRef | null
  createdAt: { blockHeight: number; timestamp: string; extrinsicIndex: number | null }
  assetIn: AssetRef
  assetOut: AssetRef
  amountPer: string
  totalAmount: string
  period: number
  maxRetries: number
  status: 'active' | 'completed' | 'terminated' | 'cancelled'
  statusAt: string | null
  executions: { count: number; failed: number; attempts: number; totalIn: string; totalOut: string }
  rows: ActivityRow[]
}
