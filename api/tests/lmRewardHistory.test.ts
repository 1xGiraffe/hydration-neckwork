import { describe, expect, it } from 'vitest'
import {
  buildEntryHistories, entryClaimableAt, entryHeldAt, farmRewardSeries, loadFarmRewardHistory, syncLookup,
  type CaptureRow, type DepositEventRow, type FarmEntryHistory, type FarmedHolding, type SyncPoint, type YieldFarmHistory,
} from '../src/services/lmRewardHistory.ts'
import { FIXED_ONE, loyaltyMultiplier } from '../src/services/lmRewardMath.ts'
import { assembleLpHistory, bucketPricerFrom, type OmnipoolPrincipalHistory } from '../src/services/lpHistory.ts'
import { testBucketing } from './support/bucketing.ts'
import { canonicalPlan, makeBucketing, type Bucketing } from '../src/services/bucketLadder.ts'
import { resetCacheForTests } from '../src/services/cache.ts'

// The farm-reward history: an entry's settled claimable at a block from its
// captured constants, its farm's sync series and its claims — the pallet's
// claim_rewards arithmetic (lmRewardMath) over the chain state at that block.

const F = FIXED_ONE
const CURVE = { initialRewardPercentage: F / 2n, scaleCoef: 100 }

function entry(over: Partial<FarmEntryHistory> = {}): FarmEntryHistory {
  return {
    pallet: 'omnipool', depositId: '7', globalFarmId: 1, yieldFarmId: 2,
    enteredBlock: 100, closedBlock: null,
    constants: { valuedShares: 1000n, rpvsEntry: F, enteredAt: 1000, stoppedAtCreation: 0 },
    captures: [{ block: 100, claimed: 0n }], claims: [],
    ...over,
  }
}

function farm(points: SyncPoint[], over: Partial<YieldFarmHistory> = {}): YieldFarmHistory {
  return {
    pallet: 'omnipool', globalFarmId: 1, yieldFarmId: 2, rewardAssetId: 0, loyaltyCurve: CURVE, blocksPerPeriod: 1,
    lastSyncAtOrBefore: syncLookup(points), resumes: [], terminatedBlock: null,
    ...over,
  }
}

// Syncs: the deposit's own at entry (rpvs 1.0), then 2.0 at period 1050 and 3.0 at 1100.
const SYNCS: SyncPoint[] = [
  { block: 100, eventIndex: 1, rpvs: F, period: 1000 },
  { block: 150, eventIndex: 3, rpvs: 2n * F, period: 1050 },
  { block: 300, eventIndex: 2, rpvs: 3n * F, period: 1100 },
]

