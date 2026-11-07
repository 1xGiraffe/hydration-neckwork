import { ChartSkeleton, F } from '../ui'
import type { UseQueryResult } from '@tanstack/react-query'
import type { AccountBil, AccountJuicer } from '../../types'
import { JuicerPositions } from './JuicerPositions'
import { BilPositions } from './BilPositions'

// The Strategies tab: every strategy the account is in — Juicer's vaults and Brazilian
// Invoice Loans — each from its own pinned read. A strategy shows when the account
// holds a position in it or its state cannot be stated (unknown is said, never shown
// as empty); with none held, one line says so for all of them.

export function StrategyPositions({ juicer, bil }: { juicer: UseQueryResult<AccountJuicer>; bil: UseQueryResult<AccountBil> }) {
  if ((juicer.isLoading && !juicer.data) || (bil.isLoading && !bil.data)) return <ChartSkeleton h={220} />
  const juicerUnknown = juicer.isError || !juicer.data || juicer.data.asOfBlock == null
  const bilUnknown = bil.isError || !bil.data || bil.data.asOfBlock == null
  const juicerHeld = !!juicer.data?.positions.length
  const bilHeld = !!bil.data?.position
  if (!juicerHeld && !bilHeld && !juicerUnknown && !bilUnknown) {
    return <div className="detail-card" style={{ padding: 24, color: 'var(--text-medium)' }}>No Juicer or Brazilian Invoice Loans position, and no open withdrawal or redemption request, as of block {F.int(Math.max(juicer.data?.asOfBlock ?? 0, bil.data?.asOfBlock ?? 0))}.</div>
  }
  return (
    <>
      {(juicerHeld || juicerUnknown) && <JuicerPositions positions={juicer.data} failed={juicer.isError} />}
      {bilHeld && bil.data && <BilPositions positions={bil.data} />}
      {bilUnknown && <div className="detail-card" style={{ padding: 24, color: 'var(--text-medium)' }}>{bil.isError ? 'Couldn’t load this account’s Brazilian Invoice Loans position. Try again in a moment.' : 'The BIL vault state is unavailable right now (no fresh read), so this account’s BIL position can’t be stated — it is unknown, not empty.'}</div>}
    </>
  )
}
