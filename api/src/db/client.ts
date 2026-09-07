import { Readable } from 'node:stream'
import { createClient, ResultSet, type ClickHouseClient } from '@clickhouse/client'
import { config } from '../config.ts'

// The per-query settings every API read runs under. Exported so a test can pin
// the limits the request paths depend on.
export const API_CLICKHOUSE_SETTINGS = {
  do_not_merge_across_partitions_select_final: 1,
  // Fairness under concurrency: the host runs multiple workloads, so one API
  // query must not fan out across every core or
  // build an unbounded join hash table. Well-formed API queries stay far
  // below both caps; the caps stop a regression from starving the host.
  max_threads: 8,
  max_memory_usage: '4000000000',
  max_execution_time: 20,
  max_result_rows: '100000',
  result_overflow_mode: 'throw',
  // A tag page interpolates its members' account list into SQL, 68 bytes each and
  // several copies per statement; the 730-member xyk-pools tag ran past the 256 KiB
  // default and answered 500. The ceiling only sizes the parser buffer.
  max_query_size: '1048576',
} as const

export function createClickHouseClient() {
  return drainQueryResponses(createClient({
    url: config.clickhouse.url,
    database: config.clickhouse.database,
    password: config.clickhouse.password,
    request_timeout: 25_000,
    clickhouse_settings: { ...API_CLICKHOUSE_SETTINGS },
  }))
}

// For multi-minute maintenance statements (historical backfill INSERT…SELECTs):
// the default client's short request timeout would abort them mid-flight. These
// jobs still get hard memory/thread caps and spill large groups to disk so a
// background rebuild cannot starve live requests or indexers.
export function createLongOpClickHouseClient() {
  return drainQueryResponses(createClient({
    url: config.clickhouse.url,
    database: config.clickhouse.database,
    password: config.clickhouse.password,
    request_timeout: 3_600_000,
    clickhouse_settings: {
      max_threads: 4,
      max_insert_threads: '2',
      max_memory_usage: '3000000000',
      max_bytes_before_external_group_by: '1000000000',
      max_bytes_before_external_sort: '1000000000',
      max_execution_time: 3600,
    },
  }))
}

// For schema bootstrap on a fresh ClickHouse server: `000_database.sql` creates
// the `price_data` database and every schema statement is fully qualified with
// it, so bootstrap must connect without selecting `price_data` (it doesn't
// exist yet). Binds to ClickHouse's built-in `default` database instead.
export function createDefaultDatabaseClickHouseClient() {
  return drainQueryResponses(createClient({
    url: config.clickhouse.url,
    database: 'default',
    password: config.clickhouse.password,
  }))
}

// Every query response is read to its END before the ResultSet reaches the caller.
//
// The node client hands back a ResultSet over the live HTTP response, and the pooled
// socket under it (`max_open_connections`, 10 per process) returns to the pool only
// once that body has been consumed. The readers here await a Promise.all of a dozen
// queries and only then call .json() on each — so with the pool full, the responses
// that had already arrived sat unread and pinned exactly the sockets the remaining
// queries were queued for. Nothing moved until ClickHouse's keep_alive_timeout (10s)
// closed the idle connections: a cold block page measured 20.3s as three waves of
// four 4ms queries, ten seconds apart. And a result no caller ever read — the
// surviving siblings of a Promise.all whose one member threw — pinned its socket for
// good; six of those left the process a pool of four (179 "socket was closed or
// ended before the response was fully read" warnings in 26 hours).
//
// Draining here bounds a socket's life to the query's own duration, whatever the
// caller does with the result afterwards. The bytes are the ones .json() would have
// buffered anyway, and the result handed back is the library's own ResultSet over
// that buffer, so .json()/.text() — including the exception-at-end-of-body
// detection — behave exactly as before. Every read in this codebase is JSONEachRow
// through .json() and nothing calls .stream(), so no consumer needs the live stream.
export function drainQueryResponses(client: ClickHouseClient): ClickHouseClient {
  const query = client.query.bind(client)
  client.query = (async (params: Parameters<ClickHouseClient['query']>[0]) => {
    const live = await query(params)
    const text = await live.text()
    return ResultSet.instance({
      stream: Readable.from([Buffer.from(text, 'utf8')]),
      format: params.format ?? 'JSON',
      query_id: live.query_id,
      response_headers: live.response_headers,
      log_error: error => console.error('[clickhouse] result set error', error.message),
    })
  }) as ClickHouseClient['query']
  return client
}

export type { ClickHouseClient } from '@clickhouse/client'
