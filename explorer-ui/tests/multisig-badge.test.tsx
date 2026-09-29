import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExtRow } from '../src/components/ActivityRows'
import type { ExtrinsicOrigin, ExtrinsicSummary } from '../src/types'

// The origin badge on a multisig row. A PENDING operation reads as progress
// toward execution — approvals out of the threshold, the same "1/3" the
// multisig's own Pending section says. A finished one reads as its shape,
// threshold out of members ("3/5" = 3-of-5).
function row(origin: ExtrinsicOrigin): ExtrinsicSummary {
  return {
    blockHeight: 15_171_035, index: 2, hash: '0x' + '11'.repeat(32), timestamp: '2026-09-29 09:29:00',
    signer: null, success: true, callName: 'Multisig.as_multi', fee: null, origin,
  }
}
const badge = (origin: ExtrinsicOrigin) => {
  const html = renderToStaticMarkup(<table><tbody><ExtRow x={row(origin)} now={Date.now()} showOrigin /></tbody></table>)
  return html.match(/class="pill-badge"[^>]*>([^<]*)/)?.[1] ?? ''
}

describe('multisig origin badge', () => {
  it('shows approvals out of the threshold while pending', () => {
    expect(badge({ kind: 'multisig', state: 'pending', threshold: 3, signatories: 5, approvals: 1 })).toBe('1/3 ⏳')
  })

  it('shows threshold out of members once executed', () => {
    expect(badge({ kind: 'multisig', state: 'executed', threshold: 3, signatories: 5, approvals: 3 })).toBe('3/5 ✓')
  })

  it('shows only the mark when the threshold is unknown', () => {
    expect(badge({ kind: 'multisig', state: 'pending', threshold: 0, signatories: 0, approvals: 1 })).toBe('⏳')
  })
})
