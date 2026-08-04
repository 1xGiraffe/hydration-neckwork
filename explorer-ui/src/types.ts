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

export interface TagRef { id: string; name: string; color: string; icon: string; memberCount?: number }

export interface AccountIdentity {
  display: string
  verified: boolean
  email: string
  web: string
  twitter: string
}

// A wallet-login profile: the display name and avatar the account owner set
// themselves. `avatarVersion` busts the avatar image URL's cache on change —
// absent/null means no profile has been set up for the account.
export interface ProfileRef { name: string; avatarVersion: number }

export interface AccountRef {
  accountId: string
  address: string        // Polkadot SS58 or EVM 0x (never Hydration SS58)
  emoji: string          // Omniwatch/snakewatch identity emoji
  emojiName?: string     // human-readable name for the custom emoji/icon (e.g. Discord emoji name)
  emojiUrl?: string      // custom image icon (e.g. a Discord avatar) — render in place of the emoji char
  tag: TagRef | null
  identity?: AccountIdentity | null   // on-chain Identity.IdentityOf display + judgement status
  profile?: ProfileRef | null         // self-authored wallet-login profile, if the account has one
  isContract?: boolean                // deployed EVM smart contract — pills wear the </> glyph
  contractName?: string               // verified source's contract name — the pill's label, like an identity display
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

// `/explorer/assets?fields=filter` — the same ordered directory projected down to
// what a token filter shows and searches on. `AssetListItem` widens to this, so
// surfaces that only build filter options accept either shape.
export type AssetFilterItem = Pick<AssetRef, 'assetId' | 'symbol' | 'name'>

export interface TopAccountRow {
  account: AccountRef | null
  // `userTagId`/`listId` are additive: set only when this group row folded under
  // the REQUESTING viewer's own tag (served from /user/accounts) rather than a
  // system one. `tagId` is the tag's real id either way, so TagGroupPill's link
  // (paths.tag(tagId)) already routes a user tag to its aggregate page — see
  // userTags.ts's looksLikeUserTagId — with no change needed to read it.
  tag: { tagId: string; name: string; color: string; icon: string; memberCount: number; userTagId?: string; listId?: string } | null
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
  // The account's own activity feed total, the same number its detail page reports.
  // Absent for an account the background ranking has not counted.
  activityCount?: number
  // False when that total is a floor the feed could only be counted to in part.
  activityCountComplete?: boolean
  tradingVolumeUsd?: number
  liquidationVolumeUsd?: number
  // Up to 4 largest holdings (> $10, highest USD first) → icon cluster after value.
  topAssets?: { asset: AssetRef; valueUsd: number }[]
}

export type AccountSort = 'value' | 'supplied' | 'borrowed' | 'health' | 'identity' | 'activity' | 'volume' | 'liquidation'
export interface AccountsPage {
  rows: TopAccountRow[]
  total: number
}

// A registry contract, as the /contracts directory and AddressDetail.contract
// carry it. Creation is evidence-labelled: `create` came from a top-level
// Ethereum.transact, `factory` from first-log attribution ("first seen", never
// "created"), `unknown` states honest incompleteness. `verified` is the compact
// directory chip; `verification` the full card, with an explicit `unverified`
// status rather than a null when no verification exists.
export interface ContractCreation {
  method: 'create' | 'factory' | 'unknown'
  deployer?: AccountRef | null
  deployerWhitelisted?: boolean       // advisory ContractDeployer whitelist (provenance only)
  factory?: AccountRef
  attribution?: 'first-log'
  blockHeight?: number
  extrinsicIndex?: number
  timestamp?: string
  txHash?: string
}
export interface ContractVerification {
  status: string           // 'verified' | 'unverified'
  name?: string
  compilerVersion?: string
  matchType?: string       // 'exact_match' | 'match' | ''
  source?: string          // 'verified' | 'import:blockscout' | 'manual'
  verifiedAt?: string
  abiPresent?: boolean
  sourceFileCount?: number
  supersededBytecode?: boolean   // code at the address changed after verification (CREATE2 redeploy)
}
export interface ContractInfo {
  address: string
  account: AccountRef
  verified: { status: string; name: string; matchType: string } | null
  verification: ContractVerification | null
  creation: ContractCreation
  codeHash: string
  codeSize: number
  destroyed: boolean
  txCount: number
  logCount: number
  firstActivity: string | null
  lastActivity: string | null
  // What the contract holds and does as an ACCOUNT, on the same models the
  // accounts directory reads. Absent means "not established" — no number is
  // shown rather than a zero standing in for one (see ContractMetrics, api).
  portfolioUsd?: number
  topAssets?: { asset: AssetRef; valueUsd: number }[]
  sparkline?: number[]
  tradingVolumeUsd?: number
  activityCount?: number
  activityCountComplete?: boolean
}
export type ContractSort = 'created' | 'active' | 'txs' | 'logs' | 'value' | 'volume' | 'activity' | 'name'
export interface ContractsPage {
  contracts: ContractInfo[]
  total: number
}
// Lazy verified-contract artifacts (extrinsic-bytes pattern): fetched only when
// the Code/Read sub-tabs actually need them.
export interface ContractAbiPayload {
  address: string
  abi: unknown[]
  source: string
  contractName: string
}
export interface ContractSourcesPayload {
  address: string
  files: { path: string; content: string }[]
  compiler: {
    version: string
    evmVersion: string
    optimizerEnabled: boolean
    optimizerRuns: number
    constructorArguments: string
    settings: unknown
  }
}
// Request-time verified-ABI decoding on detail surfaces (§9). `hashed` marks an
// indexed dynamic event param whose preimage only exists on chain as its hash.
export interface EvmDecodedParam {
  name: string
  type: string
  value: unknown
  indexed?: boolean
  hashed?: boolean
}
export interface EvmLogDecode {
  decoded: true
  name: string
  signature: string
  params: EvmDecodedParam[]
  decodedBy: 'verified-abi'
}
export type EvmCallDecode =
  | { decoded: true; name: string; signature: string; selector: string; params: EvmDecodedParam[] }
  | { decoded: false; selector: string | null }
export interface DecodedEvmCall {
  target: string
  contractName: string | null
  call: EvmCallDecode
}
// Contract-tab activity views, scoped to one contract.
export interface ContractTxMethod { selector: string | null; name: string | null; signature: string | null }
export interface ContractTxRow {
  blockHeight: number
  extrinsicIndex: number | null
  timestamp: string
  txHash: string
  from: AccountRef | null
  success: boolean
  method: ContractTxMethod
}
export interface ContractTransactionsPage { transactions: ContractTxRow[]; total: number }
export interface ContractEventRow {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  name: string | null
  topics: string[]
  data: string
  evmDecoded?: EvmLogDecode
  args?: Record<string, unknown>
  decodedBy?: 'verified-abi' | 'ingest'
}
export interface ContractEventsPage { events: ContractEventRow[]; total: number }
// Sourcify V2 verification job, as the poll endpoint reports it.
export interface VerificationJob {
  isJobCompleted: boolean
  verificationId: string
  contract: { match: string | null; runtimeMatch: string | null; creationMatch: string | null }
  error?: { customCode: string; message: string; errorId: string }
}

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

export interface FailureReason { label: string; docs: string | null }

export function failureReasonText(r: FailureReason | null | undefined): string | undefined {
  if (!r) return undefined
  return r.docs ? `${r.label} — ${r.docs}` : r.label
}

export interface ExtrinsicOrigin {
  kind: 'proxy' | 'multisig'
  state?: 'pending' | 'executed' | 'cancelled'
  threshold?: number
  signatories?: number
  approvals?: number
  callHash?: string
  // The operation's initiator — the signatory who proposed/sent it (not
  // necessarily the executing signer shown on 'executed' rows).
  initiator?: AccountRef
  // Chronological approval history: who did what, and when. `extrinsicId` is
  // the "block-extrinsic" of that timeline event, for linking to it directly.
  timeline?: { account: AccountRef; action: 'initiated' | 'approved' | 'executed' | 'cancelled'; timestamp: string; extrinsicId: string }[]
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
  origin?: ExtrinsicOrigin
  // Optional here (list rows omit it on success); ExtrinsicDetail narrows this to
  // `FailureReason | null` always-present, hence the `| null` so the override
  // stays assignable to the base property type.
  errorReason?: FailureReason | null
}

export interface BlockEvent { eventIndex: number; extrinsicIndex: number | null; name: string; args: unknown; evmDecoded?: EvmLogDecode }
export interface BlockDetail extends BlockSummary {
  parentHash: string
  stateRoot: string | null
  extrinsicsRoot: string | null
  extrinsics: ExtrinsicSummary[]
  events: BlockEvent[]
  // How many of the block's events `events` carries — below eventCount on busy
  // blocks, where the list is a prefix.
  eventsShown?: number
}

export interface ExtrinsicEvent { eventIndex: number; name: string; args: unknown; decoded?: boolean; evmDecoded?: EvmLogDecode }
export interface ExtrinsicDetail extends ExtrinsicSummary {
  version: number
  tip: string | null
  callArgs: unknown
  error: unknown
  errorReason: FailureReason | null
  events: ExtrinsicEvent[]
  // Verified-ABI decodes of the extrinsic's EVM calls (top-level and nested in
  // wrapper call trees); absent when no target has a verified ABI.
  evmCalls?: DecodedEvmCall[]
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
  // `userTagId`/`listId`: same additive convention as TopAccountRow — set only
  // when this group folded under the viewer's own tag (served from
  // /user/holders). `memberCount` counts members holding this asset.
  tag: { tagId: string; name: string; color: string; icon: string; memberCount: number; userTagId?: string; listId?: string } | null
  balance: string
  lastBlock: number
  valueUsd?: number | null
  share?: number
}
export interface HoldersResponse { asset: AssetRef; holders: HolderRow[]; total: number; totalUsd: number }

// A lock decomposed by WHEN it can release: already releasable (an unlock or
// claim call away), scheduled for an estimated time, or open-ended while votes,
// delegations or staking stay active. Tranche amounts sum to the lock amount.
export interface BalanceLockTranche { state: 'releasable' | 'scheduled' | 'active'; amount: string; until?: string; linear?: boolean }
// One lock/reserve/hold/deposit component of an asset balance. Locks OVERLAP
// (the largest one is the binding amount); reserve-side kinds add up to the
// reserved figure.
export interface BalanceLockComponent { kind: 'lock' | 'reserve' | 'hold' | 'deposit'; source: string; amount: string; claimable?: string; tranches?: BalanceLockTranche[] }
// The binding unlock timeline across ALL of the account's locks: when how much
// of the frozen balance actually becomes transferable, and which lock causes it
// ('cause'; ties join with '+'). Act-now semantics: `conditional` marks slices
// that only free if the owner acts now (GIGAHDX staked → 28d after unstaking).
// Slice amounts sum to `frozen`.
export interface BalanceUnlockSlice { state: 'releasable' | 'scheduled' | 'active'; cause: string; amount: string; until?: string; linear?: boolean; conditional?: boolean }
// `frozen` is the non-transferable part of `free` (per-account max lock, summed
// across the account set for tags).
export interface AddressBalance { asset: AssetRef; total: string; free: string; reserved: string; frozen?: string; breakdown?: BalanceLockComponent[]; timeline?: BalanceUnlockSlice[]; lastBlock: number; valueUsd: number | null }
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
  // Seconds actually observed between this order's trades. `period` is a block
  // count and block time is not a constant (12s, ~6s, 2s ahead), so a duration
  // has to come from measurement, not multiplication. Null before two trades.
  periodSeconds: number | null
  // valueUsd is one trade at current prices, budgetUsd the whole remaining plan.
  valueUsd: number | null; budgetUsd: number | null
  // Owner's spendable balance of the sold asset, on open-ended orders only —
  // the only thing that can date an order with no budget to run out of.
  fundingBalance: string | null
  // That balance at current prices — the open-ended stand-in for budgetUsd.
  fundingUsd?: number | null
  scheduleBlock: number; scheduleIndex: number | null
  // The schedule's owner — redundant on an account's own page, but the asset
  // page lists schedules across owners, so each row names whose order it is.
  who?: AccountRef
}

