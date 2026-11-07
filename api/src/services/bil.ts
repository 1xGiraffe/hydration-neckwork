// Brazilian Invoice Loans (BIL) — galacticcouncil/money-market `bil-vault`, the strategy
// behind app.hydration.net/strategies/bil-vault. The pure leaf: the deployment's
// addresses, the topics the explorer reads, their decoders and the arithmetic every
// surface shares. No I/O.
//
// How it works (the contracts' own model, and the terms the official app uses):
//  - The BIL vault (`BILVault`, ERC-4626 + ERC-7540) takes HOLLAR and mints uBIL (asset
//    550). It invests every deposit in a fixed-rate DECENTRAL position — a NFT of the
//    Decentral lending pool, which finances Brazilian invoice receivables at a fixed
//    18% APY over a 60-day term — and keeps one position per deposit or reinvestment.
//  - The app deposits through the deposit ZAP: HOLLAR → vault.deposit → the uBIL is
//    supplied to the isolated BIL money market on the depositor's behalf, so what the
//    depositor holds is BIL (asset 55), that market's aToken over uBIL, minted 1:1.
//  - A share's value is the vault's exchange rate (`exchangeRate`, HOLLAR per uBIL):
//    each position accrues simple interest until its maturity. Matured positions are
//    redeemed from Decentral (interest, then principal) and the HOLLAR is reinvested
//    or pays the redemption queue.
//  - The way out is a REDEMPTION REQUEST (`requestRedeem`): the uBIL goes into escrow
//    in the vault and keeps earning; the queue is paid FIFO from idle HOLLAR and
//    maturing positions, each settlement fixing the HOLLAR owed at the rate of the
//    moment (`RedemptionFulfilled` / `…PartiallyFulfilled`); the controller (or a keeper
//    on an auto-claim opt-in) then CLAIMS it (`Withdraw`). The unsettled part can be
//    cancelled. The instant way out is the BIL/HOLLAR stableswap pool (10055), whose
//    BIL leg is pegged to the vault's rate through the BIL/USD oracle.
//
// Verified on chain (block 16,734,600): the vault's 466 positions are exactly the
// Decentral `Deposited` logs it is the investor of, in order (index i = the i-th), the
// 282 not yet `PositionRedeemed` sum to `totalInvestedPrincipal` to the wei, and their
// uncapped 18% rate sums to `yieldRateSum`.

export const BIL_VAULT = '0x6a21891db0940491603f3cca0a9f4dba4c6e810c'
export const BIL_ZAP = '0x646fd203bbcf19b35d79f58413bb07450fdbb1db'
export const DECENTRAL_POOL = '0x207a626c07b73e76134177d1f44b0f32e94adb5a'
/** The Decentral pool's position NFT (PoolToken). */
export const DECENTRAL_POOL_TOKEN = '0xc91808c129c9766b13d22c9f0cd53db459c0bc48'
/** BIL (asset 55): the isolated BIL money market's aToken over uBIL. */
export const BIL_ATOKEN = '0x8184e2f7c477d165772c21f7a2dbbb61a76e7fc4'
export const BIL_MM_POOL = '0x69310fda58c819ad82df7d2cb61841c853337a53'
/** uBIL's money-market reserve address (the asset-id precompile of asset 550). */
export const UBIL_RESERVE = '0x0000000000000000000000000000000100000226'
/** The BIL / USD oracle: a read-through of the vault's exchange rate (the pool's peg source). */
export const BIL_ORACLE = '0xb9947cacebd0f23de3b59c369cd710137739cd83'
export const BIL_HOLLAR_CONTRACT = '0x531a654d1696ed52e7275a8cede955e82620f99a'
export const BIL_ASSET_ID = 55
export const UBIL_ASSET_ID = 550
export const BIL_HOLLAR_ASSET_ID = 222
/** The BIL/HOLLAR stableswap pool — the instant way out. */
export const BIL_POOL_ID = 10055
const WAD = 10n ** 18n
const YEAR_SEC = 365n * 86_400n

/**
 * The CUSTODY accounts: what they hold is what uBIL's holders own, so none of it is the
 * account's own value — the vault (escrowed uBIL of open requests, HOLLAR reserved for
 * settled claims, idle HOLLAR) and the Decentral pool (the HOLLAR the vault invested
 * that the borrower has not drawn; the vault's rate already counts it as principal).
 * The pool's custody also covers about 97 HOLLAR of three non-vault investors from its
 * test era (0xe6af…240b, 0x96c2…10a2, 0x553f…7775) — positions no share restates, left
 * uncounted with the rest rather than split out of a pool that is overwhelmingly BIL's.
 */
export const BIL_CUSTODY_CONTRACTS: readonly string[] = [BIL_VAULT, DECENTRAL_POOL]
/** Every BIL contract: the set whose transfer legs a BIL row owns. */
export const BIL_CONTRACTS: readonly string[] = [BIL_VAULT, BIL_ZAP, DECENTRAL_POOL]

