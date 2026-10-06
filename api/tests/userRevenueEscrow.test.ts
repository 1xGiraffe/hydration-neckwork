import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadExplorerAssets, stopExplorerAssetsRefresh } from '../src/services/explorerAssets.ts'
import type { FoldWindow, Ledger } from '../src/services/userRevenueFold.ts'
import { CHECKPOINT_POT, computeUserRevenueWindow, redemptionEscrowCustody, type AnchorIn } from '../src/services/userRevenueWindow.ts'
import {
  ESCROW_CHECKPOINT_MARK, REDEMPTION_ESCROWS, REDEMPTION_ESCROW_REMAINDER_VIA, RedemptionEscrowBook, escrowCheckpointPot, escrowEventsFromLogs,
  pegBucketFingerprints, type EscrowEvent,
} from '../src/services/userRevenueTokens.ts'
import { pegSegmentHash, type PegSegment } from '../src/services/userRevenueMath.ts'
import { ethMappedAccount } from '../src/services/userRevenueStreams.ts'

const UBIL = REDEMPTION_ESCROWS[0]
const T = UBIL.topics
const E18 = 10n ** 18n
const H0 = Date.UTC(2026, 8, 1) / 1000 // 2026-09-01 00:00
const w: FoldWindow = {
  month: 202609, monthStart: H0, monthEnd: Date.UTC(2026, 9, 1) / 1000, fromHour: H0, hours: 3,
  openBlock: 100, openTs: H0 - 6,
  hourBlocks: [{ first: 101, last: 200, lastTs: H0 + 3590 }, { first: 201, last: 300, lastTs: H0 + 7190 }, { first: 301, last: 400, lastTs: H0 + 10790 }],
  lastBlock: 400,
}

const A = '0x84d42a3f0dc68e3be1d4936b51ceb47a8601006a'
const B = '0xdd6835c55bc2d4a6ddb168b956e4cf1a3a66e621'
const CONTRACT_ACCOUNT = ethMappedAccount(UBIL.contract)

const pad = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
const u256 = (v: bigint) => pad(v.toString(16))
const addr = (a: string) => `0x${pad(a)}`
const id = (n: number) => `0x${u256(BigInt(n))}`
const request = (block: number, index: number, req: number, controller: string, shares: bigint) =>
  ({ block, index, topic0: T.request, topics: [T.request, addr(controller), addr(controller), id(req)], data: `0x${pad(controller)}${u256(shares)}` })
const cancel = (block: number, index: number, req: number, shares: bigint) =>
  ({ block, index, topic0: T.cancel, topics: [T.cancel, id(req)], data: `0x${u256(shares)}` })
const fulfil = (block: number, index: number, req: number, controller: string, assets: bigint, shares: bigint, partial = false) =>
  ({ block, index, topic0: partial ? T.fulfilPartial : T.fulfil, topics: [partial ? T.fulfilPartial : T.fulfil, id(req), addr(controller)], data: `0x${u256(assets)}${u256(shares)}` })

describe('redemption escrow: decoding the issuer\'s logs', () => {
  it('reads a request\'s controller, id and shares, and a cancel\'s or a fulfilment\'s shares (partial and final alike); other topics are skipped', () => {
    const ev = escrowEventsFromLogs(UBIL, [
      fulfil(30, 1, 3, A, 105n * E18, 40n * E18, true),
      request(20, 5, 3, A, 100n * E18),
      cancel(40, 0, 4, 7n * E18),
      fulfil(50, 2, 3, A, 160n * E18, 60n * E18),
      { block: 60, index: 0, topic0: '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db', topics: [], data: '0x' },
    ])
    expect(ev).toEqual([
      { block: 20, index: 5, id: '3', controller: A, delta: 100n * E18 },
      { block: 30, index: 1, id: '3', delta: -40n * E18 },
      { block: 40, index: 0, id: '4', delta: -7n * E18 },
      { block: 50, index: 2, id: '3', delta: -60n * E18 },
    ])
  })
})