describe('entryClaimableAt — claim_rewards at a block, settled', () => {
  it('is loyalty(periods) · gross at the farm\'s last sync', () => {
    // Block 200: last sync at 150 → updated_at 1050, 50 periods: loyalty (50+50)/(50+100) floored.
    const loyalty = loyaltyMultiplier(50, CURVE)
    expect(loyalty).toBe(666_666_666_666_666_666n)
    expect(entryClaimableAt(entry(), farm(SYNCS), 200)).toBe((loyalty * 1000n) / F) // 666
    // Before any accrual (the entry's own sync only): nothing.
    expect(entryClaimableAt(entry(), farm(SYNCS), 120)).toBe(0n)
  })

  it('grows its loyalty with the farm\'s periods, not the wall clock', () => {
    // Block 400: sync at 300 → 100 periods → 0.75 · 2000.
    expect(entryClaimableAt(entry(), farm(SYNCS), 400)).toBe(1500n)
    // No sync since 300: the value holds however late the block.
    expect(entryClaimableAt(entry(), farm(SYNCS), 5_000)).toBe(1500n)
  })

  it('subtracts what was claimed: the capture\'s amount plus RewardClaimed after it', () => {
    const e = entry({ claims: [{ block: 220, amount: 666n }] })
    expect(entryClaimableAt(e, farm(SYNCS), 210)).toBe(666n)
    expect(entryClaimableAt(e, farm(SYNCS), 250)).toBe(0n)
    // Claiming early forfeits nothing: later, loyalty(later) · gross − claimed.
    expect(entryClaimableAt(e, farm(SYNCS), 400)).toBe(1500n - 666n)
    // A later capture restates claimed at its block; claims up to it are in it.
    const recaptured = entry({ captures: [{ block: 100, claimed: 0n }, { block: 260, claimed: 666n }], claims: [{ block: 220, amount: 666n }] })
    expect(entryClaimableAt(recaptured, farm(SYNCS), 400)).toBe(1500n - 666n)
  })

  it('pays nothing once the yield farm is terminated', () => {
    const f = farm(SYNCS, { terminatedBlock: 1_200 })
    expect(entryClaimableAt(entry(), f, 1_199)).toBe(1500n)
    expect(entryClaimableAt(entry(), f, 1_200)).toBe(0n)
  })

  it('does not count a stopped stretch toward loyalty after a resume', () => {
    // Stopped after the sync at 300 (updated_at 1100); resumed at block 500,
    // period 1400: total_stopped += 300. Synced at 600 (period 1450, rpvs 4.0).
    const points = [...SYNCS, { block: 600, eventIndex: 1, rpvs: 4n * F, period: 1450 }]
    const f = farm(points, { resumes: [{ block: 500, eventIndex: 4, period: 1400 }] })
    // 1450 − 1000 − 300 = 150 periods → (150 + 50) / (150 + 100) = 0.8 · 3000.
    expect(entryClaimableAt(entry(), f, 700)).toBe(2400n)
    // An entry created after the resume carries the stop in its stopped_at_creation.
    const late = entry({ enteredBlock: 550, constants: { valuedShares: 1000n, rpvsEntry: 3n * F, enteredAt: 1420, stoppedAtCreation: 300 }, captures: [{ block: 550, claimed: 0n }] })
    expect(entryClaimableAt(late, f, 700)).toBe((loyaltyMultiplier(30, CURVE) * 1000n) / F)
  })

  it('states nothing it cannot: no creation capture, rpvs below the entry', () => {
    expect(entryClaimableAt(entry({ constants: null }), farm(SYNCS), 400)).toBeNull()
    const bad = entry({ constants: { valuedShares: 1000n, rpvsEntry: 9n * F, enteredAt: 1000, stoppedAtCreation: 0 } })
    expect(entryClaimableAt(bad, farm(SYNCS), 400)).toBeNull()
  })

  it('without a loyalty curve pays the whole gross', () => {
    expect(entryClaimableAt(entry(), farm(SYNCS, { loyaltyCurve: null }), 400)).toBe(2000n)
  })
})

describe('buildEntryHistories — lives from the deposit events', () => {
  const ev = (kind: string, block: number, idx: number, yf: number, amount = '0', deposit = '7'): DepositEventRow =>
    ({ pallet: 'omnipool', deposit_id: deposit, yield_farm_id: yf, global_farm_id: 1, block_height: block, event_index: idx, event_kind: kind, amount_s: amount })
  const cap = (block: number, yf: number, claimed: string, over: Partial<CaptureRow> = {}): CaptureRow =>
    ({ pallet: 'omnipool', deposit_id: '7', yield_farm_id: yf, global_farm_id: 1, block_height: block, capture_status: 'ok', is_event_entry: 1, valued_s: '1000', rpvs_entry_s: String(F), claimed_s: claimed, entered_at_period: 1000, stopped_at_creation: 0, ...over })

  it('opens on deposit/redeposit, closes on withdraw or destroy, and keeps re-entries apart', () => {
    const lives = buildEntryHistories([
      ev('deposited', 100, 5, 2), ev('claimed', 200, 1, 2, '50'), ev('redeposited', 300, 2, 3),
      ev('withdrawn', 400, 1, 2), ev('redeposited', 500, 1, 2), ev('destroyed', 900, 3, 0),
      // A replayed row (same block and event index) is one event.
      ev('claimed', 200, 1, 2, '50'),
    ], [cap(100, 2, '0'), cap(300, 2, '50', { is_event_entry: 0 }), cap(300, 3, '0'), cap(500, 2, '0', { entered_at_period: 1300 })])
    expect(lives.map(l => [l.yieldFarmId, l.enteredBlock, l.closedBlock])).toEqual([[2, 100, 400], [3, 300, 900], [2, 500, 900]])
    expect(lives[0].claims).toEqual([{ block: 200, amount: 50n }])
    expect(lives[0].captures).toEqual([{ block: 100, claimed: 0n }, { block: 300, claimed: 50n }])
    expect(lives[2].constants?.enteredAt).toBe(1300)
    expect(entryHeldAt(lives[0], 399)).toBe(true)
    expect(entryHeldAt(lives[0], 400)).toBe(false)
  })

  it('leaves a life without its creation capture unstated', () => {
    const [life] = buildEntryHistories([ev('deposited', 100, 5, 2)], [cap(300, 2, '0')])
    expect(life.constants).toBeNull()
  })

  it('ignores a gone_at_block_end capture', () => {
    const [life] = buildEntryHistories([ev('deposited', 100, 5, 2), ev('withdrawn', 100, 9, 2)], [cap(100, 2, '0', { capture_status: 'gone_at_block_end' })])
    expect(life.closedBlock).toBe(100)
    expect(life.constants).toBeNull()
  })
})

