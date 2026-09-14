import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Guards for read-path rules that live inside SQL or inside statement ORDER, and
// so have no value to assert. Each one below was a real defect: silent, and of a
// kind that a passing end-to-end test would not have caught either, because the
// wrong answer is well-formed.
const source = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

const hdxService = source('services/hdxService.ts')
const tagService = source('services/tagService.ts')
const accountAffinityService = source('services/accountAffinityService.ts')
const verifierClient = source('services/verifierClient.ts')
const governanceService = source('services/governanceService.ts')

// Raw ranges can be re-inserted, so anything that COUNTS or SUMS a
// ReplacingMergeTree has to resolve the replacements first. On /hdx the damage
// landed entirely on the budget cap: `executions` doubles too, but it cancels
// inside sum_in/executions, so only `remaining` — and with it the schedule's
// modelled HDX/day — collapsed toward zero.
describe('DCA flow aggregates deduplicate before they sum', () => {
  it('reads the executions and the schedules with FINAL', () => {
    const at = hdxService.indexOf('async function loadDcaScheduleFlows')
    expect(at).toBeGreaterThan(-1)
    const body = hdxService.slice(at, hdxService.indexOf('type DcaFlowRow', at))
    expect(body).toContain("FROM price_data.dca_events FINAL WHERE event_name = 'DCA.TradeExecuted'")
    expect(body).toContain('FROM price_data.dca_schedules s FINAL')
  })

  it('is the same rule the intent-flow twin already follows', () => {
    expect(hdxService).toContain('FROM price_data.intent_events FINAL')
  })
})

// A ClickHouse map subscript on a missing key returns the value type's default,
// and 0.0 is indistinguishable from a real price. An account that raised its HDX
// balance in a week with no asset-0 candle booked that tranche at a $0 cost
// basis, and arrayFold carried it forward for the rest of that account's
// history — dragging trends.realizedPrice down permanently.
describe('the weekly HDX close map has no holes', () => {
  it('forward-fills onto a contiguous Monday grid through the current week', () => {
    const at = hdxService.indexOf('AS pmap,')
    expect(at).toBeGreaterThan(-1)
    const decl = hdxService.slice(hdxService.lastIndexOf('(SELECT mapFromArrays', at), at)
    expect(decl).toContain('arrayFill(')
    expect(decl).toContain('greatest(max(w), toStartOfWeek(today(), 1))')
    // The grid is every Monday between the first candle and that end, so a week
    // inside the era can never miss.
    expect(decl).toContain('range(toUInt32(intDiv(dateDiff(\'day\', minw, maxw), 7)) + 1)')
  })

  it('still seeds weeks BEFORE the first candle from the era price', () => {
    expect(hdxService).toContain('if(t.1 < price_era, seed_px, pmap[t.1])')
  })
})

// atoken_reserve_map is ReplacingMergeTree(updated_at) ORDER BY
// (asset_address, atoken). A corrected vdebt/pool_proxy under a fixed key leaves
// the superseded row visible until merge, and mmTagMemberRows never REMOVES a
// member — so the tag would gain the stale contract permanently.
describe('money-market tag sync', () => {
  it('reads the reserve map with FINAL, as its explorer twin does', () => {
    expect(tagService).toContain('FROM price_data.atoken_reserve_map FINAL')
    expect(tagService).not.toContain('FROM price_data.atoken_reserve_map\n')
  })
})

// loadDirectTransfers BUILDS the cex account list with lower() on every
// comparison; loadCexInteractions consumed it raw. Any mixed-case account made
// the second return zero rows, so the shared_cex reason silently vanished from
// every affinity result and the score dropped 8 points, with no error.
describe('CEX interaction matching is case-normalised on both sides', () => {
  it('lowers the raw args_json accounts before comparing them to the cex list', () => {
    const at = accountAffinityService.indexOf('async function loadCexInteractions')
    expect(at).toBeGreaterThan(-1)
    const body = accountAffinityService.slice(at, accountAffinityService.indexOf('function emptyResponse', at))
    expect(body).toContain('AND (lower(from_acc) IN ({cexAccounts:Array(String)}) OR lower(to_acc) IN ({cexAccounts:Array(String)}))')
    // Including the branch predicates, which decide which side is the user.
    expect(body.split('if(lower(t.from_acc) IN ({cexAccounts:Array(String)})').length - 1).toBe(2)
    expect(body).not.toContain('if(t.from_acc IN (')
  })
})

// The abort timer covered only the HEADERS while the body was read outside the
// try: a verifier that answered 200 and then stalled mid-body held a Fastify
// connection open with no bound at all. Every sibling in the tree awaits its
// body inside the try.
describe('verifier calls are bounded through the body, not just the headers', () => {
  it('reads the response text inside the try the abort timer guards', () => {
    const at = verifierClient.indexOf('export async function verifyStandardJson')
    expect(at).toBeGreaterThan(-1)
    const body = verifierClient.slice(at)
    const read = body.indexOf('await res.text()')
    const clear = body.indexOf('clearTimeout(timer)')
    expect(read).toBeGreaterThan(-1)
    expect(read).toBeLessThan(clear)
  })
})

// A ConvictionVoting.VoteRemoved is emitted only while the poll is Ongoing, so
// it IS the "withdrawal or post-close unlock?" answer and needs no block bound.
// `conclusionBlock - 1` dropped the conclusion block entirely, and a removal
// landing in it before the close is a real withdrawal whose balance would
// otherwise keep backing the tally.
describe('withdrawals may land in the conclusion block itself', () => {
  it('passes the conclusion block unmodified, with its position', () => {
    expect(governanceService).toContain('conclusionBlock ?? 0xffff_ffff, closePosition)')
    expect(governanceService).not.toContain('? conclusionBlock - 1 :')
  })

  it('bounds the unconfirmed paths by POSITION rather than by block', () => {
    const at = governanceService.indexOf('async function loadWithdrawals')
    expect(at).toBeGreaterThan(-1)
    const body = governanceService.slice(at, governanceService.indexOf('const big =', at))
    expect(body).toContain('isAfter(concludedAt,')
    // Democracy has no removal event at all, and OpenGov below
    // CONVICTION_VOTED_FIRST_BLOCK predates one, so both compare positions.
    expect(body).toContain('Number(row.block_height) < CONVICTION_VOTED_FIRST_BLOCK && beforeClose(row)')
    expect(body).toContain('removals = removals.filter(beforeClose)')
  })
})