describe('redemption escrow: the open-request book', () => {
  const events: EscrowEvent[] = [
    { block: 10, index: 0, id: '1', controller: A, delta: 600n },
    { block: 10, index: 1, id: '2', controller: B, delta: 200n },
    { block: 10, index: 2, id: '0', controller: B, delta: 5n },
    { block: 10, index: 3, id: '0', delta: -5n }, // requested and cancelled in one block
    { block: 20, index: 0, id: '2', delta: -200n }, // cancelled
    { block: 30, index: 0, id: '1', delta: -250n }, // fulfilled in part
    { block: 40, index: 0, id: '1', delta: -350n }, // fulfilled: closed
  ]
  it('opens at a request, shrinks at a partial fulfilment and closes at a cancellation or the final fulfilment', () => {
    const book = new RedemptionEscrowBook([], events)
    expect(book.openAt(9)).toEqual([])
    expect(book.openAt(10)).toEqual([{ id: '1', controller: A, shares: 600n }, { id: '2', controller: B, shares: 200n }])
    expect(book.openAt(20)).toEqual([{ id: '1', controller: A, shares: 600n }])
    expect(book.openAt(35)).toEqual([{ id: '1', controller: A, shares: 350n }])
    expect(book.openAt(40)).toEqual([])
  })
  it('continues from a checkpoint exactly as from the full history (the month anchor\'s open requests)', () => {
    const full = new RedemptionEscrowBook([], events)
    const ckpt = new RedemptionEscrowBook([], events.filter(e => e.block <= 25)).openAt(25)
    const resumed = new RedemptionEscrowBook(ckpt, events.filter(e => e.block > 25))
    for (const b of [25, 30, 35, 40]) expect(resumed.openAt(b)).toEqual(full.openAt(b))
  })
})

describe('redemption escrow: the custody rule', () => {
  const ledger = (amounts: bigint[], units: bigint[]): Ledger => ({ holder: CONTRACT_ACCOUNT, stream: 'token_accrual', pot: 'token:550', via: '', asset: 222, held: 550, price: 'accrual', amounts, units })
  const opens = [
    [{ id: '1', controller: A, shares: 600n }, { id: '2', controller: B, shares: 200n }], // two concurrent requests
    [{ id: '1', controller: A, shares: 600n }], // 2 cancelled
    [], // 1 fulfilled: its units wait in the contract for the claim
  ]
  it('passes each open request its pro-rata share of the contract\'s held units, books the unrequested rest unattributed, and stops a request at cancel or fulfilment', async () => {
    const r = await redemptionEscrowCustody(UBIL, h => opens[h], h160 => ethMappedAccount(h160)).resolve(ledger([1000n, 800n, 900n], [1000n, 800n, 600n]))
    const of = (h160: string) => r.parts.find(p => p.holder === ethMappedAccount(h160))!
    expect(of(A)).toMatchObject({ via: 'redemption-escrow:550', held: 550, stream: 'token_accrual', pot: 'token:550', asset: 222 })
    expect(of(A).amounts).toEqual([600n, 600n, 0n])
    expect(of(B).amounts).toEqual([200n, 0n, 0n])
    expect(r.remainder).toEqual([200n, 200n, 900n])
    expect(r.remainderVia).toBe(REDEMPTION_ESCROW_REMAINDER_VIA)
    expect(r.more).toEqual([{ via: 'rounding', amounts: [0n, 0n, 0n] }])
  })
  it('conserves the hour\'s income to the unit: requesters + remainder + rounding = income', async () => {
    const r = await redemptionEscrowCustody(UBIL, () => [{ id: '1', controller: A, shares: 1n }, { id: '2', controller: B, shares: 1n }], h => h).resolve(ledger([10n], [3n]))
    const given = r.parts.reduce((a, p) => a + p.amounts[0], 0n)
    expect(given).toBe(6n) // 10 × 1/3 each, floored
    expect(r.remainder[0]).toBe(3n) // 10 × 1/3 unrequested
    expect(given + r.remainder[0] + r.more![0].amounts[0]).toBe(10n)
  })
})