describe('farmRewardSeries — per bucket end', () => {
  const bk = testBucketing(0, 100, 9) // ends 99, 199, …, 999
  const holding = (over: Partial<FarmedHolding> = {}): FarmedHolding => ({ pallet: 'omnipool', depositId: '7', positionId: '42', lpAssetId: null, fromBlock: 100, toBlock: 0, ...over })

  it('states each held entry, only while the account holds the deposit', () => {
    const farms = new Map([['omnipool:2', farm(SYNCS)]])
    const out = farmRewardSeries([holding({ toBlock: 450 })], [entry()], farms, bk)
    expect(out.itemsByBucket[0]).toEqual([]) // before the deposit
    expect(out.itemsByBucket[1].map(i => i.amount)).toEqual([666n])
    expect(out.itemsByBucket[3]).toEqual([expect.objectContaining({ positionId: '42', depositId: '7', yieldFarmId: 2, rewardAssetId: 0, amount: 1500n })])
    expect(out.itemsByBucket[4]).toEqual([]) // the deposit NFT moved away at 450
    expect(out.rewardAssetIds).toEqual([0])
  })

  it('counts an entry it cannot state instead of valuing it at zero', () => {
    const out = farmRewardSeries([holding()], [entry({ constants: null }), entry({ yieldFarmId: 9 })], new Map([['omnipool:2', farm(SYNCS)]]), bk)
    expect(out.itemsByBucket[3]).toEqual([])
    expect(out.incompleteByBucket[3]).toEqual({ omnipool: 2, xyk: 0 }) // uncaptured + unknown farm
  })

  it('counts one deposit once when two intervals of the accounts overlap it', () => {
    const out = farmRewardSeries([holding(), holding()], [entry()], new Map([['omnipool:2', farm(SYNCS)]]), bk)
    expect(out.itemsByBucket[3]).toHaveLength(1)
  })
})

