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
// `Currencies.Withdrawn`/`Currencies.Deposited` are duplicate mirrors of the
// orml-tokens events and must never be counted.
//
// So the fee is the treasury deposit — but an extrinsic can hold treasury
// deposits that are not fees (dust from a killed account arrives the same way,
// and an Omnipool fee leg can deposit H2O). Two conditions pin the right one:
//
//   * its currency was also DEBITED from the fee payer in the same extrinsic —
//     which is what separates a fee from a dust sweep or a pool fee leg, and
//   * it is the LAST such deposit, because `correct_and_deposit_fee` runs in
//     post-dispatch, after every event the call itself produced.
//
// Verified against 13759746-2 (DOT), 13756091-3 (H2O), 13706669-3 (HDX fee
// alongside 0.0001 HDX of dust) and 13443355-3 (EVM, three WETH gas deposits).
export const FEE_BALANCE_EVENTS = [
  'Tokens.Withdrawn',
  'Balances.Withdraw',
  'Tokens.Deposited',
  'Balances.Deposit',
] as const

/** The Substrate Treasury pallet account (`modlpy/trsry`), pubkey hex. */
const TREASURY_POT = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'

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

// A `Balances.*` event is the native asset by construction; `Tokens.*` names it.
function currencyOf(name: string, args: unknown): number | null {
  if (name.startsWith('Balances.')) return 0
  const v = argOf(args, 'currencyId')
  return typeof v === 'number' ? v : null
}

function parseBig(raw: string | null | undefined): bigint | null {
  return raw != null && /^\d+$/.test(raw) ? BigInt(raw) : null
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
 * `feeHdx`/`tipHdx` are `raw_extrinsics.fee`/`tip` — the HDX-equivalent base fee
 * and tip.
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

  const debited = new Set<number>()
  const deposits: { assetId: number; amount: bigint }[] = []
  for (const e of events) {
    if (e.name === 'Tokens.Withdrawn' || e.name === 'Balances.Withdraw') {
      if (accountArg(e.args, 'who') !== who) continue
      const cid = currencyOf(e.name, e.args)
      if (cid != null) debited.add(cid)
    } else if (e.name === 'Tokens.Deposited' || e.name === 'Balances.Deposit') {
      if (accountArg(e.args, 'who') !== TREASURY_POT) continue
      const cid = currencyOf(e.name, e.args)
      const amount = amountArg(e.args)
      if (cid != null && amount != null && amount > 0n) deposits.push({ assetId: cid, amount })
    }
  }

  const candidates = deposits.filter(d => debited.has(d.assetId))
  const last = candidates[candidates.length - 1]
  if (!last) return null

  const paid = hasSubstrateFee(feeHdx, tipHdx)
    ? last.amount
    : candidates.filter(c => c.assetId === last.assetId).reduce((sum, c) => sum + c.amount, 0n)

  const fee = parseBig(feeHdx)
  const tip = parseBig(tipHdx)
  if (fee != null && tip != null && tip > 0n) {
    const actual = fee + tip
    const tipPart = (paid * tip) / actual
    return { assetId: last.assetId, amount: String(paid - tipPart), tipAmount: String(tipPart) }
  }
  return { assetId: last.assetId, amount: String(paid), tipAmount: null }
}
