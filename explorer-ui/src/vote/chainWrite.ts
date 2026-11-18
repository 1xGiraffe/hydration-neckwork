import { decodeAddress, encodeAddress, u8aToHex } from 'dedot/utils'
import { getSubstrateClient, submitPermitUnsigned } from '../substrateWrite'
import { EVM_RPC_URL, ethBlockTimestamp, ethCall, ethEstimateGas, ethGasPrice } from '../evmRpc'
import { HYDRATION_CHAIN_ID, ensureHydrationChain } from '../contractWrite'
import type { SubmitResult } from '../contractWrite'
import { buildDispatchPermitArgs, parsePermitNonce, permitNonceCall, permitTypedData, splitSignature, withSubmitTimeout, PERMIT_DEADLINE_SECONDS } from '../permitWrite'
import type { PermitFields } from '../permitWrite'
import type { ChainAccount } from '../chainWallet'
import { signerFor, walletAddressOf } from '../chainWallet'
import { spendableWith, totalBalance, voteCapital, formatHdx, formatUnits } from './voteMath'
import type { HdxAccount, Tally, VoteSpec } from './voteMath'

// The one signing engine for governance: it builds the call exactly as it will be
// signed (votes, vote removals, unlocks, a GIGAHDX reward claim, referendum and
// preimage deposits and their refunds, a new proposal — batched with
// utility.batchAll and wrapped in proxy.proxy when voting for another account),
// quotes the fee, dry-runs it on our RPC with the signer as origin
// (DryRunApi.dry_run_call), and only then hands it to the wallet:
//   - a substrate extension signs the extrinsic itself;
//   - an EVM wallet signs an EIP-712 CallPermit whose `to` is the dispatch
//     precompile (0x…0401) and whose `data` is the SCALE call, submitted as an
//     unsigned MultiTransactionPayment.dispatch_permit — the fee is charged to
//     the mapped account in its fee currency;
//   - an EVM account whose fee currency is WETH sends the call to the dispatch
//     precompile as an ordinary EVM transaction instead (the wallet pays gas in
//     WETH), the split the Hydration app makes.
// The account an EVM address votes as is EvmAccountsApi.account_id(h160): the
// bound substrate account when bound, else `ETH\0 ‖ h160 ‖ 0×8`.
//
// Loaded lazily (the dedot chunk): nothing here runs on a read-only page.

export const DISPATCH_PRECOMPILE = '0x0000000000000000000000000000000000000401'
export const WETH_ASSET_ID = 20
export const HDX_ASSET_ID = 0
const SS58_PREFIX = 0

// ---- dynamic client --------------------------------------------------------
// dedot resolves pallets, calls, storage and runtime APIs from the live metadata;
// this is the slice the engine touches, typed loosely on purpose.

interface DynTx {
  call: unknown
  callHex: string
  paymentInfo(address: string): Promise<{ weight: { refTime: bigint; proofSize: bigint }; partialFee: bigint }>
  signAndSend(address: string, options: Record<string, unknown>, cb: (r: SubmitResult & { status: { type: string; value?: { blockNumber?: number; blockHash?: string; txIndex?: number } } }) => void): Promise<() => void>
}
type DynQueryFn = ((...args: unknown[]) => Promise<unknown>) & { multi?: (keys: unknown[]) => Promise<unknown[]>; entries?: (...args: unknown[]) => Promise<[unknown, unknown][]> }
interface DynClient {
  tx: Record<string, Record<string, (...args: unknown[]) => DynTx>>
  query: Record<string, Record<string, DynQueryFn>>
  call: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
  consts: Record<string, Record<string, unknown>>
  registry: { findErrorMeta(err: unknown): { pallet: string; name: string; docs: string[] } | undefined; findCodec(typeId: number): { tryDecode(input: string | Uint8Array): unknown } }
  rpc: Record<string, (...args: unknown[]) => Promise<unknown>>
  runtimeVersion: { specName: string; specVersion: number }
  metadata: { latest: { extrinsic: { callTypeId: number } } }
}

export async function client(): Promise<DynClient> {
  return (await getSubstrateClient()) as unknown as DynClient
}

// ---- accounts --------------------------------------------------------------

export function toAccountIdHex(address: string): string {
  return u8aToHex(decodeAddress(address))
}

export function toSs58(accountIdHex: string): string {
  return encodeAddress(accountIdHex, SS58_PREFIX)
}

const hexOf = (v: unknown): string => {
  const raw = (v as { raw?: unknown })?.raw
  if (typeof raw === 'string') return raw
  if (typeof v === 'string') return v.startsWith('0x') ? v : toAccountIdHex(v)
  throw new Error('unexpected account id shape')
}

/** The Hydration account an EVM address acts as (EvmAccountsApi.account_id). */
export async function evmAccountId(h160: string): Promise<string> {
  const c = await client()
  return hexOf(await c.call.evmAccountsApi.accountId(h160))
}

/** A connected account's runtime account id (hex). Substrate H160 accounts have none usable. */
export async function runtimeAccountOf(account: ChainAccount): Promise<string> {
  if (account.kind === 'evm') return evmAccountId(account.address)
  if (account.kind === 'substrate-h160') throw new Error('An Ethereum account inside a Polkadot extension cannot sign on Hydration — connect the wallet’s EVM mode instead')
  return toAccountIdHex(account.address)
}

/** True for the `ETH\0 ‖ h160 ‖ 0×8` accounts unbound EVM addresses map to. */
export function isEvmMapped(accountIdHex: string): boolean {
  return /^0x45544800[0-9a-f]{40}0{16}$/i.test(accountIdHex)
}

// ---- chain reads at compose time ------------------------------------------

export interface ClassVote { poll: number; vote: VoteSpec }
export interface ClassVoting {
  cls: number
  kind: 'casting' | 'delegating'
  votes: ClassVote[]
  prior: { until: number; amount: bigint }
  delegatingTo: string | null
  /** Votes delegated TO this account on this track: they follow its Standard votes. */
  delegations: { votes: bigint; capital: bigint }
}

/** A GIGAHDX reward record of one vote (GigaHdxRewards.UserVoteRecords). */
export interface GigaVoteRecord { stakedVoteAmount: bigint; weighted: bigint }

export interface ActorState {
  accountId: string
  hdx: HdxAccount
  /** Balances.Locks by id ('pyconvot' votes, 'stk_stks' staking, 'ghdxlock' GIGAHDX, 'ormlvest' vesting…). */
  locks: { id: string; amount: bigint }[]
  classLocks: { cls: number; amount: bigint }[]
  voting: ClassVoting[]
  /** The fee currency the chain will charge this account in (MultiTransactionPayment::account_currency). */
  feeCurrency: number
  gigahdx: { stakedHdx: bigint; pendingRewards: bigint; votedPolls: number[]; records: Map<number, GigaVoteRecord> } | null
  /**
   * The legacy staking position, when the account has one: the votes the staking
   * pallet tracks for it (at most `maxVotes`, across all tracks) and the votes it
   * already rewarded (VotesRewarded) — both hold the staked amount a losing vote locks.
   */
  staking: { positionId: string; votes: Map<number, bigint>; rewarded: Map<number, bigint>; maxVotes: number } | null
  /** Legacy staking lock, when the account stakes HDX. */
  stakingLock: bigint
  readAtBlock: number
}

const LOCK_NAMES: Record<string, string> = { pyconvot: 'votes', stk_stks: 'staking', ghdxlock: 'GIGAHDX', ormlvest: 'vesting' }
export function lockName(id: string): string { return LOCK_NAMES[id] ?? id }

function lockIdText(hex: string): string {
  const bytes = hex.replace(/^0x/, '').match(/../g) ?? []
  return bytes.map(b => String.fromCharCode(parseInt(b, 16))).join('').replace(/\0+$/, '')
}

function parseVote(v: unknown): VoteSpec | null {
  const o = v as { type?: string; value?: { vote?: number; balance?: bigint; aye?: bigint; nay?: bigint; abstain?: bigint } }
  if (o?.type === 'Standard' && o.value) {
    const byte = Number(o.value.vote)
    return { kind: 'Standard', aye: (byte & 0x80) !== 0, conviction: Math.min(6, byte & 0x7f) as 0, balance: BigInt(o.value.balance ?? 0) }
  }
  if (o?.type === 'Split' && o.value) return { kind: 'Split', aye: BigInt(o.value.aye ?? 0), nay: BigInt(o.value.nay ?? 0) }
  if (o?.type === 'SplitAbstain' && o.value) return { kind: 'SplitAbstain', aye: BigInt(o.value.aye ?? 0), nay: BigInt(o.value.nay ?? 0), abstain: BigInt(o.value.abstain ?? 0) }
  return null
}

let trackIdsCache: number[] | null = null
export async function trackIds(): Promise<number[]> {
  if (trackIdsCache) return trackIdsCache
  const c = await client()
  const tracks = c.consts.referenda.tracks as [number, unknown][]
  trackIdsCache = tracks.map(t => Number(t[0]))
  return trackIdsCache
}