describe('loadFarmRewardHistory — reads', () => {
  const ACC = `0x${'ab'.repeat(32)}`
  type Row = Record<string, unknown>
  function client(route: (q: string, p: Record<string, unknown>) => Row[] | undefined) {
    const seen: string[] = []
    return {
      seen,
      query: async (o: { query: string; query_params?: Record<string, unknown> }) => {
        seen.push(o.query)
        return { json: async () => route(o.query, o.query_params ?? {}) ?? [] }
      },
    }
  }
  const bk = testBucketing(0, 100, 4) // ends 99 … 499

  it('stops after the intervals when the accounts never farmed', async () => {
    const c = client(() => [])
    const out = await loadFarmRewardHistory(c as never, [ACC], bk)
    expect(out.itemsByBucket.every(b => b.length === 0)).toBe(true)
    expect(c.seen.map(q => q.split('\n')[0].trim())).toEqual(['-- lm:farmed-omnipool-intervals', '-- lm:farmed-xyk-intervals'])
  })

  it('dates a sync in Initialization by the previous block\'s relay parent', async () => {
    const c = client((q) => {
      if (q.includes('-- lm:farmed-omnipool-intervals')) return [{ position_id: '42', deposit_id: '7', valid_from_block: 100, valid_to_block: 0 }]
      if (q.includes('-- lm:deposit-events')) return [{ pallet: 'omnipool', deposit_id: '7', yield_farm_id: 2, global_farm_id: 1, block_height: 100, event_index: 5, event_kind: 'deposited', amount_s: '0' }]
      if (q.includes('-- lm:entry-captures')) return [{ pallet: 'omnipool', deposit_id: '7', yield_farm_id: 2, global_farm_id: 1, block_height: 100, capture_status: 'ok', is_event_entry: 1, valued_s: '1000', rpvs_entry_s: String(F), claimed_s: '0', entered_at_period: 1000, stopped_at_creation: 0 }]
      // One sync per bucket, the one in bucket 2 a scheduled call (Initialization).
      if (q.includes('-- lm:farm-syncs-by-bucket')) return [
        { pallet: 'omnipool', yield_farm_id: 2, b: 1, blk: 150, idx: 3, ph: 'ApplyExtrinsic', rpvs: String(2n * F) },
        { pallet: 'omnipool', yield_farm_id: 2, b: 2, blk: 250, idx: 0, ph: 'Initialization', rpvs: String(3n * F) },
      ]
      if (q.includes('-- lm:farm-configs')) return [
        { pallet: 'omnipool_lm', event_name: 'GlobalFarmCreated', global_farm_id: 1, yield_farm_id: null, args_json: JSON.stringify({ id: 1, rewardCurrency: 0, blocksPerPeriod: 1 }) },
        { pallet: 'omnipool_lm', event_name: 'YieldFarmCreated', global_farm_id: 1, yield_farm_id: 2, args_json: JSON.stringify({ loyaltyCurve: { initialRewardPercentage: String(F / 2n), scaleCoef: 100 } }) },
      ]
      if (q.includes('-- lm:relay-heights')) return [{ block_height: 150, relay: 1050 }, { block_height: 249, relay: 1100 }, { block_height: 250, relay: 1101 }]
      return []
    })
    const out = await loadFarmRewardHistory(c as never, [ACC], bk)
    // Bucket 2 ends at 299: rpvs 3.0 at period 1100 (block 249's relay), not 1101.
    expect(out.itemsByBucket[2].map(i => i.amount)).toEqual([1500n])
    expect(out.itemsByBucket[1].map(i => i.amount)).toEqual([666n])
    const relayQuery = c.seen.find(q => q.includes('-- lm:relay-heights'))
    expect(relayQuery).toBeDefined()
  })

  // The rows of one omnipool entry (deposit 7, farm 2) created at block 100.
  const created = (q: string, over: { eventIndex?: number } = {}) => {
    if (q.includes('-- lm:farmed-omnipool-intervals')) return [{ position_id: '42', deposit_id: '7', valid_from_block: 100, valid_to_block: 0 }]
    if (q.includes('-- lm:deposit-events')) return [{ pallet: 'omnipool', deposit_id: '7', yield_farm_id: 2, global_farm_id: 1, block_height: 100, event_index: over.eventIndex ?? 5, event_kind: 'deposited', amount_s: '0' }]
    if (q.includes('-- lm:entry-captures')) return [{ pallet: 'omnipool', deposit_id: '7', yield_farm_id: 2, global_farm_id: 1, block_height: 100, capture_status: 'ok', is_event_entry: 1, valued_s: '1000', rpvs_entry_s: String(2n * F), claimed_s: '0', entered_at_period: 1000, stopped_at_creation: 0 }]
    if (q.includes('-- lm:farm-configs')) return [
      { pallet: 'omnipool_lm', event_name: 'GlobalFarmCreated', global_farm_id: 1, yield_farm_id: null, args_json: JSON.stringify({ id: 1, rewardCurrency: 0, blocksPerPeriod: 1 }) },
      { pallet: 'omnipool_lm', event_name: 'YieldFarmCreated', global_farm_id: 1, yield_farm_id: 2, args_json: JSON.stringify({ loyaltyCurve: null }) },
    ]
    return undefined
  }

  it('reads a same-block sync that ran before the entry (Initialization, then the deposit) as the rpvs it entered at', async () => {
    // Block 100: a scheduled call syncs the farm in Initialization (to rpvs 2.0,
    // period 999 — the PREVIOUS block's relay parent), then the deposit enters at
    // 2.0 in ApplyExtrinsic. The sync is in the creation bucket and at the entry's
    // block, yet it accrues the entry nothing; the next sync (block 250) does.
    const c = client((q) => created(q) ?? (
      q.includes('-- lm:farm-syncs-by-bucket') ? [
        { pallet: 'omnipool', yield_farm_id: 2, b: 1, blk: 100, idx: 0, ph: 'Initialization', rpvs: String(2n * F) },
        { pallet: 'omnipool', yield_farm_id: 2, b: 2, blk: 250, idx: 3, ph: 'ApplyExtrinsic', rpvs: String(3n * F) },
      ]
      : q.includes('-- lm:relay-heights') ? [{ block_height: 99, relay: 999 }, { block_height: 100, relay: 1000 }, { block_height: 250, relay: 1150 }]
      : []))
    const out = await loadFarmRewardHistory(c as never, [ACC], bk)
    expect(out.incompleteByBucket[1]).toEqual({ omnipool: 0, xyk: 0 })
    expect(out.itemsByBucket[1].map(i => i.amount)).toEqual([0n]) // rpvs = rpvs_entry at the creation bucket
    expect(out.itemsByBucket[2].map(i => i.amount)).toEqual([1000n]) // (3.0 − 2.0) · 1000, no loyalty curve
    // The Initialization sync is dated by block 99's relay parent.
    expect(c.seen.find(q => q.includes('-- lm:relay-heights'))).toBeDefined()
  })

  it('counts a same-block sync that ran after a scheduled entry (Initialization, then ApplyExtrinsic)', () => {
    // Entered in Initialization at period 1000 (the previous block's relay), then an
    // extrinsic in the same block synced the farm on this block's relay (period
    // 1001, rpvs 2.5): that accrual is the entry's.
    const e = entry({ enteredBlock: 100, constants: { valuedShares: 1000n, rpvsEntry: 2n * F, enteredAt: 1000, stoppedAtCreation: 0 } })
    const f = farm([{ block: 100, eventIndex: 9, rpvs: (5n * F) / 2n, period: 1001 }], { loyaltyCurve: null })
    expect(entryClaimableAt(e, f, 199)).toBe(500n)
  })

  it('binds the (pallet, deposit_id) and (pallet, yield_farm_id) keys as two flat arrays each (arrayZip)', async () => {
    // @clickhouse/client serialises a nested JS array as [[…]] and cannot bind an
    // Array(Tuple(…)) parameter: every key parameter must be a flat scalar array.
    const params: Array<{ tag: string; p: Record<string, unknown>; q: string }> = []
    const inner = client((q) => created(q) ?? (q.includes('-- lm:farm-syncs-by-bucket') ? [{ pallet: 'omnipool', yield_farm_id: 2, b: 1, blk: 150, idx: 3, ph: 'ApplyExtrinsic', rpvs: String(3n * F) }] : q.includes('-- lm:relay-heights') ? [{ block_height: 150, relay: 1050 }] : []))
    const c = { seen: inner.seen, query: async (o: { query: string; query_params?: Record<string, unknown>; clickhouse_settings?: Record<string, unknown> }) => {
      params.push({ tag: String(o.clickhouse_settings?.log_comment ?? ''), p: o.query_params ?? {}, q: o.query })
      return inner.query(o)
    } }
    await loadFarmRewardHistory(c as never, [ACC], bk)
    const flat = (v: unknown, scalar: 'string' | 'number') => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === scalar)
    for (const tag of ['lm:deposit-events', 'lm:entry-captures']) {
      const r = params.find(x => x.tag === tag)!
      expect(r.q).toContain('(pallet, deposit_id) IN arrayZip({depPallets:Array(String)}, {depIds:Array(String)})')
      expect(flat(r.p.depPallets, 'string') && flat(r.p.depIds, 'string')).toBe(true)
      expect(r.p).toEqual({ depPallets: ['omnipool'], depIds: ['7'] })
    }
    for (const tag of ['lm:farm-syncs-by-bucket', 'lm:farm-states']) {
      const r = params.find(x => x.tag === tag)!
      expect(r.q).toContain('(pallet, yield_farm_id) IN arrayZip({farmPallets:Array(String)}, {farmIds:Array(UInt32)})')
      expect(r.p).toMatchObject({ farmPallets: ['omnipool'], farmIds: [2] })
    }
    // Every read is named in system.query_log (log_comment), not only in its SQL comment.
    expect(params.every(x => x.tag && x.q.trimStart().startsWith(`-- ${x.tag}`))).toBe(true)
  })

  it('states a farm without its creation config as incomplete', async () => {
    const c = client((q) => {
      if (q.includes('-- lm:farmed-xyk-intervals')) return [{ deposit_id: '3', lp_asset_id: 1000227, valid_from_block: 100, valid_to_block: 0 }]
      if (q.includes('-- lm:deposit-events')) return [{ pallet: 'xyk', deposit_id: '3', yield_farm_id: 4, global_farm_id: 3, block_height: 100, event_index: 5, event_kind: 'deposited', amount_s: '0' }]
      if (q.includes('-- lm:entry-captures')) return [{ pallet: 'xyk', deposit_id: '3', yield_farm_id: 4, global_farm_id: 3, block_height: 100, capture_status: 'ok', is_event_entry: 1, valued_s: '1000', rpvs_entry_s: String(F), claimed_s: '0', entered_at_period: 1000, stopped_at_creation: 0 }]
      return []
    })
    const out = await loadFarmRewardHistory(c as never, [ACC], bk)
    expect(out.incompleteByBucket[2]).toEqual({ omnipool: 0, xyk: 1 })
  })
})

