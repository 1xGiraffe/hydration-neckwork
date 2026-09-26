// Which asset a transaction fee was actually charged in.
//
// `pallet-transaction-multi-payment` lets an account nominate any accepted
// currency as its fee currency (EVM accounts default to WETH). The fee is still
// COMPUTED in HDX — `TransactionPayment.TransactionFeePaid.actualFee`, mirrored
// into `raw_extrinsics.fee` (which excludes the tip) — but what leaves the
// account is that figure converted at the block's oracle price and debited in
// the nominated asset. Roughly a fifth of fee-paying extrinsics settle in
// something other than HDX (USDT, DOT, MYTH, GLMR, H2O, …), so the HDX number
// names an asset that never moved.
//
// The debited asset and amount live only in the extrinsic's own events:
//
//   Tokens.Withdrawn  {currencyId, who: payer}     pre-dispatch debit
//   Tokens.Deposited  {currencyId, who: payer}     post-dispatch refund
//   Tokens.Deposited  {currencyId, who: treasury}  the fee, INCLUDING the tip
//
// HDX uses the `Balances.Withdraw`/`Balances.Deposit` pair instead.
//
// pallet-currencies emits its own `Currencies.Withdrawn`/`Currencies.Deposited`
// AFTER the pallet it routed the movement to has emitted its event, so for a
// Tokens asset the Currencies event repeats a `Tokens.*` twin sitting directly
// before it (or behind the bookkeeping of an account the debit killed), and for
// HDX a `Balances.*` twin one `Balances.Issued`/`Balances.Rescinded` earlier.
// For an ERC-20 registry asset (HOLLAR, GDOT, BIL, the aTokens) there is no
// twin: the balance lives in contract storage, the adapter's transfer leaves
// only the contract's `EVM.Log`, and the Currencies event is the ONLY record of
// the movement — a fee charged in HOLLAR appears in nothing else. Measured over
// every Currencies event of 20k blocks: a Tokens or HDX one always has its
// twin, an ERC-20 one never. So a `Currencies.Deposited` to the treasury counts
// exactly when it is not the mirror of the treasury deposit directly before it
// (a `Tokens.Deposited`/`Balances.Deposit` of the same currency and amount),
// and a `Currencies.Withdrawn` of the payer always names a currency they were
// debited in — for a mirror the twin already named it, which a set absorbs.
//
// One ERC-20 debit has no pallet event at all: the EVM gas prepay. The fee
// handler burns it through the adapter (`burn_from`, the ERC-20 form of
// `Balances.Burned`), which is a bare contract `transfer` from the payer to the
// adapter's holding address — an `EVM.Log` and nothing else — so an
// `Ethereum.transact` or `dispatch_permit` charged in HOLLAR or GDOT debits its
// payer in no Currencies event (a signed dispatch still has the pre-dispatch
// `Currencies.Withdrawn` of its substrate fee). The `Transfer(payer, holding)`
// log IS that debit, on the contract whose own log sits directly before the
// bare `Currencies.Deposited` that paid the treasury; the payer's H160 is the
// runtime's `EvmAccounts::evm_address` of the AccountId32 (evmAddressOfAccount).
//
// An EVM dispatch debits differently again: it PREPAYS gas as `Balances.Burned`
// and refunds the unused part as `Balances.Minted`, so the payer never appears
// in a Withdraw at all. Without `Balances.Burned` among the debits nothing is
// ever charged in the resolver's eyes, the treasury deposits are all rejected
// for naming an undebited currency, and every `Ethereum.transact` and
// `dispatch_permit` reports no fee — which is what they did. The net of the
// burns and the mints equals the treasury deposits to the planck (14872335-2:
// 6,302,863,483,272 burned, 5,670,274,694,419 returned, 632,588,788,853 both
// paid and received), so summing the deposits states the gas exactly.
//
// So the fee is the treasury deposit — but an extrinsic can hold treasury
// deposits that are not fees (dust from a killed account arrives the same way,
// an Omnipool fee leg can deposit H2O, and a `PolkadotXcm.execute` pays its
// program's weight to the treasury through the XCM weight trader). Four
// conditions pin the right one:
//
//   * its currency was also DEBITED from the fee payer in the same extrinsic —
//     which is what separates a fee from a pool fee leg or another account's
//     transfer,
//   * it does not immediately follow `Balances.DustLost`: the dust of an HDX
//     account the call killed is swept to the treasury by that hook, as a
//     `Balances.Deposit` in the very next event, and the payer's own HDX debit
//     would otherwise vouch for it (orml dust moves as a `Tokens.Transfer`,
//     never a deposit, so it needs no rule),
//   * it is not the XCM weight trader's: the trader deposits its revenue when
//     the executor drops, which is the last thing before `PolkadotXcm.Attempted`
//     — so a treasury deposit separated from that barrier only by the run's own
//     bookkeeping (XCM_FEE_RUN_EVENTS: its Currencies mirror, the HDX
//     `Balances.Issued` twin, a `PolkadotXcm.Sent`) is the XCM execution fee,
//     which the revenue model books as its own stream. The payer WAS debited in
//     that currency (the program's `WithdrawAsset`), so the debit rule alone
//     admits it — and a `dispatch_permit` whose permit fee settles in the same
//     currency counted both as one fee. A treasury deposit before the barrier
//     with anything else between (a withdrawal, a dust sweep's `Treasury.Deposit`)
//     is not the trader's, and stays a candidate; the in-credit local leg of a
//     `transfer_assets` emits the same barrier and never a trader deposit, and
//   * it is the LAST such deposit, because `correct_and_deposit_fee` runs in
//     post-dispatch, after every event the call itself produced.
//
// The resolver therefore takes the extrinsic's WHOLE event sequence in chain
// order — a pre-filtered list cannot tell a contiguous run from a gap.
//
// An extrinsic can pay BOTH: a `Dispatcher.dispatch_evm_call`, a
// `Utility.batch_all` of `EVM.call`s or any other signed wrapper that runs the
// EVM is `Pays::Yes`, so it prepays gas mid-dispatch (one treasury deposit per
// call) and settles the substrate fee post-dispatch (the last deposit). The
// substrate fee is `amount`; the gas is `gas`, the other candidates in the fee
// currency — stated only when the extrinsic ran the EVM (EVM_EXECUTION_EVENTS
// among its events), because outside that scope an earlier same-currency
// treasury deposit is not a charge the payer made. 15011574-3 (dispatch_evm_call):
// 1,765,954,456,969 burned, 1,418,746,619,275 minted back, 347,207,837,694 to
// the treasury as gas at event 35, then the 928,231,574,052 fee at event 49.
//
// The revenue model's network-fee stream (services/revenueStreams.ts,
// networkFeeRowsSql) applies these same rules in SQL — the substrate arm books
// `amount`, the deposit arm books `gas` under the same scope and the same
// "every deposit in the fee currency but the post-dispatch one" rule — so the
// fee a page shows and the fee the protocol books are one figure.
//
// Verified against 13759746-2 (DOT), 13756091-3 (H2O), 13706669-3 (HDX fee
// alongside 0.0001 HDX of dust), 13443355-3 (EVM, three WETH gas deposits),
// 15038567-3 (a bare PolkadotXcm.execute: 0.00637 DOT to the trader, then the
// 1.2676 HDX substrate fee), 15011574-3 and 15055487-2 (gas beside the fee),
// 15033063-2 (dispatch_evm_call paid in HOLLAR: 0.0031 HOLLAR of gas, then the
// 0.0070 HOLLAR fee, every movement a bare Currencies event), 15049694-2
// (Pays::No EVM.call in GDOT: gas plus a 1-wei rebasing remainder) and
// 14802829-2 (dispatch_permit paid in GDOT: the prepay a contract log alone).
import { evmAddressOfAccount } from './addressIdentity.ts'
import {
  ERC20_HOLDING_ADDRESS, ERC20_TRANSFER_TOPIC, EVM_EXECUTION_EVENTS, FEE_DEBIT_EVENTS, FEE_DEPOSIT_EVENTS, TREASURY_ACCOUNT,
} from './revenueStreams.ts'
import { XCM_EXECUTE_BARRIER_EVENT, XCM_FEE_RUN_EVENTS } from './xcmWalkEvents.ts'

