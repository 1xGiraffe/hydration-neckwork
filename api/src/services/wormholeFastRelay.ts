// The Wormhole Relay's fast path: delivery first, settlement after.
//
// A user on the origin chain calls the relay's contract there (0xa72e…9944 on Ethereum),
// and that ONE transaction publishes two Wormhole messages:
//   1. a fast message from the relay contract itself, naming the token, the amount to
//      deliver, the Hydration recipient and the NTT message id of (2);
//   2. an ordinary NTT transfer of the gross amount, whose NTT `sender` is that same
//      relay contract and whose Hydration recipient is the relay's liquidity pool.
// The relayer (the Wormhole Relay tag's 0xf1db…3547) submits (1) as soon as it is
// signed, and the pool pays the recipient out of inventory: a Tokens transfer from the
// pool, logged by the pool as `Filled`. (2) mints the gross amount — what it paid plus
// its fee — into the pool when it redeems. That is usually minutes after the delivery,
// but nothing orders the two: a settlement can land BEFORE the delivery it settles
// (14,669,987-e133 settles 14,899,122-e5).
//
// So on Hydration the user's arrival is a TRANSFER out of the pool, and the NTT mint
// into the pool is its settlement. Both halves carry the same NTT message id, which
// is what ties them — verified on the 2026-09-24 transfer (Ethereum tx 0xb512…9833
// published fast message seq 7 and NTT seq 154; delivery at 14,980,518, settlement at
// 14,980,973, both naming NTT id 152).
//
// Before the direct route, the same pool paid out on XCM Transacts relayed through
// Moonbeam (asset 44, 2026-03 → 2026-07). Those fills log the same `Filled` event but
// arrive in the block's Initialization phase with no calldata here, so their origin
// chain and sender are not in our data and stay unresolved.

import { bytesToHex, hexToBytes, parseNttTransceiverMessage } from './wormholeNtt.ts'
import { assetIdFromPrecompile } from './chainPrimitives.ts'

// Filled(address indexed originToken, address indexed localToken, bytes32 indexed
// recipient, uint256 amount) — the pool's own statement of one delivery. The local
// token is Hydration's ERC-20 precompile for the asset, the recipient a full account id.
export const FAST_RELAY_FILLED_TOPIC = '0x975e82bfde4922e2ce69ecae9a999f21616c5511424de460faee50bfaea5da02'

// receiveMessage(bytes encodedVaa) — the entry point both the relay's receiver and the
// NTT transceiver expose, and the only calldata shape decoded here. A delivery submitted
// through any other wrapper keeps an unpaired row rather than a guessed one.
const RECEIVE_MESSAGE_SELECTOR = 'f953cec7'

export interface FastRelayFilled { originToken: string; assetId: number; recipient: string; amount: string }

export function decodeFastRelayFilled(topics: readonly string[], data: string): FastRelayFilled | null {
  if (topics[0]?.toLowerCase() !== FAST_RELAY_FILLED_TOPIC || topics.length < 4) return null
  const assetId = assetIdFromPrecompile(topics[2] ?? '')
  const recipient = (topics[3] ?? '').toLowerCase()
  if (assetId == null || !/^0x[0-9a-f]{64}$/.test(recipient)) return null
  const body = (data ?? '').replace(/^0x/, '')
  if (body.length < 64 || /[^0-9a-fA-F]/.test(body)) return null
  return {
    originToken: '0x' + (topics[1] ?? '').toLowerCase().replace(/^0x/, '').slice(-40),
    assetId, recipient, amount: BigInt('0x' + body.slice(0, 64)).toString(),
  }
}

export interface ParsedVaa { emitterChain: number; emitterAddress: string; sequence: string; payload: string }