export async function chainConstants() {
  const c = await client()
  return {
    existentialDeposit: BigInt(c.consts.balances.existentialDeposit as bigint),
    voteLockingPeriod: Number(c.consts.convictionVoting.voteLockingPeriod),
    maxVotes: Number(c.consts.convictionVoting.maxVotes),
  }
}

export async function readActor(accountId: string): Promise<ActorState> {
  const c = await client()
  const classes = await trackIds()
  const [account, locks, classLocks, voting, currency, giga, pending, header] = await Promise.all([
    c.query.system.account(accountId) as Promise<{ data: { free: bigint; reserved: bigint; frozen: bigint } }>,
    c.query.balances.locks(accountId) as Promise<{ id: string; amount: bigint }[]>,
    c.query.convictionVoting.classLocksFor(accountId) as Promise<[number, bigint][]>,
    c.query.convictionVoting.votingFor.multi!(classes.map(cls => [accountId, cls])) as Promise<{ type: string; value: { votes?: [number, unknown][]; prior: [number, bigint]; target?: unknown } }[]>,
    c.query.multiTransactionPayment.accountCurrencyMap(accountId) as Promise<number | undefined>,
    (c.query.gigaHdx?.stakes?.(accountId) ?? Promise.resolve(undefined)) as Promise<{ hdx: bigint } | undefined>,
    (c.query.gigaHdxRewards?.pendingRewards?.(accountId) ?? Promise.resolve(0n)) as Promise<bigint>,
    c.rpc.chain_getHeader() as Promise<{ number: number }>,
  ])
  const feeCurrency = await effectiveFeeCurrency(accountId, currency)
  const gigaStaked = BigInt(giga?.hdx ?? 0n)
  const records = new Map<number, GigaVoteRecord>()
  if (gigaStaked > 0n || BigInt(pending ?? 0n) > 0n) {
    try {
      const entries = await c.query.gigaHdxRewards.userVoteRecords.entries!(accountId)
      for (const [k, v] of entries) {
        const r = v as { stakedVoteAmount?: bigint; weighted?: bigint }
        records.set(Number((k as unknown[])[1]), { stakedVoteAmount: BigInt(r?.stakedVoteAmount ?? 0n), weighted: BigInt(r?.weighted ?? 0n) })
      }
    } catch { /* no records readable: treated as none */ }
  }
  const staking = await readStakingPosition(c, accountId).catch(() => null)
  const parsedLocks = (locks ?? []).map(l => ({ id: lockIdText(String(l.id)), amount: BigInt(l.amount) }))
  return {
    accountId,
    hdx: { free: BigInt(account.data.free), reserved: BigInt(account.data.reserved), frozen: BigInt(account.data.frozen) },
    locks: parsedLocks,
    classLocks: (classLocks ?? []).map(([cls, amount]) => ({ cls: Number(cls), amount: BigInt(amount) })),
    voting: voting.map((v, i) => {
      const cls = classes[i]
      if (v?.type === 'Delegating') {
        const val = v.value as unknown as { target: unknown; prior: [number, bigint] }
        return { cls, kind: 'delegating' as const, votes: [], prior: { until: Number(val.prior?.[0] ?? 0), amount: BigInt(val.prior?.[1] ?? 0) }, delegatingTo: hexOf(val.target), delegations: { votes: 0n, capital: 0n } }
      }
      const votes = (v?.value?.votes ?? []).flatMap(([poll, vote]) => {
        const p = parseVote(vote)
        return p ? [{ poll: Number(poll), vote: p }] : []
      })
      const d = (v?.value as { delegations?: { votes?: bigint; capital?: bigint } } | undefined)?.delegations
      return {
        cls, kind: 'casting' as const, votes, prior: { until: Number(v?.value?.prior?.[0] ?? 0), amount: BigInt(v?.value?.prior?.[1] ?? 0) }, delegatingTo: null,
        delegations: { votes: BigInt(d?.votes ?? 0n), capital: BigInt(d?.capital ?? 0n) },
      }
    }),
    feeCurrency,
    gigahdx: gigaStaked > 0n || BigInt(pending ?? 0n) > 0n ? { stakedHdx: gigaStaked, pendingRewards: BigInt(pending ?? 0n), votedPolls: [...records.keys()], records } : null,
    staking,
    stakingLock: parsedLocks.find(l => l.id === 'stk_stks')?.amount ?? 0n,
    readAtBlock: Number(header.number),
  }
}

// The legacy staking pallet's position NFTs live in this Uniques collection
// (runtime: pallet_staking NFTCollectionId = 2222); an account holds at most one.
const STAKING_COLLECTION = 2222n

/**
 * The account's legacy staking position and the votes the staking pallet tracks for it
 * (Staking.Votes, one entry per referendum, at most MaxVotes across all tracks — a
 * new vote past that fails with Staking.MaxVotesReached) plus the ones it already
 * rewarded (Staking.VotesRewarded). Removing a vote drops its entry.
 */
async function readStakingPosition(c: DynClient, accountId: string): Promise<ActorState['staking']> {
  const owned = await c.query.uniques.account.entries!(accountId, STAKING_COLLECTION)
  if (!owned.length) return null
  const key = owned[0][0] as unknown[]
  const positionId = String(key[2])
  const [votes, rewarded] = await Promise.all([
    c.query.staking.votes(BigInt(positionId)) as Promise<{ votes?: [number, { amount: bigint }][] }>,
    c.query.staking.votesRewarded.entries!(accountId) as Promise<[unknown, unknown][]>,
  ])
  const maxVotes = Number((c.consts.staking as Record<string, unknown> | undefined)?.maxVotes ?? 25)
  return {
    positionId,
    votes: new Map((votes?.votes ?? []).map(([poll, v]) => [Number(poll), BigInt(v?.amount ?? 0n)])),
    rewarded: new Map(rewarded.map(([k, v]) => [Number((k as unknown[])[1]), BigInt((v as { amount?: bigint })?.amount ?? 0n)])),
    maxVotes,
  }
}

/** MultiTransactionPayment::account_currency: the set currency when it is still accepted, else WETH for an EVM-mapped account and HDX otherwise. */
async function effectiveFeeCurrency(accountId: string, set: number | undefined): Promise<number> {
  if (set != null) {
    if (Number(set) === HDX_ASSET_ID) return HDX_ASSET_ID
    const c = await client()
    const accepted = await c.query.multiTransactionPayment.acceptedCurrencies(Number(set))
    if (accepted != null) return Number(set)
  }
  return isEvmMapped(accountId) ? WETH_ASSET_ID : HDX_ASSET_ID
}

export interface AssetInfo { id: number; symbol: string; decimals: number }
const assetCache = new Map<number, AssetInfo>()
export async function assetInfo(id: number): Promise<AssetInfo> {
  if (id === HDX_ASSET_ID) return { id, symbol: 'HDX', decimals: 12 }
  const hit = assetCache.get(id)
  if (hit) return hit
  const c = await client()
  let info: AssetInfo = { id, symbol: `asset ${id}`, decimals: 12 }
  try {
    const a = await c.query.assetRegistry.assets(id) as { symbol?: unknown; decimals?: number } | undefined
    const sym = typeof a?.symbol === 'string' ? (a.symbol.startsWith('0x') ? lockIdText(a.symbol) : a.symbol) : null
    info = { id, symbol: sym || `asset ${id}`, decimals: a?.decimals ?? 12 }
  } catch { /* keep the fallback name */ }
  assetCache.set(id, info)
  return info
}

/** A fee-currency balance the payer can spend (orml tokens free minus frozen). */
async function tokenSpendable(accountId: string, assetId: number): Promise<bigint> {
  const c = await client()
  const t = await c.query.tokens.accounts([accountId, assetId]) as { free: bigint; frozen: bigint } | undefined
  if (!t) return 0n
  const free = BigInt(t.free), frozen = BigInt(t.frozen)
  return free > frozen ? free - frozen : 0n
}

// The price the chain charges a fee at. MultiTransactionPayment prices an accepted
// currency each block from the EMA oracle (the asset → HDX route, 10-minute period),
// falling back to the stored AcceptedCurrencies price only when the oracle has none,
// and clears that cache at the end of the block — so it is not readable from storage.
// XcmPaymentApi.query_weight_to_asset_fee applies exactly that price
// (MultiTransactionPayment::price) to a weight's fee, so the ratio of its answers for
// an asset and for HDX at one fixed weight is the conversion the fee payment uses.
export type FeePriceSource = 'native' | 'oracle' | 'fallback'
const HDX_LOCATION = { parents: 1, interior: { type: 'X2', value: [{ type: 'Parachain', value: 2034 }, { type: 'GeneralIndex', value: 0n }] } }
const PRICE_WEIGHT = { refTime: 10n ** 12n, proofSize: 0n }

