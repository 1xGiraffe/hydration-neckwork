import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatusBadge } from '../src/components/gov/GovUi'

// Lists keep colour for what needs attention: a settled-yes status is plain text,
// a live one a pill, a failed one a red pill and a stopped one an amber pill.
const html = (status: string, extra: { failing?: boolean; failedCall?: boolean } = {}) => renderToStaticMarkup(<StatusBadge status={status} {...extra} />)

describe('StatusBadge', () => {
  it('writes settled-yes statuses as plain text, executed as "Approved"', () => {
    expect(html('approved')).toBe('<span class="gov-status-text">Approved</span>')
    expect(html('executed')).toContain('>Approved<')
    expect(html('executed')).not.toContain('badge')
    expect(html('passed')).toBe('<span class="gov-status-text">Passed</span>')
  })

  it('keeps a pill for live, failed and stopped states', () => {
    expect(html('confirming')).toContain('badge gov-status almost')
    expect(html('deciding')).toContain('badge gov-status neutral')
    expect(html('rejected')).toBe('<span class="badge gov-status bad">rejected</span>')
    expect(html('timed out')).toBe('<span class="badge gov-status bad stopped">timed out</span>')
    expect(html('cancelled')).toContain('stopped')
  })

  it('flags a live referendum that cannot pass, and an enacted call that failed', () => {
    expect(html('deciding', { failing: true })).toContain('not passing')
    expect(html('executed', { failedCall: true })).toContain('badge gov-status bad')
  })
})
