import { afterEach, describe, expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import {
  addLiveHeadClient,
  liveHeadClientCount,
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
  it('emits a named event carrying all three watermarks as JSON', () => {
    // `head` is the raw-ingestion checkpoint (explorer feeds), `main` the
    // price indexer's newest block (preis candles / indexer status), `best`
    // the newest unfinalized block the pending layer can show.
    expect(sseHeadFrame(13487500, 13487498, 13487507)).toBe('event: head\ndata: {"head":13487500,"main":13487498,"best":13487507}\n\n')
    expect(sseHeadFrame(13487500, 13487498)).toBe('event: head\ndata: {"head":13487500,"main":13487498,"best":0}\n\n')
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