// topic0 of every log bil_logs keeps (keccak256 of the deployed ABI's signature).
export const BIL_TOPIC = {
  // BILVault
  Deposited: '0x91ede45f04a37a7c170f5c1207df3b6bc748dc1e04ad5e917a241d0f52feada3', // (address indexed user, uint256 hollarAmount, uint256 bilMinted, uint256 tokenId)
  RedeemRequest: '0x1fdc681a13d8c5da54e301c7ce6542dcde4581e4725043fdab2db12ddc574506', // (address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares)
  RedemptionCancelled: '0x429a07ce530fc7ce775a386bf2799667fc99df434cbef3c39dc263ad03f31c1a', // (uint256 indexed requestId, uint256 bilReturned)
  RedemptionFulfilled: '0x3a371cdd24458d5e2b7d414f2f40571376e0cfb7bd07effac6736e28558a189d', // (uint256 indexed requestId, address indexed user, uint256 hollarAmount, uint256 bilBurned)
  RedemptionPartiallyFulfilled: '0x9270c1fc51d6d3b190380df88519255073460ed60bc47c56f0cb37c3776a3dd0', // same shape
  Withdraw: '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db', // (address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)
  Reinvested: '0x61d66d8767ff702762e19c18b3cf4a23e2eef70b62fde2720244871ba6d796c7', // (uint256 hollarAmount, uint256 tokenId)
  ReinvestFailed: '0x0d9763ad6ea267ddc78f78e316c8cbe385b21db691232b45a44103a0cdc2ff8f', // (uint256 hollarAmount)
  PositionProcessed: '0xf2e373d95d66b0a34dd924c743f7c44aaf27bbef27ccaf264402dcfbdd8663e1', // (uint256 indexed positionIndex, uint256 tokenId, uint8 newState)
  PositionRedeemed: '0xf048617759ece50cdfd9ea84362581c37b711061101c52c6611eff62a5f3c9dc', // (uint256 indexed positionIndex, uint256 tokenId, uint256 yieldReceived, uint256 principalReceived)
  PositionYieldCapped: '0x021bd3cefbdeda24b76ad254e7640f591a9e15f86d1fd4a936c99d10ad8d996a', // (uint256 indexed positionIndex, uint256 maturityTime, uint256 pendingYield)
  PrincipalMismatch: '0xed4f44489e84da980c7e66e47d6a3449b2079b4195e282a6494db6435953037c', // (uint256 indexed positionIndex, uint256 indexed tokenId, uint256 expected, uint256 received, int256 delta)
  TvlCapUpdated: '0x2923cecec41b7140eaf657a035af4abb23ed61d16b1fc20a986838eb3ad99bd0', // (uint256 newCap)
  DepositsPaused: '0xdeeb69430b7153361c25d630947115165636e6a723fa8daea4b0de34b3247459', // ()
  DepositsUnpaused: '0x823084e804e36d8971e8b86749b6b0ace7b9f87ed272bef910c1e72d123eeb48', // ()
  Paused: '0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258', // (address account)
  Unpaused: '0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa', // (address account)
  MinRedeemAmountUpdated: '0xae6971e30edc181eba4e21b6f0d1238924e807e69aa92f89401c1a836dd71547', // (uint256 newAmount)
  MinReinvestAmountUpdated: '0x1dae0402eab298ec097ac31ac53541036fdec00a2ad067393523f3733b2a28da', // (uint256 newAmount)
  AutoClaimSet: '0x4b6ced08f677a1ad8fb39b5839f2d09a3676a11641bdd563ff683b5e8edb2eaa', // (address indexed controller, bool enabled)
  ActiveDepositPoolSet: '0x5d040cb5179bba6b364a85c791335d67976b938a75b6e95c0678e5618c928ed5', // (address indexed pool)
  // BILDepositZap
  DepositAndSupply: '0x93eb214b78d4914cd87b8ea2e126beb23b18c40a67418c704bf1dbc1e05af2aa', // (address indexed user, uint256 hollarAmount, uint256 bilMinted)
  // DecentralPool
  PoolDeposited: '0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca', // Deposited(address indexed investor, uint256 indexed tokenId, uint256 principalAmount)
  YieldWithdrawn: '0x2bf878084037ba4fb4363629d72708a5bb8e8e0de5af9fe03d987d5289f6f4a2', // (address indexed investor, uint256 indexed tokenId, uint256 amount)
  PrincipalWithdrawn: '0x217ea3989b9d3112d2133a930216f444b7fbcaeaa4d5bc0220d099fdc928e71e', // (address indexed investor, uint256 indexed tokenId, uint256 amount)
  Borrowed: '0xac59582e5396aca512fa873a2047e7f4c80f8f55d4a06cb34a78a0187f62719f', // (address indexed borrower, uint256 amount)
  // HOLLAR — a Transfer into or out of the Decentral pool whose other party is not the vault
  Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // (address indexed from, address indexed to, uint256 value)
} as const
export type BilTopicName = keyof typeof BIL_TOPIC
const TOPIC_NAME = new Map<string, BilTopicName>()
for (const [k, v] of Object.entries(BIL_TOPIC)) if (!TOPIC_NAME.has(v)) TOPIC_NAME.set(v, k as BilTopicName)

const VAULT_TOPICS: readonly string[] = [
  BIL_TOPIC.Deposited, BIL_TOPIC.RedeemRequest, BIL_TOPIC.RedemptionCancelled, BIL_TOPIC.RedemptionFulfilled, BIL_TOPIC.RedemptionPartiallyFulfilled,
  BIL_TOPIC.Withdraw, BIL_TOPIC.Reinvested, BIL_TOPIC.ReinvestFailed, BIL_TOPIC.PositionProcessed, BIL_TOPIC.PositionRedeemed,
  BIL_TOPIC.PositionYieldCapped, BIL_TOPIC.PrincipalMismatch, BIL_TOPIC.TvlCapUpdated, BIL_TOPIC.DepositsPaused, BIL_TOPIC.DepositsUnpaused,
  BIL_TOPIC.Paused, BIL_TOPIC.Unpaused, BIL_TOPIC.MinRedeemAmountUpdated, BIL_TOPIC.MinReinvestAmountUpdated, BIL_TOPIC.AutoClaimSet,
  BIL_TOPIC.ActiveDepositPoolSet,
]
const POOL_TOPICS: readonly string[] = [BIL_TOPIC.PoolDeposited, BIL_TOPIC.YieldWithdrawn, BIL_TOPIC.PrincipalWithdrawn, BIL_TOPIC.Borrowed]
/** Each contract bil_logs copies from, with the topics it keeps (the MV's predicate, verbatim). */
export const BIL_LOG_SOURCES: ReadonlyArray<{ contract: string; topics: readonly string[] }> = [
  { contract: BIL_VAULT, topics: VAULT_TOPICS },
  { contract: BIL_ZAP, topics: [BIL_TOPIC.DepositAndSupply] },
  { contract: DECENTRAL_POOL, topics: POOL_TOPICS },
]
const pad = (h160: string) => '0x' + '0'.repeat(24) + h160.slice(2).toLowerCase()
const q = (s: string) => `'${s}'`

