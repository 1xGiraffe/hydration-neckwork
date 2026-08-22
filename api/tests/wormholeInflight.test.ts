import { describe, it, expect } from 'vitest'
import {
  decideInflight,
  matchInboundDeposit,
  normalizeScanOperations,
  vaaKey,
  type InflightContext,
  type ManagerFacts,
  type OutboundSend,
} from '../src/services/wormholeNtt.ts'

const HYDRATION = 73
const USDC_MANAGER = '0x000000000000000000000000eceab64542a875c4472671d9ed1e690cdd4e28fc'
const USDC_ETH_MANAGER = '0x000000000000000000000000447b2c7485a3d6813f8197e605b10bccd8dd8398'
const USDC_TRANSCEIVER = '0x0d7488b39aa64468a709ec3b3d354defe539ed97'
const ETH_EMITTER = 'a108bd5dbc6ce665aebb6895351e0609c76f8efc'.padStart(64, '0')
const SUI_MANAGER = '0xa0bc45e0384140dc125f273eda89cad1434f5dee430726cf6364bdcceba1e9a3'
const SUI_TRANSCEIVER = '0xa224d6f4e0e276b34d91bfe6c3a5fe6838322af7'

const usdcFacts: ManagerFacts = { assetId: 21, symbol: 'USDC', decimals: 6, manager: '0xeceab64542a875c4472671d9ed1e690cdd4e28fc', originChainId: 2, peerDecimals: 6 }
const suiFacts: ManagerFacts = { assetId: 1_000_753, symbol: 'SUI', decimals: 9, manager: '0x978443f00cab6b09445140321ec73a221ebff5f8', originChainId: 21, peerDecimals: 9 }

const assetByManager = new Map<string, ManagerFacts>([
  [USDC_MANAGER, usdcFacts],
  [USDC_ETH_MANAGER, usdcFacts],
  ['0x' + '978443f00cab6b09445140321ec73a221ebff5f8'.padStart(64, '0'), suiFacts],
  [SUI_MANAGER, suiFacts],
])

// Shaped like a real Wormholescan row (see the operations endpoint): note that
// the chain properties live under the endpoint's own misspelling.
const scanRow = (over: Record<string, unknown> = {}) => ({
  id: `2/${ETH_EMITTER}/50`,
  emitterChain: 2,
  emitterAddress: { hex: ETH_EMITTER, native: '0xa108bd5dbc6ce665aebb6895351e0609c76f8efc' },
  sequence: '50',
  content: {
    payload: {
      transceiverMessage: { sourceNttManager: USDC_ETH_MANAGER, recipientNttManager: USDC_MANAGER },
      nttMessage: { trimmedAmount: { amount: '4921564541', decimals: 6 } },
    },
    standarizedProperties: { fromChain: 2, toChain: 73 },
  },
  sourceChain: { chainId: 2, timestamp: '2026-08-21T12:00:00Z', transaction: { txHash: '0xabc' } },
  ...over,
})

const context = (over: Partial<InflightContext> = {}): InflightContext => ({
  hydrationChainId: HYDRATION,
  assetByManager,
  redeemedInbound: new Set<string>(),
  outboundSends: [],
  nowMs: Date.parse('2026-08-22T00:00:00Z'),
  lookbackMs: 14 * 86_400_000,
  ...over,
})

describe('normalizeScanOperations', () => {
  it('dedupes by operation id and lets the redeemed view win', () => {
    const ops = normalizeScanOperations([
      scanRow(),
      scanRow({ targetChain: { chainId: 73, transaction: { txHash: '0xdef' } } }),
      scanRow(),
    ])
    expect(ops).toHaveLength(1)
    expect(ops[0].redeemedByScan).toBe(true)
  })

  it('reads amount, chains, emitter and source tx off the row', () => {
    const [op] = normalizeScanOperations([scanRow()])
    expect(op.fromChain).toBe(2)
    expect(op.toChain).toBe(73)
    expect(op.emitterAddress).toBe(ETH_EMITTER)
    expect(op.sequence).toBe('50')
    expect(op.trimmedAmount).toBe(4_921_564_541n)
    expect(op.trimmedDecimals).toBe(6)
    expect(op.sourceTx).toBe('0xabc')
    expect(op.redeemedByScan).toBe(false)
  })

  it('keeps a payload the redeemed row omitted', () => {
    const [op] = normalizeScanOperations([
      scanRow({ targetChain: { chainId: 73 }, content: { standarizedProperties: { fromChain: 2, toChain: 73 } } }),
      scanRow(),
    ])
    expect(op.trimmedAmount).toBe(4_921_564_541n)
    expect(op.redeemedByScan).toBe(true)
  })

  it('drops rows with no id rather than inventing one', () => {
    expect(normalizeScanOperations([{ emitterChain: 2 }, null, 'nonsense'])).toEqual([])
  })
})

