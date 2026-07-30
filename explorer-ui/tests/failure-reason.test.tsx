import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FailureReasonRow } from '../src/components/ui'

describe('FailureReasonRow', () => {
  it('stacks the error label above its docs so they share a left edge', () => {
    const html = renderToStaticMarkup(
      <FailureReasonRow reason={{ label: 'Router.TradingLimitReached', docs: 'The trading limit has been reached' }} />,
    )
    expect(html).toContain('Router.TradingLimitReached')
    expect(html).toContain('The trading limit has been reached')
    // The label + docs sit in one column-stacked wrapper rather than as two
    // items on the flex `.dd` row (which pushed the docs 4px out of alignment).
    expect(html).toContain('flex-direction:column')
  })

  it('renders only the label when there are no docs', () => {
    const html = renderToStaticMarkup(<FailureReasonRow reason={{ label: 'System.CallFiltered', docs: null }} />)
    expect(html).toContain('System.CallFiltered')
    expect(html).not.toContain('muted')
  })
})