describe('redemption escrow: the token rule version joins only its own segments\' identities', () => {
  it('re-marks the buckets the token\'s rate spans and leaves every other token\'s alone', () => {
    const seg: PegSegment = { startTs: H0, endTs: H0 + 7200, rise: 5n, kind: 'accrual', moves: 1 }
    expect(pegSegmentHash(550, seg, 1)).not.toBe(pegSegmentHash(550, seg))
    expect(pegSegmentHash(550, seg, 0)).toBe(pegSegmentHash(550, seg))
    const [ubil, prime] = [pegBucketFingerprints(new Map([[550, [seg]]]), [[H0, H0 + 3600]]), pegBucketFingerprints(new Map([[43, [seg]]]), [[H0, H0 + 3600]])]
    expect(ubil[0]).toBe(pegSegmentHash(550, seg, 1))
    expect(prime[0]).toBe(pegSegmentHash(43, seg))
  })
})

// ── the whole window over a fake ClickHouse ────────────────────────────────────

beforeAll(async () => {
  await loadExplorerAssets({ query: async () => ({ json: async () => [
    { asset_id: 55, symbol: 'BIL', name: 'BIL', decimals: 18 },
    { asset_id: 222, symbol: 'HOLLAR', name: 'HOLLAR', decimals: 18 },
    { asset_id: 550, symbol: 'uBIL', name: 'uBIL', decimals: 18 },
  ] }) } as never)
})
afterAll(() => stopExplorerAssetsRefresh())

const RATE = 10_000n
/** pool 10055's peg grid: BIL (55) over HOLLAR (222), rising 1e-4 from two days before the window to a day after it (decided by the next move). */
const pegRows = [
  { p: '10055', b: '10', ts: String(H0 - 2 * 86_400), ids: ['55', '222'], pn: [String(RATE), '1'], pd: [String(RATE), '1'] },
  { p: '10055', b: '500', ts: String(H0 + 86_400), ids: ['55', '222'], pn: [String(RATE + 1n), '1'], pd: [String(RATE), '1'] },
  { p: '10055', b: '900', ts: String(H0 + 2 * 86_400), ids: ['55', '222'], pn: [String(2n * RATE + 3n), '2'], pd: [String(RATE), '1'] },
]

function fakeClient(byTag: Record<string, unknown[]>, seen: Record<string, Record<string, unknown>> = {}): never {
  return {
    query: async (p: { clickhouse_settings?: { log_comment?: string }; query_params?: Record<string, unknown> }) => {
      const tag = p.clickhouse_settings?.log_comment ?? ''
      seen[tag] = p.query_params ?? {}
      const data = byTag[tag] ?? []
      return { json: async () => data, text: async () => data.map(r => JSON.stringify(r)).join('\n') }
    },
  } as never
}

