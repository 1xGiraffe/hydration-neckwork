import type { ApiCandle, OHLCVInterval } from '../types'

export interface FetchCandlesParams {
  baseId: number
  quoteId: number
  interval: OHLCVInterval
  from: number
  to: number
}

export async function fetchCandles(params: FetchCandlesParams): Promise<ApiCandle[]> {
  const qs = new URLSearchParams({
    baseId: String(params.baseId),
    quoteId: String(params.quoteId),
    interval: params.interval,
    from: String(params.from),
    to: String(params.to),
  })
  const res = await fetch(`/api/candles?${qs}`)
  if (!res.ok) {
    throw new Error(`Failed to fetch candles: ${res.status}`)
  }
  return res.json()
}
