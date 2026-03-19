import { createClient } from '@clickhouse/client'
import { config } from '../config.ts'

export function createClickHouseClient() {
  return createClient({
    url: config.clickhouse.url,
    database: config.clickhouse.database,
    password: config.clickhouse.password,
    clickhouse_settings: {
      do_not_merge_across_partitions_select_final: 1,
    },
  })
}

export type { ClickHouseClient } from '@clickhouse/client'
