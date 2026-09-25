// A read's name, for system.query_log. The history leaves (LP, farm rewards, money
// market, lending incentives) open every statement with a `-- lp:…` / `-- lm:…` /
// `-- mm:…` comment naming it, but ClickHouse
// logs a parameterised query in its formatted form, comments stripped, so the
// same tag rides as the `log_comment` setting too (system.query_log.log_comment).
// A leaf: no imports.

/** The tag a statement's leading `-- tag` comment names, if any. */
export const queryTag = (query: string): string | undefined => /^\s*--\s*(\S+)/.exec(query)?.[1]

/** The query params with the leading comment's tag as `log_comment` (unchanged without one). */
export function tagged<P extends { query: string; clickhouse_settings?: object }>(params: P): P {
  const tag = queryTag(params.query)
  return tag ? { ...params, clickhouse_settings: { ...params.clickhouse_settings, log_comment: tag } } : params
}
