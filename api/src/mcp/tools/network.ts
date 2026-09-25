import { formatParam, type ToolContext, type ToolDefinition, type ToolError, type ToolOutput } from '../toolTypes.ts'
import { toolErrorFromUpstream } from '../errors.ts'
import type { BlockSummary, ExplorerCounts, ExplorerStats } from '../types.ts'
import { DASH, formatCount, formatUsd } from '../format/units.ts'
import { chainTimeSeconds, formatDuration, formatTime, relativeAge } from '../format/time.ts'
import { accountLabel, blockUrl, explorerLink, shortHash } from '../format/refs.ts'
import { h2, joinBlocks, kv, note, table } from '../format/md.ts'
import { fit, output } from './shared.ts'

const DESCRIPTION = `Is the Hydration chain live, and how far behind it is the index that every other tool reads? The cheapest call on this server and the one to make FIRST when a result looks stale or a just-submitted transaction is missing.

Returns, in one read: the chain head and the indexed (finalized) head with the gap between them in blocks and seconds; the head block's timestamp and its age; the measured block pace beside the runtime's nominal slot time; 24-hour throughput (extrinsics, transfers, active accounts); the HDX price; the total indexed counts of blocks, extrinsics, events, transfers and contracts; and the last five blocks with their extrinsic and event counts.

The distinction that matters: 'head' includes an in-memory PENDING layer that may still reorganise, while the indexed head is the finalized block ClickHouse has stored. Indexing follows the finalized head, so the index normally trails the chain head by roughly 35-65 seconds. An extrinsic submitted moments ago is therefore NOT a bug when it is missing from get_activity or inspect_entity — this tool prints the lag in seconds so an agent can decide whether to retry instead of concluding the extrinsic failed. Blocks above the indexed head are flagged unconfirmed and carry NO AUTHOR — the collator is resolved only at finalization — so their Author cell is a dash; the block hash beside it is a digest, never an account.

Block counts are turned into wall-clock durations with the runtime's NOMINAL slot time, never the measured average: every protocol constant stated in blocks (a governance track's decision period, a DCA period, an unlock delay) is defined at the nominal rate, while the measured pace drifts with elastic block production. Both numbers are printed so the difference is visible.

Takes no arguments beyond 'format'. Prefer this over get_protocol_stats when the question is liveness or freshness rather than economics, and over inspect_entity when no specific entity is in hand.`

