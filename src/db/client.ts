import { createClient } from '@clickhouse/client'
import { config } from '../config.js'

export function createClickHouseClient() {
  return createClient({
    url: config.CLICKHOUSE_URL,
    database: config.CLICKHOUSE_DB,
    password: config.CLICKHOUSE_PASSWORD,
    clickhouse_settings: {
      do_not_merge_across_partitions_select_final: 1,
    },
  })
}

export function createOfflineMigrationClickHouseClient() {
  return createClient({
    url: config.CLICKHOUSE_URL,
    database: config.CLICKHOUSE_DB,
    password: config.CLICKHOUSE_PASSWORD,
    request_timeout: 3_600_000,
    clickhouse_settings: {
      max_threads: 4,
      max_memory_usage: '8000000000',
      max_bytes_before_external_group_by: '2000000000',
      max_bytes_before_external_sort: '2000000000',
      join_algorithm: 'auto',
    },
  })
}

export type { ClickHouseClient } from '@clickhouse/client'
