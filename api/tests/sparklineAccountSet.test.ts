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

  // The raw-observation scan is folded per ROW in ClickHouse — per (account, asset)
  // the week's last state carried forward from the pre-window baseline, then summed
  // per (row, asset, week) — so its result is bounded by rows × assets × weeks. Per
  // (account, asset, week) rows for a page whose tag rows cover thousands of
  // accounts (xyk-pools alone: 730 members and their twins) ran past the client's
  // result-row cap, and the whole enrichment pass failed with them.
  it('folds the weekly states per row in SQL, never per account on the wire', () => {
    const body = fn('enrichAccountRows')

    // Carry per (account, asset) over every week of the window …
    expect(body).toContain('arrayLast(x -> tupleElement(x, 1) <= w, states)')
    expect(body).toContain('range(-1, ${SPARK_WEEKS})')
    // … summed per row …
    expect(body).toContain("WITH rows_of AS (SELECT account_id, row FROM VALUES('account_id String, row UInt32', ${rowsOf}))")
    expect(body).toContain('WHERE account_id IN (SELECT account_id FROM rows_of)')
    expect(body).toContain('INNER JOIN rows_of AS m ON m.account_id = s.account_id')
    expect(body).toContain('GROUP BY m.row, s.asset_id, s.wk')
    // … and read back at the weeks the sum changes, from 0 — the carry in
    // buildValueSparkline restores the series, and a week the sum drops to 0 is
    // read (a dropped zero would carry the previous value forward).
    expect(body).toContain('tupleElement(x, 2) != if(i = 1, toUInt256(0), tupleElement(series[i - 1], 2))')
    expect(body).toContain('ARRAY JOIN changes AS c`')
    expect(body).not.toContain('HAVING sum(s.held) > 0')
    expect(body).not.toContain('GROUP BY account_id, asset_id, b`')
    // The fold keeps buildValueSparkline as the one series assembly; the row index
    // stands in for its account key.
    expect(body).toContain('buildValueSparkline(obs, baseline, pricesByAsset, decimalsById)')
    expect(body).toContain('const obs = obsByRow.get(String(i)) ?? []')
  })

  // A row whose members produce no usable account set must keep whatever
  // enrichAccountRows already produced rather than rendering an empty series.
  it('leaves rows with no account set alone', () => {
    expect(fn('enrichAccountSparklines')).toContain('if (!accounts.length) continue')
  })
})
