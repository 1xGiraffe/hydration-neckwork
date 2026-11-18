import { useMemo, useState } from 'react'
import { useGovStats } from '../../hooks/useGovernance'
import { useNow } from '../../hooks/useNow'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { AreaChart, ChartSkeleton, ChartTip, F, LoadError, compactAmount } from '../ui'
import { StackedColumnChart, niceAxisMax } from '../HdxCharts'
import type { StackColumn } from '../HdxCharts'
import { ChartTooltipRow as TipRow } from '../DashboardPrimitives'
import { UNFILTERED_COLOR } from '../activityColors'
import { humanDate, trackLabel } from './GovUi'
import { hdxNumber, lastFullMonth, monthLabel, overallPassRate } from '../../utils/treasury'
import type { GovernanceStats, TurnoutRow } from '../../governanceTypes'

// The hub's Stats view: who takes part and how it ends. Every figure is one the
// explorer states elsewhere (the referendum page's direct tally, the vote calls, the
// observed vote locks, the tracks' outcomes); see the api's governanceStats.ts. It is
// its own chunk, so the hub's other tabs never load its charts.

const BAR = UNFILTERED_COLOR

function Ribbon({ d, now }: { d: GovernanceStats; now: number }) {
  const month = lastFullMonth(now)
  const m = d.activeVoters.find(x => x.month === month) ?? null
  const pass = overallPassRate(d.tracks)
  const cells = [
    { k: 'Locked in votes', v: <>{F.amount(d.locked.now, 12)} HDX</>, s: `${F.int(d.locked.accounts)} accounts` },
    { k: `Voters · ${monthLabel(month)}`, v: m ? F.int(m.voters) : '—', s: m ? `${F.int(m.votes)} votes cast` : 'no votes that month' },
    { k: 'Pass rate', v: pass.rate != null ? `${Math.round(pass.rate * 100)}%` : '—', s: `${F.int(pass.approved)} of ${F.int(pass.decided)} decided` },
    { k: 'Referenda', v: F.int(d.turnout.length), s: `${F.int(d.turnout.filter(t => !t.concludedAt).length)} running` },
  ]
  return (
    <div className="ribbon standalone gov-ribbon" aria-label="Governance at a glance">
      {cells.map((c, i) => (
        <span key={c.k} style={{ display: 'contents' }}>
          {i > 0 && <span className="rs" />}
          <span className="cell"><span className="k">{c.k}</span><span className="v">{c.v}</span><span className="s">{c.s}</span></span>
        </span>
      ))}
    </div>
  )
}

/**
 * Voters per concluded referendum, placed at its conclusion: one dot each, the
 * referendum and the HDX behind each side (before conviction) on hover or focus.
 */
