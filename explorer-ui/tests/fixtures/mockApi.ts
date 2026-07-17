/* Deterministic API fixtures shared by Vitest and Playwright. */
import type {
  ExplorerStats, IndexerStatus, BlockSummary, BlockDetail, ExtrinsicSummary, ExtrinsicDetail,
  TransferRow, EventRow, TradeRow, ActivityRow, MoneyMarketResponse, AssetDetail, HoldersResponse,
  AddressDetail, AddressBalance, CloseAccountsResponse, TagDetail, SearchResult, AssetListItem, TopAccountRow, AccountsPage, DailyPoint, Tag,
  AccountRef, AssetRef, HdxDashboard, HdxCohort, HdxLockType, HdxUnlockBucket, HdxDailyFlow, HdxMover,
  HollarDashboard, HollarCollateral, HollarArbDay, HollarTradeDay, HollarPool, HollarPegPoint,
  TradeDetail as TradeDetailResponse,
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
]
const assetById = new Map(ASSETS.map(a => [a.assetId, a]))
function aref(a: MAsset): AssetRef { return { assetId: a.assetId, symbol: a.symbol, name: a.name, decimals: a.decimals, parachainId: a.parachainId } }
function raw(v: number, dec: number): string { return BigInt(Math.round(v * 1e6)).toString() + '0'.repeat(Math.max(0, dec - 6)) }

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

/* ---------- call/event catalogue ---------- */
const CALLS = ['Omnipool.sell', 'Omnipool.buy', 'Router.sell', 'Tokens.transfer', 'Balances.transfer_keep_alive', 'XTokens.transfer', 'Omnipool.add_liquidity', 'Staking.stake', 'DCA.schedule', 'EVM.call']

function genExtrinsic(height: number, idx: number): ExtrinsicDetail {
  const r = rng(height * 31 + idx * 7)
  const call = CALLS[Math.floor(r() * CALLS.length)]
  const signer = ACCS[Math.floor(r() * ACCS.length)]
  const dest = ACCS[Math.floor(r() * ACCS.length)]
  const aIn = ASSETS[Math.floor(r() * ASSETS.length)], aOut = ASSETS[Math.floor(r() * ASSETS.length)]
  const success = r() > 0.06
  const isInherent = idx < 2
  const callName = isInherent ? (idx === 0 ? 'Timestamp.set' : 'ParachainSystem.set_validation_data') : call
  const amt = +(10 + r() * 4000).toFixed(4)
  const callArgs: Record<string, unknown> = isInherent
    ? (idx === 0 ? { now: Date.parse(tsAt(height).replace(' ', 'T') + 'Z') } : { data: '0x…relay-chain-state-proof' })
    : call.startsWith('Omnipool.sell') || call.startsWith('Router')
      ? { asset_in: aIn.assetId, asset_out: aOut.assetId, amount: raw(amt, aIn.decimals), min_buy_amount: raw(amt * 0.99, aOut.decimals) }
      : call.startsWith('Tokens.transfer') ? { currency_id: aIn.assetId, dest: dest.address, amount: raw(amt, aIn.decimals) }
      : call.startsWith('Balances') ? { dest: dest.address, value: raw(amt, 12) }
      : call.startsWith('XTokens') ? { currency_id: aIn.assetId, amount: raw(amt, aIn.decimals), dest: { V3: { parents: 1, interior: { X2: [{ Parachain: 2004 }, { AccountId32: { id: dest.address } }] } } } }
      : call.startsWith('EVM') ? { target: '0x1b02E051683b5cfaC5929C25E84adb26ECf87B38', input: hx(height + idx, 72), value: '0', gas_limit: 300000 }
      : { amount: raw(amt, 12) }
  const events = isInherent
    ? [{ eventIndex: 0, name: 'System.ExtrinsicSuccess', args: { weight: 137_316_000 } }]
    : success
      ? [
        { eventIndex: 0, name: call.startsWith('Balances') ? 'Balances.Transfer' : 'Tokens.Transfer', args: { currency_id: aIn.assetId, from: signer.address, to: call.startsWith('Omnipool') ? 'Omnipool' : dest.address, amount: raw(amt, aIn.decimals) } },
        ...(call.startsWith('EVM') ? [{ eventIndex: 1, name: 'EVM.Log', args: { reserve: aIn.symbol, user: signer.address, amount: raw(amt, aIn.decimals) }, decoded: true } as ExtrinsicDetail['events'][number]] : []),
        { eventIndex: 2, name: 'TransactionPayment.TransactionFeePaid', args: { who: signer.address, actual_fee: raw(0.02, 12), tip: '0' } },
        { eventIndex: 3, name: 'System.ExtrinsicSuccess', args: { weight: 412_000_000 } },
      ]
      : [{ eventIndex: 0, name: 'System.ExtrinsicFailed', args: { dispatch_error: 'Token.BelowMinimum' } }]
  return {
    blockHeight: height, index: idx, hash: hx(height * 17 + idx, 64), timestamp: tsAt(height),
    signer: isInherent ? null : signer, success: isInherent ? true : success, callName,
    fee: isInherent ? null : raw(0.002 + r() * 0.05, 12), version: 4, tip: isInherent ? null : '0',
    callArgs, error: success || isInherent ? null : { module: 'Tokens', error: 'BelowMinimum' }, events,
  }
}