const XCM_FEE_RUN = new Set<string>(XCM_FEE_RUN_EVENTS)
const EVM_EXECUTION = new Set<string>(EVM_EXECUTION_EVENTS)
const DEBIT_EVENTS = new Set<string>(FEE_DEBIT_EVENTS)
const DEPOSIT_EVENTS = new Set<string>(FEE_DEPOSIT_EVENTS)

export interface FeePaymentEvent {
  name: string
  args: unknown
}

export interface DerivedFeePayment {
  assetId: number
  /** Raw integer amount of the fee itself, tip excluded. */
  amount: string
  /** Raw integer tip in the same asset; null when the extrinsic carried no tip. */
  tipAmount: string | null
  /**
   * EVM gas the extrinsic charged BESIDE its substrate fee (`amount`), with its
   * own asset: what the EVM burned net of its refund, as the treasury received
   * it. Present only when the extrinsic paid a substrate fee and ran the EVM;
   * when there is no substrate fee the gas IS `amount`.
   */
  gas?: { assetId: number; amount: string }
}

function argOf(args: unknown, key: string): unknown {
  return args && typeof args === 'object' ? (args as Record<string, unknown>)[key] : undefined
}

function accountArg(args: unknown, key: string): string | null {
  const v = argOf(args, key)
  return typeof v === 'string' ? v.toLowerCase() : null
}

