import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { errorEnvelope } from '../schemas/common.ts'
import { SUPPLY_TOKENS, SupplyUnresolvableError, coingeckoTickers, coingeckoTotalSupply } from '../services/coingecko.ts'

// The CoinGecko facade (spec § Phase 2 → "CoinGecko facade"). These two routes
// exist to replace HydraDX-api's /coingecko/v1/* with a base-URL swap, so their
// shapes follow CoinGecko's DEX ticker spec and the OLD feed's field names —
// they are deliberately NOT the /v1 wire conventions the rest of this API uses,
// and they are outside /v1 for exactly that reason.

const zError = z.object({ error: z.object({ code: z.string(), message: z.string() }) })

// Field names, field ORDER and field TYPES are the incumbent feed's: the six
// quantitative fields are JSON numbers there, so they are numbers here.
const zTicker = z.object({
  ticker_id: z.string().describe('`<base>_<target>`. Not unique on its own: a pair traded in several pools has one row per pool, told apart by `pool_id`.'),
  base_currency: z.string(),
  target_currency: z.string(),
  last_price: z.number().describe('Base units per one target unit, from the most recent fill in the window.'),
  base_volume: z.number().describe('Base-asset volume over the window, counting both trade directions.'),
  target_volume: z.number().describe('Target-asset volume over the window, counting both trade directions.'),
  pool_id: z.string().describe('`omnipool`, or `<venue>:<pool key>` — a stableswap pool id, an XYK pool account, an aToken contract account, an OTC order id.'),
  liquidity_in_usd: z.number().describe('Current USD depth behind the pair. 0 where the venue holds no reserves (money-market wraps, OTC) or the pool is unpriced.'),
  high: z.number(),
  low: z.number(),
})

const TICKERS_DESCRIPTION = [
  'CoinGecko DEX ticker spec: one row per pool and asset pair filled in the rolling 24 hours. A drop-in replacement for `api.hydradx.io/coingecko/v1/tickers` — same fields, same pair canonicalisation, same price and volume definitions.',
  '`last_price`, `high` and `low` are the base/target quantity ratio of a single fill (the most recent one, the largest and the smallest). The pair is canonical: H2O, GDOT and GETH are pinned to the target side, in that order of precedence, and every other pair is ordered by symbol. `base_volume` and `target_volume` sum every fill of the pair in BOTH directions, so a round trip is counted twice — the incumbent feed\'s convention.',
  'An asset quotes under the asset it wraps (aUSDT as USDT, 2-Pool-GDOT as GDOT), taken from the indexed asset registry rather than a hand-maintained token list. A pair whose asset carries no registry symbol at all — external XCM assets are registered on chain without one — is omitted rather than published under an invented code.',
  'The Omnipool routes every swap through its hub and emits one fill per hop, so a swap there appears as two tickers against H2O rather than one direct pair.',
  'Money-market wrap flows are not DEX trades and are excluded: supplying USDT mints aUSDT one for one, which emits the same swap event as a trade but has no price, no reserves and no counterparty. The old feed counted them, folded invisibly inside merged tickers.',
  'Field names, field order and field TYPES are the incumbent feed\'s: `last_price`, `base_volume`, `target_volume`, `liquidity_in_usd`, `high` and `low` are JSON numbers (CoinGecko documents the string form too and accepts either, but a consumer\'s parser must survive a base-URL swap unchanged). Everything behind them is exact integer arithmetic at 18 decimal places; the single float conversion happens at the wire, so a value needing more than a double\'s ~15–17 significant digits is rounded there. `/v1` is the surface that keeps full precision as decimal strings.',
  'Deviations from the incumbent feed, both deliberate: `pool_id` names the real pool instead of repeating `ticker_id`, so a pair traded in several pools reports each pool\'s own depth, and `liquidity_in_usd` is real — the old feed hardcoded it to 0. The window is anchored to the newest indexed swap fill, not to wall clock or an independently advancing blocks head, and a cold cache computes on demand instead of answering 503.',
].join('\n\n')

const SUPPLY_DESCRIPTION = [
  `Total supply of one of \`${SUPPLY_TOKENS.join('`, `')}\`, in whole tokens, in the incumbent endpoint's body shape.`,
  'Reconstructed from indexed state with NO per-request RPC: HOLLAR from the ERC-20 balance model, GDOT and GETH from the underlying held by their money-market receipt-token contract (their reserves have never minted variable debt, which every read re-checks, so custody is the whole supply), H2O from indexed substrate issuance.',
  'A source this model cannot read answers 503, never 0: a missing reserve entry, an unindexed balance or a reserve that has started lending are all "unknown supply", and publishing zero for any of them would be a wrong number an aggregator keeps.',
].join('\n\n')

export const coingeckoRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/coingecko/v1/tickers', {
    schema: {
      tags: ['coingecko'],
      summary: '24h DEX tickers per pool and pair',
      description: TICKERS_DESCRIPTION,
      response: { 200: z.array(zTicker) },
    },
  }, async () => coingeckoTickers(opts.client))

  app.get('/coingecko/v1/totalsupply/:token', {
    schema: {
      tags: ['coingecko'],
      summary: 'Total supply of a Hydration product token',
      description: SUPPLY_DESCRIPTION,
      params: z.object({ token: z.string().describe(SUPPLY_TOKENS.join(' | ')) }),
      response: {
        200: z.object({ result: z.string().describe('Whole tokens as a decimal string.') }),
        404: zError,
        503: zError.describe('The supply exists but could not be read from indexed state.'),
      },
    },
  }, async (req, reply) => {
    const { token } = req.params
    let supply: string | null
    try {
      supply = await coingeckoTotalSupply(opts.client, token.toLowerCase())
    } catch (err) {
      // An unreadable source is reported as one. Rendering it as 0 would publish
      // a number an aggregator keeps long after the read starts working again.
      if (!(err instanceof SupplyUnresolvableError)) throw err
      req.log.error({ err }, 'coingecko total supply unresolvable')
      return reply.code(503).send(errorEnvelope('upstream_error', err.message))
    }
    // 404 rather than a schema-level 400, matching the incumbent endpoint's
    // answer for a token it does not publish.
    if (supply == null) return reply.code(404).send(errorEnvelope('not_found', `no total supply for token '${token}'`))
    return { result: supply }
  })
}