// The bil_logs MV's WHERE and SELECT over raw_evm_logs (019_bil.sql states them verbatim,
// pinned by bilSchema.test.ts; the DATA_UPGRADES entry replays them).
// It leads with the topic set (every kept topic, Transfer included) so a part of raw that
// holds none is skipped before any contract test.
const ALL_TOPICS = [...new Set([...BIL_LOG_SOURCES.flatMap(s => s.topics), BIL_TOPIC.Transfer])]
export const BIL_LOGS_WHERE = `raw_evm_logs.topic0 IN (${ALL_TOPICS.map(q).join(', ')}) AND (` + [
  ...BIL_LOG_SOURCES.map(s => `(lower(raw_evm_logs.contract_address) = ${q(s.contract)} AND raw_evm_logs.topic0 IN (${s.topics.map(q).join(', ')}))`),
  `(lower(raw_evm_logs.contract_address) = ${q(BIL_HOLLAR_CONTRACT)} AND raw_evm_logs.topic0 = ${q(BIL_TOPIC.Transfer)} AND length(topics) >= 3`
    + ` AND ((topics[2] = ${q(pad(DECENTRAL_POOL))} AND topics[3] != ${q(pad(BIL_VAULT))}) OR (topics[3] = ${q(pad(DECENTRAL_POOL))} AND topics[2] != ${q(pad(BIL_VAULT))})))`,
].join(' OR ') + ')'
// `party`: the account the log names as its user, lowercase H160 — a deposit's user,
// a request's owner, a settlement's and a claim's controller, an auto-claim toggle's
// controller, a Decentral investor or borrower, a HOLLAR transfer's party other than
// the pool; '' for the strategy's own logs (a cancellation names its request only).
const t0 = "ifNull(raw_evm_logs.topic0, '')"
const addrAt = (i: number) => `lower(concat('0x', substring(topics[${i}], 27, 40)))`
export const BIL_LOGS_PARTY = `multiIf(`
  + `${t0} IN (${[BIL_TOPIC.Deposited, BIL_TOPIC.DepositAndSupply, BIL_TOPIC.AutoClaimSet, BIL_TOPIC.PoolDeposited, BIL_TOPIC.YieldWithdrawn, BIL_TOPIC.PrincipalWithdrawn, BIL_TOPIC.Borrowed].map(q).join(', ')}) AND length(topics) >= 2, ${addrAt(2)}, `
  + `${t0} IN (${[BIL_TOPIC.RedeemRequest, BIL_TOPIC.RedemptionFulfilled, BIL_TOPIC.RedemptionPartiallyFulfilled].map(q).join(', ')}) AND length(topics) >= 3, ${addrAt(3)}, `
  + `${t0} = ${q(BIL_TOPIC.Withdraw)} AND length(topics) >= 4, ${addrAt(4)}, `
  + `${t0} = ${q(BIL_TOPIC.Transfer)} AND length(topics) >= 3, if(topics[2] = ${q(pad(DECENTRAL_POOL))}, ${addrAt(3)}, ${addrAt(2)}), `
  + `'')`
export const BIL_LOGS_SELECT = `block_height, event_index, extrinsic_index, block_timestamp, lower(raw_evm_logs.contract_address) AS contract_address, ${t0} AS topic0, topics, data, ${BIL_LOGS_PARTY} AS party, ingested_at`

/** One bil_logs row as read. */
export interface BilLogRow {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  ts: string
  contract_address: string
  topic0: string
  topics: string[]
  data: string
}

function dataWord(data: string, i: number): bigint | null {
  const hex = (data ?? '').replace(/^0x/, '')
  if (hex.length < 64 * (i + 1)) return null
  return BigInt('0x' + hex.slice(64 * i, 64 * (i + 1)))
}
function topicWord(topics: string[], i: number): bigint | null {
  const t = topics[i]
  return t && /^0x[0-9a-f]{64}$/i.test(t) ? BigInt(t) : null
}
function topicAddress(topics: string[], i: number): string | null {
  const t = topics[i]
  return t && /^0x[0-9a-f]{64}$/i.test(t) ? '0x' + t.slice(26).toLowerCase() : null
}
const dataAddress = (data: string, i: number): string | null => {
  const w = dataWord(data, i)
  return w == null ? null : '0x' + w.toString(16).padStart(40, '0')
}
const num = (v: bigint | null): number | undefined => v == null || v > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(v)
const str = (v: bigint | null): string | undefined => v == null ? undefined : v.toString()

/** A position's state on the vault (IBILVault.NFTState). */
export const BIL_POSITION_STATE = ['active', 'yield-requested', 'yield-claimed', 'principal-requested', 'redeemed'] as const
export type BilPositionState = typeof BIL_POSITION_STATE[number]

export interface BilEvent {
  name: BilTopicName
  contract: string
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  /** The account the log names as its user (see BIL_LOGS_PARTY). */
  party: string | null
  user?: string
  owner?: string
  controller?: string
  receiver?: string
  sender?: string
  requestId?: number
  positionIndex?: number
  tokenId?: string
  /** HOLLAR raw. */
  hollar?: string
  /** uBIL raw (shares). */
  shares?: string
  newState?: number
  yieldReceived?: string
  principalReceived?: string
  maturityTime?: number
  pendingYield?: string
  amount?: string
  enabled?: boolean
  from?: string
  to?: string
  partial?: boolean
}

