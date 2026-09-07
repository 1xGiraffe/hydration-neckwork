import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ResultSet, type ClickHouseClient } from '@clickhouse/client'
import { drainQueryResponses } from '../src/db/client.ts'

// The pooled socket under a query response goes back to the pool only when the
// body has been read to its end. Every caller in this codebase awaits a
// Promise.all of several queries and only THEN reads each result — so with the
// pool full, the responses that did arrive sat unread and pinned the sockets the
// remaining queries were queued for, until ClickHouse's 10s keep_alive_timeout
// closed them (measured live: a cold block page = an exact multiple of ten
// seconds). A result a caller never read at all pinned its socket for good.
//
// The source stream stands in for that socket: it must be fully read before the
// caller gets the result, and whatever the caller then does with it.
const rows = [{ block_height: 14330461, event_index: 6 }, { block_height: 14330461, event_index: 7 }]
const body = rows.map(r => JSON.stringify(r)).join('\n') + '\n'

function clientOver(source: Readable): ClickHouseClient {
  return {
    query: async (params: { format?: string }) =>
      ResultSet.instance({ stream: source, format: (params.format ?? 'JSON') as 'JSONEachRow', query_id: 'q-1', log_error: () => {}, response_headers: {} }),
  } as unknown as ClickHouseClient
}

describe('drainQueryResponses', () => {
  it('reads the whole response before the caller sees the result', async () => {
    const source = Readable.from([Buffer.from(body)])
    const client = drainQueryResponses(clientOver(source))
    const result = await client.query({ query: 'SELECT 1', format: 'JSONEachRow' })
    expect(source.readableEnded).toBe(true)
    expect(await result.json()).toEqual(rows)
  })

  it('drains the response even when the caller never reads it', async () => {
    const source = Readable.from([Buffer.from(body)])
    const client = drainQueryResponses(clientOver(source))
    await client.query({ query: 'SELECT 1', format: 'JSONEachRow' })
    expect(source.readableEnded).toBe(true)
  })

  it('keeps the result set\'s identity and raw text', async () => {
    const client = drainQueryResponses(clientOver(Readable.from([Buffer.from(body)])))
    const result = await client.query({ query: 'SELECT 1', format: 'JSONEachRow' })
    expect(result.query_id).toBe('q-1')
    expect(await result.text()).toBe(body)
  })
})
