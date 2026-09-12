// `name` only labels the failure: the public API service reads PUBLIC_API_PORT
// (src/public/server.ts), so a bad value must name the variable the operator set.
export function parsePort(value: string | undefined, name = 'API_PORT'): number {
  const raw = value?.trim() || '3000'
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer, received ${JSON.stringify(value)}`)
  const port = Number(raw)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be between 1 and 65535, received ${JSON.stringify(value)}`)
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
  // Defuse 1Click, which resolves the destination leg of a cross-chain swap
  // (services/xcswapSettlements.ts). The token is a distribution-channel
  // identifier rather than a secret, but it is still a credential the operator
  // supplies: unset leaves the resolution off, and a cross-chain swap then shows
  // its on-chain half with the destination stated as unknown.
  oneClickBaseUrl: process.env.ONE_CLICK_BASE_URL?.trim() || 'https://1click.chaindefuser.com',
  oneClickToken: process.env.ONE_CLICK_TOKEN?.trim() || '',
  // Kraken's public OHLC, the reference series for the cross-chain pairs whose
  // destination asset does not trade on Hydration (services/foreignPrices.ts).
  krakenBaseUrl: process.env.KRAKEN_BASE_URL?.trim() || 'https://api.kraken.com/0/public',
} as const
