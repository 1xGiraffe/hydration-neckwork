import { describe, expect, it } from 'vitest'
import { createTokenLegReader, type HourWatermark, type TokenLegPair } from '../src/services/wormholeTokenLegs.ts'

// The incremental reader must answer exactly what one full read of the same
// extrinsics answers, on every cycle, whatever was kept from earlier cycles.

interface Row { block_height: number; event_index: number; extrinsic_index: number | null; amount: string }

// A fake raw_events: the legs per extrinsic, and per hour of 100 blocks its
// watermark. `insertAgain` is a replay of an hour that changes a leg.
function world() {
  const rows: Row[] = []
  const ingest = new Map<number, number>()
  let now = 1_000
  const hour = (height: number) => Math.floor(height / 100)
  const touch = (height: number) => ingest.set(hour(height), now)
  const reads: TokenLegPair[][] = []
  const full = (pairs: readonly TokenLegPair[]): Row[] => {
    const keys = new Set(pairs.map(p => `${p.blockHeight}:${p.extrinsicIndex}`))
    return rows
      .filter(r => keys.has(`${r.block_height}:${r.extrinsic_index}`))
      .sort((a, b) => a.block_height - b.block_height || a.event_index - b.event_index)
      .map(r => ({ ...r }))
  }
  const reader = createTokenLegReader<Row>({
    watermarks: async (minHeight: number): Promise<HourWatermark[]> =>
      [...ingest].filter(([h]) => (h + 1) * 100 - 1 >= minHeight)
        .map(([h, at]) => ({ lo: h * 100, hi: h * 100 + 99, ingest: String(at), settled: at < now - 2 })),
    legs: async pairs => { reads.push([...pairs]); return full(pairs) },
  })
  return {
    reader, reads, full,
    tick: (seconds = 60) => { now += seconds },
    add(height: number, extrinsic: number, eventIndex: number, amount: string) {
      rows.push({ block_height: height, event_index: eventIndex, extrinsic_index: extrinsic, amount })
      touch(height)
    },
    insertAgain(height: number, eventIndex: number, amount: string) {
      const row = rows.find(r => r.block_height === height && r.event_index === eventIndex)!
      row.amount = amount
      touch(height)
    },
    forgetHour(height: number) { ingest.delete(hour(height)) },
  }
}

const p = (blockHeight: number, extrinsicIndex: number): TokenLegPair => ({ blockHeight, extrinsicIndex })

describe('incremental NTT token legs', () => {
  it('reads everything once, then only what is new, and always equals a full read', async () => {
    const w = world()
    w.add(150, 2, 5, '10')
    w.add(150, 2, 7, '11')
    w.add(320, 1, 3, '20')
    w.add(320, 4, 9, '21') // a non-NTT extrinsic in the same block: never asked for
    w.tick()
    const pairs = [p(150, 2), p(320, 1)]

    expect(await w.reader.read(pairs)).toEqual(w.full(pairs))
    expect(w.reader.lastReadCount()).toBe(2)

    w.tick()
    expect(await w.reader.read(pairs)).toEqual(w.full(pairs))
    expect(w.reader.lastReadCount()).toBe(0)

    // A new transfer: only it is read.
    w.add(480, 3, 2, '30')
    w.tick()
    const more = [...pairs, p(480, 3)]
    expect(await w.reader.read(more)).toEqual(w.full(more))
    expect(w.reader.lastReadCount()).toBe(1)
    expect(w.reads.at(-1)).toEqual([p(480, 3)])
  })

  it('reads an extrinsic again while its hour is still settling', async () => {
    const w = world()
    w.add(150, 2, 5, '10')
    const pairs = [p(150, 2)]
    await w.reader.read(pairs) // watermark written this second: not settled
    expect(w.reader.lastReadCount()).toBe(1)
    w.tick()
    expect(await w.reader.read(pairs)).toEqual(w.full(pairs))
    expect(w.reader.lastReadCount()).toBe(1)
    w.tick()
    await w.reader.read(pairs)
    expect(w.reader.lastReadCount()).toBe(0)
  })

  it('re-reads every extrinsic of an hour inserted again below what it has read', async () => {
    const w = world()
    w.add(150, 2, 5, '10')
    w.add(160, 1, 1, '12')
    w.add(320, 1, 3, '20')
    w.tick()
    const pairs = [p(150, 2), p(160, 1), p(320, 1)]
    await w.reader.read(pairs)

    w.insertAgain(150, 5, '99')
    w.tick()
    const after = await w.reader.read(pairs)
    expect(after).toEqual(w.full(pairs))
    expect(after.find(r => r.block_height === 150)?.amount).toBe('99')
    expect(w.reads.at(-1)).toEqual([p(150, 2), p(160, 1)])
  })

  it('reads old history first named late, and every cycle an hour with no watermark', async () => {
    const w = world()
    w.add(320, 1, 3, '20')
    w.tick()
    await w.reader.read([p(320, 1)])

    // A DATA_UPGRADES replay names an older extrinsic in wormhole_ntt_logs.
    w.add(50, 1, 4, '5')
    w.tick()
    const pairs = [p(50, 1), p(320, 1)]
    expect(await w.reader.read(pairs)).toEqual(w.full(pairs))
    expect(w.reads.at(-1)).toEqual([p(50, 1)])

    w.forgetHour(50)
    w.tick()
    expect(await w.reader.read(pairs)).toEqual(w.full(pairs))
    expect(w.reads.at(-1)).toEqual([p(50, 1)])
    w.tick()
    await w.reader.read(pairs)
    expect(w.reads.at(-1)).toEqual([p(50, 1)])
  })

  it('drops extrinsics no longer named and keeps an extrinsic with no legs', async () => {
    const w = world()
    w.add(150, 2, 5, '10')
    w.add(320, 1, 3, '20')
    w.tick()
    await w.reader.read([p(150, 2), p(320, 1), p(320, 6)])
    w.tick()
    expect(await w.reader.read([p(320, 1), p(320, 6)])).toEqual(w.full([p(320, 1)]))
    expect(w.reader.lastReadCount()).toBe(0)
    w.tick()
    // Dropped, so named again it is read again.
    await w.reader.read([p(150, 2), p(320, 1)])
    expect(w.reads.at(-1)).toEqual([p(150, 2)])
    expect(await w.reader.read([])).toEqual([])
  })

  it('throws on a failed read and keeps nothing from it', async () => {
    let fail = false
    let legReads = 0
    const reader = createTokenLegReader<Row>({
      watermarks: async () => [{ lo: 0, hi: 999, ingest: '1', settled: true }],
      legs: async () => {
        legReads += 1
        if (fail) throw new Error('clickhouse down')
        return [{ block_height: 10, event_index: 1, extrinsic_index: 1, amount: '1' }]
      },
    })
    fail = true
    await expect(reader.read([p(10, 1)])).rejects.toThrow('clickhouse down')
    fail = false
    expect(await reader.read([p(10, 1)])).toEqual([{ block_height: 10, event_index: 1, extrinsic_index: 1, amount: '1' }])
    expect(legReads).toBe(2)

    const broken = createTokenLegReader<Row>({
      watermarks: async () => { throw new Error('watermarks down') },
      legs: async () => [],
    })
    await expect(broken.read([p(10, 1)])).rejects.toThrow('watermarks down')
  })
})
