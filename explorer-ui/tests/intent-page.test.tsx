import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '../src/api/explorer'
import { useIntentOrder } from '../src/hooks/useExplorerData'
import { Intent } from '../src/pages/Intent'
import { DcaSchedule } from '../src/pages/DcaSchedule'
import { ExtrinsicDetail } from '../src/pages/ExtrinsicDetail'
import { parseRoute, paths } from '../src/router'
import { mockIceSolution, mockSync } from './fixtures/mockApi'
import type { DcaScheduleDetail, ExtrinsicDetail as ExtrinsicDetailResponse, IntentOrderDetail } from '../src/types'

// An ICE intent id is a u128 that starts past u64 — the low 64 bits are the short
// "#seq" handle. 2^64 is order #0; the mock makes odd sequences DCA intents.
const SWAP_ID = '18446744073709551616'
const DCA_ID = '18446744073709551617'

// The real client goes through fetch; answering it from the shared fixture is what
// lets one test pin the URL the client builds AND the shape the page renders.
function stubFetchFromFixture() {
  const fetchMock = vi.fn(async (url: string) => {
    const body = mockSync<unknown>(url.replace(/^\/api/, ''))
    return body === undefined
      ? new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function fixture(id: string): IntentOrderDetail {
  const data = mockSync<IntentOrderDetail>(`/explorer/intent/${id}?offset=0&limit=25`)
  if (!data) throw new Error(`no intent fixture for ${id}`)
  return data
}

function renderIntent(id: string, data: IntentOrderDetail = fixture(id)): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['intent-order', id, 0], data)
  return renderToStaticMarkup(<QueryClientProvider client={client}><Intent intentId={id} /></QueryClientProvider>)
}

describe('the /intent/<id> route', () => {
  it('is its own route, never an activity slug: a bare u128 has no dash', () => {
    expect(parseRoute(`/intent/${SWAP_ID}`)).toEqual({ name: 'intent', intentId: SWAP_ID })
    expect(parseRoute(paths.intent(DCA_ID))).toEqual({ name: 'intent', intentId: DCA_ID })
    // The id survives as text: a number would round 2^64 + 1 away.
    const parsed = parseRoute(paths.intent(DCA_ID))
    expect(parsed.name === 'intent' && parsed.intentId).toBe(DCA_ID)
  })
  it('sends a malformed or missing id to the Trade tab, like the other trade pages', () => {
    expect(parseRoute('/intent/abc')).toEqual({ name: 'legacy', to: '/activity?tab=trade' })
    expect(parseRoute('/intent/123-e4')).toEqual({ name: 'legacy', to: '/activity?tab=trade' })
    expect(parseRoute('/intent')).toEqual({ name: 'legacy', to: '/activity?tab=trade' })
  })
})

describe('api.intentOrder and useIntentOrder', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks /explorer/intent/<id> with the page bounds and returns the order', async () => {
    const fetchMock = stubFetchFromFixture()
    const data = await api.intentOrder(SWAP_ID)
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([`/api/explorer/intent/${SWAP_ID}?offset=0&limit=25`])
    expect(data.order.intentId).toBe(SWAP_ID)
    expect(data.order.seq).toBe(0)
    await api.intentOrder(SWAP_ID, 50, 25)
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/explorer/intent/${SWAP_ID}?offset=50&limit=25`)
  })

  it('caches under the key the page test seeds', () => {
    const client = new QueryClient()
    function Probe() { useIntentOrder(SWAP_ID); return null }
    renderToStaticMarkup(<QueryClientProvider client={client}><Probe /></QueryClientProvider>)
    expect(client.getQueryCache().getAll().map(q => q.queryKey)).toEqual([['intent-order', SWAP_ID, 0]])
  })
})

describe('the Intent page — a filled limit order', () => {
  const html = renderIntent(SWAP_ID)

  it('titles the order by kind and short sequence, with its status pill', () => {
    expect(html).toContain('Limit order #0')
    expect(html).toMatch(/●\s*filled</)
  })
  it('crumbs lead back to the Trade tab of the activity feed', () => {
    expect(html).toContain('href="/activity?tab=trade"')
  })
  it('lists both fills, each linking to its own event rather than back to this page', () => {
    expect((html.match(/data-label="Activity"/g) ?? []).length).toBe(2)
    // A row's target rides its data-activity attribute (slug/id). With the execution
    // flag the id is the fill's own coordinates; without it every row would carry the
    // order id and lead straight back here.
    expect(html).toContain('data-activity="intent-fill/12848143-e6"')
    expect(html).toContain('data-activity="intent-fill/12848133-e5"')
    expect(html).not.toContain(`data-activity="intent-fill/${SWAP_ID}"`)
    expect(html).not.toContain(`href="${paths.intent(SWAP_ID)}"`)
  })
  it('states the limit, the owner, and where it was submitted and settled', () => {
    expect(html).toContain('Limit')
    expect(html).toContain('USDT per DOT')
    expect(html).toContain('1L53bU')                               // the owner pill
    expect(html).toContain('href="/extrinsic/')                    // submission + solutions
    expect(html).toContain('Callbacks')
    expect(html).toContain('HDX')                                  // the callback fee, in the native asset
  })
})

describe('the Intent page — an open DCA intent', () => {
  const html = renderIntent(DCA_ID)

  it('titles it as a DCA intent and shows the budget still to spend', () => {
    expect(html).toContain('DCA intent #1')
    expect(html).toMatch(/●\s*open</)
    expect(html).toContain('Budget')
    expect(html).toContain(' left')
    expect(html).toContain('every ')
  })
  it('names the DCA schedule it was migrated from', () => {
    expect(html).toContain('Migrated from')
    expect(html).toContain(`href="${paths.dcaSchedule(33546)}"`)
  })
})

describe('the DCA schedule page — runtime 443 migration states', () => {
  function renderDca(patch: Partial<DcaScheduleDetail>): string {
    const base = mockSync<DcaScheduleDetail>('/explorer/dca/33546?offset=0&limit=25')
    if (!base) throw new Error('no dca fixture')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(['dca-schedule', 33546, 0], { ...base, ...patch })
    return renderToStaticMarkup(<QueryClientProvider client={client}><DcaSchedule scheduleId={33546} /></QueryClientProvider>)
  }

  it('links a migrated schedule to the intent that replaced it', () => {
    const html = renderDca({ status: 'migrated', statusAt: '2026-09-08 09:00:00', migratedToIntentId: DCA_ID })
    expect(html).toMatch(/●\s*migrated</)
    expect(html).toContain('Migrated to')
    expect(html).toContain(`href="${paths.intent(DCA_ID)}"`)
  })
  it('states why a migration was cancelled and what was refunded', () => {
    const html = renderDca({ status: 'migration-cancelled', statusAt: '2026-09-08 09:00:00', migrationReason: 'token frozen', migrationRefunded: '32500000000000' })
    expect(html).toMatch(/●\s*migration-cancelled</)
    expect(html).toContain('token frozen')
    expect(html).toContain('refunded')
    expect(html).toContain('3.25k DOT')
  })
  it('still renders the four pre-443 states', () => {
    for (const status of ['active', 'completed', 'terminated', 'cancelled'] as const) {
      expect(renderDca({ status })).toMatch(new RegExp(`●\\s*${status}<`))
    }
  })
})

describe('the extrinsic page — ICE solution panel', () => {
  const ID = '12848613-4'
  function renderExtrinsic(patch: Partial<ExtrinsicDetailResponse>): string {
    const base = mockSync<ExtrinsicDetailResponse>('/explorer/extrinsic-at/12848613/4')
    if (!base) throw new Error('no extrinsic fixture')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(['extrinsic', ID], { ...base, ...patch })
    client.setQueryData(['extrinsic-activity', ID], [])
    return renderToStaticMarkup(<QueryClientProvider client={client}><ExtrinsicDetail id={ID} /></QueryClientProvider>)
  }

  it('renders the solution card only when the extrinsic carries one', () => {
    expect(renderExtrinsic({})).not.toContain('ICE solution')
    const html = renderExtrinsic({ callName: 'ICE.submit_solution', iceSolution: mockIceSolution() })
    expect(html).toContain('ICE solution')
    expect(html).toContain('Pot trades')
    expect(html).toContain('Fees swept')
    expect(html).toContain('Matched')
    expect(html).toContain('Routed')
  })
})
