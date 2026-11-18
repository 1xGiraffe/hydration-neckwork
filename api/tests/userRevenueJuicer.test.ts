import { describe, expect, it } from 'vitest'
import { DEAD_ADDRESS, JUICER_FEE_CONTROLLER, JUICER_SUBLOOP, JUICER_TOPIC, JUICER_VAULTS, JUICER_YIELD_ACCOUNTING, decodeJuicerLog, type JuicerEvent, type JuicerLogRow } from '../src/services/juicer.ts'
import {
  JUICER_FEE_VIA, JUICER_LOOP_UNSPLIT_VIA, JUICER_LOOP_VIA, JUICER_REMAINDER_VIA,
  juicerFeeBpsAt, juicerLoopSplitAt, juicerRequestSpans, juicerVaultClaimants, juicerVaultVia, loadJuicerCustody,
} from '../src/services/userRevenueJuicer.ts'
import type { FoldWindow, Ledger } from '../src/services/userRevenueFold.ts'
import { USER_REVENUE_RULE_ERAS, ethMappedAccount, holderClassOf } from '../src/services/userRevenueStreams.ts'
import { pegBucketFingerprints } from '../src/services/userRevenueTokens.ts'

const VAULT = JUICER_VAULTS[0]
const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0')
const addrWord = (a: string) => '0x' + a.slice(2).padStart(64, '0')
const idWord = (n: number) => '0x' + word(n)
const ALICE = '0x' + 'a1'.repeat(20), BOB = '0x' + 'b2'.repeat(20), CAROL = '0x' + 'c3'.repeat(20)
const VAULT_B = '0x' + 'ee'.repeat(20)

function log(block: number, eventIndex: number, contract: string, topic0: string, topics: string[], data: Array<bigint | number>): JuicerLogRow {
  return { block_height: block, event_index: eventIndex, extrinsic_index: 1, ts: '2026-11-10 00:00:00', contract_address: contract, topic0, topics: [topic0, ...topics], data: '0x' + data.map(word).join('') }
}
const decode = (rows: JuicerLogRow[]) => rows.map(decodeJuicerLog).filter((e): e is JuicerEvent => e != null)

const LOGS = [
  log(50, 1, JUICER_SUBLOOP, JUICER_TOPIC.LoopDeposited, [addrWord(VAULT.vault)], [1000n, 1000n]),
  log(50, 2, JUICER_FEE_CONTROLLER, JUICER_TOPIC.ProtocolFeeUpdated, [addrWord(VAULT.vault)], [500, 6900]),
  log(150, 1, VAULT.vault, JUICER_TOPIC.RedeemRequested, [idWord(1), addrWord(CAROL)], [20n]),
  log(250, 1, VAULT.vault, JUICER_TOPIC.UnwindStarted, [idWord(1)], [19n, 5n]),
]

describe('a vault\'s claimants', () => {
  const requests = juicerRequestSpans(decode(LOGS))

  it('are the share holders and every request still earning, never the custody accounts', () => {
    const wallet = new Map([[ALICE, 60n], [BOB, 30n], [DEAD_ADDRESS, 10n], [JUICER_YIELD_ACCOUNTING, 0n], [VAULT.vault, 20n]])
    // At 200 Carol's 20 shares sit in the vault's escrow, her request in its cooldown: hers.
    expect(juicerVaultClaimants(VAULT.vault, wallet, requests, 200)).toEqual({ claimants: [[ALICE, 60n], [BOB, 30n], [CAROL, 20n]], outstanding: 120n })
    // At 300 its unwind has started: the collateral owed is fixed, the escrowed shares earn for no one.
    expect(juicerVaultClaimants(VAULT.vault, wallet, requests, 300)).toEqual({ claimants: [[ALICE, 60n], [BOB, 30n]], outstanding: 120n })
  })

  it('reads the fee rate in force and the loop\'s split', () => {
    const events = decode(LOGS)
    expect(juicerFeeBpsAt(events, VAULT.vault, 49)).toBe(0n)
    expect(juicerFeeBpsAt(events, VAULT.vault, 50)).toBe(6900n)
    expect(juicerLoopSplitAt(events, [], 49)).toBeNull()
    expect(juicerLoopSplitAt(events, [], 50)).toEqual({ units: new Map([[VAULT.vault, 1n]]), total: 1n })
    // A second vault funds the loop: the split is the pinned read at or before the block, or unknown.
    const two = decode([...LOGS, log(400, 1, JUICER_SUBLOOP, JUICER_TOPIC.LoopDeposited, [addrWord(VAULT_B)], [10n, 10n])])
    expect(juicerLoopSplitAt(two, [], 400)).toBeNull()
    const reads = [{ vault: VAULT.vault, block: 410, shares: 3n, total: 4n }, { vault: VAULT_B, block: 410, shares: 1n, total: 4n }]
    expect(juicerLoopSplitAt(two, reads, 405)).toBeNull()
    expect(juicerLoopSplitAt(two, reads, 420)).toEqual({ units: new Map([[VAULT.vault, 3n], [VAULT_B, 1n]]), total: 4n })
  })
})

