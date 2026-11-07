// Juicer — galacticcouncil/money-market `juicer-vault`, the leveraged PRIME-loop
// strategy behind app.hydration.net/strategies/juicer. The pure leaf: the launch
// deployment's addresses, the topics the explorer reads and their decoders. No I/O.
//
// How it works (the contracts' own model, and the terms the official UI uses):
//  - A CollateralVault per collateral asset takes deposits of that asset, supplies
//    them to Hydration's primary money market (its "Main" position) and mints vault
//    SHARES (jETH for the GETH vault). A deposit makes no trade and borrows nothing.
//  - Keepers REBALANCE: borrow HOLLAR against Main within a band under the
//    collateral's max LTV (synthetic collateral holds Main's health factor without
//    adding borrowing power), and hand it to the shared SubLoop, which loops PRIME
//    on the same money market (supply PRIME, borrow HOLLAR, buy PRIME through ICE
//    intents) — the leveraged position that earns.
//  - A HARVEST converts the loop's surplus PRIME into each vault's collateral,
//    takes the protocol harvest share, services Main's interest and compounds the
//    rest into every holder's balance: nothing to claim.
//  - A WITHDRAWAL is a request (`requestRedeem`): the shares go into escrow in the
//    vault and keep earning for the cooldown (7 days at launch); then the unwind
//    starts (FIFO), settles in parts as the loop frees HOLLAR to repay the exit's
//    share of Main's debt, and the owner CLAIMS the settled collateral. Requests
//    cannot be cancelled. Later source proceeds of a finished exit are claimable in
//    HOLLAR from the vault's Main debt ledger (`SurplusClaimed`).
//
// The deployment is governance's (referendum enacted at block 16,683,445; the
// contracts were created at 16,630,305–16,630,310). A further vault is a new
// CollateralVault + JuicerMainDebt pair: it joins JUICER_VAULTS here and the
// juicer_logs MV's contract set (018_juicer.sql, pinned by juicerSchema.test.ts).

export interface JuicerVaultDef {
  /** The CollateralVault proxy — also the share token's ERC-20 contract. */
  vault: string
  /** Its JuicerMainDebt ledger. */
  mainDebt: string
  /** Its SyntheticToken: the non-cash collateral the vault supplies to Main beside the deposits. */
  synthetic: string
  /** Registry id of the share token (jETH). */
  shareAssetId: number
  /** Registry id of the deposited collateral (2-Pool-GETH, shown as GETH). */
  collateralAssetId: number
  /** The asset the official UI denominates amounts in (the collateral tracks it). */
  baseAssetId: number
  /** The product name the official UI gives the vault. */
  name: string
}

export const JUICER_VAULTS: readonly JuicerVaultDef[] = [
  {
    vault: '0x98db179d65b8abc53946bd89b3433a4fd3bfb60c',
    mainDebt: '0x4b1f2fc264986a7d792af4c4fc1c878cb98f1518',
    synthetic: '0xb94025f14fdc01f8e3b0c34311bcbae0febd1a4a',
    shareAssetId: 5551,
    collateralAssetId: 4200,
    baseAssetId: 34,
    name: 'Juicer ETH',
  },
]

/** The shared PRIME loop (SubLoop proxy) every vault deploys its HOLLAR into. */
export const JUICER_SUBLOOP = '0x2df1d70f413b5edd16bb794791117948a7436a45'
export const JUICER_HARVESTER = '0x91454e38b5ec11f3e9d6c23ca631e0f65388daf9'
export const JUICER_FEE_CONTROLLER = '0x9e9e273df28b4f54a4b7227517fe56d7ffa24843'
export const JUICER_DISCOUNT = '0x6a00bd956908bccdbac3523f862740ae9de38550'
export const JUICER_YIELD_ACCOUNTING = '0x3f4b16860c15a0ea7596c0b4218f5e45a1a8e53d'
export const JUICER_EXECUTION_CONTROLLER = '0x13deb9ef055328cf0daf88d4e44160b4e4a398f0'
/** The keepers the launch proposal named (pr #46): they rebalance, harvest, unwind and deliver claims. */
export const JUICER_KEEPERS: readonly string[] = [
  '0xaf11238c61d8d3e98b6e5a10c227e77dfd0d9898',
  '0x8862a05a7d9af0fdd7a0f8611c067e1f73921e8a',
]
/** Primary money market Pool, where Main and the loop both live. */
export const JUICER_POOL = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
export const HOLLAR_CONTRACT = '0x531a654d1696ed52e7275a8cede955e82620f99a'
/** PRIME's money-market reserve address (the asset-id precompile of asset 43). */
export const PRIME_RESERVE = '0x000000000000000000000000000000010000002b'
export const PRIME_ATOKEN_ASSET_ID = 1043
export const PRIME_ASSET_ID = 43
export const HOLLAR_ASSET_ID = 222
/** The burn address the launch's locked bootstrap shares sit at: no one's position. */
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead'