describe('decideInflight — inbound', () => {
  it('does not report an inbound transfer this chain has already redeemed', () => {
    const ops = normalizeScanOperations([scanRow()])
    const redeemed = new Set([vaaKey(2, ETH_EMITTER, '50')])
    // Wormholescan never records a redemption on Hydration, so its row stays
    // targetChain-less forever; our own ReceivedMessage log is the authority.
    expect(decideInflight(ops, context({ redeemedInbound: redeemed }))).toEqual([])
  })

  it('reports an inbound transfer our ReceivedMessage set has never seen', () => {
    const inflight = decideInflight(normalizeScanOperations([scanRow()]), context())
    expect(inflight).toHaveLength(1)
    expect(inflight[0]).toMatchObject({
      direction: 'in',
      assetId: '21',
      symbol: 'USDC',
      amount: '4921564541',
      fromChainId: 2,
      toChainId: 73,
      sequence: '50',
    })
  })

  it('de-trims an inbound amount into the asset decimals', () => {
    const row = scanRow({
      content: {
        payload: {
          transceiverMessage: { sourceNttManager: SUI_MANAGER, recipientNttManager: SUI_MANAGER },
          nttMessage: { trimmedAmount: { amount: '350000000000', decimals: 8 } },
        },
        standarizedProperties: { fromChain: 21, toChain: 73 },
      },
    })
    const [op] = decideInflight(normalizeScanOperations([row]), context())
    expect(op.amount).toBe('3500000000000')
  })

  it('ignores an inbound transfer older than the lookback window', () => {
    const stale = scanRow({ sourceChain: { timestamp: '2026-07-01T00:00:00Z' } })
    expect(decideInflight(normalizeScanOperations([stale]), context())).toEqual([])
  })
})

describe('decideInflight — outbound', () => {
  const send = (over: Partial<OutboundSend> = {}): OutboundSend => ({
    sequence: '32',
    emitterAddress: USDC_TRANSCEIVER,
    toChain: 2,
    assetId: 21,
    amount: 4_103_723_948n,
    sentAtMs: Date.parse('2026-08-21T20:00:00Z'),
    blockHeight: 13_728_000,
    txRef: '13728000-3',
    digest: `0x${'32'.padStart(64, '0')}`,
    ...over,
  })
  const outRow = (sequence: string, redeemed: boolean) => ({
    id: `73/${USDC_TRANSCEIVER.slice(2).padStart(64, '0')}/${sequence}`,
    emitterChain: 73,
    emitterAddress: { hex: USDC_TRANSCEIVER.slice(2).padStart(64, '0') },
    sequence,
    content: {
      payload: { transceiverMessage: { sourceNttManager: USDC_MANAGER, recipientNttManager: USDC_ETH_MANAGER } },
      standarizedProperties: { fromChain: 73, toChain: 2 },
    },
    sourceChain: { timestamp: '2026-08-21T20:00:00Z' },
    ...(redeemed ? { targetChain: { chainId: 2, transaction: { txHash: '0x20bf' } } } : {}),
  })

  it('trusts targetChain for an EVM destination', () => {
    expect(decideInflight(normalizeScanOperations([outRow('32', true)]), context({ outboundSends: [send()] }))).toEqual([])
  })

  it('reports a send the scan shows pending', () => {
    const inflight = decideInflight(normalizeScanOperations([outRow('32', false)]), context({ outboundSends: [send()] }))
    expect(inflight).toHaveLength(1)
    expect(inflight[0]).toMatchObject({ direction: 'out', assetId: '21', amount: '4103723948', fromChainId: 73, toChainId: 2 })
  })

  it('treats a send the scan does not know at all as settled', () => {
    // Over-counting in flight subtracts from the residual and would raise a
    // deficit that does not exist; under-counting only widens the surplus.
    expect(decideInflight([], context({ outboundSends: [send()] }))).toEqual([])
  })

  it('ignores a send older than the lookback window', () => {
    const stale = send({ sentAtMs: Date.parse('2026-07-01T00:00:00Z') })
    expect(decideInflight(normalizeScanOperations([outRow('32', false)]), context({ outboundSends: [stale] }))).toEqual([])
  })

  it('never counts a queued send as in flight as well', () => {
    // A send the origin's rate limiter is holding was redeemed there, and the
    // queued term already subtracts it. Counting it in both places subtracts
    // the same amount twice and would raise a deficit that does not exist.
    const queuedOutbound = new Set([vaaKey(HYDRATION, USDC_TRANSCEIVER, '32')])
    expect(decideInflight(normalizeScanOperations([outRow('32', false)]), context({ outboundSends: [send()], queuedOutbound }))).toEqual([])
    // The guard is keyed by the exact VAA identity, so a different send of the
    // same asset is unaffected.
    const other = decideInflight(normalizeScanOperations([outRow('33', false)]), context({ outboundSends: [send({ sequence: '33' })], queuedOutbound }))
    expect(other.map(op => op.sequence)).toEqual(['33'])
  })
})

