import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  dropTreasuryFeeLegs,
  feedRangeBoundsSql,
  feedWindowBoundSql,
  initExplorerService,
  nonPlumbingTransferLegSql,
  type AccountRef,
} from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

const TREASURY_POT = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'
const DONOR = '0xb2927ffd2bbb0a73a317ab830e2dccd5e30cb0231c3ce7224be0f233b330742f'
const PAYER = '0xb2049c4350cbd8b4c276d47d73fc6e34738723a3164eb907b5de5aa21e0b4744'
const PEER = '0x41ddf2ded434f3b236eca63124ea45b9034a03249dec7b072c2b4efa8efa3eae'

const account = (accountId: string): AccountRef =>
  ({ accountId, address: accountId, emoji: '🦒', tag: null, identity: null, profile: null })

// The chain-wide transfer feeds — the Activity page's Transfers tab, the merged feed
// and an asset's feed — used to hide every leg touching a module account, which also
// hid a user's deliberate donation to the treasury (block 15,072,883's
// `Utility.batch_all` of six `Tokens.transfer_all` to the pot showed on the donor's
// account feed and on the block page but never on /activity), the treasury's
// payouts, LM reward payouts and every other real movement through a pallet pot.
// The rule is gone: the chain-wide reads admit what the block page's hook arm admits
// (nonPlumbingTransferLegSql — only the pure-plumbing pots, sovereigns, pools and
// reserves are out in SQL), and what is plumbing among the rest is decided by the
// semantic ownership rules and the treasury fee rule, the same on every surface.
describe('the chain-wide transfer reads apply the block page\'s non-plumbing rule', () => {
  it('drops only pure plumbing in SQL, never a module account as such', () => {
    // The global transfer read and the asset feed's transfer arm call the shared filter
    // on their own columns.
    expect(explorerService).toContain("const userFilter = nonPlumbing ? nonPlumbingTransferLegSql('from_account', 'to_account', plumbingList) : ''")
    expect(explorerService).toContain("${nonPlumbingTransferLegSql('from_account', 'to_account', transferPlumbingList)}")
    // No transfer read keeps a module-account or sovereign prefix test on its columns.
    expect(explorerService).not.toContain("NOT match(from_account, '^0x(6d6f646c")
    expect(explorerService).not.toContain("NOT match(to_account, '^0x(6d6f646c")
    expect(explorerService).not.toContain("from_account NOT LIKE '0x6d6f646c%'")
    expect(explorerService).not.toContain("to_account NOT LIKE '0x6d6f646c%'")
    // And the shared filter itself tests no module prefix — it names the noisy pots
    // one by one, so a pallet pot's leg is a candidate unless the pot is one of those.
    const sql = nonPlumbingTransferLegSql('from_account', 'to_account', "'0xpool'")
    expect(sql).not.toContain("6d6f646c%")
    expect(sql).not.toContain("'^0x(6d6f646c")
    // The treasury is named only as the receiver of a hook-phase leg (see below).
    expect(sql).not.toContain(`from_account = '${TREASURY_POT}'`)
  })

  it('reads the global feed as bounded newest-first pages, never a whole-history window sort', () => {
    // Collapsing the pallet mirrors with a window function (max(priority) OVER the
    // identity, the LIMIT outside it) sorted every filtered row of the whole history
    // before the LIMIT could apply — 83.7M rows and 1.98 GiB for a sparse page under
    // the module exclusion, the 3.73 GiB memory cap once pallet-pot legs were admitted.
    // Both the plain and the USD-floored page now walk the same bounded top-N read
    // with the boundary block completed and the mirrors collapsed in TS.
    expect(explorerService).not.toContain('max(priority) OVER (')
    expect(explorerService).toContain("postUsdFilter ? (row: TransferRow) => rowMeetsExactUsdMinimum(row, filters.min!) : () => true")
    // Every shape pages to its size under a range; no fixed 25k page for the USD floor.
    expect(explorerService).toContain('{ pageState: () => pageState }))')
    expect(explorerService).not.toContain('pageSize: 25_000')
    // And under primary-key block ranges, never `1`: this ClickHouse plans a key-ordered
    // LIMIT as a top-N over every admitted granule, so an unbounded page sorts the
    // whole table (9.3M rows for a first page) where a ranged one reads its range.
    expect(explorerService).toContain('for (const bound of tw ? [tw] : feedRangeBoundsSql())')
    const ranges = feedRangeBoundsSql()
    expect(ranges[0]).toBe(feedWindowBoundSql())
    expect(ranges.length).toBe(6)
    // Disjoint and newest-first: each range's lower cutoff is the next range's upper one.
    for (let i = 1; i < ranges.length; i++) {
      const upper = /block_height <= \((SELECT[^)]*)\)/.exec(ranges[i])?.[1]
      expect(upper).toBeTruthy()
      expect(ranges[i - 1]).toContain(`block_height > (${upper})`)
    }
    expect(ranges.at(-1)).not.toContain('block_height >')
    // The hook half of the treasury fee rule is in the shared SQL filter, so the walk
    // does not page through the 9.2M keeper-fee legs it would drop anyway.
    const sql = nonPlumbingTransferLegSql('from_account', 'to_account', "'0xpool'")
    expect(sql).toContain(`AND NOT (to_account = '${TREASURY_POT}' AND extrinsic_index IS NULL)`)
  })

  it('memoizes the revenue tail a live first page now nearly always needs', () => {
    // The treasury funds the GIGAHDX pot hourly, so the live first page's newest row
    // regularly sits past the revenue watermark and the ~850 ms raw tail recompute ran
    // for every head the page was built under. For a fixed (visible head, block set)
    // the tail is a pure function of indexed rows, so it is kept briefly, keyed on both.
    expect(explorerService).toContain("cached(`explorer:revenue-tail:${visibleHead}:${tailBlocks.join(',')}`, REVENUE_TAIL_MEMO_MS,")
    expect(explorerService).toContain('const visibleHead = await visibleEventHeadWithin(tailBlocks)')
  })

  it('lets the merged feed keep a pallet pot\'s leg for the semantic rules to judge', () => {
    // The merged feed's transfer filter is the semantic extrinsic sets alone; the
    // module-account test that sat beside them is gone.
    expect(explorerService).not.toContain('!isModuleAcct(t.from)')
    expect(explorerService).not.toContain('!isModuleAcct(t.to)')
  })

  it('applies the treasury fee rule on every surface through one helper', () => {
    // The Transfers tab and the value-filtered merged path (suppressTransferCandidates),
    // the unfiltered merged path, the asset feed, the extrinsic page and the block
    // page's hook arm each resolve through the one helper.
    expect(explorerService).toContain('transfers = await dropTreasuryFeeLegs(transfers)')
    expect(explorerService).toContain(': await dropTreasuryFeeLegs(transfers)')
    expect(explorerService).toContain('const userTransfers = (await dropTreasuryFeeLegs(transfers)).filter(t =>')
    expect(explorerService).toContain('rows.push(...await dropTreasuryFeeLegs(transferLegs))')
    expect(explorerService).toContain('rows.push(...await dropTreasuryFeeLegs(hookTransfers))')
  })

  it('keeps a donation and drops the fee legs, asking the call table for the pot legs alone', async () => {
    const queries: string[] = []
    const query = vi.fn(async ({ query: sql }: { query: string }) => {
      queries.push(sql)
      // Only 15,072,883-2 dispatches a transfer call naming the pot.
      return { json: async () => [{ block_height: 15072883, xi: 2 }] }
    })
    initExplorerService({ query } as never)

    const rows = [
      // Two of the six donation legs (one extrinsic).
      { blockHeight: 15072883, extrinsicIndex: 2, eventIndex: 6, to: account(TREASURY_POT), from: account(DONOR) },
      { blockHeight: 15072883, extrinsicIndex: 2, eventIndex: 8, to: account(TREASURY_POT), from: account(DONOR) },
      // The negative control: a swap-and-send batch's non-native fee leg.
      { blockHeight: 15068556, extrinsicIndex: 2, eventIndex: 7, to: account(TREASURY_POT), from: account(PAYER) },
      // A hook-phase pot leg (a DCA execution's keeper fee) is a fee.
      { blockHeight: 15068600, extrinsicIndex: null, eventIndex: 3, to: account(TREASURY_POT), from: account(PAYER) },
      // A user↔user transfer and a payout FROM the pot are not the helper's business.
      { blockHeight: 15072686, extrinsicIndex: 2, eventIndex: 7, to: account(PEER), from: account(DONOR) },
      { blockHeight: 15072700, extrinsicIndex: null, eventIndex: 4, to: account(PEER), from: account(TREASURY_POT) },
    ]
    const kept = await dropTreasuryFeeLegs(rows)
    expect(kept.map(r => `${r.blockHeight}:${r.eventIndex}`)).toEqual(['15072883:6', '15072883:8', '15072686:7', '15072700:4'])
    // One primary-key read of the call table, for the signed pot legs only.
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('FROM price_data.raw_calls')
    expect(queries[0]).toContain('(15072883,2)')
    expect(queries[0]).toContain('(15068556,2)')
    expect(queries[0]).not.toContain('15068600')
    expect(queries[0]).not.toContain('15072686')
    expect(queries[0]).not.toContain('15072700')
  })

  it('asks nothing when no candidate is a signed pot leg', async () => {
    const query = vi.fn()
    initExplorerService({ query } as never)
    const rows = [
      { blockHeight: 1, extrinsicIndex: 2, to: account(PEER) },
      { blockHeight: 2, extrinsicIndex: null, to: account(TREASURY_POT) },
    ]
    // The hook-phase pot leg is dropped without a read; the user leg stays.
    expect(await dropTreasuryFeeLegs(rows)).toEqual([rows[0]])
    expect(query).not.toHaveBeenCalled()
  })

  it('matches the pot by account id regardless of case', async () => {
    const query = vi.fn(async () => ({ json: async () => [] }))
    initExplorerService({ query } as never)
    const rows = [{ blockHeight: 15068556, extrinsicIndex: 2, to: account(TREASURY_POT.toUpperCase().replace('0X', '0x')) }]
    expect(await dropTreasuryFeeLegs(rows)).toEqual([])
    expect(query).toHaveBeenCalledTimes(1)
  })
})