async function weightFeeIn(location: unknown): Promise<bigint | null> {
  const c = await client()
  const r = await c.call.xcmPaymentApi.queryWeightToAssetFee(PRICE_WEIGHT, { type: 'V4', value: location }) as { isOk?: boolean; value?: unknown }
  return r?.isOk && r.value != null ? BigInt(String(r.value)) : null
}

/** Asset units per HDX unit as the chain prices the fee (num/den), and where the price came from. */
export async function feePrice(currency: number): Promise<{ num: bigint; den: bigint; source: FeePriceSource } | null> {
  if (currency === HDX_ASSET_ID) return { num: 1n, den: 1n, source: 'native' }
  const c = await client()
  try {
    const location = await c.query.assetRegistry.assetLocations(currency)
    if (location) {
      const [num, den] = await Promise.all([weightFeeIn(location), weightFeeIn(HDX_LOCATION)])
      if (num != null && den != null && den > 0n) return { num, den, source: 'oracle' }
    }
  } catch { /* fall through to the stored price */ }
  const price = await c.query.multiTransactionPayment.acceptedCurrencies(currency) as bigint | undefined
  return price == null ? null : { num: BigInt(price), den: 10n ** 18n, source: 'fallback' }
}

/** Proxy.Proxies(real): the delegate's entry, read fresh at compose time. */
export async function readProxyEntry(realHex: string, delegateHex: string): Promise<{ proxyType: string; delay: number }[]> {
  const c = await client()
  const [list] = await c.query.proxy.proxies(realHex) as [{ delegate: unknown; proxyType: string; delay: number }[], bigint]
  return (list ?? []).filter(p => hexOf(p.delegate).toLowerCase() === delegateHex.toLowerCase()).map(p => ({ proxyType: String(p.proxyType), delay: Number(p.delay) }))
}

export interface LiveReferendum {
  index: number
  ongoing: boolean
  track: number | null
  tally: Tally | null
  electorate: bigint
  status: string
}

export async function readReferendum(index: number): Promise<LiveReferendum> {
  const c = await client()
  const [info, total, inactive] = await Promise.all([
    c.query.referenda.referendumInfoFor(index) as Promise<{ type: string; value: { track?: number; tally?: { ayes: bigint; nays: bigint; support: bigint } } } | undefined>,
    c.query.balances.totalIssuance() as Promise<bigint>,
    c.query.balances.inactiveIssuance() as Promise<bigint>,
  ])
  const electorate = BigInt(total) - BigInt(inactive)
  if (!info) return { index, ongoing: false, track: null, tally: null, electorate, status: 'unknown' }
  if (info.type !== 'Ongoing') return { index, ongoing: false, track: null, tally: null, electorate, status: info.type.toLowerCase() }
  const t = info.value.tally
  return {
    index, ongoing: true, track: Number(info.value.track), electorate, status: 'ongoing',
    tally: t ? { ayes: BigInt(t.ayes), nays: BigInt(t.nays), support: BigInt(t.support) } : null,
  }
}

/** Which referenda (of a list) are no longer ongoing — their votes can be removed and their locks settle. */
export async function finishedPolls(polls: number[]): Promise<Set<number>> {
  const out = await pollOutcomes(polls)
  return new Set(polls.filter(p => out.get(p)?.state !== 'ongoing'))
}

/**
 * A referendum as conviction voting sees it when a vote on it is removed: still
 * running, Completed(end, approved) for an approved or rejected one, or None for a
 * cancelled, killed or timed-out one (no lock follows from those). `rewardPool` says
 * whether GIGAHDX rewards were already allocated for it (ReferendaRewardPool).
 */
export type PollOutcome =
  | { state: 'ongoing' }
  | { state: 'completed'; end: number; approved: boolean; rewardPool: boolean }
  | { state: 'none'; rewardPool: boolean }

export async function pollOutcomes(polls: number[]): Promise<Map<number, PollOutcome>> {
  const out = new Map<number, PollOutcome>()
  if (!polls.length) return out
  const c = await client()
  const [infos, pools] = await Promise.all([
    c.query.referenda.referendumInfoFor.multi!(polls) as Promise<({ type: string; value?: unknown } | undefined)[]>,
    (c.query.gigaHdxRewards?.referendaRewardPool?.multi?.(polls) ?? Promise.resolve(polls.map(() => undefined))) as Promise<unknown[]>,
  ])
  polls.forEach((p, i) => {
    const info = infos[i]
    const rewardPool = pools[i] != null
    if (!info || info.type === 'Ongoing') { out.set(p, info ? { state: 'ongoing' } : { state: 'none', rewardPool }); return }
    if (info.type === 'Approved' || info.type === 'Rejected') {
      const end = Number((info.value as unknown[])?.[0] ?? 0)
      out.set(p, { state: 'completed', end, approved: info.type === 'Approved', rewardPool })
    } else out.set(p, { state: 'none', rewardPool })
  })
  return out
}

// ---- actions and calls -----------------------------------------------------

/**
 * Where a referendum's call is dispatched from: Root, or one of the runtime's custom
 * origins (each maps to one track — the runtime's `track_for`).
 */
export type ProposalOrigin = { kind: 'root' } | { kind: 'origin'; name: string }

export type VoteAction =
  | { kind: 'vote'; poll: number; vote: VoteSpec }
  | { kind: 'remove-vote'; poll: number; cls: number }
  | { kind: 'unlock'; cls: number; target: string }
  | { kind: 'claim-gigahdx-rewards' }
  // Deposits: placing one pays it from the signer; both refunds are permissionless
  // and pay the depositor, whoever signs.
  | { kind: 'place-decision-deposit'; index: number }
  | { kind: 'refund-decision-deposit'; index: number }
  | { kind: 'refund-submission-deposit'; index: number }
  // Only the preimage's owner can unnote it (and is refunded its deposit).
  | { kind: 'unnote-preimage'; hash: string }
  // Proposing: store the call's bytes (the signer pays the preimage deposit), then
  // submit a referendum on it (the signer pays the submission deposit).
  | { kind: 'note-preimage'; bytes: string }
  | { kind: 'submit'; origin: ProposalOrigin; proposal: { hash: string; len: number }; enactment: { after: number } | { at: number } }

/** Actions that move or return deposits rather than votes (they need no voting state). */
export const DEPOSIT_ACTION_KINDS = new Set<VoteAction['kind']>([
  'place-decision-deposit', 'refund-decision-deposit', 'refund-submission-deposit', 'unnote-preimage', 'note-preimage', 'submit',
])

export type ProxyType = 'Any' | 'Governance'

export interface WritePlan {
  /** The connected account that signs (and pays the fee). */
  signer: ChainAccount
  /** The signer's runtime account id (hex) — the dry-run origin. */
  signerId: string
  /** Set when the actions are for another account: proxy.proxy(real, Some(type), call). */
  proxy: { real: string; proxyType: ProxyType } | null
  /**
   * A second hop, when the signer reaches `proxy.real` through an account it is an
   * Any proxy of: proxy.proxy(via.real, Some(Any), proxy.proxy(real, Some(type), call)).
   * Only Any can carry the inner proxy.proxy (no other type's filter admits Proxy calls).
   */
  via?: { real: string; proxyType: 'Any' } | null
  actions: VoteAction[]
  /**
   * Pay this fee in HDX: the extrinsic becomes utility.batchAll([
   * multiTransactionPayment.set_currency(HDX), …]), which the runtime charges in the
   * currency it sets (`TryCallCurrency`: a batch whose first call is set_currency).
   * The setting stays: the signer pays later fees in HDX too. Substrate signers only.
   */
  feeInHdx?: boolean
}

function accountVoteArg(v: VoteSpec) {
  if (v.kind === 'Standard') return { type: 'Standard', value: { vote: (v.aye ? 0x80 : 0) | v.conviction, balance: v.balance } }
  if (v.kind === 'Split') return { type: 'Split', value: { aye: v.aye, nay: v.nay } }
  return { type: 'SplitAbstain', value: { aye: v.aye, nay: v.nay, abstain: v.abstain } }
}

// GigaHdxRewards.claim_rewards is its pallet's only call and takes no arguments,
// so the metadata describes the call enum as a bare literal ('claim_rewards') that
// dedot's call builder does not produce. The call is decoded from its two index
// bytes instead — pallet index and call index, both read from the live metadata.
function claimRewardsCall(c: DynClient): unknown {
  const meta = c.metadata as unknown as { latest: { pallets: { name: string; index: number; calls?: { typeId: number } }[]; extrinsic: { callTypeId: number } } }
  const pallet = meta.latest.pallets.find(p => p.name === 'GigaHdxRewards')
  if (!pallet?.calls) throw new Error('This runtime has no GIGAHDX rewards pallet')
  const type = (c.registry as unknown as { findType(id: number): { typeDef: { type: string; value: { members: { name: string; index: number }[] } } } }).findType(pallet.calls.typeId)
  const variant = type.typeDef.type === 'Enum' ? type.typeDef.value.members.find(m => m.name === 'claim_rewards') : undefined
  if (!variant) throw new Error('This runtime has no claim_rewards call')
  const hex = `0x${pallet.index.toString(16).padStart(2, '0')}${variant.index.toString(16).padStart(2, '0')}`
  return c.registry.findCodec(meta.latest.extrinsic.callTypeId).tryDecode(hex)
}