describe('assembleLpHistory — rewards beside the principal', () => {
  const USD = 10n ** 12n
  const bk = { N: 1, endSec: (b: number) => 100 + b }
  const pricer = bucketPricerFrom(new Map([[5, [{ closedAt: 0, close: 2n * USD }]], [0, [{ closedAt: 0, close: USD }]]]), bk)
  const omni: OmnipoolPrincipalHistory = {
    legsByBucket: [[{ positionId: '42', assetId: 5, liquidity: USD, hub: 0n, shares: USD, farmed: true, depositId: '7' }], [{ positionId: '42', assetId: 5, liquidity: USD, hub: 0n, shares: USD, farmed: true, depositId: '7' }]],
    assetIds: [5], fromBucket: 0, spans: new Map(),
  }
  const item = (amount: bigint, rewardAssetId = 0, positionId = '42') => ({ pallet: 'omnipool' as const, depositId: '7', positionId, lpAssetId: null, globalFarmId: 1, yieldFarmId: 2, rewardAssetId, amount })
  const rewards = {
    itemsByBucket: [[item(3n * USD)], [item(4n * USD), item(1n * USD, 99, '43')]],
    incompleteByBucket: [{ omnipool: 0, xyk: 0 }, { omnipool: 1, xyk: 0 }],
    rewardAssetIds: [0, 99],
  }

  it('attaches each entry to its farmed position and sums the account line apart from the principal', () => {
    const out = assembleLpHistory({ omnipool: omni, rewards }, pricer, bk)
    expect(out.points[0]).toMatchObject({ usd: 2n * USD, rewardsUsd: 3n * USD, rewardsIncomplete: 0 })
    // Asset 99 has no price: out of the sum, counted — and an entry whose position
    // the history does not list (43) is still the account's.
    expect(out.points[1]).toMatchObject({ usd: 2n * USD, rewardsUsd: 4n * USD, rewardsIncomplete: 2 })
    const [pos] = out.positions
    expect(pos.points[0].usd).toBe(2n * USD) // never folded into the position
    expect(pos.points[1].rewards).toEqual([{ depositId: '7', globalFarmId: 1, yieldFarmId: 2, assetId: 0, amount: 4n * USD, usd: 4n * USD }])
  })

  it('narrows the rewards with the venue filter', () => {
    const out = assembleLpHistory({ omnipool: omni, rewards, venues: new Set(['xyk']) }, pricer, bk)
    expect(out.points[1]).toMatchObject({ rewardsUsd: 0n, rewardsIncomplete: 0 })
  })
})