/** The contracts juicer_logs copies logs from (its MV's contract set, verbatim). */
export const JUICER_LOG_CONTRACTS: readonly string[] = [
  ...JUICER_VAULTS.map(v => v.vault), JUICER_SUBLOOP, JUICER_HARVESTER,
  ...JUICER_VAULTS.map(v => v.mainDebt), JUICER_FEE_CONTROLLER, JUICER_DISCOUNT,
]
/** Every Juicer contract — the tag's members and the set whose plumbing a Juicer row owns. */
export const JUICER_CONTRACTS: readonly string[] = [
  ...JUICER_LOG_CONTRACTS, JUICER_YIELD_ACCOUNTING, JUICER_EXECUTION_CONTROLLER,
]
const CONTRACT_SET = new Set(JUICER_CONTRACTS)
/**
 * The CUSTODY accounts: their holdings are what the jETH holders' shares restate, so
 * none of them is the account's own value — the vault (Main's collateral and debt, the
 * synthetic, the escrowed shares), the SubLoop (the PRIME loop the Main debt funded)
 * and the yield accounting (the funded earnings fund). The fee controller's collected
 * fees and the Main debt ledger's protocol reserve are the protocol's money, not
 * restated by a share, so they stay counted.
 */
export const JUICER_CUSTODY_CONTRACTS: readonly string[] = [...JUICER_VAULTS.map(v => v.vault), JUICER_SUBLOOP, JUICER_YIELD_ACCOUNTING]
export function isJuicerContract(h160: string | null | undefined): boolean {
  return h160 != null && CONTRACT_SET.has(h160.toLowerCase())
}
export function juicerVaultByAddress(h160: string | null | undefined): JuicerVaultDef | null {
  const a = (h160 ?? '').toLowerCase()
  return JUICER_VAULTS.find(v => v.vault === a || v.mainDebt === a) ?? null
}
/**
 * A vault's synthetic collateral — a money-market reserve with no registry asset, held
 * only by its vault. It holds Main's health factor and can fund nothing (the contract's
 * own words: "cannot fund repayments"), so it is no one's value.
 */
export function isJuicerSynthetic(reserve: string | null | undefined): boolean {
  const a = (reserve ?? '').toLowerCase()
  return JUICER_VAULTS.some(v => v.synthetic === a)
}
export function juicerVaultByShare(assetId: number): JuicerVaultDef | null {
  return JUICER_VAULTS.find(v => v.shareAssetId === assetId) ?? null
}

