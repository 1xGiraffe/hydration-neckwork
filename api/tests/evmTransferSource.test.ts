import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { transferEventPriority, EVM_TRANSFER_EVENT_NAME } from '../src/services/explorerService.ts'

const mvs = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')

// HOLLAR's canonical balance lives in an EVM contract, so a HOLLAR movement
// between two wallets can happen entirely inside the EVM and emit no substrate
// transfer event at all. Measured 2026-07-01..08-03: 973 such legs across 168
// account pairs would otherwise never appear on any activity surface — which is
// how half a million HOLLAR reached a wallet with nothing on its page to show it.
//
// The legs are fed into the three EXISTING transfer read models rather than a
// side table, because all three paginate in SQL (getRecentTransfers pushes
// LIMIT/OFFSET down); a separately merged source could not join that ordering
// without dropping or repeating rows across pages.
const TABLES = ['account_transfer_activity', 'transfer_activity', 'transfer_activity_by_time']

// The three MV declarations, one per read model. Asserted non-empty here so a
// missing declaration fails loudly instead of making every per-MV check below
// pass over an empty list.
function evmTransferMvs(): string[] {
  const found = TABLES.map(t => mvs.split('\n').find(l => l.includes(`price_data.erc20_${t}_mv `)))
  expect(found.filter(Boolean)).toHaveLength(TABLES.length)
  return found as string[]
}

describe('EVM-only transfer legs feed the existing read models', () => {
  for (const table of TABLES) {
    it(`declares an EVM-side MV into ${table}`, () => {
      const mv = mvs.split('\n').find(l => l.includes(`price_data.erc20_${table}_mv `))
      expect(mv, `no erc20_${table}_mv declared`).toBeDefined()
      expect(mv).toContain(`TO price_data.${table} `)
      expect(mv).toContain('FROM price_data.raw_evm_logs')
    })
  }

  it('reads only the HOLLAR contract\'s Transfer logs', () => {
    for (const mv of evmTransferMvs()) {
      expect(mv).toContain("'0x531a654d1696ed52e7275a8cede955e82620f99a'")
      expect(mv).toContain("event_name = 'Transfer'")
    }
  })

  // modlcurreser is the substrate/EVM bridge account: every substrate-initiated
  // HOLLAR transfer moves through it EVM-side, so those legs restate a row the
  // substrate event already produced. 104,963 of them over the same 33 days —
  // inserting them would put bridge plumbing on block and asset pages.
  it('excludes module-derived and mint/burn counterparties at insert time', () => {
    for (const mv of evmTransferMvs()) {
      expect(mv).toMatch(/6d6f646c\|7369626c\|70617261/)
      expect(mv).toContain('0x0000000000000000000000000000000000000000')
    }
  })

  it('widens each H160 to the truncated account form the explorer resolves', () => {
    for (const mv of evmTransferMvs()) {
      expect(mv).toContain("'0x45544800'")
      expect(mv).toContain("'0000000000000000'")
    }
  })

  // The synthetic name must lose every priority tie, so a leg that DOES have a
  // substrate twin is always represented by the substrate row (which carries the
  // real account ids) and never by the log.
  it('gives the synthetic event the lowest transfer priority', () => {
    expect(transferEventPriority(EVM_TRANSFER_EVENT_NAME))
      .toBeLessThan(transferEventPriority('Tokens.Transfer'))
    expect(transferEventPriority(EVM_TRANSFER_EVENT_NAME))
      .toBeLessThan(transferEventPriority('Currencies.Transferred'))
  })

  it('names the same synthetic event the MVs insert', () => {
    for (const mv of evmTransferMvs()) {
      expect(mv).toContain(`'${EVM_TRANSFER_EVENT_NAME}'`)
    }
  })
})
