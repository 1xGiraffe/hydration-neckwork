import { useId, useState } from 'react'
import { AccountEmoji, Amt, F, ShortAddr } from '../components/ui'
import type { AccountRef } from '../types'
import { CONVICTIONS, totalBalance } from './voteMath'
import type { VoteSpec } from './voteMath'
import { openWallets } from './voteBus'
import { describeVote } from './voteLogic'
import { useActorState } from './useVoting'
import type { Voter } from './useVoting'

// "Vote as": the account a vote is for, with the wallet account that signs it. A
// proxied account says so ("via … · Governance proxy"); a delayed proxy is listed
// with why it cannot vote. Each row shows the HDX the account can vote with and, on
// a referendum, its vote there. The menu ends with the way to manage wallets.

/** "Aye 6× · 109M HDX": a standing vote short enough for one line (the exact figures are in its title). */
function shortVote(v: VoteSpec): string {
  if (v.kind === 'Standard') return `${v.aye ? 'Aye' : 'Nay'} ${CONVICTIONS[v.conviction].label} · ${F.amount(v.balance.toString(), 12)} HDX`
  if (v.kind === 'SplitAbstain' && v.aye === 0n && v.nay === 0n) return `Abstain · ${F.amount(v.abstain.toString(), 12)} HDX`
  return 'a split vote'
}

function nameOf(ref: AccountRef | null, fallback: string | null): string | null {
  return ref?.profile?.name || ref?.identity?.display || fallback
}

export function VoterLine({ voter, compact, poll }: { voter: Voter; compact?: boolean; poll?: number | null }) {
  const state = useActorState(voter.disabled ? null : voter.actorId)
  const name = nameOf(voter.ref, voter.proxy ? null : voter.signer.name)
  const standing = poll != null && state.data ? state.data.voting.flatMap(c => c.votes).find(v => v.poll === poll) : null
  return (
    <span className="voter-line">
      {voter.ref ? <AccountEmoji account={voter.ref} className="emoji id voter-emoji" /> : <span className="emoji id voter-emoji" aria-hidden="true">👤</span>}
      <span className="voter-text">
        <span className="voter-name">{name ? <>{name} <span className="voter-addr mono"><ShortAddr addr={voter.actorAddress} /></span></> : <span className="mono"><ShortAddr addr={voter.actorAddress} /></span>}</span>
        {!compact && (
          <span className="voter-sub">
            {voter.proxy
              ? voter.via
                ? <>via {voter.signer.name || <ShortAddr addr={voter.signer.address} />} → {voter.via.ref.profile?.name || voter.via.ref.identity?.display || <ShortAddr addr={voter.via.ref.address} />} · Any, then {voter.proxy.proxyType} proxy</>
                : <>via {voter.signer.name || <ShortAddr addr={voter.signer.address} />} · {voter.proxy.proxyType} proxy</>
              : voter.signer.kind === 'evm' ? <>{voter.signer.walletName} · <span className="mono"><ShortAddr addr={voter.signer.address} /></span></> : voter.signer.walletName}
            {poll != null && state.data && <> · {standing ? <span className="voter-voted" title={describeVote(standing.vote)}>voted {shortVote(standing.vote)}</span> : 'not voted yet'}</>}
          </span>
        )}
      </span>
      <span className="voter-bal">
        {voter.disabled ? <span className="muted">can’t vote</span>
          : state.data ? <><Amt raw={totalBalance(state.data.hdx).toString()} dec={12} /> <span className="muted">HDX</span></>
          : state.isError ? <span className="muted">—</span> : <span className="skeleton voter-bal-sk" />}
      </span>
    </span>
  )
}

export function VoterPicker({ voters, value, onChange, poll, label = 'Vote as' }: { voters: Voter[]; value: Voter | null; onChange: (v: Voter) => void; poll?: number | null; label?: string }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  if (!value) return null
  const direct = voters.filter(v => !v.proxy)
  // Proxies that can vote, then — last, and only said — the ones that cannot.
  const proxied = voters.filter(v => v.proxy && !v.disabled)
  const blocked = voters.filter(v => v.proxy && v.disabled)
  return (
    <div className="voter-picker">
      <button type="button" className="voter-current" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(o => !o)}>
        <VoterLine voter={value} poll={poll} />
        <span className="voter-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div id={listId} className="voter-menu">
          <div className="voter-list" role="listbox" aria-label={label}>
            {direct.length > 0 && <div className="voter-group">Your accounts</div>}
            {direct.map(v => (
              <button key={v.key} type="button" role="option" aria-selected={v.key === value.key} className={`voter-option${v.key === value.key ? ' on' : ''}`} onClick={() => { onChange(v); setOpen(false) }}>
                <VoterLine voter={v} poll={poll} />
              </button>
            ))}
            {proxied.length > 0 && <div className="voter-group">Accounts you can vote for</div>}
            {proxied.map(v => (
              <button key={v.key} type="button" role="option" aria-selected={v.key === value.key} className={`voter-option${v.key === value.key ? ' on' : ''}`} onClick={() => { onChange(v); setOpen(false) }}>
                <VoterLine voter={v} poll={poll} />
              </button>
            ))}
            {blocked.length > 0 && <div className="voter-group">Proxy for, but cannot vote here</div>}
            {blocked.map(v => (
              <button key={v.key} type="button" role="option" aria-selected={false} aria-disabled title={v.disabled ?? undefined} className="voter-option off" onClick={() => undefined}>
                <VoterLine voter={v} poll={poll} />
                <span className="voter-why">{v.disabled}</span>
              </button>
            ))}
          </div>
          <button type="button" className="link-btn voter-manage" onClick={() => { setOpen(false); openWallets() }}>Manage wallets…</button>
        </div>
      )}
    </div>
  )
}