const H0 = Date.UTC(2026, 10, 10) / 1000
const W: FoldWindow = {
  month: 202611, monthStart: Date.UTC(2026, 10, 1) / 1000, monthEnd: Date.UTC(2026, 11, 1) / 1000, fromHour: H0, hours: 3,
  openBlock: 100, openTs: H0 - 6,
  hourBlocks: [{ first: 101, last: 200, lastTs: H0 + 3590 }, { first: 201, last: 300, lastTs: H0 + 7190 }, { first: 301, last: 400, lastTs: H0 + 10790 }],
  lastBlock: 400,
}
function fakeClient(byTag: Record<string, unknown[]>): never {
  return { query: async (p: { clickhouse_settings?: { log_comment?: string } }) => ({ json: async () => byTag[p.clickhouse_settings?.log_comment ?? ''] ?? [] }) } as never
}
const ledger = (holder: string, amounts: bigint[]): Ledger => ({ holder, stream: 'token_accrual', pot: 'token:43', via: 'atoken:1043', asset: 222, held: null, price: 'accrual', amounts })

describe('loadJuicerCustody — the loop to its vaults, a vault to its holders', () => {
  const client = fakeClient({
    'ur:juicer-logs': LOGS,
    'ur:juicer-loop-shares': [],
    // jETH transfers: Alice 60, Bob 30, the burn address 10, Carol 20 — then Carol's request escrows hers at 150.
    'ur:token-erc20': [
      { h: ALICE, b: '60', d: '60' }, { h: BOB, b: '60', d: '30' }, { h: DEAD_ADDRESS, b: '60', d: '10' }, { h: CAROL, b: '60', d: '20' },
      { h: CAROL, b: '150', d: '-20' }, { h: VAULT.vault, b: '150', d: '20' },
    ],
  })
  const accountOf = (h: string) => ethMappedAccount(h)

  it('gives the protocol its fee share of the loop\'s income and the vault the rest', async () => {
    const { resolvers, protocolAccounts } = await loadJuicerCustody(client, W, accountOf)
    const res = await resolvers.get(ethMappedAccount(JUICER_SUBLOOP))!.resolve(ledger(ethMappedAccount(JUICER_SUBLOOP), [1000n, 1000n, 1000n]))
    const fee = res.parts.find(p => p.holder === ethMappedAccount(JUICER_FEE_CONTROLLER))!
    const vault = res.parts.find(p => p.holder === ethMappedAccount(VAULT.vault))!
    expect(fee.amounts).toEqual([690n, 690n, 690n])
    expect(fee.via).toBe(`atoken:1043>${JUICER_LOOP_VIA}>${JUICER_FEE_VIA}`)
    expect(vault.amounts).toEqual([310n, 310n, 310n])
    expect(vault.via).toBe(`atoken:1043>${JUICER_LOOP_VIA}`)
    expect(res.remainderVia).toBe(JUICER_LOOP_UNSPLIT_VIA)
    expect(res.remainder).toEqual([0n, 0n, 0n])
    // The fee controller (and each Main debt ledger) is the protocol's: its share books to the protocol class.
    expect(protocolAccounts).toContain(ethMappedAccount(JUICER_FEE_CONTROLLER))
    expect(holderClassOf(ethMappedAccount(JUICER_FEE_CONTROLLER), new Set())).toBe('protocol')
    expect(holderClassOf(ethMappedAccount(VAULT.mainDebt), new Set())).toBe('protocol')
  })

  it('passes a vault\'s income to its holders by their units, the custody\'s share unattributed', async () => {
    const { resolvers } = await loadJuicerCustody(client, W, accountOf)
    const res = await resolvers.get(ethMappedAccount(VAULT.vault))!.resolve(ledger(ethMappedAccount(VAULT.vault), [120n, 120n, 120n]))
    const of = (h: string) => res.parts.find(p => p.holder === ethMappedAccount(h))?.amounts
    // Hour 0 (block 100): Carol still holds hers. Hour 1 (200): her request earns for her. Hour 2 (300): unwinding.
    expect(of(ALICE)).toEqual([60n, 60n, 60n])
    expect(of(BOB)).toEqual([30n, 30n, 30n])
    expect(of(CAROL)).toEqual([20n, 20n, 0n])
    expect(res.remainder).toEqual([10n, 10n, 30n])
    expect(res.remainderVia).toBe(JUICER_REMAINDER_VIA)
    for (const p of res.parts) {
      expect(p.via).toBe(`atoken:1043>${juicerVaultVia(VAULT)}`)
      expect(p.held).toBe(VAULT.shareAssetId)
    }
  })
})

describe('the Juicer rule era', () => {
  it('re-marks the buckets from the deployment on, and none before', () => {
    const era = USER_REVENUE_RULE_ERAS.find(e => e.id === 'juicer')!
    const before = [era.fromTs - 7200, era.fromTs - 3600] as const
    const across = [era.fromTs - 600, era.fromTs + 3000] as const
    const after = [era.fromTs + 86_400, era.fromTs + 90_000] as const
    const [b, x, a] = pegBucketFingerprints(new Map(), [before, across, after])
    expect(b).toBe(0n)
    expect(x).not.toBe(0n)
    expect(a).toBe(x)
  })
})