// The asset page's DCAs tab: ongoing schedules buying the asset vs selling it.
export interface AssetDcas { buys: ActiveDca[]; sells: ActiveDca[] }
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
  isPure: { creator: AccountRef; proxyType: string; blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
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
  profile?: ProfileRef | null
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
  contract?: ContractInfo | null      // deployed EVM contract at this address
  portfolioSeries?: number[]
  portfolioDates?: string[]
  balanceHistory?: AssetBalanceHistory[]
}

export interface AssetBalancePoint { ts: string; blockHeight: number; balance: number }
export interface AssetBalanceHistory { asset: AssetRef; current: number; points: AssetBalancePoint[]; availableFrom?: string }
export interface AccountHistoryResponse { portfolioSeries: number[]; portfolioDates: string[]; balanceHistory: AssetBalanceHistory[] }

// One of the account/tag's largest value-changing events (big transfers in/out,
// swaps, liquidity moves, cross-chain flows, liquidations) — the value chart's
// clickable markers. A 'dca' marker stands for a whole schedule (its executions
// summed), not one swap; a 'price' marker annotates a big value-line jump no
// discrete event explains (its valueUsd is the SIGNED delta, asset is null).
export interface ValueEvent {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  kind: 'transfer-in' | 'transfer-out' | 'swap' | 'liquidity' | 'liquidation' | 'dca' | 'cross-chain' | 'price' | 'other'
  valueUsd: number
  asset: AssetRef | null
  counterparty: AccountRef | null
  // Cross-chain flow direction (inbound credit vs outbound send).
  direction?: 'in' | 'out'
  // false when a cross-chain marker has no resolvable detail row → render unlinked.
  linkable?: boolean
  // A 'dca' marker summarizes a whole schedule: id links to /dca/:id, trades is
  // the execution count behind valueUsd; block/event point at the peak execution.
  dcaScheduleId?: number
  dcaTrades?: number
  // Traded pair for swap/DCA markers; `asset` stays the value-bearing leg.
  assetIn?: AssetRef | null
  assetOut?: AssetRef | null
  // Raw token amount in `asset` decimals — only on single-event markers.
  amount?: string
}

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
  type: 'block' | 'extrinsic' | 'address' | 'asset' | 'tag' | 'referendum'
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
  // Referendum-type results carry pallet+index (its real identity — Democracy and
  // OpenGov both index from 0) and its lifecycle status, so the dropdown links
  // straight to `/referendum/:pallet/:index` with no follow-up fetch.
  pallet?: 'opengov' | 'democracy'
  index?: number
  status?: string
}