/** Decodes one bil_logs row; null for a row it does not read (or a malformed one). */
export function decodeBilLog(r: BilLogRow): BilEvent | null {
  const name = TOPIC_NAME.get((r.topic0 ?? '').toLowerCase())
  if (!name) return null
  const contract = (r.contract_address ?? '').toLowerCase()
  const t = r.topics ?? [], d = r.data ?? '0x'
  const base: BilEvent = {
    name, contract, blockHeight: Number(r.block_height), eventIndex: Number(r.event_index),
    extrinsicIndex: r.extrinsic_index == null ? null : Number(r.extrinsic_index),
    timestamp: r.ts.includes('T') ? r.ts : r.ts.replace(' ', 'T') + 'Z', party: null,
  }
  const w = (i: number) => dataWord(d, i)
  // The vault's PoolDeposited/Transfer share topics with nothing else; the contract decides.
  switch (name) {
    case 'Deposited': {
      if (contract !== BIL_VAULT) return null
      const user = topicAddress(t, 1)
      return { ...base, party: user, user: user ?? undefined, hollar: str(w(0)), shares: str(w(1)), tokenId: str(w(2)) }
    }
    case 'DepositAndSupply': {
      const user = topicAddress(t, 1)
      return { ...base, party: user, user: user ?? undefined, hollar: str(w(0)), shares: str(w(1)) }
    }
    case 'RedeemRequest': {
      const controller = topicAddress(t, 1), owner = topicAddress(t, 2)
      return { ...base, party: owner, controller: controller ?? undefined, owner: owner ?? undefined, requestId: num(topicWord(t, 3)), sender: dataAddress(d, 0) ?? undefined, shares: str(w(1)) }
    }
    case 'RedemptionCancelled':
      return { ...base, requestId: num(topicWord(t, 1)), shares: str(w(0)) }
    case 'RedemptionFulfilled':
    case 'RedemptionPartiallyFulfilled': {
      const user = topicAddress(t, 2)
      return { ...base, party: user, controller: user ?? undefined, requestId: num(topicWord(t, 1)), hollar: str(w(0)), shares: str(w(1)), partial: name === 'RedemptionPartiallyFulfilled' }
    }
    case 'Withdraw': {
      if (contract !== BIL_VAULT) return null
      const controller = topicAddress(t, 3)
      return { ...base, party: controller, sender: topicAddress(t, 1) ?? undefined, receiver: topicAddress(t, 2) ?? undefined, controller: controller ?? undefined, hollar: str(w(0)), shares: str(w(1)) }
    }
    case 'Reinvested':
      return { ...base, hollar: str(w(0)), tokenId: str(w(1)) }
    case 'ReinvestFailed':
      return { ...base, hollar: str(w(0)) }
    case 'PositionProcessed':
      return { ...base, positionIndex: num(topicWord(t, 1)), tokenId: str(w(0)), newState: num(w(1)) }
    case 'PositionRedeemed':
      return { ...base, positionIndex: num(topicWord(t, 1)), tokenId: str(w(0)), yieldReceived: str(w(1)), principalReceived: str(w(2)) }
    case 'PositionYieldCapped':
      return { ...base, positionIndex: num(topicWord(t, 1)), maturityTime: num(w(0)), pendingYield: str(w(1)) }
    case 'PrincipalMismatch':
      return { ...base, positionIndex: num(topicWord(t, 1)), tokenId: str(topicWord(t, 2)), amount: str(w(1)) }
    case 'TvlCapUpdated':
    case 'MinRedeemAmountUpdated':
    case 'MinReinvestAmountUpdated':
      return { ...base, amount: str(w(0)) }
    case 'DepositsPaused':
    case 'DepositsUnpaused':
    case 'Paused':
    case 'Unpaused':
    case 'ActiveDepositPoolSet':
      return contract === BIL_VAULT ? base : null
    case 'AutoClaimSet': {
      const controller = topicAddress(t, 1)
      return { ...base, party: controller, controller: controller ?? undefined, enabled: (w(0) ?? 0n) !== 0n }
    }
    case 'PoolDeposited':
    case 'YieldWithdrawn':
    case 'PrincipalWithdrawn': {
      if (contract !== DECENTRAL_POOL) return null
      const investor = topicAddress(t, 1)
      return { ...base, party: investor, user: investor ?? undefined, tokenId: str(topicWord(t, 2)), hollar: str(w(0)) }
    }
    case 'Borrowed': {
      const borrower = topicAddress(t, 1)
      return { ...base, party: borrower, user: borrower ?? undefined, hollar: str(w(0)) }
    }
    case 'Transfer': {
      if (contract !== BIL_HOLLAR_CONTRACT) return null
      const from = topicAddress(t, 1), to = topicAddress(t, 2)
      if (!from || !to) return null
      return { ...base, party: from === DECENTRAL_POOL ? to : from, from, to, hollar: str(w(0)) }
    }
  }
  return null
}

// Activity actions, in the official app's terms. `Redeem` is the request (uBIL into the
// queue), `Settle` a settlement fixing the HOLLAR owed, `Claim` the payout; the vault's
// own `Reinvest`, `Interest` and `Principal` are Decentral positions opened and paid
// back; `Draw` / `Repay` are the Decentral borrower taking and returning the pool's HOLLAR.
export const BIL_ACTIONS = ['Deposit', 'Redeem', 'Cancel', 'Settle', 'Claim', 'Reinvest', 'Interest', 'Principal', 'Draw', 'Repay'] as const
export type BilAction = typeof BIL_ACTIONS[number]
/** The feed's `action` slugs (`bil-*`), the activity page routes. */
export const BIL_ACTION_SLUGS: Record<string, BilAction> = {
  'bil-deposit': 'Deposit', 'bil-redeem': 'Redeem', 'bil-cancel': 'Cancel', 'bil-settle': 'Settle', 'bil-claim': 'Claim',
  'bil-reinvest': 'Reinvest', 'bil-interest': 'Interest', 'bil-principal': 'Principal', 'bil-draw': 'Draw', 'bil-repay': 'Repay',
}
export function bilActionSlug(action: BilAction): string {
  return Object.entries(BIL_ACTION_SLUGS).find(([, a]) => a === action)![0]
}

/**
 * The Decentral pool's borrowers: every account a `Borrowed` log names. A HOLLAR transfer
 * between the pool and one of them is a draw or a repayment; the pool's other non-vault
 * transfers (its own investors before BIL, tests) are not BIL acts.
 */
export function decentralBorrowers(events: readonly BilEvent[]): Set<string> {
  return new Set(events.filter(e => e.name === 'Borrowed' && e.user).map(e => e.user!))
}
/**
 * The block the vault first invested in the Decentral pool. The pool lent to its
 * borrower before BIL existed (the Treasury's 2026 pilot); a draw or repayment is a BIL
 * act from this block on.
 */
export function bilFirstInvestmentBlock(events: readonly BilEvent[]): number | null {
  let first: number | null = null
  for (const e of events) if (e.name === 'PoolDeposited' && e.user === BIL_VAULT && (first == null || e.blockHeight < first)) first = e.blockHeight
  return first
}