describe('redemption escrow in the fold', () => {
  // The contract holds 1,000 uBIL: A's open 600 and B's open 200 (requests 1, 2) and 200 nobody requested. B cancels
  // inside hour 1 (its 200 come back); A's request is fulfilled in part inside hour 2.
  const c = UBIL.contract
  const erc20 = [
    { h: c, b: '50', d: String(1000n * E18) },
    { h: c, b: '250', d: String(-200n * E18) },
    { h: B, b: '250', d: String(200n * E18) },
  ]
  const escrowLogs = [request(40, 1, 1, A, 600n * E18), request(45, 1, 2, B, 200n * E18), cancel(250, 2, 2, 200n * E18), fulfil(350, 3, 1, A, 320n * E18, 300n * E18, true)]
  const escrowRows = (logs: typeof escrowLogs) => logs.map(l => ({ b: String(l.block), i: String(l.index), t: l.topic0, tp: l.topics, d: l.data }))
  const sources = (logs: typeof escrowLogs) => ({ 'ur:token-pegs': pegRows, 'ur:token-erc20': erc20, 'ur:token-escrow': escrowRows(logs) })

  /** Σ token_accrual per (account, class, via) over the window's daily cells. */
  const byHolder = (day: Map<string, { amount: bigint }>) => {
    const out = new Map<string, bigint>()
    for (const [k, cell] of day) {
      const [account, , stream, , via, , cls] = k.split('\u0001')
      if (stream !== 'token_accrual') continue
      const key = `${account}|${cls}|${via}`
      out.set(key, (out.get(key) ?? 0n) + cell.amount)
    }
    return out
  }

  it('books the contract\'s accrual to the requesters while their requests are open and the rest unattributed — never to the contract as a user', async () => {
    const r = await computeUserRevenueWindow(fakeClient(sources(escrowLogs)), w, null)
    const got = byHolder(r.sink.day)
    // The rate rises 1e-4 over 3 days: per hour 1e-4 / 72 of a unit.
    const perHour = (units: bigint) => (units * E18 * 10n ** 32n / 72n) / 10n ** 36n
    expect([...got.keys()].filter(k => k.startsWith(CONTRACT_ACCOUNT))).toEqual([])
    expect([...got.entries()].filter(([k]) => k.includes('|user|') && k.startsWith(ethMappedAccount(c)))).toEqual([])
    const a = got.get(`${ethMappedAccount(A)}|user|redemption-escrow:550`)!
    const b = got.get(`${ethMappedAccount(B)}|user|redemption-escrow:550`)!
    expect(a).toBeGreaterThan(0n)
    // A: 600 of 1,000 in hours 0–1, 600 of 800 in hour 2 (the partial fulfilment lands after hour 2's start).
    const income = (h: number) => perHour(h < 2 ? 1000n : 800n)
    expect(a).toBe((income(0) * 600n) / 1000n + (income(1) * 600n) / 1000n + (income(2) * 600n) / 800n)
    // B: only while its request was open (hours 0–1); afterwards it holds its 200 directly.
    expect(b).toBe((income(0) * 200n) / 1000n + (income(1) * 200n) / 1000n)
    expect(got.get(`${ethMappedAccount(B)}|user|`)).toBe(perHour(200n))
    const rest = got.get(`|unattributed|${REDEMPTION_ESCROW_REMAINDER_VIA}`)!
    const rounding = got.get('|unattributed|rounding') ?? 0n
    expect(a + b + rest + rounding).toBe(income(0) + income(1) + income(2))
    // The window's end: A's request still open for 300 — the next anchor's escrow checkpoint, with its mark.
    expect(r.anchorOut.filter(x => x.pot === escrowCheckpointPot(c))).toEqual([{ pot: escrowCheckpointPot(c), holder: A, exposure_id: '1', units: 300n * E18, aux: '' }])
    expect(r.anchorOut).toContainEqual({ pot: CHECKPOINT_POT, holder: '', exposure_id: ESCROW_CHECKPOINT_MARK, units: 1n, aux: '' })
  })

  it('opens from the month anchor\'s escrow checkpoint, reading only the logs after its block, to the same facts', async () => {
    const full = await computeUserRevenueWindow(fakeClient(sources(escrowLogs)), w, null)
    const anchor: AnchorIn = {
      block: 60,
      rows: [
        { pot: CHECKPOINT_POT, holder: '', exposure_id: 'farm|v3|vault', units: 1n, aux: '' },
        { pot: CHECKPOINT_POT, holder: '', exposure_id: 'erc20', units: 1n, aux: '' },
        { pot: CHECKPOINT_POT, holder: '', exposure_id: ESCROW_CHECKPOINT_MARK, units: 1n, aux: '' },
        { pot: `erc20:${c}`, holder: c, exposure_id: '', units: 1000n * E18, aux: '' },
        { pot: escrowCheckpointPot(c), holder: A, exposure_id: '1', units: 600n * E18, aux: '' },
        { pot: escrowCheckpointPot(c), holder: B, exposure_id: '2', units: 200n * E18, aux: '' },
      ],
    }
    const seen: Record<string, Record<string, unknown>> = {}
    const later = escrowLogs.filter(l => l.block > anchor.block)
    const resumed = await computeUserRevenueWindow(fakeClient({ ...sources(later), 'ur:token-erc20': erc20.filter(e => Number(e.b) > anchor.block) }, seen), w, anchor)
    expect(seen['ur:token-escrow']).toMatchObject({ lo: 60, hi: 400 })
    expect(byHolder(full.sink.day).get(`${ethMappedAccount(A)}|user|redemption-escrow:550`)).toBeGreaterThan(0n)
    expect(byHolder(resumed.sink.day)).toEqual(byHolder(full.sink.day))
    expect(resumed.anchorOut.filter(x => x.pot === escrowCheckpointPot(c))).toEqual(full.anchorOut.filter(x => x.pot === escrowCheckpointPot(c)))
  })
})