async function handler(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  // Three independent reads: a slow or failing one must not cost the others.
  const [statsRes, countsRes, blocksRes] = await Promise.allSettled([
    ctx.upstream.get<ExplorerStats>('/explorer/stats', undefined, { ttlMs: 2_000 }),
    ctx.upstream.get<ExplorerCounts>('/explorer/counts', undefined, { ttlMs: 30_000 }),
    ctx.upstream.get<BlockSummary[]>('/explorer/blocks', { limit: 5 }, { ttlMs: 2_000 }),
  ])

  const errors: ToolError[] = []
  const stats = statsRes.status === 'fulfilled' ? statsRes.value : null
  if (statsRes.status === 'rejected') errors.push(toolErrorFromUpstream(statsRes.reason, 'The chain head'))
  const counts = countsRes.status === 'fulfilled' ? countsRes.value : null
  if (countsRes.status === 'rejected') errors.push(toolErrorFromUpstream(countsRes.reason, 'The indexed totals'))
  const blocks = blocksRes.status === 'fulfilled' ? blocksRes.value : null
  if (blocksRes.status === 'rejected') errors.push(toolErrorFromUpstream(blocksRes.reason, 'The latest blocks'))

  const now = Date.now()
  const blocks$ = Array.isArray(blocks) ? blocks : []

  let headBlock: string | null = null
  let lag: string | null = null
  let pace: string | null = null
  let throughput: string | null = null

  if (stats) {
    const gap = stats.headBlock - stats.finalizedBlock
    const nominal = stats.nominalBlockSec > 0 ? stats.nominalBlockSec : null
    headBlock = kv([
      ['Chain head', `${formatCount(stats.headBlock)} (includes the unfinalized pending layer)`],
      ['Indexed head', `${formatCount(stats.finalizedBlock)} (finalized, stored in the index)`],
      ['Head time', `${formatTime(stats.headTime)} · ${relativeAge(stats.headTime, now)}`],
      ['HDX price', stats.hdxPrice == null ? DASH : formatUsd(stats.hdxPrice)],
    ])
    // The lag an agent acts on. Stated in seconds as well as blocks, because
    // "is my extrinsic visible yet?" is a wall-clock question.
    const gapSeconds = nominal ? gap * nominal : null
    const headAgeSec = (() => {
      const t = chainTimeSeconds(stats.headTime)
      return t == null ? null : Math.max(0, Math.round(now / 1000 - t))
    })()
    lag = [
      `The index trails the chain head by **${formatCount(gap)} block${gap === 1 ? '' : 's'}**` +
        (gapSeconds != null ? ` (~${formatDuration(gapSeconds)} at the nominal slot time)` : '') + '.',
      headAgeSec != null ? `The head block itself is ${formatDuration(headAgeSec)} old.` : null,
      'Indexing follows the FINALIZED head, so a just-submitted extrinsic normally becomes visible after that lag plus finalization (roughly 35-65 seconds in total). A lookup that misses inside that window is an early read, not a failure — retry rather than concluding the extrinsic never happened.',
    ].filter(Boolean).join(' ')
    pace = kv([
      ['Measured block time', `${stats.avgBlockSec.toFixed(2)}s (moves with elastic block production)`],
      ['Nominal block time', nominal ? `${nominal}s (the runtime slot time)` : DASH],
    ])
    // Each figure says what it counts: none of the three is the activity feed's
    // classified count, and "transfers" here are raw events, plumbing included.
    throughput = kv([
      ['Extrinsics (24 h)', `${formatCount(stats.extrinsics24h)} signed extrinsics`],
      ['Transfers (24 h)', `${formatCount(stats.transfers24h)} raw Balances/Tokens transfer events — the internal legs of swaps, pool deposits and fees included, so far more than the Transfer rows get_activity classifies`],
      ['Active accounts (24 h)', `${formatCount(stats.activeAccounts24h)} distinct accounts that signed an extrinsic (the Accounts page's daily-active definition); receiving a transfer does not count`],
    ])
  }

  const countsBlock = counts
    ? kv([
      ['Blocks', formatCount(counts.blocks)],
      ['Extrinsics', formatCount(counts.extrinsics)],
      ['Events', formatCount(counts.events)],
      ['Transfers', `${formatCount(counts.transfers)} raw transfer events (the 24 h figure's definition)`],
      ['Contracts', formatCount(counts.contracts)],
      ['Max list offset', `${formatCount(counts.maxOffset)} (paged lists refuse a deeper offset)`],
    ])
    : null

  // The author column and the hash column are kept apart. `author` is null on
  // every unfinalized block — which is all of them on the head page — and a
  // hash printed in an Author cell is a 32-byte digest a model can quote as if
  // it were the collator who produced the block.
  const blockRows = blocks$.map(b => [
    explorerLink(formatCount(b.height), blockUrl(ctx.explorerBaseUrl, b.height)),
    `${formatTime(b.timestamp)} · ${relativeAge(b.timestamp, now)}`,
    b.finalized === false ? 'unconfirmed' : 'finalized',
    formatCount(b.extrinsicCount),
    formatCount(b.eventCount),
    b.author ? accountLabel(b.author) : DASH,
    shortHash(b.hash),
  ])
  const missingAuthors = blocks$.filter(b => !b.author).length

  const markdown = joinBlocks(
    h2('Chain head'),
    headBlock,
    lag,
    pace ? joinBlocks(h2('Block pace'), pace, note('Every block-count constant on this chain — a governance track period, a DCA period, an unlock delay — is defined at the NOMINAL slot time. Convert block counts with that, not with the measured average.')) : null,
    throughput ? joinBlocks(h2('Throughput'), throughput) : null,
    countsBlock ? joinBlocks(h2('Indexed totals'), countsBlock) : null,
    joinBlocks(
      h2('Latest blocks'),
      table(['Height', 'Time', 'State', 'Extrinsics', 'Events', 'Author', 'Block hash'], blockRows, 'the block list could not be read'),
      missingAuthors > 0
        ? note(`${missingAuthors} of these blocks ${missingAuthors === 1 ? 'has' : 'have'} no Author: the collator is resolved only once a block is finalized, so an unconfirmed block shows a dash. The Block hash column is the block's own digest and is never an account.`)
        : null,
    ),
  )

  return output(ctx, fit(markdown, ctx), { stats, counts, blocks: blocks$ }, errors)
}

export const networkTools: ToolDefinition[] = [{
  name: 'get_network_status',
  title: 'Chain head and index freshness',
  description: DESCRIPTION,
  inputSchema: { format: formatParam },
  handler,
}]