/**
 * Which logs are which row: ONE table both classifiers read — bilActionOf over decoded
 * logs (the feeds) and bilActionRowSql over bil_logs (the per-day counts) — so the two
 * cannot disagree. A rule names the contract and topics, and optionally the `party` the
 * row requires (`party`: equal, `partyNot`: different) or, for a HOLLAR transfer, the
 * side the Decentral pool is on (`poolSide`), which then also requires the other party
 * to be a Decentral borrower (an account a `Borrowed` log names) and the block to be at
 * or after the vault's first investment. Settings, position bookkeeping, the vault's
 * half of a zapped deposit and a Decentral investment (the deposit's or reinvestment's
 * own plumbing) are no rule, so no row.
 */
export interface BilActionRule { contract: string; topics: readonly string[]; party?: string; partyNot?: string; poolSide?: 'from' | 'to' }
export const BIL_ACTION_RULES: Record<BilAction, readonly BilActionRule[]> = {
  // A deposit through the zap is the zap's DepositAndSupply (it names the depositor); the
  // vault's own Deposited only when its receiver is not the zap.
  Deposit: [{ contract: BIL_ZAP, topics: [BIL_TOPIC.DepositAndSupply] }, { contract: BIL_VAULT, topics: [BIL_TOPIC.Deposited], partyNot: BIL_ZAP }],
  Redeem: [{ contract: BIL_VAULT, topics: [BIL_TOPIC.RedeemRequest] }],
  Cancel: [{ contract: BIL_VAULT, topics: [BIL_TOPIC.RedemptionCancelled] }],
  Settle: [{ contract: BIL_VAULT, topics: [BIL_TOPIC.RedemptionFulfilled, BIL_TOPIC.RedemptionPartiallyFulfilled] }],
  Claim: [{ contract: BIL_VAULT, topics: [BIL_TOPIC.Withdraw] }],
  Reinvest: [{ contract: BIL_VAULT, topics: [BIL_TOPIC.Reinvested] }],
  Interest: [{ contract: DECENTRAL_POOL, topics: [BIL_TOPIC.YieldWithdrawn], party: BIL_VAULT }],
  Principal: [{ contract: DECENTRAL_POOL, topics: [BIL_TOPIC.PrincipalWithdrawn], party: BIL_VAULT }],
  Draw: [{ contract: BIL_HOLLAR_CONTRACT, topics: [BIL_TOPIC.Transfer], poolSide: 'from' }],
  Repay: [{ contract: BIL_HOLLAR_CONTRACT, topics: [BIL_TOPIC.Transfer], poolSide: 'to' }],
}

/** The row action a decoded log is (BIL_ACTION_RULES), or null when it is no row. */
export function bilActionOf(e: BilEvent, borrowers: ReadonlySet<string>, sinceBlock: number | null): BilAction | null {
  const topic = BIL_TOPIC[e.name]
  for (const action of BIL_ACTIONS) {
    for (const r of BIL_ACTION_RULES[action]) {
      if (r.contract !== e.contract || !r.topics.includes(topic)) continue
      if (r.party != null && e.party !== r.party) continue
      if (r.partyNot != null && (e.party == null || e.party === r.partyNot)) continue
      if (r.poolSide) {
        if (sinceBlock == null || e.blockHeight < sinceBlock) continue
        const pool = r.poolSide === 'from' ? e.from : e.to
        if (pool !== DECENTRAL_POOL || e.party == null || !borrowers.has(e.party)) continue
      }
      return action
    }
  }
  return null
}

/**
 * The SQL predicate over bil_logs selecting the rows of one action — BIL_ACTION_RULES as
 * SQL, the activity chart's per-day counts.
 */
export function bilActionRowSql(action: BilAction): string {
  const borrowers = `(SELECT party FROM price_data.bil_logs WHERE topic0 = ${q(BIL_TOPIC.Borrowed)})`
  const since = `block_height >= (SELECT min(block_height) FROM price_data.bil_logs WHERE topic0 = ${q(BIL_TOPIC.PoolDeposited)} AND party = ${q(BIL_VAULT)})`
  const arms = BIL_ACTION_RULES[action].map(r => [
    `contract_address = ${q(r.contract)}`,
    r.topics.length === 1 ? `topic0 = ${q(r.topics[0])}` : `topic0 IN (${r.topics.map(q).join(', ')})`,
    ...(r.party != null ? [`party = ${q(r.party)}`] : []),
    ...(r.partyNot != null ? [`party != ${q(r.partyNot)}`] : []),
    ...(r.poolSide ? [`topics[${r.poolSide === 'from' ? 2 : 3}] = ${q(pad(DECENTRAL_POOL))}`, `party IN ${borrowers}`, since] : []),
  ].join(' AND '))
  return `(${arms.map(a => `(${a})`).join(' OR ')})`
}

/**
 * The registry assets a row of each action moves — what an asset page, a token filter
 * and the per-day counts match it on. A zapped deposit mints uBIL and hands the depositor
 * BIL; a settlement fixes HOLLAR for queued uBIL; the strategy's own flows are HOLLAR.
 */
export const BIL_ACTION_ASSETS: Record<BilAction, readonly number[]> = {
  Deposit: [BIL_HOLLAR_ASSET_ID, UBIL_ASSET_ID, BIL_ASSET_ID],
  Redeem: [UBIL_ASSET_ID], Cancel: [UBIL_ASSET_ID],
  Settle: [UBIL_ASSET_ID, BIL_HOLLAR_ASSET_ID], Claim: [BIL_HOLLAR_ASSET_ID, UBIL_ASSET_ID],
  Reinvest: [BIL_HOLLAR_ASSET_ID], Interest: [BIL_HOLLAR_ASSET_ID], Principal: [BIL_HOLLAR_ASSET_ID], Draw: [BIL_HOLLAR_ASSET_ID], Repay: [BIL_HOLLAR_ASSET_ID],
}
/** The assets one row moves: a deposit not made through the zap mints uBIL, not BIL. */
export function bilRowAssets(action: BilAction, zapped: boolean): number[] {
  return action === 'Deposit' && !zapped ? [BIL_HOLLAR_ASSET_ID, UBIL_ASSET_ID] : [...BIL_ACTION_ASSETS[action]]
}

