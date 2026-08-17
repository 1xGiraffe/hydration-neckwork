import { afterEach, describe, expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import {
  addLiveHeadClient,
  liveHeadClientCount,
  poolPushDue,
  removeLiveHeadClient,
  sseHeadFrame,
  stopLiveHeadService,
} from '../src/services/liveHeadService.ts'

function fakeClient(): { res: ServerResponse; written: string[]; ended: boolean } {
  const out = { written: [] as string[], ended: false, res: null as unknown as ServerResponse }
  out.res = {
    write: (chunk: string) => { out.written.push(chunk); return true },
    end: () => { out.ended = true },
  } as unknown as ServerResponse
  return out
}

afterEach(() => stopLiveHeadService())

describe('sseHeadFrame', () => {
  it('emits a named event carrying all four watermarks as JSON', () => {
    // `head` is the raw-ingestion checkpoint (explorer feeds), `main` the
    // price indexer's newest block (preis candles / indexer status), `best`
    // the newest unfinalized block the pending layer can show, `pool` the
    // transaction-pool generation (mempool rows change between blocks).
    expect(sseHeadFrame(13487500, 13487498, 13487507, 42)).toBe('event: head\ndata: {"head":13487500,"main":13487498,"best":13487507,"pool":42}\n\n')
    expect(sseHeadFrame(13487500, 13487498)).toBe('event: head\ndata: {"head":13487500,"main":13487498,"best":0,"pool":0}\n\n')
  })
})

// A block-handoff (best-height advance) is latency-critical and always pushes.
// But the pool generation bumps on every sweep whose membership changed, which a
// mempool flood can drive at the 100ms sweep rate — and each push fans a frame out
// to EVERY connected client. So a pool-only change is rate-limited: one attacker
// churning the pool must not turn into N clients × 10 refetches/second.
describe('poolPushDue', () => {
  it('lets a pool-only push through once the minimum interval has elapsed', () => {
    // 500ms since the last push: still throttled.
    expect(poolPushDue(1_000_000, 999_500, 1_000)).toBe(false)
    // Exactly the interval, and beyond it: due.
    expect(poolPushDue(1_000_000, 999_000, 1_000)).toBe(true)
    expect(poolPushDue(1_000_000, 998_500, 1_000)).toBe(true)
    // A shorter interval clears the same gap sooner.
    expect(poolPushDue(1_000_000, 999_500, 500)).toBe(true)
  })

  it('always fires on the very first pool change', () => {
    expect(poolPushDue(1_000_000, 0, 1_000)).toBe(true)
  })
})

describe('live head client registry', () => {
  it('tracks connected clients and clears them on shutdown', () => {
    const a = fakeClient()
    const b = fakeClient()
    addLiveHeadClient(a.res)
    addLiveHeadClient(b.res)
    expect(liveHeadClientCount()).toBe(2)
    removeLiveHeadClient(a.res)
    expect(liveHeadClientCount()).toBe(1)
    stopLiveHeadService()
    expect(liveHeadClientCount()).toBe(0)
    expect(b.ended).toBe(true)
  })
})
