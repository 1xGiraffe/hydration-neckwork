import { useQueries } from '@tanstack/react-query'
import { govApi } from '../../api/explorer'
import { snapshotRetry, useNeedsVote } from '../../hooks/useGovernance'
import { useMyGovernanceAccounts } from '../../governanceAccounts'
import { useRecentVotes, type RecentVote } from '../../vote/voteBus'
import type { NeedsVote } from '../../governanceTypes'
import { convictionShort } from './GovUi'

/** "Aye 6×" / "Abstain" — a standing vote's side, as the reader's state on a live card. */
function sideText(side: string, conviction: number | null): string {
  if (side === 'SplitAbstain') return 'Abstain'
  return side === 'Aye' || side === 'Nay' ? `${side} ${convictionShort(null, conviction)}` : side
}

/**
 * Which live referenda still need a vote from which of `accounts` (needs-vote's
 * answer), counting a vote signed in this tab at once, before the indexer has seen
 * it. One reckoning for the "Needs your vote" list and the count beside "My
 * governance" in the menu, so the two never disagree.
 */
export function stillToVote(accounts: NeedsVote['accounts'], recent: readonly RecentVote[]): { missing: Map<number, number>; justVoted: { index: number; text: string }[] } {
  const missing = new Map<number, number>()
  const justVoted: { index: number; text: string }[] = []
  for (const a of accounts) {
    if (!a.accountId) continue
    for (const i of a.needsVote) {
      const just = recent.find(r => r.index === i && r.actorId.toLowerCase() === a.accountId?.toLowerCase())
      if (just) justVoted.push({ index: i, text: just.direction === 'split' ? 'Split' : sideText(just.direction === 'aye' ? 'Aye' : just.direction === 'nay' ? 'Nay' : 'SplitAbstain', just.conviction) })
      else missing.set(i, (missing.get(i) ?? 0) + 1)
    }
  }
  return { missing, justVoted }
}

/** The menu's count: the live referenda at least one of the reader's accounts has still to vote on — the length of /governance/me's "Needs your vote" list. */
export function useStillToVoteCount(): number | null {
  const mine = useMyGovernanceAccounts()
  const q = useNeedsVote(mine.map(m => m.address).slice(0, 20))
  const recent = useRecentVotes()
  if (!q.data) return null
  const { missing } = stillToVote(q.data.accounts, recent)
  return q.data.referenda.filter(r => missing.has(r.index)).length
}

/**
 * The reader's accounts (signed in, connected, followed; or the `only` subset) against
 * the live referenda: which still need a vote from how many of them, and how the
 * others voted. Votes signed in this tab count at once, before the indexer has seen them.
 */
export function useReaderVotes(only?: string[] | null) {
  const all = useMyGovernanceAccounts()
  const mine = only ? all.filter(m => only.includes(m.address)) : all
  const q = useNeedsVote(mine.map(m => m.address).slice(0, 20))
  // The quick Aye/Nay/Abstain cart choices are for people who already vote here: an
  // account that never voted starts in the composer, where amount and lock are explained.
  const histories = useQueries({
    queries: mine.slice(0, 10).map(m => ({ queryKey: ['gov-account', m.address], queryFn: ({ signal }: { signal: AbortSignal }) => govApi.accountGovernance(m.address, signal), staleTime: 30_000, ...snapshotRetry })),
  })
  const hasVoted = histories.some(h => (h.data?.history.referendaVoted ?? 0) > 0)
  const recent = useRecentVotes()
  const known = (q.data?.accounts ?? []).filter(a => a.accountId)
  const voted = new Map<number, Set<string>>()
  const add = (i: number, text: string) => voted.set(i, (voted.get(i) ?? new Set<string>()).add(text))
  for (const a of known) for (const v of a.voted) add(v.index, sideText(v.side, v.conviction))
  const { missing, justVoted } = stillToVote(known, recent)
  for (const j of justVoted) add(j.index, j.text)
  const rows = (q.data?.referenda ?? []).filter(r => missing.has(r.index))
  // Followed addresses are watched, not owned: they are never called "yours".
  const watchOnly = mine.length > 0 && mine.every(m => m.source === 'watched')
  return { mine, q, known, missing, voted, rows, hasVoted, watchOnly }
}

