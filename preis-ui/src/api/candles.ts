import type { ApiCandle, OHLCVInterval, OmniwatchVolumeDetails } from '../types'

export interface FetchCandlesParams {
  baseId: number
  quoteId: number
  interval: OHLCVInterval
  from: number
  to: number
}

export async function fetchCandles(params: FetchCandlesParams, signal?: AbortSignal): Promise<ApiCandle[]> {
  const qs = new URLSearchParams({
    baseId: String(params.baseId),
    quoteId: String(params.quoteId),
    interval: params.interval,
    from: String(params.from),
    to: String(params.to),
  })
  const res = await fetch(`/api/candles?${qs}`, { signal })
  if (!res.ok) {
    throw new Error(`Failed to fetch candles: ${res.status}`)
  }
  return res.json()
}

export interface FetchVolumeDetailsParams {
  baseId: number
  quoteId: number
  interval: OHLCVInterval
  time: number
  limit?: number
  offset?: number
}

export async function fetchVolumeDetails(
  params: FetchVolumeDetailsParams,
  signal?: AbortSignal,
): Promise<OmniwatchVolumeDetails> {
  const qs = new URLSearchParams({
    baseId: String(params.baseId),
    quoteId: String(params.quoteId),
    interval: params.interval,
    time: String(params.time),
  })
  if (params.limit != null) qs.set('limit', String(params.limit))
  if (params.offset != null) qs.set('offset', String(params.offset))
  const res = await fetch(`/api/candles/volume-details?${qs}`, { signal })
  if (!res.ok) {
    throw new Error(`Failed to fetch volume details: ${res.status}`)
  }
  return res.json()
}
