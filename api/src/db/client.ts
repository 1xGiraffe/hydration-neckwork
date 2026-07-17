import { createClient } from '@clickhouse/client'
import { config } from '../config.ts'

export function createClickHouseClient() {
  return createClient({
    url: config.clickhouse.url,
    database: config.clickhouse.database,
    password: config.clickhouse.password,
    request_timeout: 25_000,
    clickhouse_settings: {
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
    },
  })
}

// For multi-minute maintenance statements (historical backfill INSERT…SELECTs):
// the default client's short request timeout would abort them mid-flight. These
// jobs still get hard memory/thread caps and spill large groups to disk so a
// background rebuild cannot starve live requests or indexers.
export function createLongOpClickHouseClient() {
  return createClient({
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
  })
}

// For schema bootstrap on a fresh ClickHouse server: `000_database.sql` creates
// the `price_data` database and every schema statement is fully qualified with
// it, so bootstrap must connect without selecting `price_data` (it doesn't
// exist yet). Binds to ClickHouse's built-in `default` database instead.
export function createDefaultDatabaseClickHouseClient() {
  return createClient({
    url: config.clickhouse.url,
    database: 'default',
    password: config.clickhouse.password,
  })
}

export type { ClickHouseClient } from '@clickhouse/client'
