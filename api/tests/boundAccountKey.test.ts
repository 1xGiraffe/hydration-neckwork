import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// Every directory/volume/weekly query keys a row on its bound substrate owner when the
// row is that owner's EVM-side pot, falling back to the account itself. The fallback used
// to be `coalesce(b.owner, ...)`, which only works while `bind`'s owner column is
// Nullable: a LEFT JOIN fills unmatched rows with the column's DEFAULT, so reading the
// owner out of raw_account_aliases (Nullable(String)) it arrived as NULL and coalesce fell
// through, but out of account_alias_directory (plain String) it arrived as '' and coalesce
// returned the empty owner. Every unbound account then collapsed into one ''-keyed group:
// the directory went from 114,045 rows to 3,217, topped by a $135M row holding every HDX
// on the chain, and `/account/` for an empty address.
describe('bound-account directory key', () => {
  it('never relies on coalesce to detect an unmatched bind row', () => {
    expect(explorerService).not.toContain('coalesce(b.owner')
  })

  it('tests the joined owner for emptiness as well as null', () => {
    const sql = explorerService.slice(
      explorerService.indexOf('function boundAccountSql'), explorerService.indexOf('function bindCteSql'))

    expect(sql).toContain("ifNull(b.owner, '') != ''")
    // The chosen owner must also be non-nullable, or the group key it feeds turns
    // Nullable and every downstream `= ''` comparison goes three-valued.
    expect(sql).toContain("ifNull(b.owner, ''), if(")
  })

  it('builds every bound-account key through the one helper', () => {
    // 4 call sites: asset holders, trade volume, liquidation volume, and the accounts
    // directory itself. The weekly-activity site went with the directory's
    // balance-observation counter, which the account's own feed total replaced.
    expect((explorerService.match(/\$\{boundAccountSql\('\w+'\)\}/g) ?? []).length).toBe(4)
    expect((explorerService.match(/substring\(\$\{account\}, 11, 8\) IN \('6d6f646c', '7369626c', '70617261'\)/g) ?? []).length).toBe(1)
  })

  it('keeps the module/sovereign truncation remap in the fallback', () => {
    const sql = explorerService.slice(explorerService.indexOf('function boundAccountSql'), explorerService.indexOf('function bindCteSql'))

    expect(sql).toContain("substring(${account}, 3, 8) = '45544800'")
    expect(sql).toContain("concat('0x', substring(${account}, 11, 40), '000000000000000000000000')")
  })
})
