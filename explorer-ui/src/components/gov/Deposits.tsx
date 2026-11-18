import { useState } from 'react'
import type { ReactNode } from 'react'
import { Link, paths } from '../../router'
import { AddrPill, F, MomentLink } from '../ui'
import { InfoTip } from './Disclosure'
import { inCartActions, openVote, toggleCartAction, useCartActions } from '../../vote/voteBus'
import type { CartAction } from '../../vote/voteBus'
import type { AccountDeposits, PreimageDeposit, ReferendumDeposit } from '../../governanceTypes'
import type { ReferendumDetail } from '../../types'
import { actionsTotal, depositName, depositRefund, depositStateWord, heldAndKept, placeDecisionDeposit, preimageRefund, refundAll, shortHash } from './deposits'

// Governance deposits on the pages that hold them. The signing itself is the voting
// engine's action sheet (vote/ActionSheet.tsx, loaded with the sheets on first use):
// a Refund button opens it for one deposit, "Add to cart" keeps it for the cart's
// one signature with any votes there, "Refund all" signs every refundable one at once.

const hdx = (raw: string) => `${F.amount(raw, 12)} HDX`

/** "Add to cart" / "In cart": the toggle beside a Refund button. */
function CartToggle({ action }: { action: CartAction }) {
  useCartActions()
  const on = inCartActions(action)
  return (
    <button type="button" className="link-btn gov-dep-cart" aria-pressed={on} onClick={() => toggleCartAction(action)}>
      {on ? 'In cart' : 'Add to cart'}
    </button>
  )
}

function RefundButton({ action, title }: { action: CartAction; title: string }) {
  return <button type="button" className="gov-btn gov-btn-sm" onClick={() => openVote({ kind: 'actions', items: [action], title })}>Refund</button>
}

/** One concluded referendum deposit, one line: what it is, how much, what became of it, and the refund when there is one. */
function DepositLine({ d }: { d: ReferendumDeposit }) {
  const refund = depositRefund(d)
  return (
    <li className="gov-dep-line">
      <span className="gov-dep-what">{depositName(d)} · {hdx(d.amount)} · <span className={d.state === 'refundable' ? 'gov-dep-open' : undefined}>{depositStateWord(d)}</span></span>
      {refund && <span className="gov-dep-acts"><RefundButton action={refund} title="Refund deposit" /><CartToggle action={refund} /></span>}
    </li>
  )
}

/**
 * The deposits line of a referendum's Status: while it waits for a decision deposit,
 * the button that places one (neutral: Vote stays the page's primary); once
 * concluded, each deposit with its state and refund. Older api answers carry no
 * deposits, and the verdict's own text stands in.
 */
export function ReferendumDepositsLine({ data, fallback }: { data: ReferendumDetail; fallback?: ReactNode }) {
  const d = data.deposits
  if (!d) return fallback ? <div className="gov-ref-status-deposits">{fallback}</div> : null
  const running = !data.concludedAt
  if (running && d.needsDecisionDeposit && data.trackInfo) {
    const action = placeDecisionDeposit(data.index, data.trackInfo.decisionDeposit)
    return (
      <div className="gov-ref-status-deposits gov-dep-place">
        <button type="button" className="gov-btn" onClick={() => openVote({ kind: 'actions', items: [action], title: 'Place the decision deposit' })}>
          Place decision deposit ({hdx(data.trackInfo.decisionDeposit)})
        </button>
        <span className="gov-dep-note">Anyone can place it; it is refunded when the referendum concludes.</span>
      </div>
    )
  }
  if (running) return null
  const lines = [d.submission, d.decision].filter((x): x is ReferendumDeposit => !!x)
  if (!lines.length) return null
  return <ul className="gov-ref-status-deposits gov-dep-lines" aria-label="Deposits">{lines.map(x => <DepositLine key={x.kind} d={x} />)}</ul>
}

/** "More details": who placed each deposit, how much, and what became of it. */
export function DepositFacts({ data, now }: { data: ReferendumDetail; now: number }) {
  const d = data.deposits
  if (!d) return null
  const rows = [d.submission, d.decision].filter((x): x is ReferendumDeposit => !!x)
  return (
    <>
      {rows.map(x => (
        <div key={x.kind} className="gov-dep-fact">
          <div className="dt">{depositName(x)}</div>
          <div className="dd">
            <span className="mono">{hdx(x.amount)}</span>
            {x.account ? <> by <AddrPill account={x.account} noCopy /></> : null}
            <span className="muted"> · {depositStateWord(x)}{x.refundedAt ? <> <MomentLink at={x.refundedAt} now={now} /></> : null}</span>
          </div>
        </div>
      ))}
      {!d.decision && data.trackInfo && (
        <div className="gov-dep-fact">
          <div className="dt">Decision deposit</div>
          <div className="dd"><span className="mono">{hdx(data.trackInfo.decisionDeposit)}</span> <span className="muted">· not placed</span></div>
        </div>
      )}
    </>
  )
}

