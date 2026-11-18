import { Amt } from '../ui'
import { GovDetails } from './Disclosure'
import { curveWords, days, shape, short, span } from './trackRuleText'
import type { GovernanceTrackInfo } from '../../governanceTypes'

// A track's three bars as the house ribbon, with the rest of its rules one fold away,
// in the proposal wizard.

/** The three rules a referendum on the track is judged by, as the page's ribbon; the rest are one fold away. */
export function TrackFacts({ t, msPerBlock }: { t: GovernanceTrackInfo; msPerBlock: number }) {
  return (
    <>
      <div className="ribbon standalone gov-ribbon">
        <div className="cell"><span className="k">Approval</span><span className="v">{span(t.curve.map(c => c.approval))}</span><span className="s">{shape(curveWords(t.minApproval, t.curve.map(c => c.approval)))}</span></div>
        <div className="cell"><span className="k">Support</span><span className="v">{span(t.curve.map(c => c.support))}</span><span className="s">{shape(curveWords(t.minSupport, t.curve.map(c => c.support)))}</span></div>
        <div className="cell"><span className="k">Decision</span><span className="v">{short(t.decisionPeriod, msPerBlock)}</span><span className="s">+ confirm {short(t.confirmPeriod, msPerBlock)}</span></div>
      </div>
      <GovDetails summary="More rules" className="gov-track-more">
        <dl className="gov-track-facts">
          <div><dt>Before deciding</dt><dd>at least {days(t.preparePeriod, msPerBlock)}, and a decision deposit of <Amt raw={t.decisionDeposit} dec={12} /> HDX</dd></div>
          <div><dt>To pass</dt><dd>both bars held for {days(t.confirmPeriod, msPerBlock)} in a row (confirmation), within the decision period of {days(t.decisionPeriod, msPerBlock)}</dd></div>
          <div><dt>After passing</dt><dd>enacted no sooner than {days(t.minEnactmentPeriod, msPerBlock)} later</dd></div>
          <div><dt>At once</dt><dd>up to {t.maxDeciding} {t.maxDeciding === 1 ? 'referendum decides' : 'referenda decide'} at a time ({t.deciding} now)</dd></div>
        </dl>
      </GovDetails>
    </>
  )
}
