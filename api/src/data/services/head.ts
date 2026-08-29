import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { iso } from '../schemas/common.ts'

// The Data API's own small head/status service (the public status.ts idiom):
// one point read on raw_blocks at max(block_height), held for 1.5 s. It is
// both GET /v1/status's payload and the head every live feed's cache key
// carries (`data:…:h{head}`), so a shared cache entry can never outlive the
// block it was computed against by more than this TTL. max() resolves from the
// parts' minmax index (a few hundred rows); `ORDER BY block_height DESC LIMIT
// 1` read one granule from every part of the live partition instead —
// measured 1.8 M rows / 21 MiB per probe.
export interface DataStatus {
  indexedHead: number
  indexedHeadTime: string
  specVersion: number
  lagSeconds: number
}

const TTL_MS = 1_500

export function dataStatus(client: ClickHouseClient): Promise<DataStatus> {
  return cached('data:v1:status', TTL_MS, () => loadStatus(client))
}

// The live-feed cache tag. Callers append it to their keys; the 1.5 s status
// TTL bounds how long a feed can be served against a superseded head.
export async function liveHeadTag(client: ClickHouseClient): Promise<string> {
  const { indexedHead } = await dataStatus(client)
  return `h${indexedHead}`
}

async function loadStatus(client: ClickHouseClient): Promise<DataStatus> {
  const res = await client.query({
    query: `-- data:status:head
      SELECT block_height, toString(block_timestamp) AS ts, spec_version
      FROM price_data.raw_blocks
      WHERE block_height = (SELECT max(block_height) FROM price_data.raw_blocks)
      ORDER BY ingested_at DESC
      LIMIT 1
    `,
    format: 'JSONEachRow',
  })
  const [row] = await res.json<{ block_height: number; ts: string; spec_version: number }>()
  // An empty database reports height 0 and the epoch rather than failing: the
  // wire shape never varies.
  const indexedHead = Number(row?.block_height ?? 0) || 0
  const indexedHeadTime = iso(row?.ts || 0)
  return {
    indexedHead,
    indexedHeadTime,
    specVersion: Number(row?.spec_version ?? 0) || 0,
    lagSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(indexedHeadTime)) / 1000)),
  }
}

// The context every chain-resource 404 carries (concept § 6.2): where the
// index currently ends, so "not found" is distinguishable from "not yet
// ingested". `aheadBy` is present when the caller asked above the head.
export async function notFoundContext(client: ClickHouseClient, opts?: { requestedHeight?: number; hint?: string }): Promise<Record<string, unknown>> {
  const status = await dataStatus(client)
  const context: Record<string, unknown> = {
    indexedHead: status.indexedHead,
    indexedHeadTime: status.indexedHeadTime,
  }
  if (opts?.requestedHeight != null && opts.requestedHeight > status.indexedHead) {
    context.aheadBy = opts.requestedHeight - status.indexedHead
  }
  if (opts?.hint) context.hint = opts.hint
  return context
}