function originArg(o: ProposalOrigin): unknown {
  return o.kind === 'root' ? { type: 'System', value: { type: 'Root' } } : { type: 'Origins', value: o.name }
}

function actionCall(c: DynClient, a: VoteAction): { call: unknown; tx: DynTx | null } {
  const one = (tx: DynTx) => ({ call: tx.call, tx })
  switch (a.kind) {
    case 'vote': return one(c.tx.convictionVoting.vote(a.poll, accountVoteArg(a.vote)))
    case 'remove-vote': return one(c.tx.convictionVoting.removeVote(a.cls, a.poll))
    case 'unlock': return one(c.tx.convictionVoting.unlock(a.cls, a.target))
    case 'claim-gigahdx-rewards': return { call: claimRewardsCall(c), tx: null }
    case 'place-decision-deposit': return one(c.tx.referenda.placeDecisionDeposit(a.index))
    case 'refund-decision-deposit': return one(c.tx.referenda.refundDecisionDeposit(a.index))
    case 'refund-submission-deposit': return one(c.tx.referenda.refundSubmissionDeposit(a.index))
    case 'unnote-preimage': return one(c.tx.preimage.unnotePreimage(a.hash))
    case 'note-preimage': return one(c.tx.preimage.notePreimage(a.bytes))
    case 'submit': return one(c.tx.referenda.submit(
      originArg(a.origin),
      { type: 'Lookup', value: { hash: a.proposal.hash, len: a.proposal.len } },
      'after' in a.enactment ? { type: 'After', value: a.enactment.after } : { type: 'At', value: a.enactment.at },
    ))
  }
}

/** The extrinsic exactly as it will be signed: one action as is, several in utility.batchAll, then the proxy wrapper. */
export async function buildTx(plan: WritePlan): Promise<DynTx> {
  if (!plan.actions.length) throw new Error('nothing to sign')
  const c = await client()
  const calls = plan.actions.map(a => actionCall(c, a))
  const inner = calls.length === 1 && calls[0].tx ? calls[0].tx : c.tx.utility.batchAll(calls.map(x => x.call))
  const wrapped = plan.proxy ? c.tx.proxy.proxy(plan.proxy.real, plan.proxy.proxyType, inner.call) : inner
  const outer = plan.proxy && plan.via ? c.tx.proxy.proxy(plan.via.real, plan.via.proxyType, wrapped.call) : wrapped
  if (!plan.feeInHdx) return outer
  // Paying in HDX is a substrate-signer option only: an EVM signer's permit or
  // transaction is charged by the EVM path, not by this batch's first call.
  if (plan.signer.kind === 'evm') throw new Error('Paying the fee in HDX is not available for an EVM wallet')
  const setHdx = c.tx.multiTransactionPayment.setCurrency(HDX_ASSET_ID).call
  // The runtime's call filter refuses a batch directly inside a batch, so without a
  // proxy wrapper the actions join set_currency in one flat batchAll (TryCallCurrency
  // only needs set_currency to be its first call).
  if (!plan.proxy && calls.length > 1) return c.tx.utility.batchAll([setHdx, ...calls.map(x => x.call)])
  return c.tx.utility.batchAll([setHdx, outer.call])
}

// ---- simulation ------------------------------------------------------------

export interface SimEvent { pallet: string; name: string; data: unknown }

export interface Simulation {
  status: 'ok' | 'failed' | 'unavailable'
  /** Plain-language reason, when it failed. */
  message: string | null
  /** The technical name (Pallet.Error), when known. */
  code: string | null
  events: SimEvent[]
  /** What the chain did, in words: "Voted on #450", "Unlocked 1,200 HDX". */
  outcome: string[]
  /**
   * Whether the call keeps its fee (the dispatch's own PostDispatchInfo): false when
   * the chain refunds it (`Pays::No`) — noting a preimage the chain had requested.
   * The fee is still taken up front, so the signer must hold it. Null when unknown.
   */
  paysFee?: boolean | null
}

const ERROR_WORDS: Record<string, string> = {
  'ConvictionVoting.NotOngoing': 'Voting on this referendum has closed.',
  'ConvictionVoting.NotVoter': 'This account has no vote on that referendum.',
  'ConvictionVoting.NoPermission': 'Only the voter can remove this vote.',
  'ConvictionVoting.NoPermissionYet': 'This vote is still locked; it can be removed once its lock ends.',
  'ConvictionVoting.AlreadyDelegating': 'This account delegates its vote on this track, so its delegate votes for it. Undelegate in another app to vote here directly.',
  'ConvictionVoting.AlreadyVoting': 'This account still has votes on this track.',
  'ConvictionVoting.InsufficientFunds': 'The amount is more than this account holds (free plus reserved HDX).',
  'ConvictionVoting.NotDelegating': 'This account does not delegate on this track.',
  'ConvictionVoting.Nonsense': 'The chain rejected this request as inconsistent.',
  'ConvictionVoting.MaxVotesReached': 'This account already has 25 votes on this track. Remove votes on finished referenda first (Unlock & clean up).',
  'ConvictionVoting.ClassNeeded': 'The track of this vote has to be given.',
  'ConvictionVoting.BadClass': 'That track does not exist.',
  'System.CallFiltered': 'This proxy is not allowed to make one of these calls. A Governance proxy can vote, remove votes and unlock, but not claim GIGAHDX rewards — the account claims them itself (or through an Any proxy).',
  'Staking.MaxVotesReached': 'This account’s staking position already tracks the most votes the staking pallet allows (25, across all tracks). Remove votes on finished referenda first — “Unlock & clean up” frees one slot per removed vote.',
  'Proxy.NotProxy': 'The signing account is not (or no longer) a proxy of the account it acts for.',
  'Proxy.Unproxyable': 'This proxy type is not allowed to make this call.',
  'Proxy.Unannounced': 'This proxy has a delay and has to announce the call first, which is not supported here.',
  'GigaHdxRewards.NoPendingRewards': 'There are no GIGAHDX voting rewards to claim.',
  'GigaHdxRewards.BlockedByExternalLock': 'GIGAHDX rewards cannot be claimed while another lock holds the position.',
  'Balances.LiquidityRestrictions': 'The HDX needed is locked.',
  'Utility.TooManyCalls': 'Too many actions for one signature.',
  'Referenda.NotOngoing': 'This referendum is no longer running.',
  'Referenda.HasDeposit': 'Someone already placed this referendum’s decision deposit.',
  'Referenda.BadReferendum': 'There is no such referendum.',
  'Referenda.NoDeposit': 'There is no deposit left to refund: it was refunded already, or the outcome forfeits it.',
  'Referenda.Unfinished': 'The referendum is still running; its decision deposit is refunded once it has concluded.',
  'Referenda.BadStatus': 'This outcome does not return the submission deposit (a rejected or timed-out referendum keeps it).',
  'Referenda.NoTrack': 'No track accepts a referendum from this origin.',
  'Referenda.Full': 'This track’s queue is full right now.',
  'Referenda.PreimageNotExist': 'The call’s preimage is not stored on chain.',
  'Referenda.PreimageStoredWithDifferentLength': 'A preimage with this hash is stored with a different length.',
  'Preimage.TooBig': 'The call is too large to store as a preimage.',
  'Preimage.AlreadyNoted': 'This preimage is already stored (use its hash).',
  'Preimage.NotAuthorized': 'Only the account that stored this preimage can remove it.',
  'Preimage.NotNoted': 'This preimage is not stored.',
  'Balances.InsufficientBalance': 'Not enough free HDX for the deposit and the fee.',
  'MultiTransactionPayment.EvmPermitInvalid': 'The wallet’s permit signature was not accepted.',
  'MultiTransactionPayment.EvmPermitExpired': 'The permit expired before it was dispatched.',
}

function errorKey(c: DynClient, err: unknown): { code: string | null; message: string } {
  const e = err as { type?: string; value?: unknown }
  if (e?.type === 'Module') {
    const meta = c.registry.findErrorMeta(err)
    if (meta) {
      const code = `${meta.pallet}.${meta.name}`
      return { code, message: ERROR_WORDS[code] ?? (meta.docs?.join(' ').trim() || code) }
    }
    return { code: null, message: 'The chain rejected the call.' }
  }
  if (e?.type === 'BadOrigin') return { code: 'BadOrigin', message: 'This account is not allowed to make this call.' }
  if (e?.type === 'Token') return { code: `Token.${String((e.value as { type?: string })?.type ?? e.value)}`, message: 'Not enough funds for this call.' }
  if (e?.type === 'Arithmetic') return { code: 'Arithmetic', message: 'The amount is out of range.' }
  return { code: e?.type ?? null, message: `The chain rejected the call (${e?.type ?? 'unknown error'}).` }
}

