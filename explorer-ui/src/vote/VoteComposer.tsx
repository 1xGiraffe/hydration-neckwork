import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useReferendum } from '../hooks/useExplorerData'
import { useAccountGovernance, useGovClock } from '../hooks/useGovernance'
import { projectBlock } from '../governanceClock'
import { humanDate, trackLabel } from '../components/gov/GovUi'
import { Amt, F } from '../components/ui'
import { chainConstants, estimateFeeHdx, readReferendum } from './chainWrite'
import type { WritePlan } from './chainWrite'
import { capitalOf, describeVote, directionOf, isSplit, standingVote, useLastVote, usePickedVoter } from './voteLogic'
import {
  CONVICTIONS, ONE_HDX, amountPresets, formatHdx, formatHdxInput, lockBlocks, parseHdx, roundUpTenth, spendableWith,
  suggestedReserve, tallyAfter, tallyDelta, tallyShares, totalBalance, voteSpec, weighted,
} from './voteMath'
import type { Conviction, VoteSpec } from './voteMath'
import { getCart, openVote, openWallets, rememberVote, forgetVote, setVotePrefs, toggleCart, useCart, useVotePrefs } from './voteBus'
import type { ComposerTarget, Direction } from './voteBus'
import { useActorState, useRefreshAfterWrite, useVoters } from './useVoting'
import { VoterPicker } from './VoterPicker'
import { Fact, ReviewPanel } from './ReviewPanel'
import { NoWallet } from './WalletDialog'
import { RadioGroup } from '../components/RadioGroup'
import { GovDetails, InfoTip } from '../components/gov/Disclosure'

// The vote composer: for whom, which way, how much, how long to lock, then a dry-run
// and Sign. What decides the vote stays on screen — the account (its address when
// proxied), the side, the amount (and where a pre-fill came from), the conviction
// with the lock it sets, the fee, and anything that would make it fail or that is
// risky; the explanations behind them sit in one closed "Details" at the end, and
// the rarer choices (keep HDX back for fees, remove the vote) one step away.
// Votes from one sitting can also go to the cart and be signed together.

const DIRECTIONS: { id: Direction; label: string }[] = [
  { id: 'aye', label: 'Aye' },
  { id: 'nay', label: 'Nay' },
  { id: 'abstain', label: 'Abstain' },
]

const HELD_BY: Record<string, string> = { pyconvot: 'backs other votes', stk_stks: 'is staked', ghdxlock: 'is staked as GIGAHDX', ormlvest: 'is vesting' }
const lockWord = (id: string) => ({ pyconvot: 'your other votes', stk_stks: 'staking', ghdxlock: 'GIGAHDX', ormlvest: 'vesting' } as Record<string, string>)[id] ?? `the “${id}” lock`

const weightedOf = (v: VoteSpec): bigint => { const d = tallyDelta(v); return d.ayes + d.nays }

