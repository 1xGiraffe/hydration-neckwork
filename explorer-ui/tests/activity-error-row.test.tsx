import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityTable } from '../src/components/ActivityTable'
import { ApiError } from '../src/api/explorer'

// A failed activity request must never read as "this account has no activity".
// The account/tag feeds reach real 400/503 responses on deep pages and on a
// too-broad value filter, and the API's message is the actionable part.
describe('activity table request failures', () => {
  it('renders the API message instead of the empty state', () => {
    const error = new ApiError(503, 'Requested activity window is too broad — narrow the filters.')
    const html = renderToStaticMarkup(<ActivityTable rows={[]} now={0} error={error} />)

    expect(html).toContain('table-error')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Requested activity window is too broad')
    expect(html).not.toContain('No activity')
  })

  it('offers a retry when the caller can refetch', () => {
    const html = renderToStaticMarkup(<ActivityTable rows={[]} now={0} error={new ApiError(503, 'boom')} onRetry={() => {}} />)

    expect(html).toContain('Try again')
  })

  it('falls back to a generic detail for a non-API failure', () => {
    const html = renderToStaticMarkup(<ActivityTable rows={[]} now={0} error={new TypeError('Failed to fetch')} />)

    expect(html).toContain('The request failed.')
    expect(html).not.toContain('No activity')
  })

  it('keeps the empty state for a successful empty response', () => {
    const html = renderToStaticMarkup(<ActivityTable rows={[]} now={0} />)

    expect(html).toContain('No activity')
    expect(html).not.toContain('table-error')
  })

  it('keeps already-loaded rows visible when a refetch fails', () => {
    const row = {
      type: 'transfer' as const,
      blockHeight: 1,
      timestamp: '2026-07-19 10:00:00',
      eventIndex: 1,
      extrinsicIndex: 1,
      who: null,
      to: null,
      asset: { assetId: 0, symbol: 'HDX', name: 'HDX', decimals: 12, icon: '', origin: null },
      assetIn: null,
      assetOut: null,
      amount: '1000000000000',
      amountIn: null,
      amountOut: null,
      valueUsd: 1,
    }
    const html = renderToStaticMarkup(<ActivityTable rows={[row as never]} now={0} error={new ApiError(503, 'boom')} />)

    expect(html).not.toContain('table-error')
    expect(html).toContain('HDX')
  })
})
