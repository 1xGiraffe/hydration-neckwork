import type { ReactNode } from 'react'
import { F } from '../ui'
import { spendableNowOf } from './GovUi'
import type { AccountGovernance as AccountGovernanceData, GovernanceVoteRow } from '../../governanceTypes'

// Figures an account's governance read adds up to, shared by the account tab and
// /governance/me (which totals them across the accounts in view).

const sum = (values: string[]) => values.reduce((a, v) => a + BigInt(v || '0'), 0n).toString()

export /** "#450 and #448" — the running referenda an open-ended lock waits on. */
function runningPolls(votes: GovernanceVoteRow[], account: string): string {
  const polls = [...new Set(votes.filter(v => v.account === account && !v.finished).map(v => v.poll))].sort((a, b) => b - a)
  if (!polls.length) return 'its referenda'
  const list = polls.slice(0, 3).map(p => `#${p}`)
  if (polls.length > 3) return `${list.join(', ')} and ${polls.length - 3} more`
  return list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/** The data note every vote-state figure rests on (the Terms fold's last entry). */
export function voteStateNote(data: Pick<AccountGovernanceData, 'asOfBlock' | 'history'>): { dt: string; dd: ReactNode } {
  return { dt: 'Data', dd: <>Vote state as of block {data.asOfBlock != null ? F.int(data.asOfBlock) : '—'}; votes cast through a proxy, multisig or batch are included from block {F.int(data.history.observedFrom)} on.</> }
}

/** Locked, unlockable and next-unlock across one or more accounts' governance reads. */
export function lockTotals(list: AccountGovernanceData[]) {
  const seen = new Set<string>()
  const locks = list.flatMap(d => d.locks).filter(l => { if (seen.has(l.account)) return false; seen.add(l.account); return true })
  const locked = sum(locks.map(l => l.locked))
  const unlockable = locks.reduce((a, l) => a + spendableNowOf(l), 0n)
  const next = locks.flatMap(l => (l.nextUnlock ? [l.nextUnlock] : [])).sort((a, b) => a.at.block - b.at.block)[0] ?? null
  const waiting = list.flatMap(d => d.locks.filter(l => BigInt(l.openEnded) > 0n).map(l => runningPolls(d.votes, l.account)))[0] ?? null
  return { locked, unlockable, next, waiting }
}