// topic0 of every log juicer_logs keeps (keccak256 of the deployed ABI's signature).
export const JUICER_TOPIC = {
  // CollateralVault
  Deposited: '0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca', // (address indexed user, uint256 assets, uint256 shares)
  RedeemRequested: '0x1d3135f7e52d949fd35b86ab673aeb906bdee851ec045f9539dc9a33fbfbe482', // (uint256 indexed requestId, address indexed owner, uint256 shares)
  UnwindScheduled: '0x6dc83b2b4249c95db32c0425ee1720f24b33553482a672c27cfae3f9cd26b5df', // (uint256 indexed requestId, uint256 eligibleAt)
  UnwindStarted: '0xb1c0c2e07488f4aa1df44007c536731d967f82433a7b84165277d42539b2fd7f', // (uint256 indexed requestId, uint256 collateralOwed, uint256 debtShare)
  RedeemSettled: '0xfd1a04eeaf1025d8607aac73d41599dd887b57e743c0098da99e2670506bd748', // (uint256 indexed requestId, uint256 collateral)
  Claimed: '0x4ec90e965519d92681267467f775ada5bd214aa92c0dc93d90a5e880ce9ed026', // (uint256 indexed requestId, address indexed receiver, uint256 collateral)
  Harvested: '0x8e55ccfc9778ff8eba1646d765cf1982537ce0f9257054a17b48aad745250183', // vault: (uint256 collateralCompounded); SubLoop: (uint256 surplus)
  Rebalanced: '0xc257294ad49c215e1a248c91a86bc2612b4781d9677285cc9c14498f485ef122', // (uint256 ltvBefore, uint256 ltvAfter), bps
  HeadroomExit: '0x5e8d4127e6ec0b1c7d569e172d279634cb4c958854a86b9097b4cc784e294291', // (uint256 indexed id, uint256 keptShares, uint256 unwoundShares, uint256 shortfall)
  WithdrawalDelayUpdated: '0x29a87c0fb05270894205d39dc3d391b0225438e392b727f99abdc8dc0a751f21', // (uint32 delay)
  Paused: '0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258',
  Unpaused: '0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa',
  // SubLoop
  LoopDeposited: '0xfb5f43e3eb2833d020c71477c280fe339de3c2770691e1a67d65cd12eb6ea72d', // (address indexed vault, uint256 hollarIn, uint256 shares)
  UnwindRequested: '0x907affd07d507e1612862c5a5ff36f1a853b28f5e735b8bdb3bb7fac1d39bd2c', // (address indexed vault, uint256 shares, uint256 equity, uint256 unwindId)
  FreedPulled: '0xb290e765bc36448563c8c8a8bdf512550cd18c6b4d7e3f3c472794e12fe86f80', // (address indexed vault, uint256 hollar)
  DeLevered: '0xb57536a0e253526e84274d61a4649afa0fc49e044b9235aa18974e30444db5ae', // (uint256 hfBefore, uint256 hfAfter), wad
  EmergencyPauseUpdated: '0xed1f3e12429ce88e77b14ddf9c2eb89f0b9e1e0faa7e33a95d0ce1bbc90a1c2f', // (bool paused)
  RebalanceBandSet: '0xdc6b42828e03ea0b28a942f3c814c84c608207f3e38f9a69ead06acc75adcaef', // (address indexed vault, uint16 targetGapBps, uint16 releverGapBps, uint16 deleverGapBps)
  ExitHeadroomSet: '0x74526d6729c142a6e5df37263dd611255125ebfbe40b3bdcc7a884f6e643d365', // (address indexed vault, bool enabled, uint16 gapBps)
  // Harvester
  HarvestRun: '0xedbd60129f57789cfab63ebccda712fe907f483793e4facb02d0244d729907a0', // (uint256 surplusPrime)
  DeLeverRun: '0xe79fd7d860df2c45b8a610c7420edf6bcec13675af36b9d2523378b1a83c279c', // ()
  // JuicerMainDebt
  MainRepaid: '0x40f0544b1c1f4fec29c2ffa81737598ecaa047e4e993011387699ed956bfa4eb', // Repaid(uint256 indexed key, uint256 interest, uint256 principal, uint256 cashSpent)
  SurplusClaimed: '0x060c1a8b7e19e0e6e3deffe56fd2fef99a7d5a4bc2234061734f110cf5b6367c', // (uint256 indexed id, address indexed owner, uint256 amount)
  ReserveFunded: '0xb52b99b9e83551fcbd069b559cc3e823e2a1a3bad8ece46561ea77524394c850', // (address indexed donor, uint256 amount)
  ReserveDrawn: '0xa34080a97c7bd5a0cc1fe33cb5d3332d55c380e90902d1b4453e96537a3d1006', // (uint256 indexed key, uint256 amount)
  ExitReserved: '0x58b283ab2bf97081e73797c76c83642af1e9e330a6b0173dd0e638bd84fc5995', // (uint256 indexed id, uint256 cash, uint256 debt, uint256 sourceClaim)
  // JuicerFeeController
  ProtocolFeeAccrued: '0xef307ecc2880448842675e7d171caa0bcc3474fd35bb18cad19f4ff36e00d0d1', // (address indexed vault, address indexed asset, uint256 gross, uint256 fee, uint256 net)
  ProtocolFeesClaimed: '0x4f8a50ec1fe3d316970fdadd1f94e0b822f92d31e2bac3c9dc2c6c287de07107', // (address indexed asset, address indexed recipient, uint256 amount)
  ProtocolFeeUpdated: '0x23e5bc5f063963f9e7b37609ce9794ed733f8df8c8122736a34380f2f4039a75', // (address indexed vault, uint16 previousBps, uint16 newBps)
  // JuicerDiscount
  DiscountBpsUpdated: '0x98e3263d243be6fa54f64665eb035d2af14f3873f13b350f25d26184c6036035', // (uint16 previousBps, uint16 newBps)
  LoopDiscountBpsUpdated: '0x345b03f5c035388db76a0f8edb9be72736d2c47998b185aee8ee8b4d9d5a882b', // (uint16 previousBps, uint16 newBps)
  // SubLoop loop building (juicer_loop_logs_mv): an entry or exit goes out as an ICE intent
  LoopBorrowed: '0x14a13f958d7fe38fb8529e8d43353b6d9120f52444e486a4077f68a3fc77dcbf', // Borrowed(uint256 amount, uint256 hfAfter)
  LoopRepaid: '0x81472a96709c8315c82af40d41ef624a642ad53864b097e53af675593bb4e035', // Repaid(uint256 amount, uint256 hfAfter)
  IntentSubmitted: '0xf47be53a3800f408a772b4ce403212b043ad8c0eff97ec1a583cbc250aa91c89', // (uint8 indexed kind, uint64 indexed nonce, uint256 amountIn, uint256 minOut, uint64 deadline)
  IntentSettled: '0x3a51313280fc2f1e8e1ce3435821f506bc14cf540e387a22d71c54dffc7bc7b3', // (uint8 indexed kind, uint64 indexed nonce, uint256 amountOut)
} as const
/** The SubLoop-only topics juicer_loop_logs_mv copies (the rest are juicer_logs_mv's). */
export const JUICER_LOOP_TOPICS: readonly string[] = [JUICER_TOPIC.LoopBorrowed, JUICER_TOPIC.LoopRepaid, JUICER_TOPIC.IntentSubmitted, JUICER_TOPIC.IntentSettled]
/** An IntentSubmitted/Settled `kind`: 1 buys PRIME with borrowed HOLLAR (levers up), 2 sells it back (levers down). */
export const LOOP_INTENT_ENTRY = 1
export type JuicerTopicName = keyof typeof JUICER_TOPIC
const TOPIC_NAME = new Map<string, JuicerTopicName>(Object.entries(JUICER_TOPIC).map(([k, v]) => [v, k as JuicerTopicName]))

