import { z } from 'zod'
import { formatParam, type ToolContext, type ToolDefinition, type ToolError, type ToolOutput } from '../toolTypes.ts'
import { invalidArgument, toolErrorFromUpstream } from '../errors.ts'
import type {
  AccountRef, AssetRef, ReferendaPage, ReferendumDetail, ReferendumListRow, ReferendumVoter, SearchResult,
} from '../types.ts'
import { DASH, formatAmount, formatCount, formatNumber, formatPercent, formatUsd, scaleAmount } from '../format/units.ts'
import { blocksToDuration, formatTime, relativeAge } from '../format/time.ts'
import { accountLabel, accountUrl, explorerLink, referendumUrl, shortHash } from '../format/refs.ts'
import { bullets, code, h2, h3, joinBlocks, kv, note, table } from '../format/md.ts'
import { failure, fit, output, parseInput } from './shared.ts'

/* ============ shapes types.ts does not mirror ============ */

interface GovernanceCounts { opengov: number; democracy: number; tcMotions: number; councilMotions: number; tips: number }

interface ReferendumProgress {
  phase: string
  decisionDepositPlaced?: boolean
  submittedBlock?: number | null
  decisionStartBlock?: number | null
  decisionEndBlock?: number | null
  confirmStartBlock?: number | null
  confirmEndBlock?: number | null
  timeoutBlock?: number | null
  approval?: ReferendumGauge | null
  support?: ReferendumGauge | null
  projection?: { state: string; confirmableAtBlock: number | null } | null
}

/**
 * One progress bar. Every field but the threshold is NULLABLE upstream: the
 * support gauge needs the electorate, which only the live chain read carries,
 * so a referendum whose live read failed has a threshold and no current — and
 * `passing` is then null, meaning "not known", not "no".
 *
 * `source` is the other half of the reading. 'chain' is the pallet's own tally;
 * 'attributed' is the INDEXED DIRECT VOTES, which carry no delegated weight, so
 * an approval figure computed from them understates a referendum that delegates
 * have backed. Both are printed, because the same percentage means two
 * different things depending on which it came from.
 */
interface ReferendumGauge {
  currentPerbill: number | null
  thresholdPerbill: number
  passing: boolean | null
  source: 'chain' | 'attributed' | null
}

interface ActiveReferendumCard {
  index: number
  title: string | null
  status: string
  track: { id: number; name: string } | null
  proposer: AccountRef | null
  submittedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
  progress: ReferendumProgress | null
  tally: { ayes: string; nays: string; support: string | null; source: 'live' | 'snapshot' } | null
}

interface GovernanceOverview { active: ActiveReferendumCard[]; counts: GovernanceCounts }

interface CollectiveMotionRow {
  index: number
  hash: string
  proposer: AccountRef | null
  threshold: number
  ayes: number
  nays: number
  call: string
  status: 'open' | 'approved' | 'disapproved' | 'executed' | 'failed'
  proposedAt: { blockHeight: number; timestamp: string } | null
  closedAt: { blockHeight: number; timestamp: string } | null
}
interface MotionsPage { total: number; rows: CollectiveMotionRow[] }

interface TreasuryTipRow {
  hash: string
  reason: string
  beneficiary: AccountRef | null
  payout: string | null
  status: 'open' | 'closing' | 'closed' | 'retracted'
  openedAt: { blockHeight: number; timestamp: string } | null
  closedAt: { blockHeight: number; timestamp: string } | null
}
interface TipsPage { total: number; rows: TreasuryTipRow[] }

/**
 * Tallies, tips and vote locks are all denominated in HDX, whose registry
 * decimals are 12. The overview and tip routes carry no AssetRef of their own,
 * so the native token's fixed decimals are stated here; a referendum detail
 * carries `asset` and is scaled by that instead.
 */
const HDX_DECIMALS = 12
const HDX_SYMBOL = 'HDX'

/**
 * Chain- and user-authored free text in a table cell: a tip reason, a
 * referendum title. Neither is bounded upstream, and one long one shifts the
 * whole answer over the text budget, which then cuts a LATER section entirely.
 * Trimming the cell is the cheap version of that loss and it is visible.
 */
