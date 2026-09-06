import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BOND_EVENT_NAMES, bondActivityParts, bondUnderlyingId } from '../src/services/explorerService.ts'
import { BOND_UNDERLYING_ID } from '../src/services/explorerAssets.ts'

const views = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')
const tables = readFileSync(new URL('../../clickhouse/schema/001_tables.sql', import.meta.url), 'utf8')

const TREASURY = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'
const USER = '0xc48cbd210165097e4955ba0b35553db067e959752d454331835be646b470d15b'

describe('bondActivityParts', () => {
  // Bonds.Issued (block 12529271): the Treasury issued 452,563.2 HOLLAR bonds by
  // governance, fee 0. The actor field is `issuer`, not `who`.
  it('reads an issue from its issuer, amount and fee', () => {
    expect(bondActivityParts('Bonds.Issued', { issuer: TREASURY, bondId: 1001351, amount: '452563222222222222222222', fee: '0' }))
      .toEqual({ who: TREASURY, bondId: 1001351, amount: '452563222222222222222222', fee: '0', action: 'Issue' })
  })
  // Bonds.Issued (block 3681426): the first HDX bond carried a 1,020,408.18 HDX fee.
  it('keeps the issuance fee the Treasury collected', () => {
    expect(bondActivityParts('Bonds.Issued', { issuer: TREASURY, bondId: 1000010, amount: '50000000820000000000', fee: '1020408180000000000' })?.fee)
      .toBe('1020408180000000000')
  })
  // Bonds.Issued (block 4879205): a user created a bond class and issued nothing.
  // Still an act — the token exists because of it — so it stays a row at amount 0.
  it('keeps a zero-amount issue as a row', () => {
    expect(bondActivityParts('Bonds.Issued', { issuer: USER, bondId: 1000050, amount: '0', fee: '1' }))
      .toEqual({ who: USER, bondId: 1000050, amount: '0', fee: '1', action: 'Issue' })
  })
  // Bonds.Redeemed (extrinsic 13921174-2): 225.83 HOLLAR bonds for 225.83 HOLLAR.
  it('reads a redemption from who, bondId and amount', () => {
    expect(bondActivityParts('Bonds.Redeemed', { who: USER, bondId: 1001351, amount: '225829499999999999999' }))
      .toEqual({ who: USER, bondId: 1001351, amount: '225829499999999999999', fee: null, action: 'Redeem' })
  })
  it('is not fooled by the token-creation companion or unrelated events', () => {
    expect(bondActivityParts('Bonds.TokenCreated', { issuer: TREASURY, assetId: 222, bondId: 1001351, maturity: '1787639154000' })).toBeNull()
    expect(bondActivityParts('Tokens.Withdrawn', { who: USER, currencyId: 1001351, amount: '1' })).toBeNull()
  })
})

describe('bondUnderlyingId', () => {
  it('answers from the bond registry only', () => {
    BOND_UNDERLYING_ID[1001351] = 222
    expect(bondUnderlyingId(1001351)).toBe(222)
    // HOLLAR itself, and an asset no Bonds.TokenCreated ever named, are not bonds.
    expect(bondUnderlyingId(222)).toBeNull()
    expect(bondUnderlyingId(0)).toBeNull()
    delete BOND_UNDERLYING_ID[1001351]
  })
})

// The bond_activity projection is what every windowed bond read pages from, and the
// histogram MV is what the Bond tab's daily bars count — both must select exactly
// the events the row builders render, or a row appears in the feed with no bar
// (or the other way round).
describe('bond schema', () => {
  it('declares the bond_activity table and an MV that mirrors BOND_EVENT_NAMES', () => {
    expect(tables).toContain('CREATE TABLE IF NOT EXISTS price_data.bond_activity (')
    const mv = views.split('\n').find(line => line.includes('price_data.bond_activity_mv'))
    expect(mv).toBeDefined()
    for (const name of BOND_EVENT_NAMES) expect(mv).toContain(`'${name}'`)
    // Issued names its actor `issuer`; the MV must fall back to it so account-scoped
    // reads (`who IN (…)`) find a Treasury or user issue.
    expect(mv).toContain("JSONExtractString(args_json, 'issuer')")
  })
  it('counts both bond events in the activity histogram, keyed on the bond id', () => {
    const mv = views.split('\n').find(line => line.includes('price_data.activity_histogram_events_mv'))
    expect(mv).toBeDefined()
    for (const name of BOND_EVENT_NAMES) expect(mv!.match(new RegExp(`'${name.replace('.', '\\.')}'`, 'g'))?.length).toBe(2)
    expect(mv).toContain("[toUInt32(greatest(0, JSONExtractInt(args_json, 'bondId')))]")
  })
})