// A list shows five rows until asked for the rest (the house list length).
const SHOWN = 5

function ReferendumDepositRow({ d }: { d: AccountDeposits['referenda'][number] }) {
  const refund = depositRefund(d)
  return (
    <li className="gov-dep-row">
      <span className="gov-dep-main">
        <Link to={paths.referendum('opengov', d.index)} className="gov-deadline-title"><span className="mono muted">#{d.index}</span> {d.title ?? `Referendum #${d.index}`}</Link>
        <span className="gov-dep-meta">{depositName(d)} · {hdx(d.amount)} · <span className={d.state === 'refundable' ? 'gov-dep-open' : undefined}>{depositStateWord(d)}</span></span>
      </span>
      {refund && <span className="gov-dep-acts"><RefundButton action={refund} title="Refund deposit" /><CartToggle action={refund} /></span>}
    </li>
  )
}

function PreimageRow({ p }: { p: PreimageDeposit }) {
  const refund = preimageRefund(p)
  const use = p.usedBy.length ? p.usedBy.map(u => `#${u.index}`).join(', ') : null
  return (
    <li className="gov-dep-row">
      <span className="gov-dep-main">
        <span className="gov-dep-hash"><span className="mono" title={p.hash}>Preimage {shortHash(p.hash)}</span>{p.usedBy[0] && <> <Link to={paths.referendum('opengov', p.usedBy[0].index)} className="hash">for #{p.usedBy[0].index}</Link></>}</span>
        <span className="gov-dep-meta">
          {p.len != null ? `${F.int(p.len)} bytes · ` : ''}{hdx(p.amount)} · {p.blocked ? <>stays while {use ?? 'a referendum'} runs</> : <span className="gov-dep-open">refundable</span>}{p.legacy ? ' · old format' : ''}
        </span>
      </span>
      {refund && <span className="gov-dep-acts"><RefundButton action={refund} title="Refund preimage deposit" /><CartToggle action={refund} /></span>}
    </li>
  )
}

/**
 * An account's open deposits (account Governance tab, /governance/me): the HDX its
 * referendum deposits and stored preimages hold, what can be refunded now, and one
 * "Refund all" for the lot. A null preimage list is still loading, never "none".
 */
export function AccountDepositsSection({ deposits }: { deposits: AccountDeposits }) {
  const [all, setAll] = useState(false)
  const pre = deposits.preimages ?? []
  const rows: ({ kind: 'ref'; d: AccountDeposits['referenda'][number] } | { kind: 'pre'; p: PreimageDeposit })[] = [
    ...deposits.referenda.map(d => ({ kind: 'ref' as const, d })),
    ...pre.map(p => ({ kind: 'pre' as const, p })),
  ]
  if (!rows.length) return null
  const everything = refundAll(deposits)
  const shown = all ? rows : rows.slice(0, SHOWN)
  const total = actionsTotal(everything)
  const totals = heldAndKept(deposits)
  return (
    <section className="gov-section gov-deposits-sec">
      <h3 className="gov-h3">Deposits <span className="gov-h2-sub">· {hdx(totals.held.toString())} held{totals.kept > 0n ? ` · ${hdx(totals.kept.toString())} kept by the chain` : ''}</span>
        <InfoTip label="About deposits">
          Proposing a referendum reserves a submission deposit, deciding it a decision deposit, and storing a call a preimage deposit. A concluded referendum’s deposits are refunded by anyone’s signature, always to whoever placed them; a rejected or timed-out referendum keeps its submission deposit. Only the account that stored a preimage can remove it and take its deposit back, and not while a running referendum still needs it.
        </InfoTip>
      </h3>
      {everything.length > 0 && (
        <div className="gov-dep-head">
          <span className="gov-dep-note">{hdx(deposits.totals.refundable)} refundable now</span>
          <button type="button" className="gov-btn" onClick={() => openVote({ kind: 'actions', items: everything, title: 'Refund deposits' })}>
            Refund all ({everything.length} · {hdx(total.toString())})
          </button>
        </div>
      )}
      <ul className="gov-dep-list">
        {shown.map(r => r.kind === 'ref'
          ? <ReferendumDepositRow key={`r:${r.d.index}:${r.d.kind}`} d={r.d} />
          : <PreimageRow key={`p:${r.p.hash}`} p={r.p} />)}
      </ul>
      {rows.length > shown.length && <button type="button" className="gov-more" onClick={() => setAll(true)}>Show {rows.length - shown.length} more</button>}
    </section>
  )
}
