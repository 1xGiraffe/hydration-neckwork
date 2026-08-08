/* Deterministic API fixtures shared by Vitest and Playwright. */
import type {
  ExplorerStats, IndexerStatus, BlockSummary, BlockDetail, ExtrinsicSummary, ExtrinsicDetail,
  TransferRow, EventRow, TradeRow, ActivityRow, MoneyMarketResponse, AssetDetail, HoldersResponse,
  AddressDetail, AddressBalance, CloseAccountsResponse, TagDetail, SearchResult, AssetListItem, TopAccountRow, AccountsPage, DailyPoint, Tag,
  ContractInfo, ContractsPage, ContractTransactionsPage, ContractEventsPage, ContractEventRow, DecodedEvmCall, EvmLogDecode, EvmReceipt, EvmTransactionFacts,
  AccountRef, AssetRef, AssetLiquidationDay, AssetLiquidationTotal, HdxDashboard, HdxCohort, HdxLockType, HdxUnlockBucket, HdxDailyFlow, HdxMover,
  AssetLiquidity, AssetLiquiditySource, PoolDetail, OmnipoolDetail, PoolCompositionEntry,
  HollarDashboard, HollarCollateral, HollarArbDay, HollarTradeDay, HollarPool, HollarPegPoint,
  TradeDetail as TradeDetailResponse,
  ListSummaryRef, ListDetailResponse, ListTagDetail, TagMapResponse, MeResponse,
} from '../../src/types'

/* ---------- deterministic helpers ---------- */
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296 } }
function series(seed: number, n: number, base: number, vol = 0.12): number[] {
  const r = rng(seed); const out: number[] = []; let v = base * (0.6 + r() * 0.5)
  for (let i = 0; i < n; i++) { v = Math.max(base * 0.05, v * (1 - vol + r() * vol * 2)); out.push(v) }
  const s = base / (out[out.length - 1] || 1); return out.map(x => +(x * s).toFixed(base < 0.01 ? 7 : 4))
}
const TIP = 12_848_613
const MOCK_NOW_MS = Date.UTC(2026, 6, 15, 12)
// The paging bounds the real API publishes, so the mock pagers face the same three
// shapes: a counted feed (vote), an uncounted one bounded only by serving depth, and
// a total longer than the depth that serves it (events). The vote total leaves a
// part-full last page (128 pages of 25, the last holding 12).
export const MOCK_VOTE_ACTIVITY_TOTAL = 3_187
export const MOCK_ACTIVITY_MAX_OFFSET = 2_500
export const MOCK_NARROW_ACTIVITY_MAX_OFFSET = 250_000
export const MOCK_LIST_MAX_OFFSET = 20_000_000
function tsAt(height: number): string {
  const ms = MOCK_NOW_MS - (TIP - height) * 6000
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
}
// Same "YYYY-MM-DD HH:MM:SS" shape as tsAt, but from an explicit timestamp.
function tsMs(ms: number): string { return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') }
function hx(seed: number, n: number): string { const r = rng(seed); let s = '0x'; for (let i = 0; i < n; i++) s += Math.floor(r() * 16).toString(16); return s }

/* ---------- assets ---------- */
type MAsset = AssetRef & { price: number; ch: number; ch7d: number; ch1h: number; type: string }
const ASSETS: MAsset[] = [
  { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null, price: 0.02184, ch: 4.28, ch7d: 11.2, ch1h: 0.4, type: 'Native' },
  { assetId: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachainId: null, price: 4.4422, ch: -1.16, ch7d: -3.1, ch1h: -0.2, type: 'Token' },
  { assetId: 10, symbol: 'USDT', name: 'Tether USD', decimals: 6, parachainId: 1000, price: 1.0001, ch: 0.01, ch7d: 0.02, ch1h: 0.0, type: 'Token' },
  { assetId: 1002, symbol: 'aUSDT', name: 'Aave USDT', decimals: 6, parachainId: null, price: 1.0001, ch: 0.01, ch7d: 0.02, ch1h: 0.0, type: 'Aave' },
  { assetId: 22, symbol: 'USDC', name: 'USD Coin', decimals: 6, parachainId: 1000, price: 0.9999, ch: -0.01, ch7d: -0.01, ch1h: 0.0, type: 'Token' },
  { assetId: 15, symbol: 'vDOT', name: 'Voucher DOT', decimals: 10, parachainId: 2030, price: 5.8401, ch: 1.84, ch7d: 4.0, ch1h: 0.1, type: 'Derivative' },
  { assetId: 19, symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, parachainId: 1000, price: 67241.1, ch: -0.72, ch7d: 2.4, ch1h: -0.05, type: 'Token' },
  { assetId: 20, symbol: 'WETH', name: 'Wrapped ETH', decimals: 18, parachainId: 1000, price: 3204.4, ch: 2.18, ch7d: 5.9, ch1h: 0.3, type: 'Token' },
  { assetId: 16, symbol: 'GLMR', name: 'Moonbeam', decimals: 18, parachainId: 2004, price: 0.1842, ch: 9.18, ch7d: 14.0, ch1h: 1.1, type: 'Token' },
  { assetId: 1000, symbol: 'HOLLAR', name: 'Hollar', decimals: 18, parachainId: null, price: 1.0, ch: 0.02, ch7d: 0.0, ch1h: 0.0, type: 'Token' },
  { assetId: 1001, symbol: 'GDOT', name: 'Gigadot', decimals: 10, parachainId: null, price: 4.4501, ch: -1.1, ch7d: -2.0, ch1h: -0.1, type: 'Derivative' },
  // The GDOT stable pool's share token: pool id == share asset id, so /pool/690
  // and the Liquidity tab's pegged-pool card share one identity.
  { assetId: 690, symbol: '2-Pool-GDOT', name: 'GDOT stable pool', decimals: 18, parachainId: null, price: 5.1, ch: 0.4, ch7d: 1.1, ch1h: 0.0, type: 'Share token' },
]
const assetById = new Map(ASSETS.map(a => [a.assetId, a]))
function aref(a: MAsset): AssetRef { return { assetId: a.assetId, symbol: a.symbol, name: a.name, decimals: a.decimals, parachainId: a.parachainId } }
function raw(v: number, dec: number): string { return BigInt(Math.round(v * 1e6)).toString() + '0'.repeat(Math.max(0, dec - 6)) }

/* ---------- money-market liquidations ---------- */
// Primary-market reserves. USDC, vDOT and aUSDT are reserves that have never been
// liquidated, so the asset card's Liquidated row is exercised at zero as well as
// with history. Days land on the asset's own price dates, as the real API's
// day buckets do.
const MOCK_MM_RESERVES = new Set([5, 10, 22, 15, 19, 1002])
const MOCK_LIQUIDATED_ASSETS = new Set([5, 10, 19])
function mockLiquidationDays(a: MAsset, priceDates: string[]): AssetLiquidationDay[] {
  if (!MOCK_LIQUIDATED_ASSETS.has(a.assetId)) return []
  const r = rng(a.assetId * 977 + 3)
  const out: AssetLiquidationDay[] = []
  priceDates.forEach((date, i) => {
    if (i % 11 !== 3) return
    const roll = r()
    const tokens = (0.2 + roll * 4) * 1000 / a.price
    out.push({ date, valueUsd: +(tokens * a.price).toFixed(2), amount: raw(tokens, a.decimals), count: 1 + Math.floor(roll * 4) })
  })
  return out
}
function mockLiquidationTotal(days: AssetLiquidationDay[]): AssetLiquidationTotal {
  return {
    valueUsd: days.reduce((s, d) => s + d.valueUsd, 0),
    amount: days.reduce((s, d) => s + BigInt(d.amount), 0n).toString(),
    count: days.reduce((s, d) => s + d.count, 0),
  }
}

/* ---------- accounts ---------- */
function acc(accountId: string, address: string, emoji: string, tag: AccountRef['tag'] = null, identity: AccountRef['identity'] = null): AccountRef {
  return { accountId, address, emoji, tag, identity }
}
const KRAKEN_TAG = { id: 'kraken', name: 'Kraken', color: '#7b6cf6', icon: '/tag-icons/kraken.jpg' }
const A = {
  krakenEvm: acc('0xf73a2b8c1d4e9a06b5c8f2e1a3d70c9b4e6f18ad', '0xF73a2B8c1D4e9A06b5C8f2E1a3D70c9B4e6F18aD', '🦑', KRAKEN_TAG),
  krakenSub: acc('0x9d8bafc9cbe3ae4f1a7c4d2e0b9f86dc31aa5e72aa11bb22cc33dd44ee55ff66', '1MqRsT3uV4wX5yZ6aB7cD8eF9gH0iJ1kL2mN3pQ4rS5tU6v', '🦑', KRAKEN_TAG),
  treasury: acc('0x6d6f646c70792f74727372790000000000000000000000000000000000000000', '7L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr', '🏦', { id: 'treasury', name: 'Treasury', color: '#74C742', icon: '🏦' }),
  binance: acc('0x2c1f9eb7a4d0c83e5f6a1b9d2c7e04af8b3d16c9bb22cc33dd44ee55ff6600aa', '0x2c1F9eB7a4D0c83E5f6A1b9D2c7E04aF8b3D16C9', '🐳'),
  fox: acc('0xaa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899', '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr', '🦊', null, { display: 'StakerNode', verified: true, email: 'info@stakernode.com', web: 'https://stakernode.com/', twitter: '@NodeStaker' }),
  owl: acc('0xbb22cc33dd44ee55ff6677889900aabbccddeeff0011223344556677889900aa', '1NPoMQbiA6trJKkjB35uk96MeJD4PGWkLQLH7k7hXEkZpiba', '🦉'),
  swan: acc('0xcc33dd44ee55ff6677889900aabbccddeeff0011223344556677889900aabbcc', '1Rs5Uv6Wx7Yz8Ab9Cd0Ef1Gh2Ij3Kl4Mn5Op6Qr7St8Uv9w', '🦢'),
}
const ACCS = [A.krakenEvm, A.binance, A.fox, A.owl, A.treasury, A.swan]
const COLLATORS = [acc('0xf617ddeb11327140143ea2c663520f91c6f56d351fa2fb5cb5f2b0e80b755b37', '16ZfsSG7swhuyw79EMUcjmV3LEpYpAroUuMv13FZYuYSpb7B', '🌳')]

/* ---------- tag lists ---------- */
// Owners and members are the SAME mock accounts used everywhere else (the fox,
// owl, swan, binance, kraken) — a list's owner card, member pills, and an
// address page's "in these lists" panel must agree on one identity per
// account, exactly as the live accounts/tags/activity feeds already do.
const FOX_PROFILE = { name: 'fox.hdx', avatarVersion: 1 }
const MOCK_PERSONAL_LIST: ListSummaryRef = {
  listId: 'personal', name: 'My list', note: '', visibility: 'private', isPersonal: true,
  owner: { ...A.fox, profile: FOX_PROFILE }, tagCount: 1, accountCount: 1, subscriberCount: 0,
}
// Two public lists, owned by two different existing mock accounts.
export const MOCK_LISTS: ListSummaryRef[] = [
  { listId: 'defi-desks', name: 'DeFi desks', note: 'Accounts trading actively across Omnipool and the money markets', visibility: 'public', isPersonal: false, owner: { ...A.fox, profile: FOX_PROFILE }, tagCount: 2, accountCount: 3, subscriberCount: 3 },
  { listId: 'exchange-wallets', name: 'Exchange wallets', note: 'Known CEX hot and deposit wallets', visibility: 'public', isPersonal: false, owner: A.binance, tagCount: 1, accountCount: 2, subscriberCount: 7 },
]
const MOCK_LIST_DETAILS: Record<string, ListDetailResponse> = {
  'defi-desks': {
    ...MOCK_LISTS[0],
    tags: [
      { tagId: 'defi-desks-active', name: 'Active traders', color: '#5865f2', icon: '📈', note: 'Trades weekly across Omnipool or the router', members: [A.fox, A.owl] },
      { tagId: 'defi-desks-lp', name: 'Liquidity providers', color: '#22c55e', icon: '💧', note: 'Holds a live Omnipool or stablepool position', members: [A.swan] },
    ] satisfies ListTagDetail[],
    subscribed: false,
  },
  'exchange-wallets': {
    ...MOCK_LISTS[1],
    tags: [
      { tagId: 'exchange-wallets-hot', name: 'Hot wallets', color: '#f97316', icon: '🔥', note: 'Active deposit/withdrawal wallets', members: [A.binance, A.krakenEvm] },
    ] satisfies ListTagDetail[],
    subscribed: true,
  },
}
export const MOCK_LIST_DETAIL = MOCK_LIST_DETAILS['defi-desks']
// Which public lists list this address as owner or tagged member — the
// account page's "in these lists" panel. Any address not one of the two
// owners/members below falls back to the fox's set, mirroring buildAddress's
// own unknown-address fallback.
function addressLists(rawAddress: string): ListSummaryRef[] {
  const wanted = decodeURIComponent(rawAddress)
  const is = (a: AccountRef) => a.accountId === wanted || a.address.toLowerCase() === wanted.toLowerCase()
  if (is(A.binance) || is(A.krakenEvm)) return [MOCK_LISTS[1]]
  return [MOCK_LISTS[0]]
}
// Which public lists TAG this address as a member of one of their real
// MOCK_LIST_DETAILS tags — a DIFFERENT question from addressLists above
// (ownership). Unlike addressLists' any-address fallback, this has no
// default: an address that is genuinely nobody's tagged member (Treasury, an
// arbitrary generated one, …) gets [], matching what the real
// publicListsTagging scan would answer.
function addressTaggedIn(rawAddress: string): ListSummaryRef[] {
  const wanted = decodeURIComponent(rawAddress)
  const is = (a: AccountRef) => a.accountId === wanted || a.address.toLowerCase() === wanted.toLowerCase()
  return Object.entries(MOCK_LIST_DETAILS)
    .filter(([, detail]) => detail.visibility === 'public' && detail.tags.some(t => t.members.some(is)))
    .map(([listId]) => MOCK_LISTS.find(l => l.listId === listId)!)
}
// A personal list (the tag map's non-system entry) plus the required
// system marker. `personal-watch` holds a known mock address so a resolved
// pill can be asserted against it.
export const MOCK_TAG_MAP: TagMapResponse = {
  lists: [
    { listId: 'personal', name: 'My list', tags: [
      { tagId: 'personal-watch', name: 'Watching', color: '#f97316', icon: '👀', members: [A.owl.address] },
    ] },
    { listId: 'system', name: 'Hydration', tags: [] },
  ],
}
// The 'personal-watch' tag's own aggregate view — same tagId/name/color/icon a
// pill resolved through MOCK_TAG_MAP links to, so /list/personal/tag/personal-watch
// renders the identical label its pill already showed.
export const MOCK_LIST_TAG_DETAIL: TagDetail = {
  tagId: 'personal-watch', name: 'Watching', color: '#f97316', note: '', icon: '👀',
  members: [A.owl], balances: [], topAssets: [], portfolioUsd: 0,
  moneyMarket: [], liquidityPositions: [], activeDcas: [], portfolioSeries: [], portfolioDates: [], balanceHistory: [],
}
// A private, invite-only list the viewer has been invited to but neither
// owns nor has accepted yet.
const MOCK_INVITE_LIST: ListSummaryRef = {
  listId: 'whale-watch', name: 'Whale watch', note: 'Invite-only — large HDX holders under active monitoring', visibility: 'private', isPersonal: false,
  owner: A.binance, tagCount: 1, accountCount: 2, subscriberCount: 1,
}
export const MOCK_INVITES: ListSummaryRef[] = [MOCK_INVITE_LIST]
export const MOCK_ME: MeResponse = {
  account: { ...A.fox, profile: FOX_PROFILE },
  profile: FOX_PROFILE,
  lists: [MOCK_PERSONAL_LIST, MOCK_LISTS[0]],
  subscriptions: [MOCK_LISTS[1]],
  invites: MOCK_INVITES,
  // Priority order always names every slot, including the built-in 'system'
  // directory — here last, so a viewer's own lists outrank it by default.
  order: [MOCK_PERSONAL_LIST.listId, MOCK_LISTS[0].listId, MOCK_LISTS[1].listId, 'system'],
}

/* ---------- call/event catalogue ---------- */
const CALLS = ['Omnipool.sell', 'Omnipool.buy', 'Router.sell', 'Tokens.transfer', 'Balances.transfer_keep_alive', 'XTokens.transfer', 'Omnipool.add_liquidity', 'Staking.stake', 'DCA.schedule', 'EVM.call']

// How many extrinsics a mock block holds. Shared so every surface that walks a
// block — the block detail, the feeds, and the extrinsic-at lookup's bounds —
// agrees on the same block, exactly as the real API does.
export function blockExtrinsicCount(height: number): number { return 2 + (height % 6) }

function genExtrinsic(height: number, idx: number): ExtrinsicDetail {
  const r = rng(height * 31 + idx * 7)
  const call = CALLS[Math.floor(r() * CALLS.length)]
  const signer = ACCS[Math.floor(r() * ACCS.length)]
  const dest = ACCS[Math.floor(r() * ACCS.length)]
  const aIn = ASSETS[Math.floor(r() * ASSETS.length)], aOut = ASSETS[Math.floor(r() * ASSETS.length)]
  const success = r() > 0.06
  const isInherent = idx < 2
  // The chain's one EVM transaction (see MOCK_EVM_TX): an Ethereum.transact
  // extrinsic, everywhere the mock walks a block, so its hash-resolved page and
  // its height-index page are literally the same row.
  const isEvmTx = height === MOCK_EVM_TX.height && idx === MOCK_EVM_TX.index
  const callName = isInherent ? (idx === 0 ? 'Timestamp.set' : 'ParachainSystem.set_validation_data') : isEvmTx ? 'Ethereum.transact' : call
  const amt = +(10 + r() * 4000).toFixed(4)
  const callArgs: Record<string, unknown> = isEvmTx ? evmTxCallArgs(height, idx, amt) : isInherent
    ? (idx === 0 ? { now: Date.parse(tsAt(height).replace(' ', 'T') + 'Z') } : { data: '0x…relay-chain-state-proof' })
    : call.startsWith('Omnipool.sell') || call.startsWith('Router')
      ? { asset_in: aIn.assetId, asset_out: aOut.assetId, amount: raw(amt, aIn.decimals), min_buy_amount: raw(amt * 0.99, aOut.decimals) }
      : call.startsWith('Tokens.transfer') ? { currency_id: aIn.assetId, dest: dest.address, amount: raw(amt, aIn.decimals) }
      : call.startsWith('Balances') ? { dest: dest.address, value: raw(amt, 12) }
      : call.startsWith('XTokens') ? { currency_id: aIn.assetId, amount: raw(amt, aIn.decimals), dest: { V3: { parents: 1, interior: { X2: [{ Parachain: 2004 }, { AccountId32: { id: dest.address } }] } } } }
      : call.startsWith('EVM') ? { source: EVM_CALLER, target: VERIFIED_CONTRACT_ADDRESS, input: evmTransferInput(height, idx, amt), value: '0', gas_limit: 300000 }
      : { amount: raw(amt, 12) }
  const events = isEvmTx
    ? [
      evmLogEvent(height, idx, amt),
      evmExecutedEvent(),
      // No TransactionPayment.TransactionFeePaid: the EVM takes its own fee, which
      // is why an Ethereum.transact extrinsic shows no substrate fee at all.
      { eventIndex: 3, name: 'System.ExtrinsicSuccess', args: { weight: 412_000_000 } },
    ]
    : isInherent
    ? [{ eventIndex: 0, name: 'System.ExtrinsicSuccess', args: { weight: 137_316_000 } }]
    : success
      ? [
        { eventIndex: 0, name: call.startsWith('Balances') ? 'Balances.Transfer' : 'Tokens.Transfer', args: { currency_id: aIn.assetId, from: signer.address, to: call.startsWith('Omnipool') ? 'Omnipool' : dest.address, amount: raw(amt, aIn.decimals) } },
        ...(call.startsWith('EVM') ? [evmLogEvent(height, idx, amt)] : []),
        { eventIndex: 2, name: 'TransactionPayment.TransactionFeePaid', args: { who: signer.address, actual_fee: raw(0.02, 12), tip: '0' } },
        { eventIndex: 3, name: 'System.ExtrinsicSuccess', args: { weight: 412_000_000 } },
      ]
      : [{ eventIndex: 0, name: 'System.ExtrinsicFailed', args: { dispatch_error: 'Token.BelowMinimum' } }]
  return {
    blockHeight: height, index: idx, hash: hx(height * 17 + idx, 64), timestamp: tsAt(height),
    signer: isInherent ? null : signer, success: isInherent || isEvmTx ? true : success, callName,
    fee: isInherent || isEvmTx ? null : raw(0.002 + r() * 0.05, 12), version: 4, tip: isInherent ? null : '0',
    callArgs, error: success || isInherent || isEvmTx ? null : { module: 'Tokens', error: 'BelowMinimum' }, events,
    ...((call.startsWith('EVM') || isEvmTx) && !isInherent ? { evmCalls: [evmCallDecode(height, idx, amt)] } : {}),
    ...(isEvmTx ? { evmTx: MOCK_EVM_TX_FACTS } : {}),
  }
}

/* ---------- verified-ABI decode fixtures (§9) ---------- */
// The mock EVM.call extrinsic targets the verified contract with a well-formed
// transfer(address,uint256) calldata, and carries the same request-time decode
// shapes the api attaches: `evmCalls` on the extrinsic detail and `evmDecoded`
// on its EVM.Log event.
const EVM_CALLER = '0x4b0540d29f19b2da4cce2b1ba6b6325dd9d86622'
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const evmWord = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
function evmTransferTo(height: number, idx: number): string { return hx(height * 3 + idx + 1, 40) }
function evmTransferAmount(amt: number): string { return raw(amt, 18) }
function evmTransferInput(height: number, idx: number, amt: number): string {
  return `0xa9059cbb${evmWord(evmTransferTo(height, idx))}${evmWord(BigInt(evmTransferAmount(amt)).toString(16))}`
}
function evmCallDecode(height: number, idx: number, amt: number): DecodedEvmCall {
  return {
    target: VERIFIED_CONTRACT_ADDRESS,
    contractName: 'GhoToken',
    call: {
      decoded: true, name: 'transfer', signature: 'transfer(address,uint256)', selector: '0xa9059cbb',
      params: [
        { name: 'to', type: 'address', value: evmTransferTo(height, idx) },
        { name: 'value', type: 'uint256', value: evmTransferAmount(amt) },
      ],
    },
  }
}
function evmTransferLogDecode(height: number, idx: number, amt: number): EvmLogDecode {
  return {
    decoded: true, name: 'Transfer', signature: 'Transfer(address,address,uint256)', decodedBy: 'verified-abi',
    params: [
      { name: 'from', type: 'address', value: EVM_CALLER, indexed: true },
      { name: 'to', type: 'address', value: evmTransferTo(height, idx), indexed: true },
      { name: 'value', type: 'uint256', value: evmTransferAmount(amt) },
    ],
  }
}
function evmLogEvent(height: number, idx: number, amt: number): ExtrinsicDetail['events'][number] {
  return {
    eventIndex: 1,
    name: 'EVM.Log',
    args: {
      log: {
        address: VERIFIED_CONTRACT_ADDRESS,
        topics: [TRANSFER_TOPIC0, `0x${evmWord(EVM_CALLER)}`, `0x${evmWord(evmTransferTo(height, idx))}`],
        data: `0x${evmWord(BigInt(evmTransferAmount(amt)).toString(16))}`,
      },
    },
    decoded: true,
    evmDecoded: evmTransferLogDecode(height, idx, amt),
  }
}

/* ---------- the chain's EVM transaction (Ethereum.transact) ---------- */
// One `Ethereum.transact` extrinsic, addressable BOTH ways: by its extrinsic id
// and by the Ethereum transaction hash a reader pastes from a wallet or another
// explorer. The two hashes are deliberately different values — that is the whole
// reason the hash needs resolving — and both name this one extrinsic, so the
// feeds, the block, the hash lookup and the receipt all agree on one identity.
export const MOCK_EVM_TX = { height: TIP - 5, index: 5 }
export const MOCK_EVM_TX_HASH = hx(909_090, 64)
// Its Ethereum.Executed facts, as the api derives them from that event.
export const MOCK_EVM_TX_FACTS: EvmTransactionFacts = { txHash: MOCK_EVM_TX_HASH, exitKind: 'Succeed', exitDetail: 'Stopped', extraData: null }
// Gas, which nothing indexes: the receipt endpoint answers this for MOCK_EVM_TX_HASH
// and 404s for every other hash, exactly as a node that has no such transaction does.
export const MOCK_EVM_TX_RECEIPT: EvmReceipt = { gasUsed: '355638', effectiveGasPrice: '7000447' }
const MOCK_EVM_TX_GAS_LIMIT = '565795'

/* ---------- a transaction still in the pool (mempool) ---------- */
// One pool transaction: a dry-run PROJECTION with 0-0 block placeholders,
// addressed by hash, leading page 0 of the activity and extrinsics feeds.
export const MOCK_MEMPOOL_HASH = hx(777_777, 64)
function mempoolExtrinsicSummary(): ExtrinsicSummary {
  return { blockHeight: 0, index: 0, hash: MOCK_MEMPOOL_HASH, timestamp: tsAt(TIP + 2), signer: A.fox, success: true, callName: 'Router.sell', fee: null, finalized: false, mempool: true, projected: 'ok' }
}
function mempoolExtrinsicDetail(): ExtrinsicDetail {
  return {
    ...mempoolExtrinsicSummary(),
    version: 4, tip: '0',
    callArgs: { asset_in: ASSETS[2].assetId, asset_out: ASSETS[1].assetId, amount_in: raw(500, ASSETS[2].decimals), min_amount_out: raw(495 * ASSETS[2].price / ASSETS[1].price, ASSETS[1].decimals), route: [] },
    error: null, errorReason: null,
    events: [
      { eventIndex: 0, name: 'Broadcast.Swapped3', args: { swapper: A.fox.address }, decoded: false },
      { eventIndex: 1, name: 'System.ExtrinsicSuccess', args: {}, decoded: false },
    ],
  }
}
function mempoolEventRows(): EventRow[] {
  return mempoolExtrinsicDetail().events.map(e => ({
    blockHeight: 0, eventIndex: e.eventIndex, extrinsicIndex: null, timestamp: tsAt(TIP + 2),
    name: e.name, args: e.args, decoded: false, finalized: false, mempool: true, hash: MOCK_MEMPOOL_HASH,
  }))
}
function mempoolActivityRow(): ActivityRow {
  return {
    type: 'trade', mempool: true, finalized: false, hash: MOCK_MEMPOOL_HASH,
    blockHeight: 0, timestamp: tsAt(TIP + 2), eventIndex: 0, extrinsicIndex: 0,
    who: A.fox, to: null, asset: null, assetIn: aref(ASSETS[2]), assetOut: aref(ASSETS[1]),
    amount: null, amountIn: raw(500, ASSETS[2].decimals), amountOut: raw(500 * ASSETS[2].price / ASSETS[1].price, ASSETS[1].decimals),
    valueUsd: 500 * ASSETS[2].price,
  }
}

// An EIP1559 envelope as raw_extrinsics stores it: the transaction nested under
// `transaction.value`, integers as strings, the target in `action`. Calldata is the
// same verified-ABI transfer the EVM.call fixture uses, so the Parameters tab
// decodes it the same way.
function evmTxCallArgs(height: number, idx: number, amt: number): Record<string, unknown> {
  return {
    transaction: {
      __kind: 'EIP1559',
      value: {
        chainId: '222222', nonce: '141', maxPriorityFeePerGas: '7000447', maxFeePerGas: '7000447',
        gasLimit: MOCK_EVM_TX_GAS_LIMIT,
        action: { __kind: 'Call', value: VERIFIED_CONTRACT_ADDRESS },
        value: '0', input: evmTransferInput(height, idx, amt), accessList: [],
      },
    },
  }
}

function evmExecutedEvent(): ExtrinsicDetail['events'][number] {
  return {
    eventIndex: 2,
    name: 'Ethereum.Executed',
    args: {
      from: EVM_CALLER, to: VERIFIED_CONTRACT_ADDRESS, transactionHash: MOCK_EVM_TX_HASH,
      exitReason: { __kind: 'Succeed', value: { __kind: 'Stopped' } }, extraData: '0x',
    },
  }
}

// The first EVM.call extrinsic below the tip — a stable target for e2e specs
// that exercise the extrinsic detail's decoded rendering.
export function firstEvmCallExtrinsic(): { height: number; index: number } {
  for (let h = TIP; h > TIP - 400; h--) {
    for (let i = 2; i < blockExtrinsicCount(h); i++) {
      const x = genExtrinsic(h, i)
      if (x.callName === 'EVM.call' && x.success) return { height: h, index: i }
    }
  }
  throw new Error('no successful EVM.call extrinsic in the mock window')
}


// Rows above the fixture's finalized boundary (stats.finalizedBlock = TIP - 2)
// carry the pending-head marker, mirroring the api's unfinalized merge.
function mockFinal(h: number): { finalized?: boolean } {
  return h > TIP - 2 ? { finalized: false } : {}
}

function recentExtrinsics(limit: number, signedOnly: boolean): ExtrinsicSummary[] {
  const out: ExtrinsicSummary[] = []
  let h = TIP
  while (out.length < limit && h > TIP - 400) {
    const n = blockExtrinsicCount(h)
    for (let i = n - 1; i >= 0 && out.length < limit; i--) {
      const x = genExtrinsic(h, i)
      if (signedOnly && !x.signer) continue
      out.push({ blockHeight: x.blockHeight, index: x.index, hash: x.hash, timestamp: x.timestamp, signer: x.signer, success: x.success, callName: x.callName, fee: x.fee, ...mockFinal(h) })
    }
    h--
  }
  return out.slice(0, limit)
}

function mockExtrinsicActivity(height: number, index: number): ActivityRow[] {
  const x = genExtrinsic(height, index)
  const r = rng(height * 37 + index * 11)
  const aIn = ASSETS[Math.floor(r() * ASSETS.length)]
  const aOut = ASSETS[Math.floor(r() * ASSETS.length)]
  const amount = +(25 + r() * 2500).toFixed(4)
  const base = {
    blockHeight: height,
    timestamp: x.timestamp,
    eventIndex: 0,
    extrinsicIndex: index,
    who: x.signer,
    to: null as AccountRef | null,
    asset: null as AssetRef | null,
    assetIn: null as AssetRef | null,
    assetOut: null as AssetRef | null,
    amount: null as string | null,
    amountIn: null as string | null,
    amountOut: null as string | null,
    valueUsd: amount * aIn.price,
    linkBlock: height,
    linkIndex: index,
  }
  if (!x.signer) return []
  if (/transfer/i.test(x.callName)) return [{ ...base, type: x.callName.startsWith('XTokens') ? 'xcm' : 'transfer', to: ACCS[(index + 1) % ACCS.length], asset: aref(aIn), amount: raw(amount, aIn.decimals), destChain: x.callName.startsWith('XTokens') ? 'Moonbeam' : undefined }]
  if (/liquidity/i.test(x.callName)) return [{ ...base, type: 'liquidity', asset: aref(aIn), amount: raw(amount, aIn.decimals), liqAction: 'Add' }]
  if (/staking/i.test(x.callName)) return [{ ...base, type: 'staking', asset: aref(ASSETS[0]), amount: raw(amount, ASSETS[0].decimals), stakingAction: 'Stake' }]
  if (/DCA/i.test(x.callName)) return [{ ...base, type: 'trade', assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amount, aIn.decimals), amountOut: raw(amount * aIn.price / aOut.price, aOut.decimals), dca: true, dcaScheduleId: 33546 }]
  if (/EVM/i.test(x.callName)) return [{ ...base, type: 'mm', asset: aref(aIn), amount: raw(amount, aIn.decimals), mmAction: 'Supply' }]
  return [{ ...base, type: 'trade', assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amount, aIn.decimals), amountOut: raw(amount * aIn.price / aOut.price, aOut.decimals) }]
}

