import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClickHouseClient } from '../db/client.ts'
import { parsePollSeconds, runCycle, type DerivationJob } from './runner.ts'

// A fake client only needs `close()` — the fake jobs below never touch the
// client argument, so no other ClickHouseClient method is exercised.
function makeFakeClient() {
  const close = vi.fn(async () => {})
  const asClient = { close } as unknown as ClickHouseClient
  return { close, asClient }
}

describe('runCycle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('isolates job failures: one job throwing does not stop the others from running', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const runB = vi.fn(async () => ({ model: 'b', rows: 5 }))
    const runC = vi.fn(async () => ({ model: 'c', rows: 7 }))
    const jobs: DerivationJob[] = [
      { model: 'a', run: vi.fn(async () => { throw new Error('boom') }) },
      { model: 'b', run: runB },
      { model: 'c', run: runC },
    ]
    const { asClient } = makeFakeClient()

    await runCycle({ jobs, loadAssets: vi.fn(async () => {}), makeClient: () => asClient })

    expect(runB).toHaveBeenCalledTimes(1)
    expect(runC).toHaveBeenCalledTimes(1)
  })

  it('closes the client after the cycle, even when a job throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const jobs: DerivationJob[] = [
      { model: 'a', run: vi.fn(async () => { throw new Error('boom') }) },
    ]
    const { close, asClient } = makeFakeClient()

    await runCycle({ jobs, loadAssets: vi.fn(async () => {}), makeClient: () => asClient })

    expect(close).toHaveBeenCalledTimes(1)
  })

  it('still closes the client when the asset-registry load itself throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const run = vi.fn(async () => ({ model: 'a', rows: 1 }))
    const jobs: DerivationJob[] = [{ model: 'a', run }]
    const { close, asClient } = makeFakeClient()

    await runCycle({
      jobs,
      loadAssets: vi.fn(async () => { throw new Error('registry down') }),
      makeClient: () => asClient,
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('skips needsAssets jobs when the registry load fails, but runs the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    // A registry-dependent job must not run against a failed/stale registry —
    // it would bake wrong valuations into partitions nothing re-marks stale.
    const runAtv = vi.fn(async () => ({ model: 'atv', rows: 1 }))
    const runOther = vi.fn(async () => ({ model: 'other', rows: 2 }))
    const jobs: DerivationJob[] = [
      { model: 'atv', run: runAtv, needsAssets: true },
      { model: 'other', run: runOther },
    ]
    const { asClient } = makeFakeClient()

    await runCycle({
      jobs,
      loadAssets: vi.fn(async () => { throw new Error('registry down') }),
      makeClient: () => asClient,
    })

    expect(runAtv).not.toHaveBeenCalled()
    expect(runOther).toHaveBeenCalledTimes(1)
    const summary = log.mock.calls.map(c => String(c[0])).find(l => l.includes('cycle complete'))
    expect(summary).toContain('atv=SKIPPED')
    expect(summary).toContain('other=2')
  })

  it('runs needsAssets jobs normally when the registry load succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const runAtv = vi.fn(async () => ({ model: 'atv', rows: 3 }))
    const jobs: DerivationJob[] = [{ model: 'atv', run: runAtv, needsAssets: true }]
    const { asClient } = makeFakeClient()

    await runCycle({ jobs, loadAssets: vi.fn(async () => {}), makeClient: () => asClient })

    expect(runAtv).toHaveBeenCalledTimes(1)
  })
})

describe('parsePollSeconds', () => {
  it('falls back to 600 for unset, empty, or malformed values', () => {
    expect(parsePollSeconds(undefined)).toBe(600)
    expect(parsePollSeconds('')).toBe(600)
    expect(parsePollSeconds('   ')).toBe(600)
    expect(parsePollSeconds('not-a-number')).toBe(600)
    expect(parsePollSeconds('NaN')).toBe(600)
    expect(parsePollSeconds('Infinity')).toBe(600)
    expect(parsePollSeconds('-5')).toBe(600)
    expect(parsePollSeconds('0')).toBe(600)
  })

  it('uses the parsed value for well-formed positive input', () => {
    expect(parsePollSeconds('120')).toBe(120)
    expect(parsePollSeconds('  45 ')).toBe(45)
  })
})