// ─── The redemption queue ────────────────────────────────────────────────────

export type BilRequestStatus = 'queued' | 'partly-settled' | 'claimable' | 'claimed' | 'cancelled'
export interface BilRequest {
  requestId: number
  owner: string
  /** Who settles, cancels and claims it (the queue's `user`). */
  controller: string
  /** uBIL requested. */
  shares: string
  requestedAt: { block: number; timestamp: string }
  /** uBIL settled so far and the HOLLAR those settlements fixed. */
  settledShares: string
  hollarOwed: string
  /** uBIL returned by a cancellation. */
  cancelledShares: string
  /** Still unsettled and not cancelled: waiting in the queue. */
  pendingShares: string
  lastSettledAt: string | null
}

/**
 * Every redemption request from the logs: what was requested, settled (and the HOLLAR
 * each settlement fixed), cancelled and still waiting. Claims are per CONTROLLER (the
 * vault's `redeem` walks a controller's settled requests and its log names no request),
 * so a request carries no claimed figure; `bilControllerClaims` states them.
 */
export function bilRequests(events: readonly BilEvent[]): BilRequest[] {
  const byId = new Map<number, BilRequest>()
  const sorted = [...events].sort((a, b) => a.blockHeight - b.blockHeight || a.eventIndex - b.eventIndex)
  for (const e of sorted) {
    if (e.contract !== BIL_VAULT || e.requestId == null) continue
    if (e.name === 'RedeemRequest' && e.controller && e.owner) {
      byId.set(e.requestId, {
        requestId: e.requestId, owner: e.owner, controller: e.controller, shares: e.shares ?? '0',
        requestedAt: { block: e.blockHeight, timestamp: e.timestamp },
        settledShares: '0', hollarOwed: '0', cancelledShares: '0', pendingShares: e.shares ?? '0', lastSettledAt: null,
      })
      continue
    }
    const r = byId.get(e.requestId)
    if (!r) continue
    if (e.name === 'RedemptionFulfilled' || e.name === 'RedemptionPartiallyFulfilled') {
      r.settledShares = (BigInt(r.settledShares) + BigInt(e.shares ?? '0')).toString()
      r.hollarOwed = (BigInt(r.hollarOwed) + BigInt(e.hollar ?? '0')).toString()
      r.lastSettledAt = e.timestamp
    } else if (e.name === 'RedemptionCancelled') {
      r.cancelledShares = (BigInt(r.cancelledShares) + BigInt(e.shares ?? '0')).toString()
    }
    const pending = BigInt(r.shares) - BigInt(r.settledShares) - BigInt(r.cancelledShares)
    r.pendingShares = (pending > 0n ? pending : 0n).toString()
  }
  return [...byId.values()].sort((a, b) => a.requestId - b.requestId)
}

/** Per controller: uBIL claimed and the HOLLAR paid for it (every Withdraw log). */
export function bilControllerClaims(events: readonly BilEvent[]): Map<string, { shares: bigint; hollar: bigint }> {
  const out = new Map<string, { shares: bigint; hollar: bigint }>()
  for (const e of events) {
    if (e.name !== 'Withdraw' || !e.controller) continue
    const c = out.get(e.controller) ?? { shares: 0n, hollar: 0n }
    c.shares += BigInt(e.shares ?? '0'); c.hollar += BigInt(e.hollar ?? '0')
    out.set(e.controller, c)
  }
  return out
}

/**
 * A request's state. Settled HOLLAR is claimed per controller, so a settled request is
 * `claimable` while its controller has settled-and-unclaimed uBIL (`unclaimedShares`,
 * the controller's settlements less its claims), else `claimed`.
 */
export function bilRequestStatus(r: Pick<BilRequest, 'settledShares' | 'cancelledShares' | 'pendingShares'>, controllerUnclaimedShares: bigint): BilRequestStatus {
  const pending = BigInt(r.pendingShares), settled = BigInt(r.settledShares)
  if (pending > 0n) return settled > 0n ? 'partly-settled' : 'queued'
  if (settled === 0n) return 'cancelled'
  return controllerUnclaimedShares > 0n ? 'claimable' : 'claimed'
}

// ─── The Decentral positions (the maturity ladder) ───────────────────────────

export interface BilPosition {
  /** The vault's position index (the i-th Decentral Deposited it invested). */
  index: number
  tokenId: string
  principal: string
  depositTime: number
  maturityTime: number
  state: BilPositionState
  /** Interest Decentral has paid on it so far (YieldWithdrawn). */
  interestPaid: string
  /** Capped by the vault at maturity: accrual stopped, the pending interest is fixed. */
  yieldCapped: boolean
  /** The position's own fixed rate (WAD), as the vault stored it; null until read. */
  apyWad: string | null
}
/** A position's immutable terms as the vault stores them (getPosition). */
export interface BilPositionTerms { tokenId: string; principal: string; apyWad: string; depositTime: number; maturityTime: number }

/**
 * The vault's Decentral positions from the logs: position i is the i-th Decentral
 * `Deposited` naming the vault as investor (deposits and reinvestments both open one),
 * its maturity the deposit time plus the pool's investment period, its state the
 * newest `PositionProcessed` / `PositionRedeemed`. `periodSec` is the pool's
 * `minimumInvestmentPeriodSeconds` (no event states it).
 */