// Derive OTC sub-fields from the row identity so every feed returns the same row.
function otcFields(h: number, aIn: MAsset, aOut: MAsset, amt: number): {
  action: NonNullable<ActivityRow['otcAction']>; orderId: number; partiallyFillable?: boolean; partial?: boolean; fee?: string
} {
  const action = (['Place', 'Pull', 'Fill'] as const)[h % 3]
  const orderId = 1000 + (h % 900)
  if (action === 'Place') return { action, orderId, partiallyFillable: h % 2 === 0 }
  if (action === 'Fill') return { action, orderId, partial: h % 5 === 0, fee: raw((amt * aIn.price / aOut.price) * 0.001, aOut.decimals) }
  return { action, orderId }
}

// Deterministic single row for a given height, computed the same way the
// `/explorer/activity` feed's per-height loop does (below) — a pure function of
// `h` via its own freshly-seeded rng, so it reproduces byte-identical output to
// whatever the feed showed for that height. Included in mockBlockActivity so a
// row clicked in the Activity feed is still found when its own block's activity
// is re-fetched (e.g. by ActivityDetailPage's row lookup), instead of "not found".
function activityRowAtHeight(h: number): ActivityRow {
  const r = rng(h * 2654435761 + 13)
  const types: ActivityRow['type'][] = ['trade', 'transfer', 'xcm', 'liquidity', 'mm', 'dca', 'otc']
  const t = types[h % types.length]
  const aIn = ASSETS[Math.floor(r() * ASSETS.length)], aOut = ASSETS[Math.floor(r() * ASSETS.length)]
  const amt = r() < 0.25 ? +((0.5 + r() * 8) / aIn.price).toFixed(6) : +(10 + r() * 4000).toFixed(2)
  const who = ACCS[Math.floor(r() * ACCS.length)]
  const base = { blockHeight: h, timestamp: tsAt(h), eventIndex: h % 100, extrinsicIndex: 2 + Math.floor(r() * 3), who, to: null as AccountRef | null, asset: null as AssetRef | null, assetIn: null as AssetRef | null, assetOut: null as AssetRef | null, amount: null as string | null, amountIn: null as string | null, amountOut: null as string | null, valueUsd: amt * aIn.price }
  if (t === 'trade' || t === 'dca') return { ...base, type: t, assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amt, aIn.decimals), amountOut: raw(amt * aIn.price / aOut.price, aOut.decimals), ...(t === 'dca' ? { dca: true, dcaScheduleId: 33546 } : {}) }
  if (t === 'otc') {
    const f = otcFields(h, aIn, aOut, amt)
    if (f.action === 'Pull') return { ...base, type: t, valueUsd: null, otcAction: f.action, otcOrderId: f.orderId }
    return { ...base, type: t, assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amt, aIn.decimals), amountOut: raw(amt * aIn.price / aOut.price, aOut.decimals), otcAction: f.action, otcOrderId: f.orderId, otcPartiallyFillable: f.partiallyFillable, otcPartial: f.partial, otcFee: f.fee }
  }
  if (t === 'xcm' && h % 2 === 0) return { ...base, type: t, extrinsicIndex: null, asset: aref(aIn), amount: raw(amt, aIn.decimals), xcmDir: 'in', fromChain: 'AssetHub', fromAccount: xcmExternalAccount(h) }
  if (t === 'transfer' || t === 'xcm') return { ...base, type: t, to: ACCS[Math.floor(r() * ACCS.length)], asset: aref(aIn), amount: raw(amt, aIn.decimals), destChain: t === 'xcm' ? 'Moonbeam' : undefined, xcmDir: t === 'xcm' ? 'out' : undefined }
  // GIGAHDX reaches the feed mainly through the debt side of its market: the
  // collateral legs of a GIGAHDX stake are that staking row's plumbing and the API
  // suppresses them, so a mock Lend/Withdraw belongs to the primary market.
  const mmAction = t === 'mm' ? ['Supply', 'Borrow', 'Repay', 'Withdraw'][Math.floor(r() * 4)] : undefined
  const gigaMm = mmAction === 'Borrow' || mmAction === 'Repay'
  return { ...base, type: t, asset: aref(aIn), amount: raw(amt, aIn.decimals), mmAction, ...(gigaMm ? { mmMarketKey: 'gigahdx', mmMarket: 'GIGAHDX' } : {}) }
}