function eventName(e: { pallet: string; palletEvent: string | { name: string; data?: unknown } }): { pallet: string; name: string; data: unknown } {
  const pe = e.palletEvent
  return typeof pe === 'string' ? { pallet: e.pallet, name: pe, data: null } : { pallet: e.pallet, name: pe.name, data: pe.data ?? null }
}

/** Reads inner results the outer Ok hides: a proxy's ProxyExecuted result and a batch's BatchInterrupted. */
export function innerFailure(c: Pick<DynClient, 'registry'>, events: SimEvent[]): { code: string | null; message: string } | null {
  for (const ev of events) {
    if (ev.pallet === 'Proxy' && ev.name === 'ProxyExecuted') {
      const r = (ev.data as { result?: { isErr?: boolean; err?: unknown } })?.result
      if (r?.isErr) return errorKey(c as DynClient, r.err)
    }
    if (ev.pallet === 'Utility' && ev.name === 'BatchInterrupted') {
      const d = ev.data as { index?: number; error?: unknown }
      const inner = errorKey(c as DynClient, d?.error)
      return { code: inner.code, message: `Action ${Number(d?.index ?? 0) + 1}: ${inner.message}` }
    }
  }
  return null
}

/**
 * What a run did, in words, from its events. ConvictionVoting emits VoteRemoved only
 * for a vote on a running referendum (where it changes the tally); removals of votes
 * on finished referenda are counted from the plan. Balances.Locked / Unlocked carry
 * the change of a lock. A GIGAHDX reward claim stakes the reward, which shows as a
 * Balances.Locked of the same amount: it is reported as the claim, not as a new lock.
 */
/** HDX freed and newly locked by a run, with a GIGAHDX claim's restake taken out of "locked". */
export function lockEffects(events: SimEvent[]): { freed: bigint; lockedMore: bigint; claimed: bigint } {
  let locked = 0n, freed = 0n, claimed = 0n
  for (const ev of events) {
    const d = ev.data as Record<string, unknown> | null
    if (ev.pallet === 'Balances' && ev.name === 'Locked') locked += BigInt(String(d?.amount ?? 0))
    else if (ev.pallet === 'Balances' && ev.name === 'Unlocked') freed += BigInt(String(d?.amount ?? 0))
    else if (ev.pallet === 'GigaHdxRewards' && ev.name === 'RewardsClaimed') claimed += BigInt(String(d?.totalHdx ?? 0))
  }
  const lockedMore = locked > claimed ? locked - claimed : 0n
  return { freed, lockedMore, claimed }
}

export function outcomeLines(events: SimEvent[], actions: VoteAction[] = []): string[] {
  const out: string[] = []
  const count = (pallet: string, name: string) => events.filter(e => e.pallet === pallet && e.name === name).length
  const voted = count('ConvictionVoting', 'Voted')
  const removedEvents = count('ConvictionVoting', 'VoteRemoved')
  const removed = Math.max(removedEvents, actions.filter(a => a.kind === 'remove-vote').length)
  const unlocked = count('ConvictionVoting', 'VoteUnlocked')
  const credited = count('GigaHdxRewards', 'UserRewardRecorded')
  if (voted) out.push(`records ${voted} ${voted === 1 ? 'vote' : 'votes'}`)
  if (removed) out.push(`removes ${removed} ${removed === 1 ? 'vote' : 'votes'}`)
  if (credited) out.push(`credits GIGAHDX voting rewards for ${credited} ${credited === 1 ? 'referendum' : 'referenda'}`)
  if (unlocked) out.push(`re-checks the lock of ${unlocked} ${unlocked === 1 ? 'track' : 'tracks'}`)
  const fx = lockEffects(events)
  // Deposits, preimages and referenda, from their own events: one
  // line each while there are a few of a kind, one summing line for a long batch.
  const arg = (e: SimEvent, k: string) => (e.data as Record<string, unknown> | null)?.[k]
  const hdx = (v: unknown) => formatHdx(BigInt(String(v ?? 0)), 2)
  const sumOf = (es: SimEvent[]) => formatHdx(es.reduce((t, e) => t + BigInt(String(arg(e, 'amount') ?? 0)), 0n), 2)
  const of = (pallet: string, name: string) => events.filter(e => e.pallet === pallet && e.name === name)
  const FEW = 3
  const kinds: { pallet: string; name: string; one: (e: SimEvent) => string; many: (es: SimEvent[]) => string }[] = [
    { pallet: 'Referenda', name: 'DecisionDepositPlaced', one: e => `places the decision deposit of ${hdx(arg(e, 'amount'))} HDX on #${arg(e, 'index')}`, many: es => `places ${es.length} decision deposits (${sumOf(es)} HDX)` },
    { pallet: 'Referenda', name: 'DecisionDepositRefunded', one: e => `returns the decision deposit of #${arg(e, 'index')} (${hdx(arg(e, 'amount'))} HDX) to its depositor`, many: es => `returns ${es.length} decision deposits (${sumOf(es)} HDX) to their depositors` },
    { pallet: 'Referenda', name: 'SubmissionDepositRefunded', one: e => `returns the submission deposit of #${arg(e, 'index')} (${hdx(arg(e, 'amount'))} HDX) to its depositor`, many: es => `returns ${es.length} submission deposits (${sumOf(es)} HDX) to their depositors` },
    // A proposal stores its preimage before it submits on it: said in that order.
    { pallet: 'Preimage', name: 'Noted', one: () => 'stores the call’s preimage', many: es => `stores ${es.length} preimages` },
    { pallet: 'Referenda', name: 'Submitted', one: e => `submits referendum #${arg(e, 'index')}`, many: es => `submits ${es.length} referenda` },
    { pallet: 'Preimage', name: 'Cleared', one: () => 'removes the preimage and returns its deposit', many: es => `removes ${es.length} preimages and returns their deposits` },
  ]
  for (const k of kinds) {
    const es = of(k.pallet, k.name)
    if (es.length > FEW) out.push(k.many(es))
    else for (const e of es) out.push(k.one(e))
  }
  // Unnoting a requested preimage returns its deposit without an event of its own.
  const unnotes = actions.filter(a => a.kind === 'unnote-preimage').length - count('Preimage', 'Cleared')
  if (unnotes > 0) out.push(`returns ${unnotes === 1 ? 'a preimage deposit' : `${unnotes} preimage deposits`}`)
  if (fx.claimed > 0n) out.push(`claims ${formatHdx(fx.claimed, 2)} HDX of GIGAHDX voting rewards, staked into GIGAHDX`)
  if (fx.freed > 0n) out.push(`frees ${formatHdx(fx.freed, 2)} HDX`)
  if (fx.lockedMore > 0n) out.push(`locks ${formatHdx(fx.lockedMore, 2)} HDX more`)
  if (!fx.freed && (unlocked || removed) && !fx.lockedMore) out.push('frees no HDX yet (running votes or unexpired locks still need it)')
  if (out.length) out[0] = out[0].charAt(0).toUpperCase() + out[0].slice(1)
  return out
}

export async function simulate(plan: WritePlan, tx?: DynTx): Promise<Simulation> {
  const c = await client()
  const t = tx ?? await buildTx(plan)
  let result: { isOk?: boolean; value?: { executionResult: { isOk: boolean; value?: { paysFee?: unknown }; err?: { error: unknown } }; emittedEvents: { pallet: string; palletEvent: string | { name: string; data?: unknown } }[] } }
  try {
    result = await c.call.dryRunApi.dryRunCall({ type: 'System', value: { type: 'Signed', value: plan.signerId } }, t.call, 5) as typeof result
  } catch (err) {
    return { status: 'unavailable', message: `The simulation could not run: ${err instanceof Error ? err.message : String(err)}`, code: null, events: [], outcome: [] }
  }
  if (!result?.isOk || !result.value) return { status: 'unavailable', message: 'The node could not simulate this call.', code: null, events: [], outcome: [] }
  const events = result.value.emittedEvents.map(eventName)
  const exec = result.value.executionResult
  if (!exec.isOk) {
    const e = errorKey(c, exec.err?.error)
    return { status: 'failed', message: e.message, code: e.code, events, outcome: [] }
  }
  const inner = innerFailure(c, events)
  if (inner) return { status: 'failed', message: inner.message, code: inner.code, events, outcome: [] }
  const pays = exec.value?.paysFee
  const paysFee = pays === 'No' || (pays as { type?: string } | undefined)?.type === 'No' ? false : pays === 'Yes' || (pays as { type?: string } | undefined)?.type === 'Yes' ? true : null
  return { status: 'ok', message: null, code: null, events, outcome: outcomeLines(events, plan.actions), paysFee }
}

