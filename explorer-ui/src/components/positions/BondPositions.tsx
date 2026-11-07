import { AssetAmount, AssetChip, F, Usd } from '../ui'
import { Link, paths } from '../../router'
import type { AccountBonds } from '../../types'
import { BOND_STATUS_LABEL, BOND_STATUS_TONE, bondDate, bondPct } from './bondStatus'

// The Strategies tab's bonds card: every bond the account holds, by family and round —
// how much (in face: what it redeems for), when it matures, what it is worth now under
// the bond rule (face from maturity, face discounted at the bond's own issue yield
// before it) and, where the account bought it in the primary sale, what it paid and the
// APR that locked in.

export function BondPositions({ bonds }: { bonds: AccountBonds }) {
  if (!bonds.positions.length) return null
  const families = [...new Map(bonds.positions.map(p => [p.family, p.familyTitle])).entries()]
  const total = bonds.positions.reduce<number | null>((s, p) => s == null || p.valueUsd == null ? null : s + p.valueUsd, 0)
  return (
    <div className="pf-card juicer-position bond-position">
      <div className="sec-title-row" style={{ marginTop: 0 }}>
        <h3 className="sec-title" style={{ margin: 0 }}>
          {families.map(([key, title], i) => <span key={key}>{i > 0 && ' · '}<Link to={paths.bonds(key)}>{title}</Link></span>)}
          {' '}<span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>· fixed-yield bonds, redeemable 1:1 at maturity · <Usd v={total} /></span>
        </h3>
      </div>
      <div className="panel" style={{ marginTop: 10 }}>
        <table className="tbl">
          <thead><tr><th>Bond</th><th className="r">Held</th><th>Matures</th><th className="r">Worth now</th><th className="r">Bought in the sale</th></tr></thead>
          <tbody>
            {bonds.positions.map(p => (
              <tr key={p.bondId}>
                <td data-label="Bond">
                  <AssetChip asset={p.asset} /> <span className="muted">round {p.round}</span>
                  <div><span className={`badge ${BOND_STATUS_TONE[p.status]}`}>{p.redeemable ? 'Redeemable now' : BOND_STATUS_LABEL[p.status]}</span></div>
                </td>
                <td data-label="Held" className="r mono">
                  <AssetAmount asset={p.asset} raw={p.balance} />
                  <div className="muted" style={{ fontSize: 11 }}>face {F.amount(p.balance, p.asset.decimals)} {p.underlying.symbol}</div>
                </td>
                <td data-label="Matures">{bondDate(p.maturityAt)}</td>
                <td data-label="Worth now" className="r mono">
                  <Usd v={p.valueUsd} />
                  {p.valueFactor != null && p.valueFactor < 1 && <div className="muted" style={{ fontSize: 11 }}>{p.valueFactor.toFixed(4)} of face (<Usd v={p.faceUsd} />)</div>}
                </td>
                <td data-label="Bought in the sale" className="r mono">
                  {p.bought ? <>
                    {p.bought.paid.map(x => <div key={x.asset.assetId}><AssetAmount asset={x.asset} raw={x.raw} /></div>)}
                    <div className="muted" style={{ fontSize: 11 }}>{F.amount(p.bought.bonds, p.asset.decimals)} {p.asset.symbol}{p.bought.returnPct != null ? ` · ${bondPct(p.bought.returnPct)} in ${p.underlying.symbol} to maturity` : ''}{p.bought.aprPct != null ? ` (${bondPct(p.bought.aprPct)} APR)` : ''}</div>
                  </> : <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hdx-note">As of block {F.int(bonds.asOfBlock ?? 0)}. Bonds are wallet balances, so this is in the account’s Value already — it restates that value, it does not add to it. Before maturity a bond is worth its face discounted at its own issue yield over the time left; from maturity it redeems 1:1 for its underlying. “Bought in the sale” is what this account paid in the issuer’s sale — its OTC offers (a rollover pays in the older round’s bonds) or its LBP, net of any bonds sold back — with the yield it locked in; a bond paid for in another asset (the HDX bonds, bought with DOT) states it in its underlying at each purchase’s own prices. Bonds moved in or out since are not in it.</div>
    </div>
  )
}