// A signed VAA: version, guardian-set index, the signatures, then the body the guardians
// signed. Only the body is read — the chain already verified the signatures when the
// call succeeded, and this runs over successful extrinsics only.
export function parseVaa(vaa: Uint8Array): ParsedVaa | null {
  if (vaa.length < 6 || vaa[0] !== 1) return null
  const body = 6 + vaa[5] * 66
  if (vaa.length < body + 51) return null
  let sequence = 0n
  for (let i = 0; i < 8; i++) sequence = (sequence << 8n) | BigInt(vaa[body + 42 + i])
  return {
    emitterChain: (vaa[body + 8] << 8) | vaa[body + 9],
    emitterAddress: bytesToHex(vaa.subarray(body + 10, body + 42)),
    sequence: sequence.toString(),
    payload: bytesToHex(vaa.subarray(body + 51)),
  }
}

// The VAA inside a `receiveMessage(bytes)` call's input.
export function vaaFromReceiveMessageInput(input: string): ParsedVaa | null {
  const b = hexToBytes(input)
  if (b.length < 4 + 64 || bytesToHex(b.subarray(0, 4)).slice(2) !== RECEIVE_MESSAGE_SELECTOR) return null
  const args = b.subarray(4)
  const word = (at: number): number | null => {
    if (at + 32 > args.length) return null
    for (let i = 0; i < 24; i++) if (args[at + i] !== 0) return null
    let n = 0
    for (let i = 24; i < 32; i++) n = n * 256 + args[at + i]
    return n
  }
  const offset = word(0)
  if (offset == null) return null
  const length = word(offset)
  if (length == null || offset + 32 + length > args.length) return null
  return parseVaa(args.subarray(offset + 32, offset + 32 + length))
}

export interface FastRelayMessage { token: string; amount: string; recipient: string; nttMessageId: string }

// The fast message's payload, ABI-encoded as one tuple with a trailing dynamic `bytes`:
// (offset 0x20) token, amount, recipient bytes32, NTT message id, offset of extra data.
export function decodeFastRelayMessage(payload: string): FastRelayMessage | null {
  const body = payload.replace(/^0x/, '').toLowerCase()
  if (body.length < 64 * 6 || /[^0-9a-f]/.test(body)) return null
  const word = (i: number) => body.slice(i * 64, (i + 1) * 64)
  if (BigInt('0x' + word(0)) !== 32n) return null
  const token = word(1)
  if (!/^0{24}/.test(token)) return null
  return {
    token: '0x' + token.slice(24),
    amount: BigInt('0x' + word(2)).toString(),
    recipient: '0x' + word(3),
    nttMessageId: BigInt('0x' + word(4)).toString(),
  }
}

// What pairs a delivery with its settlement: the origin chain, the relay contract on it
// (the fast message's emitter IS the NTT transfer's sender), and the NTT message id the
// fast message names. Chain and contract are part of the key because NTT ids are only
// unique per sending manager.
export function fastRelayPairKey(chain: number, relayContract: string, nttMessageId: string): string {
  return `${chain}:${relayContract.replace(/^0x/, '').toLowerCase().padStart(64, '0')}:${BigInt(nttMessageId).toString()}`
}

export interface FastRelayDelivery { pairKey: string; vaaId: string; recipient: string; amount: string }

// The delivery side of a `receiveMessage` call.
export function fastRelayDeliveryFromInput(input: string): FastRelayDelivery | null {
  const vaa = vaaFromReceiveMessageInput(input)
  if (!vaa) return null
  const msg = decodeFastRelayMessage(vaa.payload)
  if (!msg) return null
  return {
    pairKey: fastRelayPairKey(vaa.emitterChain, vaa.emitterAddress, msg.nttMessageId),
    vaaId: `${vaa.emitterChain}/${vaa.emitterAddress.replace(/^0x/, '')}/${vaa.sequence}`,
    recipient: msg.recipient, amount: msg.amount,
  }
}