export function TurnoutChart({ rows, h: hProp }: { rows: TurnoutRow[]; h?: number }) {
  const [hover, setHover] = useState<number | null>(null)
  const narrow = useMediaQuery('(max-width: 720px)')
  // On a phone the viewBox keeps its width, so it is drawn taller to stay readable.
  const h = hProp ?? (narrow ? 440 : 220)
  const pts = useMemo(() => rows.filter(r => r.concludedAt).map(r => ({ r, t: Date.parse(r.concludedAt!.includes('T') ? r.concludedAt! : `${r.concludedAt!.replace(' ', 'T')}Z`) })).filter(p => Number.isFinite(p.t)).sort((a, b) => a.t - b.t), [rows])
  if (pts.length < 2) return <p className="gov-empty">No concluded referendum to chart yet.</p>
  const W = 860, padL = narrow ? 70 : 46, padR = 10, padT = 14, padB = narrow ? 34 : 22
  const plotW = W - padL - padR, plotH = h - padT - padB
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t
  const max = niceAxisMax(Math.max(...pts.map(p => p.r.voters), 1))
  const x = (t: number) => padL + (t1 > t0 ? (t - t0) / (t1 - t0) : 0.5) * plotW
  const y = (v: number) => padT + (1 - v / max) * plotH
  const years: number[] = []
  for (let yr = new Date(t0).getUTCFullYear() + 1; yr <= new Date(t1).getUTCFullYear(); yr++) years.push(Date.UTC(yr, 0, 1))
  const nearest = (clientX: number, el: SVGSVGElement) => {
    const r = el.getBoundingClientRect()
    const vx = (clientX - r.left) / r.width * W
    let best = 0, bd = Infinity
    pts.forEach((p, i) => { const dd = Math.abs(x(p.t) - vx); if (dd < bd) { bd = dd; best = i } })
    return best
  }
  const hp = hover != null ? pts[hover] : null
  return (
    <div className="hdx-chart-wrap stats-turnout" onMouseLeave={() => setHover(null)}>
      <svg className="day-chart" viewBox={`0 0 ${W} ${h}`} role="img" aria-label={`Direct voters per referendum, delegations excluded: ${pts.length} concluded referenda, from ${humanDate(t0, false)} to ${humanDate(t1, false)}`}
        onPointerMove={e => setHover(nearest(e.clientX, e.currentTarget))}
        onPointerDown={e => setHover(nearest(e.clientX, e.currentTarget))}>
        {[0, 0.5, 1].map(t => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(max * t).toFixed(1)} y2={y(max * t).toFixed(1)} stroke="var(--separator)" strokeWidth="1" />
            <text className="hdx-ax" x={padL - 8} y={(y(max * t) + 3).toFixed(1)} textAnchor="end">{compactAmount(max * t)}</text>
          </g>
        ))}
        {years.map(t => <text key={t} className="hdx-ax" x={x(t).toFixed(1)} y={h - 5} textAnchor="middle">{new Date(t).getUTCFullYear()}</text>)}
        {pts.map((p, i) => (
          <circle key={p.r.index} cx={x(p.t).toFixed(1)} cy={y(p.r.voters).toFixed(1)} r={hover === i ? (narrow ? 9 : 5) : narrow ? 6 : 3}
            fill={BAR} stroke="var(--bg-elev)" strokeWidth="1.5" opacity={hover == null || hover === i ? 1 : 0.55} />
        ))}
      </svg>
      {hp && (
        <ChartTip className="hdx-tip" xPct={x(hp.t) / W * 100} top={2}>
          <span className="t-d">#{hp.r.index} · {humanDate(hp.t, false)}</span>
          <TipRow label="Direct voters" value={F.int(hp.r.voters)} />
          <TipRow label="Aye HDX" value={compactAmount(hdxNumber(hp.r.ayeCapital))} />
          <TipRow label="Nay HDX" value={compactAmount(hdxNumber(hp.r.nayCapital))} />
          <TipRow label="Outcome" value={hp.r.status} />
        </ChartTip>
      )}
    </div>
  )
}

function voterColumns(rows: GovernanceStats['activeVoters'], narrow: boolean): StackColumn[] {
  const every = narrow ? 6 : 3
  return rows.map((m, i) => ({
    key: m.month,
    label: i % every === 0 ? monthLabel(m.month).replace(/ (\d\d)(\d\d)$/, ' ’$2') : '',
    segments: [{ key: 'voters', label: 'Voters', color: BAR, value: m.voters }],
    tip: (<><span className="t-d">{monthLabel(m.month)}</span><TipRow label="Voters" value={F.int(m.voters)} /><TipRow label="Votes cast" value={F.int(m.votes)} /></>),
  }))
}