// One vote per height, cycling the conviction values the chain actually emits —
// including `None`, the no-lock vote that carries 0.1x and used to render as the
// word "None" beside votes showing a multiplier, i.e. as missing data.
export const MOCK_VOTE_CONVICTIONS = ['Locked6x', 'None', 'Locked2x', 'Locked1x', 'Locked5x'] as const
export function voteRowAtHeight(h: number): ActivityRow {
  const conviction = MOCK_VOTE_CONVICTIONS[h % MOCK_VOTE_CONVICTIONS.length]
  const hdx = ASSETS[0]
  const amt = 1000 + (h % 9000)
  return {
    type: 'vote', blockHeight: h, timestamp: tsAt(h), eventIndex: 95, extrinsicIndex: 3,
    who: ACCS[h % ACCS.length], to: null, asset: aref(hdx), assetIn: null, assetOut: null,
    amount: raw(amt, hdx.decimals), amountIn: null, amountOut: null, valueUsd: amt * hdx.price,
    votePallet: 'ConvictionVoting', voteAction: 'Voted', voteRef: 380,
    voteSide: h % 7 === 0 ? 'Nay' : 'Aye', voteConviction: conviction,
    voteRefPallet: 'opengov', voteRefTitle: 'Security patch runtime upgrade v50.0.2',
    linkBlock: h, linkIndex: 3,
  }
}

// Inbound XCM's source account, cycling through a tagged, an identity-only, and
// a plain local account by the same pubkey — demonstrates ExternalAccountPill's
// full tag > identity > address precedence (same pubkey, same Hydration
// tag/identity, even shown as an AssetHub-side sender).
function xcmExternalAccount(h: number): NonNullable<ActivityRow['fromAccount']> {
  const src = [A.krakenSub, A.fox, A.owl][(h / 2) % 3]
  return {
    kind: 'AccountId32', address: src.address, raw: src.accountId,
    subscanUrl: `https://assethub-polkadot.subscan.io/account/${encodeURIComponent(src.address)}`,
    emoji: src.emoji, emojiName: src.emojiName, emojiUrl: src.emojiUrl,
    tag: src.tag, identity: src.identity ?? null,
  }
}

function mockBlockActivity(height: number): ActivityRow[] {
  const n = blockExtrinsicCount(height)
  const rows = Array.from({ length: n }, (_, i) => mockExtrinsicActivity(height, i)).flat()
  rows.push(activityRowAtHeight(height))
  // So a vote opened from the feed is found again when its own block is
  // re-fetched by the detail page's row lookup.
  rows.push(voteRowAtHeight(height))
  const aIn = ASSETS[2], aOut = ASSETS[1]
  rows.push({
    type: 'trade',
    blockHeight: height,
    timestamp: tsAt(height),
    eventIndex: 77,
    extrinsicIndex: null,
    who: A.fox,
    to: null,
    asset: null,
    assetIn: aref(aIn),
    assetOut: aref(aOut),
    amount: null,
    amountIn: raw(1234.56, aIn.decimals),
    amountOut: raw(1234.56 * aIn.price / aOut.price, aOut.decimals),
    valueUsd: 1234.56 * aIn.price,
  })
  return rows
}

/* ---------- money market ---------- */
function mmFor(seed: number) {
  const r = rng(seed)
  const supply = 5000 + r() * 90000
  const debt = r() > 0.4 ? supply * (0.2 + r() * 0.45) : 0
  const hf = debt > 0 ? (supply * 0.78) / debt : Infinity
  return { supply, debt, hf }
}

/* ---------- builders per route ---------- */
function buildAssets(): AssetListItem[] {
  return ASSETS.map(a => ({ ...aref(a), price: a.price, change24h: a.ch / 100, change7d: a.ch7d / 100, type: a.type, amountUsd: 2_000_000 * (0.3 + rng(a.assetId + 9)() * 4), holderCount: 20 + Math.floor(rng(a.assetId + 17)() * 8000), sparkline: series(a.assetId * 13 + 1, 14, a.price) }))
}
// A structural pot touches balances on every trade, so its own activity feed runs deeper
// than the directory's counter can reach and its total is a FLOOR — "at least this many",
// rendered with a trailing '+'. The floor is deliberately the LARGEST number in the
// column so that both halves of the rule are observable: an ordering that forgot the
// completeness term would rank this row first instead of last.
const ACTIVITY_FLOOR_ACCOUNT = A.treasury
const ACTIVITY_FLOOR_COUNT = 50_000

// Shared by buildAccounts and buildAccountsForViewer, so a viewer-folded page
// ranks its (re-summed) rows the exact same way the plain directory does.
function sortAccountRows(rows: TopAccountRow[], sort: string): TopAccountRow[] {
  const health = (row: TopAccountRow) => {
    if (!row.healthFactor) return Number.POSITIVE_INFINITY
    return row.healthFactor === 'inf' ? Number.MAX_SAFE_INTEGER : Number(row.healthFactor)
  }
  return [...rows].sort((a, b) => {
    if (sort === 'supplied') return (b.suppliedUsd ?? -1) - (a.suppliedUsd ?? -1)
    if (sort === 'borrowed') return (b.borrowedUsd ?? -1) - (a.borrowedUsd ?? -1)
    if (sort === 'health') return health(a) - health(b)
    // Mirrors the server's `activity_count_complete DESC, activity_count DESC,
    // usd_total DESC`. The completeness term comes FIRST: a floor says only "at least
    // this many", so ranking it against an exact total by number alone would put a
    // "known to be at least 50k" above a "known to be exactly 2,143".
    if (sort === 'activity') {
      return Number(b.activityCountComplete ?? false) - Number(a.activityCountComplete ?? false)
        || (b.activityCount ?? -1) - (a.activityCount ?? -1)
        || b.portfolioUsd - a.portfolioUsd
    }
    if (sort === 'volume') return (b.tradingVolumeUsd ?? -1) - (a.tradingVolumeUsd ?? -1) || b.portfolioUsd - a.portfolioUsd
    if (sort === 'liquidation') return (b.liquidationVolumeUsd ?? -1) - (a.liquidationVolumeUsd ?? -1) || b.portfolioUsd - a.portfolioUsd
    if (sort === 'identity') {
      // Named rows first, alphabetically; unnamed by value (mirrors the server).
      const an = a.identity ?? a.tag?.name ?? '', bn = b.identity ?? b.tag?.name ?? ''
      return Number(Boolean(bn)) - Number(Boolean(an)) || an.localeCompare(bn) || b.portfolioUsd - a.portfolioUsd
    }
    return b.portfolioUsd - a.portfolioUsd
  })
}
function buildAccounts(offset: number, limit: number, sort: string): AccountsPage {
  const rows: TopAccountRow[] = []
  // Kraken tag (2 members) as one row
  // 53 weekly points = the real API's 1Y padded sparkline shape.
  rows.push({ account: null, tag: { tagId: 'kraken', name: 'Kraken', color: '#7b6cf6', icon: '/tag-icons/kraken.jpg', memberCount: 2 }, portfolioUsd: 5_240_000, lastBlock: TIP - 12, healthFactor: '1410000000000000000', identity: 'Kraken', suppliedUsd: null, borrowedUsd: null, supplementalMarket: { marketKey: 'gigahdx', market: 'GIGAHDX', borrowedUsd: 6_200, healthFactor: '2380000000000000000' }, sparkline: series(99, 53, 5_240_000), activityCount: 2143, activityCountComplete: true, tradingVolumeUsd: 82_400_000, liquidationVolumeUsd: 740_000 })
  const seeds: [AccountRef, number][] = [[A.binance, 3_900_000], [A.fox, 1_240_000], [A.treasury, 980_000], [A.owl, 410_000], [A.swan, 96_000]]
  for (const [a, usd] of seeds) {
    const mm = mmFor(a.accountId.length * 7)
    const floor = a === ACTIVITY_FLOOR_ACCOUNT
    rows.push({ account: a, tag: null, portfolioUsd: usd, lastBlock: TIP - Math.floor(usd % 900), healthFactor: mm.debt > 0 ? BigInt(Math.round(mm.hf * 1e18)).toString() : 'inf', identity: a === A.binance ? 'Binance' : null, suppliedUsd: mm.supply > 0 ? mm.supply : null, borrowedUsd: mm.debt > 0 ? mm.debt : null, supplementalMarket: a === A.fox ? { marketKey: 'gigahdx', market: 'GIGAHDX', borrowedUsd: 4_800, healthFactor: '2500000000000000000' } : null, sparkline: series(a.accountId.length * 31, 53, usd), activityCount: floor ? ACTIVITY_FLOOR_COUNT : 100 + (usd % 4000), activityCountComplete: !floor, tradingVolumeUsd: usd * (12 + (a.accountId.charCodeAt(4) % 9)), liquidationVolumeUsd: mm.debt > 0 ? usd * (0.08 + (a.accountId.charCodeAt(6) % 5) / 100) : undefined })
  }
  const sorted = sortAccountRows(rows, sort)
  return { rows: sorted.slice(offset, offset + limit), total: sorted.length }
}

// The contracts directory: a verified top-level create, a factory child
// ("first seen", destroyed, unverified) and an unknown-provenance contract, so
// every creation label and both verification states are exercised. Hoisted so
// buildAddress can attach the same rows to their account pages (same identity
// across feeds, per the mock-data rule).
const evmContractRef = (h160: string): AccountRef => ({ accountId: '0x45544800' + h160.slice(2) + '0000000000000000', address: h160, emoji: '🪙', tag: null, identity: null, profile: null, isContract: true })
export const VERIFIED_CONTRACT_ADDRESS = '0x531a654d1696ed52e7275a8cede955e82620f99a'
export const UNVERIFIED_CONTRACT_ADDRESS = '0x9a1c2b3d4e5f60718293a4b5c6d7e8f901234567'
// A verified ERC1967 proxy in front of the verified contract: its own ABI has
// no functions (constructor, events, fallback), so Read/Write must resolve the
// implementation. The e2e RPC mock answers its EIP-1967 slot accordingly.
export const PROXY_CONTRACT_ADDRESS = '0x7b1967aa5e0d38d1f2a1e6f7dd5f5cbe4c31c0de'
const MOCK_CONTRACTS: ContractInfo[] = [
  {
    address: VERIFIED_CONTRACT_ADDRESS, account: evmContractRef(VERIFIED_CONTRACT_ADDRESS),
    verified: { status: 'verified', name: 'GhoToken', matchType: 'exact_match' },
    verification: {
      status: 'verified', name: 'GhoToken', compilerVersion: 'v0.8.10+commit.fc410830', matchType: 'exact_match',
      source: 'verified', verifiedAt: tsAt(TIP - 100), abiPresent: true, sourceFileCount: 2, supersededBytecode: false,
    },
    creation: { method: 'create', deployer: A.fox, deployerWhitelisted: true, blockHeight: TIP - 2_000_000, extrinsicIndex: 2, timestamp: tsAt(TIP - 2_000_000), txHash: '0x' + 'ab'.repeat(32) },
    codeHash: '0x' + 'cd'.repeat(32), codeSize: 10719, destroyed: false,
    txCount: 41230, logCount: 96780, firstActivity: tsAt(TIP - 2_000_000), lastActivity: tsAt(TIP - 40),
  },
  {
    address: '0x02639ec01313c8775fae74f2dad1118c8a8a86da', account: evmContractRef('0x02639ec01313c8775fae74f2dad1118c8a8a86da'),
    verified: null, verification: { status: 'unverified' },
    creation: { method: 'factory', factory: evmContractRef('0x1b02e051683b5cfac5929c25e84adb26ecf87b38'), attribution: 'first-log', blockHeight: TIP - 900_000, timestamp: tsAt(TIP - 900_000), txHash: '0x' + 'ef'.repeat(32) },
    codeHash: '0x' + '12'.repeat(32), codeSize: 13783, destroyed: true,
    txCount: 340, logCount: 2210, firstActivity: tsAt(TIP - 900_000), lastActivity: tsAt(TIP - 120_000),
  },
  {
    address: UNVERIFIED_CONTRACT_ADDRESS, account: evmContractRef(UNVERIFIED_CONTRACT_ADDRESS),
    verified: null, verification: { status: 'unverified' },
    creation: { method: 'unknown' },
    codeHash: '0x' + '34'.repeat(32), codeSize: 2333, destroyed: false,
    txCount: 12, logCount: 0, firstActivity: tsAt(TIP - 300_000), lastActivity: tsAt(TIP - 300_000),
  },
  {
    address: PROXY_CONTRACT_ADDRESS, account: evmContractRef(PROXY_CONTRACT_ADDRESS),
    verified: { status: 'verified', name: 'ERC1967Proxy', matchType: 'match' },
    verification: {
      status: 'verified', name: 'ERC1967Proxy', compilerVersion: 'v0.8.19+commit.7dd6d404', matchType: 'match',
      source: 'verified', verifiedAt: tsAt(TIP - 80), abiPresent: true, sourceFileCount: 1, supersededBytecode: false,
    },
    creation: { method: 'create', deployer: A.fox, deployerWhitelisted: true, blockHeight: TIP - 150_000, extrinsicIndex: 1, timestamp: tsAt(TIP - 150_000), txHash: '0x' + '77'.repeat(32) },
    codeHash: '0x' + '56'.repeat(32), codeSize: 733, destroyed: false,
    txCount: 18, logCount: 3, firstActivity: tsAt(TIP - 150_000), lastActivity: tsAt(TIP - 200),
  },
]