// Directory row for /explorer/tags. Members themselves come from the tag detail
// endpoint; the list only ever shows how many there are.
export interface Tag {
  tagId: string
  name: string
  color: string
  note: string
  icon: string
  memberCount: number
}

export interface IndexerStatus {
  blockHeight: number
  blockTimestamp: string
  lagSeconds: number
  chainBlockHeight: number
  blocksBehindHead: number
  // false when the API could not sample the chain head — blocksBehindHead is then
  // measured against raw ingestion's own head, so 0 does not mean "in sync".
  chainHeadSampled?: boolean
}

export interface EventRow {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  name: string
  args: unknown
  decoded: boolean
  evmDecoded?: EvmLogDecode
}

export interface EventDetail {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  name: string
  args: unknown
  decoded: boolean
  evmDecoded?: EvmLogDecode
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
    // The same canonical id local accountRefs carry — for a bound-EVM
    // AccountKey20 this differs from `raw` (the bare H160), so viewer-side
    // lookups (user tags, avatar URLs) must key on this, not on `raw`/`address`.
    // Optional only for old cached responses/fixtures that predate this field.
    kind: 'AccountId32' | 'AccountKey20'; accountId?: string; address: string; raw: string; subscanUrl: string | null
    emoji?: string; emojiName?: string; emojiUrl?: string
    tag?: TagRef | null
    identity?: { display: string; verified: boolean } | null
    profile?: ProfileRef | null
    isContract?: boolean
    contractName?: string
  }
  xcmDir?: 'in' | 'out'      // xcm: transfer direction relative to Hydration
  fromChain?: string         // xcm inbound: origin chain name
  fromParachainId?: number | null
  // Source account of an inbound transfer (best-effort — resolved server-side
  // from the Ocelloids crosschain index; absent for old rows or on API outage).
  fromAccount?: ActivityRow['destAccount']
  messageId?: string | null
  fromTxUrl?: string | null   // xcm inbound: origin-chain extrinsic on its explorer  // xcm inbound: message topic id
  // Destination-chain transaction, once the journey lands there — the far end's
  // counterpart to fromTxUrl.
  destTxUrl?: string | null
  // How the transfer crossed, when a bridge rather than only XCM carried it
  // ('Snowbridge', 'Wormhole', 'Basejump'). Resolved alongside fromChain, and not
  // versioned on purpose: Snowbridge v1 and v2 differ in the hops they take, not in
  // being Snowbridge, and the version is not always determinable.
  bridge?: string | null
  mmAction?: string
  mmMarketKey?: string
  mmMarket?: string
  stakingAction?: string
  votePallet?: string
  voteRefPallet?: 'opengov' | 'democracy' | null
  voteRefTitle?: string | null
  voteAction?: string
  voteRef?: string | null
  voteSide?: string
  voteConviction?: string | null
  liqAction?: 'Add' | 'Remove' | 'Create' | 'Claim' | 'Destroy'   // Create = pool creation; Destroy = pool closure; Claim = LM rewards
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
  weighted?: string | null
  voteRefPallet?: 'opengov' | 'democracy' | null
  voteRefTitle?: string | null
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