// ---- fee and path ----------------------------------------------------------

export type SignPath = 'substrate' | 'evm-permit' | 'evm-dispatch'

export interface FeeQuote {
  path: SignPath
  /** In the fee currency's own units. */
  amount: bigint
  currency: AssetInfo
  /** The same fee in HDX, when converted (≈). */
  hdx: bigint | null
  /** Where the conversion between the fee currency and HDX came from. */
  priceSource: FeePriceSource | 'gas'
  /** The amount is an upper bound or a fallback-priced estimate, not the chain's exact charge. */
  estimate: boolean
  /** Who pays: always the signer (a proxy's real account never pays). */
  payerId: string
  /** What the payer can spend in that currency now. */
  payerSpendable: bigint
  /** EVM paths: the gas limit signed into the permit or transaction. */
  gasLimit: bigint | null
  weight: { refTime: bigint; proofSize: bigint }
}

// hydration-ui's weight → gas rule for the dispatch precompile (25,000 weight per
// gas, 100k–15M), raised to eth_estimateGas when that is higher (the precompile
// also charges for proof size), then 30% headroom.
const EVM_GAS_TO_WEIGHT = 25_000n
export function permitGasLimit(refTime: bigint, estimate: bigint | null): bigint {
  let gas = refTime / EVM_GAS_TO_WEIGHT
  if (gas < 100_000n) gas = 100_000n
  if (gas > 15_000_000n) gas = 15_000_000n
  if (estimate != null && estimate > gas) gas = estimate
  return gas * 13n / 10n
}

/** 75% of the largest normal extrinsic — the headroom a batch keeps so it always fits a block. */
async function weightBudget(): Promise<{ refTime: bigint; proofSize: bigint }> {
  const c = await client()
  const bw = c.consts.system.blockWeights as { perClass: { normal: { maxExtrinsic?: { refTime: bigint; proofSize: bigint } } } }
  const max = bw.perClass.normal.maxExtrinsic ?? { refTime: 0n, proofSize: 0n }
  return { refTime: BigInt(max.refTime) * 3n / 4n, proofSize: BigInt(max.proofSize) * 3n / 4n }
}

export async function quoteFee(plan: WritePlan, tx: DynTx, payer: ActorState): Promise<FeeQuote> {
  const info = await tx.paymentInfo(plan.signerId)
  const weight = { refTime: BigInt(info.weight.refTime), proofSize: BigInt(info.weight.proofSize) }
  if (plan.feeInHdx && plan.signer.kind === 'evm') throw new Error('Paying the fee in HDX is not available for an EVM wallet')
  const feeCurrency = plan.feeInHdx ? HDX_ASSET_ID : payer.feeCurrency
  const currency = await assetInfo(feeCurrency)
  const spendable = async () => feeCurrency === HDX_ASSET_ID
    ? spendableWith(payer.hdx, 0n, (await chainConstants()).existentialDeposit)
    : tokenSpendable(plan.signerId, feeCurrency)
  if (plan.signer.kind !== 'evm') {
    const hdx = BigInt(info.partialFee)
    const price = await feePrice(feeCurrency)
    const amount = price ? hdx * price.num / price.den : hdx
    return {
      path: 'substrate', amount, currency, hdx, priceSource: price?.source ?? 'fallback', estimate: price?.source === 'fallback',
      payerId: plan.signerId, payerSpendable: await spendable(), gasLimit: null, weight,
    }
  }
  // EVM: the cost is gas × gas price in WETH, bounded above by the signed gas limit;
  // the permit path charges its equivalent in the account's fee currency.
  // The dispatch precompile charges gas for proof size too, which no weight-based
  // fallback reproduces (one vote: 130k by weight, ~352k needed): without a real
  // estimate the permit could run out of gas on chain and still charge the fee, so
  // the review is blocked instead (with a retry) — never guessed.
  let estimate: bigint
  try { estimate = await ethEstimateGas({ from: plan.signer.address, to: DISPATCH_PRECOMPILE, data: tx.callHex }) } catch (err) {
    throw new GasEstimateError(err instanceof Error ? err.message : String(err))
  }
  const gasLimit = permitGasLimit(weight.refTime, estimate)
  const gasPrice = await ethGasPrice()
  const wei = gasLimit * (gasPrice + gasPrice / 20n)
  const weth = await feePrice(WETH_ASSET_ID)
  const hdx = weth ? wei * weth.den / weth.num : null
  const path: SignPath = payer.feeCurrency === WETH_ASSET_ID ? 'evm-dispatch' : 'evm-permit'
  const price = await feePrice(payer.feeCurrency)
  const amount = path === 'evm-dispatch' ? wei : (hdx != null && price ? hdx * price.num / price.den : wei)
  return { path, amount, currency, hdx, priceSource: 'gas', estimate: true, payerId: plan.signerId, payerSpendable: await spendable(), gasLimit, weight }
}

export class GasEstimateError extends Error {
  constructor(detail: string) {
    super(`The node could not estimate the gas for this EVM dispatch (${detail}). Without it the permit could run out of gas on chain and still be charged, so signing waits — check again in a moment.`)
    this.name = 'GasEstimateError'
  }
}

// ---- the whole review -------------------------------------------------------

export interface Review {
  plan: WritePlan
  callHex: string
  simulation: Simulation
  fee: FeeQuote | null
  /** Plain-language reasons Sign stays disabled. Empty means it may be signed. */
  blockers: string[]
  /**
   * Set when the signer cannot pay the fee in its fee currency: what it needs and
   * holds unlocked there, and whether paying in HDX instead (`feeInHdx`) would work —
   * a substrate signer with enough unlocked HDX.
   */
  feeShortfall: { symbol: string; decimals: number; isHdx: boolean; needs: bigint; has: bigint; hdxWouldWork: boolean } | null
  /** Facts worth stating before signing ("Signed by D · pays the fee"). */
  notes: string[]
  /** The actor's state the review was judged against. */
  actor: ActorState
}

/**
 * Build, quote and dry-run a plan. Blocks what would obviously fail: a failed
 * simulation, a fee the signer cannot pay, a vote that would leave no room for its
 * own fee, a proxy that no longer exists, a batch too heavy for one block.
 */
