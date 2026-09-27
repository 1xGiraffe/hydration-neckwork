import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { initExplorerService, transferCallDispatchSql, transferCallExtrinsics } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// A transfer INTO the treasury pot is a fee or a deposit unless the extrinsic that
// emitted it dispatches a token-transfer call — a donation. The rule must look at the
// extrinsic's CALL TREE, not its outer call name: block 15,072,883's `Utility.batch_all`
// of six `Tokens.transfer_all` to the treasury is six donations, and an outer-call test
// (`raw_extrinsics.call_name`) read the batch as a fee and dropped all six from the
// account feed and its count while the block and extrinsic pages showed them.
describe('treasury donations are recognised through the call tree', () => {
  it('reads the decomposed call tree on its own sort key, never the outer call name', () => {
    const sql = transferCallDispatchSql('block_height IN (15072883)')
    expect(sql).toContain('FROM price_data.raw_calls')
    expect(sql).not.toContain('raw_extrinsics')
    // The sort key spelling, so the bound is a primary-key read and the pair it returns
    // is comparable with the transfer candidates' own `xi`.
    expect(sql).toContain('ifNull(extrinsic_index, 4294967295) AS xi')
    // A batch holds the call once per leg; the pair is reported once.
    expect(sql).toContain('SELECT DISTINCT block_height')
    // Every local token-transfer call, batched or not, can carry a donation.
    for (const call of ['Tokens.transfer_all', 'Tokens.transfer', 'Currencies.transfer', 'Balances.transfer_keep_alive']) {
      expect(sql).toContain(`'${call}'`)
    }
    // A cross-chain send names a MultiLocation, never the local pot.
    expect(sql).not.toContain('XTokens')
  })

  it('requires the transfer call to NAME the pot, not merely to be present', () => {
    // The app's swap-and-send batch — `Utility.batch_all [set_currency, Router.sell,
    // Balances.transfer_keep_alive, set_currency]` (block 15,068,556) — pays its fee in
    // the set currency as a transfer INTO the pot while dispatching a transfer call to
    // someone else. A presence test reads that fee as a donation; only the swap owning
    // the leg first kept it hidden, and a plain non-native-fee transfer batch has no
    // swap to do that. So the rule matches the call's `dest` against the pot, which
    // every local transfer call spells as the plain AccountId hex.
    const sql = transferCallDispatchSql('block_height IN (15068556)')
    expect(sql).toContain("JSONExtractString(args_json, 'dest') = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'")
  })

  it('admits a batched transfer call by its extrinsic and skips hook-phase candidates', async () => {
    const queries: string[] = []
    const query = vi.fn(async ({ query: sql }: { query: string }) => {
      queries.push(sql)
      // raw_calls holds the batch's `Tokens.transfer_all` children under addresses
      // `0`..`5`; only that extrinsic dispatches a transfer call.
      return { json: async () => [{ block_height: 15072883, xi: 2 }] }
    })
    initExplorerService({ query } as never)

    const admitted = await transferCallExtrinsics([
      [15072883, 2], [15072883, 2], // six legs share one extrinsic — asked once
      [15072900, 4],                // a Router.sell's fee leg: no transfer call
      [15072950, null],             // hook phase: no extrinsic to look up
    ])

    expect(admitted).toEqual(new Set(['15072883:2']))
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('FROM price_data.raw_calls')
    expect(queries[0]).toContain('(15072883,2)')
    expect(queries[0]).toContain('(15072900,4)')
    expect(queries[0]).not.toContain('15072950')
    expect(queries[0]).toContain('(block_height, ifNull(extrinsic_index, 4294967295)) IN (')
  })

  it('is asked of nothing when no candidate carries an extrinsic', async () => {
    const query = vi.fn()
    initExplorerService({ query } as never)
    expect(await transferCallExtrinsics([[1, null]])).toEqual(new Set())
    expect(query).not.toHaveBeenCalled()
  })

  it('is the one rule for the page read and the count arm', () => {
    // The set of transfer calls is spelled into SQL exactly once — inside the helper —
    // so the count arm cannot carry a second list that drifts from the page's.
    expect(explorerService.match(/\[\.\.\.TRANSFER_CALL_NAMES\]/g)).toHaveLength(1)
    // Both readers call it: the account page read (transferCallExtrinsics, by tuple)
    // and accountTransferArm's treasury filter (by the candidates' blocks).
    expect(explorerService).toContain("transferCallDispatchSql(`(block_height, ifNull(extrinsic_index, 4294967295)) IN (${blockExtrinsicTupleList(chunk)})`)")
    expect(explorerService).toContain("transferCallDispatchSql(`block_height IN (SELECT block_height FROM cand WHERE to_account = '${TREASURY_POT}')`)")
  })
})