// One referendum's combined vote across a tag's members (the votes tab's
// grouped mode): each member's latest vote summed as integers. The average
// conviction is derived client-side from weighted/amount (avgConvictionLabel).
export interface VoteGroupRow {
  pallet: string
  referendum: string | null
  voteRefPallet?: 'opengov' | 'democracy' | null
  voteRefTitle?: string | null
  side: string
  voters: number
  weighted: string | null
  amount: string | null
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  asset: AssetRef
  valueUsd: number | null
}
// `complete: false` = the members' vote history ran past the aggregation's scan
// ceiling, so rows cover only the newest part of it.
export interface VotesByReferendumPage { rows: VoteGroupRow[]; total: number; complete: boolean }

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

// One day of collateral seized from borrowers in the primary money market:
// `amount` is the raw token amount, `valueUsd` its value at the time it happened.
export interface AssetLiquidationDay { date: string; valueUsd: number; amount: string; count: number }
export interface AssetLiquidationTotal { valueUsd: number; amount: string; count: number }
export interface AssetLiquidations {
  // The basis every `amount` here is expressed in — not necessarily the page
  // asset's own, since the reserve can be a pool-share token with different
  // decimals (2-Pool-PRIME 18 vs PRIME 6). Format amounts with THIS.
  decimals: number
  days: AssetLiquidationDay[]
  total: AssetLiquidationTotal
}

