import { AssetAmount, F, Usd } from '../ui'
import { Link, paths } from '../../router'
import { useNow } from '../../hooks/useNow'
import type { AccountBil, BilWait } from '../../types'
import { BIL_STATUS_LABEL, BIL_STATUS_TONE, bilRequestHref } from './bilStatus'
import { pctText } from './juicerStatus'

// The Strategies tab's Brazilian Invoice Loans card: the account's position as the API's
// pinned read of the vault states it. What accrues at the vault's NAV — BIL held (the BIL
// money market's aToken over uBIL), uBIL held directly, uBIL still queued for redemption —
// apart from what no longer does: settled redemptions, a fixed HOLLAR amount until claimed.

/** A moment to the minute: "Thu 01 Jan 2099 · 18:00 UTC". */
const dt = (iso: string) => F.datetime(iso).replace(/:\d\d UTC$/, ' UTC')

/**
 * When a queued redemption is paid: a window (its covering maturity plus the measured
 * median to 90th-percentile processing), or — once that maturity has passed — "matured,
 * awaiting processing". Never a time in the past.
 */
export function BilWaitText({ wait, fromIdle, now }: { wait: BilWait | null; fromIdle: boolean; now: number }) {
  const style = { fontSize: 11 }
  if (fromIdle) return <span className="muted" style={style}>covered by idle HOLLAR, paid at the next settlement</span>
  if (!wait) return <span className="muted" style={style}>beyond the current ladder</span>
  if (wait.matured) {
    return <span className="muted" style={style} title={`maturity ${dt(wait.maturesAt)}`}>matured, awaiting processing{Date.parse(wait.to) > now ? <> · usually paid by {dt(wait.to)}</> : null}</span>
  }
  return <span className="muted" style={style} title={`maturity ${dt(wait.maturesAt)} + measured processing`}>expected {dt(wait.from)} – {dt(wait.to)}</span>
}

export function BilPositions({ positions }: { positions: AccountBil }) {
  const now = useNow()
  const p = positions.position
  if (!p) return null
  const nav = Number(BigInt(p.exchangeRate) * 1_000_000n / 10n ** 18n) / 1e6
  const held = p.bil !== '0' || p.ubil !== '0'
  const queued = p.queuedShares !== '0'
  const claimable = p.claimableHollar !== '0'
  return (
    <div className="pf-card juicer-position bil-position">
      <div className="sec-title-row" style={{ marginTop: 0 }}>
        <h3 className="sec-title" style={{ margin: 0 }}><Link to={paths.bil()}>Brazilian Invoice Loans</Link> <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>· fixed-rate Decentral invoice receivables</span></h3>
      </div>
      <div className="hdx-cards" style={{ marginTop: 10 }}>
        <div className="hdx-card">
          <div className="hk">Position</div>
          <div className="hv"><Usd v={p.totalUsd} /></div>
          <div className="hs">{p.totalHollar != null ? <><AssetAmount asset={p.hollarAsset} raw={p.totalHollar} />{claimable && (held || queued) ? ' — at NAV plus the claimable HOLLAR' : claimable ? ' to claim' : ' at NAV'}</> : 'unknown'}</div>
        </div>
        {held && (
          <div className="hdx-card">
            <div className="hk">Held</div>
            <div className="hv">{p.bil !== '0' ? <AssetAmount asset={p.bilAsset} raw={p.bil} /> : <AssetAmount asset={p.ubilAsset} raw={p.ubil} />}</div>
            <div className="hs">{p.bil !== '0' && p.ubil !== '0' ? <>+ <AssetAmount asset={p.ubilAsset} raw={p.ubil} /> · </> : null}BIL is uBIL supplied to the BIL market, 1:1</div>
          </div>
        )}
        {queued && (
          <div className="hdx-card">
            <div className="hk">Queued for redemption</div>
            <div className="hv"><AssetAmount asset={p.ubilAsset} raw={p.queuedShares} /></div>
            <div className="hs">still earning at NAV until settled</div>
          </div>
        )}
        {claimable && (
          <div className="hdx-card">
            <div className="hk">Settled, claimable</div>
            <div className="hv"><AssetAmount asset={p.hollarAsset} raw={p.claimableHollar} /></div>
            <div className="hs">fixed at settlement, no longer earning</div>
          </div>
        )}
        {p.apyPct != null && (
          <div className="hdx-card">
            <div className="hk">APY</div>
            <div className="hv">{pctText(p.apyPct)}</div>
            <div className="hs">fixed on each {p.termDays}-day Decentral position · NAV <span className="mono">{nav.toFixed(4)}</span> HOLLAR</div>
          </div>
        )}
        {p.share != null && <div className="hdx-card"><div className="hk">Vault share</div><div className="hv">{F.share(p.share)}</div><div className="hs">of the uBIL earning in the vault</div></div>}
      </div>
      {p.requests.length > 0 && (
        <div className="panel" style={{ marginTop: 12 }}>
          <table className="tbl">
            <thead><tr><th>Redemption</th><th className="r">uBIL</th><th className="r">Worth</th><th>State</th></tr></thead>
            <tbody>
              {p.requests.map(r => (
                <tr key={r.requestId}>
                  <td data-label="Redemption" className="mono"><Link to={bilRequestHref(r.requestId)}>#{r.requestId}</Link></td>
                  <td data-label="uBIL" className="r mono"><AssetAmount asset={p.ubilAsset} raw={r.shares} /></td>
                  <td data-label="Worth" className="r mono">{r.worthHollar != null ? <AssetAmount asset={p.hollarAsset} raw={r.worthHollar} /> : '—'}</td>
                  <td data-label="State">
                    <span className={`badge ${BIL_STATUS_TONE[r.status]}`}>{BIL_STATUS_LABEL[r.status]}</span>
                    {r.pendingShares !== '0' && <> <BilWaitText wait={r.wait} fromIdle={r.paidFromIdle} now={now} /></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!positions.complete && <div className="hdx-note">The vault’s open redemption requests could not be read at this block, so a queued or claimable part may be missing above.</div>}
      <div className="hdx-note">As of block {F.int(positions.asOfBlock ?? 0)}. This holding is in the account’s Value already — BIL, uBIL and queued uBIL at the vault’s NAV, a settled part at its fixed HOLLAR — so it restates that value, it does not add to it. The unsettled part of a request can be cancelled.</div>
    </div>
  )
}