function amountArg(args: unknown): bigint | null {
  const v = argOf(args, 'amount')
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v)
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v)
  return null
}

// A `Balances.*` event is the native asset by construction; `Tokens.*` and
// `Currencies.*` name it.
function currencyOf(name: string, args: unknown): number | null {
  if (name.startsWith('Balances.')) return 0
  const v = argOf(args, 'currencyId')
  return typeof v === 'number' ? v : null
}

function parseBig(raw: string | null | undefined): bigint | null {
  return raw != null && /^\d+$/.test(raw) ? BigInt(raw) : null
}

// An `EVM.Log` event's contract and, when it is an ERC-20 Transfer, its parties
// (lowercase H160s out of the padded indexed topics).
function evmLogOf(args: unknown): { contract: string; from: string | null; to: string | null } | null {
  const log = argOf(args, 'log')
  const address = argOf(log, 'address')
  if (typeof address !== 'string') return null
  const topics = argOf(log, 'topics')
  const transfer = Array.isArray(topics) && topics.length >= 3 && typeof topics[0] === 'string'
    && topics[0].toLowerCase() === ERC20_TRANSFER_TOPIC
  const party = (topic: unknown): string | null =>
    typeof topic === 'string' && topic.length === 66 ? '0x' + topic.slice(26).toLowerCase() : null
  return {
    contract: address.toLowerCase(),
    from: transfer ? party(topics[1]) : null,
    to: transfer ? party(topics[2]) : null,
  }
}

/**
 * Whether the extrinsic carries a substrate fee figure that charged something.
 * False for both EVM shapes — `Ethereum.transact` (no `TransactionFeePaid`) and a
 * `Pays::No` dispatch (`actualFee: 0`) — which is the line the derivation and its
 * readers both split on, so they share one definition of it.
 */
export function hasSubstrateFee(feeHdx: string | null, tipHdx: string | null): boolean {
  const fee = parseBig(feeHdx)
  if (fee == null) return false
  return fee + (parseBig(tipHdx) ?? 0n) > 0n
}

/**
 * The asset and amount an extrinsic's fee was actually charged in, or null when
 * the extrinsic's events do not name one (no payer, no matching treasury
 * deposit, an inherent).
 *
 * `events` is the extrinsic's own event sequence, WHOLE and in chain order (see
 * the module header for why a filtered list will not do). `feeHdx`/`tipHdx` are
 * `raw_extrinsics.fee`/`tip` — the HDX-equivalent base fee and tip.
 *
 * When they say the substrate charged NOTHING, the cost is EVM gas and every
 * matching treasury deposit is summed rather than only the last one taken: one
 * extrinsic can charge gas several times, and there is no post-dispatch fee
 * deposit for "last" to mean. That covers both shapes — `Ethereum.transact`
 * emits no `TransactionFeePaid` at all (null), and an `EVM.call` or
 * `dispatch_permit` dispatched `Pays::No` reports `actualFee: 0` while its gas
 * arrives as its own deposit plus a rounding remainder (13749778-2: 342257016041
 * + 1 planck of BNC — taking the last alone would state one planck).
 *
 * When they say the substrate charged something AND the events say the EVM ran
 * (EVM_EXECUTION_EVENTS — a `Dispatcher.dispatch_evm_call`, a `Utility.batch_all`
 * of `EVM.call`s, any `Pays::Yes` wrapper around one), the extrinsic paid both:
 * the last candidate is the post-dispatch substrate fee and every earlier one
 * in its currency is gas, returned as `gas` so the page can state what the
 * account actually paid. Without the marker an earlier same-currency treasury
 * deposit is nothing the payer was charged (the revenue model books none), so
 * `gas` stays absent.
 *
 * The tip is split off by the exact `tip / (fee + tip)` ratio. The runtime
 * converts fee and tip through the same price with independent truncation, so
 * the split can differ from the chain's own by at most one raw unit — which no
 * display of a fee can show.
 */
