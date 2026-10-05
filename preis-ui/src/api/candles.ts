import type { ApiCandle, OHLCVInterval, OmniwatchVolumeDetails } from '../types'

interface FetchCandlesParams {
  baseId: number
  quoteId: number
  interval: OHLCVInterval
  from: number
  to: number
  // Price against the USD-pegged quote asset itself instead of reading it as USD.
  quoteAsset?: boolean
}

export async function fetchCandles(params: FetchCandlesParams, signal?: AbortSignal): Promise<ApiCandle[]> {
  const qs = new URLSearchParams({
    baseId: String(params.baseId),
    quoteId: String(params.quoteId),
    interval: params.interval,
    from: String(params.from),
    to: String(params.to),
  })
  if (params.quoteAsset) qs.set('quoteAsset', '1')
  const res = await fetch(`/api/candles?${qs}`, { signal })
  if (!res.ok) {
    throw new Error(`Failed to fetch candles: ${res.status}`)
  }
  return res.json()
}

interface FetchVolumeDetailsParams {
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
    throw new Error(`Couldn’t load the volume details (HTTP ${res.status})`)
  }
  return res.json()
}