describe('decideInflight — a destination Wormholescan cannot resolve', () => {
  // Wormholescan does not index redemptions on Sui, so its rows for Sui-bound
  // transfers stay pending forever. The Sui state object's inbox count answers
  // instead, and the newest unmatched sends are the ones still in flight.
  const suiSend = (sequence: string, sentAt: string): OutboundSend => ({
    sequence,
    emitterAddress: SUI_TRANSCEIVER,
    toChain: 21,
    assetId: 1_000_753,
    amount: 3_500_000_000_000n,
    sentAtMs: Date.parse(sentAt),
    blockHeight: 13_728_047,
    txRef: '13728047-3',
    digest: `0x${sequence.padStart(64, '0')}`,
  })
  const sends = [
    suiSend('10', '2026-08-19T00:00:00Z'),
    suiSend('11', '2026-08-20T00:00:00Z'),
    suiSend('12', '2026-08-21T00:00:00Z'),
  ]

  it('marks only the newest unmatched sends, newest first', () => {
    const inflight = decideInflight([], context({ outboundSends: sends, unresolvedOutboundByChain: new Map([[21, 2]]) }))
    expect(inflight.map(op => op.sequence)).toEqual(['12', '11'])
  })

  it('reports nothing in flight when the destination has redeemed everything', () => {
    expect(decideInflight([], context({ outboundSends: sends, unresolvedOutboundByChain: new Map([[21, 0]]) }))).toEqual([])
  })

  it('resolves to settled when the destination could not be read at all', () => {
    // An unread inbox yields a zero budget, never "everything is stuck".
    expect(decideInflight([], context({ outboundSends: sends, unresolvedOutboundByChain: new Map([[21, 0]]) }))).toEqual([])
  })
})

describe('matchInboundDeposit', () => {
  // Real WETH inbound at block 13,697,685: the mint is 3.77621131 WETH and the
  // same extrinsic also pays the relayer and the treasury in WETH.
  const wethExtrinsic = [
    { eventIndex: 4, assetId: 20, who: '0x6e4d19cb5308240bccba997276040ba7c811c1dd72f1ec0a58a18e27e0a4f03d', amount: 3_776_211_310_000_000_000n },
    { eventIndex: 6, assetId: 20, who: '0x45544800f1db8c4bfbb3d6a97c9b669a2ffc0b70f41f35470000000000000000', amount: 178_795_329_948n },
    { eventIndex: 7, assetId: 20, who: '0x6d6f646c70792f74727372790000000000000000000000000000000000000000', amount: 2_368_349_979_540n },
  ]

  it('picks the mint over same-asset fee legs in the same extrinsic', () => {
    const mint = matchInboundDeposit(wethExtrinsic, 20, 18, 8)
    expect(mint?.amount).toBe(3_776_211_310_000_000_000n)
    expect(mint?.eventIndex).toBe(4)
  })

  it('ignores deposits of another asset', () => {
    const mixed = [{ eventIndex: 3, assetId: 20, who: '0xaa', amount: 500_000_000_000_000_000n }, ...wethExtrinsic.map(c => ({ ...c, assetId: 99 }))]
    expect(matchInboundDeposit(mixed, 20, 18, 8)?.amount).toBe(500_000_000_000_000_000n)
  })

  it('takes the real USDC mint where the trim step is the whole unit', () => {
    // USDC has 6 decimals, so nothing is trimmed and every amount is on step;
    // the mint is the earliest deposit of the asset.
    const usdc = [{ eventIndex: 13, assetId: 21, who: '0x08e9', amount: 4_921_564_541n }]
    expect(matchInboundDeposit(usdc, 21, 6, 6)?.amount).toBe(4_921_564_541n)
  })

  it('returns null when the extrinsic carries no deposit of the asset', () => {
    expect(matchInboundDeposit([], 21, 6, 6)).toBeNull()
  })
})
