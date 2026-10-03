import { describe, expect, it } from 'vitest'
import { headSingleFlight } from '../src/services/headSingleFlight.ts'

// The explorer's price generation is recomposed once per price head and shared by
// concurrent requests. A request that has seen head N must not be handed the
// recompose still running for N − 1 — the SSE poller would push that older
// generation as the current one and the page would never refetch.
describe('headSingleFlight', () => {
  it('never answers a newer head with a composition started for an older one', async () => {
    const started: number[] = []
    let releaseOld!: () => void
    const compose = (head: number) => {
      started.push(head)
      if (head === 10) return new Promise<{ head: number }>(resolve => { releaseOld = () => resolve({ head }) })
      return Promise.resolve({ head })
    }
    const at = headSingleFlight(compose)
    const older = at(10)
    const newer = at(11)
    releaseOld()
    expect((await older).head).toBe(10)
    expect((await newer).head).toBe(11)
    expect(started).toEqual([10, 11])
  })

  it('shares one composition among callers at the same head', async () => {
    let n = 0
    const at = headSingleFlight(async (head: number) => { n++; await new Promise(r => setTimeout(r, 5)); return { head } })
    const [a, b] = await Promise.all([at(5), at(5)])
    expect([a.head, b.head, n]).toEqual([5, 5, 1])
  })

  it('serves a newer composition to an older head', async () => {
    let release!: () => void
    const at = headSingleFlight((head: number) => new Promise<{ head: number }>(r => { release = () => r({ head }) }))
    const newer = at(12)
    const older = at(11)
    release()
    expect([(await newer).head, (await older).head]).toEqual([12, 12])
  })
})