// The verified contract's lazy artifacts (Code/Read sub-tabs); unverified
// addresses fall through to the harness 404 exactly like the real API.
const MOCK_CONTRACT_ABI = {
  address: VERIFIED_CONTRACT_ADDRESS,
  abi: [
    { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
    { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
    { type: 'function', name: 'symbol', stateMutability: 'pure', inputs: [], outputs: [{ name: '', type: 'string' }] },
    { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
    { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
    { type: 'event', name: 'Transfer', inputs: [] },
  ],
  source: 'verified',
  contractName: 'GhoToken',
}
// The proxy's own verified ABI, deliberately function-free — the shape that
// forces Read/Write through the implementation.
const MOCK_PROXY_ABI = {
  address: PROXY_CONTRACT_ADDRESS,
  abi: [
    { type: 'constructor', stateMutability: 'payable', inputs: [{ name: '_logic', type: 'address' }, { name: '_data', type: 'bytes' }] },
    { type: 'event', name: 'Upgraded', inputs: [{ name: 'implementation', type: 'address', indexed: true }] },
    { type: 'fallback', stateMutability: 'payable' },
    { type: 'receive', stateMutability: 'payable' },
  ],
  source: 'verified',
  contractName: 'ERC1967Proxy',
}
const MOCK_CONTRACT_SOURCES = {
  address: VERIFIED_CONTRACT_ADDRESS,
  files: [
    { path: 'src/GhoToken.sol', content: '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.10;\n\ncontract GhoToken {\n  uint256 public totalSupply;\n}\n' },
    { path: 'src/lib/Math.sol', content: 'library Math { function min(uint256 a, uint256 b) internal pure returns (uint256) { return a < b ? a : b; } }\n' },
  ],
  compiler: { version: 'v0.8.10+commit.fc410830', evmVersion: 'london', optimizerEnabled: true, optimizerRuns: 200, constructorArguments: '0xabcd', settings: null },
}

export function mockContractByAddress(address: string): ContractInfo | undefined {
  const lc = address.toLowerCase()
  return MOCK_CONTRACTS.find(c => c.address === lc || c.account.accountId === lc)
}

function buildContracts(offset: number, limit: number, sort: string): ContractsPage {
  const rows = MOCK_CONTRACTS
  const created = (c: ContractInfo) => c.creation.blockHeight ?? -1
  const sorted = [...rows].sort((a, b) => {
    if (sort === 'txs') return b.txCount - a.txCount || (a.address < b.address ? -1 : 1)
    if (sort === 'logs') return b.logCount - a.logCount || (a.address < b.address ? -1 : 1)
    if (sort === 'active') return (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '') || (a.address < b.address ? -1 : 1)
    return created(b) - created(a) || (a.address < b.address ? -1 : 1)
  })
  return { contracts: sorted.slice(offset, offset + limit), total: sorted.length }
}

// Contract-tab activity views. The verified contract's rows carry decoded
// method chips and named events (with one selector-only and one raw row per
// cycle so the fallbacks stay exercised); an unverified contract gets bare
// selectors and topics. Unknown addresses fall through to the harness 404.
const MOCK_CONTRACT_TX_TOTAL = 60
function buildContractTransactions(address: string, offset: number, limit: number): ContractTransactionsPage | undefined {
  const c = mockContractByAddress(address)
  if (!c) return undefined
  const verified = !!c.verified
  const rows = Array.from({ length: Math.max(0, Math.min(limit, MOCK_CONTRACT_TX_TOTAL - offset)) }, (_, k) => {
    const n = offset + k
    const r = rng(n * 13 + 7)
    const height = TIP - 40 - n * 7
    return {
      blockHeight: height, extrinsicIndex: 2, timestamp: tsAt(height), txHash: hx(n * 11 + 3, 64),
      from: ACCS[Math.floor(r() * ACCS.length)], success: r() > 0.1,
      method: !verified ? { selector: '0x12345678', name: null, signature: null }
        : n % 5 === 4 ? { selector: '0xdeadbeef', name: null, signature: null }
          : { selector: '0xa9059cbb', name: 'transfer', signature: 'transfer(address,uint256)' },
    }
  })
  return { transactions: rows, total: MOCK_CONTRACT_TX_TOTAL }
}

const MOCK_CONTRACT_EVENT_TOTAL = 40
function buildContractEvents(address: string, offset: number, limit: number): ContractEventsPage | undefined {
  const c = mockContractByAddress(address)
  if (!c) return undefined
  const verified = !!c.verified
  const rows: ContractEventRow[] = Array.from({ length: Math.max(0, Math.min(limit, MOCK_CONTRACT_EVENT_TOTAL - offset)) }, (_, k) => {
    const n = offset + k
    const height = TIP - 45 - n * 9
    const base = {
      blockHeight: height, eventIndex: 4, extrinsicIndex: 2, timestamp: tsAt(height),
      topics: [TRANSFER_TOPIC0, `0x${evmWord(EVM_CALLER)}`, `0x${evmWord(evmTransferTo(height, 4))}`],
      data: `0x${evmWord('f4240')}`,
    }
    if (verified && n % 3 === 0) return { ...base, name: 'Transfer', decodedBy: 'verified-abi' as const, evmDecoded: evmTransferLogDecode(height, 4, 12.5) }
    if (n % 3 === 1) return { ...base, name: 'Borrow', decodedBy: 'ingest' as const, args: { reserve: c.address, user: EVM_CALLER, amount: raw(12.5, 18) } }
    return { ...base, name: null, topics: [hx(n * 5 + 1, 64)], data: `0x${evmWord('1234')}` }
  })
  return { events: rows, total: MOCK_CONTRACT_EVENT_TOTAL }
}

// The accounts directory, folded under a VIEWER's own tags too — the mock's
// analogue of userListService.directoryFoldFor + accountsPage's viewer-fold
// grouping. Walks tagMap.lists in priority order exactly like resolveTag()
// (userTags.ts) does client-side, but over buildAccounts's own already
// system-tag-grouped rows: the 'system' slot wins a row that already carries
// a system tag (never overridden), and the first list ahead of it whose tag
// contains the row's account wins otherwise — summed exactly like a system
// tag's own group, not fetched from a separate aggregate.
//
// Known, deliberate divergence from the real SQL: this operates on
// buildAccounts's OWN already-grouped TopAccountRow[] and folds by
// `listId:tagId` alone. It has no notion of the real query's `label_id` —
// the per-account system-tag id the `grouped` CTE ALSO groups by (see
// accountsPage's `labelIdSql`) — so it cannot reproduce a real regression
// where a single user tag holds both a system-tagged and a system-tagless
// account and the SQL's grouping splits it in two. That regression is
// covered at the API level instead (accountsViewerFold.test.ts), where the
// real grouping expressions are exercised; this mock only has to give the
// e2e suite deterministic, plausible fold ROWS to assert rendering against.
export function buildAccountsForViewer(tagMap: TagMapResponse | null, offset: number, limit: number, sort: string): AccountsPage {
  if (!tagMap) return buildAccounts(offset, limit, sort)
  const { rows } = buildAccounts(0, 1000, sort)
  const winnerFor = (row: TopAccountRow) => {
    if (!row.account) return null   // already a system-tag group row — never re-folds
    for (const lib of tagMap.lists) {
      if (lib.listId === 'system') { if (row.account.tag) return null; continue }
      const tag = lib.tags.find(t => t.members.includes(row.account!.accountId))
      if (tag) return { tagId: tag.tagId, listId: lib.listId, name: tag.name, color: tag.color, icon: tag.icon, memberCount: tag.members.length }
    }
    return null
  }
  const groups = new Map<string, TopAccountRow>()
  const out: TopAccountRow[] = []
  for (const row of rows) {
    const winner = winnerFor(row)
    if (!winner) { out.push(row); continue }
    const key = `${winner.listId}:${winner.tagId}`
    const existing = groups.get(key)
    if (existing) {
      existing.portfolioUsd += row.portfolioUsd
      if (row.suppliedUsd) existing.suppliedUsd = (existing.suppliedUsd ?? 0) + row.suppliedUsd
      if (row.borrowedUsd) existing.borrowedUsd = (existing.borrowedUsd ?? 0) + row.borrowedUsd
      if (row.tradingVolumeUsd) existing.tradingVolumeUsd = (existing.tradingVolumeUsd ?? 0) + row.tradingVolumeUsd
      if (row.liquidationVolumeUsd) existing.liquidationVolumeUsd = (existing.liquidationVolumeUsd ?? 0) + row.liquidationVolumeUsd
      continue
    }
    const grouped: TopAccountRow = {
      ...row, account: null, identity: winner.name,
      tag: { tagId: winner.tagId, name: winner.name, color: winner.color, icon: winner.icon, memberCount: winner.memberCount, userTagId: winner.tagId, listId: winner.listId },
    }
    groups.set(key, grouped)
    out.push(grouped)
  }
  const sorted = sortAccountRows(out, sort)
  return { rows: sorted.slice(offset, offset + limit), total: sorted.length }
}
// Deterministic HDX lock/reserve breakdown for a balance of `bal` tokens (free =
// 92%, reserved = 8%, matching the mock balance split): overlapping vesting /
// governance / staking / GIGAHDX locks, a binding unlock timeline whose slices
// sum exactly to `frozen`, and reserve components that deliberately cover only
// part of `reserved` so the "other" remainder row is exercised.
function hdxBreakdown(bal: number, dec: number): Pick<AddressBalance, 'frozen' | 'breakdown' | 'timeline'> {
  const f = (x: number) => raw(bal * x, dec)
  // Unlock `until` dates anchor to WALL-CLOCK now, not MOCK_NOW_MS: the panel
  // renders them relative to the real Date.now(), so a fixed anchor would make
  // the "in Nd" text drift and eventually flip to "now" as real time overtakes
  // it. Anchoring to now keeps the relative display (what tests assert) stable.
  const inDays = (n: number) => tsMs(Date.now() + n * 86400e3)
  return {
    frozen: f(0.566), // the binding lock envelope across the overlapping locks
    breakdown: [
      { kind: 'lock', source: 'vesting', amount: f(0.506), claimable: f(0.138) },
      { kind: 'lock', source: 'vote', amount: f(0.414) },
      { kind: 'lock', source: 'staking', amount: f(0.276) },
      { kind: 'lock', source: 'gigahdx', amount: f(0.166) },
      { kind: 'reserve', source: 'dca', amount: f(0.03) },
      { kind: 'deposit', source: 'identity', amount: f(0.012) },
      { kind: 'deposit', source: 'multisig', amount: f(0.008) },
    ],
    // when · how much · why (act-now semantics) — sums to frozen
    // (0.08+0.055+0.1+0.09+0.211+0.03 = 0.566)
    timeline: [
      { state: 'releasable', cause: 'staking', amount: f(0.08) },
      { state: 'scheduled', cause: 'gigahdx', amount: f(0.055), until: inDays(21) },
      { state: 'scheduled', cause: 'gigahdx', amount: f(0.1), until: inDays(28), conditional: true },
      { state: 'scheduled', cause: 'vote', amount: f(0.09), until: inDays(36) },
      { state: 'scheduled', cause: 'vesting', amount: f(0.211), until: inDays(230), linear: true },
      { state: 'active', cause: 'vote', amount: f(0.03) },
    ],
  }
}

function buildAddress(accountId: string): AddressDetail {
  // A contract address gets the contract's own account ref (and the `contract`
  // field below), so its account page grows the Contract tab; everything else
  // keeps the fox fallback.
  const contract = mockContractByAddress(accountId)
  const a = contract?.account ?? ACCS.find(x => x.accountId === accountId || x.address.toLowerCase() === accountId.toLowerCase()) ?? A.fox
  const r = rng(a.accountId.length * 17)
  const priced = ASSETS.filter((_, i) => (r() > 0.4) || i < 2).slice(0, 6).map(as => {
    const bal = +(r() * (as.price > 1000 ? 3 : as.price > 1 ? 6000 : 2_000_000)).toFixed(4)
    return {
      asset: aref(as), total: raw(bal, as.decimals), free: raw(bal * 0.92, as.decimals), reserved: raw(bal * 0.08, as.decimals), lastBlock: TIP - Math.floor(r() * 40000), valueUsd: bal * as.price,
      // HDX carries the full lock breakdown; DOT shows the single-component
      // shape (an OTC order reserve) for a non-native asset.
      ...(as.assetId === 0 ? hdxBreakdown(bal, as.decimals) : {}),
      ...(as.assetId === 5 ? { breakdown: [{ kind: 'reserve' as const, source: 'otc', amount: raw(bal * 0.08, as.decimals) }] } : {}),
    }
  }).sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0))
  // The fox additionally holds one asset with no market price, so the "without a
  // market price" rows beneath the treemap are exercised.
  const unpricedHoldings: AddressBalance[] = a === A.fox
    ? [{ asset: { assetId: 424242, symbol: 'MYST', name: 'Mystery Token', decimals: 12, parachainId: null }, total: raw(150_000, 12), free: raw(150_000, 12), reserved: '0', lastBlock: TIP - 5000, valueUsd: null }]
    : []
  // The owl carries a long tail of sub-threshold dust (no market history), so its
  // treemap folds into an "Other" tile — the fixture for the Other/no-history
  // hover behaviour.
  const dustHoldings: AddressBalance[] = a === A.owl
    ? Array.from({ length: 12 }, (_, i) => ({
        asset: { assetId: 700001 + i, symbol: `DUST${i + 1}`, name: `Dust asset ${i + 1}`, decimals: 12, parachainId: null },
        total: raw(10 + i, 12), free: raw(10 + i, 12), reserved: '0', lastBlock: TIP - 100 * i, valueUsd: 0.2 + i * 0.05,
      }))
    : []
  const balances = [...priced, ...unpricedHoldings, ...dustHoldings]
  const portfolioUsd = balances.reduce((s, b) => s + (b.valueUsd ?? 0), 0)
  const isEvm = a.address.startsWith('0x')
  const mm = mmFor(a.accountId.length * 7)
  const hasMm = mm.supply > 0 && (a === A.krakenEvm || a === A.fox || a === A.binance)
  const boundEvm = !isEvm && hasMm ? `0x${a.accountId.slice(2, 42)}` : null
  return {
    input: a.address, kind: isEvm ? 'evm' : 'ss58', accountId: a.accountId, emoji: a.emoji,
    evmAddress: isEvm ? a.address : null,
    ss58: a.address.startsWith('1') || a.address.startsWith('7') ? a.address : '7' + a.accountId.slice(2, 47),
    ss58Polkadot: isEvm ? '1MqRsT3uV4wX5yZ6aB7cD8eF9gH0iJ1kL2mN3pQ4rS5tU6v' : a.address,
    tag: a.tag, identity: a.identity ?? null, relatedAccountIds: [a.accountId],
    aliases: isEvm
      ? [{ accountId: a.accountId, evmAddress: a.address, primaryProfile: a.address, relationship: 'EVMAccounts.Bound', confidence: 100 }]
      : boundEvm
        ? [{ accountId: a.accountId, evmAddress: boundEvm, primaryProfile: `evm:${boundEvm}`, relationship: 'explicit_binding', confidence: 1 }]
        : [],
    balances, portfolioUsd, tradingVolumeUsd: portfolioUsd * (18 + (a.accountId.charCodeAt(5) % 11)), liquidationVolumeUsd: hasMm ? portfolioUsd * 0.11 : undefined,
    activeDcas: [
      { id: 33546, assetIn: aref(assetById.get(0)!), assetOut: aref(assetById.get(10)!), direction: 'Sell', amountPerTrade: raw(60000, 12), totalAmount: raw(1_200_000, 12), filledAmount: raw(480_000, 12), remainingAmount: raw(720_000, 12), executionsDone: 8, period: 180, nextExecutionBlock: TIP + 90, valueUsd: 3080, scheduleBlock: TIP - 40000, scheduleIndex: 2 },
      { id: 30104, assetIn: aref(assetById.get(5)!), assetOut: aref(assetById.get(0)!), direction: 'Sell', amountPerTrade: raw(1.04, 10), totalAmount: '0', filledAmount: raw(101_818, 10), remainingAmount: null, executionsDone: 97902, period: 10, nextExecutionBlock: TIP + 4, valueUsd: 4.6, scheduleBlock: TIP - 500000, scheduleIndex: 3 },
    ],
    balanceHistory: [
      ...balances.slice(0, 5).map(b => {
        const tokens = Number(b.total) / 10 ** b.asset.decimals
        const ser = series(b.asset.assetId * 17 + 3, 30, Math.max(tokens, 1))
        return { asset: b.asset, current: tokens, points: ser.map((v, i) => ({ ts: tsAt(TIP - (29 - i) * 18000), blockHeight: TIP - (29 - i) * 18000, balance: v })) }
      }),
      // A holding the fox has since exited: it has a balance history but no
      // current balance, so it appears only in the "historically held" rows.
      ...(a === A.fox ? [{
        asset: { assetId: 313131, symbol: 'PAST', name: 'Former Holding', decimals: 10, parachainId: null } as AssetRef,
        current: 0,
        points: series(313131, 20, 5000).map((v, i, arr) => ({ ts: tsAt(TIP - (19 - i) * 18000), blockHeight: TIP - (19 - i) * 18000, balance: i >= arr.length - 3 ? 0 : v })),
      }] : []),
    ],
    moneyMarket: hasMm ? [{
      marketKey: 'core', market: 'Money Market', role: 'primary', defiSimSupported: true,
      blockHeight: TIP - 8, timestamp: tsAt(TIP - 8),
      totalCollateralBase: BigInt(Math.round(mm.supply * 1e8)).toString(), totalDebtBase: BigInt(Math.round(mm.debt * 1e8)).toString(),
      availableBorrowsBase: BigInt(Math.round(Math.max(0, mm.supply * 0.78 - mm.debt) * 1e8)).toString(),
      liquidationThreshold: '7800', ltv: '6500',
      healthFactor: mm.debt > 0 ? BigInt(Math.round(mm.hf * 1e18)).toString() : 'inf',
      reserves: [
        { assetId: 1000, symbol: 'HOLLAR', decimals: 18, supplied: '0', debt: raw(mm.debt, 18), suppliedUsd: null, debtUsd: mm.debt, collateral: false },
        { assetId: 43, symbol: 'PRIME', decimals: 6, supplied: raw(mm.supply * 0.6, 6), debt: '0', suppliedUsd: mm.supply * 0.6, debtUsd: null, collateral: true },
        { assetId: 5, symbol: 'DOT', decimals: 10, supplied: raw(mm.supply * 0.4 / 4.44, 10), debt: '0', suppliedUsd: mm.supply * 0.4, debtUsd: null, collateral: true },
      ],
    }, ...((a === A.krakenEvm || a === A.fox) ? [{
      marketKey: 'gigahdx', market: 'GIGAHDX', role: 'supplemental' as const, defiSimSupported: false, stakingBacked: true,
      blockHeight: TIP - 4, timestamp: tsAt(TIP - 4),
      totalCollateralBase: '2400000000000', totalDebtBase: '620000000000', availableBorrowsBase: '540000000000',
      liquidationThreshold: '8000', ltv: '6000', healthFactor: '2380000000000000000',
      reserves: [
        { assetId: 670, symbol: 'stHDX', decimals: 12, supplied: raw(24_000_000, 12), debt: '0', suppliedUsd: 24_000, debtUsd: null, collateral: true },
        { assetId: 1000, symbol: 'HOLLAR', decimals: 18, supplied: '0', debt: raw(6_200, 18), suppliedUsd: null, debtUsd: 6_200, collateral: false },
      ],
    }] : [])] : [],
    portfolioSeries: series(a.accountId.length * 5, 52, portfolioUsd || 1000),
    // Proxy/multisig demo data: the fox is a 2-of-3 multisig controlled-by-proxy
    // account, the owl is one of its signatories, the swan is a pure proxy.
    proxy: a === A.fox ? {
      isPure: null,
      delegates: [{ account: A.owl, proxyType: 'Any', delay: 0 }, { account: A.swan, proxyType: 'Governance', delay: 300 }],
      delegatorOf: [{ account: A.binance, proxyType: 'Transfer', delay: 0 }],
    } : a === A.swan ? {
      isPure: { creator: A.fox, proxyType: 'Any', blockHeight: TIP - 220000, extrinsicIndex: 2, timestamp: tsAt(TIP - 220000) },
      delegates: [{ account: A.fox, proxyType: 'Any', delay: 0 }],
      delegatorOf: [],
    } : null,
    multisig: a === A.fox ? {
      threshold: 2,
      signatories: [A.owl, A.swan, A.binance],
      pending: [{ callHash: '0x25737077ac4eea2d3cc075243902f0d7e8e3a0ea9a39a00e6484121ba5b89aa8', depositor: A.owl, approvals: [A.owl], sinceBlock: TIP - 4200 }],
    } : null,
    multisigMemberships: a === A.owl ? [{ account: A.fox, threshold: 2, signatories: 3 }] : [],
    ...(contract ? { contract } : {}),
  }
}

// A finite, deterministic account/tag activity feed. The detail pagers publish an
// exact row total, so the fixture needs a real end to page to: 137 rows is 6 pages
// of 25 with a partial last one.
const MOCK_ACTIVITY_ROWS = 137
function mockAccountActivity(a: AccountRef, r: () => number): ActivityRow[] {
  return Array.from({ length: MOCK_ACTIVITY_ROWS }, (_, i) => {
    const h = TIP - i * 90 - Math.floor(r() * 30)
    const t = (['trade', 'transfer', 'dca', 'trade'] as const)[Math.floor(r() * 4)]
    const aIn = ASSETS[Math.floor(r() * ASSETS.length)], aOut = ASSETS[Math.floor(r() * ASSETS.length)]
    const amt = +(10 + r() * 4000).toFixed(2)
    const base = { blockHeight: h, timestamp: tsAt(h), extrinsicIndex: 2 + Math.floor(r() * 3), who: a, to: null as AccountRef | null, asset: null as AssetRef | null, assetIn: null as AssetRef | null, assetOut: null as AssetRef | null, amount: null as string | null, amountIn: null as string | null, amountOut: null as string | null, valueUsd: amt * aIn.price, linkBlock: h, linkIndex: 2 }
    if (t === 'transfer') return { ...base, type: t, to: ACCS[Math.floor(r() * ACCS.length)], asset: aref(aIn), amount: raw(amt, aIn.decimals) }
    return { ...base, type: t, assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amt, aIn.decimals), amountOut: raw(amt * aIn.price / aOut.price, aOut.decimals), dca: t === 'dca', ...(t === 'dca' ? { dcaScheduleId: 33546 } : {}) }
  })
}

// The account/tag detail feeds and their exact totals must be two views of ONE set
// of rows, or a pager would offer a page the feed cannot fill. Both go through these.
function accountActivityRows(rawAddress: string): ActivityRow[] {
  const wanted = decodeURIComponent(rawAddress)
  const account = ACCS.find(candidate => candidate.accountId === wanted || candidate.address.toLowerCase() === wanted.toLowerCase()) ?? A.fox
  return mockAccountActivity(account, rng(account.accountId.length * 17))
}
function tagActivityRows(): ActivityRow[] {
  return mockAccountActivity(A.krakenEvm, rng(A.krakenEvm.accountId.length * 17))
}
function filteredMockActivity(rows: ActivityRow[], qs: URLSearchParams): ActivityRow[] {
  const type = qs.get('type') ?? 'all'
  const min = qs.get('min') == null ? null : Number(qs.get('min'))
  return rows
    .filter(row => type === 'all' || row.type === type)
    .filter(row => min == null || (row.valueUsd ?? 0) >= min)
}
// Each tab's total counts the rows ITS feed serves. The extrinsics and events
// fixtures are recency generators without an end, so those two keep a stated length.
function mockListTotal(qs: URLSearchParams, activityRows: () => ActivityRow[]): number {
  switch (qs.get('tab')) {
    case 'activity': return filteredMockActivity(activityRows(), qs).length
    case 'extrinsics': return qs.get('call') || qs.get('result') || qs.get('origin') ? 87 : 1451
    case 'events': return qs.get('event') ? 312 : 26787
    default: return 0
  }
}

/* ---------- HDX dashboard ---------- */
function buildHdx(): HdxDashboard {
  const r = rng(4242)
  const now = MOCK_NOW_MS
  const day = 86_400_000
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
  const cohorts: HdxCohort[] = [
    { key: 'whale', label: 'Whale', minPct: 0.1, minHdx: 6_420_000, accounts: 92, totalHdx: 2.5e9 },
    { key: 'dolphin', label: 'Dolphin', minPct: 0.01, minHdx: 642_000, accounts: 456, totalHdx: 9.4e8 },
    { key: 'fish', label: 'Fish', minPct: 0.000001, minHdx: 64, accounts: 25_549, totalHdx: 4.5e8 },
    { key: 'shrimp', label: 'Shrimp', minPct: 0, minHdx: 0, accounts: 34_872, totalHdx: 6.0e5 },
  ]
  const lockTypes: HdxLockType[] = [
    { key: 'vote', label: 'Vote', accounts: 8235, totalHdx: 1.56e9 },
    { key: 'staking', label: 'Staking', accounts: 5117, totalHdx: 1.24e9 },
    { key: 'gigahdx', label: 'GIGAHDX', accounts: 641, totalHdx: 7.97e8 },
    { key: 'vesting', label: 'Vesting', accounts: 118, totalHdx: 5.0e8 },
  ]
  const buckets: HdxUnlockBucket[] = []
  for (let i = 0; i < 8; i++) {
    const from = now + i * 7 * day
    buckets.push({
      label: `W${i + 1}`, fromTs: ts(from), toTs: ts(from + 7 * day),
      gigahdx: Math.round(1.5e6 + r() * 9e6), vesting: Math.round(8.2e6 + r() * 3.2e6), vote: Math.round(9e6 + r() * 4.4e7),
    })
  }
  // Monthly buckets step by calendar month (not 30 days) so no month label repeats.
  const weeklyEnd = now + 8 * 7 * day
  const monthFrom = (i: number) => { const d = new Date(weeklyEnd); d.setUTCMonth(d.getUTCMonth() + i); return d.getTime() }
  for (let i = 0; i < 6; i++) {
    buckets.push({
      label: `M${i + 1}`, fromTs: ts(monthFrom(i)), toTs: ts(monthFrom(i + 1)),
      gigahdx: Math.round(8e6 + r() * 2.6e7), vesting: Math.round(3.4e7 + r() * 8e6), vote: Math.round(2e7 + r() * 8.5e7),
    })
  }
  const daily: HdxDailyFlow[] = Array.from({ length: 60 }, (_, i) => {
    const d = now - (59 - i) * day
    return {
      date: iso(d), buyHdx: Math.round(2e6 + r() * 2.6e7), sellHdx: Math.round(2e6 + r() * 2.4e7),
      buyers: Math.round(120 + r() * 640), sellers: Math.round(110 + r() * 580),
    }
  })
  const weekly = Array.from({ length: 12 }, (_, i) => ({
    weekStart: iso(now - (11 - i) * 7 * day),
    newHolders: Math.round(320 + r() * 620), exitedHolders: Math.round(260 + r() * 520),
  }))
  const MOVER_ACCS = [...ACCS, ...COLLATORS]
  const mover = (i: number, dir: 1 | -1): HdxMover => {
    const big = 3e6 + r() * 4.5e7, small = big * (0.04 + r() * 0.38)
    const boughtHdx = Math.round(dir > 0 ? big : small), soldHdx = Math.round(dir > 0 ? small : big)
    return { account: MOVER_ACCS[i % MOVER_ACCS.length], balanceHdx: Math.round(big * (2 + i)), boughtHdx, soldHdx, netHdx: boughtHdx - soldHdx }
  }
  return {
    price: 0.0046,
    change24h: 0.0231,
    supply: { totalHdx: 6.5e9, protocolHdx: 2.6e9, userHdx: 3.9e9, holders: 60_968 },
    cohorts,
    locks: { types: lockTypes, totalLockedHdx: 2.9e9, lockedPctOfUser: 74.4, vestedUnclaimedHdx: 2.3e8, snapshotAt: ts(now - 3_600_000) },
    unlocks: {
      buckets,
      laterHdx: { gigahdx: 9.2e7, vesting: 1.6e8, vote: 1.4e8 },
      unlockableNowHdx: 6.7e8,
      activeVoteHdx: 7.8e8,
      stakingAnytimeHdx: 1.24e9,
      gigaPending: { count: 12, totalHdx: 1.4e6, nextUnlockTs: ts(now + 2 * day) },
    },
    flows: { daily, dca: { buy: { orders: 46, hdxPerDay: 2.1e6 }, sell: { orders: 13, hdxPerDay: 6.4e5 } } },
    churn: { weekly },
    topMovers: {
      accumulators: Array.from({ length: 6 }, (_, i) => mover(i, 1)).sort((a, b) => b.netHdx - a.netHdx),
      distributors: Array.from({ length: 6 }, (_, i) => mover(i + 3, -1)).sort((a, b) => a.netHdx - b.netHdx),
    },
    gigaLiquidations: {
      currentPrice: 0.0218,
      points: Array.from({ length: 40 }, (_, i) => {
        const r = rng(i * 17 + 3)
        // liq prices between −85% and −5% of spot, size skewed to a few whales
        const price = 0.0218 * (0.15 + 0.8 * (i / 39))
        return { price, stHdx: Math.round(2_800_000 * (r() < 0.12 ? 4 : 1) * (0.2 + r())) }
      }),
    },
    gigaMarket: [
      { asset: { assetId: 670, symbol: 'stHDX', name: 'Staked HDX', decimals: 12, parachainId: null }, supplied: 48_200_000, suppliedUsd: 1_052_688, debt: 0, debtUsd: 0, suppliers: 412, borrowers: 0 },
      { asset: { assetId: 1000, symbol: 'HOLLAR', name: 'Hollar', decimals: 18, parachainId: null }, supplied: 310_000, suppliedUsd: 310_310, debt: 264_500, debtUsd: 264_764, suppliers: 58, borrowers: 187 },
    ],
  }
}

/* ---------- HOLLAR dashboard ----------
   Fully deterministic (no Date.now()/Math.random()) — every value is derived
   from a fixed anchor timestamp + index-based formulas, so render tests can
   assert exact numbers instead of "close enough" ranges. */
const HOLLAR_MOCK_ANCHOR = Date.parse('2026-07-10T00:00:00.000Z')
function buildHollar(): HollarDashboard {
  const DAY = 86_400_000
  const dayIso = (daysAgo: number) => new Date(HOLLAR_MOCK_ANCHOR - daysAgo * DAY).toISOString().slice(0, 10)

  // 30d of hourly closes, ±~12bps gentle wobble around peg (matches the live
  // peculiarity of small persistent deviations rather than a flat $1 line).
  const hourly: HollarPegPoint[] = []
  const startMs = HOLLAR_MOCK_ANCHOR - 30 * DAY
  for (let i = 0; i < 720; i++) {
    const wobble = Math.sin(i / 11) * 0.0009 + Math.sin(i / 3.7 + 1) * 0.0003
    hourly.push({ ts: tsMs(startMs + i * 3_600_000), close: +(1 + wobble).toFixed(6) })
  }
  const closes = hourly.map(h => h.close)
  const devs = closes.map(c => (c - 1) * 10000)
  const within25bpsPct = devs.filter(dv => Math.abs(dv) <= 25).length / devs.length * 100
  const maxDevBps = devs.reduce((worst, dv) => (Math.abs(dv) > Math.abs(worst) ? dv : worst), devs[0])
  const price = closes[closes.length - 1]

  const aUSDC: AssetRef = { assetId: 1003, symbol: 'aUSDC', name: 'Aave USDC', decimals: 6, parachainId: null }
  const aUSDT = aref(assetById.get(1002)!)
  const sUSDS: AssetRef = { assetId: 1000745, symbol: 'sUSDS', name: 'Savings USDS', decimals: 18, parachainId: null }
  const sUSDe: AssetRef = { assetId: 1000625, symbol: 'sUSDe', name: 'Savings USDe', decimals: 18, parachainId: null }
  const USDC = aref(assetById.get(22)!)
  const USDT = aref(assetById.get(10)!)

  const collaterals: HollarCollateral[] = [
    { asset: aUSDC, poolId: 110, holdings: '0', holdingsUsd: 0, purchaseFeePct: 0.3, buyBackFeePct: 0.01, maxBuyPrice: 0.995, buybackRatePct: 0.01, maxInHolding: null, lastArbTs: '2026-07-08 14:32:00', lastArbDirection: 'out' },
    { asset: aUSDT, poolId: 111, holdings: '0', holdingsUsd: 0, purchaseFeePct: 0.3, buyBackFeePct: 0.01, maxBuyPrice: 0.995, buybackRatePct: 0.01, maxInHolding: null, lastArbTs: '2026-07-08 09:15:00', lastArbDirection: 'in' },
    { asset: sUSDS, poolId: 112, holdings: raw(74_000, 18), holdingsUsd: 74_000, purchaseFeePct: 0.3, buyBackFeePct: 0.01, maxBuyPrice: 0.995, buybackRatePct: 0.01, maxInHolding: raw(500_000, 18), lastArbTs: '2026-07-09 02:40:00', lastArbDirection: 'out' },
    { asset: sUSDe, poolId: 113, holdings: raw(193_000, 18), holdingsUsd: 198_790, purchaseFeePct: 0.3, buyBackFeePct: 0.01, maxBuyPrice: 0.995, buybackRatePct: 0.01, maxInHolding: raw(750_000, 18), lastArbTs: '2026-07-08 20:05:00', lastArbDirection: 'in' },
  ]
  const totalHoldingsUsd = collaterals.reduce((s, c) => s + (c.holdingsUsd ?? 0), 0)

  // Sparse — most days are quiet, matching the live "last arb 1.8 days ago" norm.
  const arbitrageDaily: HollarArbDay[] = Array.from({ length: 60 }, (_, i) => {
    const daysAgo = 59 - i
    const isEvent = daysAgo % 9 === 2
    return { date: dayIso(daysAgo), hollarIn: isEvent && daysAgo % 18 === 2 ? 8_400 : 0, hollarOut: isEvent && daysAgo % 18 !== 2 ? 5_100 : 0 }
  })
  const tradesDaily: HollarTradeDay[] = Array.from({ length: 60 }, (_, i) => {
    const daysAgo = 59 - i
    const quiet = daysAgo % 11 === 5
    return { date: dayIso(daysAgo), bought: quiet ? 0 : 1_200 + (daysAgo % 7) * 340, sold: quiet ? 0 : 900 + (daysAgo % 5) * 260 }
  })

  const pools: HollarPool[] = [
    { poolId: 110, tvlUsd: 12_056_000, hollar: { amount: 6_000_000, usd: 6_006_000 }, partners: [{ asset: aUSDC, amount: 6_050_000, usd: 6_050_000 }], hollarSharePct: 6_006_000 / 12_056_000 * 100 },
    { poolId: 111, tvlUsd: 4_232_800, hollar: { amount: 2_100_000, usd: 2_102_800 }, partners: [{ asset: aUSDT, amount: 2_130_000, usd: 2_130_000 }], hollarSharePct: 2_102_800 / 4_232_800 * 100 },
    { poolId: 112, tvlUsd: 955_600, hollar: { amount: 480_000, usd: 480_600 }, partners: [{ asset: sUSDS, amount: 475_000, usd: 475_000 }], hollarSharePct: 480_600 / 955_600 * 100 },
    { poolId: 113, tvlUsd: 422_440, hollar: { amount: 210_000, usd: 210_260 }, partners: [{ asset: sUSDe, amount: 206_000, usd: 212_180 }], hollarSharePct: 210_260 / 422_440 * 100 },
    {
      poolId: 105, tvlUsd: 510_842.75, hollar: { amount: 255_000, usd: 255_330 },
      partners: [{ asset: USDC, amount: 128_000, usd: 128_000 }, { asset: USDT, amount: 127_500, usd: 127_512.75 }],
      hollarSharePct: 255_330 / 510_842.75 * 100,
    },
  ]
  const inStablepools = pools.reduce((s, p) => s + p.hollar.amount, 0)
  const inOmnipool = 410_000
  const total = 10_300_000
  const other = total - inStablepools - inOmnipool

  return {
    price, change24h: 0.0006, pegDeviationBps: (price - 1) * 10000,
    peg: { hourly, within25bpsPct, maxDevBps, min30d: Math.min(...closes), max30d: Math.max(...closes) },
    supply: { total, holders: 4_215, inStablepools, inOmnipool, other },
    hsm: {
      totalHoldingsUsd, collaterals, arbitrageDaily, tradesDaily,
      lastArb: { ts: '2026-07-08 20:05:00', direction: 'in', asset: sUSDe, hollarAmount: 4_200 },
    },
    pools,
  }
}

// Asset-pinned activities (the unified /explorer/activity with ?asset=N). Applies
// the same min filter the server does so filter e2e flows behave identically.
function assetScopedActivityRows(qs: URLSearchParams): ActivityRow[] {
  const a = assetById.get(Number(qs.get('asset'))) ?? ASSETS[0]
  const activityType = qs.get('type') ?? 'all'; const limit = Number(qs.get('limit') ?? 40)
  const min = qs.get('min') ? Number(qs.get('min')) : null
  const out: ActivityRow[] = []; let h = TIP
  const types: ActivityRow['type'][] = ['trade', 'transfer', 'xcm', 'liquidity', 'mm', 'dca']
  while (out.length < limit && h > TIP - 1200) {
    const r = rng(h * 2654435761 + a.assetId); const t = types[h % types.length]
    if (activityType !== 'all' && t !== activityType) { h -= 1 + Math.floor(r() * 3); continue }
    const other = ASSETS[Math.floor(r() * ASSETS.length)]
    // ~1 in 4 rows is smol so the "$ from" filter has something to drop
    const amt = r() < 0.25 ? +((0.5 + r() * 8) / a.price).toFixed(6) : +(10 + r() * 4000).toFixed(2)
    const who = ACCS[Math.floor(r() * ACCS.length)]
    const base = { blockHeight: h, timestamp: tsAt(h), eventIndex: h % 100, extrinsicIndex: 2 + Math.floor(r() * 3), who, to: null as AccountRef | null, asset: null as AssetRef | null, assetIn: null as AssetRef | null, assetOut: null as AssetRef | null, amount: null as string | null, amountIn: null as string | null, amountOut: null as string | null, valueUsd: amt * a.price }
    if (min != null && base.valueUsd < min) { h -= 1 + Math.floor(r() * 3); continue }
    if (t === 'trade' || t === 'dca') out.push({ ...base, type: t, assetIn: aref(a), assetOut: aref(other), amountIn: raw(amt, a.decimals), amountOut: raw(amt * a.price / other.price, other.decimals) })
    else if (t === 'xcm' && h % 2 === 0) out.push({ ...base, type: t, extrinsicIndex: null, asset: aref(a), amount: raw(amt, a.decimals), xcmDir: 'in', fromChain: 'AssetHub', fromAccount: xcmExternalAccount(h) })
    else if (t === 'transfer' || t === 'xcm') out.push({ ...base, type: t, to: ACCS[Math.floor(r() * ACCS.length)], asset: aref(a), amount: raw(amt, a.decimals), destChain: t === 'xcm' ? 'Moonbeam' : undefined, xcmDir: t === 'xcm' ? 'out' : undefined })
    else out.push({ ...base, type: t, asset: aref(a), amount: raw(amt, a.decimals), mmAction: t === 'mm' ? (['Supply', 'Borrow', 'Repay', 'Withdraw'][Math.floor(r() * 4)]) : undefined, ...(t === 'mm' ? { mmMarketKey: 'gigahdx', mmMarket: 'GIGAHDX' } : {}) })
    h -= 1 + Math.floor(r() * 3)
  }
  return out.slice(0, limit)
}

/* ---------- liquidity pools ---------- */
// One deterministic pool world shared by the Liquidity tab, /pool/:id and
// /omnipool, so a card and the page it links to always carry the same numbers:
// the Omnipool holds HDX/DOT/USDT/vDOT/WETH, pool 690 is the pegged GDOT
// stableswap (vDOT + GDOT, Bifrost-oracle peg on the vDOT leg), and one
// HDX/DOT XYK pair.
const XYK_LP_ID = 1000194
const MOCK_LRNA_PRICE = 5.0
const POOL_DAYS = 120
const POOL_BUCKETS = Array.from({ length: POOL_DAYS }, (_, i) => new Date(MOCK_NOW_MS - (POOL_DAYS - i) * 86_400_000).toISOString().slice(0, 10))
const OMNI_POOL_ACCOUNT = acc('0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000', '7L53bUTBUvKnCVGKLM83Ch3wm3RNFbctFCxSHQwUJgLNsGVU', '💧', { id: 'omnipool', name: 'Omnipool', color: '#57a5ec', icon: '💧' })
const POOL_690_ACCOUNT = acc(hx(690, 64), '167UdiHenqFRhRoXHwh6MBu9YV6NPkbCJx3MC71bfz9YTdzs', '💧', { id: 'stableswap-pools', name: 'Stableswap Pool', color: '#57a5ec', icon: '💧' })
const XYK_PAIR_ACCOUNT = acc(hx(694, 64), '1XyKHdxDotPairAccountX1111111111111111111111111', '💧', { id: 'xyk-pools', name: 'XYK Pool', color: '#57a5ec', icon: '💧' })

const OMNI_ASSETS: { id: number; reserve: number; capPct: number; tradable: string[] }[] = [
  { id: 0, reserve: 48_000_000, capPct: 3.5, tradable: ['Sell', 'Buy', 'Add', 'Remove'] },
  { id: 5, reserve: 610_000, capPct: 30, tradable: ['Sell', 'Buy', 'Add', 'Remove'] },
  { id: 10, reserve: 1_650_000, capPct: 20, tradable: ['Sell', 'Buy', 'Add', 'Remove'] },
  { id: 15, reserve: 92_000, capPct: 10, tradable: ['Sell', 'Buy', 'Add', 'Remove'] },
  { id: 20, reserve: 310, capPct: 10, tradable: ['Sell'] },
]
const SS_690 = {
  poolId: 690,
  assets: [
    { id: 15, reserve: 139_000, peg: { num: '13147', den: '10000', price: 1.3147 }, pegSource: { kind: 'oracle' as const, source: 'Bifrost', period: 'LastBlock', oracleAsset: aref(assetById.get(5)!) } },
    { id: 5, reserve: 219_000, peg: { num: '1', den: '1', price: 1 }, pegSource: { kind: 'value' as const } },
  ],
  feePermill: 690, amplification: { current: 222, initial: 100, final: 222, initialBlock: TIP - 900_000, finalBlock: TIP - 880_000 },
  maxPegUpdatePerbill: 120, issuance: 4_150_000, createdBlock: TIP - 1_000_000,
}
const XYK_POOL = { lpAssetId: XYK_LP_ID, assetA: 0, assetB: 5, reserveA: 5_200_000, reserveB: 25_500, createdBlock: TIP - 2_000_000, totalShares: 3_100_000 }

const priceof = (id: number) => assetById.get(id)!.price
const compEntry = (id: number, amount: number, tvlUsd: number): PoolCompositionEntry => {
  const a = assetById.get(id)!
  const usd = amount * a.price
  return { asset: aref(a), amount: raw(amount, a.decimals), usd, sharePct: tvlUsd > 0 ? usd / tvlUsd * 100 : null }
}
const omniTvlUsd = () => OMNI_ASSETS.reduce((s, o) => s + o.reserve * priceof(o.id), 0)
const ss690TvlUsd = () => SS_690.assets.reduce((s, x) => s + x.reserve * priceof(x.id), 0)
const xykTvlUsd = () => XYK_POOL.reserveA * priceof(XYK_POOL.assetA) + XYK_POOL.reserveB * priceof(XYK_POOL.assetB)

// A source's daily amount history: a gentle deterministic walk ending at the
// current reserve, so the chart's right edge agrees with the cards above it.
function poolAmountSeries(seed: number, current: number): number[] {
  return series(seed, POOL_DAYS, current, 0.05)
}

function buildAssetLiquidity(assetId: number): AssetLiquidity {
  const a = assetById.get(assetId) ?? ASSETS[0]
  const sources: AssetLiquiditySource[] = []
  const histSeries: AssetLiquidity['history']['series'] = []
  const omni = OMNI_ASSETS.find(o => o.id === assetId)
  if (omni) {
    const usd = omni.reserve * a.price
    sources.push({
      kind: 'omnipool', poolId: null, name: 'Omnipool', tvlUsd: omniTvlUsd(),
      assetAmount: raw(omni.reserve, a.decimals), assetUsd: usd, assetSharePct: usd / omniTvlUsd() * 100,
      composition: [], hasPegs: false,
    })
    const amounts = poolAmountSeries(assetId * 31 + 7, omni.reserve)
    histSeries.push({ key: 'omnipool', label: 'Omnipool', amounts, usd: amounts.map(v => v * a.price) })
  }
  const ss = SS_690.assets.find(x => x.id === assetId)
  if (ss) {
    const tvl = ss690TvlUsd()
    sources.push({
      kind: 'stableswap', poolId: 690, name: '2-Pool-GDOT', tvlUsd: tvl,
      assetAmount: raw(ss.reserve, a.decimals), assetUsd: ss.reserve * a.price, assetSharePct: ss.reserve * a.price / tvl * 100,
      composition: SS_690.assets.map(x => compEntry(x.id, x.reserve, tvl)),
      hasPegs: true,
    })
    const amounts = poolAmountSeries(assetId * 31 + 11, ss.reserve)
    histSeries.push({ key: 'ss:690', label: '2-Pool-GDOT', amounts, usd: amounts.map(v => v * a.price) })
  }
  if (assetId === XYK_POOL.assetA || assetId === XYK_POOL.assetB) {
    const tvl = xykTvlUsd()
    const amount = assetId === XYK_POOL.assetA ? XYK_POOL.reserveA : XYK_POOL.reserveB
    sources.push({
      kind: 'xyk', poolId: XYK_LP_ID, name: 'HDX / DOT', tvlUsd: tvl,
      assetAmount: raw(amount, a.decimals), assetUsd: amount * a.price, assetSharePct: amount * a.price / tvl * 100,
      composition: [compEntry(XYK_POOL.assetA, XYK_POOL.reserveA, tvl), compEntry(XYK_POOL.assetB, XYK_POOL.reserveB, tvl)],
      hasPegs: false,
    })
    const amounts = poolAmountSeries(assetId * 31 + 13, amount)
    histSeries.push({ key: `xyk:${XYK_LP_ID}`, label: 'HDX / DOT', amounts, usd: amounts.map(v => v * a.price) })
  }
  sources.sort((x, y) => (y.assetUsd ?? -1) - (x.assetUsd ?? -1))
  const totalAmountNum = sources.reduce((s, x) => s + Number(BigInt(x.assetAmount)) / 10 ** a.decimals, 0)
  return {
    asset: aref(a),
    totalAmount: raw(totalAmountNum, a.decimals),
    totalUsd: totalAmountNum * a.price,
    sources,
    // DOT keeps one former pool so the section renders deterministically.
    former: assetId === 5 ? [{ kind: 'xyk', poolId: 1000044, name: 'DOT / GLMR', lastActiveBlock: TIP - 400_000, lastActiveAt: tsAt(TIP - 400_000) }] : [],
    history: { buckets: POOL_BUCKETS, series: histSeries },
  }
}

function buildPoolDetail(poolId: number): PoolDetail | undefined {
  if (poolId === 690) {
    const tvl = ss690TvlUsd()
    const share = assetById.get(690)!
    const compAmounts = SS_690.assets.map((x, i) => poolAmountSeries(690 * 7 + i, x.reserve))
    const pegWalk = series(69017, POOL_DAYS, SS_690.assets[0].peg.price, 0.004)
    return {
      kind: 'stableswap', poolId: 690, name: '2-Pool-GDOT', account: POOL_690_ACCOUNT, shareToken: aref(share),
      createdBlock: SS_690.createdBlock, createdAt: tsAt(SS_690.createdBlock), destroyed: false,
      tvlUsd: tvl, totalIssuance: raw(SS_690.issuance, share.decimals),
      feePermill: SS_690.feePermill, amplification: SS_690.amplification, maxPegUpdatePerbill: SS_690.maxPegUpdatePerbill,
      assets: SS_690.assets.map(x => ({ ...compEntry(x.id, x.reserve, tvl), peg: x.peg, pegSource: x.pegSource })),
      paramEvents: [
        { blockHeight: TIP - 880_000, timestamp: tsAt(TIP - 880_000), kind: 'max-peg-update', summary: 'Max peg update set to 0.000012% per block' },
        { blockHeight: TIP - 900_000, timestamp: tsAt(TIP - 900_000), kind: 'amplification', summary: `Amplification ramping 100 → 222 over blocks ${TIP - 900_000}–${TIP - 880_000}` },
        { blockHeight: SS_690.createdBlock, timestamp: tsAt(SS_690.createdBlock), kind: 'created', summary: 'Pool created with vDOT, GDOT — amplification 100, fee 0.069%, with price pegs' },
      ],
      history: {
        buckets: POOL_BUCKETS,
        tvlUsd: POOL_BUCKETS.map((_, i) => SS_690.assets.reduce((s, x, k) => s + compAmounts[k][i] * priceof(x.id), 0)),
        composition: SS_690.assets.map((x, k) => ({ asset: aref(assetById.get(x.id)!), amounts: compAmounts[k], usd: compAmounts[k].map(v => v * priceof(x.id)) })),
        pegs: [{ asset: aref(assetById.get(15)!), prices: pegWalk }],
        issuance: poolAmountSeries(69019, SS_690.issuance),
      },
    }
  }
  if (poolId === XYK_LP_ID) {
    const tvl = xykTvlUsd()
    const legs = [[XYK_POOL.assetA, XYK_POOL.reserveA], [XYK_POOL.assetB, XYK_POOL.reserveB]] as const
    const compAmounts = legs.map(([id, reserve]) => poolAmountSeries(id * 5 + 194, reserve))
    return {
      kind: 'xyk', poolId: XYK_LP_ID, name: 'HDX / DOT', account: XYK_PAIR_ACCOUNT,
      shareToken: { assetId: XYK_LP_ID, symbol: 'HDX/DOT LP', name: 'HDX/DOT share token', decimals: 12, parachainId: null },
      createdBlock: XYK_POOL.createdBlock, createdAt: tsAt(XYK_POOL.createdBlock), destroyed: false,
      tvlUsd: tvl, totalIssuance: raw(XYK_POOL.totalShares, 12), feePermill: 3000,
      amplification: null, maxPegUpdatePerbill: null,
      assets: legs.map(([id, reserve]) => ({ ...compEntry(id, reserve, tvl), peg: null, pegSource: null })),
      paramEvents: [],
      history: {
        buckets: POOL_BUCKETS,
        tvlUsd: POOL_BUCKETS.map((_, i) => legs.reduce((s, [id], k) => s + compAmounts[k][i] * priceof(id), 0)),
        composition: legs.map(([id], k) => ({ asset: aref(assetById.get(id)!), amounts: compAmounts[k], usd: compAmounts[k].map(v => v * priceof(id)) })),
        pegs: null,
        issuance: null,
      },
    }
  }
  return undefined
}

function buildOmnipool(): OmnipoolDetail {
  const tvl = omniTvlUsd()
  const rows = OMNI_ASSETS.map(o => {
    const a = assetById.get(o.id)!
    const usd = o.reserve * a.price
    return {
      asset: aref(a), reserve: raw(o.reserve, a.decimals), reserveUsd: usd,
      hubReserve: raw(usd / MOCK_LRNA_PRICE, 12), weightPct: usd / tvl * 100, capPct: o.capPct, tradable: o.tradable,
    }
  }).sort((x, y) => (y.reserveUsd ?? 0) - (x.reserveUsd ?? 0))
  const amountsById = new Map(OMNI_ASSETS.map(o => [o.id, poolAmountSeries(o.id * 31 + 7, o.reserve)]))
  const composition = rows.map(r => ({
    asset: r.asset,
    usd: amountsById.get(r.asset.assetId)!.map(v => v * priceof(r.asset.assetId)),
  }))
  return {
    account: OMNI_POOL_ACCOUNT,
    tvlUsd: tvl, assetCount: OMNI_ASSETS.length,
    hubReserveTotal: raw(tvl / MOCK_LRNA_PRICE, 12), lrnaPrice: MOCK_LRNA_PRICE,
    assets: rows,
    history: {
      buckets: POOL_BUCKETS,
      tvlUsd: POOL_BUCKETS.map((_, i) => composition.reduce((s, c) => s + (c.usd[i] ?? 0), 0)),
      composition,
    },
  }
}

// Pools currently holding an asset (the Liquidity tab's count chip).
function mockLiquiditySourceCount(assetId: number): number {
  return (OMNI_ASSETS.some(o => o.id === assetId) ? 1 : 0)
    + (SS_690.assets.some(x => x.id === assetId) ? 1 : 0)
    + (assetId === XYK_POOL.assetA || assetId === XYK_POOL.assetB ? 1 : 0)
}

const ROUTES: { re: RegExp; fn: (m: RegExpMatchArray, qs: URLSearchParams) => unknown }[] = [
  { re: /^\/explorer\/stats$/, fn: () => ({ headBlock: TIP, finalizedBlock: TIP - 2, headTime: tsAt(TIP), avgBlockSec: 6.0, transfers24h: 18204, extrinsics24h: 42318, activeAccounts24h: 7120, hdxPrice: 0.02184 } satisfies ExplorerStats) },
  { re: /^\/indexer$/, fn: () => ({ blockHeight: TIP, blockTimestamp: tsAt(TIP), lagSeconds: 6, chainBlockHeight: TIP + 1, blocksBehindHead: 1 } satisfies IndexerStatus) },
  // Two shapes off one directory, exactly as the API serves them: the full rows the
  // Assets page renders, and `fields=filter`'s id/symbol/name projection in the same
  // order, which is all a token combo shows and searches.
  { re: /^\/explorer\/assets$/, fn: (_m, qs) => qs.get('fields') === 'filter' ? buildAssets().map(a => ({ assetId: a.assetId, symbol: a.symbol, name: a.name })) : buildAssets() },
  { re: /^\/explorer\/hdx$/, fn: () => buildHdx() },
  { re: /^\/explorer\/hollar$/, fn: () => buildHollar() },
  { re: /^\/explorer\/accounts$/, fn: (_m, qs) => buildAccounts(Number(qs.get('offset') ?? 0), Number(qs.get('limit') ?? 50), qs.get('sort') ?? 'value') },
  { re: /^\/explorer\/contracts$/, fn: (_m, qs) => buildContracts(Number(qs.get('offset') ?? 0), Number(qs.get('limit') ?? 50), qs.get('sort') ?? 'created') },
  { re: /^\/explorer\/contract\/compiler-versions$/, fn: () => ({ versions: ['v0.8.19+commit.7dd6d404', 'v0.8.10+commit.fc410830'] }) },
  // Artifacts exist only for the verified contract; anything else falls through
  // to the harness 404, exactly like the real endpoints.
  { re: /^\/explorer\/contract\/([^/]+)\/abi$/, fn: m => {
    const address = decodeURIComponent(m[1]).toLowerCase()
    if (address === VERIFIED_CONTRACT_ADDRESS) return MOCK_CONTRACT_ABI
    if (address === PROXY_CONTRACT_ADDRESS) return MOCK_PROXY_ABI
    return undefined
  } },
  { re: /^\/explorer\/contract\/([^/]+)\/sources$/, fn: m => decodeURIComponent(m[1]).toLowerCase() === VERIFIED_CONTRACT_ADDRESS ? MOCK_CONTRACT_SOURCES : undefined },
  { re: /^\/explorer\/contract\/([^/]+)\/transactions$/, fn: (m, qs) => buildContractTransactions(decodeURIComponent(m[1]).toLowerCase(), Number(qs.get('offset') ?? 0), Number(qs.get('limit') ?? 25)) },
  { re: /^\/explorer\/contract\/([^/]+)\/events$/, fn: (m, qs) => buildContractEvents(decodeURIComponent(m[1]).toLowerCase(), Number(qs.get('offset') ?? 0), Number(qs.get('limit') ?? 25)) },
  { re: /^\/explorer\/daily\/(\w+)(?:\?.*)?$/, fn: (m) => Array.from({ length: 45 }, (_, i) => { const d = new Date(MOCK_NOW_MS - (44 - i) * 86400000); const r = rng(i + m[1].length * 7); return { date: d.toISOString().slice(0, 10), value: Math.round((m[1] === 'events' ? 60000 : m[1] === 'extrinsics' ? 12000 : 4000) * (0.5 + r())) } as DailyPoint }) },
  { re: /^\/explorer\/accounts-daily$/, fn: () => Array.from({ length: 30 }, (_, i) => { const d = new Date(MOCK_NOW_MS - (29 - i) * 86400000); const r = rng(i * 31 + 5); return { date: d.toISOString().slice(0, 10), active: Math.round(6000 * (0.6 + r() * 0.8)), new: Math.round(350 * (0.4 + r())) } }) },
  // events is deliberately longer than MOCK_LIST_MAX_OFFSET can page, so the mock
  // reproduces the real shape: a total whose last pages the API will not serve.
  { re: /^\/explorer\/counts$/, fn: () => ({ blocks: 567764, extrinsics: 132771, events: 302863213, transfers: 410000, maxOffset: MOCK_LIST_MAX_OFFSET }) },
  // The global Activity feed's bounds. Vote is the one category the real API counts
  // (it pages in SQL over a single source); everything else publishes only how deep
  // it serves, exactly as the API does.
  {
    re: /^\/explorer\/activity\/count$/, fn: (_m, qs) => {
      const type = qs.get('type') ?? 'all'
      const countable = type === 'vote' && !qs.get('action')
      return {
        total: countable ? MOCK_VOTE_ACTIVITY_TOTAL : null,
        complete: countable,
        maxOffset: type === 'vote' ? MOCK_NARROW_ACTIVITY_MAX_OFFSET : MOCK_ACTIVITY_MAX_OFFSET,
      }
    },
  },
  {
    re: /^\/explorer\/blocks$/, fn: (_m, qs) => {
      const limit = Number(qs.get('limit') ?? 25); const offset = Number(qs.get('offset') ?? 0)
      return Array.from({ length: limit }, (_, i) => { const h = TIP - offset - i; return { height: h, timestamp: tsAt(h), hash: hx(h, 64), author: h > TIP - 2 ? null : COLLATORS[0], specVersion: 428, extrinsicCount: blockExtrinsicCount(h), eventCount: blockExtrinsicCount(h) * 3 + (h % 5), ...mockFinal(h) } satisfies BlockSummary })
    },
  },
  {
    re: /^\/explorer\/block\/(\d+)$/, fn: (m) => {
      const h = Number(m[1]); const n = blockExtrinsicCount(h)
      const exts = Array.from({ length: n }, (_, i) => genExtrinsic(h, i))
      const events: BlockDetail['events'] = []
      exts.forEach(x => x.events.forEach(e => events.push({ eventIndex: events.length, extrinsicIndex: x.index, name: e.name, args: e.args })))
      return {
        height: h, timestamp: tsAt(h), hash: hx(h, 64), author: COLLATORS[0], specVersion: 428, extrinsicCount: n, eventCount: events.length,
        parentHash: hx(h - 1, 64), stateRoot: hx(h * 3, 64), extrinsicsRoot: hx(h * 5, 64),
        extrinsics: exts.map(x => ({ blockHeight: x.blockHeight, index: x.index, hash: x.hash, timestamp: x.timestamp, signer: x.signer, success: x.success, callName: x.callName, fee: x.fee })),
        events,
      } satisfies BlockDetail
    },
  },
  { re: /^\/explorer\/block\/(\d+)\/activity$/, fn: (m) => mockBlockActivity(Number(m[1])) },
  { re: /^\/explorer\/extrinsics$/, fn: (_m, qs) => {
    const limit = Number(qs.get('limit') ?? 25)
    const rows = recentExtrinsics(limit, qs.get('signedOnly') === '1')
    // Page 0 leads with the pool transaction, mirroring the api's merge.
    return Number(qs.get('offset') ?? 0) === 0 ? [mempoolExtrinsicSummary(), ...rows].slice(0, limit) : rows
  } },
  // Past the block's last index there is no extrinsic, so the fixture answers as the
  // API does — nothing, which the callers turn into a 404. Handing back an invented
  // extrinsic would make every block look endless to anything that pages or probes.
  { re: /^\/explorer\/extrinsic-at\/(\d+)\/(\d+)$/, fn: (m) => Number(m[2]) < blockExtrinsicCount(Number(m[1])) ? { ...genExtrinsic(Number(m[1]), Number(m[2])), ...mockFinal(Number(m[1])) } : undefined },
  { re: /^\/explorer\/extrinsic-at\/(\d+)\/(\d+)\/activity$/, fn: (m) => mockExtrinsicActivity(Number(m[1]), Number(m[2])) },
  // An Ethereum transaction hash resolves to the extrinsic that carries it — the
  // same object /extrinsic-at/<height>/<index> answers, which is what lets the page
  // canonicalize the URL. Ahead of the generic 64-hex rule below, which stands in
  // for "any substrate extrinsic hash".
  { re: /^\/explorer\/extrinsic\/(0x[0-9a-f]{64})$/, fn: (m) => m[1] === MOCK_MEMPOOL_HASH ? mempoolExtrinsicDetail() : m[1] === MOCK_EVM_TX_HASH ? genExtrinsic(MOCK_EVM_TX.height, MOCK_EVM_TX.index) : genExtrinsic(12_848_613, 4) },
  { re: /^\/explorer\/extrinsic\/(0x[0-9a-f]{64})\/activity$/, fn: (m) => m[1] === MOCK_MEMPOOL_HASH ? [] : m[1] === MOCK_EVM_TX_HASH ? mockExtrinsicActivity(MOCK_EVM_TX.height, MOCK_EVM_TX.index) : mockExtrinsicActivity(12_848_613, 4) },
  // Gas comes from the node, per transaction. Unknown hash → undefined → 404, the
  // same answer the api gives when the node cannot produce a receipt.
  { re: /^\/explorer\/evm-tx\/(0x[0-9a-f]{64})\/receipt$/, fn: (m) => m[1] === MOCK_EVM_TX_HASH ? MOCK_EVM_TX_RECEIPT : undefined },
  {
    re: /^\/explorer\/trade\/(\d+)\/(\d+)$/, fn: (m) => {
      const h = Number(m[1]), i = Number(m[2]); const r = rng(h * 7 + i + 3)
      const aIn = ASSETS[2], mid = ASSETS[3], aOut = ASSETS[1]
      const amtIn = +(500 + r() * 3000).toFixed(2), amtMid = amtIn * aIn.price / mid.price, amtOut = amtIn * aIn.price / aOut.price
      return {
        blockHeight: h, timestamp: tsAt(h), extrinsicIndex: i, eventIndex: 42, hash: '0x' + 'ab'.repeat(32), success: true,
        who: ACCS[Math.floor(r() * ACCS.length)], venue: 'Router', direction: 'Sell',
        assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amtIn, aIn.decimals), amountOut: raw(amtOut, aOut.decimals),
        valueUsd: amtIn * aIn.price, executionPrice: aIn.price / aOut.price,
        limit: { kind: 'minReceived', amount: raw(amtOut * 0.985, aOut.decimals), asset: aref(aOut), marginPct: 1.52 },
        extrinsicFee: '12000000000000',
        route: [
          { pool: 'Aave', poolId: null, assetIn: aref(aIn), assetOut: aref(mid), amountIn: null, amountOut: null, fee: null },
          { pool: 'Omnipool', poolId: null, assetIn: aref(mid), assetOut: aref(aOut), amountIn: raw(amtMid, mid.decimals), amountOut: raw(amtOut, aOut.decimals), fee: { amount: raw(amtOut * 0.0025, aOut.decimals), asset: aref(aOut) } },
        ],
        dca: false,
      } satisfies TradeDetailResponse
    },
  },
  {
    re: /^\/explorer\/trade-event\/(\d+)\/(\d+)$/, fn: (m) => {
      const h = Number(m[1]), e = Number(m[2])
      const aIn = ASSETS[2], aOut = ASSETS[1]
      const amtIn = 1234.56
      const amtOut = amtIn * aIn.price / aOut.price
      return {
        blockHeight: h, timestamp: tsAt(h), extrinsicIndex: null, eventIndex: e, hash: null, success: true,
        who: A.fox, venue: 'Router', direction: 'Sell',
        assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amtIn, aIn.decimals), amountOut: raw(amtOut, aOut.decimals),
        valueUsd: amtIn * aIn.price, executionPrice: aIn.price / aOut.price,
        limit: null, extrinsicFee: null,
        route: [{ pool: 'Router', poolId: null, assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amtIn, aIn.decimals), amountOut: raw(amtOut, aOut.decimals), fee: null }],
        dca: false,
      } satisfies TradeDetailResponse
    },
  },
  { re: /^\/explorer\/extrinsic\/(0x[0-9a-f]+)$/, fn: () => genExtrinsic(TIP - 3, 2) },
  { re: /^\/explorer\/extrinsic\/(0x[0-9a-f]+)\/activity$/, fn: () => mockExtrinsicActivity(TIP - 3, 2) },
  {
    re: /^\/explorer\/transfers$/, fn: (_m, qs) => {
      const limit = Number(qs.get('limit') ?? 25)
      return recentExtrinsics(200, true).filter(x => /transfer/i.test(x.callName)).slice(0, limit).map((x, i) => {
        const as = ASSETS[(x.blockHeight + i) % ASSETS.length]; const amt = +(10 + (x.blockHeight % 4000)).toFixed(2)
        return { blockHeight: x.blockHeight, timestamp: x.timestamp, eventIndex: i, extrinsicIndex: x.index, from: x.signer ?? A.fox, to: ACCS[(i + 1) % ACCS.length], amount: raw(amt, as.decimals), asset: aref(as), valueUsd: amt * as.price } satisfies TransferRow
      })
    },
  },
  {
    re: /^\/explorer\/events$/, fn: (_m, qs) => {
      const limit = Number(qs.get('limit') ?? 25)
      // Page 0 leads with the pool transaction's PROJECTED events.
      const out: EventRow[] = Number(qs.get('offset') ?? 0) === 0 ? mempoolEventRows() : []
      let h = TIP
      while (out.length < limit && h > TIP - 200) {
        const n = blockExtrinsicCount(h)
        for (let i = n - 1; i >= 0 && out.length < limit; i--) { const x = genExtrinsic(h, i); for (const e of x.events) { out.push({ blockHeight: h, eventIndex: out.length, extrinsicIndex: x.index, timestamp: x.timestamp, name: e.name, args: e.args, decoded: !!(e as { decoded?: boolean }).decoded, ...mockFinal(h) }); if (out.length >= limit) break } }
        h--
      }
      return out.slice(0, limit)
    },
  },
  {
    re: /^\/explorer\/trades$/, fn: (_m, qs) => {
      const limit = Number(qs.get('limit') ?? 25)
      return recentExtrinsics(200, true).filter(x => /Omnipool\.(sell|buy)|Router/i.test(x.callName)).slice(0, limit).map((x, i) => {
        const aIn = ASSETS[(x.blockHeight) % ASSETS.length], aOut = ASSETS[(x.blockHeight + 3) % ASSETS.length]
        const amtIn = +(10 + (x.blockHeight % 5000)).toFixed(2), usd = amtIn * aIn.price
        return { blockHeight: x.blockHeight, timestamp: x.timestamp, eventIndex: i, extrinsicIndex: x.index, who: x.signer, assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amtIn, aIn.decimals), amountOut: raw(usd / aOut.price, aOut.decimals), valueUsd: usd, venue: x.callName.split('.')[0] } satisfies TradeRow
      })
    },
  },
  {
    re: /^\/explorer\/activity$/, fn: (_m, qs) => {
      if (qs.get('asset') != null) return assetScopedActivityRows(qs)   // unified endpoint, asset-pinned form
      const limit = Number(qs.get('limit') ?? 25); const out: ActivityRow[] = []
      const requestedType = qs.get('type') ?? 'all'
      const min = qs.get('min') ? Number(qs.get('min')) : null
      let h = TIP
      if (requestedType === 'all' || requestedType === 'trade') {
        // Ahead of everything: a transaction still in the pool — a dry-run
        // projection, specially highlighted and non-navigable.
        out.push(mempoolActivityRow())
        // The newest trade rides an unfinalized block: no detail link yet, the
        // row is dimmed and non-navigable until finality.
        out.push({
          type: 'trade', blockHeight: h + 1, timestamp: tsAt(h + 1), eventIndex: 77, extrinsicIndex: null,
          who: A.fox, to: null, asset: null, assetIn: aref(ASSETS[2]), assetOut: aref(ASSETS[1]),
          amount: null, amountIn: raw(1234.56, ASSETS[2].decimals), amountOut: raw(1234.56 * ASSETS[2].price / ASSETS[1].price, ASSETS[1].decimals),
          valueUsd: 1234.56 * ASSETS[2].price, finalized: false,
        })
      }
      // The vote category has its own generator: votes are not part of the
      // per-height type cycle, so without this the tab renders empty and nothing
      // exercises how a vote row reads.
      if (requestedType === 'vote') {
        while (out.length < limit && h > TIP - 400) { out.push(voteRowAtHeight(h)); h -= 1 + (h % 3) }
        return out.slice(0, limit)
      }
      const types: ActivityRow['type'][] = ['trade', 'transfer', 'xcm', 'liquidity', 'mm', 'dca', 'otc']
      while (out.length < limit && h > TIP - 400) {
        const r = rng(h * 2654435761 + 13); const t = types[h % types.length]
        const aIn = ASSETS[Math.floor(r() * ASSETS.length)], aOut = ASSETS[Math.floor(r() * ASSETS.length)]
        // ~1 in 4 rows is "smol" (< $10) so the dim treatment / smol toggle show in mock.
        const amt = r() < 0.25 ? +((0.5 + r() * 8) / aIn.price).toFixed(6) : +(10 + r() * 4000).toFixed(2)
        const who = ACCS[Math.floor(r() * ACCS.length)]
        const base = { blockHeight: h, timestamp: tsAt(h), eventIndex: h % 100, extrinsicIndex: 2 + Math.floor(r() * 3), who, to: null as AccountRef | null, asset: null as AssetRef | null, assetIn: null as AssetRef | null, assetOut: null as AssetRef | null, amount: null as string | null, amountIn: null as string | null, amountOut: null as string | null, valueUsd: amt * aIn.price }
        const skip = min != null && base.valueUsd < min   // mirrors the server-side min filter
        // otc folds under the trade filter (mirrors the real API's family merge).
        const typeMatches = requestedType === 'all' || requestedType === t || (requestedType === 'trade' && (t === 'dca' || t === 'otc'))
        if (skip || !typeMatches) { /* filtered out */ }
        else if (t === 'trade' || t === 'dca') out.push({ ...base, type: t, assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amt, aIn.decimals), amountOut: raw(amt * aIn.price / aOut.price, aOut.decimals), ...(t === 'dca' ? { dca: true, dcaScheduleId: 33546 } : {}) })
        else if (t === 'otc') {
          const f = otcFields(h, aIn, aOut, amt)
          if (f.action === 'Pull') out.push({ ...base, type: t, valueUsd: null, otcAction: f.action, otcOrderId: f.orderId })
          else out.push({ ...base, type: t, assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amt, aIn.decimals), amountOut: raw(amt * aIn.price / aOut.price, aOut.decimals), otcAction: f.action, otcOrderId: f.orderId, otcPartiallyFillable: f.partiallyFillable, otcPartial: f.partial, otcFee: f.fee })
        }
        else if (t === 'xcm' && h % 2 === 0) out.push({ ...base, type: t, extrinsicIndex: null, asset: aref(aIn), amount: raw(amt, aIn.decimals), xcmDir: 'in', fromChain: 'AssetHub', fromAccount: xcmExternalAccount(h) })
        else if (t === 'transfer' || t === 'xcm') out.push({ ...base, type: t, to: ACCS[Math.floor(r() * ACCS.length)], asset: aref(aIn), amount: raw(amt, aIn.decimals), destChain: t === 'xcm' ? 'Moonbeam' : undefined, xcmDir: t === 'xcm' ? 'out' : undefined })
        else out.push({ ...base, type: t, asset: aref(aIn), amount: raw(amt, aIn.decimals), mmAction: t === 'mm' ? (['Supply', 'Borrow', 'Repay', 'Withdraw'][Math.floor(r() * 4)]) : undefined, ...(t === 'mm' ? { mmMarketKey: 'gigahdx', mmMarket: 'GIGAHDX' } : {}) })
        h -= 1 + Math.floor(r() * 3)
      }
      return out.slice(0, limit)
    },
  },
  {
    re: /^\/explorer\/money-market$/, fn: () => {
      const positions = [A.krakenEvm, A.binance, A.fox].map(a => { const mm = mmFor(a.accountId.length * 7); return { account: a, supplyUsd: mm.supply, debtUsd: mm.debt, netWorthUsd: mm.supply - mm.debt, healthFactor: mm.debt > 0 ? BigInt(Math.round(mm.hf * 1e18)).toString() : 'inf', blockHeight: TIP - 8 } })
      return { totalSupplyUsd: positions.reduce((s, p) => s + p.supplyUsd, 0), totalDebtUsd: positions.reduce((s, p) => s + p.debtUsd, 0), positions } satisfies MoneyMarketResponse
    },
  },
  {
    re: /^\/explorer\/asset\/(\d+)$/, fn: (m) => {
      const a = assetById.get(Number(m[1])) ?? ASSETS[0]
      const totalUsd = ACCS.reduce((s, _ac, i) => s + (i + 1) * 12000, 0)
      const priceSeries = series(a.assetId * 13 + 1, 180, a.price)
      const priceDates = priceSeries.map((_, i) => new Date(MOCK_NOW_MS - (priceSeries.length - 1 - i) * 86_400_000).toISOString().slice(0, 10))
      const days = mockLiquidationDays(a, priceDates)
      return {
        asset: { ...aref(a), price: a.price, change24h: a.ch / 100, change7d: a.ch7d / 100, type: a.type, amountUsd: totalUsd },
        holderCount: ACCS.length, totalUsd, priceSeries, priceDates,
        liquidations: MOCK_MM_RESERVES.has(a.assetId) ? { decimals: a.decimals, days, total: mockLiquidationTotal(days) } : null,
        liquiditySourceCount: mockLiquiditySourceCount(a.assetId),
      } satisfies AssetDetail
    },
  },
  { re: /^\/explorer\/asset\/(\d+)\/liquidity$/, fn: m => buildAssetLiquidity(Number(m[1])) },
  // Unknown pool ids fall through to the harness 404, like the real endpoint.
  { re: /^\/explorer\/pool\/(\d+)$/, fn: m => buildPoolDetail(Number(m[1])) },
  // A pool's own activity: the swaps that happened IN it (between its member
  // assets) ahead of what its share token did. The member-asset swaps are the
  // half the share token's own activity feed can never show, and their absence
  // is what made a busy pool look idle.
  { re: /^\/explorer\/pool\/(\d+)\/activity$/, fn: (m, qs) => {
    const poolId = Number(m[1])
    const detail = buildPoolDetail(poolId)
    if (!detail) return []
    const limit = Number(qs.get('limit') ?? 25)
    const members = detail.assets.map(a => a.asset.assetId)
    const rows: ActivityRow[] = []
    for (let i = 0; i < 6 && rows.length < limit; i++) {
      const h = TIP - i * 3
      const [a, b] = i % 2 === 0 ? members : [...members].reverse()
      const aIn = assetById.get(a)!, aOut = assetById.get(b)!
      const amt = 120 + i * 37
      rows.push({
        type: 'trade', blockHeight: h, timestamp: tsAt(h), eventIndex: 40 + i, extrinsicIndex: 2,
        who: ACCS[i % ACCS.length], to: null, asset: null,
        assetIn: aref(aIn), assetOut: aref(aOut),
        amount: null, amountIn: raw(amt, aIn.decimals), amountOut: raw(amt * aIn.price / aOut.price, aOut.decimals),
        valueUsd: amt * aIn.price, linkBlock: h, linkIndex: 2,
      })
    }
    return rows.slice(0, limit)
  } },
  { re: /^\/explorer\/omnipool$/, fn: () => buildOmnipool() },
  {
    re: /^\/explorer\/holders\/(\d+)$/, fn: (m, qs) => {
      const a = assetById.get(Number(m[1])) ?? ASSETS[0]
      const offset = Number(qs.get('offset') ?? 0), limit = Number(qs.get('limit') ?? 100)
      const all = ACCS.map((ac, i) => { const bal = (i + 1) * 12000 / a.price; return { rank: i + 1, account: ac.tag ? null : ac, tag: ac.tag ? { tagId: ac.tag.id, name: ac.tag.name, color: ac.tag.color, icon: ac.tag.icon, memberCount: 2 } : null, balance: raw(bal, a.decimals), lastBlock: TIP - i * 100, valueUsd: bal * a.price } })
      const totalUsd = all.reduce((s, h) => s + (h.valueUsd ?? 0), 0)
      const holders = all.map(h => ({ ...h, share: totalUsd > 0 ? (h.valueUsd ?? 0) / totalUsd : 0 })).slice(offset, offset + limit)
      return { asset: aref(a), holders, total: all.length, totalUsd } satisfies HoldersResponse
    },
  },
  {
    re: /^\/explorer\/address\/(.+)\/activity$/, fn: (m, qs) => {
      const rows = filteredMockActivity(accountActivityRows(m[1]), qs)
      const offset = Number(qs.get('offset') ?? 0)
      return rows.slice(offset, offset + Number(qs.get('limit') ?? 25))
    },
  },
  // The exact length of whichever list a pager is sizing itself against, under the
  // filters it is showing. Counted from the same rows the feed above returns, so the
  // fixture cannot advertise a page the mocked feed does not hold.
  { re: /^\/explorer\/address\/(.+)\/list-count$/, fn: (m, qs) => ({ total: mockListTotal(qs, () => accountActivityRows(m[1])) }) },
  { re: /^\/explorer\/address\/(.+)\/extrinsics$/, fn: (_m, qs) => recentExtrinsics(Number(qs.get('limit') ?? 25), true) },
  {
    re: /^\/explorer\/address\/(.+)\/events$/, fn: (_m, qs) => {
      const limit = Number(qs.get('limit') ?? 25); const out: EventRow[] = []
      let h = TIP
      while (out.length < limit && h > TIP - 200) {
        const n = blockExtrinsicCount(h)
        for (let i = n - 1; i >= 0 && out.length < limit; i--) { const x = genExtrinsic(h, i); for (const e of x.events) { out.push({ blockHeight: h, eventIndex: out.length, extrinsicIndex: x.index, timestamp: x.timestamp, name: e.name, args: e.args, decoded: !!(e as { decoded?: boolean }).decoded }); if (out.length >= limit) break } }
        h--
      }
      return out.slice(0, limit)
    },
  },
  { re: /^\/explorer\/address\/(.+)\/counts$/, fn: () => ({ extrinsics: 1451, extrinsicsOnBehalf: 0, events: 26787, votes: 0 }) },
  // Per-account balance/portfolio history. Must sit before the generic address
  // route below, whose greedy `(.+)` would otherwise swallow this sub-path and
  // fall back to the default account — leaking one account's history onto another.
  // `series=1` is the Overview's shape: the value series without the per-asset
  // history the Balances treemap reads (98-99% of the real payload).
  { re: /^\/explorer\/address\/(.+)\/history$/, fn: (m, qs) => { const built = buildAddress(decodeURIComponent(m[1])); return { portfolioSeries: built.portfolioSeries ?? [], portfolioDates: built.portfolioDates ?? [], balanceHistory: qs.get('series') === '1' ? [] : built.balanceHistory ?? [] } } },
  // Public lists that list this address as owner or tagged member — must
  // also sit before the generic address route's greedy `(.+)`.
  { re: /^\/explorer\/address\/(.+)\/lists$/, fn: (m) => addressLists(m[1]) },
  { re: /^\/explorer\/address\/(.+)\/tagged-in$/, fn: (m) => addressTaggedIn(m[1]) },
  {
    re: /^\/explorer\/address\/(.+)\/close-accounts$/, fn: () => ({
      accounts: [
        {
          account: A.binance,
          score: 0.91,
          confidence: 'strong',
          lastSeen: '2026-07-09 18:42:00',
          reasons: [
            { type: 'direct_transfers', count: 7, days: 4, valueUsd: 128_400, bidirectional: true },
            { type: 'near_signing', days: 9 },
          ],
        },
        {
          account: A.krakenEvm,
          score: 0.68,
          confidence: 'moderate',
          lastSeen: '2026-07-06 09:15:00',
          reasons: [{ type: 'shared_cex', name: 'Kraken' }],
        },
      ],
      lookbackDays: null,
      disclaimer: 'Behavioral signals are not proof of common ownership. System and high-volume protocol accounts are excluded.',
    } satisfies CloseAccountsResponse),
  },
  { re: /^\/explorer\/dca-at\/(\d+)\/(\d+)/, fn: () => ({ scheduleId: 33546 }) },
  {
    // One DCA execution attempt by its event: the failed-attempt rows of the
    // cancelled schedule (33573) live at TIP-20/TIP-40 — same identity as its
    // schedule-page rows; other eventIndex-4 addresses are executed 33546 rows.
    // Anything else 404s (legacy event-form links must fall back to the
    // schedule resolver, mirroring the real API).
    re: /^\/explorer\/dca\/exec\/(\d+)\/(\d+)$/, fn: (m) => {
      const h = Number(m[1]), i = Number(m[2])
      if (i !== 4) return undefined
      const failed = h === TIP - 20 || h === TIP - 40
      if (failed) {
        const assetIn = aref(assetById.get(5)!), assetOut = aref(assetById.get(10)!)
        return {
          scheduleId: 33573, status: 'failed', who: A.fox,
          blockHeight: h, timestamp: tsAt(h), eventIndex: i, extrinsicIndex: null,
          assetIn, assetOut, amountIn: raw(975, assetIn.decimals), amountOut: null,
          valueUsd: 975, executionPrice: null, period: 6,
          failureReason: { label: 'pool trade limit reached', docs: 'The trade exceeds the pool trade volume limit for this block.' },
        }
      }
      const assetIn = aref(assetById.get(5)!), assetOut = aref(assetById.get(0)!)
      return {
        scheduleId: 33546, status: 'executed', who: A.fox,
        blockHeight: h, timestamp: tsAt(h), eventIndex: i, extrinsicIndex: null,
        assetIn, assetOut, amountIn: raw(12.5, 10), amountOut: raw(12.5 * 4.4422 / 0.02184, 12),
        valueUsd: 55.5, executionPrice: 4.4422 / 0.02184, period: 300,
        failureReason: null,
      }
    },
  },
  {
    re: /^\/explorer\/dca\/(\d+)/, fn: (m) => {
      const scheduleId = Number(m[1])
      if (scheduleId === 33573) {
        const assetIn = aref(assetById.get(5)!), assetOut = aref(assetById.get(10)!)
        const rows = [20, 40].map((ago) => ({
          type: 'dca', blockHeight: TIP - ago, timestamp: tsAt(TIP - ago), eventIndex: 4, extrinsicIndex: null,
          who: A.fox, to: null, asset: null, assetIn, assetOut,
          amount: null, amountIn: raw(975, assetIn.decimals), amountOut: null, valueUsd: 975,
          dca: true, dcaStatus: 'failed', dcaScheduleId: scheduleId, linkBlock: TIP - ago, linkIndex: null,
        })) as ActivityRow[]
        return {
          scheduleId, who: A.fox,
          createdAt: { blockHeight: TIP - 60, timestamp: tsAt(TIP - 60), extrinsicIndex: 2 },
          assetIn, assetOut, direction: 'Sell', amountPer: raw(975, assetIn.decimals), totalAmount: raw(3900, assetIn.decimals), period: 6, maxRetries: 0,
          status: 'cancelled', statusAt: tsAt(TIP - 1),
          executions: { count: 0, failed: 2, attempts: 2, totalIn: '0', totalOut: '0' }, rows,
        }
      }
      const execs = Array.from({ length: 25 }, (_, i) => ({
        type: 'dca', blockHeight: TIP - 300 - i * 100, timestamp: tsAt(TIP - 300 - i * 100), eventIndex: 4, extrinsicIndex: null,
        who: A.fox, to: null, asset: null, assetIn: aref(assetById.get(5)!), assetOut: aref(assetById.get(0)!),
        amount: null, amountIn: raw(12.5, 10), amountOut: raw(12.5 * 4.4422 / 0.02184, 12),
        valueUsd: 55.5, dca: true, dcaScheduleId: scheduleId, linkBlock: TIP - 300 - i * 100, linkIndex: null,
      })) as ActivityRow[]
      return {
        scheduleId,
        who: A.fox,
        createdAt: { blockHeight: TIP - 40000, timestamp: tsAt(TIP - 40000), extrinsicIndex: 2 },
        assetIn: aref(assetById.get(5)!), assetOut: aref(assetById.get(0)!),
        direction: 'Sell', amountPer: raw(12.5, 10), totalAmount: raw(5000, 10), period: 300, maxRetries: 3,
        status: 'active', statusAt: null,
        executions: { count: 132, failed: 0, attempts: 132, totalIn: raw(1650, 10), totalOut: raw(1650 * 4.4422 / 0.02184, 12) },
        rows: execs,
      }
    },
  },
  { re: /^\/explorer\/address\/(.+)$/, fn: (m) => buildAddress(decodeURIComponent(m[1])) },
  { re: /^\/explorer\/tag\/(.+)\/counts$/, fn: () => ({ extrinsics: 1451, extrinsicsOnBehalf: 0, events: 26787, votes: 0 }) },
  {
    re: /^\/explorer\/tag\/(.+)\/close-accounts$/, fn: () => ({
      accounts: [
        {
          account: A.binance,
          score: 0.87,
          confidence: 'strong',
          lastSeen: '2026-07-08 11:20:00',
          reasons: [
            { type: 'direct_transfers', count: 12, days: 6, valueUsd: 402_300, bidirectional: true },
            { type: 'near_signing', days: 5 },
          ],
        },
        {
          account: A.fox,
          score: 0.61,
          confidence: 'moderate',
          lastSeen: '2026-07-03 22:41:00',
          reasons: [{ type: 'direct_transfers', count: 3, days: 2, valueUsd: 9_800, bidirectional: false }],
        },
      ],
      lookbackDays: null,
      disclaimer: 'Behavioral signals are not proof of common ownership. System and high-volume protocol accounts are excluded.',
    } satisfies CloseAccountsResponse),
  },
  {
    re: /^\/explorer\/tag\/(.+)\/activity$/, fn: (_m, qs) => {
      const rows = filteredMockActivity(tagActivityRows(), qs)
      const offset = Number(qs.get('offset') ?? 0)
      return rows.slice(offset, offset + Number(qs.get('limit') ?? 25))
    },
  },
  { re: /^\/explorer\/tag\/(.+)\/list-count$/, fn: (_m, qs) => ({ total: mockListTotal(qs, tagActivityRows) }) },
  { re: /^\/explorer\/tag\/(.+)\/extrinsics$/, fn: (_m, qs) => recentExtrinsics(Number(qs.get('limit') ?? 25), true) },
  {
    re: /^\/explorer\/tag\/(.+)\/events$/, fn: (_m, qs) => {
      const limit = Number(qs.get('limit') ?? 25); const out: EventRow[] = []
      let h = TIP
      while (out.length < limit && h > TIP - 200) {
        const n = blockExtrinsicCount(h)
        for (let i = n - 1; i >= 0 && out.length < limit; i--) { const x = genExtrinsic(h, i); for (const e of x.events) { out.push({ blockHeight: h, eventIndex: out.length, extrinsicIndex: x.index, timestamp: x.timestamp, name: e.name, args: e.args, decoded: !!(e as { decoded?: boolean }).decoded }); if (out.length >= limit) break } }
        h--
      }
      return out.slice(0, limit)
    },
  },
  {
    re: /^\/explorer\/tag\/(.+)$/, fn: () => {
      const members = [A.krakenEvm, A.krakenSub]
      const balances = ASSETS.slice(0, 5).map((as, i) => {
        const bal = (i + 2) * 40000 / as.price
        // The tag's HDX row carries the members' summed lock breakdown so the
        // tag balances view exercises the same panel as accounts.
        if (as.assetId === 0) {
          return { asset: aref(as), total: raw(bal, as.decimals), free: raw(bal * 0.92, as.decimals), reserved: raw(bal * 0.08, as.decimals), lastBlock: TIP - i * 80, valueUsd: bal * as.price, ...hdxBreakdown(bal, as.decimals) }
        }
        return { asset: aref(as), total: raw(bal, as.decimals), free: raw(bal, as.decimals), reserved: '0', lastBlock: TIP - i * 80, valueUsd: bal * as.price }
      })
      const portfolioUsd = balances.reduce((s, b) => s + (b.valueUsd ?? 0), 0)
      const built = buildAddress(A.krakenEvm.accountId)
      const moneyMarket = built.moneyMarket.map(p => p.role === 'primary' ? { ...p, simAccount: A.krakenEvm.address } : p)
      return { tagId: 'kraken', name: 'Kraken', color: '#7b6cf6', note: 'Exchange — hot + deposit wallets', icon: '/tag-icons/kraken.jpg', members, balances, portfolioUsd, tradingVolumeUsd: portfolioUsd * 24, liquidationVolumeUsd: portfolioUsd * 0.08, moneyMarket, liquidityPositions: built.liquidityPositions ?? [], activeDcas: built.activeDcas ?? [], portfolioSeries: series(77, 52, portfolioUsd), balanceHistory: built.balanceHistory ?? [] } satisfies TagDetail
    },
  },
  {
    re: /^\/explorer\/search$/, fn: (_m, qs) => {
      const q = (qs.get('q') ?? '').trim(); const out: SearchResult[] = []
      if (/^\d+$/.test(q)) out.push({ type: 'block', value: q })
      if (/^\d+-\d+$/.test(q)) out.push({ type: 'extrinsic', value: q })
      // An EVM transaction hash offers the extrinsic and NOTHING else: it is 64-hex
      // like an AccountId32, and the fallback that reads it as one offered a
      // fabricated account page (see searchUncached's hash branch).
      if (q.toLowerCase() === MOCK_EVM_TX_HASH) out.push({ type: 'extrinsic', value: MOCK_EVM_TX_HASH })
      const sym = ASSETS.find(a => a.symbol.toLowerCase() === q.toLowerCase()); if (sym) out.push({ type: 'asset', value: String(sym.assetId), label: sym.symbol })
      if (/kraken/i.test(q)) out.push({ type: 'tag', value: 'kraken', label: 'Kraken', icon: '/tag-icons/kraken.jpg', color: '#7b6cf6' })
      const acc = ACCS.find(a => a.address.toLowerCase() === q.toLowerCase() || a.accountId.toLowerCase() === q.toLowerCase()); if (acc) out.push({ type: 'address', value: acc.accountId, label: acc.address, emoji: acc.emoji, identity: acc.identity })
      if (/^0x[0-9a-f]{40}$/i.test(q) && !acc) out.push({ type: 'address', value: q, label: q })
      // identity-name substring match
      if (/[a-z]/i.test(q)) {
        for (const a of ACCS) {
          if (a === acc || !a.identity?.display) continue
          if (a.identity.display.toLowerCase().includes(q.toLowerCase())) out.push({ type: 'address', value: a.accountId, label: a.address, emoji: a.emoji, identity: a.identity })
        }
      }
      // Referendum index or title, e.g. "263" or "treasury spend" — mirrors the
      // real search's two referendum matchers.
      if (/^\d+$/.test(q)) for (const r of MOCK_REFERENDA) if (String(r.index) === q) out.push(r)
      if (/[a-z]/i.test(q)) for (const r of MOCK_REFERENDA) if (r.label?.toLowerCase().includes(q.toLowerCase())) out.push(r)
      return out
    },
  },
  {
    re: /^\/explorer\/tags$/, fn: () => mockTags,
  },
  { re: /^\/explorer\/lists$/, fn: () => MOCK_LISTS },
  // Public detail of another user's list carries only the statistics —
  // tag names/members stay with the owner (mirrors listDetailResponse).
  { re: /^\/explorer\/list\/(.+)$/, fn: (m) => { const d = MOCK_LIST_DETAILS[decodeURIComponent(m[1])]; return d ? { ...d, tags: [] } : d } },
  // Connect-dialog display refs: echo known fixture accounts (matched on either
  // form), null for anything unknown — same contract as the real endpoint.
  {
    re: /^\/explorer\/account-refs$/,
    fn: (_m, qs) => (qs.get('addresses') ?? '').split(',').filter(Boolean).map(addr =>
      ACCS.find(a => a.address === addr || a.accountId === addr) ?? null),
  },
  // Authed detail — same objects as the public endpoint above (the mock has no
  // private-only list, so there is nothing the anonymous route wouldn't see).
  { re: /^\/user\/lists\/(.+)$/, fn: (m) => MOCK_LIST_DETAILS[decodeURIComponent(m[1])] },
  { re: /^\/user\/me$/, fn: () => MOCK_ME },
  { re: /^\/user\/tag-map$/, fn: () => MOCK_TAG_MAP },
  { re: /^\/user\/invites$/, fn: () => MOCK_INVITES },
  // A list tag's own aggregate page. Feeds answer empty (deterministic, and
  // enough for the page to render its header + empty tables); the detail carries
  // the same tag the tag-map's 'personal-watch' entry resolves pills to, so a
  // pill and its own aggregate page agree on name/color/icon.
  { re: /^\/user\/list-tag\/[^/]+\/[^/]+\/counts$/, fn: () => ({ extrinsics: 0, extrinsicsOnBehalf: 0, events: 0, votes: 0 }) },
  { re: /^\/user\/list-tag\/[^/]+\/[^/]+\/list-count$/, fn: () => ({ total: 0, complete: true }) },
  { re: /^\/user\/list-tag\/[^/]+\/[^/]+\/activity$/, fn: () => [] as ActivityRow[] },
  { re: /^\/user\/list-tag\/[^/]+\/[^/]+\/extrinsics$/, fn: () => [] as ExtrinsicSummary[] },
  { re: /^\/user\/list-tag\/[^/]+\/[^/]+\/events$/, fn: () => [] as EventRow[] },
  { re: /^\/user\/list-tag\/[^/]+\/[^/]+\/votes$/, fn: () => [] },
  { re: /^\/user\/list-tag\/[^/]+\/[^/]+\/value-events$/, fn: () => [] as ValueEvent[] },
  { re: /^\/user\/list-tag\/([^/]+)\/([^/]+)$/, fn: (m) => decodeURIComponent(m[2]) === MOCK_LIST_TAG_DETAIL.tagId ? MOCK_LIST_TAG_DETAIL : undefined },
]

const mockTags: Tag[] = [
  { tagId: 'kraken', name: 'Kraken', color: '#7b6cf6', note: 'Exchange — hot + deposit wallets', icon: '/tag-icons/kraken.jpg', memberCount: 2 },
  { tagId: 'treasury', name: 'Treasury', color: '#74C742', note: '', icon: '🏦', memberCount: 1 },
]

// Same index (263), two pallets — mirrors the real Democracy/OpenGov collision
// the search dropdown and its route must keep distinct.
const MOCK_REFERENDA: SearchResult[] = [
  { type: 'referendum', value: 'opengov:263', label: 'Treasury spend for Bifrost integration', pallet: 'opengov', index: 263, status: 'deciding' },
  { type: 'referendum', value: 'democracy:263', label: 'Treasury Council election', pallet: 'democracy', index: 263, status: 'passed' },
]

export function mockSync<T>(path: string): T | undefined {
  const [p, query] = path.split('?')
  const qs = new URLSearchParams(query ?? '')
  for (const route of ROUTES) {
    const m = p.match(route.re)
    if (m) return route.fn(m, qs) as T
  }
  return undefined
}
