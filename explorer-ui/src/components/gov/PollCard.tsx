import { useId, useState } from 'react'
import { Link, paths } from '../../router'
import { AccountEmoji, F } from '../ui'
import { humanDate } from './GovUi'
import { useNow } from '../../hooks/useNow'
import { readPoll } from './poll'

// A discussion's poll, read-only: its question, each option's share of the votes,
// when it closed (or closes), and — for a poll whose votes were public — who chose
// what (poll.ts reads the stored shape). No new polls are opened here.

const VOTERS_SHOWN = 12

function Voter({ id }: { id: string }) {
  if (id.startsWith('legacy:')) return <span className="gov-poll-voter legacy">{id.slice(7)}</span>
  const short = id.length > 16 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
  return (
    <Link to={paths.account(id)} className="gov-poll-voter">
      <AccountEmoji account={{ accountId: id }} className="emoji id" />{short}
    </Link>
  )
}

function Voters({ list }: { list: string[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? list : list.slice(0, VOTERS_SHOWN)
  return (
    <details className="gov-poll-voters">
      <summary>{list.length === 1 ? '1 voter' : `${F.int(list.length)} voters`}</summary>
      <div className="gov-poll-voter-list">
        {shown.map(v => <Voter key={v} id={v} />)}
        {!all && list.length > VOTERS_SHOWN && <button type="button" className="link-btn" onClick={() => setAll(true)}>Show all {F.int(list.length)}</button>}
      </div>
    </details>
  )
}

export function PollCard({ poll: raw }: { poll: unknown }) {
  const titleId = useId()
  const now = useNow(60_000)
  const poll = readPoll(raw)
  if (!poll) return null
  const total = poll.votes ? poll.options.reduce((s, o) => s + (poll.votes?.[o] ?? 0), 0) : null
  const top = poll.votes && total ? Math.max(...poll.options.map(o => poll.votes?.[o] ?? 0)) : 0
  const closed = poll.expiresTime != null && poll.expiresTime <= now
  return (
    <section className="gov-poll" aria-labelledby={titleId}>
      <div className="gov-poll-head">
        <h3 id={titleId} className="gov-poll-title">{poll.title || 'Poll'}</h3>
        <p className="gov-poll-meta">
          {poll.expiresTime != null ? (closed ? `Closed on ${humanDate(poll.expiresTime, false)}` : `Open until ${humanDate(poll.expiresTime, false)}`) : 'Poll'}
          {' · '}{poll.anonymous ? 'anonymous votes' : 'public votes'}
          {total != null && <> · {F.int(total)} {total === 1 ? 'vote' : 'votes'}</>}
        </p>
      </div>
      <ul className="gov-poll-options">
        {poll.options.map(o => {
          const n = poll.votes?.[o] ?? 0
          const share = total ? n / total : 0
          const voters = poll.voters?.[o] ?? []
          return (
            <li key={o} className={`gov-poll-option${total && n === top ? ' lead' : ''}`}>
              <div className="gov-poll-row">
                <span className="gov-poll-label">{o}</span>
                {total != null && <span className="gov-poll-count">{F.int(n)}{total > 0 && <span className="muted"> · {Math.round(share * 100)}%</span>}</span>}
              </div>
              {total != null && <div className="gov-poll-bar" aria-hidden="true"><span style={{ width: `${(share * 100).toFixed(1)}%` }} /></div>}
              {voters.length > 0 && <Voters list={voters} />}
            </li>
          )
        })}
      </ul>
      {total == null && <p className="gov-poll-note">{closed ? 'The results of this poll are not available.' : 'Results show once the poll closes.'}</p>}
    </section>
  )
}
