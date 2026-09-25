import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { OrdersTab } from '../src/components/positions/OrdersTab'
import { ORDER_STATUS_TONE, orderAvgPrice, orderHandle, parseOrderKind, parseOrderPage } from '../src/components/positions/ordersFormat'
import { mockOrderHistory, MOCK_ORDER_HISTORY_TOTAL } from './fixtures/positionsMock'
import type { ActiveDca, OpenLimitOrder, OrderHistoryPage, OrderHistoryRow, PositionScope } from '../src/types'

const ADDR = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'
const scope: PositionScope = { kind: 'account', address: ADDR }
const owner = { accountId: '0x' + 'aa'.repeat(32), address: ADDR, emoji: '🦊', tag: null }
const HDX = { assetId: 0, symbol: 'HDX', name: null, decimals: 12, parachainId: null }
const USDT = { assetId: 10, symbol: 'USDT', name: null, decimals: 6, parachainId: 1000 }

function row(over: Partial<OrderHistoryRow> = {}): OrderHistoryRow {
  return {
    kind: 'dca', id: '33400', who: owner, assetIn: HDX, assetOut: USDT, direction: 'Sell',
    status: 'completed', statusReason: null, migratedToIntentId: null,
    budgetAmount: '1000000000000000', soldAmount: '1000000000000000', receivedAmount: '21840000', soldUsd: 21.84,
    trades: 10, failedTrades: 0, openedBlock: 12_800_000, openedIndex: 2, openedAt: '2026-07-10 10:00:00',
    endedBlock: 12_840_000, endedEventIndex: 4, endedAt: '2026-07-14 10:00:00',
    ...over,
  }
}

function render(page: OrderHistoryPage | undefined, props: { activeDcas?: ActiveDca[]; openLimitOrders?: OpenLimitOrder[]; showOwner?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  if (page) qc.setQueryData(['order-history', 'account', ADDR, 0, 25, 'all'], page)
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <OrdersTab scope={scope} activeDcas={props.activeDcas ?? []} openLimitOrders={props.openLimitOrders ?? []} showOwner={props.showOwner}
        headBlock={12_848_613} now={Date.UTC(2026, 6, 15, 12)} blockSec={6} />
    </QueryClientProvider>,
  )
}

describe('orderAvgPrice', () => {
  it('scales each side by its own decimals', () => {
    // 1,000 HDX (12 dp) for 21.84 USDT (6 dp)
    expect(orderAvgPrice('1000000000000000', '21840000', 12, 6)).toBe('0.02184')
    // 2 WBTC (8 dp) for 134,482.2 USDT (6 dp)
    expect(orderAvgPrice('200000000', '134482200000', 8, 6)).toBe('67241.1')
    // an 18-dp out leg: 3 DOT (10 dp) for 13.3266 HOLLAR (18 dp)
    expect(orderAvgPrice('30000000000', '13326600000000000000', 10, 18)).toBe('4.4422')
  })
  it('stays exact beyond Number range', () => {
    const sold = (10n ** 30n).toString(), received = (3n * 10n ** 30n + 10n ** 12n).toString()
    expect(orderAvgPrice(sold, received, 18, 18)).toBe('3.000000000000000001')
  })
  it('has no price when nothing was sold', () => {
    expect(orderAvgPrice('0', '0', 12, 6)).toBeNull()
    expect(orderAvgPrice('abc', '1', 12, 6)).toBeNull()
  })
})

describe('order history URL state', () => {
  it('clamps the kind filter to known values', () => {
    expect(parseOrderKind('dca')).toBe('dca')
    expect(parseOrderKind('limit')).toBe('limit')
    expect(parseOrderKind('bogus')).toBe('all')
    expect(parseOrderKind(null)).toBe('all')
  })
  it('reads the page as a 0-based index', () => {
    expect(parseOrderPage(null)).toBe(0)
    expect(parseOrderPage('2')).toBe(2)
    expect(parseOrderPage('-1')).toBe(0)
    expect(parseOrderPage('x')).toBe(0)
  })
  it('names intents by their short sequence and schedules by id', () => {
    expect(orderHandle({ kind: 'dca', id: '33573' })).toBe('#33573')
    expect(orderHandle({ kind: 'limit', id: '55340232221128654848', seq: 1000 })).toBe('#1000')
  })
})

describe('status tones', () => {
  it('match the detail pages’ tones', () => {
    expect(ORDER_STATUS_TONE.completed).toBe('var(--sky)')
    expect(ORDER_STATUS_TONE.filled).toBe('var(--sky)')
    expect(ORDER_STATUS_TONE.migrated).toBe('var(--sky)')
    expect(ORDER_STATUS_TONE.terminated).toBe('var(--red)')
    expect(ORDER_STATUS_TONE['migration-cancelled']).toBe('var(--red)')
    expect(ORDER_STATUS_TONE.expired).toBe('var(--red)')
    expect(ORDER_STATUS_TONE.cancelled).toBe('var(--text-low)')
  })
})

