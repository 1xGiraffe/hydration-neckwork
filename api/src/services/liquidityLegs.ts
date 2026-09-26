// The amounts a pallet liquidity event does not state, recovered from the
// transfer legs beside it. One definition for the explorer's activity feeds and
// the Data API's /v1/accounts/{address}/liquidity, so an XYK add's or removal's
// two legs and an Omnipool removal's asset leg read the same on both surfaces.
// Each surface loads the legs of its own page (transfer_activity_by_time by
// primary key, in the rows' own assets) and hands them to matchLiquidityAmounts.
//
// A LEAF — no imports — so the data tree may take it (the allow-list in
// api/tests/data/isolation.test.ts); explorerService re-exports it.

// The treasury pot (`modlpy/trsry`). It takes the XYK pool-creation / LP-token
// existential deposit beside a liquidity action and refunds it when the last LP
// exits, so it is never the pool side of a recovered leg.
export const TREASURY_POT = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'

// Events whose empty amount is the ANSWER, not a gap to be recovered.
// XYK.PoolDestroyed is emitted in the same extrinsic as XYK.LiquidityRemoved,
// with the same `who` and the same assetA, so the pool↔who pairing WOULD match —
// and would render the removal's value a second time, inflating every feed the
// row appears in and admitting it to value filters. 728 of 728 destructions carry
// that sibling, so this is unconditional.
export const AMOUNTLESS_LIQUIDITY_EVENTS: ReadonlySet<string> = new Set(['XYK.PoolDestroyed'])
export function isAmountlessLiquidityEvent(eventName: string): boolean {
  return AMOUNTLESS_LIQUIDITY_EVENTS.has(eventName)
}

// An XYK add, removal or pool creation moves BOTH of the pair's assets between
// `who` and the pool, and its event states neither amount in the row's
// denomination (LiquidityAdded carries amountA/amountB beside assetA/assetB,
// LiquidityRemoved only `shares`, PoolCreated only `initialSharesAmount`), so a row
// of any of them is a PAIR of transfer legs recovered together: assetA's leg as the
// row's `amount`, assetB's as `amount_b`. Rendering assetA's leg alone halved every
// XYK removal's value, left every add empty and stated half of every pool's seed.
export const XYK_TWO_LEG_EVENTS: ReadonlySet<string> = new Set(['XYK.LiquidityAdded', 'XYK.LiquidityRemoved', 'XYK.PoolCreated'])
// The add and the removal alone — the two the explorer renders from the recovered
// pair (xykPairLegs); it builds a pool creation's seed legs and their value in its
// own builder (enrichPoolCreations). The Data API publishes all three pairs alike.
export const XYK_PAIR_EVENTS: ReadonlySet<string> = new Set(['XYK.LiquidityAdded', 'XYK.LiquidityRemoved'])
// The liquidity events whose recovered legs run who→pool; every other event's leg
// is a pool→who payout.
const XYK_DEPOSIT_EVENTS: ReadonlySet<string> = new Set(['XYK.PoolCreated', 'XYK.LiquidityAdded'])

export interface LiquidityAmountCandidate {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  event_name: string
  who: string
  asset_id: number
  amount: string
  // The pair's second asset and its recovered leg — an XYK add, removal or pool
  // creation only (XYK_TWO_LEG_EVENTS); every other event has one leg, `amount`.
  asset_b?: number | null
  amount_b?: string
}

export interface LiquidityTransferLeg {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  asset_id: number
  from_account: string
  to_account: string
  amount: string
}

// The rows whose amount is a gap to recover: amountless in the table, with an
// account and asset to match on, and not an event whose empty amount is final.
export function missingLiquidityAmounts<T extends LiquidityAmountCandidate>(rows: readonly T[]): T[] {
  return rows.filter(r => !r.amount && r.who && r.asset_id != null && !isAmountlessLiquidityEvent(r.event_name))
}

// The assets whose legs can ever be matched for these rows — both of an XYK
// pair's — so a loader ships only those legs rather than a batch or routed
// extrinsic's unrelated ones.
export function liquidityLegAssetIds(missing: readonly LiquidityAmountCandidate[]): number[] {
  return [...new Set(missing.flatMap(r => XYK_TWO_LEG_EVENTS.has(r.event_name) && r.asset_b != null ? [r.asset_id, r.asset_b] : [r.asset_id]))]
}

