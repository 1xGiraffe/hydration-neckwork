// The logic of the aToken / variable-debt scaled-balance anchor
// (snapshot-atoken-anchors.ts), kept free of any connection so it can be
// exercised with fakes: the batched eth_call reader, the anchor rows a contract
// yields at B0, the candidate holder set, and the sample check that an anchor
// equals the chain's scaled balance.
//
// The anchor is the chain's own SCALED balance at B0 — `scaledBalanceOf(holder)`
// and, for the holder = '' total row, `scaledTotalSupply()` — read directly.
// It must not be derived as balanceOf · RAY / index: balanceOf is
// scaled.rayMul(index) (rounded half-up), so dividing back by the index is not an
// inverse — and the index balanceOf compounds to at B0 is not the reserve's
// STORED index from the last ReserveDataUpdated ≤ B0 either. Either shortcut
// misstates about half of all holder rows by ~6e-9 relative, and every
// holder = '' total differs from scaledTotalSupply.

/**
 * The lowest block raw ingestion must have completed before the anchor's first
 * capture: just below the money market's first log (the aToken implementation's
 * Initialized at 6,382,885; the reserve aToken / variable-debt proxies initialize
 * from 6,382,902 and the pool's first ReserveDataUpdated is at 6,468,408). The
 * candidate sources — the contracts' own logs, the scaled-delta model fed by them,
 * the RewardsController's Accrued (from 7,346,897, inside this window), the
 * collateral sweep's users and the Substrate legs of the registry assets over the
 * aTokens — are read from raw indexed in this window, so a capture on a partial
 * backfill would anchor too few holders; later cycles top the table up with the
 * candidates the sources name since (anchorKeysToRead), but the full capture is
 * the one that reads them all at once.
 */
export const MM_LOGS_FROM = 6_382_800

export const RAY = 10n ** 27n

export const SEL = {
  reservesList: 'd1946dbc',
  reserveData: '35ea6a75',
  scaledBalanceOf: '1da24f3e',
  scaledTotalSupply: 'b1bf962d',
} as const

export const ZERO_H160 = '0x0000000000000000000000000000000000000000'

export interface EthCallRequest { to: string; data: string }
/** Batched eth_call at `block` (a hex tag or 'latest'); one result per request, in order. */
export type EthCall = (calls: EthCallRequest[], block: string) => Promise<string[]>

export interface AnchorRow { contract_address: string; holder: string; scaled_balance: string; anchor_block: number }

export const blockTag = (block: number): string => `0x${block.toString(16)}`
export const padAddress = (h160: string): string => h160.slice(2).toLowerCase().padStart(64, '0')

/** The read that states an anchor row: scaledTotalSupply() for '', scaledBalanceOf(holder) otherwise. */
export function scaledCall(contract: string, holder: string): EthCallRequest {
  return holder === ''
    ? { to: contract, data: `0x${SEL.scaledTotalSupply}` }
    : { to: contract, data: `0x${SEL.scaledBalanceOf}${padAddress(holder)}` }
}

/** A uint256 return, or null for an empty return ('0x': reverted, or no code at that block). */
export function parseUint(hex: string): bigint | null {
  if (hex === '0x' || hex === '') return null
  return BigInt(hex)
}

interface BatchOptions { chunk?: number; attempts?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; /** Error-message prefix naming the caller. */ label?: string }

/**
 * A batched JSON-RPC eth_call reader over `fetchImpl`.
 *
 * THROWS if any request in the batch never produced a result — a dropped chunk or
 * a per-item JSON-RPC error. A missing balance is indistinguishable from a zero
 * one, so passing null through would let a holder drop out and a short anchor be
 * published; the table then being non-empty, no later cycle would recompute it.
 * An empty return ('0x' — reverted, or no code at the block) IS a result and is
 * passed through for the caller to treat as a legitimate skip.
 */
