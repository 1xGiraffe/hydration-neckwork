import { vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { ClickHouseClient } from '../../src/db/client.ts'
import { resetDataAuthForTests } from '../../src/data/services/auth.ts'
import { resetCacheForTests } from '../../src/services/cache.ts'
import { assertNoShadowedAlias } from './sqlGuard.ts'

// Shared fixtures for the data-API contract tests: a fake ClickHouse client
// dispatching on the `-- data:…` SQL markers (or a table-name fallback), plus
// the standing token the auth hook resolves.
//
// The indexed HEAD is one constant across every data test file on purpose: the
// head/status read is cached process-wide under a single key
// (`data:v1:status`, 1.5 s), so two tests disagreeing about the head inside
// one TTL would race each other through the shared cache.
export const TEST_HEAD = 9_000_000
export const TEST_HEAD_TIME = '2026-08-28 12:00:00'
export const TEST_SPEC_VERSION = 440

export const TEST_ACCOUNT = `0x${'11'.repeat(32)}`
export const TEST_TOKEN = `hdd_${'ab'.repeat(32)}`
export const AUTH = { authorization: `Bearer ${TEST_TOKEN}` }

type Row = Record<string, unknown>
export interface Seen { query: string; params: Record<string, unknown> }

export type QueryHandler = (query: string, params: Record<string, unknown>) => Row[] | undefined

export interface FakeDataClient {
  seen: Seen[]
  query: ReturnType<typeof vi.fn>
  command: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  inserted: Array<{ table: string; values: Row[] }>
}

// Handlers run in order; the first returning an array answers the query. The
// built-in tail answers the auth/limits/head reads every request needs.
export function fakeDataClient(...handlers: QueryHandler[]): FakeDataClient {
  const seen: Seen[] = []
  const inserted: Array<{ table: string; values: Row[] }> = []
  const builtins: QueryHandler[] = [
    // The page-scoped extrinsic-hash enrichment every event/leg feed runs. The
    // default answers nothing (items render extrinsicHash: null); a test that
    // asserts the join passes its own handler for this marker.
    query => (query.includes('-- data:enrich:extrinsic-hashes') ? [] : undefined),
    // The page-scoped event-time closes every historical flow feed prices with.
    // The default answers nothing (valueUsd renders null); a test that asserts
    // valuation passes its own handler for this marker.
    query => (query.includes('-- data:prices:event-time-closes') ? [] : undefined),
    (query, params) => {
      if (!query.includes('FROM price_data.user_api_tokens')) return undefined
      return params.hash === sha256Hex(TEST_TOKEN) ? [{ account_id: TEST_ACCOUNT }] : []
    },
    query => (query.includes('FROM price_data.user_api_limits') ? [] : undefined),
    query => (query.includes('FROM price_data.user_api_usage') ? [] : undefined),
    query => (query.includes('-- data:status:head')
      ? [{ block_height: TEST_HEAD, ts: TEST_HEAD_TIME, spec_version: TEST_SPEC_VERSION }]
      : undefined),
  ]
  const all = [...handlers, ...builtins]
  return {
    seen,
    inserted,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      const params = query_params ?? {}
      seen.push({ query, params })
      // Every SQL a route sends is checked for the self-shadowing alias that
      // has 500'd live several times and that no fake-client assertion can see.
      assertNoShadowedAlias(query)
      for (const handler of all) {
        const rows = handler(query, params)
        if (rows) return { json: vi.fn(async () => rows) }
      }
      throw new Error(`unexpected query: ${query}`)
    }),
    command: vi.fn(async () => ({})),
    insert: vi.fn(async ({ table, values }: { table: string; values: Row[] }) => { inserted.push({ table, values }) }),
  }
}

import { createHash } from 'node:crypto'
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function freshDataApp(client: FakeDataClient): Promise<FastifyInstance> {
  resetDataAuthForTests()
  resetCacheForTests()
  const { buildDataApp } = await import('../../src/data/app.ts')
  return buildDataApp({ client: client as unknown as ClickHouseClient, logger: false })
}
