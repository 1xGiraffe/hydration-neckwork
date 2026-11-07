import { ChartSkeleton, F } from '../ui'
import type { UseQueryResult } from '@tanstack/react-query'
import type { AccountBil, AccountBonds, AccountJuicer } from '../../types'
import { JuicerPositions } from './JuicerPositions'
import { BilPositions } from './BilPositions'
import { BondPositions } from './BondPositions'

// The Strategies tab: every strategy the account is in — Juicer's vaults, Brazilian
// Invoice Loans and bonds (HOLLAR and HDX bonds) — each from its own pinned read. A strategy
// shows when the account holds a position in it or its state cannot be stated (unknown
// is said, never shown as empty); with none held, one line says so for all of them.

export function StrategyPositions({ juicer, bil, bonds }: { juicer: UseQueryResult<AccountJuicer>; bil: UseQueryResult<AccountBil>; bonds: UseQueryResult<AccountBonds> }) {
  if ((juicer.isLoading && !juicer.data) || (bil.isLoading && !bil.data) || (bonds.isLoading && !bonds.data)) return <ChartSkeleton h={220} />
  const juicerUnknown = juicer.isError || !juicer.data || juicer.data.asOfBlock == null
  const bilUnknown = bil.isError || !bil.data || bil.data.asOfBlock == null
  const bondsUnknown = bonds.isError || !bonds.data || bonds.data.asOfBlock == null
  const juicerHeld = !!juicer.data?.positions.length
  const bilHeld = !!bil.data?.position
  const bondsHeld = !!bonds.data?.positions.length
  if (!juicerHeld && !bilHeld && !bondsHeld && !juicerUnknown && !bilUnknown && !bondsUnknown) {
    return <div className="detail-card" style={{ padding: 24, color: 'var(--text-medium)' }}>No Juicer, Brazilian Invoice Loans or bond position, and no open withdrawal or redemption request, as of block {F.int(Math.max(juicer.data?.asOfBlock ?? 0, bil.data?.asOfBlock ?? 0, bonds.data?.asOfBlock ?? 0))}.</div>
  }
  return (
    <>
      {(juicerHeld || juicerUnknown) && <JuicerPositions positions={juicer.data} failed={juicer.isError} />}
      {bilHeld && bil.data && <BilPositions positions={bil.data} />}
      {bilUnknown && <div className="detail-card" style={{ padding: 24, color: 'var(--text-medium)' }}>{bil.isError ? 'Couldn’t load this account’s Brazilian Invoice Loans position. Try again in a moment.' : 'The BIL vault state is unavailable right now (no fresh read), so this account’s BIL position can’t be stated — it is unknown, not empty.'}</div>}
      {bondsHeld && bonds.data && <BondPositions bonds={bonds.data} />}
      {bondsUnknown && <div className="detail-card" style={{ padding: 24, color: 'var(--text-medium)' }}>{bonds.isError ? 'Couldn’t load this account’s bonds. Try again in a moment.' : 'The bond state is unavailable right now (no fresh read), so this account’s bonds can’t be stated here — they are unknown, not empty (its Balances still list them).'}</div>}
    </>
  )
}