/** One juicer_logs row as read. */
export interface JuicerLogRow {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  ts: string
  contract_address: string
  topic0: string
  topics: string[]
  data: string
}

/** The i-th 32-byte word of a log's data, or null when it is short. */
export function dataWord(data: string, i: number): bigint | null {
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

// Activity actions, in the official app's terms. `Withdraw` is the request (the
// shares go into escrow; the cooldown starts), `Unwind` its start, `Settle` a
// settled part, `Claim` the owner taking settled collateral, `ClaimSurplus` a
// finished exit's later HOLLAR. Harvest / Rebalance / Delever are the keepers', and so
// are the loop's own steps: Lever (borrowed HOLLAR sent out as an ICE intent to buy
// PRIME) and Unlever (PRIME sold back for HOLLAR to repay the loop's debt).
export const JUICER_ACTIONS = ['Deposit', 'Withdraw', 'Unwind', 'Settle', 'Claim', 'ClaimSurplus', 'Harvest', 'Rebalance', 'Delever', 'Lever', 'Unlever'] as const
export type JuicerAction = typeof JUICER_ACTIONS[number]
/** The feed's `action` filter slugs. */
export const JUICER_ACTION_SLUGS: Record<string, JuicerAction> = {
  'juicer-deposit': 'Deposit', 'juicer-withdraw': 'Withdraw', 'juicer-unwind': 'Unwind', 'juicer-settle': 'Settle',
  'juicer-claim': 'Claim', 'juicer-claim-surplus': 'ClaimSurplus', 'juicer-harvest': 'Harvest',
  'juicer-rebalance': 'Rebalance', 'juicer-delever': 'Delever', 'juicer-lever': 'Lever', 'juicer-unlever': 'Unlever',
}
export function juicerActionSlug(action: JuicerAction): string {
  return Object.entries(JUICER_ACTION_SLUGS).find(([, a]) => a === action)![0]
}
/** The topic each action's row is built from (the row's own identity: its log). */
export const JUICER_ACTION_TOPIC: Record<JuicerAction, { topic: string; contract: 'vault' | 'mainDebt' | 'subloop' }> = {
  Deposit: { topic: JUICER_TOPIC.Deposited, contract: 'vault' },
  Withdraw: { topic: JUICER_TOPIC.RedeemRequested, contract: 'vault' },
  Unwind: { topic: JUICER_TOPIC.UnwindStarted, contract: 'vault' },
  Settle: { topic: JUICER_TOPIC.RedeemSettled, contract: 'vault' },
  Claim: { topic: JUICER_TOPIC.Claimed, contract: 'vault' },
  ClaimSurplus: { topic: JUICER_TOPIC.SurplusClaimed, contract: 'mainDebt' },
  Harvest: { topic: JUICER_TOPIC.Harvested, contract: 'vault' },
  Rebalance: { topic: JUICER_TOPIC.Rebalanced, contract: 'vault' },
  Delever: { topic: JUICER_TOPIC.DeLevered, contract: 'subloop' },
  // Both are IntentSubmitted, told apart by its kind (juicerActionOf).
  Lever: { topic: JUICER_TOPIC.IntentSubmitted, contract: 'subloop' },
  Unlever: { topic: JUICER_TOPIC.IntentSubmitted, contract: 'subloop' },
}

/** A decoded Juicer log: the fields the explorer reads, raw integers as decimal strings. */
export interface JuicerEvent {
  name: JuicerTopicName
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  contract: string
  /** The vault the log concerns (its own, or the one a SubLoop/MainDebt/fee log names). */
  vault: string | null
  requestId?: number
  /** The account the log names as its user (lowercase H160). */
  party?: string
  assets?: string
  shares?: string
  collateral?: string
  hollar?: string
  amount?: string
  debtShare?: string
  eligibleAt?: number
  ltvBefore?: number
  ltvAfter?: number
  hfBefore?: string
  hfAfter?: string
  fee?: string
  gross?: string
  bps?: number
  paused?: boolean
  delay?: number
  band?: { target: number; relever: number; delever: number }
  headroom?: { enabled: boolean; gapBps: number }
  /** IntentSubmitted / IntentSettled. */
  intentKind?: number
  intentNonce?: number
  minOut?: string
}

const str = (v: bigint | null): string | undefined => v == null ? undefined : v.toString()
const num = (v: bigint | null): number | undefined => v == null || v > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(v)

/** Decode one juicer_logs row; null for a topic or contract it does not know, or a malformed log. */
export function decodeJuicerLog(r: JuicerLogRow): JuicerEvent | null {
  const name = TOPIC_NAME.get(r.topic0)
  const contract = (r.contract_address ?? '').toLowerCase()
  if (!name || !CONTRACT_SET.has(contract)) return null
  const base: JuicerEvent = {
    name, blockHeight: Number(r.block_height), eventIndex: Number(r.event_index),
    extrinsicIndex: r.extrinsic_index == null ? null : Number(r.extrinsic_index), timestamp: r.ts, contract,
    vault: juicerVaultByAddress(contract)?.vault ?? null,
  }
  const t = r.topics ?? [], d = r.data ?? ''
  switch (name) {
    case 'Deposited': {
      const party = topicAddress(t, 1), assets = dataWord(d, 0), shares = dataWord(d, 1)
      return party && assets != null && shares != null ? { ...base, party, assets: assets.toString(), shares: shares.toString() } : null
    }
    case 'RedeemRequested': {
      const id = num(topicWord(t, 1)), party = topicAddress(t, 2), shares = dataWord(d, 0)
      return id != null && party && shares != null ? { ...base, requestId: id, party, shares: shares.toString() } : null
    }
    case 'UnwindScheduled': {
      const id = num(topicWord(t, 1)), at = num(dataWord(d, 0))
      return id != null && at != null ? { ...base, requestId: id, eligibleAt: at } : null
    }
    case 'UnwindStarted': {
      const id = num(topicWord(t, 1)), owed = dataWord(d, 0), debt = dataWord(d, 1)
      return id != null && owed != null ? { ...base, requestId: id, collateral: owed.toString(), debtShare: str(debt) } : null
    }
    case 'RedeemSettled': {
      const id = num(topicWord(t, 1)), c = dataWord(d, 0)
      return id != null && c != null ? { ...base, requestId: id, collateral: c.toString() } : null
    }
    case 'Claimed': {
      const id = num(topicWord(t, 1)), party = topicAddress(t, 2), c = dataWord(d, 0)
      return id != null && party && c != null ? { ...base, requestId: id, party, collateral: c.toString() } : null
    }
    case 'Harvested': {
      const v = dataWord(d, 0)
      if (v == null) return null
      // The vault's is the collateral compounded; the SubLoop's the PRIME surplus it released.
      return contract === JUICER_SUBLOOP ? { ...base, amount: v.toString() } : { ...base, collateral: v.toString() }
    }
    case 'Rebalanced': {
      const a = num(dataWord(d, 0)), b = num(dataWord(d, 1))
      return a != null && b != null ? { ...base, ltvBefore: a, ltvAfter: b } : null
    }
    case 'HeadroomExit': {
      const id = num(topicWord(t, 1)), kept = dataWord(d, 0), unwound = dataWord(d, 1), shortfall = dataWord(d, 2)
      return id != null ? { ...base, requestId: id, shares: str(kept), amount: str(unwound), debtShare: str(shortfall) } : null
    }
    case 'WithdrawalDelayUpdated': {
      const v = num(dataWord(d, 0))
      return v != null ? { ...base, delay: v } : null
    }
    case 'Paused': return { ...base, paused: true }
    case 'Unpaused': return { ...base, paused: false }
    case 'LoopDeposited': {
      const vault = topicAddress(t, 1), h = dataWord(d, 0), s = dataWord(d, 1)
      return vault && h != null ? { ...base, vault, hollar: h.toString(), shares: str(s) } : null
    }
    case 'UnwindRequested': {
      const vault = topicAddress(t, 1), s = dataWord(d, 0), eq = dataWord(d, 1), id = num(dataWord(d, 2))
      return vault ? { ...base, vault, shares: str(s), hollar: str(eq), requestId: id } : null
    }
    case 'FreedPulled': {
      const vault = topicAddress(t, 1), h = dataWord(d, 0)
      return vault && h != null ? { ...base, vault, hollar: h.toString() } : null
    }
    case 'DeLevered': {
      const a = dataWord(d, 0), b = dataWord(d, 1)
      return a != null && b != null ? { ...base, hfBefore: a.toString(), hfAfter: b.toString() } : null
    }
    case 'EmergencyPauseUpdated': {
      const v = dataWord(d, 0)
      return v != null ? { ...base, paused: v !== 0n } : null
    }
    case 'RebalanceBandSet': {
      const vault = topicAddress(t, 1), a = num(dataWord(d, 0)), b = num(dataWord(d, 1)), c = num(dataWord(d, 2))
      return vault && a != null && b != null && c != null ? { ...base, vault, band: { target: a, relever: b, delever: c } } : null
    }
    case 'ExitHeadroomSet': {
      const vault = topicAddress(t, 1), on = dataWord(d, 0), gap = num(dataWord(d, 1))
      return vault && on != null && gap != null ? { ...base, vault, headroom: { enabled: on !== 0n, gapBps: gap } } : null
    }
    case 'LoopBorrowed':
    case 'LoopRepaid': {
      const v = dataWord(d, 0), hf = dataWord(d, 1)
      return v != null ? { ...base, hollar: v.toString(), hfAfter: str(hf) } : null
    }
    case 'IntentSubmitted': {
      const kind = num(topicWord(t, 1)), nonce = num(topicWord(t, 2)), amountIn = dataWord(d, 0), minOut = dataWord(d, 1)
      return kind != null && nonce != null && amountIn != null ? { ...base, intentKind: kind, intentNonce: nonce, amount: amountIn.toString(), minOut: str(minOut) } : null
    }
    case 'IntentSettled': {
      const kind = num(topicWord(t, 1)), nonce = num(topicWord(t, 2)), out = dataWord(d, 0)
      return kind != null && nonce != null && out != null ? { ...base, intentKind: kind, intentNonce: nonce, amount: out.toString() } : null
    }
    case 'HarvestRun': {
      const v = dataWord(d, 0)
      return v != null ? { ...base, amount: v.toString() } : null
    }
    case 'DeLeverRun': return base
    case 'MainRepaid': {
      const interest = dataWord(d, 0), principal = dataWord(d, 1), cash = dataWord(d, 2)
      return interest != null && principal != null ? { ...base, hollar: (interest + principal).toString(), amount: str(cash), fee: interest.toString() } : null
    }
    case 'SurplusClaimed': {
      const id = num(topicWord(t, 1)), party = topicAddress(t, 2), v = dataWord(d, 0)
      return id != null && party && v != null ? { ...base, requestId: id, party, hollar: v.toString() } : null
    }
    case 'ReserveFunded': {
      const v = dataWord(d, 0)
      return v != null ? { ...base, party: topicAddress(t, 1) ?? undefined, hollar: v.toString() } : null
    }
    case 'ReserveDrawn': {
      const v = dataWord(d, 0)
      return v != null ? { ...base, hollar: v.toString() } : null
    }
    case 'ExitReserved': {
      const id = num(topicWord(t, 1)), cash = dataWord(d, 0), debt = dataWord(d, 1)
      return id != null ? { ...base, requestId: id, hollar: str(cash), debtShare: str(debt) } : null
    }
    case 'ProtocolFeeAccrued': {
      const vault = topicAddress(t, 1), gross = dataWord(d, 0), fee = dataWord(d, 1), net = dataWord(d, 2)
      return vault && fee != null ? { ...base, vault, gross: str(gross), fee: fee.toString(), amount: str(net) } : null
    }
    case 'ProtocolFeesClaimed': {
      const v = dataWord(d, 0)
      return v != null ? { ...base, party: topicAddress(t, 2) ?? undefined, amount: v.toString() } : null
    }
    case 'ProtocolFeeUpdated': {
      const vault = topicAddress(t, 1), bps = num(dataWord(d, 1))
      return vault && bps != null ? { ...base, vault, bps } : null
    }
    case 'DiscountBpsUpdated':
    case 'LoopDiscountBpsUpdated': {
      const bps = num(dataWord(d, 1))
      return bps != null ? { ...base, bps } : null
    }
  }
}

// --- the advertised rate ---------------------------------------------------
//
// The official UI's "Est. APY" (hydration-ui `computeVaultApr` + `toApy` +
// `targetLoopLeverage`), restated: the loop's carry at its TARGET leverage —
// leverage = 1 / (1 − PRIME's liquidation threshold / the loop's target health
// factor), the steady state rather than the live gearing, which dips after every
// large deposit — less the protocol's harvest share of that carry and Main's
// discounted HOLLAR interest, scaled by the vault's target LTV, then compounded
// continuously (e^r − 1). PRIME's supply APY is converted to its hourly-compounded
// APR first. Every input is a rate the chain or the explorer's yield model states;
// no fee, slippage or ramp time is forecast — the app's own caveats.

export interface JuicerAprInputs {
  /** Target Main LTV, 0..1 (the collateral's max LTV less the band's target gap). */
  targetLtv: number
  /** The loop's target health factor (SubLoop.targetHf, wad → number). */
  targetHf: number
  /** PRIME's liquidation threshold in bps (the reserve configuration). */
  primeLtBps: number
  /** HOLLAR's current variable borrow rate, as a fraction (ray / 1e27). */
  borrowRate: number
  /** PRIME's total supply APY in percent (money-market supply + its own yield + incentives). */
  primeSupplyApyPct: number
  protocolFeeBps: number
  mainDiscountBps: number
  loopDiscountBps: number
}

export function targetLoopLeverage(targetHf: number, primeLtBps: number): number | null {
  if (!(targetHf > 0) || !(primeLtBps > 0)) return null
  const ratio = primeLtBps / 1e4 / targetHf
  return ratio < 1 ? 1 / (1 - ratio) : null
}

/** The estimated APY in percent, or null when an input is missing or out of range. */
export function juicerEstimatedApyPct(i: JuicerAprInputs): number | null {
  const leverage = targetLoopLeverage(i.targetHf, i.primeLtBps)
  if (leverage == null) return null
  const vals = [i.targetLtv, i.borrowRate, i.primeSupplyApyPct, i.protocolFeeBps, i.mainDiscountBps, i.loopDiscountBps]
  if (!vals.every(Number.isFinite)) return null
  if (i.targetLtv < 0 || i.targetLtv > 1 || i.borrowRate < 0 || i.primeSupplyApyPct <= -100) return null
  if ([i.protocolFeeBps, i.mainDiscountBps, i.loopDiscountBps].some(b => b < 0 || b > 10_000)) return null
  const sourceApr = Math.expm1(Math.log1p(i.primeSupplyApyPct / 100) / 8760) * 8760
  const loopBorrow = i.borrowRate * (1 - i.loopDiscountBps / 10_000)
  const loopCarry = leverage * sourceApr - (leverage - 1) * loopBorrow
  const fee = Math.max(loopCarry, 0) * i.protocolFeeBps / 10_000
  const mainBorrow = i.borrowRate * (1 - i.mainDiscountBps / 10_000)
  const apr = i.targetLtv * (loopCarry - fee - mainBorrow)
  return (Math.expm1(apr) || 0) * 100
}

/**
 * The run-rate: the same arithmetic as the estimate, at the loop's LIVE leverage
 * (collateral ÷ equity, getUserAccountData) and Main's LIVE LTV (debt ÷ real
 * collateral) instead of their targets — what holders accrue while the loop is still
 * being built. Negative while the loop's carry does not yet cover Main's interest.
 */
export function juicerRunRateApyPct(i: Omit<JuicerAprInputs, 'targetLtv' | 'targetHf' | 'primeLtBps'> & { mainLtv: number; leverage: number }): number | null {
  const vals = [i.mainLtv, i.leverage, i.borrowRate, i.primeSupplyApyPct, i.protocolFeeBps, i.mainDiscountBps, i.loopDiscountBps]
  if (!vals.every(Number.isFinite) || i.leverage < 1 || i.mainLtv < 0 || i.mainLtv > 1 || i.borrowRate < 0 || i.primeSupplyApyPct <= -100) return null
  if ([i.protocolFeeBps, i.mainDiscountBps, i.loopDiscountBps].some(b => b < 0 || b > 10_000)) return null
  const sourceApr = Math.expm1(Math.log1p(i.primeSupplyApyPct / 100) / 8760) * 8760
  const loopBorrow = i.borrowRate * (1 - i.loopDiscountBps / 10_000)
  const loopCarry = i.leverage * sourceApr - (i.leverage - 1) * loopBorrow
  const fee = Math.max(loopCarry, 0) * i.protocolFeeBps / 10_000
  const mainBorrow = i.borrowRate * (1 - i.mainDiscountBps / 10_000)
  return (Math.expm1(i.mainLtv * (loopCarry - fee - mainBorrow)) || 0) * 100
}

/** The rebalance band as the contract applies it (SubLoop.setRebalanceBand): gaps from the TARGET, not from max LTV. */
export function rebalanceBandBps(maxLtvBps: number, band: { targetGapBps: number; releverGapBps: number; deleverGapBps: number }): { target: number; relever: number; delever: number } {
  const target = Math.max(0, maxLtvBps - band.targetGapBps)
  return { target, relever: Math.max(0, target - band.releverGapBps), delever: target + band.deleverGapBps }
}

/** One withdrawal request as its five logs state it. */
export interface JuicerRequest {
  vault: string
  requestId: number
  owner: string
  /** Shares requested (the RedeemRequested log: the wallet shares escrowed plus any funded slice). */
  shares: string
  requestedAt: { blockHeight: number; timestamp: string }
  eligibleAt: number | null
  started: boolean
  /** Collateral the unwind fixed (UnwindStarted). */
  collateralOwed: string | null
  /** Collateral released so far (Σ RedeemSettled) and claimed so far (Σ Claimed). */
  settled: string
  claimed: string
}
export type JuicerRequestStatus = 'cooldown' | 'queued' | 'settling' | 'claimable' | 'claimed'

/** Every request of every vault from its logs (RedeemRequested, UnwindScheduled, UnwindStarted, RedeemSettled, Claimed). */
export function juicerRequests(events: readonly JuicerEvent[]): JuicerRequest[] {
  const out = new Map<string, JuicerRequest>()
  const key = (e: JuicerEvent) => `${e.contract}:${e.requestId}`
  for (const e of [...events].sort((a, b) => a.blockHeight - b.blockHeight || a.eventIndex - b.eventIndex)) {
    if (e.requestId == null || !juicerVaultByAddress(e.contract) || juicerVaultByAddress(e.contract)!.vault !== e.contract) continue
    if (e.name === 'RedeemRequested' && e.party && e.shares) {
      out.set(key(e), {
        vault: e.contract, requestId: e.requestId, owner: e.party, shares: e.shares, requestedAt: { blockHeight: e.blockHeight, timestamp: e.timestamp },
        eligibleAt: null, started: false, collateralOwed: null, settled: '0', claimed: '0',
      })
      continue
    }
    const r = out.get(key(e))
    if (!r) continue
    if (e.name === 'UnwindScheduled' && e.eligibleAt != null) r.eligibleAt = e.eligibleAt
    else if (e.name === 'UnwindStarted') { r.started = true; r.collateralOwed = e.collateral ?? null }
    else if (e.name === 'RedeemSettled' && e.collateral) r.settled = (BigInt(r.settled) + BigInt(e.collateral)).toString()
    else if (e.name === 'Claimed' && e.collateral) r.claimed = (BigInt(r.claimed) + BigInt(e.collateral)).toString()
  }
  return [...out.values()]
}

/**
 * A request's state: in its cooldown or queued for the FIFO unwind, then settling
 * (nothing released and unclaimed), claimable (released collateral awaits a claim —
 * the vault's `collateralSettled` is that unclaimed balance), claimed once the claims
 * reach what the unwind fixed.
 */
export function juicerRequestStatus(r: Pick<JuicerRequest, 'started' | 'eligibleAt' | 'collateralOwed' | 'settled' | 'claimed'>, nowSec: number): JuicerRequestStatus {
  if (!r.started) return r.eligibleAt != null && r.eligibleAt > nowSec ? 'cooldown' : 'queued'
  const claimed = BigInt(r.claimed)
  if (r.collateralOwed != null && claimed >= BigInt(r.collateralOwed)) return 'claimed'
  return BigInt(r.settled) - claimed > 0n ? 'claimable' : 'settling'
}

/**
 * Beneficial share balances — the custody the vault and the yield accounting hold,
 * attributed to whom it belongs. Inputs are all at ONE block: `wallet` the share
 * token's wallet balances (the summed Transfer deltas), `funded` each holder's funded
 * earnings (balanceOf − walletOf, a slice of the yield fund the fund's wallet holds),
 * `requests` from the logs, and the vault's exchange rate.
 *
 *   wallet(vault) + wallet(fund) = Σ attributed + remainder(vault) + remainder(fund)
 *
 * A pending request's requested shares (escrowed wallet shares plus the funded slice it
 * took) move to its owner; a started one is worth exactly the collateral it is still
 * owed (owed − claimed), stated in shares at the current rate so it is valued at the
 * share's price; funded earnings move from the fund to their holder. What no one is
 * attributed stays with the custody account as its remainder, which no surface values.
 * Returns null — publish nothing — when the attribution would exceed the custody.
 */
export function juicerBeneficialBalances(input: {
  vault: string
  wallet: ReadonlyMap<string, bigint>
  funded: ReadonlyMap<string, bigint>
  requests: readonly JuicerRequest[]
  exchangeRateWad: bigint
}): Map<string, bigint> | null {
  const WAD = 10n ** 18n
  const out = new Map<string, bigint>(input.wallet)
  const add = (h: string, v: bigint) => out.set(h, (out.get(h) ?? 0n) + v)
  let fromCustody = 0n
  for (const [h, f] of input.funded) { if (f > 0n) { add(h, f); fromCustody += f } }
  for (const r of input.requests) {
    if (r.vault !== input.vault) continue
    const claimed = BigInt(r.claimed)
    if (!r.started) { add(r.owner, BigInt(r.shares)); fromCustody += BigInt(r.shares); continue }
    const owed = BigInt(r.collateralOwed ?? '0')
    if (owed <= claimed || input.exchangeRateWad <= 0n) continue
    const eq = (owed - claimed) * WAD / input.exchangeRateWad
    add(r.owner, eq)
    fromCustody += eq
  }
  const custody = (input.wallet.get(input.vault) ?? 0n) + (input.wallet.get(JUICER_YIELD_ACCOUNTING) ?? 0n)
  if (fromCustody > custody) return null
  // The custody accounts keep their remainder, split back in proportion to what each held.
  const remainder = custody - fromCustody
  const vaultHeld = input.wallet.get(input.vault) ?? 0n
  const vaultShare = custody > 0n ? remainder * vaultHeld / custody : 0n
  out.set(input.vault, vaultShare)
  out.set(JUICER_YIELD_ACCOUNTING, remainder - vaultShare)
  return out
}