export function deriveFeePayment(
  events: readonly FeePaymentEvent[],
  payer: string | null,
  feeHdx: string | null,
  tipHdx: string | null,
): DerivedFeePayment | null {
  if (!payer) return null
  const who = payer.toLowerCase()
  const whoEvm = evmAddressOfAccount(who)

  const debited = new Set<number>()
  // Contracts the ERC-20 adapter withdrew the payer's balance from — the debit
  // of a bare Currencies deposit made on the same contract (module header).
  const erc20Debited = new Set<string>()
  const deposits: { assetId: number; amount: bigint; contract: string | null }[] = []
  let ranEvm = false
  // The contract of the `EVM.Log` directly before the current event, else null.
  let previousLogContract: string | null = null
  // "The deposit right after DustLost" is the previous element of the sequence.
  let afterDustLost = false
  // Whether the newest treasury deposit is still joined to the events after it by
  // nothing but the XCM run's own bookkeeping — true right after it is pushed,
  // false at the first event that is not in XCM_FEE_RUN_EVENTS. An XCM barrier
  // arriving while it holds names that deposit as the weight trader's.
  let lastDepositContiguous = false
  // The treasury deposit before the current one, dust sweeps included: a
  // `Currencies.Deposited` repeating its currency and amount is its mirror.
  let previousTreasuryDeposit: { name: string; assetId: number | null; amount: bigint | null } | null = null
  for (const e of events) {
    const dustSweep = afterDustLost
    afterDustLost = e.name === 'Balances.DustLost'
    const logContract = previousLogContract
    previousLogContract = null
    if (EVM_EXECUTION.has(e.name)) ranEvm = true
    if (e.name === XCM_EXECUTE_BARRIER_EVENT) {
      if (lastDepositContiguous) deposits.pop()
      lastDepositContiguous = false
      continue
    }
    if (DEBIT_EVENTS.has(e.name)) {
      lastDepositContiguous = false
      if (accountArg(e.args, 'who') !== who) continue
      const cid = currencyOf(e.name, e.args)
      if (cid != null) debited.add(cid)
    } else if (DEPOSIT_EVENTS.has(e.name)) {
      if (accountArg(e.args, 'who') !== TREASURY_ACCOUNT) continue
      const cid = currencyOf(e.name, e.args)
      const amount = amountArg(e.args)
      const previous = previousTreasuryDeposit
      previousTreasuryDeposit = { name: e.name, assetId: cid, amount }
      const mirror = e.name === 'Currencies.Deposited' && previous != null
        && previous.name !== 'Currencies.Deposited' && previous.assetId === cid && previous.amount === amount
      if (dustSweep || mirror) continue
      if (cid != null && amount != null && amount > 0n) {
        deposits.push({ assetId: cid, amount, contract: e.name === 'Currencies.Deposited' ? logContract : null })
        lastDepositContiguous = true
      }
    } else if (e.name === 'EVM.Log') {
      // Run bookkeeping for the XCM rule (XCM_FEE_RUN_EVENTS), and the adapter's
      // own record of an ERC-20 debit when it is the payer's transfer to holding.
      const log = evmLogOf(e.args)
      if (log) {
        previousLogContract = log.contract
        if (log.from === whoEvm && log.to === ERC20_HOLDING_ADDRESS) erc20Debited.add(log.contract)
      }
    } else if (!XCM_FEE_RUN.has(e.name)) {
      lastDepositContiguous = false
    }
  }

  const candidates = deposits.filter(d => debited.has(d.assetId) || (d.contract != null && erc20Debited.has(d.contract)))
  const last = candidates[candidates.length - 1]
  if (!last) return null

  const substrateFee = hasSubstrateFee(feeHdx, tipHdx)
  const inFeeCurrency = candidates.filter(c => c.assetId === last.assetId)
  const paid = substrateFee ? last.amount : inFeeCurrency.reduce((sum, c) => sum + c.amount, 0n)
  // With a substrate fee the last candidate is that fee; what the EVM charged
  // before it, in the same currency, is the gas the revenue model's deposit arm
  // books — one rule for both readers.
  const gasPaid = substrateFee && ranEvm
    ? inFeeCurrency.slice(0, -1).reduce((sum, c) => sum + c.amount, 0n)
    : 0n
  const gas = gasPaid > 0n ? { gas: { assetId: last.assetId, amount: String(gasPaid) } } : {}

  const fee = parseBig(feeHdx)
  const tip = parseBig(tipHdx)
  if (fee != null && tip != null && tip > 0n) {
    const actual = fee + tip
    const tipPart = (paid * tip) / actual
    return { assetId: last.assetId, amount: String(paid - tipPart), tipAmount: String(tipPart), ...gas }
  }
  return { assetId: last.assetId, amount: String(paid), tipAmount: null, ...gas }
}
