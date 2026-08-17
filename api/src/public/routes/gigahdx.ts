import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { zIsoTimestamp } from '../schemas/common.ts'
import { VOTING_WINDOW_DAYS, gigahdxApr } from '../services/gigahdxApr.ts'

// GIGAHDX staking: the APR the staking dashboard displays (spec § Semantics 10).
// One aggregate resource carrying exactly what the UI renders — the three
// percentages of the header ("total = base + voting") and the two terms its
// stake modal personalizes with — so the endpoint stays cacheable for every
// viewer at once. /v1 is additive-only: a field can be added when a surface
// needs it, never removed, which is why nothing speculative ships here.

const zGigahdxApr = z.object({
  asOf: zIsoTimestamp.describe('The newest indexed block — every window here is anchored to it, not to wall clock.'),
  totalAprPerc: z.string().nullable().describe('base + voting, 4-decimal percent ("19.2000" = 19.2 %) — the headline. Null while either stream is unknown.'),
  baseAprPerc: z.string().nullable().describe('The exchange-rate stream: max(median of the 7/14/28d gigaHDX rate slopes, programme floor).'),
  votingAprPerc: z.string().nullable().describe('The voting stream at max conviction: max(realized paid-out rate, programme floor).'),
  paidOutPerYear: z.string().describe(`HDX actually paid into referendum reward pools over the trailing ${VOTING_WINDOW_DAYS}d, annualized by block timestamps — raw planck per year. With medianWeightedVotes, the personalization term.`),
  medianWeightedVotes: z.string().nullable().describe('Upper median of the window\'s per-referendum totalWeightedVotes (Σ min(voteBalance, stakedHDX) × convictionMultiplier), raw units. Null while no allocation is in the window.'),
})

const DESCRIPTION = [
  '**The number the staking dashboard shows**: `totalAprPerc = baseAprPerc + votingAprPerc`, each stream reported at `max(measured, programme floor)`.',
  '**Voting (realized, not projected)**: `100 × 8 × paidOutPerYear / medianWeightedVotes` — annualized HDX actually paid into referendum reward pools over the trailing window, at the maximum conviction multiplier (Locked6x ⇒ ×8; the ladder is 1x ⇒ ×0.25, 2x ⇒ ×0.5, 3x ⇒ ×1, 4x ⇒ ×2, 5x ⇒ ×4, 6x ⇒ ×8; Split/Abstain/no-conviction earn nothing). The reward pallet deletes its per-referendum storage as voters claim and its accumulator pot is a backlog, so neither carries an honest rate; allocation events cannot be deleted, which is what makes this number stable — it cannot cliff when chain storage is cleaned, and it decays gradually while governance is quiet.',
  'Personalized, for stake `s` (planck) at conviction multiplier `m`: `apr(s, m) = 100 × paidOutPerYear × s×m / (medianWeightedVotes + s×m) / s` — both terms are in this response. It assumes voting on every eligible referendum; skipping referenda earns proportionally less. The headline is the zero-stake limit.',
  '**Base (exchange-rate appreciation)**: the median of the 7/14/28-day slopes of the gigaHDX exchange rate `max(1, (TotalLocked + gigahdx! pot) / stHDX supply)`, each annualized by timestamps — a median of three windows so one anomalous boundary cannot move the result. Null in the first 7 days after launch (the floor stands alone there).',
  'The floors are the total-participation bounds of the treasury programme (4,109.59 HDX per 600 blocks to the base pot, 6,164.38 to the voting accumulator; HDX referendum #101): `100 × programmePerYear / totalStake`. The programme is a fixed schedule running to ~mid-2027, so the floors are guaranteed only while it runs; the measured terms follow a programme change with their windows\' lag.',
  `Windowing per Semantics 6: anchored to the newest indexed block, clamped to the GIGAHDX launch (2026-07-01), annualized by block timestamps (voting window ${VOTING_WINDOW_DAYS}d).`,
].join('\n\n')

const zError = z.object({ error: z.object({ code: z.string(), message: z.string() }) })

export const gigahdxRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/staking/gigahdx/apr', {
    schema: {
      tags: ['chain'],
      summary: 'GIGAHDX staking APR (base + voting, realized)',
      description: DESCRIPTION,
      response: { 200: zGigahdxApr, 500: zError },
    },
  }, async () => {
    const apr = await cached('pub:gigahdx:apr', 60_000, () => gigahdxApr(opts.client))
    // Exactly the UI's fields — the compute's richer internals (floors, measured
    // terms, window bookkeeping) stay server-side until a surface needs one.
    return {
      asOf: apr.asOf,
      totalAprPerc: apr.totalAprPerc,
      baseAprPerc: apr.baseAprPerc,
      votingAprPerc: apr.votingAprPerc,
      paidOutPerYear: apr.paidOutPerYear,
      medianWeightedVotes: apr.medianWeightedVotes,
    }
  })
}
