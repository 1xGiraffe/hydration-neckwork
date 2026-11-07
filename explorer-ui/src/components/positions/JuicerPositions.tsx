import { AddrPill, AssetAmount, ChartSkeleton, F, Usd } from '../ui'
import { Link, paths } from '../../router'
import { fmtDuration } from '../../utils/dca'
import { useNow } from '../../hooks/useNow'
import type { AccountJuicer } from '../../types'
import { JUICER_STATUS_LABEL, JUICER_STATUS_TONE, pctText } from './juicerStatus'

// The Strategies tab: the account's Juicer vault positions and open withdrawal
// requests, as the API's pinned read of the vault states them — everything the
// position is (held shares, funded earnings included, plus what is on its way out),
// what it converts to now and its value, and each request on its way out.

/** "unwinds in 5d 9h" against the shared clock, the exact moment on hover. */
export function UnwindsIn({ iso, now }: { iso: string; now: number }) {
  const left = (Date.parse(iso) - now) / 1000
  return <span className="muted" style={{ fontSize: 11 }} title={F.datetime(iso)}>{left > 0 ? `unwinds in ${fmtDuration(left)}` : 'cooldown over'}</span>
}

export function JuicerPositions({ positions, loading, failed }: { positions: AccountJuicer | undefined; loading?: boolean; failed?: boolean }) {
  const now = useNow()
  if (loading && !positions) return <ChartSkeleton h={220} />
  if (failed || !positions) {
    return <div className="detail-card" style={{ padding: 24, color: 'var(--text-medium)' }}>Couldn’t load this account’s Juicer positions. Try again in a moment.</div>
  }
  if (positions.asOfBlock == null) {
    return <div className="detail-card" style={{ padding: 24, color: 'var(--text-medium)' }}>The Juicer vault state is unavailable right now (no fresh read), so this account’s positions can’t be stated — they are unknown, not empty.</div>
  }
  if (!positions.positions.length) {
    return <div className="detail-card" style={{ padding: 24, color: 'var(--text-medium)' }}>No Juicer position or open withdrawal request as of block {F.int(positions.asOfBlock)}.</div>
  }
  return (
    <>
      {positions.positions.map(p => (
        <div key={p.vault.accountId} className="pf-card juicer-position">
          <div className="sec-title-row" style={{ marginTop: 0 }}>
            <div className="sec-title" style={{ margin: 0 }}><Link to={paths.juicer()}>{p.name}</Link> <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>· <AddrPill account={p.vault} noCopy /></span></div>
          </div>
          <div className="hdx-cards" style={{ marginTop: 10 }}>
            <div className="hdx-card">
              <div className="hk">Position</div>
              <div className="hv"><Usd v={p.totalUsd} /></div>
              <div className="hs">{p.totalAssets != null ? <><AssetAmount asset={p.collateral} raw={p.totalAssets} /> now</> : 'unknown'}{p.inWithdrawal !== '0' && <> · {p.inWithdrawalUsd != null ? F.usd(p.inWithdrawalUsd) : 'part'} on its way out</>}</div>
            </div>
            <div className="hdx-card">
              <div className="hk">Shares</div>
              <div className="hv"><AssetAmount asset={p.shareAsset} raw={p.shares} /></div>
              <div className="hs">{p.inWithdrawal !== '0' ? <>+ <AssetAmount asset={p.shareAsset} raw={p.inWithdrawal} /> in withdrawal</> : 'funded earnings included'}</div>
            </div>
            <div className="hdx-card">
              <div className="hk">Est. APY</div>
              <div className="hv">{pctText(p.apyPct)}</div>
              <div className="hs">at target leverage · {p.runRateApyPct != null ? <>earning {pctText(p.runRateApyPct)} now</> : 'variable'}</div>
            </div>
            <div className="hdx-card"><div className="hk">Vault share</div><div className="hv">{F.share(p.share)}</div><div className="hs">of the shares outstanding</div></div>
          </div>
          {p.withdrawals.length > 0 && (
            <div className="panel" style={{ marginTop: 12 }}>
              <table className="tbl">
                <thead><tr><th>Withdrawal</th><th className="r">Shares</th><th className="r">Worth</th><th>State</th></tr></thead>
                <tbody>
                  {p.withdrawals.map(w => (
                    <tr key={w.requestId}>
                      <td data-label="Withdrawal" className="mono">#{w.requestId}</td>
                      <td data-label="Shares" className="r mono"><AssetAmount asset={p.shareAsset} raw={w.shares} /></td>
                      <td data-label="Worth" className="r mono">{w.assets != null ? <AssetAmount asset={p.collateral} raw={w.assets} /> : '—'}</td>
                      <td data-label="State">
                        <span className={`badge ${JUICER_STATUS_TONE[w.status]}`}>{JUICER_STATUS_LABEL[w.status]}</span>
                        {w.status === 'cooldown' && w.eligibleAt && <> <UnwindsIn iso={w.eligibleAt} now={now} /></>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="hdx-note">As of block {F.int(positions.asOfBlock ?? 0)}. The shares are in the account’s Value at what one converts to in the vault’s collateral. Withdrawal requests cannot be cancelled; escrowed shares keep earning until their unwind starts, and an exit then bears its own borrowing interest.</div>
        </div>
      ))}
    </>
  )
}
