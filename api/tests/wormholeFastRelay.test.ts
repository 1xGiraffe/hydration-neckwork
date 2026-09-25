import { describe, it, expect } from 'vitest'
import {
  buildFastRelayIndex,
  decodeFastRelayFilled,
  fastRelayDeliveryFromInput,
  fastRelayFeeRaw,
  fastRelayLegExclusionSql,
  fastRelayPairKey,
  fastRelaySettlementKeyFromInput,
  FastRelayIndexStore,
  isFastRelayLeg,
  vaaFromReceiveMessageInput,
  type FastRelayDeposit,
  type FastRelayFill,
  type FastRelayIndex,
  type FastRelayLeg,
  type FastRelayRowSource,
  type FastRelayRows,
} from '../src/services/wormholeFastRelay.ts'
import { annotateFastRelaySettlements, fastRelayDeliveryRow, type ActivityRow } from '../src/services/explorerService.ts'

// Real Hydration bytes, one transfer end to end. Ethereum tx 0xb512…9833 by
// 0x553f…7775 published the relay's fast message (seq 7) and an NTT transfer
// (seq 154). The relayer submitted the fast message at 14,980,518 extrinsic 2 and
// the pool paid 19.9 USDC out; the NTT redeem at 14,980,973 extrinsic 2 minted
// 20 USDC into the pool.
const DELIVERY_INPUT = '0xf953cec70000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000047301000000070d00a93300c7ca4a7f5dd8e4eeaa7dd0a384725843f1b38d7cbe81cade189ba5440b2a95db66d15a81611c908f8bff90afa3bca3f4736c6ce7c149e2ba4d445b5771000191bee0af5d46d7efc972ddd73e5f9578d585e56a8f5274682941c44aead21d0e5dcdd64481f445b398c09ae7e32065f0f46b9e4640531da02d14f91552a9738900036f90408ea58d5133b2227b0888a9df342b7070a7c8fe401c2c805f991e7384774706685b9582d14d2e6c0eeaa5d95bf2054866fcaccb974d2dfd535b9b72bf910106cf5b32585ebbfa33b7f59a772ace5081352255be0ed4da2c379685493b204f80244854cc02cb1156c41b1a8730f403a46ba3bc49b4f8fbbfcfc4ebce61762ff90007acd0b628e223f7308efdf28c9bf49b4202f66031d8f4d2ddcefcc48096bb8d8f72ea7e77da3c77cbde3d5b6fc19d5b24f438eb7f13425e088370b6153e748d2101085994b5084701c86ef87d3e1f612629b320e3b1b9f54562875df6a320687488f51a38911bb038c267b59d333d18026630ce5ed600f96fa4fb3eefe99a509fd5a50109909da58405a9eb9c0fc4d2d9963d6994302d543dbc18a65622f0c62ce5e04868276c098500f1d7d6e8ed8a27e6683b8757b46306f674dbbb9196e03461a410d1000ac5fc09c9eb73705be627ec791b4616a39ea7a8a08d4cd9441ad1273e588f8abc35cad4bfc5ca0a81b56fa9ff71ace760cf9cf07c7e5020751f312bcc435eaa84010c6ae2d6acfbe307962095e96bb5bc29928095bc4ec5f693df190a4051eb06f80f4f3601647dc95d05bc7ead886e59550f17bd5ba411b2825edb47c98bd6b10b14010d22039e751a200d39e618bc4077e07b13f7a79292fa5c291dbddd1bcae9ee295714d96f80f2bf62c5f6f31cd342bc29cce823cf5c7558341ec2cfeb73725ae03a000e563c37749a5f5bf40b617d2239827e45dd017b5dd21e76540c42d23aed423957681cb951335d482ed63bb4b19dbd7371a54ddab0820200b95022f100094cca21010f4b6fa1d597b8e07ec9eec4223acdff4e89c18552633d3ff63d13ec226b07244f30fd07ff59f588e26fd45379111fa40b0a9f14b0f5032b9f9637605a4d2994500110a30bb1b5884f6060ca2be8231895680577c0e07fc259b3f0bce479fccea777aa1ae5489d6253ec23d9da5f4b3f80e8e979349af3eda4658714483bd1d02c91bc016ab500ff000000070002000000000000000000000000a72e2bf29c840eb93adbb9ee1aa41580f01c99440000000000000007c80000000000000000000000000000000000000000000000000000000000000020000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000012fa66045544800553f022201fa7c88e6cc10d1c688b157d6fa77750000000000000000000000000000000000000000000000000000000000000000000000000000009800000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
const SETTLEMENT_INPUT = '0xf953cec70000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000046c01000000070d004ccfa8c91c68a2efd9f1b6285d959804bbe9a19de9eabd2503a7fa2191b1212065e0aebc917b74e3cfbedf936b022c57259c2012bd8c5f604b35ce66d1f9d4030101992390bde5fde22460e76ae4580a176988348058532245753d77852271bce1275f0d7d7b10719eea9ad7530f1df04bb04147b7c91cc59399abc4ca38e3dfa1fd00028ca64e8219357004567a3a64188f2291c43450869d6756227886e86a31a13a4554a534971fe2871328075051bd8c4d980e1ba5d6db1481f58c4a5e112f2a0c3d0106a43a244195ee8ebdcbe47e964a463e3e257e6a1dd56293b6378b3e4c22f94ffc6d682e29fa5b72b3377cb56517dabe556706e33030d1adffede18763716e58d40007668dc8445d6d3d1cf7598441bf9c5a2896eaf93cbc750d8c9e458ae9b2db097a16e5b41f6b7d5a029f1217e7b88cf3f15d563e3603c8b414273968f07803b7f100081144b66fb7869ca4a23f8884cc6de8af21a3491ad13c3ceb3344ea986efd587300196b1bf656c2343f95fe742c157721094e84c6bd90a929e25aa172d0917c6901098e0aa7bb9ddb7ddedc5564916bd6fcdb6dd7e8f6998fda6fdd773aac66b9c1a412546e1a8dd715f53b3bf9fb0a58217f91bfa6daef5a201f22c1225584dc223f000ab1e30c8c1a7b6bd58ad808e16b66fc5da889b538b49184ef7b2d87a9e65f444a6dfc41cc40d890c0a8148a63fafce7184117063017ce9296cbae55e78a51b5c6010c53bf8785e39e452693f1bf6566926c203470ddbae7300969d0e69508bd8239c2762c2b040c5ddd6e469dc15192193d3c3b6bfee6214cf3a196df8196b07ee953010d6c3af77e1425da68dc7330aa8a3badfe09039acf08d5899afbf3ff475f09e0fb4ecd0636271f491d83f75e7f9da4d8a7255e798aad0388687734aa57fbf5182e010e8b5977cc8ee18fb3b33571b8c1da52b84c642d3315d10ec59d30e68e0f2b512629b62b0c099464785d7b179398bf3f4cae348cb985780ff1278c0d0a46cb97260010c3c7e2dd33cb9b242806ea99247124418c4373223f96de8e0ecba2067c05d1482cd5d3815b8333e717e3347c542cd600cd7d0ada7ee4a9476a11249268f323080112cd8e46c0ab0fb99b2a2532123ef1c56119eec9543cf4dc426a728074261760d84349b17275ce6bd058c8a0d07d3521ee0523da11c9430cc1ae74c8c86799c304016ab500ff000000000002000000000000000000000000a108bd5dbc6ce665aebb6895351e0609c76f8efc000000000000009aca9945ff10000000000000000000000000447b2c7485a3d6813f8197e605b10bccd8dd8398000000000000000000000000eceab64542a875c4472671d9ed1e690cdd4e28fc00910000000000000000000000000000000000000000000000000000000000000098000000000000000000000000a72e2bf29c840eb93adbb9ee1aa41580f01c9944004f994e5454060000000001312d00000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000070e9b12c3b19cb5f0e59984a5866278ab69df976004900000000000000000000000000000000000000000000'
const RELAY = '0xa72e2bf29c840eb93adbb9ee1aa41580f01c9944'
const USER = '0x45544800553f022201fa7c88e6cc10d1c688b157d6fa77750000000000000000'