// The settlement side: an NTT redeem whose NTT sender is a relay contract. Every NTT
// redeem decodes to a key; only one a delivery also names is a settlement.
export function fastRelaySettlementKeyFromInput(input: string): string | null {
  const vaa = vaaFromReceiveMessageInput(input)
  if (!vaa) return null
  const ntt = parseNttTransceiverMessage(vaa.payload)
  if (!ntt) return null
  return fastRelayPairKey(vaa.emitterChain, ntt.sender, BigInt(ntt.messageId).toString())
}

// ---------------------------------------------------------------------------------
// The index: every delivery leg and every settlement, and the one membership rule.
//
// A delivery is an ordinary transfer OUT of the relay's pool contract, so it reaches
// the feed looking like a transfer; what makes it a cross-chain arrival is the pool's
// `Filled` log in the same block. Membership is one predicate shared by both sides —
// a transfer from a pool, in a block where that pool logged a fill — so a leg is
// always exactly one of the two families: fastRelayLegExclusionSql/isFastRelayLeg
// remove it from every transfer read, and the explorer renders it as a delivery.
// The pool's own non-fill transfers (operator withdrawals) sit in blocks with no fill,
// so they stay transfers.

// One `Filled` block of one pool (the pool as a lowercase account id).
export interface FastRelayFill { block: number; pool: string }
// A transfer out of a pool in one of its fill blocks, with the identity it had as a
// transfer. Accounts lowercase.
export interface FastRelayLeg { block_height: number; ts: string; event_index: number; extrinsic_index: number | null; from_acc: string; to_acc: string; amount: string; asset_id: number }
// A candidate settlement: a `Currencies.Deposited` into a pool inside an extrinsic.
export interface FastRelayDeposit { block_height: number; ts: string; event_index: number; extrinsic_index: number; asset_id: number; amount: string }
export interface FastRelaySettlement { blockHeight: number; eventIndex: number; ts: string; amount: string; assetId: number; journeyId: string | null }
export interface FastRelayRows { fills: FastRelayFill[]; legs: FastRelayLeg[]; deposits: FastRelayDeposit[] }

export interface FastRelayIndex {
  // (block, pool account id) of every fill — the exclusion and membership predicate.
  pairs: FastRelayFill[]
  // The same set as `block:pool` keys, and as each pool's fill blocks (ascending).
  fillKeys: Set<string>
  fillBlocksByPool: Map<string, number[]>
  // The delivery transfer legs, one per transfer identity, newest first.
  legs: FastRelayLeg[]
  // Leg `block:event` → the fast message its extrinsic submitted (direct route only).
  deliveryOf: Map<string, FastRelayDelivery>
  // Pair key → the NTT mint that settled it, and the reverse lookups.
  settlementOf: Map<string, FastRelaySettlement>
  deliveryLegOf: Map<string, FastRelayLeg>
  settlementKeyOf: Map<string, string>
}

// The `block:extrinsic` keys whose EVM call input the index decodes.
export function fastRelayInputKeys(rows: FastRelayRows): string[] {
  return [
    ...rows.legs.filter(l => l.extrinsic_index != null).map(l => `${l.block_height}:${l.extrinsic_index}`),
    ...rows.deposits.map(d => `${d.block_height}:${d.extrinsic_index}`),
  ]
}

