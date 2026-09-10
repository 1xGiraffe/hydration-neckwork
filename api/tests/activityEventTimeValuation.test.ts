import { beforeEach, describe, expect, it } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'
import {
  activityHistPick,
  activityRowMatchesFilters,
  applyHistoricalUsd,
  initExplorerService,
  type ActivityRow,
  type AssetRef,
} from '../src/services/explorerService.ts'

// A flow is worth what it was worth WHEN it happened. These pin the two halves of
// that rule for the FEED: which legs a row's value stands for, and that the value
// is the sum of those legs at their own block-time closes — never today's price,
// and never a partial sum standing in for an unpriced leg.

const ref = (assetId: number, decimals: number): AssetRef =>
  ({ assetId, iconAssetId: assetId, symbol: `A${assetId}`, name: null, decimals, parachainId: null, origin: null })

const TS = '2026-09-09 12:22:42'
const HOUR = '2026-09-09 12:00:00'

// Ids used only here, so the process-wide close cache cannot answer from another test.
const TOKEN0 = 990_001 // 10 decimals, floating
const TOKEN1 = 990_002 // 18 decimals, near par
const UNPRICED = 990_003

const v3LpRow = (): ActivityRow => ({
  type: 'liquidity', blockHeight: 14_402_015, timestamp: TS, eventIndex: 42, extrinsicIndex: 2,
  who: null, to: null, asset: ref(TOKEN0, 10), amount: '21245733705342',
  assetIn: ref(TOKEN0, 10), assetOut: ref(TOKEN1, 18),
  amountIn: '21245733705342', amountOut: '2500000000000000000000',
  valueUsd: 4829.15, liqAction: 'Add', poolAddress: '0x5c6208a3c316a801f8996750aa7b6f45fc988548',
})

// Answers the one ASOF read historicalCloses issues, from the (asset, hour) tuples
// the query itself carries.
function fakeClient(closes: Record<number, string>) {
  const queries: string[] = []
  const client = {
    query: async ({ query }: { query: string }) => {
      queries.push(query)
      return {
        json: async () => {
          if (!query.includes('price_data.ohlc_1h')) throw new Error(`Unexpected query: ${query}`)
          return [...query.matchAll(/\((\d+),'([^']+)'\)/g)]
            .map(([, id, ts]) => ({ asset_id: Number(id), ts, close: closes[Number(id)] }))
            .filter(row => row.close != null)
        },
      }
    },
  } as unknown as ClickHouseClient
  return { client, queries }
}

describe('activityHistPick', () => {
  it('names BOTH tokens of a concentrated-liquidity LP row', () => {
    expect(activityHistPick(v3LpRow())).toEqual([
      { assetId: TOKEN0, decimals: 10, raw: '21245733705342', ts: TS },
      { assetId: TOKEN1, decimals: 18, raw: '2500000000000000000000', ts: TS },
    ])
  })

  it('leaves an LP row with an incomplete pair unvalued rather than valuing one side', () => {
    expect(activityHistPick({ ...v3LpRow(), amountOut: null })).toBeNull()
  })

  it('still values an ordinary row on its OUT leg and a flow on its moved asset', () => {
    const trade: ActivityRow = {
      type: 'trade', blockHeight: 1, timestamp: TS, eventIndex: 1, extrinsicIndex: 1,
      who: null, to: null, asset: null, amount: null,
      assetIn: ref(TOKEN0, 10), assetOut: ref(TOKEN1, 18), amountIn: '1', amountOut: '2', valueUsd: null,
    }
    expect(activityHistPick(trade)).toEqual({ assetId: TOKEN1, decimals: 18, raw: '2', ts: TS })
    const transfer: ActivityRow = {
      type: 'transfer', blockHeight: 1, timestamp: TS, eventIndex: 1, extrinsicIndex: 1,
      who: null, to: null, asset: ref(TOKEN0, 10), amount: '7',
      assetIn: null, assetOut: null, amountIn: null, amountOut: null, valueUsd: null,
    }
    expect(activityHistPick(transfer)).toEqual({ assetId: TOKEN0, decimals: 10, raw: '7', ts: TS })
  })

  it('leaves pool creation and destruction to their own builders', () => {
    expect(activityHistPick({ ...v3LpRow(), poolAddress: undefined, liqAction: 'Create' })).toBeNull()
    expect(activityHistPick({ ...v3LpRow(), poolAddress: undefined, liqAction: 'Destroy' })).toBeNull()
  })
})

describe('applyHistoricalUsd', () => {
  beforeEach(() => { initExplorerService(undefined as unknown as ClickHouseClient) })

  it('values a two-leg LP row as the sum of both legs at their block-time closes', async () => {
    const { client, queries } = fakeClient({ [TOKEN0]: '1.176707870000', [TOKEN1]: '0.999000000000' })
    initExplorerService(client)
    const row = v3LpRow()
    await applyHistoricalUsd([row], activityHistPick)
    // 2124.5733705342 × 1.17670787 + 2500 × 0.999 — not either leg alone, and not
    // the current-price sum the row was built with.
    expect(row.valueUsd).toBeCloseTo(2124.5733705342 * 1.17670787 + 2500 * 0.999, 6)
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain(`'${HOUR}'`)
  })

  it('judges a USD floor on the exact sum of both legs', async () => {
    initExplorerService(fakeClient({ [TOKEN0]: '1.176707870000', [TOKEN1]: '0.999000000000' }).client)
    const row = v3LpRow()
    await applyHistoricalUsd([row], activityHistPick)
    expect(activityRowMatchesFilters(row, { min: 4_996, unit: 'usd' })).toBe(true)
    expect(activityRowMatchesFilters(row, { min: 4_998, unit: 'usd' })).toBe(false)
  })

  it('leaves the row unvalued when one leg has no close, rather than showing the priced half', async () => {
    initExplorerService(fakeClient({ [TOKEN0]: '1.176707870000' }).client)
    const row = { ...v3LpRow(), assetOut: ref(UNPRICED, 18) }
    await applyHistoricalUsd([row], activityHistPick)
    expect(row.valueUsd).toBeNull()
  })
})