describe('OrdersTab', () => {
  it('says so quietly when nothing is active, and lists the history', () => {
    const html = render({ total: 1, offset: 0, limit: 25, rows: [row({ status: 'terminated', statusReason: 'TradeLimitReached', failedTrades: 3 })] })
    expect(html).toContain('No active DCA or limit orders')
    expect(html).not.toContain('ord-kpis')
    expect(html).toContain('Order history · 1')
    expect(html).toContain('data-order-history="dca/33400"')
    expect(html).toContain('color:var(--red)')
    expect(html).toContain('title="TradeLimitReached"')
    expect(html).toContain('3 failed')
    expect(html).toContain('>DCA<')
    // the average price, rough scale, out per in
    expect(html).toMatch(/0\.0218[^<]*<\/span>[^]*?USDT[^]*?per HDX/)
    expect(html).not.toContain('>Owner<')
  })
  it('shows the owner column on tags and links a migrated schedule to its intent', () => {
    const html = render({ total: 1, offset: 0, limit: 25, rows: [row({ status: 'migrated', migratedToIntentId: '18446744073709552617' })] }, { showOwner: true })
    expect(html).toContain('>Owner<')
    expect(html).toContain('href="/intent/18446744073709552617"')
  })
  it('renders a dash for an owner the API could not resolve', () => {
    const html = render({ total: 1, offset: 0, limit: 25, rows: [row({ who: null })] }, { showOwner: true })
    expect(html).toMatch(/data-label="Owner"><span[^>]*>—<\/span><\/td>/)
    expect(html).not.toContain('addr-pill')
  })
  it('names kinds and the filter-specific empty state', () => {
    const html = render({ total: 2, offset: 0, limit: 25, rows: [row({ kind: 'limit', id: '55340232221128654848', seq: 1000, direction: null, status: 'filled' }), row({ kind: 'dca-intent', id: '55340232221128654849', seq: 1001, direction: null })] })
    expect(html).toContain('>Limit<')
    expect(html).toContain('>DCA intent<')
    expect(html).toContain('#1000')
    expect(render({ total: 0, offset: 0, limit: 25, rows: [] })).toContain('No finished orders yet')
  })
  it('renders a skeleton while the first page loads', () => {
    expect(render(undefined)).toContain('sk-tr')
  })
  it('leads with the KPI line when orders are active', () => {
    const limit: OpenLimitOrder = {
      intentId: '18446744073709551616', seq: 0, who: owner, assetIn: HDX, assetOut: USDT,
      amountIn: '1000000000000000', amountOut: '25000000', filledIn: '0', filledOut: '0', remainingIn: '1000000000000000', remainingOut: '25000000',
      fills: 0, partial: true, limitPrice: 0.025, valueUsd: 21.84, placedBlock: 12_840_000, placedIndex: 2, timestamp: '2026-07-14 10:00:00', deadline: null,
    }
    const html = render({ total: 0, offset: 0, limit: 25, rows: [] }, { openLimitOrders: [limit] })
    expect(html).toContain('ord-kpis')
    expect(html).toContain('Limit orders')
    expect(html).toContain('Resting')
    expect(html).not.toContain('DCA orders</span>')
    expect(html).not.toContain('No active DCA')
  })
})

describe('order history fixture', () => {
  it('pages by offset/limit and filters by kind with stable identities', () => {
    const all = mockOrderHistory(new URLSearchParams('offset=0&limit=25'), `/explorer/address/${ADDR}/order-history`)
    expect(all.total).toBe(MOCK_ORDER_HISTORY_TOTAL)
    expect(all.rows).toHaveLength(25)
    const second = mockOrderHistory(new URLSearchParams('offset=25&limit=25'), `/explorer/address/${ADDR}/order-history`)
    expect(second.rows).toHaveLength(MOCK_ORDER_HISTORY_TOTAL - 25)
    expect(new Set([...all.rows, ...second.rows].map(r => `${r.kind}/${r.id}`)).size).toBe(MOCK_ORDER_HISTORY_TOTAL)
    expect(all.rows.every(r => r.who.address === ADDR)).toBe(true)
    const limits = mockOrderHistory(new URLSearchParams('kind=limit'), '/explorer/tag/kraken/order-history')
    expect(limits.rows.every(r => r.kind === 'limit')).toBe(true)
    const dcas = mockOrderHistory(new URLSearchParams('kind=dca'), '/explorer/tag/kraken/order-history')
    expect(dcas.total + limits.total).toBe(MOCK_ORDER_HISTORY_TOTAL)
    // newest end first
    const ends = all.rows.map(r => r.endedBlock)
    expect([...ends].sort((a, b) => b - a)).toEqual(ends)
  })
})
