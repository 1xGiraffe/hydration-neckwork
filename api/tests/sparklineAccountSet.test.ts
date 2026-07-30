import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

const fn = (name: string) => {
  const at = explorerService.indexOf(`async function ${name}(`)
  expect(at, name).toBeGreaterThan(-1)
  return explorerService.slice(at, explorerService.indexOf('\n}\n', at))
}

// Two enrichers build account sets for the same directory rows, and they must treat
// pallet/sovereign members differently:
//
// enrichAccountRows scans raw balance observations, where the omnipool pallet alone owns
// ~60M events, so it keeps them out of the history scan (and only counts their activity).
//
// enrichAccountSparklines runs the detail page's own shared reconstruction, which already
// charts those accounts — /explorer/address/<pallet>/history returns a full 180-bucket
// series for the treasury and omnipool pallets, and account_balance_weekly covers them
// back to 2022. Excluding them there only made the sparkline disagree with the Value
// column beside it, which sums every member: Treasury, Omnipool, HOLLAR Stability Module,
// Liquidity Mining, Parachain Sovereign, Staking Pot and Pallet Pots each rendered a
// value with no series at all.
describe('sparkline account sets', () => {
  it('keeps pallet and sovereign members in the shared reconstruction', () => {
    const body = fn('enrichAccountSparklines')

    expect(body).toContain('members.filter(m => ACCOUNT_RE.test(m))')
    expect(body).not.toContain('!isModuleAccount(m)')
    expect(body).not.toContain('const isModuleAccount')
  })

  it('still keeps them out of the raw-observation scan', () => {
    const body = fn('enrichAccountRows')

    expect(body).toContain('const isModuleAccount')
    expect(body).toContain('members.filter(m => !isModuleAccount(m))')
    // Their activity counters are still collected, only the balance history is skipped.
    expect(body).toContain('members.filter(isModuleAccount)')
  })

  it('still contributes each member s EVM-side twin', () => {
    const body = fn('enrichAccountSparklines')

    expect(body).toContain('evmAccountForm(m)')
  })

  // A row whose members produce no usable account set must keep whatever
  // enrichAccountRows already produced rather than rendering an empty series.
  it('leaves rows with no account set alone', () => {
    expect(fn('enrichAccountSparklines')).toContain('if (!accounts.length) continue')
  })
})
