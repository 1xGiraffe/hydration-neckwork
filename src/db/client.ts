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

/**
 * Memory and thread ceilings for an ad-hoc pass over raw history.
 *
 * Every such query runs against the SAME ClickHouse the live deployment serves
 * from, so it has to be bounded BEFORE it is run — writing nothing does not make
 * it safe. Unbounded, a full-history pass over raw_extrinsics/raw_events reaches
 * ~84 GiB RSS; the next container to allocate then trips the kernel's global OOM
 * killer, which takes ClickHouse and every service on the box with it. The same
 * work bounded stays near 3 GiB.
 *
 * These are the ceiling only — a caller still owes the query a partition- or
 * sort-key predicate and, for a full sweep, block-range chunking.
 */
export const BOUNDED_QUERY_SETTINGS = { max_memory_usage: '3000000000', max_threads: 4 } as const

export type { ClickHouseClient } from '@clickhouse/client'
