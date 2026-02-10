import { createClient } from '@clickhouse/client'

export function createClickHouseClient() {
  return createClient({
    url: process.env.CLICKHOUSE_HOST ?? 'http://localhost:18123',
    database: 'price_data',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    clickhouse_settings: {
      do_not_merge_across_partitions_select_final: 1,
    },
  })
}

export type { ClickHouseClient } from '@clickhouse/client'