export function makeEthCallBatch(rpcUrl: string, fetchImpl: typeof fetch = fetch, options: BatchOptions = {}): EthCall {
  const CHUNK = options.chunk ?? 50
  const attempts = options.attempts ?? 3
  const timeoutMs = options.timeoutMs ?? 30_000
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const label = options.label ?? 'atoken-anchor'
  return async (calls, block) => {
    const out: (string | null)[] = new Array(calls.length).fill(null)
    for (let start = 0; start < calls.length; start += CHUNK) {
      const chunk = calls.slice(start, start + CHUNK)
      const body = chunk.map((c, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: c.to, data: c.data }, block] }))
      let lastError: unknown = null
      for (let attempt = 0; attempt < attempts; attempt++) {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), timeoutMs)
        try {
          const res = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal, body: JSON.stringify(body) })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const json = await res.json() as { id: number; result?: string; error?: { message?: string } }[]
          if (!Array.isArray(json)) throw new Error('non-array batch response')
          const itemErrors = json.filter(r => typeof r.result !== 'string')
          if (itemErrors.length) {
            throw new Error(`${itemErrors.length}/${chunk.length} calls errored, first: ${itemErrors[0]?.error?.message ?? 'no result'}`)
          }
          for (const r of json) if (typeof r.id === 'number' && r.id >= 0 && r.id < chunk.length) out[start + r.id] = r.result!
          lastError = null
          break
        } catch (err) {
          lastError = err
          if (attempt < attempts - 1) await sleep(1000 * (attempt + 1))
        } finally { clearTimeout(timer) }
      }
      if (lastError != null) {
        throw new Error(`[${label}] eth_call batch at offset ${start} (block ${block}) failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
      }
    }
    const missing = out.findIndex(value => value == null)
    if (missing >= 0) throw new Error(`[${label}] eth_call batch returned no result for request ${missing} (block ${block})`)
    return out as string[]
  }
}

export type AnchorMode = 'full' | 'top-up'

/**
 * The anchor keys ('' for the total, else a holder) one cycle reads for a
 * contract. A full capture reads every candidate; a top-up reads only the keys the
 * table holds no row for — a candidate a source named since the last capture (a
 * pre-B0 holder outside the money market's own log coverage, swept later as a
 * collateral user, or named by a Substrate transfer of the registry asset over the
 * aToken). Rows are pinned at B0, so re-reading an anchored key could only repeat
 * it; a candidate that read zero has no row and is read again, which costs one
 * call and keeps a holder from being missed for good.
 */
export function anchorKeysToRead(candidates: readonly string[], anchored: ReadonlySet<string>, mode: AnchorMode): string[] {
  const keys = ['', ...candidates]
  return mode === 'full' ? keys : keys.filter(key => !anchored.has(key))
}

/**
 * The anchor rows of one scaled-balance contract at `anchorBlock`: the
 * scaledTotalSupply() total (holder = '') and scaledBalanceOf(h) for every
 * candidate holder, read at that block with no index arithmetic. An empty return
 * (no code at B0: a reserve created after it) and a zero balance yield no row.
 */
export async function anchorForContract(contract: string, holders: string[], anchorBlock: number, ethCall: EthCall): Promise<AnchorRow[]> {
  return anchorRowsForKeys(contract, ['', ...holders], anchorBlock, ethCall)
}

/** anchorForContract over an explicit key list (anchorKeysToRead's output). */
export async function anchorRowsForKeys(contract: string, keys: readonly string[], anchorBlock: number, ethCall: EthCall): Promise<AnchorRow[]> {
  if (!keys.length) return []
  const results = await ethCall(keys.map(h => scaledCall(contract, h)), blockTag(anchorBlock))
  const rows: AnchorRow[] = []
  keys.forEach((holder, i) => {
    const scaled = parseUint(results[i])
    if (scaled == null || scaled <= 0n) return
    rows.push({ contract_address: contract, holder, scaled_balance: scaled.toString(), anchor_block: anchorBlock })
  })
  return rows
}

/**
 * A deterministic verification sample: every holder = '' total row, plus up to
 * `size` holder rows spread evenly over the (contract, holder)-sorted set.
 */
export function verificationSample(rows: AnchorRow[], size: number): AnchorRow[] {
  const sorted = [...rows].sort((a, b) => a.contract_address.localeCompare(b.contract_address) || a.holder.localeCompare(b.holder))
  const totals = sorted.filter(r => r.holder === '')
  const holders = sorted.filter(r => r.holder !== '')
  if (size <= 0 || holders.length === 0) return totals
  if (size >= holders.length) return [...totals, ...holders]
  const step = holders.length / size
  const picked: AnchorRow[] = []
  for (let i = 0; i < size; i++) picked.push(holders[Math.floor(i * step)])
  return [...totals, ...picked]
}

export interface VerifyResult { checked: number; matched: number; mismatches: { contract_address: string; holder: string; anchor: string; chain: string | null; anchor_block: number }[] }

/** Compare anchor rows to scaledBalanceOf / scaledTotalSupply at each row's anchor block. */
export async function verifyAnchors(rows: AnchorRow[], ethCall: EthCall): Promise<VerifyResult> {
  const byBlock = new Map<number, AnchorRow[]>()
  for (const r of rows) {
    const b = Number(r.anchor_block)
    if (!byBlock.has(b)) byBlock.set(b, [])
    byBlock.get(b)!.push(r)
  }
  const mismatches: VerifyResult['mismatches'] = []
  for (const [block, group] of byBlock) {
    const results = await ethCall(group.map(r => scaledCall(r.contract_address, r.holder)), blockTag(block))
    group.forEach((row, i) => {
      const chain = parseUint(results[i])
      if (chain == null || chain !== BigInt(row.scaled_balance)) {
        mismatches.push({ contract_address: row.contract_address, holder: row.holder, anchor: String(row.scaled_balance), chain: chain == null ? null : chain.toString(), anchor_block: block })
      }
    })
  }
  return { checked: rows.length, matched: rows.length - mismatches.length, mismatches }
}

// ───────────────────────── candidate holders ─────────────────────────

/**
 * The candidate holder set of one contract: the union of every source, lowercased,
 * H160-shaped, without the zero address, sorted — plus how many each source named
 * (logged, so a source that silently returns nothing is visible).
 *
 * No single source is complete on its own. EVM-log coverage before B0 is partial,
 * so a holder who received the aToken inside a gap and did nothing afterwards
 * appears in no Transfer at all; the RewardsController's Accrued/anchor rows name
 * such a holder when it was incentivized (a claim or any balance change re-emits
 * Accrued for it), the collateral sweep names it once the money market reads its
 * position, and a Substrate transfer or swap of the registry asset over the aToken
 * (GDOT over aGDOT) names it from the substrate side. Measured at block 15,047,000:
 * 79 holders (77 aGDOT, one aUSDT, one atBTC) held their whole balance since
 * before B0, were in none of the log-fed sources, and summed exactly to each
 * contract's total-minus-holders gap. A candidate costs one scaledBalanceOf, and a
 * non-holder reads 0 and yields no row, so over-including is free while
 * under-including drops a holder from the anchor until a source names it.
 */
export function unionCandidates(sources: Record<string, readonly string[]>): { holders: string[]; counts: Record<string, number> } {
  const set = new Set<string>()
  const counts: Record<string, number> = {}
  for (const [name, list] of Object.entries(sources)) {
    let n = 0
    for (const raw of list) {
      const h = raw.toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(h) || h === ZERO_H160) continue
      n++
      set.add(h)
    }
    counts[name] = n
  }
  return { holders: [...set].sort(), counts }
}