describe('chartFarmRewardSeries — the value chart\'s reward series', () => {
  it('prices each bucket\'s entries at the chart price and drops HDX rewards from the ex-HDX curve', async () => {
    const { chartFarmRewardSeries } = await import('../src/services/explorerService.ts')
    const item = (rewardAssetId: number, amount: bigint) => ({ pallet: 'omnipool' as const, depositId: '7', positionId: '42', lpAssetId: null, globalFarmId: 1, yieldFarmId: 2, rewardAssetId, amount })
    const rewards = { itemsByBucket: [[], [item(0, 2n * 10n ** 12n), item(5, 10n ** 12n)]], incompleteByBucket: [{ omnipool: 0, xyk: 0 }, { omnipool: 0, xyk: 0 }], rewardAssetIds: [0, 5] }
    const price = (id: string) => (id === '0' ? 0.5 : 3)
    const out = chartFarmRewardSeries(rewards, price, () => 12)
    expect(out.total).toEqual([0, 4])
    expect(out.exHdx).toEqual([0, 3])
  })
})

// On a canonical grid the farm syncs and states are folded once for EVERY farm
// and shared by every account on the grid; the account's head bucket adds the
// syncs since the lattice boundary below it. Same amounts as its own-grid fold.
describe('loadFarmRewardHistory on a canonical grid', () => {
  const ACC = `0x${'cd'.repeat(32)}`
  const HOUR = 3_600
  const T0 = 1_000 * HOUR
  const heightAt = (sec: number) => (sec < T0 ? null : 200_000 + Math.floor((sec - T0) / 6))
  const END = T0 + 400 * HOUR + 500
  const grid = (from: number, dated: boolean) => makeBucketing({ hours: [], heights: [], builtAt: 0 }, from, END, heightAt(from)!, undefined, undefined,
    dated ? { stepSec: HOUR, heightAt, dating: { key: 'exact', heightAt } } : { stepSec: HOUR, heightAt })
  // Syncs every ~20 hours of blocks, one inside the head bucket's tail.
  const syncs = Array.from({ length: 30 }, (_, i) => ({ blk: 200_000 + 12_000 * i + 7, idx: 1, ph: 'ApplyExtrinsic', rpvs: String(BigInt(i + 2) * F) }))
    .concat([{ blk: heightAt(END)! - 10, idx: 2, ph: 'ApplyExtrinsic', rpvs: String(40n * F) }])
  const ENTRY = 200_050
  function fake(own: Bucketing) {
    const seen: Array<{ query: string; params: Record<string, unknown> }> = []
    const bucketed = (bk: Bucketing, rows: typeof syncs) => {
      const by = new Map<number, (typeof syncs)[number]>()
      for (const r of rows) {
        if (r.blk > bk.endHeight(bk.N)) continue
        const b = r.blk < bk.floorHeight ? -1 : bk.bucketOfHeight(r.blk)
        const prev = by.get(b)
        if (!prev || r.blk > prev.blk) by.set(b, r)
      }
      return [...by].map(([b, r]) => ({ pallet: 'omnipool', yield_farm_id: 2, b, ...r }))
    }
    return {
      seen,
      query: async (o: { query: string; query_params?: Record<string, unknown> }) => {
        const q = o.query
        const p = o.query_params ?? {}
        seen.push({ query: q, params: p })
        const rows = ((): Record<string, unknown>[] => {
          if (q.includes('-- lm:farmed-omnipool-intervals')) return [{ position_id: '42', deposit_id: '7', valid_from_block: ENTRY, valid_to_block: 0 }]
          if (q.includes('-- lm:deposit-events')) return [{ pallet: 'omnipool', deposit_id: '7', yield_farm_id: 2, global_farm_id: 1, block_height: ENTRY, event_index: 5, event_kind: 'deposited', amount_s: '0' }]
          if (q.includes('-- lm:entry-captures')) return [{ pallet: 'omnipool', deposit_id: '7', yield_farm_id: 2, global_farm_id: 1, block_height: ENTRY, capture_status: 'ok', is_event_entry: 1, valued_s: '1000', rpvs_entry_s: String(2n * F), claimed_s: '0', entered_at_period: 201_000, stopped_at_creation: 0 }]
          if (q.includes('-- lm:farm-configs')) return [
            { pallet: 'omnipool_lm', event_name: 'GlobalFarmCreated', global_farm_id: 1, yield_farm_id: null, args_json: JSON.stringify({ id: 1, rewardCurrency: 0, blocksPerPeriod: 1 }) },
            { pallet: 'omnipool_lm', event_name: 'YieldFarmCreated', global_farm_id: 1, yield_farm_id: 2, args_json: JSON.stringify({ loyaltyCurve: null }) },
          ]
          if (q.includes('-- lm:farm-syncs-by-bucket')) return bucketed(p.farmPallets ? own : canonicalPlan(own)!.grid.bk, syncs)
          if (q.includes('-- lm:farm-syncs-tail')) {
            const [, from, to] = /block_height >= (\d+) AND block_height <= (\d+)/.exec(q)!
            const hit = syncs.filter(s => s.blk >= Number(from) && s.blk <= Number(to)).sort((a, b) => b.blk - a.blk)[0]
            return hit ? [{ pallet: 'omnipool', yield_farm_id: 2, b: own.N, ...hit }] : []
          }
          if (q.includes('-- lm:relay-heights')) return (p.hs as number[]).map(h => ({ block_height: h, relay: h + 1_000 }))
          return []
        })()
        return { json: async () => rows }
      },
    }
  }

  it('folds every farm once per grid, shared by accounts, with the amounts of the account\'s own fold', async () => {
    resetCacheForTests()
    const shared = fake(grid(T0 + 300 * HOUR, true))
    for (const from of [T0 + 300 * HOUR, T0 + 350 * HOUR]) {
      const dated = grid(from, true)
      const own = grid(from, false)
      expect(canonicalPlan(dated)?.tail).not.toBeNull()
      expect(canonicalPlan(own)).toBeNull()
      const viaCanon = await loadFarmRewardHistory({ ...shared, query: fake(dated).query } as never, [ACC], dated)
      const viaOwn = await loadFarmRewardHistory(fake(own) as never, [ACC], own)
      expect(viaCanon.itemsByBucket.map(b => b.map(i => i.amount))).toEqual(viaOwn.itemsByBucket.map(b => b.map(i => i.amount)))
      expect(viaCanon.itemsByBucket.at(-1)![0].amount).toBe(38_000n) // (40 − 2) · 1000, the tail's sync
    }
    // The shared client: one canonical fold (no farm filter) for both accounts.
    resetCacheForTests()
    const c = fake(grid(T0 + 300 * HOUR, true))
    for (const from of [T0 + 300 * HOUR, T0 + 350 * HOUR]) await loadFarmRewardHistory(c as never, [ACC], grid(from, true))
    const folds = c.seen.filter(s => s.query.includes('-- lm:farm-syncs-by-bucket'))
    expect(folds).toHaveLength(1)
    expect(folds[0].params.farmPallets).toBeUndefined()
    expect(c.seen.filter(s => s.query.includes('-- lm:farm-syncs-tail'))).toHaveLength(2)
    expect(c.seen.filter(s => s.query.includes('-- lm:farm-states') && !s.query.includes('-- lm:farm-states-tail'))).toHaveLength(1)
    // Relay heights are memoized per client: the second account asks only for blocks the first did not.
    const relayAsks = c.seen.filter(s => s.query.includes('-- lm:relay-heights')).flatMap(s => s.params.hs as number[])
    expect(new Set(relayAsks).size).toBe(relayAsks.length)
  })
})