export interface AssetDetail {
  asset: AssetListItem
  holderCount: number
  // Ongoing DCA schedules buying or selling this asset (the DCAs tab badge).
  dcaCount: number
  totalUsd: number
  priceSeries: number[]
  priceDates?: string[]
  // Absent/null unless the asset is or has been a primary money-market reserve.
  liquidations?: AssetLiquidations | null
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

// One leg of a DCA schedule's route. Only Stableswap names a specific pool; the
// other venues are a single pool each.
export interface DcaRouteHop { pool: string; poolId: number | null; assetIn: AssetRef; assetOut: AssetRef }

export interface DcaScheduleDetail {
  scheduleId: number
  who: AccountRef | null
  createdAt: { blockHeight: number; timestamp: string; extrinsicIndex: number | null }
  assetIn: AssetRef
  assetOut: AssetRef
  // 'Sell' | 'Buy' ('' for pre-router schedules). amountPer follows it: the
  // sold (in) amount for Sell orders, the bought (out) amount for Buy orders.
  direction: string
  amountPer: string
  totalAmount: string
  // What one trade and the whole budget are worth — at today's price while the
  // schedule is live, at the price of the day it stopped once it has finished
  // (the era its own executions traded in).
  amountPerUsd: number | null
  budgetUsd: number | null
  usdBasis: 'current' | 'ended'
  period: number
  // Seconds actually observed between this schedule's trades (median of its most
  // recent gaps), null before it has run twice. See ActiveDca.periodSeconds.
  periodSeconds: number | null
  // Null means the schedule set none (the runtime default applies) or that it was
  // submitted through an EVM permit whose inner call is not indexed — neither is a
  // real zero, so both render as unknown rather than "0 retries".
  maxRetries: number | null
  // Per-execution slippage tolerance against the oracle price, as a Permill
  // (30000 = 3%). Same Option caveat as maxRetries.
  slippagePermill: number | null
  // The order's own absolute price bound, fixed for its whole life: a Sell floors
  // what each trade receives, a Buy caps what each trade pays. Only the one the
  // direction defines is ever set.
  minAmountOut: string | null
  maxAmountIn: string | null
  // The path each execution trades through. An EMPTY array is a real answer: the
  // order named no path, so the router picks one per execution. Null = unknown.
  route: DcaRouteHop[] | null
  // Highest block the pallet has planned an execution for — the anchor for the
  // next-execution countdown and the budget's remaining runway.
  nextExecutionBlock: number | null
  // Owner's spendable balance of the sold asset, on live open-ended schedules
  // only: what dates an order that has no budget to exhaust.
  fundingBalance: string | null
  status: 'active' | 'completed' | 'terminated' | 'cancelled'
  statusAt: string | null
  // Named termination reason for error terminations (e.g. "token frozen").
  statusReason: string | null
  executions: { count: number; failed: number; attempts: number; totalIn: string; totalOut: string }
  rows: ActivityRow[]
}

// A single DCA execution attempt (one row on the schedule page), addressed by
// its execution event. Executed attempts carry both legs and a price; failed
// attempts carry only the schedule's fixed per-trade leg (the sold amount for
// Sell orders, the bought amount for Buy orders) and a decoded failure reason.
export interface DcaExecutionDetail {
  scheduleId: number
  status: 'executed' | 'failed'
  who: AccountRef | null
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  assetIn: AssetRef
  assetOut: AssetRef
  amountIn: string | null
  amountOut: string | null
  valueUsd: number | null
  executionPrice: number | null
  period: number
  failureReason: FailureReason | null
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

export interface ReferendumTally { ayes: string; nays: string; support: string | null }

// The chain's own tally with the provenance that says whether it still holds. `final`
// marks a concluding event's tally — the referendum's last word. A running referendum
// only ever published a Referenda.DecisionStarted snapshot, taken as the decision
// period opened and left behind by every vote since; the live tally sits in chain
// storage, which is not indexed. See selectTally.
export interface OnChainTally extends ReferendumTally {
  final: boolean
  blockHeight: number
  timestamp: string
}

export interface ReferendumDetail {
  pallet: 'opengov' | 'democracy'
  index: number
  title: string | null
  subsquareUrl: string
  track: number | null
  proposalHash: string | null
  proposalCall: { pallet: string; callName: string; args: unknown; encoded: string | null; byteLength: number; decodeError: string | null } | null
  status: string
  submittedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
  concludedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
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
}

// A user-authored tag list: a named, ownable collection of tags an account
// created to organize other accounts (mirrors the built-in Tag directory, but
// user-owned and optionally shared). `isPersonal` marks the one list every
// account gets automatically and cannot delete or leave.
export interface ListSummaryRef {
  listId: string
  name: string
  note: string
  visibility: 'private' | 'public'
  isPersonal: boolean
  owner: AccountRef
  tagCount: number
  accountCount: number
  subscriberCount: number
}

export interface ListTagDetail {
  tagId: string
  name: string
  color: string
  // The RAW stored icon — '' when unset. This is what an edit form must seed
  // from and resubmit; `checkIcon` server-side rejects anything URL-shaped,
  // so seeding an edit from `displayIcon` (which can be a profile-avatar URL
  // once the first-member fallback engages) would 422 a plain rename.
  icon: string
  // The DISPLAY icon — `icon` if set, else derived from the first member
  // (see tagDisplayIcon server-side). Every display surface (this page's own
  // header/pill, tag-map pills elsewhere) uses this, never `icon` directly.
  displayIcon: string
  note: string
  members: AccountRef[]
}

export interface ListDetailResponse extends ListSummaryRef {
  tags: ListTagDetail[]
  // Present only when the viewer is authenticated and not the owner — whether
  // they already subscribe to this (public) list.
  subscribed?: boolean
  // Owner-only (Subscribers tab): every account with a live invite or an
  // active subscription. Absent for every other viewer, including the
  // anonymous public detail — never an empty array standing in for "no
  // access", so the tab can tell "no subscribers yet" apart from "not yours
  // to see".
  shares?: { account: AccountRef; status: 'invited' | 'active' }[]
}

// The viewer's tag-map projection: every list's tags reduced to member
// addresses, for local pill resolution without a round trip per tag. The
// 'system' entry stands for the built-in Tag directory (no list owns it).
export interface TagMapList {
  listId: string
  name: string
  tags: { tagId: string; name: string; color: string; icon: string; members: string[] }[]
}
export interface TagMapResponse { lists: TagMapList[] }

export interface MeResponse {
  account: AccountRef
  profile: ProfileRef | null
  lists: ListSummaryRef[]
  subscriptions: ListSummaryRef[]
  invites: ListSummaryRef[]
  order: string[]
}

export interface LoginChallengeResponse { nonce: string; message: string }
export interface LoginResponse { token: string; me: MeResponse }

// QR device-link handoff: `code` goes into the QR only, `linkId` is the handle
// the issuing device polls with (never the code itself).
export interface DeviceLinkResponse { code: string; linkId: string; expiresAt: string }
export type DeviceLinkStatus = 'pending' | 'claimed' | 'expired'
// One live session on the devices list; `id` is the server-side token hash —
// the handle revocation takes — never a usable token.
export interface DeviceSession { id: string; label: string; createdVia: string; createdAt: string; lastSeen: string; current: boolean }