// Pure: the index over a set of rows and the call inputs of their extrinsics. A leg is
// paired only when the fast message its extrinsic submitted names exactly its
// recipient and amount; a deposit is a settlement only when its NTT redeem's pair key
// is one a paired delivery carries — so each side's absence leaves the other unpaired
// rather than guessed.
export function buildFastRelayIndex(rows: FastRelayRows, inputs: Map<string, string>): FastRelayIndex {
  const pairMap = new Map<string, FastRelayFill>()
  for (const f of rows.fills) pairMap.set(`${f.block}:${f.pool}`, f)
  const pairs = [...pairMap.values()]
  const fillBlocksByPool = new Map<string, number[]>()
  for (const p of pairs) {
    const blocks = fillBlocksByPool.get(p.pool)
    if (blocks) blocks.push(p.block)
    else fillBlocksByPool.set(p.pool, [p.block])
  }
  for (const blocks of fillBlocksByPool.values()) blocks.sort((a, b) => a - b)
  const legs = [...rows.legs].sort((a, b) => b.block_height - a.block_height || b.event_index - a.event_index)
  const deliveryOf = new Map<string, FastRelayDelivery>()
  const deliveryLegOf = new Map<string, FastRelayLeg>()
  for (const leg of legs) {
    const input = leg.extrinsic_index != null ? inputs.get(`${leg.block_height}:${leg.extrinsic_index}`) : undefined
    const delivery = input ? fastRelayDeliveryFromInput(input) : null
    if (!delivery || delivery.recipient !== leg.to_acc || delivery.amount !== String(leg.amount)) continue
    deliveryOf.set(`${leg.block_height}:${leg.event_index}`, delivery)
    deliveryLegOf.set(delivery.pairKey, leg)
  }
  const settlementOf = new Map<string, FastRelaySettlement>()
  const settlementKeyOf = new Map<string, string>()
  for (const d of rows.deposits) {
    const input = inputs.get(`${d.block_height}:${d.extrinsic_index}`)
    const key = input ? fastRelaySettlementKeyFromInput(input) : null
    if (!key || !deliveryLegOf.has(key)) continue
    const vaa = vaaFromReceiveMessageInput(input!)
    settlementOf.set(key, {
      blockHeight: Number(d.block_height), eventIndex: Number(d.event_index), ts: d.ts, amount: String(d.amount), assetId: Number(d.asset_id),
      journeyId: vaa ? `${vaa.emitterChain}/${vaa.emitterAddress.replace(/^0x/, '')}/${vaa.sequence}` : null,
    })
    settlementKeyOf.set(`${d.block_height}:${d.event_index}`, key)
  }
  return { pairs, fillKeys: new Set(pairMap.keys()), fillBlocksByPool, legs, deliveryOf, settlementOf, deliveryLegOf, settlementKeyOf }
}

export const EMPTY_FAST_RELAY_INDEX: FastRelayIndex = buildFastRelayIndex({ fills: [], legs: [], deposits: [] }, new Map())

// The transfer family's half of the membership rule, for every transfer read — the way
// nttMinterLegExclusionSql is shared, so the rows a page renders and the rows its total
// counts can never be a different set. One `from IN (pool) AND block IN (its fill
// blocks)` group per pool, so the predicate is exactly the (block, pool) set even with
// several pools. `fromExpr` is compared as given: the read models' `from_account` is
// lowercase throughout history (verified on every row of transfer_activity,
// transfer_activity_by_time and account_transfer_activity), and wrapping the column in
// lower() cost ~8x the scan CPU; a raw-events caller passes its own lower(…).
export function fastRelayLegExclusionSql(index: FastRelayIndex, blockExpr = 'block_height', fromExpr = 'from_account'): string {
  if (!index.fillBlocksByPool.size) return ''
  const groups = [...index.fillBlocksByPool].map(([pool, blocks]) =>
    `(${fromExpr} IN ('${pool}') AND toUInt32(${blockExpr}) IN (${blocks.join(',')}))`)
  return `AND NOT (${groups.join(' OR ')})`
}

// The same rule for a transfer already in hand.
export function isFastRelayLeg(index: FastRelayIndex, blockHeight: number, fromAccount: string | null | undefined): boolean {
  if (!fromAccount || !index.fillKeys.size) return false
  return index.fillKeys.has(`${blockHeight}:${fromAccount.toLowerCase()}`)
}

