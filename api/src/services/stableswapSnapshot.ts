// Shared parsing for the `stableswap` section of raw_block_snapshots.payload_json —
// the single authoritative source of current stableswap pool state (reserves,
// amplification ramp, fee, LP issuance, drifting pegs). Used by the pool pages,
// the HOLLAR dashboard and the share-NAV pricing so they can never disagree on
// how a pool entry is read.

export interface StableswapPegRational { num: bigint; den: bigint }

export interface StableswapPoolSnapshot {
  poolId: number
  assetIds: number[]
  reserves: bigint[]
  amplification: number
  initialAmplification: number
  finalAmplification: number
  initialBlock: number
  finalBlock: number
  feePermill: number
  totalIssuance: bigint
  // One rational per pool asset (same order as assetIds); null when the pool
  // has no pegs (the payload omits peg_multipliers entirely).
  pegs: StableswapPegRational[] | null
}

// Pool asset ids serialize two ways: a JSON int array, or a compact hex
// byte-string with ONE BYTE per asset id — only produced when every id in the
// pool fits a byte (ids ≤ 255).
export function parsePoolAssetIds(raw: string | number[]): number[] {
  if (Array.isArray(raw)) return raw.map(Number)
  const h = raw.startsWith('0x') ? raw.slice(2) : raw
  const out: number[] = []
  for (let i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16))
  return out
}

interface RawSnapshotPool {
  pool_id: number
  assets: string | number[]
  reserves: string[]
  amplification: string | number
  fee: number
  total_issuance: string
  initial_amplification?: number
  final_amplification?: number
  initial_block?: number
  final_block?: number
  peg_multipliers?: [string, string][]
}

// Parse the decoded `stableswap` payload section ({ pools: [...] }). Malformed
// pool entries are skipped, never guessed at.
export function parseStableswapPools(section: unknown): StableswapPoolSnapshot[] {
  const pools = (section as { pools?: RawSnapshotPool[] } | null | undefined)?.pools
  if (!Array.isArray(pools)) return []
  const out: StableswapPoolSnapshot[] = []
  for (const p of pools) {
    try {
      const assetIds = parsePoolAssetIds(p.assets)
      if (!assetIds.length || !Array.isArray(p.reserves) || p.reserves.length !== assetIds.length) continue
      const pegs = Array.isArray(p.peg_multipliers) && p.peg_multipliers.length === assetIds.length
        ? p.peg_multipliers.map(([num, den]) => ({ num: BigInt(num), den: BigInt(den) }))
        : null
      out.push({
        poolId: Number(p.pool_id),
        assetIds,
        reserves: p.reserves.map(r => BigInt(r)),
        amplification: Number(p.amplification),
        initialAmplification: Number(p.initial_amplification ?? p.amplification),
        finalAmplification: Number(p.final_amplification ?? p.amplification),
        initialBlock: Number(p.initial_block ?? 0),
        finalBlock: Number(p.final_block ?? 0),
        feePermill: Number(p.fee),
        totalIssuance: BigInt(p.total_issuance ?? '0'),
        pegs,
      })
    } catch { /* malformed pool entry — skip */ }
  }
  return out
}

// A peg rational as a display float. Peg numerators/denominators are u128-scale
// (up to ~3.4e38), far beyond Number precision, so the ratio is taken in bigint
// at 18 fractional digits before the single lossy conversion.
export function pegPrice(num: bigint, den: bigint): number {
  if (den === 0n) return 0
  return Number((num * 10n ** 18n) / den) / 1e18
}

// A peg vector is only *drifting* when some entry differs from the unit peg 1/1
// (pools created with pegs keep a constant [1,1] leg for the base asset).
export function hasDriftingPegs(pegs: StableswapPegRational[] | null): boolean {
  return pegs != null && pegs.some(p => p.num !== p.den)
}