const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(v < 0.1 ? 2 : 1)}%`)
// Lock lengths at the governance clock's measured pace ("~7.6 days").
const dayText = (days: number) => (days >= 1 ? `~${days < 10 ? Math.round(days * 10) / 10 : Math.round(days)} days` : `~${Math.round(days * 24)} hours`)
const stopText = (days: number) => `${days < 10 ? Math.round(days * 10) / 10 : Math.round(days)}d`

/** "13 Jul 2027": a projected date, so no weekday (the tooltip has it). */
const shortDate = (ms: number) => humanDate(ms, false).replace(/^\S+ /, '')

export function ConvictionRuler({ value, onChange, amount, lockPeriod, msPerBlock, endBlock, endMs, disabled, side, tag }: {
  value: Conviction; onChange: (c: Conviction) => void; amount: bigint; lockPeriod: number; msPerBlock: number
  endBlock: number | null; endMs: (block: number) => number | null; disabled?: boolean
  /** The side whose win sets the lock ("Aye"), when there is one. */
  side?: string | null
  /** A short tag beside the label (the rewards this vote earns). */
  tag?: ReactNode
}) {
  const id = useId()
  const days = (c: Conviction) => lockBlocks(c, lockPeriod) * msPerBlock / 86_400_000
  const lockDays = days(value)
  const unlockAt = endBlock != null ? endMs(endBlock + lockBlocks(value, lockPeriod)) : null
  return (
    <div className={`conv${disabled ? ' off' : ''}`}>
      <div className="conv-head">
        <span className="conv-label">
          <label htmlFor={id} className="vote-label">Conviction</label>
          <InfoTip label="About conviction">A multiplier on your vote, paid for with a longer lock after the referendum ends: each step doubles the lock. 0.1× counts a tenth of your HDX and locks nothing afterwards; 1× is a common start.</InfoTip>
          {tag}
        </span>
        <span className="conv-figure" aria-live="polite"><span className="conv-weight">{amount > 0n ? F.amount(weighted(amount, value).toString(), 12) : '0'}</span> votes counted</span>
      </div>
      <input id={id} type="range" min={0} max={6} step={1} value={value} disabled={disabled} className="conv-range"
        aria-valuetext={`${CONVICTIONS[value].label}, ${value === 0 ? 'no lock after the referendum' : `locked ${dayText(lockDays)} after it ends`}`}
        onChange={e => onChange(Number(e.target.value) as Conviction)} />
      <ol className="conv-stops" aria-hidden="true">
        {CONVICTIONS.map(c => (
          <li key={c.conviction} className={c.conviction === value ? 'on' : c.conviction < value ? 'past' : ''}>
            <button type="button" tabIndex={-1} disabled={disabled} onClick={() => onChange(c.conviction as Conviction)}>
              <span className="conv-x">{c.label}</span>
              <span className="conv-d">{c.conviction === 0 ? 'no lock' : stopText(days(c.conviction as Conviction))}</span>
            </button>
          </li>
        ))}
      </ol>
      <p className="conv-say">
        {value === 0
          ? <>No lock after the referendum; locked only while it runs.</>
          : <>Locked <strong>{dayText(lockDays)}</strong> if {side ?? 'your side'} wins{unlockAt ? <> (to <span title={`If it ends at its decision deadline: ${humanDate(unlockAt, false)}`}>~{shortDate(unlockAt)}</span>)</> : null}</>}
      </p>
    </div>
  )
}

type AmountMode = 'custom' | 'full' | 'almost' | 'current' | 'last'

export function VoteComposer({ target }: { target: ComposerTarget }) {
  const index = target.index
  const { voters, loading, accounts } = useVoters()
  const [voter, setVoter, picked] = usePickedVoter(voters, index, false, target.intent ?? null)
  const actorQ = useActorState(voter?.actorId ?? null)
  const actor = actorQ.data
  const detail = useReferendum('opengov', index)
  const clock = useGovClock()
  const live = useQuery({ queryKey: ['vote-referendum', index], queryFn: () => readReferendum(index), staleTime: 12_000, refetchInterval: 30_000 })
  const consts = useQuery({ queryKey: ['vote-consts'], queryFn: chainConstants, staleTime: Infinity })
  const prefs = useVotePrefs()
  const cart = useCart()
  const refresh = useRefreshAfterWrite()

  const current = standingVote(actor, index)
  const last = useLastVote(voter?.actorId ?? null, voter?.actorAddress ?? null, actor, index)
  const [direction, setDirection] = useState<Direction | 'split' | null>(target.direction ?? null)
  const [amountMode, setAmountMode] = useState<AmountMode>('custom')
  const [customText, setCustomText] = useState('')
  const [conviction, setConviction] = useState<Conviction>(1)
  const [reserveText, setReserveText] = useState<string | null>(null)
  const [mode, setMode] = useState<'vote' | 'remove'>('vote')
  const [seeded, setSeeded] = useState<string | null>(null)
  // Which choices came from a pre-fill (the standing or last vote) rather than the reader.
  const [prefilled, setPrefilled] = useState<{ amount: string | null; conviction: string | null }>({ amount: null, conviction: null })
  const [added, setAdded] = useState(false)

  // Start from the standing vote when there is one (a re-vote, a split kept as a
  // split), else from the account's last vote.
  // Seeded once per account, after its indexed history has answered (or failed), so a
  // late answer never overwrites what the reader has started choosing.
  const history = useAccountGovernance(voter?.actorAddress ?? null)
  const historySettled = !voter || history.isSuccess || history.isError || history.failureCount > 0
  const seedKey = voter && actor && historySettled ? `${voter.key}:${current ? 'cur' : 'nocur'}` : null
  // A choice the reader already made is never overwritten by a pre-fill that arrives later.
  const [touchedFor, setTouchedFor] = useState<string | null>(null)
  const touched = !!voter && touchedFor === voter.key
  const touch = () => { if (voter && touchedFor !== voter.key) setTouchedFor(voter.key) }
  if (seedKey && seedKey !== seeded && touched) {
    // Only what is still empty: a re-vote keeps the standing side unless one was chosen.
    setSeeded(seedKey)
    if (current && !direction && !target.direction) setDirection(directionOf(current.vote))
  }
  else if (seedKey && seedKey !== seeded) {
    setSeeded(seedKey)
    const base = current?.vote ?? last?.vote ?? null
    const from = current ? 'your current vote' : last ? `your vote on #${last.poll}` : null
    if (base && from) {
      if (!target.direction && current) setDirection(directionOf(base))
      setAmountMode(current ? 'current' : 'last')
      if (base.kind === 'Standard') setConviction(base.conviction)
      setPrefilled({ amount: from, conviction: base.kind === 'Standard' ? from : null })
    } else {
      // An account with no vote to start from starts blank: no side, 1×, no amount —
      // never the choices another account in the picker left behind.
      setDirection(target.direction ?? null)
      setAmountMode('custom')
      setConviction(1)
      setPrefilled({ amount: null, conviction: null })
    }
  }

  const track = live.data?.track ?? target.track ?? detail.data?.track ?? null
  const proxy = voter?.proxy ? { real: voter.actorId, proxyType: voter.proxy.proxyType } : null
  const feeQ = useQuery({
    queryKey: ['vote-fee-est', voter?.key ?? '', index],
    queryFn: () => estimateFeeHdx({ signer: voter!.signer, signerId: voter!.signerId, proxy, via: voter!.via, actions: [{ kind: 'vote', poll: index, vote: { kind: 'Standard', aye: true, conviction: 1, balance: ONE_HDX } }] }),
    enabled: !!voter && !voter.disabled,
    staleTime: 60_000,
  })
  // What removing this vote and unlocking its track will cost later: the fee of that
  // very batch, quoted now.
  const cleanupQ = useQuery({
    queryKey: ['vote-cleanup-fee', voter?.key ?? '', index, track],
    queryFn: () => estimateFeeHdx({ signer: voter!.signer, signerId: voter!.signerId, proxy, via: voter!.via, actions: [{ kind: 'remove-vote', poll: index, cls: track ?? 0 }, { kind: 'unlock', cls: track ?? 0, target: voter!.actorId }] }),
    enabled: !!voter && !voter.disabled && track != null,
    staleTime: 60_000,
  })
  const voteFee = feeQ.data ?? null
  const cleanupFee = cleanupQ.data ?? null
  const feeFromActor = actor && !proxy && actor.feeCurrency === 0 ? (voteFee ?? ONE_HDX / 2n) : 0n
  const suggested = roundUpTenth(suggestedReserve(voteFee, cleanupFee))
  const reserveFromText = reserveText != null ? parseHdx(reserveText) : null
  const reserve = reserveFromText ?? (prefs.reserve ? BigInt(prefs.reserve) : suggested)
  const presets = actor ? amountPresets(actor.hdx, { feeInHdxFromActor: feeFromActor, reserve }) : null
  const total = actor ? totalBalance(actor.hdx) : null
  const amount: bigint | null = amountMode === 'full' ? presets?.full ?? null
    : amountMode === 'almost' ? presets?.almostFull ?? null
    : amountMode === 'current' ? (current ? capitalOf(current.vote) : null)
    : amountMode === 'last' ? (last ? capitalOf(last.vote) : null)
    : parseHdx(customText)
  // A preset shows grouped to the cent ("31,165,604.19"); the vote keeps every planck of it.
  const amountText = amountMode === 'custom' ? customText : amount != null ? formatHdx(amount, 2) : ''
  const pickAmount = (m: AmountMode) => {
    touch()
    setAmountMode(m)
    setPrefilled(p => ({ ...p, amount: null }))
    if (m === 'current' && current?.vote.kind === 'Standard') { setConviction(current.vote.conviction); setPrefilled({ amount: null, conviction: null }) }
    if (m === 'last' && last?.vote.kind === 'Standard') { setConviction(last.vote.conviction); setPrefilled({ amount: null, conviction: null }) }
  }

  const lockPeriod = consts.data?.voteLockingPeriod ?? 302_400
  const msPerBlock = clock.data?.msPerBlock ?? 2_000
  const progress = detail.data?.progress ?? null
  const endBlock = progress?.confirmEndBlock ?? progress?.decisionEndBlock ?? null
  const endMs = (b: number) => (clock.data ? projectBlock(clock.data, b) : null)

  const splitNow = current && isSplit(current.vote) ? current.vote : null
  const spec: VoteSpec | null = direction === 'split'
    ? splitNow
    : direction && amount != null && amount > 0n ? voteSpec(direction, amount, direction === 'abstain' ? 0 : conviction) : null
  const stakedLock = actor ? actor.locks.filter(l => l.id === 'stk_stks' || l.id === 'ghdxlock').reduce((m, l) => (l.amount > m ? l.amount : m), 0n) : 0n
  const isGiga = !!actor?.gigahdx && actor.gigahdx.stakedHdx > 0n
  const isStaker = (actor?.stakingLock ?? 0n) > 0n

  let blocked: string | null = null
  if (!voter) blocked = 'Connect a wallet to vote.'
  else if (voter.disabled) blocked = voter.disabled
  else if (live.data && !live.data.ongoing) blocked = 'Voting on this referendum has closed.'
  else if (mode === 'vote' && !direction) blocked = 'Choose Aye, Nay or Abstain.'
  else if (mode === 'vote' && direction !== 'split' && (amount == null || amount <= 0n)) blocked = amountMode === 'custom' && customText.trim() ? 'Enter an amount in HDX, like 1000 or 12.5.' : 'Enter how much HDX to vote with.'
  else if (mode === 'vote' && total != null && spec && capitalOf(spec) > total) blocked = `That is more than this account holds (${formatHdx(total, 2)} HDX).`
  else if (mode === 'vote' && amountMode === 'almost' && reserveText != null && reserveFromText == null) blocked = 'The amount to keep unlocked must be a number of HDX, like 2 or 2.5.'
  else if (mode === 'remove' && (!current || track == null)) blocked = 'There is no vote to remove.'
  // The amount's own errors, said next to the field as well as above Sign.
  const amountError = blocked != null && mode === 'vote' && direction !== 'split' && (blocked.startsWith('Enter an amount in HDX') || blocked.startsWith('That is more than this account holds')) ? blocked : null
  const delegating = actor?.voting.find(c => c.cls === track && c.kind === 'delegating')
  if (!blocked && delegating && mode === 'vote') blocked = 'This account delegates its votes on this track, so its delegate votes for it. Undelegate in another app to vote here directly.'
  const classVotes = actor?.voting.find(c => c.cls === track)?.votes.length ?? 0
  if (!blocked && mode === 'vote' && !current && consts.data && classVotes >= consts.data.maxVotes) blocked = `This account already has ${classVotes} votes on this track (the most allowed). Remove votes on finished referenda first — open “Unlock & clean up”.`
  // The staking pallet tracks every vote of a staking position (across all tracks) and
  // refuses a new one past its limit (Staking.MaxVotesReached); a re-vote reuses its slot.
  const stakingVotes = actor?.staking ? actor.staking.votes.size : 0
  if (!blocked && mode === 'vote' && actor?.staking && !actor.staking.votes.has(index) && stakingVotes >= actor.staking.maxVotes) blocked = `This account’s staking position already tracks ${stakingVotes} votes, the most the staking pallet allows across all tracks. Remove votes on finished referenda first — “Unlock & clean up” frees one slot for each vote it removes.`

  // A vote only ever raises a track's lock; lowering it takes unlock(track). When the
  // new amount is below what the track holds locked, the same signature unlocks it,
  // so a smaller re-vote actually frees the difference (the dry-run says how much).
  const trackLock = actor?.classLocks.find(l => l.cls === track)?.amount ?? 0n
  const releases = mode === 'vote' && !!spec && track != null && trackLock > capitalOf(spec)
  const via = voter?.via ?? null
  const plan: WritePlan | null = voter && !voter.disabled
    ? mode === 'remove'
      ? (current && track != null ? { signer: voter.signer, signerId: voter.signerId, proxy, via, actions: [{ kind: 'remove-vote', poll: index, cls: current.cls }, { kind: 'unlock', cls: current.cls, target: voter.actorId }] } : null)
      : (spec ? { signer: voter.signer, signerId: voter.signerId, proxy, via, actions: [{ kind: 'vote', poll: index, vote: spec }, ...(releases ? [{ kind: 'unlock' as const, cls: track!, target: voter.actorId }] : [])] } : null)
    : null

  // Effect on the tally, against the chain's live tally.
  const moved: VoteSpec | null = mode === 'remove' ? (current?.vote ?? null) : spec
  const tally = live.data?.tally ?? null
  const before = tally && live.data ? tallyShares(tally, live.data.electorate) : null
  const delegatedHere = actor?.voting.find(c => c.cls === track)?.delegations
  const after = tally && live.data ? tallyShares(tallyAfter(tally, mode === 'remove' ? null : spec, current?.vote ?? null, delegatedHere), live.data.electorate) : null
  const approvalNeed = progress?.approval ? progress.approval.thresholdPerbill / 1e9 : null
  const supportNeed = progress?.support ? progress.support.thresholdPerbill / 1e9 : null
  const passesBefore = before && approvalNeed != null && supportNeed != null ? (before.approval ?? 0) >= approvalNeed && (before.support ?? 0) >= supportNeed : null
  const passesAfter = after && approvalNeed != null && supportNeed != null ? (after.approval ?? 0) >= approvalNeed && (after.support ?? 0) >= supportNeed : null

  const lockAmount = spec ? capitalOf(spec) : amount
  const spendAfter = actor && consts.data && lockAmount != null ? spendableWith(actor.hdx, lockAmount, consts.data.existentialDeposit) : null
  // Balances freezes the largest lock: this vote's, or one already in place.
  const biggestLock = actor ? actor.locks.filter(l => l.amount > 0n).sort((a, b) => (b.amount > a.amount ? 1 : -1))[0] ?? null : null
  const lockedAfter = lockAmount != null && actor ? (actor.hdx.frozen > lockAmount ? actor.hdx.frozen : lockAmount) : 0n
  const lockedFree = actor && lockedAfter > actor.hdx.reserved ? lockedAfter - actor.hdx.reserved : 0n
  const heldBy = actor ? [...new Set(actor.locks.filter(l => l.amount > 0n).map(l => HELD_BY[l.id] ?? `is held by the “${l.id}” lock`))] : []

  const inCart = cart.find(c => c.index === index)
  const title = detail.data?.title ?? target.title ?? null
  const successText = mode === 'remove' ? `Removed the vote on #${index}` : spec ? `Voted ${describeVote(spec)} on #${index}` : `Voted on #${index}`
  const sideWord = spec?.kind === 'Standard' ? (spec.aye ? 'Aye' : 'Nay') : direction === 'aye' ? 'Aye' : direction === 'nay' ? 'Nay' : null
  // What this vote costs in HDX that stays spendable: worth a warning only when what is
  // left would not pay two more fees (this account pays them in HDX itself).
  const feeGuess = voteFee ?? ONE_HDX / 2n
  const spendRisky = spendAfter != null && lockAmount != null && lockAmount > 0n && !!actor && !proxy && actor.feeCurrency === 0 && spendAfter < 2n * feeGuess
  const prefillParts = [prefilled.amount ? 'amount' : null, prefilled.conviction && direction !== 'abstain' ? 'conviction' : null].filter(Boolean)
  const prefillFrom = prefilled.amount ?? prefilled.conviction
  // The pre-fill chip: the standing vote when there is one, else the last vote; the
  // other (when both exist) waits under More options with the reserve.
  const mainPreset: 'current' | 'last' | null = current && !splitNow ? 'current' : last ? 'last' : null
  const presetLabel = (m: 'current' | 'last') => (m === 'current' ? 'Same as now' : 'Same as last time')
  const presetTitle = (m: 'current' | 'last') => (m === 'current' ? (current ? `Your current vote: ${describeVote(current.vote)}` : '') : last ? `Your vote on #${last.poll}: ${describeVote(last.vote)}` : '')
  const extraPreset: 'last' | null = mainPreset === 'current' && last ? 'last' : null
  const rewardTag = spec?.kind === 'Standard' && conviction > 0 && isGiga ? 'earns GIGAHDX rewards' : spec?.kind === 'Standard' && isStaker ? 'adds to staking rewards' : null
  const flips = passesBefore != null && passesAfter != null && passesBefore !== passesAfter
  const othersVoted = picked.alreadyVoted - (current && voter && !voter.proxy ? 1 : 0)

  if (!accounts.length) {
    // Before a wallet: the choices ahead, shown but not yet usable, so the sheet says what voting asks.
    return (
      <>
        <NoWallet reason="Connect a wallet to vote. Connecting only shares your addresses; nothing is signed until you press Sign." />
        <div className="vote-preview" aria-hidden="true">
          <section className="vote-block">
            <div className="vote-dirs">
              {DIRECTIONS.map(d => <span key={d.id} className={`vote-dir ${d.id}`}><span className="vote-dir-word">{d.label}</span></span>)}
            </div>
          </section>
          <section className="vote-block">
            <ConvictionRuler value={1} onChange={() => undefined} amount={0n} lockPeriod={lockPeriod} msPerBlock={msPerBlock} endBlock={endBlock} endMs={endMs} disabled />
          </section>
        </div>
      </>
    )
  }

  const directions = splitNow ? [...DIRECTIONS, { id: 'split' as const, label: 'Split' }] : DIRECTIONS

  // The explanations, for whoever wants them: one closed Details at the end of the sheet.
  const details = (
    <>
      {before && after && (
        <Fact k="Effect">
          Approval {pct(before.approval) === pct(after.approval) ? pct(after.approval) : <>{pct(before.approval)} → <strong>{pct(after.approval)}</strong></>}{approvalNeed != null && <span className="muted"> (needs {pct(approvalNeed)})</span>},
          {' '}support {pct(before.support) === pct(after.support) ? pct(after.support) : <>{pct(before.support)} → <strong>{pct(after.support)}</strong></>}{supportNeed != null && <span className="muted"> (needs {pct(supportNeed)})</span>}.
          {moved && <> {mode === 'remove' ? 'Takes away' : 'Adds'} {weightedOf(moved) > 0n ? `${F.amount(weightedOf(moved).toString(), 12)} votes` : `${F.amount(tallyDelta(moved).support.toString(), 12)} HDX of support`}{pct(before.approval) === pct(after.approval) && pct(before.support) === pct(after.support) ? ', too small to move the percentages' : ''}.</>}
        </Fact>
      )}
      {mode === 'vote' && actor && total != null && (
        <Fact k="Amount">
          You can vote with up to {formatHdx(total, 2)} HDX.
          {heldBy.length > 0 && <> It already {heldBy.join(' and ')}; locks overlap, so that’s fine.</>}
          {' '}Voting does not move HDX: it locks it in place.
          {last && <> Your last vote (#{last.poll}): {describeVote(last.vote)}.</>}
          {amountMode === 'full' && <> {feeFromActor > 0n ? <>Max leaves about {formatHdx(feeFromActor * 2n, 2)} HDX for this fee, which is paid before the vote is counted. </> : null}With all HDX locked, later fees (removing this vote, unlocking) need another asset{actor.feeCurrency !== 0 ? ' — this account pays fees in another asset, so that is fine' : ''}.</>}
        </Fact>
      )}
      {mode === 'vote' && spendAfter != null && lockAmount != null && lockAmount > 0n && actor && consts.data && (
        <Fact k="Spendable">
          After this vote, about {formatHdx(spendAfter, 2)} HDX stays spendable for fees and transfers:{' '}
          {lockedFree === 0n ? <>the {formatHdx(actor.hdx.reserved, 2)} HDX this account has reserved covers the lock, so its {formatHdx(actor.hdx.free, 2)} free HDX stays free.</> : <>{formatHdx(actor.hdx.free, 2)} HDX free, less {formatHdx(lockedFree, 2)} HDX locked ({lockedAfter === lockAmount ? `this vote’s ${formatHdx(lockedAfter, 2)} HDX` : `the largest lock already in place, ${biggestLock ? lockWord(biggestLock.id) : 'other locks'}, ${formatHdx(lockedAfter, 2)} HDX, which this vote shares`}{actor.hdx.reserved > 0n ? `, minus the ${formatHdx(actor.hdx.reserved, 2)} HDX reserved that it also covers` : ''}).</>}
          {lockedFree < consts.data.existentialDeposit ? ` ${formatHdx(consts.data.existentialDeposit, 0)} HDX (the existential deposit) always stays in the account.` : ''}
        </Fact>
      )}
      {(isStaker || isGiga) && (
        <Fact k="Rewards">
          {isGiga && <>This account holds GIGAHDX: Standard votes earn a share of the GIGAHDX voting rewards for this {track != null ? `${trackLabel(detail.data?.trackInfo?.name ?? null).toLowerCase()} ` : ''}track, weighted by conviction (0.1× and split votes earn none). Keep the vote until the referendum ends, then collect with “Unlock & clean up”. </>}
          {isStaker && <>This account stakes HDX: voting adds to its staking rewards once the referendum ends. Removing the vote earlier forfeits that.</>}
        </Fact>
      )}
    </>
  )

  return (
    <div className="vote-composer">
      <section className="vote-block vote-as" aria-label="Vote as">
        {loading && !voter ? <div className="skeleton" style={{ height: 52 }} /> : voter ? <VoterPicker voters={voters} value={voter} poll={index} onChange={v => { setVoter(v); setSeeded(null) }} /> : (
          <p className="vote-note">None of the connected accounts can sign on Hydration. Ethereum accounts held in a Polkadot extension need that wallet’s EVM mode. <button type="button" className="link-btn" onClick={openWallets}>Manage wallets</button></p>
        )}
        {othersVoted > 0 && <p className="vote-sub">{othersVoted === 1 ? 'Another of your accounts has' : `${othersVoted} other accounts of yours have`} voted on #{index}.</p>}
        {/* The address in full: a proxied account's name could be anyone's. */}
        {voter?.proxy && <p className="vote-sub vote-proxy-note">Voting for <span className="mono">{voter.actorAddress}</span> as its {voter.proxy.proxyType} proxy: the vote, its lock and rewards are that account’s; yours signs and pays the fee.</p>}
      </section>

      {mode === 'remove' ? (
        <section className="vote-block">
          {current && <p className="vote-standing">Remove your vote: <strong>{describeVote(current.vote)}</strong></p>}
          <p className="vote-say">{live.data?.ongoing
            ? 'It leaves the tally now, and the same signature releases the track’s lock, so its HDX frees up unless another vote still needs it.'
            : 'The referendum has ended, so removing the vote is safe. The same signature releases the track’s lock: HDX frees up unless your side won with conviction (that lock runs to its end) or another vote still needs it.'}</p>
          {live.data?.ongoing && (isStaker || isGiga) && <p className="vote-warn">This account {isGiga ? 'holds GIGAHDX' : 'stakes HDX'}: removing a vote while the referendum runs forfeits the {isGiga ? 'GIGAHDX voting reward' : 'staking reward'} it would earn. Keep it until the referendum ends to collect it.</p>}
        </section>
      ) : (
        <>
          <section className="vote-block">
            <RadioGroup className={`vote-dirs${splitNow ? ' four' : ''}`} aria-label="Your vote">
              {directions.map(d => (
                <button key={d.id} type="button" role="radio" aria-checked={direction === d.id} className={`vote-dir ${d.id}${direction === d.id ? ' on' : ''}`} onClick={() => { touch(); setDirection(d.id); setAdded(false) }}>
                  <span className="vote-dir-word">{d.label}</span>
                </button>
              ))}
            </RadioGroup>
            {direction === 'abstain' && <p className="vote-note">Counts toward turnout only: at a tenth of its HDX, with no lock afterwards and no GIGAHDX reward.</p>}
            {direction === 'split' && splitNow && <p className="vote-note">Re-signs your split exactly as it stands — {describeVote(splitNow)}. Split votes count at a tenth and carry no lock after the referendum. Choose Aye, Nay or Abstain instead to replace it with a single-direction vote.</p>}
            {splitNow && direction && direction !== 'split' && <p className="vote-warn">Your split vote ({describeVote(splitNow)}) will be replaced by this {direction === 'abstain' ? 'abstain' : direction} vote.</p>}
          </section>

          {direction !== 'split' && (
            <section className="vote-block">
              <label htmlFor="vote-amount" className="vote-label">Amount</label>
              <div className="vote-amount">
                <input id="vote-amount" inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0" value={amountText}
                  onChange={e => { touch(); setAmountMode('custom'); setCustomText(e.target.value); setPrefilled(p => ({ ...p, amount: null })) }}
                  aria-invalid={amountError ? true : undefined} aria-describedby={amountError ? 'vote-amount-error vote-amount-help' : 'vote-amount-help'} />
                <span className="vote-unit">HDX</span>
              </div>
              {amountError && <p id="vote-amount-error" className="vote-field-error">{amountError}</p>}
              <RadioGroup className="vote-chips" aria-label="Amount presets">
                {mainPreset && <button type="button" role="radio" aria-checked={amountMode === mainPreset} className={amountMode === mainPreset ? 'on' : ''} title={presetTitle(mainPreset)} onClick={() => pickAmount(mainPreset)}>{presetLabel(mainPreset)}</button>}
                {presets && <button type="button" role="radio" aria-checked={amountMode === 'full'} className={amountMode === 'full' ? 'on' : ''} title={`${formatHdx(presets.full, 2)} HDX`} onClick={() => pickAmount('full')}>Max</button>}
              </RadioGroup>
              <div id="vote-amount-help" className="vote-help">
                {actor && total != null && <p>Up to <Amt raw={total.toString()} dec={12} /> HDX · locks in place, never moves</p>}
                {prefillFrom && prefillParts.length > 0 && <p className="vote-prefill">Prefilled from {prefillFrom}: check {prefillParts.join(' and ')}</p>}
                {spendRisky && <p className="vote-warn">Leaves {formatHdx(spendAfter!, 2)} HDX spendable for fees: keep some back. {amountMode !== 'almost' && presets && <button type="button" className="link-btn" onClick={() => pickAmount('almost')}>Keep {formatHdx(reserve, 1)} HDX</button>}</p>}
              </div>
              {(presets || extraPreset) && (
                <GovDetails summary="More options" className="vote-more" open={amountMode === 'almost' || amountMode === extraPreset ? true : undefined}>
                  <div className="vote-chips" role="group" aria-label="More amount presets">
                    {extraPreset && <button type="button" aria-pressed={amountMode === extraPreset} className={amountMode === extraPreset ? 'on' : ''} title={presetTitle(extraPreset)} onClick={() => pickAmount(extraPreset)}>{presetLabel(extraPreset)}</button>}
                    {presets && <button type="button" aria-pressed={amountMode === 'almost'} className={amountMode === 'almost' ? 'on' : ''} title={`${formatHdx(presets.almostFull, 2)} HDX`} onClick={() => pickAmount('almost')}>All but {formatHdx(reserve, 1)} HDX (keeps fees)</button>}
                  </div>
                  {amountMode === 'almost' && (
                    <div className="vote-reserve">
                      <label htmlFor="vote-reserve">Keep</label>
                      <input id="vote-reserve" inputMode="decimal" autoComplete="off" value={reserveText ?? formatHdxInput(reserve)}
                        onChange={e => setReserveText(e.target.value)}
                        onBlur={() => { if (reserveFromText != null) setVotePrefs({ reserve: reserveFromText.toString() }) }} />
                      <span>HDX unlocked</span>
                      {reserve !== suggested && <button type="button" className="link-btn" onClick={() => { setReserveText(null); setVotePrefs({ reserve: null }) }}>use {formatHdx(suggested, 1)}</button>}
                    </div>
                  )}
                  <p className="vote-note">Keeps HDX free of this vote’s lock so later fees can be paid in HDX{voteFee != null ? <> (this vote costs ≈ {formatHdx(voteFee, 3)} HDX{cleanupFee != null ? <>; removing it and unlocking its track later, ≈ {formatHdx(cleanupFee, 3)} HDX</> : null})</> : null}. The suggestion is the larger of 2 HDX and three rounds of those fees; 1 HDX (the existential deposit) always stays in the account.</p>
                </GovDetails>
              )}
            </section>
          )}

          {direction !== 'abstain' && direction !== 'split' && (
            <section className="vote-block">
              <ConvictionRuler value={conviction} onChange={c => { touch(); setConviction(c); setPrefilled(p => ({ ...p, conviction: null })) }} amount={amount ?? 0n} lockPeriod={lockPeriod} msPerBlock={msPerBlock} endBlock={endBlock} endMs={endMs} disabled={!direction}
                side={sideWord} tag={rewardTag ? <span className="vote-tag">{rewardTag}</span> : null} />
              {(isStaker || isGiga) && conviction > 0 && (
                <p className="vote-caution">
                  Staked part stays locked even if {sideWord ?? 'your side'} loses
                  <InfoTip label="About staked locks">On Hydration, an account that stakes HDX is locked either way — even if its side loses — for the staked part (up to {formatHdx(stakedLock, 0)} HDX).</InfoTip>
                </p>
              )}
            </section>
          )}
        </>
      )}

      <ReviewPanel
        plan={blocked ? null : plan}
        blocked={blocked}
        signLabel={mode === 'remove' ? 'Remove vote' : current ? 'Sign new vote' : 'Sign vote'}
        successText={successText}
        aboveSign={flips ? <p className={`effect-flip ${passesAfter ? 'good' : 'bad'}`}>{passesAfter ? 'This would make it pass today’s thresholds.' : 'This would take it below today’s thresholds.'}</p> : null}
        belowSign={(
          <div className="vote-links">
            {mode === 'vote' && direction && direction !== 'split' && (inCart
              ? <span>#{index} is in your cart.</span>
              : added ? <span>Added.</span>
              : <button type="button" className="link-btn" onClick={() => { toggleCart({ index, title, track, direction }); setAdded(true) }}>Add to cart</button>)}
            {mode === 'vote' && (inCart || added || getCart().length > 0) && <button type="button" className="link-btn" onClick={() => openVote({ kind: 'cart' })}>Open cart ({cart.length})</button>}
            {current && track != null && (mode === 'vote'
              ? <button type="button" className="link-btn vote-links-end" onClick={() => setMode('remove')}>Remove vote</button>
              : <button type="button" className="link-btn vote-links-end" onClick={() => setMode('vote')}>Keep my vote</button>)}
          </div>
        )}
        details={(before && after) || (mode === 'vote' && actor) || isStaker || isGiga ? details : null}
        onFinal={(stage, rv) => {
          if (stage.phase === 'failed') return
          const actorId = rv.plan.proxy?.real ?? rv.plan.signerId
          if (mode === 'remove') forgetVote(actorId, index)
          else if (spec) rememberVote({ actorId, index, direction: directionOf(spec), conviction: spec.kind === 'Standard' ? spec.conviction : null, balance: capitalOf(spec).toString(), at: Date.now() })
          refresh([index])
        }}
      />
    </div>
  )
}