describe('wormhole fast relay', () => {
  it('reads the delivery the fast message instructs', () => {
    const d = fastRelayDeliveryFromInput(DELIVERY_INPUT)
    expect(d).toEqual({
      pairKey: fastRelayPairKey(2, RELAY, '152'),
      vaaId: '2/000000000000000000000000a72e2bf29c840eb93adbb9ee1aa41580f01c9944/7',
      recipient: USER,
      amount: '19900000',
    })
  })

  it('pairs the NTT settlement to that delivery by the NTT message id', () => {
    expect(fastRelaySettlementKeyFromInput(SETTLEMENT_INPUT)).toBe(fastRelayPairKey(2, RELAY, '152'))
    // The settlement's own VAA is the NTT transceiver's, the id Ocelloids keys the journey by.
    const vaa = vaaFromReceiveMessageInput(SETTLEMENT_INPUT)!
    expect(`${vaa.emitterChain}/${vaa.emitterAddress.slice(2)}/${vaa.sequence}`)
      .toBe('2/000000000000000000000000a108bd5dbc6ce665aebb6895351e0609c76f8efc/154')
  })

  it('does not read an NTT redeem as a delivery, nor a delivery as a settlement', () => {
    expect(fastRelayDeliveryFromInput(SETTLEMENT_INPUT)).toBeNull()
    expect(fastRelaySettlementKeyFromInput(DELIVERY_INPUT)).toBeNull()
    expect(fastRelayDeliveryFromInput('0xdeadbeef' + DELIVERY_INPUT.slice(10))).toBeNull()
  })

  it("decodes the pool's Filled log", () => {
    expect(decodeFastRelayFilled([
      '0x975e82bfde4922e2ce69ecae9a999f21616c5511424de460faee50bfaea5da02',
      '0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      '0x0000000000000000000000000000000000000000000000000000000100000015',
      USER,
    ], '0x00000000000000000000000000000000000000000000000000000000012fa660')).toEqual({
      originToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', assetId: 21, recipient: USER, amount: '19900000',
    })
    expect(decodeFastRelayFilled(['0x' + '11'.repeat(32)], '0x')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------
// The index over hand-built rows. POOL is the relay's pool contract as an account id,
// OTHER_POOL a second pool, so the per-pool predicate is exercised rather than a
// cross product of every pool with every fill block.
const POOL = '0x4554480070e9b12c3b19cb5f0e59984a5866278ab69df9760000000000000000'
const OTHER_POOL = '0x45544800' + '11'.repeat(20) + '0000000000000000'
const STRANGER = '0x' + '22'.repeat(32)

function leg(block: number, event: number, from: string, to: string, amount: string, extrinsic: number | null = 2, assetId = 21): FastRelayLeg {
  return { block_height: block, ts: '2026-09-24 10:00:00', event_index: event, extrinsic_index: extrinsic, from_acc: from, to_acc: to, amount, asset_id: assetId }
}
function deposit(block: number, event: number, amount: string, extrinsic = 2, assetId = 21): FastRelayDeposit {
  return { block_height: block, ts: '2026-09-24 10:45:00', event_index: event, extrinsic_index: extrinsic, asset_id: assetId, amount }
}

// The fill blocks: POOL at the real delivery's block and a Moonbeam-era hook fill,
// OTHER_POOL at a block POOL did not fill in.
const FILLS: FastRelayFill[] = [
  { block: 14_980_518, pool: POOL },
  { block: 13_000_000, pool: POOL },
  { block: 14_500_000, pool: OTHER_POOL },
]
// Every transfer a transfer read could meet around those blocks.
const CANDIDATES: FastRelayLeg[] = [
  leg(14_980_518, 7, POOL, USER, '19900000'),              // the real delivery
  leg(14_980_518, 9, STRANGER, POOL, '5'),                  // into the pool, same block
  leg(14_980_518, 11, STRANGER, USER, '19900000'),          // someone else, same block
  leg(13_000_000, 3, POOL, STRANGER, '1000', null, 44),     // Moonbeam-era hook fill
  leg(14_500_000, 4, POOL, STRANGER, '1'),                  // POOL, but only OTHER_POOL filled here
  leg(14_500_000, 5, OTHER_POOL, STRANGER, '2'),            // OTHER_POOL's fill
  leg(14_600_000, 1, POOL, STRANGER, '3'),                  // operator withdrawal, no fill
]
// What the leg reader selects: a transfer from a pool in a block that pool filled in.
const readerSelects = (c: FastRelayLeg) => FILLS.some(f => f.block === c.block_height && f.pool === c.from_acc)
const ROWS: FastRelayRows = {
  fills: FILLS,
  legs: CANDIDATES.filter(readerSelects),
  deposits: [deposit(14_980_973, 4, '20000000'), deposit(14_700_000, 2, '999')],
}
const INPUTS = new Map([['14980518:2', DELIVERY_INPUT], ['14980973:2', SETTLEMENT_INPUT], ['14700000:2', DELIVERY_INPUT]])

// Evaluates the exclusion predicate's own groups against one transfer, so the SQL
// rule is checked as written rather than restated.
function sqlExcludes(sql: string, c: FastRelayLeg): boolean {
  const groups = [...sql.matchAll(/\(from_account IN \('([^']+)'\) AND toUInt32\(block_height\) IN \(([0-9,]+)\)\)/g)]
  expect(groups.length).toBeGreaterThan(0)
  return groups.some(([, pool, blocks]) => pool === c.from_acc && blocks.split(',').map(Number).includes(c.block_height))
}

describe('the fast-relay membership rule', () => {
  const index = buildFastRelayIndex(ROWS, INPUTS)
  const id = (c: { block_height: number; event_index: number }) => `${c.block_height}:${c.event_index}`

  it('removes from the transfer reads exactly the legs that become delivery rows', () => {
    const sql = fastRelayLegExclusionSql(index)
    expect(sql.startsWith('AND NOT (')).toBe(true)
    // One group per pool, and no lower() on the read-model column.
    expect(sql.match(/from_account IN/g)).toHaveLength(2)
    expect(sql).not.toContain('lower(')
    const excluded = CANDIDATES.filter(c => sqlExcludes(sql, c)).map(id)
    const inHand = CANDIDATES.filter(c => isFastRelayLeg(index, c.block_height, c.from_acc)).map(id)
    const deliveries = index.legs.map(l => fastRelayDeliveryRow(l, index, new Map()))
    expect(deliveries.every(r => r.type === 'xcm' && r.xcmDir === 'in' && r.fastRelay?.role === 'delivery')).toBe(true)
    const delivered = deliveries.map(r => `${r.blockHeight}:${r.eventIndex}`)
    expect(excluded).toEqual(['14980518:7', '13000000:3', '14500000:5'])
    expect(inHand).toEqual(excluded)
    expect(new Set(delivered)).toEqual(new Set(excluded))
  })

  it('matches a sender in any case in hand, and passes a raw spelling through', () => {
    expect(isFastRelayLeg(index, 14_980_518, POOL.toUpperCase().replace('0X', '0x'))).toBe(true)
    expect(isFastRelayLeg(index, 14_980_518, null)).toBe(false)
    const raw = fastRelayLegExclusionSql(index, 'block_height', "lower(JSONExtractString(args_json,'from'))")
    expect(raw).toContain(`(lower(JSONExtractString(args_json,'from')) IN ('${POOL}') AND toUInt32(block_height) IN (13000000,14980518))`)
  })

  it('is empty — excludes nothing — without fills', () => {
    const empty = buildFastRelayIndex({ fills: [], legs: [], deposits: [] }, new Map())
    expect(fastRelayLegExclusionSql(empty)).toBe('')
    expect(isFastRelayLeg(empty, 14_980_518, POOL)).toBe(false)
  })

  it('pairs the delivery with the NTT mint its message names, and nothing else', () => {
    const key = fastRelayPairKey(2, RELAY, '152')
    expect(index.deliveryOf.get('14980518:7')?.pairKey).toBe(key)
    expect(index.settlementOf.get(key)).toMatchObject({ blockHeight: 14_980_973, eventIndex: 4, amount: '20000000', assetId: 21 })
    // A deposit whose calldata is a fast message (not an NTT redeem) settles nothing,
    // and the hook fill has no message to pair by.
    expect(index.settlementKeyOf.size).toBe(1)
    expect(index.deliveryOf.has('13000000:3')).toBe(false)
  })

  it('does not pair a leg whose amount or recipient differs from the message', () => {
    const off = buildFastRelayIndex({ ...ROWS, legs: [leg(14_980_518, 7, POOL, USER, '19900001')] }, INPUTS)
    expect(off.deliveryOf.size).toBe(0)
    expect(off.settlementOf.size).toBe(0)
  })

  it('charges the relayer fee as settlement minus delivery', () => {
    const row = fastRelayDeliveryRow(index.legs.find(l => l.block_height === 14_980_518)!, index, new Map())
    expect(row.messageId).toBe('2/000000000000000000000000a72e2bf29c840eb93adbb9ee1aa41580f01c9944/7')
    expect(row.fastRelay).toMatchObject({ role: 'delivery', pair: { blockHeight: 14_980_973, eventIndex: 4 }, pairMessageId: '2/000000000000000000000000a108bd5dbc6ce665aebb6895351e0609c76f8efc/154' })
    expect(row.xcmFees).toHaveLength(1)
    expect(row.xcmFees![0]).toMatchObject({ kind: 'relayer', amount: '100000', settlement: 'destination' })
    const hook = fastRelayDeliveryRow(index.legs.find(l => l.block_height === 13_000_000)!, index, new Map())
    expect(hook.messageId).toBeUndefined()
    expect(hook.fastRelay?.pair).toBeNull()
    expect(hook.xcmFees).toBeUndefined()

    const l = leg(1, 1, POOL, USER, '100')
    const s = { blockHeight: 2, eventIndex: 1, ts: '', amount: '130', assetId: 21, journeyId: null }
    expect(fastRelayFeeRaw(l, s)).toBe('30')
    expect(fastRelayFeeRaw(l, { ...s, amount: '100' })).toBeNull()
    expect(fastRelayFeeRaw(l, { ...s, amount: '99' })).toBeNull()
    expect(fastRelayFeeRaw(l, { ...s, assetId: 22 })).toBeNull()
    expect(fastRelayFeeRaw(l, undefined)).toBeNull()
  })

  it('annotates the settlement row and points it at its delivery', () => {
    const nttRow = (blockHeight: number, eventIndex: number): ActivityRow => ({
      type: 'xcm', xcmDir: 'in', blockHeight, eventIndex, timestamp: '', extrinsicIndex: 2,
      who: null, to: null, asset: null, assetIn: null, assetOut: null, amount: '20000000', amountIn: null, amountOut: null, valueUsd: null,
    } as unknown as ActivityRow)
    const settlement = nttRow(14_980_973, 4)
    const other = nttRow(14_700_000, 2)
    const out = { ...nttRow(14_980_973, 4), xcmDir: 'out' } as ActivityRow
    annotateFastRelaySettlements([settlement, other, out], index)
    expect(settlement.fastRelay).toEqual({ role: 'settlement', pool: null, pair: { blockHeight: 14_980_518, eventIndex: 7 }, pairMessageId: null })
    expect(other.fastRelay).toBeUndefined()
    expect(out.fastRelay).toBeUndefined()
  })
})

// A fake row source over a fixed history, recording every read's lower bound.
function fakeSource(history: FastRelayRows, inputs: Map<string, string>) {
  const calls: { read: string; after: number | null }[] = []
  let fail = false
  const guard = () => { if (fail) throw new Error('clickhouse down') }
  const source: FastRelayRowSource = {
    async fills(after) {
      guard(); calls.push({ read: 'fills', after })
      return history.fills.filter(f => after == null || f.block > after)
    },
    async legs(fills) {
      guard(); calls.push({ read: 'legs', after: Math.min(...fills.map(f => f.block)) - 1 })
      return history.legs.filter(l => fills.some(f => f.block === l.block_height && f.pool === l.from_acc))
    },
    async deposits(_pools, after) {
      guard(); calls.push({ read: 'deposits', after })
      return history.deposits.filter(d => after == null || d.block_height > after)
    },
    async inputs(keys) {
      guard()
      return new Map(keys.filter(k => inputs.has(k)).map(k => [k, inputs.get(k)!]))
    },
  }
  return { source, calls, setFail: (v: boolean) => { fail = v } }
}

const summary = (i: FastRelayIndex) => ({
  fills: i.pairs.map(p => `${p.block}:${p.pool.slice(0, 12)}`).sort(),
  legs: i.legs.map(l => `${l.block_height}:${l.event_index}`),
  settlements: [...i.settlementKeyOf.keys()].sort(),
})

describe('the fast-relay index store', () => {
  const MARGIN = 600
  const HOUR = 3_600_000

  it('reads all of history once, then only the blocks above the kept base', async () => {
    const history: FastRelayRows = { fills: [FILLS[1]], legs: [ROWS.legs.find(l => l.block_height === 13_000_000)!], deposits: [] }
    const { source, calls } = fakeSource(history, INPUTS)
    let now = 0
    const store = new FastRelayIndexStore({ marginBlocks: MARGIN, reanchorMs: HOUR, now: () => now })
    const cold = await store.index(14_980_000, source)
    expect(calls.map(c => c.after)).toEqual([null, 12_999_999, null])
    expect(cold.legs).toHaveLength(1)

    // The real transfer lands: fill + delivery near the head, settlement a few blocks on.
    history.fills.push(FILLS[0])
    history.legs.push(ROWS.legs.find(l => l.block_height === 14_980_518)!)
    calls.length = 0
    now += 60_000
    const delivered = await store.index(14_980_600, source)
    expect(calls).toEqual([
      { read: 'fills', after: 14_980_000 - MARGIN },
      { read: 'legs', after: 14_980_517 },
      { read: 'deposits', after: 14_980_000 - MARGIN },
    ])
    expect(delivered.deliveryOf.has('14980518:7')).toBe(true)
    expect(delivered.settlementOf.size).toBe(0)

    history.deposits.push(ROWS.deposits[0])
    calls.length = 0
    now += 60_000
    const settled = await store.index(14_981_000, source)
    expect(calls.every(c => c.after != null && c.after >= 14_980_600 - MARGIN)).toBe(true)
    // The same index a full read of the same history builds.
    const full = await new FastRelayIndexStore({ marginBlocks: MARGIN, reanchorMs: HOUR }).index(14_981_000, fakeSource(history, INPUTS).source)
    expect(summary(settled)).toEqual(summary(full))
    expect(settled.settlementOf.get(fastRelayPairKey(2, RELAY, '152'))?.blockHeight).toBe(14_980_973)
  })

  it('pairs a settlement that landed before its delivery, across the base boundary', async () => {
    // The settlement is final and in the base; the delivery arrives in the tail.
    const early = deposit(14_000_000, 4, '20000000')
    const history: FastRelayRows = { fills: [FILLS[1]], legs: [ROWS.legs.find(l => l.block_height === 13_000_000)!], deposits: [early] }
    const { source } = fakeSource(history, new Map([...INPUTS, ['14000000:2', SETTLEMENT_INPUT]]))
    const store = new FastRelayIndexStore({ marginBlocks: MARGIN, reanchorMs: HOUR, now: () => 0 })
    await store.index(14_980_000, source)
    history.fills.push(FILLS[0])
    history.legs.push(ROWS.legs.find(l => l.block_height === 14_980_518)!)
    const index = await store.index(14_980_600, source)
    expect(index.settlementOf.get(fastRelayPairKey(2, RELAY, '152'))).toMatchObject({ blockHeight: 14_000_000, eventIndex: 4 })
    const row = fastRelayDeliveryRow(index.legs[0], index, new Map())
    expect(row.fastRelay?.pair).toEqual({ blockHeight: 14_000_000, eventIndex: 4 })
  })

  it('re-anchors on a full read after reanchorMs, and when the tail names a new pool', async () => {
    const history: FastRelayRows = { fills: [FILLS[1]], legs: [], deposits: [] }
    const { source, calls } = fakeSource(history, INPUTS)
    let now = 0
    const store = new FastRelayIndexStore({ marginBlocks: MARGIN, reanchorMs: HOUR, now: () => now })
    await store.index(14_000_000, source)
    calls.length = 0
    now = HOUR
    await store.index(14_000_001, source)
    expect(calls.filter(c => c.read === 'fills').map(c => c.after)).toEqual([null])

    history.fills.push(FILLS[2])
    calls.length = 0
    now = HOUR + 1
    await store.index(14_600_000, source)
    // The incremental fills read found OTHER_POOL, so fills and deposits were re-read whole.
    expect(calls.filter(c => c.read !== 'legs').map(c => c.after)).toEqual([14_000_001 - MARGIN, null, null])
  })

  it('throws on a cold failure, and serves the last good index on a warm one', async () => {
    const { source, setFail } = fakeSource(ROWS, INPUTS)
    const errors: unknown[] = []
    const store = new FastRelayIndexStore({ marginBlocks: MARGIN, reanchorMs: HOUR, now: () => 0, onError: e => errors.push(e) })
    setFail(true)
    await expect(store.index(15_000_000, source)).rejects.toThrow('clickhouse down')
    setFail(false)
    const good = await store.index(15_000_000, source)
    setFail(true)
    expect(await store.index(15_000_001, source)).toBe(good)
    expect(errors).toHaveLength(2)
  })
})
