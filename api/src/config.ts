export const config = {
  port: parseInt(process.env.API_PORT ?? '3000', 10),
  host: process.env.API_HOST ?? '0.0.0.0',
  clickhouse: {
    url: process.env.CLICKHOUSE_HOST ?? 'http://localhost:18123',
    database: 'price_data',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
  },
} as const