// Omnipool/Stableswap liquidity events carry only shares (sharesRemoved / shares),
// never the underlying token amount — that lives on the paired pool↔who transfer
// leg. Recover it by matching each amount-less row to a leg with the same asset +
// account and the nearest preceding event index, consuming each leg once.
//
// Legs are matched within the same DISPATCH SCOPE: signed user actions scope to
// their extrinsic, while scheduler/hook-dispatched events (an Omnipool asset being
// offboarded force-removes every position from a runtime hook) carry no extrinsic
// and scope to the block's out-of-extrinsic legs. Isolating the scopes stops a
// signed same-block transfer from being mistaken for an offboarding leg.
//
// An XYK add, removal or pool creation (XYK_TWO_LEG_EVENTS) recovers BOTH of its
// legs, as a pair against ONE counterparty: the pallet moves assetA and assetB
// between `who` and the same pool account, so assetA's candidates are tried
// nearest-first and the first with an assetB leg against the same account wins
// both. That is what keeps a same-asset leg to some other account in the same
// extrinsic — a batched transfer, the LP-token existential deposit — out of the
// pair. A pool creation's event PRECEDES its two deposits, so its legs are found
// among the candidates that follow it.
export function matchLiquidityAmounts(missing: LiquidityAmountCandidate[], legs: LiquidityTransferLeg[]): void {
  const scopeOf = (ext: number | null | undefined): string => ext == null ? 'blk' : String(ext)
  type LegEntry = { event_index: number; amount: string; counterparty: string; used: boolean }
  // Payout legs run pool→who and are found by their RECIPIENT; pool creation and
  // XYK add legs run who→pool (XYK_DEPOSIT_EVENTS) and are found by their SENDER.
  const byTo = new Map<string, LegEntry[]>()
  const byFrom = new Map<string, LegEntry[]>()
  const push = (map: Map<string, LegEntry[]>, key: string, entry: LegEntry): void => {
    const list = map.get(key) ?? []
    list.push(entry)
    map.set(key, list)
  }
  for (const t of legs) {
    if (!t.amount) continue
    const from = t.from_account.toLowerCase()
    const to = t.to_account.toLowerCase()
    const scope = scopeOf(t.extrinsic_index)
    // The pool side of a leg is never the Treasury. It appears in a liquidity
    // extrinsic only to take the XYK pool-creation / LP-token existential deposit
    // (who→Treasury, emitted AFTER the pool deposits) or to refund it when the last
    // LP exits and the pool is destroyed (Treasury→who, AFTER the pool's own
    // payout) — so adjacency alone would report the 1 HDX deposit as the real leg
    // on every HDX-paired action.
    if (from !== TREASURY_POT) push(byTo, `${t.block_height}:${scope}:${t.asset_id}:${to}`, { event_index: t.event_index, amount: t.amount, counterparty: from, used: false })
    if (to !== TREASURY_POT) push(byFrom, `${t.block_height}:${scope}:${t.asset_id}:${from}`, { event_index: t.event_index, amount: t.amount, counterparty: to, used: false })
  }
  for (const list of byTo.values()) list.sort((a, b) => a.event_index - b.event_index)
  for (const list of byFrom.values()) list.sort((a, b) => a.event_index - b.event_index)
  // Unused legs nearest-first: the closest preceding leg, then the rest before it,
  // then any that follow — the order a lone leg is taken in.
  const candidates = (list: LegEntry[] | undefined, eventIndex: number): LegEntry[] => {
    const free = (list ?? []).filter(t => !t.used)
    return [...free.filter(t => t.event_index < eventIndex).reverse(), ...free.filter(t => t.event_index >= eventIndex)]
  }
  for (const row of missing) {
    if (row.amount || !row.who || row.asset_id == null) continue
    const scope = scopeOf(row.extrinsic_index)
    const lookup = XYK_DEPOSIT_EVENTS.has(row.event_name) ? byFrom : byTo
    const key = (assetId: number): string => `${row.block_height}:${scope}:${assetId}:${row.who.toLowerCase()}`
    const legsA = candidates(lookup.get(key(row.asset_id)), row.event_index)
    if (!legsA.length) continue
    // A pair names two distinct assets: a row pinned to one of them on both sides
    // (a surface showing the creation under its assetB) takes the single leg.
    if (XYK_TWO_LEG_EVENTS.has(row.event_name) && row.asset_b != null && row.asset_b !== row.asset_id) {
      const legsB = candidates(lookup.get(key(row.asset_b)), row.event_index)
      const pair = legsA.flatMap(a => {
        const b = legsB.find(t => t.counterparty === a.counterparty)
        return b ? [[a, b]] : []
      })[0]
      if (pair) {
        pair[0].used = pair[1].used = true
        row.amount = pair[0].amount
        row.amount_b = pair[1].amount
        continue
      }
    }
    // No pair: assetA's nearest leg alone, the single-leg display (the explorer's
    // xykPairLegs leaves such a row's assetB leg and value unstated).
    const match = legsA[0]
    match.used = true
    row.amount = match.amount
  }
}