const cell = (text: string | null | undefined, max = 110): string =>
  text == null || text === '' ? DASH : (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/**
 * Rows a two-table answer can afford before the server's text cap cuts one of
 * them off mid-way. Measured on the live motions payload at ~230 characters a
 * row, held to 80% of the budget so the headings, notes and an error block fit
 * beside it. Trimming BEFORE rendering is the contract (AGENTS.md § MCP server);
 * letting the transport do it drops whichever table sorts last, which is how
 * `limit: 100` used to answer "the Council has 232 motions" and then show none.
 */
const CHARS_PER_ROW = 230
const rowsPerTable = (ctx: ToolContext, limit: number, tables: number): number =>
  Math.max(1, Math.min(limit, Math.floor((ctx.maxTextChars * 0.8) / CHARS_PER_ROW / tables)))

const PALLETS = ['opengov', 'democracy'] as const
type Pallet = typeof PALLETS[number]
const KINDS = ['overview', 'referenda', 'referendum', 'motions', 'tips'] as const

/** A perbill (parts per billion) as a percentage: 999,827,797 → 99.98%. */
const perbill = (n: number | null | undefined, digits = 2): string =>
  n == null || !Number.isFinite(n) ? DASH : `${(n / 1e7).toFixed(digits)}%`

const GAUGE_SOURCE: Record<string, string> = {
  chain: 'from the pallet\'s own tally',
  attributed: 'from the INDEXED DIRECT VOTES only, so delegated weight is missing and the real figure is at least this',
}

/**
 * A gauge as a sentence. `passing` is a tri-state and the third state is the
 * one that matters: with no current figure the bar is UNKNOWN, and calling it
 * "failing" would report a referendum as losing a vote nobody has counted.
 */
function gaugeLine(g: ReferendumGauge | null | undefined, extra?: string): string | null {
  if (!g) return null
  const verdict = g.currentPerbill == null || g.passing == null
    ? 'not known — the live tally behind this bar could not be read, which is NOT the same as failing'
    : g.passing ? 'passing' : 'failing'
  const source = g.source ? ` · ${GAUGE_SOURCE[g.source] ?? g.source}` : ''
  return `${perbill(g.currentPerbill)} against a ${perbill(g.thresholdPerbill)} threshold — ${verdict}${source}${extra ?? ''}`
}

/* ============ description ============ */

const DESCRIPTION = `What is Hydration voting on, and how did a vote go? Covers both governance systems on the chain: OpenGov (pallet 'opengov', track-based, the live system) and the retired Democracy pallet ('democracy'), plus Technical-Committee and Council motions and treasury tips.

'kind' selects the reading:
- 'overview' (default) — the active referenda with their live tallies and phase progress, plus how many referenda, motions and tips exist in each system.
- 'referenda' — the referendum directory. With 'pallet' set it is that pallet's paged list and can be narrowed by 'status'; without 'pallet' it is the unified newest-first list across both.
- 'referendum' — one referendum in full: title, track, proposer, proposal call, status, the phase timeline, the tally, and the largest voters.
- 'motions' — Technical Committee and Council motions with their thresholds, aye/nay counts and outcome.
- 'tips' — treasury tips with beneficiary, payout and status.

THE AMBIGUITY YOU MUST HANDLE: both pallets index referenda from ZERO, so referendum 100 exists twice and means two different things. For kind 'referendum', pass 'pallet' as well as 'index'. If you pass only 'index', the tool resolves it through search: when exactly one pallet has that index it takes it and SAYS which; when both do, it refuses and lists the two titles so you can choose rather than being handed the wrong one.

THE TALLY DEFINITION YOU MUST NOT RESTATE NAIVELY: 'ayes' and 'nays' are CONVICTION-WEIGHTED capital (a 6x-locked vote counts six times its balance), while 'support' is UNWEIGHTED capital and counts AYE PLUS ABSTAIN — nay capital is excluded from support entirely. Approval is measured on the weighted ayes/nays; support is measured against the total issuance-based electorate. So a referendum can be passing on approval and failing on support, and "support" here never means "the share who agree". The rendering prints this beside every support figure.

Other things worth knowing: OpenGov carries an on-chain tally and track parameters, Democracy never does — its 'onChainTally', 'track' and 'trackInfo' are null by nature, not by omission. Track periods are stated in BLOCKS and converted with the runtime's nominal slot time. A referendum's page also exists on Subsquare; the link is included. Amounts are HDX scaled out of raw units.`

/* ============ tallies ============ */

interface TallyFigures { ayes: string; nays: string; support: string | null }

/**
 * The tally, with the two definitions spelled out. Support is the trap: it is
 * unweighted capital, it includes ABSTAIN, and it excludes NAY — so an agent
 * reading it as "share in favour" would be wrong twice over.
 */
function renderTally(
  t: TallyFigures,
  opts: { decimals: number; symbol: string; label: string; electorate?: string | null; omitApproval?: boolean; voters?: { ayes: number; nays: number; split: number; total: number } | null },
): string {
  const ayes = scaleAmount(t.ayes, opts.decimals)
  const nays = scaleAmount(t.nays, opts.decimals)
  const weighted = (ayes ?? 0) + (nays ?? 0)
  const approval = weighted > 0 && ayes != null ? (ayes / weighted) * 100 : null
  const support = t.support == null ? null : scaleAmount(t.support, opts.decimals)
  const electorate = opts.electorate == null ? null : scaleAmount(opts.electorate, opts.decimals)
  return kv([
    ['Tally source', opts.label],
    ['Aye (conviction-weighted)', ayes == null ? DASH : `${formatNumber(ayes)} ${opts.symbol}`],
    ['Nay (conviction-weighted)', nays == null ? DASH : `${formatNumber(nays)} ${opts.symbol}`],
    ['Approval', opts.omitApproval || approval == null ? null : formatPercent(approval)],
    ['Support', support == null ? DASH : `${formatNumber(support)} ${opts.symbol} — UNWEIGHTED capital, counting aye plus abstain and EXCLUDING nay${electorate ? `; ${formatPercent((support / electorate) * 100)} of the ${formatNumber(electorate)} ${opts.symbol} electorate` : ''}`],
    ['Voters', opts.voters ? `${formatCount(opts.voters.total)} (${formatCount(opts.voters.ayes)} aye, ${formatCount(opts.voters.nays)} nay${opts.voters.split ? `, ${formatCount(opts.voters.split)} split` : ''})` : null],
  ])
}

/* ============ overview ============ */

function renderOverview(d: GovernanceOverview, ctx: ToolContext): string {
  const c = d.counts
  const cards = (d.active ?? []).map(card => {
    const p = card.progress
    return joinBlocks(
      h3(`${explorerLink(`OpenGov #${card.index}`, referendumUrl(ctx.explorerBaseUrl, 'opengov', card.index))} — ${card.title ?? 'untitled'}`),
      kv([
        ['Status', `${card.status}${p?.phase && p.phase !== card.status ? ` (phase ${p.phase})` : ''}`],
        ['Track', card.track ? `${card.track.name} (#${card.track.id})` : null],
        ['Proposer', card.proposer ? explorerLink(accountLabel(card.proposer, { withAddress: true }), accountUrl(ctx.explorerBaseUrl, card.proposer.address)) : null],
        ['Submitted', card.submittedAt ? `${formatTime(card.submittedAt.timestamp)} · ${relativeAge(card.submittedAt.timestamp)} · block ${formatCount(card.submittedAt.blockHeight)}` : null],
        ['Approval', gaugeLine(p?.approval, ' (conviction-weighted aye over aye plus nay)')],
        ['Support', gaugeLine(p?.support, ' (aye plus abstain capital against the electorate, nay excluded)')],
        ['Confirming until', p?.confirmEndBlock ? `block ${formatCount(p.confirmEndBlock)}` : null],
        ['Decision ends', p?.decisionEndBlock ? `block ${formatCount(p.decisionEndBlock)}` : null],
        ['Projection', p?.projection ? p.projection.state : null],
      ]),
      card.tally
        ? renderTally(card.tally, { decimals: HDX_DECIMALS, symbol: HDX_SYMBOL, omitApproval: p?.approval != null, label: card.tally.source === 'live' ? 'live chain storage' : 'indexed snapshot' })
        : null,
    )
  })
  return joinBlocks(
    h2('Governance'),
    kv([
      ['OpenGov referenda', formatCount(c?.opengov)],
      ['Democracy referenda', `${formatCount(c?.democracy)} (retired pallet, still addressable)`],
      ['Technical Committee motions', formatCount(c?.tcMotions)],
      ['Council motions', formatCount(c?.councilMotions)],
      ['Treasury tips', formatCount(c?.tips)],
    ]),
    note('Both pallets index from zero, so a referendum index alone is ambiguous — always pair it with its pallet.'),
    h2(`Active referenda (${(d.active ?? []).length})`),
    cards.length ? joinBlocks(...cards) : note('nothing is being decided right now'),
  )
}

/* ============ lists ============ */

/**
 * A dash in the Track column of a Democracy row is not missing data: that
 * pallet has no tracks at all, and neither does it record a proposer for a
 * referendum tabled out of its queue. Said once beneath the table, because a
 * column of dashes otherwise reads as an indexing gap.
 */
const democracyDashNote = (rows: ReferendumListRow[]): string | null =>
  rows.some(r => r.pallet === 'democracy')
    ? note('Democracy rows show no Track and often no Proposer: the retired pallet has no tracks by design, and a referendum tabled from its queue records no proposer. Those dashes are the answer, not a gap in the index.')
    : null

function referendaTable(rows: ReferendumListRow[], ctx: ToolContext): string {
  return table(
    ['Referendum', 'Title', 'Status', 'Track', 'Proposer', 'Submitted'],
    rows.map(r => [
      explorerLink(`${r.pallet} #${r.index}`, referendumUrl(ctx.explorerBaseUrl, r.pallet, r.index)),
      cell(r.title),
      `${r.status}${r.enactment && r.enactment !== 'ok' ? ` · enactment ${r.enactment}` : ''}`,
      r.track ? `${r.track.name} (#${r.track.id})` : DASH,
      r.proposer ? accountLabel(r.proposer) : DASH,
      `${formatTime(r.timestamp)} · ${relativeAge(r.timestamp)}`,
    ]),
    'no referendum matches',
  )
}

/* ============ one referendum ============ */

function renderVoters(voters: ReferendumVoter[], asset: AssetRef, ctx: ToolContext, limit: number): string {
  const rows = [...(voters ?? [])]
    .filter(v => !v.removed)
    .sort((a, b) => Number(scaleAmount(b.weighted, asset.decimals) ?? 0) - Number(scaleAmount(a.weighted, asset.decimals) ?? 0))
    .slice(0, limit)
    .map(v => [
      v.account ? explorerLink(accountLabel(v.account, { withAddress: true }), accountUrl(ctx.explorerBaseUrl, v.account.address)) : DASH,
      v.side,
      v.conviction ?? DASH,
      formatAmount(v.balance, asset.decimals, asset.symbol),
      formatAmount(v.weighted, asset.decimals, asset.symbol),
      formatUsd(v.valueUsd),
      relativeAge(v.timestamp),
    ])
  return table(['Voter', 'Side', 'Conviction', 'Balance', 'Weighted', 'USD at vote', 'When'], rows, 'nobody has voted')
}

function renderReferendum(d: ReferendumDetail, ctx: ToolContext, opts: { limit: number; nominalBlockSec: number | null }): string {
  const asset = d.asset ?? { assetId: 0, iconAssetId: 0, symbol: HDX_SYMBOL, name: null, decimals: HDX_DECIMALS, parachainId: null, origin: null }
  const call = d.proposalCall
  const track = d.trackInfo
  const p = d.progress as ReferendumProgress | undefined

  const timeline = (d.timeline ?? []).map(t => (
    `${formatTime(t.timestamp)} · block ${formatCount(t.blockHeight)} · **${t.event}**${t.outcome && t.outcome !== 'ok' ? ` (${t.outcome})` : ''}${t.scheduled ? ` · scheduled ${t.scheduled.state}` : ''}`
  ))

  // Prefer the pallet's own live storage tally while a referendum runs; fall
  // back to the indexed direct-vote sum, and say which is on screen either way.
  const tallyBlock = d.liveTally
    ? renderTally(d.liveTally, {
      decimals: asset.decimals, symbol: asset.symbol ?? HDX_SYMBOL,
      label: 'live chain storage (conviction-weighted, delegations included)',
      electorate: d.liveTally.electorate,
      voters: { ayes: d.directTally.ayeVoters, nays: d.directTally.nayVoters, split: d.directTally.splitVoters, total: d.directTally.voters },
    })
    : renderTally(d.directTally, {
      decimals: asset.decimals, symbol: asset.symbol ?? HDX_SYMBOL,
      label: 'indexed direct votes (delegated weight is not folded in)',
      voters: { ayes: d.directTally.ayeVoters, nays: d.directTally.nayVoters, split: d.directTally.splitVoters, total: d.directTally.voters },
    })

  return joinBlocks(
    h2(`${d.pallet} referendum #${d.index}${d.title ? ` — ${d.title}` : ''}`),
    kv([
      ['Status', d.status],
      ['Enactment', d.enactment],
      ['Track', track ? `${track.name} (#${track.id})` : d.track != null ? `#${d.track}` : 'none (Democracy has no tracks)'],
      ['Proposer', d.proposer ? explorerLink(accountLabel(d.proposer, { withAddress: true }), accountUrl(ctx.explorerBaseUrl, d.proposer.address)) : 'none recorded (a Democracy referendum is tabled from a queue)'],
      ['Submitted', d.submittedAt ? `${formatTime(d.submittedAt.timestamp)} · ${relativeAge(d.submittedAt.timestamp)} · block ${formatCount(d.submittedAt.blockHeight)}` : null],
      ['Concluded', d.concludedAt ? `${formatTime(d.concludedAt.timestamp)} · ${relativeAge(d.concludedAt.timestamp)} · block ${formatCount(d.concludedAt.blockHeight)}` : null],
      ['Proposal', call ? `${call.pallet}.${call.callName}${call.decodeError ? ` (decode failed: ${call.decodeError})` : ''} · ${formatCount(call.byteLength)} bytes` : d.proposalHash ? `hash only, ${shortHash(d.proposalHash)}` : null],
      ['Explorer', explorerLink(`${d.pallet} #${d.index}`, referendumUrl(ctx.explorerBaseUrl, d.pallet, d.index))],
      ['Subsquare', d.subsquareUrl],
    ]),
    h3('Tally'),
    tallyBlock,
    d.indirectTally
      ? note(`A delegated residual is tracked separately: ${formatAmount(d.indirectTally.ayes, asset.decimals, asset.symbol)} aye / ${formatAmount(d.indirectTally.nays, asset.decimals, asset.symbol)} nay.`)
      : null,
    d.onChainTally
      ? note(`The chain's own recorded tally at block ${formatCount(d.onChainTally.blockHeight)} (${d.onChainTally.final ? 'final' : 'not final'}): ${formatAmount(d.onChainTally.ayes, asset.decimals, asset.symbol)} aye, ${formatAmount(d.onChainTally.nays, asset.decimals, asset.symbol)} nay.`)
      : d.pallet === 'democracy' ? note('The Democracy pallet keeps no on-chain tally snapshot; the figures above are the indexed votes.') : null,
    p?.approval || p?.support
      ? joinBlocks(h3('Progress'), kv([
        ['Phase', p.phase],
        ['Approval', gaugeLine(p.approval, ' (conviction-weighted aye over aye plus nay)')],
        ['Support', gaugeLine(p.support, ' (aye plus abstain capital against the electorate, nay excluded)')],
        ['Decision window', p.decisionStartBlock && p.decisionEndBlock ? `blocks ${formatCount(p.decisionStartBlock)} → ${formatCount(p.decisionEndBlock)}` : null],
        ['Confirmation window', p.confirmStartBlock && p.confirmEndBlock ? `blocks ${formatCount(p.confirmStartBlock)} → ${formatCount(p.confirmEndBlock)}` : null],
        ['Projection', p.projection ? p.projection.state : null],
      ]))
      : null,
    track
      ? joinBlocks(h3('Track parameters'), kv([
        ['Prepare period', opts.nominalBlockSec ? `${formatCount(track.preparePeriod)} blocks (${blocksToDuration(track.preparePeriod, opts.nominalBlockSec)})` : `${formatCount(track.preparePeriod)} blocks`],
        ['Decision period', opts.nominalBlockSec ? `${formatCount(track.decisionPeriod)} blocks (${blocksToDuration(track.decisionPeriod, opts.nominalBlockSec)})` : `${formatCount(track.decisionPeriod)} blocks`],
        ['Confirm period', opts.nominalBlockSec ? `${formatCount(track.confirmPeriod)} blocks (${blocksToDuration(track.confirmPeriod, opts.nominalBlockSec)})` : `${formatCount(track.confirmPeriod)} blocks`],
        ['Min enactment', opts.nominalBlockSec ? `${formatCount(track.minEnactmentPeriod)} blocks (${blocksToDuration(track.minEnactmentPeriod, opts.nominalBlockSec)})` : `${formatCount(track.minEnactmentPeriod)} blocks`],
        ['Decision deposit', formatAmount(track.decisionDeposit, asset.decimals, asset.symbol)],
      ]), note('Track periods are defined in blocks at the runtime\'s nominal slot time, which is what the durations above use.'))
      : null,
    timeline.length ? joinBlocks(h3('Timeline'), bullets(timeline.slice(0, 20)), d.timelineTruncated ? note('the timeline is truncated upstream') : null) : null,
    joinBlocks(
      h3(`Top voters (${formatCount(Math.min(opts.limit, d.voters?.length ?? 0))} of ${formatCount(d.votesTotal)}, largest weighted stake first)`),
      renderVoters(d.voters ?? [], asset, ctx, opts.limit),
    ),
    call?.args ? joinBlocks(h3('Proposal arguments'), code(JSON.stringify(call.args, null, 2).slice(0, 2_000), 'json')) : null,
  )
}

/* ============ motions and tips ============ */

function motionsTable(rows: CollectiveMotionRow[], ctx: ToolContext): string {
  return table(
    ['#', 'Call', 'Status', 'Votes', 'Proposer', 'Proposed'],
    rows.map(m => [
      `${m.index}`,
      cell(m.call, 60),
      m.status,
      `${m.ayes}/${m.threshold} aye${m.nays ? `, ${m.nays} nay` : ''}`,
      m.proposer ? explorerLink(accountLabel(m.proposer), accountUrl(ctx.explorerBaseUrl, m.proposer.address)) : DASH,
      m.proposedAt ? `${formatTime(m.proposedAt.timestamp)} · ${relativeAge(m.proposedAt.timestamp)}` : DASH,
    ]),
    'no motions',
  )
}

function tipsTable(rows: TreasuryTipRow[], ctx: ToolContext): string {
  return table(
    ['Beneficiary', 'Payout', 'Status', 'Reason', 'Opened'],
    rows.map(t => [
      t.beneficiary ? explorerLink(accountLabel(t.beneficiary, { withAddress: true }), accountUrl(ctx.explorerBaseUrl, t.beneficiary.address)) : DASH,
      t.payout ? formatAmount(t.payout, HDX_DECIMALS, HDX_SYMBOL) : DASH,
      t.status,
      cell(t.reason),
      t.openedAt ? `${formatTime(t.openedAt.timestamp)} · ${relativeAge(t.openedAt.timestamp)}` : DASH,
    ]),
    'no tips',
  )
}

/* ============ pallet resolution ============ */

interface PalletResolution { pallet: Pallet; note: string | null; candidates?: { pallet: Pallet; index: number; title: string | null }[] }

/**
 * Both pallets index from zero, so an index alone names two referenda. Search
 * is the cheap way to find out which of them exists: one hit is unambiguous and
 * is taken with a line saying so, two hits are refused with both titles.
 */
async function resolvePallet(index: number, ctx: ToolContext): Promise<PalletResolution | null> {
  const hits = await ctx.upstream.get<SearchResult[]>('/explorer/search', { q: String(index) }, { ttlMs: 10_000 })
  const refs = (Array.isArray(hits) ? hits : [])
    .filter(h => h.type === 'referendum' && h.index === index && (h.pallet === 'opengov' || h.pallet === 'democracy'))
    .map(h => ({ pallet: h.pallet as Pallet, index, title: h.label ?? null }))
  if (refs.length === 1) {
    return { pallet: refs[0].pallet, note: `No \`pallet\` was given. Only the ${refs[0].pallet} pallet has a referendum #${index}, so that is the one read.` }
  }
  if (refs.length > 1) return { pallet: refs[0].pallet, note: null, candidates: refs }
  return null
}

/* ============ handler ============ */

async function handler(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(INPUT_SHAPE, input)
  if (!parsed.ok) return failure(parsed.error)
  const args = parsed.value
  const kind = args.kind ?? 'overview'
  const limit = args.limit ?? 25
  const errors: ToolError[] = []

  if (kind === 'overview') {
    try {
      const d = await ctx.upstream.get<GovernanceOverview>('/explorer/governance', undefined, { ttlMs: 10_000, timeoutMs: 60_000 })
      return output(ctx, fit(renderOverview(d, ctx), ctx), d)
    } catch (err) {
      return failure(toolErrorFromUpstream(err, 'The governance overview'))
    }
  }

  if (kind === 'referenda') {
    try {
      if (args.pallet) {
        const page = await ctx.upstream.get<ReferendaPage>('/explorer/governance/referenda', {
          pallet: args.pallet, status: args.status, limit: rowsPerTable(ctx, limit, 1),
        }, { ttlMs: 15_000 })
        const markdown = joinBlocks(
          h2(`${args.pallet} referenda${args.status ? ` · status ${args.status}` : ''}`),
          referendaTable(page.rows ?? [], ctx),
          note(`Showing ${(page.rows ?? []).length} of ${formatCount(page.total)}${args.status ? ` matching "${args.status}"` : ''}. The voter count is deliberately not computed in this list; open one referendum for its tally.`),
          democracyDashNote(page.rows ?? []),
        )
        return output(ctx, fit(markdown, ctx, 'Lower `limit` or set `status`.'), page)
      }
      // No pallet: the unified directory, newest first across both systems. It
      // takes no status filter upstream, so a status is applied here over a
      // wider page and the note says exactly what was searched.
      const scan = args.status ? 100 : limit
      const rows = await ctx.upstream.get<ReferendumListRow[]>('/explorer/referenda', { limit: scan }, { ttlMs: 60_000 })
      const filtered = args.status
        ? (rows ?? []).filter(r => r.status.toLowerCase() === args.status!.toLowerCase())
        : (rows ?? [])
      const shown = filtered.slice(0, rowsPerTable(ctx, limit, 1))
      const markdown = joinBlocks(
        h2('Referenda (both pallets, newest first)'),
        referendaTable(shown, ctx),
        note(args.status
          ? `Showing ${shown.length} referenda with status "${args.status}", found among the ${(rows ?? []).length} most recent across both pallets — the unified list takes no status filter upstream, so this searched a window rather than the whole history. Set \`pallet\` to filter a whole system with its own total. Both pallets index from zero, so an index is only unique together with its pallet.`
          : `The ${shown.length} most recent referenda across both pallets. Set \`pallet\` to page one system with its own total and a status filter. Both pallets index from zero, so an index is only unique together with its pallet.`),
        democracyDashNote(shown),
      )
      return output(ctx, fit(markdown, ctx, 'Lower `limit`.'), shown)
    } catch (err) {
      return failure(toolErrorFromUpstream(err, 'The referendum list'))
    }
  }

  if (kind === 'referendum') {
    if (args.index == null) {
      return failure(invalidArgument("kind 'referendum' needs an `index`. Pass `pallet` with it ('opengov' or 'democracy') — both pallets index from zero, so an index alone names two different referenda."))
    }
    let pallet = args.pallet as Pallet | undefined
    let resolution: PalletResolution | null = null
    if (!pallet) {
      try {
        resolution = await resolvePallet(args.index, ctx)
      } catch (err) {
        errors.push(toolErrorFromUpstream(err, 'The pallet lookup'))
      }
      if (resolution?.candidates?.length) {
        return failure(invalidArgument(
          `Referendum #${args.index} exists in BOTH pallets, which index from zero independently: `
          + resolution.candidates.map(c => `${c.pallet} #${c.index} "${c.title ?? 'untitled'}"`).join(' · ')
          + '. Call again with `pallet` set to the one you mean.',
        ), { candidates: resolution.candidates })
      }
      if (!resolution) {
        return failure(invalidArgument(`No referendum #${args.index} was found in either pallet. Pass \`pallet\` explicitly if you believe it exists, or use search on its title.`))
      }
      pallet = resolution.pallet
    }

    // The voter table is the only unbounded section of a referendum, so it takes
    // the row budget rather than `limit` straight.
    const voterRows = rowsPerTable(ctx, limit, 1)
    const [detailRes, statsRes] = await Promise.allSettled([
      // The upstream `limit` bounds the voter list only; the tally counts every
      // vote either way, so asking for exactly what is rendered costs nothing.
      ctx.upstream.get<ReferendumDetail>(`/explorer/referendum/${pallet}/${args.index}`, { limit: voterRows }, { ttlMs: 15_000, timeoutMs: 60_000 }),
      // Only for turning the track's block counts into durations; a failure here
      // costs the durations, not the referendum.
      ctx.upstream.get<{ nominalBlockSec: number }>('/explorer/stats', undefined, { ttlMs: 30_000 }),
    ])
    if (detailRes.status === 'rejected') {
      return failure([...errors, toolErrorFromUpstream(detailRes.reason, `Referendum ${pallet} #${args.index}`)])
    }
    const nominalBlockSec = statsRes.status === 'fulfilled' && statsRes.value?.nominalBlockSec > 0 ? statsRes.value.nominalBlockSec : null
    const detail = detailRes.value
    const markdown = joinBlocks(
      resolution?.note ? note(resolution.note) : null,
      renderReferendum(detail, ctx, { limit: voterRows, nominalBlockSec }),
    )
    return output(ctx, fit(markdown, ctx, 'Lower `limit` to shorten the voter table.'),
      { ...detail, voters: (detail.voters ?? []).slice(0, voterRows) }, errors)
  }

  if (kind === 'motions') {
    // `body` is required upstream and there are two of them, so both are read —
    // and the row budget is SPLIT between them here rather than being asked for
    // twice and then half-lost to the text cap downstream.
    const perBody = rowsPerTable(ctx, limit, 2)
    const [tcRes, councilRes] = await Promise.allSettled([
      ctx.upstream.get<MotionsPage>('/explorer/governance/motions', { body: 'tc', limit: perBody }, { ttlMs: 15_000 }),
      ctx.upstream.get<MotionsPage>('/explorer/governance/motions', { body: 'council', limit: perBody }, { ttlMs: 15_000 }),
    ])
    if (tcRes.status === 'rejected') errors.push(toolErrorFromUpstream(tcRes.reason, 'Technical Committee motions'))
    if (councilRes.status === 'rejected') errors.push(toolErrorFromUpstream(councilRes.reason, 'Council motions'))
    const tc = tcRes.status === 'fulfilled' ? tcRes.value : null
    const council = councilRes.status === 'fulfilled' ? councilRes.value : null
    const markdown = joinBlocks(
      h2('Collective motions'),
      tc ? joinBlocks(h3(`Technical Committee — newest ${formatCount((tc.rows ?? []).length)} of ${formatCount(tc.total)}`), motionsTable(tc.rows ?? [], ctx)) : null,
      council ? joinBlocks(h3(`Council — newest ${formatCount((council.rows ?? []).length)} of ${formatCount(council.total)}`), motionsTable(council.rows ?? [], ctx)) : null,
      perBody < limit
        ? note(`Two bodies share one answer, so \`limit\` ${formatCount(limit)} was cut to ${formatCount(perBody)} rows EACH — the whole of both tables would not fit this server's text budget, and the alternative is losing the Council table without being told.`)
        : null,
      note('"Votes" is aye count against the motion\'s threshold — a collective votes by member count, not by stake, so none of the conviction weighting that applies to referenda applies here.'),
    )
    return output(ctx, fit(markdown, ctx, 'Lower `limit`.'), { techCommittee: tc, council }, errors)
  }

  try {
    const tipRows = rowsPerTable(ctx, limit, 1)
    const tips = await ctx.upstream.get<TipsPage>('/explorer/governance/tips', { limit: tipRows }, { ttlMs: 15_000 })
    const markdown = joinBlocks(
      h2(`Treasury tips (${formatCount(tips.total)} total)`),
      tipsTable(tips.rows ?? [], ctx),
      note(`Showing ${(tips.rows ?? []).length} of ${formatCount(tips.total)}${tipRows < limit ? `; \`limit\` ${formatCount(limit)} was cut to ${formatCount(tipRows)} rows to stay inside this server's text budget` : ''}. Payouts are HDX.`),
    )
    return output(ctx, fit(markdown, ctx, 'Lower `limit`.'), tips)
  } catch (err) {
    return failure(toolErrorFromUpstream(err, 'Treasury tips'))
  }
}

const INPUT_SHAPE = {
    kind: z.enum(KINDS).optional().describe("What to read: 'overview' (default, the active referenda and system counts), 'referenda' (the directory), 'referendum' (one, in full), 'motions' (Technical Committee and Council), 'tips' (treasury tips)."),
    pallet: z.enum(PALLETS).optional().describe("Which governance system: 'opengov' (live, track-based) or 'democracy' (retired). REQUIRED for kind 'referendum' unless you accept a search-based resolution — both pallets index from zero, so #100 exists twice."),
    index: z.coerce.number().int().min(0).optional().describe("The referendum index, for kind 'referendum'. Meaningless without a pallet unless exactly one pallet has it."),
    status: z.string().trim().min(1).max(24).optional().describe("Referendum list filter, for example 'confirming', 'deciding', 'executed', 'not passed', 'rejected'. An unknown status simply matches nothing."),
    limit: z.coerce.number().int().min(1).max(100).optional().describe('Rows per table — list entries, motions, tips, or voters on one referendum. Default 25.'),
    format: formatParam,
}

export const governanceTools: ToolDefinition[] = [{
  name: 'get_governance',
  title: 'Referenda, motions and tips',
  description: DESCRIPTION,
  inputSchema: INPUT_SHAPE,
  handler,
}]
