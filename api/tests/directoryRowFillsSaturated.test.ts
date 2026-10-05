import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createBackgroundLane, deferRowFill } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// A cold /accounts page defers its rows' sparklines and exact top assets to a
// bounded background lane. When that lane's queue is full, a refused fill used to
// be dropped: a build whose every fill was refused deferred nothing, so it read as
// complete and was persisted with the approximations in place of the real values.
describe('a saturated directory fill lane', () => {
  it('keeps a refused fill deferred until the queue drains, so the page stays partial', async () => {
    const lane = createBackgroundLane(1, 1)
    const gates: (() => void)[] = []
    const slow = () => new Promise<void>(resolve => { gates.push(resolve) })

    const deferred: Promise<void>[] = []
    deferRowFill(lane, deferred, 'a', slow)   // runs
    deferRowFill(lane, deferred, 'b', slow)   // queued (queue now full)
    deferRowFill(lane, deferred, 'c', slow)   // refused: queue full
    deferRowFill(lane, deferred, 'd', slow)   // refused
    // Every offer is tracked — none is silently dropped — so the build is partial.
    expect(deferred).toHaveLength(4)
    expect(lane.stats()).toEqual({ running: 1, queued: 1 })

    let settled = false
    void Promise.allSettled(deferred).then(() => { settled = true })
    await new Promise(r => setTimeout(r, 0))
    expect(settled).toBe(false)

    gates.shift()!()          // 'a' finishes, 'b' leaves the queue: drained
    await new Promise(r => setTimeout(r, 0))
    expect(lane.stats()).toEqual({ running: 1, queued: 0 })
    gates.shift()!()          // 'b' finishes
    await new Promise(r => setTimeout(r, 0))
    expect(settled).toBe(true)
  })

  it('resolves drained() at once when nothing is queued', async () => {
    const lane = createBackgroundLane(2, 4)
    await expect(lane.drained()).resolves.toBeUndefined()
  })

  it('persists a page only when nothing was deferred', () => {
    const at = explorerService.indexOf('async function accountsPage(')
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))
    const partial = body.indexOf('if (deferred?.length) {')
    const persist = body.indexOf('await persistAccountDirectorySnapshot(snapshotKey, page)')
    expect(partial).toBeGreaterThan(-1)
    expect(persist).toBeGreaterThan(partial)
    expect(body.slice(partial, persist)).toContain('return page')
    // Both deferral sites go through deferRowFill; nothing offers to the lane directly.
    expect(explorerService.match(/directoryRowFills\.offer\(/g)).toBeNull()
    expect(explorerService.match(/deferRowFill\(directoryRowFills, deferred,/g)).toHaveLength(2)
  })
})
