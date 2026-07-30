import { describe, expect, it } from 'vitest'
import { nonPlumbingTransferLegSql } from '../src/services/explorerService.ts'

// Well-known `modl` pallet pots (stable chain constants).
const ROUTER = '0x6d6f646c726f7574657265780000000000000000000000000000000000000000'
const OMNIPOOL = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'
const FEEPROC = '0x6d6f646c66656570726f632f0000000000000000000000000000000000000000'
const TREASURY = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'

describe('nonPlumbingTransferLegSql', () => {
  const sql = nonPlumbingTransferLegSql(
    "JSONExtractString(args_json,'from')",
    "JSONExtractString(args_json,'to')",
    "'0xpool','0xreserve'",
  )

  it('excludes the noisy swap/fee pots on both legs', () => {
    for (const pot of [ROUTER, OMNIPOOL, FEEPROC]) {
      // once per leg (from + to)
      expect(sql.split(pot).length - 1).toBe(2)
    }
  })

  it('excludes XCM sovereign/system accounts (sibl/para/Parent)', () => {
    expect(sql).toContain('7369626c|70617261|506172656e74')
  })

  it('excludes the passed pool / money-market reserve plumbing list', () => {
    expect(sql).toContain("'0xpool','0xreserve'")
  })

  // The bug: a blanket `0x6d6f646c…` module exclusion drops treasury payouts, so
  // a treasury transfer shown on an account page can't be re-derived from block
  // activity and its detail page 404s. Genuine pallet-pot payouts must stay.
  it('keeps genuine pallet-pot payouts — no blanket module exclusion, treasury visible', () => {
    expect(sql).not.toContain("LIKE '0x6d6f646c%'")
    expect(sql).not.toContain(TREASURY)
  })
})