export function bilPositions(events: readonly BilEvent[], periodSec: number): BilPosition[] {
  const sorted = [...events].sort((a, b) => a.blockHeight - b.blockHeight || a.eventIndex - b.eventIndex)
  const out: BilPosition[] = []
  const byToken = new Map<string, BilPosition>()
  for (const e of sorted) {
    if (e.name === 'PoolDeposited' && e.user === BIL_VAULT && e.tokenId != null) {
      const ts = Math.floor(Date.parse(e.timestamp) / 1000)
      const p: BilPosition = { index: out.length, tokenId: e.tokenId, principal: e.hollar ?? '0', depositTime: ts, maturityTime: ts + periodSec, state: 'active', interestPaid: '0', yieldCapped: false, apyWad: null }
      out.push(p); byToken.set(p.tokenId, p)
    } else if (e.name === 'PositionProcessed' && e.positionIndex != null && out[e.positionIndex]) {
      out[e.positionIndex].state = BIL_POSITION_STATE[e.newState ?? 0] ?? out[e.positionIndex].state
    } else if (e.name === 'PositionRedeemed' && e.positionIndex != null && out[e.positionIndex]) {
      out[e.positionIndex].state = 'redeemed'
    } else if (e.name === 'PositionYieldCapped' && e.positionIndex != null && out[e.positionIndex]) {
      out[e.positionIndex].yieldCapped = true
    } else if (e.name === 'YieldWithdrawn' && e.user === BIL_VAULT && e.tokenId != null) {
      const p = byToken.get(e.tokenId)
      if (p) p.interestPaid = (BigInt(p.interestPaid) + BigInt(e.hollar ?? '0')).toString()
    }
  }
  return out
}

/**
 * The positions with the vault's own stored terms (deposit time, maturity, rate) in place
 * of the logs' block-time estimates, or null — publish no ladder — when a stored position
 * names another NFT or principal than the logs do. `terms` holds the positions read so far
 * (a position's terms never change); positions without one keep the log-derived terms.
 */
export function withPositionTerms(positions: readonly BilPosition[], terms: ReadonlyMap<number, BilPositionTerms>): BilPosition[] | null {
  const out: BilPosition[] = []
  for (const p of positions) {
    const t = terms.get(p.index)
    if (!t) { out.push(p); continue }
    if (t.tokenId !== p.tokenId || t.principal !== p.principal) return null
    out.push({ ...p, depositTime: t.depositTime, maturityTime: t.maturityTime, apyWad: t.apyWad })
  }
  return out
}

/**
 * The vault's uncapped yield rate as the positions state it — Σ apy × principal over the
 * open positions not yet capped at maturity — which must equal its `yieldRateSum`.
 * Null when a counted position's rate is unknown.
 */
export function bilYieldRateSum(positions: readonly BilPosition[]): bigint | null {
  let sum = 0n
  for (const p of positions) {
    if (p.state === 'redeemed' || p.yieldCapped) continue
    if (p.apyWad == null) return null
    sum += BigInt(p.apyWad) * BigInt(p.principal)
  }
  return sum
}

/** A position's payout at maturity: principal plus its fixed simple interest over its own term, at its own rate (else `fallbackApyWad`). */
export function bilPositionPayout(p: Pick<BilPosition, 'principal' | 'depositTime' | 'maturityTime' | 'apyWad'>, fallbackApyWad: bigint): bigint {
  const principal = BigInt(p.principal)
  const apy = p.apyWad != null ? BigInt(p.apyWad) : fallbackApyWad
  const term = BigInt(Math.max(0, p.maturityTime - p.depositTime))
  return principal + principal * apy * term / (WAD * YEAR_SEC)
}

/**
 * Which maturity pays a redemption of `hollarNeeded` behind `queuedAheadHollar`: the
 * vault's own FIFO rule (QueueLib.estimatedWaitTime) — idle HOLLAR first, then each open
 * position's payout in position order until they cover it. `maturityTime` is that
 * position's maturity; when the HOLLAR actually arrives is maturity plus processing
 * (bilExpectedWindow). `covered` false when the open positions do not cover it.
 */
export function bilQueueCoverage(input: {
  positions: readonly BilPosition[]
  apyWad: bigint
  idleHollar: bigint
  queuedAheadHollar: bigint
  hollarNeeded: bigint
}): { covered: boolean; coveredByIdle: boolean; maturityTime: number | null; position: BilPosition | null } {
  const need = input.queuedAheadHollar + input.hollarNeeded
  if (input.idleHollar >= need) return { covered: true, coveredByIdle: true, maturityTime: null, position: null }
  let acc = input.idleHollar
  for (const p of input.positions) {
    if (p.state === 'redeemed') continue
    acc += bilPositionPayout(p, input.apyWad)
    if (acc >= need) return { covered: true, coveredByIdle: false, maturityTime: p.maturityTime, position: p }
  }
  return { covered: false, coveredByIdle: false, maturityTime: null, position: null }
}

/** Measured processing after maturity (seconds): the median and the 90th percentile of the repaid positions. */
export interface BilProcessing { samples: number; medianSec: number; p90Sec: number; maxSec: number }
export function bilProcessingStats(delays: readonly number[]): BilProcessing | null {
  if (!delays.length) return null
  const sorted = [...delays].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]
  return { samples: sorted.length, medianSec: at(0.5), p90Sec: at(0.9), maxSec: at(1) }
}

/**
 * When the HOLLAR of a maturity reaches the queue: a window, maturity plus the measured
 * median to maturity plus the measured 90th-percentile processing (the pool's own delay
 * when nothing has been repaid yet). Once maturity has passed it is `matured` — awaiting
 * processing — and never a time in the past.
 */
export function bilExpectedWindow(maturityTime: number, processing: BilProcessing | null, poolDelaySec: number, nowSec: number): { maturesAt: number; from: number; to: number; matured: boolean } {
  const lo = processing?.medianSec ?? poolDelaySec, hi = processing?.p90Sec ?? poolDelaySec
  return { maturesAt: maturityTime, from: maturityTime + lo, to: maturityTime + Math.max(lo, hi), matured: maturityTime <= nowSec }
}

/** One holder's whole BIL position: what accrues (BIL, uBIL, uBIL still queued) and what is fixed (settled HOLLAR awaiting a claim). */
export interface BilHolding { h160: string; bil: bigint; ubil: bigint; queuedShares: bigint; claimableHollar: bigint }
/**
 * Every holder's position at one block, custody excluded: BIL (the aToken balances), uBIL
 * held directly (wallet balances, the vault's escrow and the aToken's backing excluded),
 * and per controller the uBIL its open requests still have queued — accruing at NAV —
 * and the HOLLAR their settled parts are owed, a fixed amount until claimed. `chain` null
 * (the open requests could not be stated) leaves every escrow out and says so:
 * `complete` false.
 */
