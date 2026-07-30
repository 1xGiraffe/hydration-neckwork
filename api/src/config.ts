export function parsePort(value: string | undefined): number {
  const raw = value?.trim() || '3000'
  if (!/^\d+$/.test(raw)) throw new Error(`API_PORT must be an integer, received ${JSON.stringify(value)}`)
  const port = Number(raw)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`API_PORT must be between 1 and 65535, received ${JSON.stringify(value)}`)
  }
  return port
}

export const config = {
  port: parsePort(process.env.API_PORT),
  host: process.env.API_HOST?.trim() || '0.0.0.0',
  clickhouse: {
    url: process.env.CLICKHOUSE_HOST?.trim() || 'http://localhost:18123',
    database: 'price_data',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
  },
} as const