// The relay's fee on one delivery: what the settlement minted into the pool less what
// the pool paid out. Null unless both are in the same asset and the mint is larger.
export function fastRelayFeeRaw(leg: FastRelayLeg, settlement: FastRelaySettlement | undefined): string | null {
  if (!settlement || settlement.assetId !== leg.asset_id) return null
  const fee = BigInt(settlement.amount) - BigInt(leg.amount)
  return fee > 0n ? fee.toString() : null
}

// Where the index's rows come from. Each read covers blocks strictly above `after`
// (all of history when null).
export interface FastRelayRowSource {
  fills(after: number | null): Promise<FastRelayFill[]>
  // The delivery legs of exactly these fills.
  legs(fills: FastRelayFill[]): Promise<FastRelayLeg[]>
  deposits(pools: string[], after: number | null): Promise<FastRelayDeposit[]>
  inputs(keys: string[]): Promise<Map<string, string>>
}

export interface FastRelayStoreOptions {
  // Blocks this far below the indexed head are treated as final and fully ingested.
  marginBlocks: number
  // How long a kept base is trusted before the next load re-reads all of history.
  reanchorMs: number
  now?: () => number
  onError?: (err: unknown) => void
}

// The index, loaded incrementally. Rows at or below `head − marginBlocks` are kept
// (the base); each load re-reads only the blocks above the base with a block_height
// bound, so a per-block reload costs the last ~margin blocks rather than all of
// history. Raw can still be backfilled below the margin, so the base is re-anchored by
// a full read every `reanchorMs` — a backfilled fill is a transfer for at most that
// long, never for good. A pool first seen in the tail also forces a full read, since
// its older deposits are not in the base.
//
// A failed load serves the last good index, and throws when there is none: an empty
// index would silently turn every delivery back into a transfer.
export class FastRelayIndexStore {
  private base: { through: number; anchoredAt: number; rows: FastRelayRows; pools: Set<string> } | null = null
  private lastGood: FastRelayIndex | null = null
  private readonly now: () => number

  constructor(private readonly opts: FastRelayStoreOptions) {
    this.now = opts.now ?? Date.now
  }

  async index(head: number, source: FastRelayRowSource): Promise<FastRelayIndex> {
    try {
      const index = await this.load(head, source)
      this.lastGood = index
      return index
    } catch (err) {
      this.opts.onError?.(err)
      if (!this.lastGood) throw err
      return this.lastGood
    }
  }

  private async load(head: number, source: FastRelayRowSource): Promise<FastRelayIndex> {
    const now = this.now()
    const start = this.base
    let base = start && now - start.anchoredAt < this.opts.reanchorMs ? start : null
    let fills = await source.fills(base ? base.through : null)
    if (base && fills.some(f => !base!.pools.has(f.pool))) {
      base = null
      fills = await source.fills(null)
    }
    const after = base ? base.through : null
    const allFills = base ? [...base.rows.fills, ...fills] : fills
    const pools = [...new Set(allFills.map(f => f.pool))]
    const [legs, deposits] = await Promise.all([
      fills.length ? source.legs(fills) : Promise.resolve([]),
      pools.length ? source.deposits(pools, after) : Promise.resolve([]),
    ])
    const rows: FastRelayRows = base
      ? { fills: allFills, legs: [...base.rows.legs, ...legs], deposits: [...base.rows.deposits, ...deposits] }
      : { fills, legs, deposits }
    const index = buildFastRelayIndex(rows, await source.inputs(fastRelayInputKeys(rows)))
    const through = head - this.opts.marginBlocks
    // A full read always replaces the base; an incremental one only extends the base it
    // started from, so a concurrent full read's corrections are never overwritten.
    if (!base || (this.base === start && through > base.through)) {
      this.base = {
        through, anchoredAt: base ? base.anchoredAt : now, pools: new Set(pools),
        rows: {
          fills: rows.fills.filter(f => f.block <= through),
          legs: rows.legs.filter(l => l.block_height <= through),
          deposits: rows.deposits.filter(d => d.block_height <= through),
        },
      }
    }
    return index
  }
}
