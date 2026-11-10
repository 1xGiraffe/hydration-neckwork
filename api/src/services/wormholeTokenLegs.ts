// The token legs inside the extrinsics the NTT logs name, read incrementally.
//
// The bridge detail rebuilds about once a minute over every NTT transfer ever made
// (thousands of extrinsics, a few new per day), and each extrinsic's legs are
// raw_events rows: re-reading all of them every rebuild touched one 8k-row granule
// per extrinsic, ~14M rows and ~2.3 GiB of args_json each time. Raw ingestion
// follows the finalized head, so an indexed block's events change only when its
// range is inserted again (a replay or re-index), and every such insert raises the
// 'events' watermark of revenue_hour_watermarks (008_revenue.sql: per chain-time
// hour, the newest ingested_at of its raw_events and raw_extrinsics rows and the
// block span it covers, written by an MV inside the same insert) for each hour it
// touches. So each extrinsic's legs are kept with the watermark of its block's hour
// as read just before them, and read again only when:
//   - the extrinsic has no entry (the first read, a new transfer, or older history a
//     DATA_UPGRADES replay adds to wormhole_ntt_logs);
//   - its hour's watermark moved since (that hour was inserted again);
//   - its hour has no watermark, or the watermark is still settling (within a few
//     seconds of the server clock — it has one-second resolution, so a later insert
//     in the same second would not move it).
// An extrinsic no longer named is dropped. Nothing is served from a read that
// failed: a failing watermark or leg read throws and leaves the kept entries as
// they were.
// A leaf: no imports.

export interface TokenLegPair { blockHeight: number; extrinsicIndex: number }

/** One chain-time hour's 'events' watermark: its block span and newest ingest. */
export interface HourWatermark {
  lo: number
  hi: number
  ingest: string
  /** The watermark is old enough that a later insert into the hour must move it. */
  settled: boolean
}

export interface TokenLegRow { block_height: number; event_index: number; extrinsic_index: number | null }

export interface TokenLegSources<Row extends TokenLegRow> {
  /** Every hour's watermark whose span reaches `minHeight` or later. */
  watermarks(minHeight: number): Promise<HourWatermark[]>
  /** The legs of exactly these extrinsics, deduplicated by event identity. */
  legs(pairs: readonly TokenLegPair[]): Promise<Row[]>
}

export interface TokenLegReader<Row extends TokenLegRow> {
  /** Every leg of these extrinsics, ordered by (block_height, event_index). */
  read(pairs: readonly TokenLegPair[]): Promise<Row[]>
  /** Extrinsics read by the last call (for tests and the rollout comparison). */
  lastReadCount(): number
}

const pairKey = (blockHeight: number, extrinsicIndex: number): string => `${blockHeight}:${extrinsicIndex}`

function hourOf(spans: readonly HourWatermark[], height: number): HourWatermark | null {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const span = spans[mid]!
    if (height < span.lo) hi = mid - 1
    else if (height > span.hi) lo = mid + 1
    else return span
  }
  return null
}

export function createTokenLegReader<Row extends TokenLegRow>(sources: TokenLegSources<Row>): TokenLegReader<Row> {
  // Per extrinsic: its legs and the settled watermark they were read under (null:
  // read again next time).
  const kept = new Map<string, { mark: string | null; legs: Row[] }>()
  let readCount = 0

  return {
    lastReadCount: () => readCount,
    async read(pairs) {
      const wanted = new Map<string, TokenLegPair>()
      for (const p of pairs) wanted.set(pairKey(p.blockHeight, p.extrinsicIndex), p)
      if (!wanted.size) {
        kept.clear()
        readCount = 0
        return []
      }
      let minHeight = Infinity
      for (const p of wanted.values()) minHeight = Math.min(minHeight, p.blockHeight)
      const spans = [...await sources.watermarks(minHeight)].sort((a, b) => a.lo - b.lo)

      const got = new Map<string, Row[]>()
      const due: TokenLegPair[] = []
      const marks = new Map<string, string | null>()
      for (const [key, p] of wanted) {
        const span = hourOf(spans, p.blockHeight)
        const mark = span?.settled ? span.ingest : null
        const have = kept.get(key)
        if (have && mark != null && have.mark === mark) {
          got.set(key, have.legs)
        } else {
          due.push(p)
          marks.set(key, mark)
        }
      }

      const fresh = due.length ? await sources.legs(due) : []
      for (const p of due) got.set(pairKey(p.blockHeight, p.extrinsicIndex), [])
      for (const row of fresh) {
        if (row.extrinsic_index == null) continue
        got.get(pairKey(row.block_height, row.extrinsic_index))?.push(row)
      }
      for (const [key, mark] of marks) kept.set(key, { mark, legs: got.get(key)! })
      for (const key of [...kept.keys()]) if (!wanted.has(key)) kept.delete(key)
      readCount = due.length

      const out: Row[] = []
      for (const legs of got.values()) out.push(...legs)
      return out.sort((a, b) => a.block_height - b.block_height || a.event_index - b.event_index)
    },
  }
}
