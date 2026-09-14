import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { getExtrinsicActivity, initExplorerService } from '../src/services/explorerService.ts'
import { resetCacheForTests } from '../src/services/cache.ts'
import type { ClickHouseClient } from '../src/db/client.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// One send, two legs, the SAME amount: the Polkadot Treasury pays AssetHub 5,000 USDC
// and 5,000 USDT every ~45 minutes. Only the extrinsic's own withdrawals say which
// registry asset each leg was, one withdrawal per leg — so a lookup keyed on amount
// collapses the pair, and the surviving row can even carry the other leg's asset.
const SENDER = `0x${'44'.repeat(32)}`
const USDC = 22, USDT = 10
const AMOUNT = '5000000000'

const withdrawn = (eventIndex: number, currencyId: number) => ({
  block_height: 900_100,
  ts: '2026-08-04 10:00:00',
  event_index: eventIndex,
  extrinsic_index: 3,
  event_name: 'Currencies.Withdrawn',
  call_address: '',
  args_json: JSON.stringify({ currencyId, who: SENDER, amount: AMOUNT }),
})

const send = {
  block_height: 900_100,
  ts: '2026-08-04 10:00:00',
  event_index: 9,
  extrinsic_index: 3,
  event_name: 'XTokens.TransferredAssets',
  call_address: '',
  args_json: JSON.stringify({
    sender: SENDER,
    assets: [
      { id: {}, fun: { __kind: 'Fungible', value: AMOUNT } },
      { id: {}, fun: { __kind: 'Fungible', value: AMOUNT } },
    ],
    fee: { id: {}, fun: { __kind: 'Fungible', value: AMOUNT } },
    dest: { parents: 1, interior: { __kind: 'X2', value: [{ __kind: 'Parachain', value: 1000 }, { id: SENDER, __kind: 'AccountId32' }] } },
  }),
}

function fakeClient(events: Record<string, unknown>[]): ClickHouseClient {
  return {
    query: async (opts: { query: string }) => ({
      json: async () => (opts.query.includes('FROM price_data.raw_events') && opts.query.includes('args_json')
        && opts.query.includes('extrinsic_index = {i:UInt32}')
        ? events
        : []),
    }),
  } as unknown as ClickHouseClient
}

describe('the extrinsic page claims one withdrawal per XCM leg', () => {
  beforeEach(() => resetCacheForTests())

  it('renders two same-amount legs as their two different assets', async () => {
    initExplorerService(fakeClient([withdrawn(7, USDC), withdrawn(8, USDT), send]))
    const rows = (await getExtrinsicActivity(900_100, 3, { revenue: false }))
      .filter(r => r.type === 'xcm')

    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.asset?.assetId)).toEqual([USDC, USDT])
    expect(rows.map(r => r.amount)).toEqual([AMOUNT, AMOUNT])
    // Each leg stays addressable: they share the send's event index, so the ordinal is
    // the only thing separating them.
    expect(rows.map(r => r.xcmLegIndex)).toEqual([0, 1])
  })
})

// The remaining two invariants live in the shared builder, which no exported surface
// reaches directly; both are stated as code shape so a later edit cannot quietly undo
// them.
describe('the outbound XCM feed', () => {
  it('reads an extrinsics withdrawals unfiltered by the requested token', () => {
    const at = explorerService.indexOf('async function buildOutboundXcmRows')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))

    // A send's delivery fee is usually a DIFFERENT asset from its payload, so pruning
    // the withdrawals to the requested token strips the fee leg off every row (and lets
    // a leg claim a same-amount withdrawal belonging to another asset). The token
    // predicate is enforced on built rows instead.
    expect(body).toContain(`event_name='Currencies.Withdrawn'`)
    expect(body).not.toContain('assetIdFilterSql')
    expect(body).toContain('xcmLegAssets(parsed.amounts, available)')
  })

  it('identifies a row by its send and leg ordinal, never by asset and amount', () => {
    const at = explorerService.indexOf('async function getRecentXcm(')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))

    expect(body).toContain('row => `${row.blockHeight}:${row.eventIndex}:${row.xcmLegIndex ?? 0}`')
    expect(body).not.toContain('row.asset?.assetId ?? -1')
  })
})