function recentExtrinsics(limit: number, signedOnly: boolean): ExtrinsicSummary[] {
  const out: ExtrinsicSummary[] = []
  let h = TIP
  while (out.length < limit && h > TIP - 400) {
    const n = 2 + (h % 6)
    for (let i = n - 1; i >= 0 && out.length < limit; i--) {
      const x = genExtrinsic(h, i)
      if (signedOnly && !x.signer) continue
      out.push({ blockHeight: x.blockHeight, index: x.index, hash: x.hash, timestamp: x.timestamp, signer: x.signer, success: x.success, callName: x.callName, fee: x.fee })
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
  return { ...base, type: t, asset: aref(aIn), amount: raw(amt, aIn.decimals), mmAction: t === 'mm' ? (['Supply', 'Borrow', 'Repay', 'Withdraw'][Math.floor(r() * 4)]) : undefined, ...(t === 'mm' ? { mmMarketKey: 'gigahdx', mmMarket: 'GIGAHDX' } : {}) }
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
  const n = 2 + (height % 6)
  const rows = Array.from({ length: n }, (_, i) => mockExtrinsicActivity(height, i)).flat()
  rows.push(activityRowAtHeight(height))
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
function buildAccounts(offset: number, limit: number, sort: string): AccountsPage {
  const rows: TopAccountRow[] = []
  // Kraken tag (2 members) as one row
  // 53 weekly points = the real API's 1Y padded sparkline shape.
  rows.push({ account: null, tag: { tagId: 'kraken', name: 'Kraken', color: '#7b6cf6', icon: '/tag-icons/kraken.jpg', memberCount: 2 }, portfolioUsd: 5_240_000, lastBlock: TIP - 12, healthFactor: '1410000000000000000', identity: 'Kraken', suppliedUsd: null, borrowedUsd: null, supplementalMarket: { marketKey: 'gigahdx', market: 'GIGAHDX', borrowedUsd: 6_200, healthFactor: '2380000000000000000' }, sparkline: series(99, 53, 5_240_000), activityCount: 2143, tradingVolumeUsd: 82_400_000, liquidationVolumeUsd: 740_000 })
  const seeds: [AccountRef, number][] = [[A.binance, 3_900_000], [A.fox, 1_240_000], [A.treasury, 980_000], [A.owl, 410_000], [A.swan, 96_000]]
  for (const [a, usd] of seeds) {
    const mm = mmFor(a.accountId.length * 7)
    rows.push({ account: a, tag: null, portfolioUsd: usd, lastBlock: TIP - Math.floor(usd % 900), healthFactor: mm.debt > 0 ? BigInt(Math.round(mm.hf * 1e18)).toString() : 'inf', identity: a === A.binance ? 'Binance' : null, suppliedUsd: mm.supply > 0 ? mm.supply : null, borrowedUsd: mm.debt > 0 ? mm.debt : null, supplementalMarket: a === A.fox ? { marketKey: 'gigahdx', market: 'GIGAHDX', borrowedUsd: 4_800, healthFactor: '2500000000000000000' } : null, sparkline: series(a.accountId.length * 31, 53, usd), activityCount: 100 + (usd % 4000), tradingVolumeUsd: usd * (12 + (a.accountId.charCodeAt(4) % 9)), liquidationVolumeUsd: mm.debt > 0 ? usd * (0.08 + (a.accountId.charCodeAt(6) % 5) / 100) : undefined })
  }
  const health = (row: TopAccountRow) => {
    if (!row.healthFactor) return Number.POSITIVE_INFINITY
    return row.healthFactor === 'inf' ? Number.MAX_SAFE_INTEGER : Number(row.healthFactor)
  }
  const sorted = [...rows].sort((a, b) => {
    if (sort === 'supplied') return (b.suppliedUsd ?? -1) - (a.suppliedUsd ?? -1)
    if (sort === 'borrowed') return (b.borrowedUsd ?? -1) - (a.borrowedUsd ?? -1)
    if (sort === 'health') return health(a) - health(b)
    if (sort === 'activity') return (b.activityCount ?? -1) - (a.activityCount ?? -1) || b.portfolioUsd - a.portfolioUsd
    if (sort === 'volume') return (b.tradingVolumeUsd ?? -1) - (a.tradingVolumeUsd ?? -1) || b.portfolioUsd - a.portfolioUsd
    if (sort === 'liquidation') return (b.liquidationVolumeUsd ?? -1) - (a.liquidationVolumeUsd ?? -1) || b.portfolioUsd - a.portfolioUsd
    if (sort === 'identity') {
      // Named rows first, alphabetically; unnamed by value (mirrors the server).
      const an = a.identity ?? a.tag?.name ?? '', bn = b.identity ?? b.tag?.name ?? ''
      return Number(Boolean(bn)) - Number(Boolean(an)) || an.localeCompare(bn) || b.portfolioUsd - a.portfolioUsd
    }
    return b.portfolioUsd - a.portfolioUsd
  })
  return { rows: sorted.slice(offset, offset + limit), total: sorted.length }
}
function buildAddress(accountId: string): AddressDetail {
  const a = ACCS.find(x => x.accountId === accountId || x.address.toLowerCase() === accountId.toLowerCase()) ?? A.fox
  const r = rng(a.accountId.length * 17)
  const priced = ASSETS.filter((_, i) => (r() > 0.4) || i < 2).slice(0, 6).map(as => {
    const bal = +(r() * (as.price > 1000 ? 3 : as.price > 1 ? 6000 : 2_000_000)).toFixed(4)
    return { asset: aref(as), total: raw(bal, as.decimals), free: raw(bal * 0.92, as.decimals), reserved: raw(bal * 0.08, as.decimals), lastBlock: TIP - Math.floor(r() * 40000), valueUsd: bal * as.price }
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
      isPure: { creator: A.fox, proxyType: 'Any', blockHeight: TIP - 220000, timestamp: tsAt(TIP - 220000) },
      delegates: [{ account: A.fox, proxyType: 'Any', delay: 0 }],
      delegatorOf: [],
    } : null,
    multisig: a === A.fox ? {
      threshold: 2,
      signatories: [A.owl, A.swan, A.binance],
      pending: [{ callHash: '0x25737077ac4eea2d3cc075243902f0d7e8e3a0ea9a39a00e6484121ba5b89aa8', depositor: A.owl, approvals: [A.owl], sinceBlock: TIP - 4200 }],
    } : null,
    multisigMemberships: a === A.owl ? [{ account: A.fox, threshold: 2, signatories: 3 }] : [],
  }
}

function mockAccountActivity(a: AccountRef, r: () => number): ActivityRow[] {
  return Array.from({ length: 12 }, (_, i) => {
    const h = TIP - i * 90 - Math.floor(r() * 30)
    const t = (['trade', 'transfer', 'dca', 'trade'] as const)[Math.floor(r() * 4)]
    const aIn = ASSETS[Math.floor(r() * ASSETS.length)], aOut = ASSETS[Math.floor(r() * ASSETS.length)]
    const amt = +(10 + r() * 4000).toFixed(2)
    const base = { blockHeight: h, timestamp: tsAt(h), extrinsicIndex: 2 + Math.floor(r() * 3), who: a, to: null as AccountRef | null, asset: null as AssetRef | null, assetIn: null as AssetRef | null, assetOut: null as AssetRef | null, amount: null as string | null, amountIn: null as string | null, amountOut: null as string | null, valueUsd: amt * aIn.price, linkBlock: h, linkIndex: 2 }
    if (t === 'transfer') return { ...base, type: t, to: ACCS[Math.floor(r() * ACCS.length)], asset: aref(aIn), amount: raw(amt, aIn.decimals) }
    return { ...base, type: t, assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amt, aIn.decimals), amountOut: raw(amt * aIn.price / aOut.price, aOut.decimals), dca: t === 'dca', ...(t === 'dca' ? { dcaScheduleId: 33546 } : {}) }
  })
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

const ROUTES: { re: RegExp; fn: (m: RegExpMatchArray, qs: URLSearchParams) => unknown }[] = [
  { re: /^\/explorer\/stats$/, fn: () => ({ headBlock: TIP, finalizedBlock: TIP - 2, headTime: tsAt(TIP), avgBlockSec: 6.0, transfers24h: 18204, extrinsics24h: 42318, activeAccounts24h: 7120, hdxPrice: 0.02184 } satisfies ExplorerStats) },
  { re: /^\/indexer$/, fn: () => ({ blockHeight: TIP, blockTimestamp: tsAt(TIP), lagSeconds: 6, chainBlockHeight: TIP + 1, blocksBehindHead: 1 } satisfies IndexerStatus) },
  { re: /^\/explorer\/assets$/, fn: () => buildAssets() },
  { re: /^\/explorer\/hdx$/, fn: () => buildHdx() },
  { re: /^\/explorer\/hollar$/, fn: () => buildHollar() },
  { re: /^\/explorer\/accounts$/, fn: (_m, qs) => buildAccounts(Number(qs.get('offset') ?? 0), Number(qs.get('limit') ?? 50), qs.get('sort') ?? 'value') },
  { re: /^\/explorer\/daily\/(\w+)(?:\?.*)?$/, fn: (m) => Array.from({ length: 45 }, (_, i) => { const d = new Date(MOCK_NOW_MS - (44 - i) * 86400000); const r = rng(i + m[1].length * 7); return { date: d.toISOString().slice(0, 10), value: Math.round((m[1] === 'events' ? 60000 : m[1] === 'extrinsics' ? 12000 : 4000) * (0.5 + r())) } as DailyPoint }) },
  { re: /^\/explorer\/accounts-daily$/, fn: () => Array.from({ length: 30 }, (_, i) => { const d = new Date(MOCK_NOW_MS - (29 - i) * 86400000); const r = rng(i * 31 + 5); return { date: d.toISOString().slice(0, 10), active: Math.round(6000 * (0.6 + r() * 0.8)), new: Math.round(350 * (0.4 + r())) } }) },
  { re: /^\/explorer\/counts$/, fn: () => ({ blocks: 567764, extrinsics: 132771, events: 4200000, transfers: 410000 }) },
  {
    re: /^\/explorer\/blocks$/, fn: (_m, qs) => {
      const limit = Number(qs.get('limit') ?? 25); const offset = Number(qs.get('offset') ?? 0)
      return Array.from({ length: limit }, (_, i) => { const h = TIP - offset - i; return { height: h, timestamp: tsAt(h), hash: hx(h, 64), author: COLLATORS[0], specVersion: 428, extrinsicCount: 2 + (h % 6), eventCount: (2 + (h % 6)) * 3 + (h % 5) } satisfies BlockSummary })
    },
  },
  {
    re: /^\/explorer\/block\/(\d+)$/, fn: (m) => {
      const h = Number(m[1]); const n = 2 + (h % 6)
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
  { re: /^\/explorer\/extrinsics$/, fn: (_m, qs) => recentExtrinsics(Number(qs.get('limit') ?? 25), qs.get('signedOnly') === '1') },
  { re: /^\/explorer\/extrinsic-at\/(\d+)\/(\d+)$/, fn: (m) => genExtrinsic(Number(m[1]), Number(m[2])) },
  { re: /^\/explorer\/extrinsic-at\/(\d+)\/(\d+)\/activity$/, fn: (m) => mockExtrinsicActivity(Number(m[1]), Number(m[2])) },
  { re: /^\/explorer\/extrinsic\/(0x[0-9a-f]{64})$/, fn: () => genExtrinsic(12_848_613, 4) },
  { re: /^\/explorer\/extrinsic\/(0x[0-9a-f]{64})\/activity$/, fn: () => mockExtrinsicActivity(12_848_613, 4) },
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
      const limit = Number(qs.get('limit') ?? 25); const out: EventRow[] = []
      let h = TIP
      while (out.length < limit && h > TIP - 200) {
        const n = 2 + (h % 6)
        for (let i = n - 1; i >= 0 && out.length < limit; i--) { const x = genExtrinsic(h, i); for (const e of x.events) { out.push({ blockHeight: h, eventIndex: out.length, extrinsicIndex: x.index, timestamp: x.timestamp, name: e.name, args: e.args, decoded: !!(e as { decoded?: boolean }).decoded }); if (out.length >= limit) break } }
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
        out.push({
          type: 'trade', blockHeight: h + 1, timestamp: tsAt(h + 1), eventIndex: 77, extrinsicIndex: null,
          who: A.fox, to: null, asset: null, assetIn: aref(ASSETS[2]), assetOut: aref(ASSETS[1]),
          amount: null, amountIn: raw(1234.56, ASSETS[2].decimals), amountOut: raw(1234.56 * ASSETS[2].price / ASSETS[1].price, ASSETS[1].decimals),
          valueUsd: 1234.56 * ASSETS[2].price,
        })
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
      return { asset: { ...aref(a), price: a.price, change24h: a.ch / 100, change7d: a.ch7d / 100, type: a.type, amountUsd: totalUsd }, holderCount: ACCS.length, totalUsd, priceSeries, priceDates } satisfies AssetDetail
    },
  },
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
      const activityType = qs.get('type') ?? 'all'
      const limit = Number(qs.get('limit') ?? 25)
      const account = ACCS.find(candidate => candidate.accountId === decodeURIComponent(m[1]) || candidate.address.toLowerCase() === decodeURIComponent(m[1]).toLowerCase()) ?? A.fox
      const rows = mockAccountActivity(account, rng(account.accountId.length * 17))
      return (activityType === 'all' ? rows : rows.filter(r => r.type === activityType)).slice(0, limit)
    },
  },
  { re: /^\/explorer\/address\/(.+)\/extrinsics$/, fn: (_m, qs) => recentExtrinsics(Number(qs.get('limit') ?? 25), true) },
  {
    re: /^\/explorer\/address\/(.+)\/events$/, fn: (_m, qs) => {
      const limit = Number(qs.get('limit') ?? 25); const out: EventRow[] = []
      let h = TIP
      while (out.length < limit && h > TIP - 200) {
        const n = 2 + (h % 6)
        for (let i = n - 1; i >= 0 && out.length < limit; i--) { const x = genExtrinsic(h, i); for (const e of x.events) { out.push({ blockHeight: h, eventIndex: out.length, extrinsicIndex: x.index, timestamp: x.timestamp, name: e.name, args: e.args, decoded: !!(e as { decoded?: boolean }).decoded }); if (out.length >= limit) break } }
        h--
      }
      return out.slice(0, limit)
    },
  },
  { re: /^\/explorer\/address\/(.+)\/counts$/, fn: () => ({ extrinsics: 1451, events: 26787, activity: 2143 }) },
  // Per-account balance/portfolio history. Must sit before the generic address
  // route below, whose greedy `(.+)` would otherwise swallow this sub-path and
  // fall back to the default account — leaking one account's history onto another.
  { re: /^\/explorer\/address\/(.+)\/history$/, fn: (m) => { const built = buildAddress(decodeURIComponent(m[1])); return { portfolioSeries: built.portfolioSeries ?? [], portfolioDates: built.portfolioDates ?? [], balanceHistory: built.balanceHistory ?? [] } } },
  // value-filtered activity count: 1600 of the 2143 rows are ≥ the requested $-min
  { re: /^\/explorer\/address\/(.+)\/activity-count$/, fn: (_m, qs) => ({ activity: qs.get('min') != null ? 1600 : null }) },
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
          assetIn, assetOut, amountPer: raw(975, assetIn.decimals), totalAmount: raw(3900, assetIn.decimals), period: 6, maxRetries: 0,
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
        amountPer: raw(12.5, 10), totalAmount: raw(5000, 10), period: 300, maxRetries: 3,
        status: 'active', statusAt: null,
        executions: { count: 132, failed: 0, attempts: 132, totalIn: raw(1650, 10), totalOut: raw(1650 * 4.4422 / 0.02184, 12) },
        rows: execs,
      }
    },
  },
  { re: /^\/explorer\/address\/(.+)$/, fn: (m) => buildAddress(decodeURIComponent(m[1])) },
  { re: /^\/explorer\/tag\/(.+)\/counts$/, fn: () => ({ extrinsics: 1451, events: 26787, activity: 2143 }) },
  { re: /^\/explorer\/tag\/(.+)\/activity-count$/, fn: () => ({ activity: 640 }) },
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
  { re: /^\/explorer\/tag\/(.+)\/activity$/, fn: () => mockAccountActivity(A.krakenEvm, rng(A.krakenEvm.accountId.length * 17)) },
  { re: /^\/explorer\/tag\/(.+)\/extrinsics$/, fn: (_m, qs) => recentExtrinsics(Number(qs.get('limit') ?? 25), true) },
  {
    re: /^\/explorer\/tag\/(.+)\/events$/, fn: (_m, qs) => {
      const limit = Number(qs.get('limit') ?? 25); const out: EventRow[] = []
      let h = TIP
      while (out.length < limit && h > TIP - 200) {
        const n = 2 + (h % 6)
        for (let i = n - 1; i >= 0 && out.length < limit; i--) { const x = genExtrinsic(h, i); for (const e of x.events) { out.push({ blockHeight: h, eventIndex: out.length, extrinsicIndex: x.index, timestamp: x.timestamp, name: e.name, args: e.args, decoded: !!(e as { decoded?: boolean }).decoded }); if (out.length >= limit) break } }
        h--
      }
      return out.slice(0, limit)
    },
  },
  {
    re: /^\/explorer\/tag\/(.+)$/, fn: () => {
      const members = [A.krakenEvm, A.krakenSub]
      const balances = ASSETS.slice(0, 5).map((as, i) => { const bal = (i + 2) * 40000 / as.price; return { asset: aref(as), total: raw(bal, as.decimals), free: raw(bal, as.decimals), reserved: '0', lastBlock: TIP - i * 80, valueUsd: bal * as.price } })
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
      return out
    },
  },
  {
    re: /^\/explorer\/tags$/, fn: () => mockTags,
  },
]

const mockTags: Tag[] = [
  { tagId: 'kraken', name: 'Kraken', color: '#7b6cf6', note: 'Exchange — hot + deposit wallets', icon: '/tag-icons/kraken.jpg', members: [{ accountId: A.krakenEvm.accountId, address: A.krakenEvm.address }, { accountId: A.krakenSub.accountId, address: A.krakenSub.address }] },
  { tagId: 'treasury', name: 'Treasury', color: '#74C742', note: '', icon: '🏦', members: [{ accountId: A.treasury.accountId, address: A.treasury.address }] },
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