export function bilHoldings(input: {
  bil: ReadonlyMap<string, bigint>
  wallet: ReadonlyMap<string, bigint>
  chain: ReadonlyArray<{ controller: string; escrowShares: bigint; settledShares: bigint; hollarOwed: bigint }> | null
}): { holdings: BilHolding[]; complete: boolean } {
  const out = new Map<string, BilHolding>()
  const at = (h: string) => out.get(h) ?? out.set(h, { h160: h, bil: 0n, ubil: 0n, queuedShares: 0n, claimableHollar: 0n }).get(h)!
  for (const [h, b] of input.bil) if (b > 0n) at(h).bil += b
  for (const [h, b] of input.wallet) if (b > 0n && h !== BIL_VAULT && h !== BIL_ATOKEN) at(h).ubil += b
  for (const r of input.chain ?? []) {
    const queued = r.escrowShares - r.settledShares
    if (queued > 0n) at(r.controller).queuedShares += queued
    if (r.hollarOwed > 0n) at(r.controller).claimableHollar += r.hollarOwed
  }
  const escrowed = (input.wallet.get(BIL_VAULT) ?? 0n) > 0n
  return {
    holdings: [...out.values()].filter(h => h.bil + h.ubil + h.queuedShares > 0n || h.claimableHollar > 0n),
    complete: input.chain != null || !escrowed,
  }
}
/** The uBIL a holding accrues on (BIL, uBIL and what is still queued). */
export const bilAccruingShares = (h: Pick<BilHolding, 'bil' | 'ubil' | 'queuedShares'>): bigint => h.bil + h.ubil + h.queuedShares
/** A holding's HOLLAR worth: its accruing uBIL at the rate plus its fixed claimable HOLLAR. */
export const bilHoldingHollar = (h: BilHolding, rateWad: bigint): bigint => bilAccruingShares(h) * rateWad / WAD + h.claimableHollar

/**
 * Beneficial uBIL balances — the vault's escrow attributed to whom it belongs. Inputs at
 * ONE block: `wallet` uBIL's wallet balances (summed Transfer deltas), the requests from
 * the logs with their CHAIN state (`chain`: what each open request still holds in
 * escrow and the HOLLAR its settled part is owed, the vault's getRedemptionRequest at
 * the same block), and the vault's exchange rate.
 *
 *   wallet(vault) = Σ attributed + remainder(vault)
 *
 * A request's unsettled uBIL moves to its controller as the uBIL it still is; its
 * settled part is worth exactly the HOLLAR fixed for it, stated in uBIL at the current
 * rate so it is valued at the share's price. What no one is attributed stays with the
 * vault as its remainder, which no surface values. Null — publish nothing — when the
 * attribution would exceed the custody.
 */
export function bilBeneficialBalances(input: {
  wallet: ReadonlyMap<string, bigint>
  chain: ReadonlyArray<{ controller: string; escrowShares: bigint; settledShares: bigint; hollarOwed: bigint }>
  exchangeRateWad: bigint
}): Map<string, bigint> | null {
  const out = new Map<string, bigint>(input.wallet)
  const add = (h: string, v: bigint) => out.set(h, (out.get(h) ?? 0n) + v)
  let fromCustody = 0n
  for (const r of input.chain) {
    const pending = r.escrowShares - r.settledShares
    if (pending > 0n) { add(r.controller, pending); fromCustody += pending }
    if (r.hollarOwed > 0n && input.exchangeRateWad > 0n) {
      const eq = r.hollarOwed * WAD / input.exchangeRateWad
      add(r.controller, eq); fromCustody += eq
    }
  }
  const custody = input.wallet.get(BIL_VAULT) ?? 0n
  if (fromCustody > custody) return null
  out.set(BIL_VAULT, custody - fromCustody)
  return out
}

/**
 * The exchange rate each deposit and settlement EXECUTED at (HOLLAR per uBIL, WAD): a
 * deposit mints at the rate of its block (hollar × 1e18 / shares, the vault's own
 * rounding aside) and a settlement fixes hollarOwed = shares × rate. Exact event-time
 * observations of the vault's NAV — no event states it otherwise. Input: the Deposit and
 * Settle activity rows' HOLLAR and uBIL.
 */
export function bilRateObservations(acts: ReadonlyArray<{ blockHeight: number; timestamp: string; hollar: string | null; shares: string | null; source: 'deposit' | 'settlement' }>): Array<{ block: number; timestamp: string; rateWad: bigint; source: 'deposit' | 'settlement' }> {
  const out: Array<{ block: number; timestamp: string; rateWad: bigint; source: 'deposit' | 'settlement' }> = []
  for (const a of acts) {
    const shares = BigInt(a.shares ?? '0'), hollar = BigInt(a.hollar ?? '0')
    if (shares > 0n && hollar > 0n) out.push({ block: a.blockHeight, timestamp: a.timestamp, rateWad: hollar * WAD / shares, source: a.source })
  }
  return out.sort((a, b) => a.block - b.block)
}

/**
 * How long after maturity each repaid position's principal came back (Decentral's
 * PrincipalWithdrawn to the vault, against the position's maturity): the queue's real
 * processing delay — the pool's own delay plus Decentral's manual approval.
 */
export function bilProcessingDelays(positions: readonly BilPosition[], events: readonly BilEvent[]): number[] {
  const maturity = new Map(positions.map(p => [p.tokenId, p.maturityTime]))
  const out: number[] = []
  for (const e of events) {
    if (e.name !== 'PrincipalWithdrawn' || e.user !== BIL_VAULT || e.tokenId == null) continue
    const m = maturity.get(e.tokenId)
    if (m != null) out.push(Math.floor(Date.parse(e.timestamp) / 1000) - m)
  }
  return out.sort((a, b) => a - b)
}

/**
 * Annualised SIMPLE growth between two rates over `seconds` (the vault accrues each
 * position linearly), in percent; null for a span under a day.
 */
export function bilRealizedApyPct(fromWad: bigint, toWad: bigint, seconds: number): number | null {
  if (seconds < 86_400 || fromWad <= 0n) return null
  const growth = Number((toWad - fromWad) * 1_000_000_000n / fromWad) / 1e9
  return growth * (365 * 86_400 / seconds) * 100
}