function PassRates({ tracks }: { tracks: GovernanceStats['tracks'] }) {
  const rows = [...tracks].filter(t => t.approved + t.rejected + t.cancelled + t.timedOut + t.killed + t.ongoing > 0)
    .sort((a, b) => (b.approved + b.rejected) - (a.approved + a.rejected))
  return (
    <div className="panel"><table className="tbl gov-list-tbl stats-pass">
      <thead><tr><th>Track</th><th className="r">Decided</th><th>Pass rate</th><th className="r">Other endings</th></tr></thead>
      <tbody>
        {rows.map(t => {
          const decided = t.approved + t.rejected
          const other = t.cancelled + t.timedOut + t.killed
          return (
            <tr key={t.id}>
              <td data-label="Track">{trackLabel(t.name)}</td>
              <td data-label="Decided" className="r mono">{F.int(decided)}</td>
              <td data-label="Pass rate">
                {t.passRate != null ? (
                  <span className="stats-bar" title={`${t.approved} approved, ${t.rejected} rejected`}>
                    <span className="stats-bar-track"><span className="stats-bar-fill" style={{ width: `${Math.round(t.passRate * 100)}%` }} /></span>
                    <span className="mono">{Math.round(t.passRate * 100)}%</span>
                  </span>
                ) : <span className="muted">none decided</span>}
              </td>
              <td data-label="Other endings" className="r mono muted" title={`${t.cancelled} cancelled, ${t.timedOut} timed out, ${t.killed} killed${t.ongoing ? `, ${t.ongoing} running` : ''}`}>{other ? F.int(other) : '—'}{t.ongoing ? ` · ${t.ongoing} running` : ''}</td>
            </tr>
          )
        })}
      </tbody>
    </table></div>
  )
}

export default function GovStats() {
  const now = useNow(60_000)
  const narrow = useMediaQuery('(max-width: 720px)')
  const q = useGovStats()
  const d = q.data
  if (q.isError && !d) return <LoadError title="The statistics could not be loaded." onRetry={() => void q.refetch()} />
  if (!d) return <div className="gov-stats" aria-busy="true"><div className="skeleton treas-ribbon-sk" /><ChartSkeleton h={220} /><ChartSkeleton h={200} /></div>
  const locked = d.locked.weekly
  return (
    <div className="gov-stats">
      <Ribbon d={d} now={now} />

      <section className="gov-section" aria-labelledby="stats-turnout">
        <h2 id="stats-turnout" className="gov-h2">Turnout <span className="gov-h2-sub">direct voters per referendum (delegations excluded)</span></h2>
        <div className="pf-card"><TurnoutChart rows={d.turnout} /></div>
      </section>

      <section className="gov-section" aria-labelledby="stats-voters">
        <h2 id="stats-voters" className="gov-h2">Active voters <span className="gov-h2-sub">accounts that voted, per month</span></h2>
        <div className="pf-card">{d.activeVoters.length ? <StackedColumnChart columns={voterColumns(d.activeVoters, narrow)} h={narrow ? 420 : 200} clamp={false} yFmt={v => compactAmount(v)} /> : <p className="gov-empty">No votes indexed yet.</p>}</div>
      </section>

      <section className="gov-section" aria-labelledby="stats-locked">
        <h2 id="stats-locked" className="gov-h2">HDX locked in votes <span className="gov-h2-sub">weekly, from block {F.int(d.locked.since)}</span></h2>
        <div className="pf-card">
          {locked.length >= 2
            ? <AreaChart data={locked.map(w => hdxNumber(w.locked))} dates={locked.map(w => w.week)} floor={0} color={BAR} valueFmt={v => `${compactAmount(v)} HDX`} h={140} />
            : <p className="gov-empty">The weekly series starts once a second week of observations is in.</p>}
          <p className="gov-fineprint">Each account’s conviction lock as last observed, summed. Lock observations begin at block {F.int(d.locked.since)}, so the series starts there.</p>
        </div>
      </section>

      <section className="gov-section" aria-labelledby="stats-pass">
        <h2 id="stats-pass" className="gov-h2">Pass rate per track</h2>
        <PassRates tracks={d.tracks} />
        <p className="gov-fineprint">Approved over approved and rejected; cancelled, timed-out and killed referenda were never decided and sit apart.</p>
      </section>
    </div>
  )
}