export async function review(plan: WritePlan): Promise<Review> {
  const actorId = plan.proxy?.real ?? plan.signerId
  const tx = await buildTx(plan)
  const [simulation, signerState, actor, budget, consts] = await Promise.all([
    simulate(plan, tx),
    readActor(plan.signerId),
    actorId === plan.signerId ? Promise.resolve(null) : readActor(actorId),
    weightBudget(),
    chainConstants(),
  ])
  const actorState = actor ?? signerState
  const blockers: string[] = []
  const notes: string[] = []
  let feeShortfall: Review['feeShortfall'] = null
  let fee: FeeQuote | null = null
  try { fee = await quoteFee(plan, tx, signerState) } catch (err) {
    blockers.push(err instanceof GasEstimateError ? err.message : `The fee could not be estimated: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (simulation.status === 'failed') blockers.push(simulation.message ?? 'The simulation failed.')
  // Without a dry-run nothing says whether it would work — a proxy's or a batch's
  // inner failure in particular only shows there — so it is not signed blind.
  if (simulation.status === 'unavailable') blockers.push(`The chain could not check this transaction (${simulation.message ?? 'no simulation'}). Nothing is signed unchecked — try again in a moment.`)
  if (fee) {
    if (fee.weight.refTime > budget.refTime || fee.weight.proofSize > budget.proofSize) {
      blockers.push('This is too much for one signature (it would not fit in a block). Sign fewer votes at once.')
    }
    // An estimate (gas upper bound, or a fallback price) gets wider headroom than the chain's own conversion.
    const headroom = fee.estimate ? fee.amount + fee.amount / 2n : fee.amount + fee.amount / 10n
    if (fee.path !== 'evm-dispatch' && fee.payerSpendable < headroom) {
      blockers.push(`The signing account cannot pay the fee: it needs about ${formatUnits(fee.amount, fee.currency.decimals, 4)} ${fee.currency.symbol} that is not locked, and has ${formatUnits(fee.payerSpendable, fee.currency.decimals, 4)}.`)
      const hdxFree = spendableWith(signerState.hdx, 0n, consts.existentialDeposit)
      const hdxFee = fee.hdx ?? null
      feeShortfall = {
        symbol: fee.currency.symbol, decimals: fee.currency.decimals, isHdx: fee.currency.id === HDX_ASSET_ID,
        needs: fee.amount, has: fee.payerSpendable,
        hdxWouldWork: fee.currency.id !== HDX_ASSET_ID && plan.signer.kind !== 'evm' && hdxFee != null && hdxFree >= hdxFee + hdxFee / 2n,
      }
    }
    // The fee leaves before the vote is checked against the balance: a vote at the
    // very top of the balance fails when the same account pays the fee in HDX.
    if (fee.currency.id === HDX_ASSET_ID && !plan.proxy && fee.hdx != null) {
      const total = totalBalance(actorState.hdx)
      const biggest = plan.actions.reduce((m, a) => (a.kind === 'vote' && voteCapital(a.vote) > m ? voteCapital(a.vote) : m), 0n)
      if (biggest > 0n && biggest + fee.hdx > total) {
        blockers.push(`The fee (≈ ${formatHdx(fee.hdx, 4)} HDX) is paid from the same HDX before the vote is counted, so the vote can be at most ${formatHdx(total - fee.hdx - fee.hdx / 10n, 4)} HDX. Lower the amount a little (or use "Almost full").`)
      }
    }
  }
  if (plan.proxy) {
    // The call was built with these proxy types; they are checked, never rewritten, so
    // the reviewed call is the one that gets signed. With a second hop the signer is
    // the Any proxy of `via`, which is the proxy of the voting account.
    const hops: { real: string; delegate: string; proxyType: string }[] = plan.via
      ? [{ real: plan.via.real, delegate: plan.signerId, proxyType: plan.via.proxyType }, { real: plan.proxy.real, delegate: plan.via.real, proxyType: plan.proxy.proxyType }]
      : [{ real: plan.proxy.real, delegate: plan.signerId, proxyType: plan.proxy.proxyType }]
    for (const h of hops) {
      const entries = await readProxyEntry(h.real, h.delegate)
      if (!entries.find(e => e.proxyType === h.proxyType && e.delay === 0)) {
        blockers.push(entries.length
          ? `${h.delegate === plan.signerId ? 'The signing account' : 'The account in between'} is no longer a ${h.proxyType} proxy without delay of ${h.real === actorId ? 'this account' : 'the next account in the chain'}. Close the sheet and pick the account again.`
          : `${h.delegate === plan.signerId ? 'The signing account' : 'The account in between'} is no longer a proxy of ${h.real === actorId ? 'this account' : 'the next account in the chain'}.`)
      }
    }
  }
  return { plan, callHex: tx.callHex, simulation, fee, blockers, feeShortfall, notes, actor: actorState }
}

// ---- signing and tracking ---------------------------------------------------

export type TxStage =
  /** The review is redone right before the wallet opens (it was more than a few seconds old). */
  | { phase: 'checking' }
  | { phase: 'wallet' }
  | { phase: 'submitted'; txHash: string | null }
  | { phase: 'in-block'; blockNumber: number; txIndex: number | null; txHash: string | null }
  | { phase: 'finalized'; blockNumber: number; txIndex: number | null; txHash: string | null; outcome: string[]; events?: SimEvent[] }
  /** Included and judged successful, but finality was not seen in time: not called final. */
  | { phase: 'unconfirmed'; blockNumber: number; txIndex: number | null; txHash: string | null; outcome: string[]; events?: SimEvent[] }
  /** `declined`: the wallet refused to sign — nothing was sent, so trying again is safe. */
  | { phase: 'failed'; message: string; blockNumber?: number; txIndex?: number | null; declined?: boolean }

// Only the wallet's own refusal reads as "you cancelled": EIP-1193 code 4001, or the
// refusal a substrate extension throws from its signer ("Cancelled", "Rejected by
// user"…), and only for an error that came out of the signing step itself. A node or
// pallet rejecting the transaction is reported as that, in its own words.
const USER_REFUSAL = /^(cancel+ed|rejected)\b|user (rejected|denied|cancel+ed)|rejected by (the )?user|denied by (the )?user|request (was )?rejected/i
export function isUserRefusal(err: unknown): boolean {
  if ((err as { code?: number })?.code === 4001) return true
  const msg = err instanceof Error ? err.message : String(err)
  return USER_REFUSAL.test(msg.trim())
}

function describeFailure(err: unknown, fromWallet: boolean): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (fromWallet && isUserRefusal(err)) return 'You cancelled the request in your wallet. Nothing was sent.'
  if (fromWallet) return `The wallet could not sign: ${msg}`
  return /^the chain|^the node/i.test(msg) ? msg : `The node rejected the transaction: ${msg}`
}

/** Judge an included extrinsic from its own events, inner results first. */
export function judgeEvents(c: Pick<DynClient, 'registry'>, raw: SubmitResult['events'], path: SignPath, dispatchError?: unknown, actions: VoteAction[] = []): { ok: boolean; message: string | null; outcome: string[]; events?: SimEvent[] } {
  const events = raw.map(r => eventName(r.event as { pallet: string; palletEvent: string | { name: string; data?: unknown } }))
  if (dispatchError) return { ok: false, ...errorKey(c as DynClient, dispatchError), outcome: [] }
  const failed = events.find(e => e.pallet === 'System' && e.name === 'ExtrinsicFailed')
  if (failed) return { ok: false, ...errorKey(c as DynClient, (failed.data as { dispatchError?: unknown })?.dispatchError), outcome: [] }
  const inner = innerFailure(c, events)
  if (inner) return { ok: false, message: inner.message, outcome: [] }
  if (path === 'evm-permit') {
    const evmFailed = events.some(e => e.pallet === 'EVM' && e.name === 'ExecutedFailed')
    const ran = events.some(e => e.pallet === 'EVM' && e.name === 'Executed')
    if (evmFailed) return { ok: false, message: 'The permit ran, but the dispatched call failed.', outcome: [] }
    if (!ran) return { ok: false, message: 'The chain accepted the permit but ran nothing — it was no longer valid. Nothing was charged.', outcome: [] }
  }
  return { ok: true, message: null, outcome: outcomeLines(events, actions), events }
}

/**
 * Sign and submit a reviewed plan with the account's wallet and report each stage.
 * Resolves once the outcome is known (failed, or finalized).
 */
export async function signAndTrack(rv: Review, onStage: (s: TxStage) => void): Promise<TxStage> {
  const signer = signerFor(rv.plan.signer)
  if (!signer) {
    const s: TxStage = { phase: 'failed', message: `${rv.plan.signer.walletName} is not connected in this tab. Reconnect it and try again.` }
    onStage(s)
    return s
  }
  const c = await client()
  const tx = await buildTx(rv.plan)
  if (tx.callHex !== rv.callHex) {
    const s: TxStage = { phase: 'failed', message: 'The transaction changed since it was reviewed. Review it again.' }
    onStage(s)
    return s
  }
  const path: SignPath = rv.fee?.path ?? (rv.plan.signer.kind === 'evm' ? 'evm-permit' : 'substrate')
  onStage({ phase: 'wallet' })
  if (path === 'evm-dispatch' && signer.kind === 'evm') return dispatchViaEvm(rv, tx, signer.provider, onStage)
  return new Promise<TxStage>(resolve => {
    let last: TxStage = { phase: 'wallet' }
    let settled = false
    let unsub: (() => void) | null = null
    const emit = (s: TxStage) => { last = s; onStage(s) }
    const settle = (s: TxStage) => {
      if (settled) return
      settled = true
      emit(s)
      try { unsub?.() } catch { /* ignore */ }
      resolve(s)
    }
    const onResult = (r: SubmitResult & { status: { type: string; value?: { blockNumber?: number; txIndex?: number; error?: string } } }) => {
      if (settled) return
      const st = r.status
      if (st.type === 'Validated' || st.type === 'Broadcasting') { if (last.phase === 'wallet') emit({ phase: 'submitted', txHash: r.txHash ?? null }); return }
      if (st.type === 'BestChainBlockIncluded' || st.type === 'Finalized') {
        const blockNumber = Number(st.value?.blockNumber ?? 0)
        const txIndex = st.value?.txIndex ?? null
        const verdict = judgeEvents(c, r.events, path, r.dispatchError, rv.plan.actions)
        if (!verdict.ok) { settle({ phase: 'failed', message: verdict.message ?? 'The transaction failed on chain.', blockNumber, txIndex }); return }
        if (st.type === 'Finalized') settle({ phase: 'finalized', blockNumber, txIndex, txHash: r.txHash ?? null, outcome: verdict.outcome, events: verdict.events })
        else emit({ phase: 'in-block', blockNumber, txIndex, txHash: r.txHash ?? null })
        return
      }
      if (st.type === 'Invalid' || st.type === 'Drop') settle({ phase: 'failed', message: st.value?.error ? `The node rejected the transaction: ${st.value.error}` : 'The node dropped the transaction; nothing was charged.' })
    }
    // Errors thrown inside the wallet's own signing step are told apart from the
    // node's: only those can be the user's refusal.
    let walletError: unknown = null
    const start = async () => {
      if (signer.kind === 'substrate') {
        const inner = signer.signer as { signPayload?: (p: unknown) => Promise<unknown>; signRaw?: (p: unknown) => Promise<unknown> }
        const wrapped = {
          ...inner,
          signPayload: async (payload: unknown) => {
            try { return await inner.signPayload!.call(inner, payload) } catch (err) { walletError = err; throw err }
          },
        }
        // CheckMetadataHash stays in mode 0, as the Hydration app signs: every
        // extension understands it, and dedot lets a wallet that needs the hash (a
        // Ledger account in Talisman or SubWallet) return its own signed transaction.
        unsub = await tx.signAndSend(walletAddressOf(rv.plan.signer), { signer: wrapped, tip: 0n }, onResult)
        return
      }
      let args: readonly unknown[]
      try { args = await signPermit(rv, tx, signer.provider) } catch (err) { walletError = err; throw err }
      emit({ phase: 'submitted', txHash: null })
      const u = await withSubmitTimeout(submitPermitUnsigned(args, onResult as (r: SubmitResult) => void), PERMIT_SUBMIT_TIMEOUT_MS)
      unsub = typeof u === 'function' ? u as () => void : null
    }
    start().catch(err => settle({ phase: 'failed', message: describeFailure(err, err === walletError), declined: err === walletError && isUserRefusal(err) }))
  })
}

const PERMIT_SUBMIT_TIMEOUT_MS = 30_000

async function signPermit(rv: Review, tx: DynTx, provider: { request(a: { method: string; params?: unknown[] }): Promise<unknown> }): Promise<readonly unknown[]> {
  const from = rv.plan.signer.address
  // Typed data names chain 222222; a wallet on another network refuses to sign it.
  await ensureHydrationChain(provider, window.location.origin)
  const [nonceRaw, timestamp] = await Promise.all([ethCall(permitNonceCall(from).to, permitNonceCall(from).data), ethBlockTimestamp()])
  const fields: PermitFields = {
    chainId: HYDRATION_CHAIN_ID,
    from,
    to: DISPATCH_PRECOMPILE,
    valueWei: 0n,
    data: tx.callHex,
    gasLimit: rv.fee?.gasLimit ?? permitGasLimit(rv.fee?.weight.refTime ?? 0n, null),
    nonce: parsePermitNonce(nonceRaw),
    deadline: timestamp + PERMIT_DEADLINE_SECONDS,
  }
  const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [from, permitTypedData(fields)] }) as string
  return buildDispatchPermitArgs(fields, splitSignature(signature))
}

async function dispatchViaEvm(rv: Review, tx: DynTx, provider: { request(a: { method: string; params?: unknown[] }): Promise<unknown> }, onStage: (s: TxStage) => void): Promise<TxStage> {
  const fail = (message: string, blockNumber?: number, txIndex?: number | null): TxStage => { const s: TxStage = { phase: 'failed', message, blockNumber, txIndex }; onStage(s); return s }
  let hash: string
  try {
    await ensureHydrationChain(provider, window.location.origin)
    hash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: rv.plan.signer.address, to: DISPATCH_PRECOMPILE, data: tx.callHex, gas: `0x${(rv.fee?.gasLimit ?? 300_000n).toString(16)}`, value: '0x0' }],
    }) as string
  } catch (err) {
    const s: TxStage = { phase: 'failed', message: describeFailure(err, true), declined: isUserRefusal(err) }
    onStage(s)
    return s
  }
  onStage({ phase: 'submitted', txHash: hash })
  const deadline = Date.now() + 120_000
  let receipt: { status: string; blockNumber: string; blockHash: string } | null = null
  while (Date.now() < deadline) {
    receipt = await evmReceipt(hash).catch(() => null)
    if (receipt) break
    await new Promise(r => setTimeout(r, 2_000))
  }
  if (!receipt) return fail('The transaction was sent but not seen in a block within two minutes. Check your wallet’s activity before trying again.')
  const blockNumber = Number(BigInt(receipt.blockNumber))
  const c = await client()
  // Judge what actually happened from the block's own events for this transaction:
  // the precompile reverts when the dispatched call fails, but a proxied call's inner
  // failure only shows in its ProxyExecuted event.
  const own = await extrinsicEventsOfEthTx(c, blockNumber, hash).catch(() => null)
  if (receipt.status !== '0x1') return fail('The transaction was included but the dispatched call failed (the precompile reverted).', blockNumber, own?.index ?? null)
  // Without the block's events (a node that no longer has the block) the receipt is all
  // there is: success is reported without an outcome rather than with the dry-run's.
  const verdict = own ? judgeEvents(c, own.events, 'evm-dispatch', undefined, rv.plan.actions) : { ok: true, message: null, outcome: [] as string[] }
  if (!verdict.ok) return fail(verdict.message ?? 'The dispatched call failed.', blockNumber, own?.index ?? null)
  onStage({ phase: 'in-block', blockNumber, txIndex: own?.index ?? null, txHash: hash })
  const finalDeadline = Date.now() + 180_000
  while (Date.now() < finalDeadline) {
    const fin = await c.rpc.chain_getFinalizedHead() as string
    const head = await c.rpc.chain_getHeader(fin) as { number: number }
    if (Number(head.number) >= blockNumber) {
      const s: TxStage = { phase: 'finalized', blockNumber, txIndex: own?.index ?? null, txHash: hash, outcome: verdict.outcome, events: verdict.events }
      onStage(s)
      return s
    }
    await new Promise(r => setTimeout(r, 3_000))
  }
  const s: TxStage = { phase: 'unconfirmed', blockNumber, txIndex: own?.index ?? null, txHash: hash, outcome: verdict.outcome, events: verdict.events }
  onStage(s)
  return s
}

/**
 * The events of the extrinsic that carried an Ethereum transaction, found by its hash
 * in Ethereum.Executed. Read as System.Events at the substrate block of that height
 * (an Ethereum receipt's blockHash is the Ethereum block's, not the substrate one).
 */
async function extrinsicEventsOfEthTx(c: DynClient, blockNumber: number, ethHash: string): Promise<{ index: number; events: SubmitResult['events'] } | null> {
  type Rec = { phase: { type: string; value?: number }; event: { pallet: string; palletEvent: string | { name: string; data?: { transactionHash?: string } } } }
  const q = c.query.system.events as unknown as { rawKey(): string; meta: { storageType: { value: { valueTypeId: number } } } }
  const hash = await c.rpc.chain_getBlockHash(blockNumber) as string
  const raw = await c.rpc.state_getStorage(q.rawKey(), hash) as string | null
  if (!raw) return null
  const records = c.registry.findCodec(q.meta.storageType.value.valueTypeId).tryDecode(raw) as Rec[]
  const hit = records.find(r => r.event.pallet === 'Ethereum' && typeof r.event.palletEvent !== 'string' && r.event.palletEvent.name === 'Executed'
    && String(r.event.palletEvent.data?.transactionHash ?? '').toLowerCase() === ethHash.toLowerCase())
  if (!hit || hit.phase.type !== 'ApplyExtrinsic') return null
  const index = Number(hit.phase.value)
  return { index, events: records.filter(r => r.phase.type === 'ApplyExtrinsic' && Number(r.phase.value) === index) as unknown as SubmitResult['events'] }
}

async function evmReceipt(hash: string): Promise<{ status: string; blockNumber: string; blockHash: string } | null> {
  const res = await fetch(EVM_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }) })
  const json = await res.json() as { result?: { status: string; blockNumber: string; blockHash: string } | null }
  return json.result ?? null
}

/** Decode a SCALE call (hex) into its pallet.method tree, for display and tests. */
export async function decodeCall(callHex: string): Promise<unknown> {
  const c = await client()
  return c.registry.findCodec(c.metadata.latest.extrinsic.callTypeId).tryDecode(callHex)
}

/** The fee of a plan in HDX (≈ for EVM paths), for presets that must leave room for it. */
export async function estimateFeeHdx(plan: WritePlan): Promise<bigint | null> {
  const tx = await buildTx(plan)
  const payer = await readActor(plan.signerId)
  const q = await quoteFee(plan, tx, payer)
  return q.hdx
}

/**
 * A dry-run's error in words and its Pallet.Error code, the review's own reading — for
 * callers that dry-run a call themselves (the proposal wizard checks a call against a
 * track's origin), so every dry-run is described one way.
 */
export function describeDryRun(c: Pick<DynClient, 'registry'>, result: { executionResult: { isOk: boolean; err?: { error: unknown } }; emittedEvents: { pallet: string; palletEvent: string | { name: string; data?: unknown } }[] }): { ok: boolean; code: string | null; message: string | null; events: SimEvent[] } {
  const events = result.emittedEvents.map(eventName)
  if (!result.executionResult.isOk) return { ok: false, ...errorKey(c as DynClient, result.executionResult.err?.error), events }
  const inner = innerFailure(c, events)
  return inner ? { ok: false, ...inner, events } : { ok: true, code: null, message: null, events }
}
