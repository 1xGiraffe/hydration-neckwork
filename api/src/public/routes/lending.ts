import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { zAssetId, zIsoTimestamp } from '../schemas/common.ts'
import { lendingCaps } from '../services/lendingCaps.ts'

// Money-market caps and utilization (spec § Phase 2 → "hydration.net stats +
// lending caps"). A superset of HydraDX-api's `/lending/v1/caps`: same path, the
// same four field names and JSON-number types on every row, plus the per-reserve
// detail the incumbent could not serve. Outside /v1 because the inherited fields
// are not the /v1 wire conventions.

const zCap = z.object({
  asset: z.string().describe('The reserve asset\'s registry name, e.g. "Hydrated Dollar".'),
  borrowCap: z.number().nullable().describe('Maximum borrowable, in whole tokens. Null when no cap has ever been set for this reserve. `0` is Aave\'s own "no cap" sentinel, not a freeze.'),
  currentBorrow: z.number().describe('Currently borrowed, in whole tokens, including accrued interest.'),
  available: z.number().nullable().describe('`borrowCap - currentBorrow`. Null when there is no cap to be available against; can be negative if a cap was lowered below current borrowing.'),
  borrowCapSource: z.enum(['facilitator', 'poolConfigurator']).nullable().describe('Which on-chain control set `borrowCap`: the market\'s HOLLAR facilitator bucket capacity, or the pool configurator\'s Aave borrow cap.'),
  market: z.string().nullable().describe('The isolated market this reserve belongs to: `core`, `gigahdx` or `bil`. The markets are never blended.'),
  assetId: zAssetId.nullable().describe('The reserve asset\'s registry id.'),
  symbol: z.string().nullable(),
  supplyCap: z.number().nullable().describe('Maximum suppliable, in whole tokens. Null when no cap has ever been set. As with `borrowCap`, `0` is Aave\'s own "no cap" sentinel rather than a freeze — stHDX ships `supplyCap: 0` against 1.23B supplied.'),
  currentSupply: z.number().describe('Currently supplied, in whole tokens, including accrued interest.'),
  utilization: z.number().nullable().describe('`currentBorrow / currentSupply`, between 0 and 1. Null when nothing is supplied — a facilitator-minted reserve such as HOLLAR has debt without deposits, and neither 0 nor infinity would describe it.'),
  asOf: zIsoTimestamp.describe('The indexed block whose reserve state this row reports.'),
})

const DESCRIPTION = [
  'Supply and borrow caps, current supply and borrow, and utilization for every reserve of every isolated money market. A drop-in replacement for `api.hydradx.io/lending/v1/caps`: the incumbent\'s four fields — `asset`, `borrowCap`, `currentBorrow`, `available` — keep their names, types and meaning, and the core market\'s HOLLAR row stays FIRST in the array so a consumer reading `body[0]` reads the same number it always did. The remaining reserves follow in a stable (market, symbol) order.',
  'Everything here is derived from indexed chain data — no per-request RPC. Aave caps are decoded from the pool configurator\'s `SupplyCapChanged`/`BorrowCapChanged` logs and are denominated in WHOLE TOKENS, as Aave stores them. HOLLAR carries no Aave cap because it is minted by a facilitator rather than deposited by lenders; its `borrowCap` is the market\'s facilitator bucket capacity, which is the limit the chain actually enforces, and `borrowCapSource` says which of the two a row used.',
  '`currentBorrow` is the reserve\'s scaled debt times its current variable borrow index — the same quantity the variable-debt token\'s `totalSupply` returns, which is what the incumbent read over RPC. The two agreed to within the interest accrued between the reads when this was verified.',
  'A reserve the pool has DELISTED is absent, not frozen at its last balance: the reserve map is rewritten in full each refresh cycle, so a reserve missing from the newest generation is dropped. An empty array means the money-market reserve model has no state at all (its aToken anchor has not been snapshotted) — it never means "no caps configured".',
  'Cached for 60 seconds, matching the incumbent\'s Redis TTL.',
].join('\n\n')

export const lendingRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/lending/v1/caps', {
    schema: {
      tags: ['lending'],
      summary: 'Money-market caps, borrow levels and utilization',
      description: DESCRIPTION,
      response: { 200: z.array(zCap) },
    },
  }, async () => lendingCaps(opts.client))
}
