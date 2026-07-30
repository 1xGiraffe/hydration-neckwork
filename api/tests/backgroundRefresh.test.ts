import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The scheduler imports the three refresh functions; stub them so the test
// exercises only the cadence/serialization logic, not the heavy service graph.
const hdx = vi.fn(async () => {})
const proxy = vi.fn(async () => {})
const erc20 = vi.fn(async () => {})
vi.mock('../src/services/hdxService.ts', () => ({ refreshHdxSnapshot: () => hdx() }))
vi.mock('../src/services/proxyMultisigService.ts', () => ({ refreshProxyMultisig: () => proxy() }))
vi.mock('../src/services/erc20WalletService.ts', () => ({ refreshErc20Wallets: () => erc20() }))

const { startBackgroundRefresh, stopBackgroundRefresh, dueTasks } = await import('../src/services/backgroundRefresh.ts')

describe('dueTasks cadence', () => {
  const tasks = [
    { name: 'a', everyTicks: 1, run: async () => {} },
    { name: 'b', everyTicks: 3, run: async () => {} },
  ]
  it('runs every-tick tasks each tick and every-3rd tasks only on multiples of 3', () => {
    expect(dueTasks(1, tasks).map(t => t.name)).toEqual(['a'])
    expect(dueTasks(2, tasks).map(t => t.name)).toEqual(['a'])
    expect(dueTasks(3, tasks).map(t => t.name)).toEqual(['a', 'b'])
    expect(dueTasks(6, tasks).map(t => t.name)).toEqual(['a', 'b'])
  })
})

describe('startBackgroundRefresh scheduling', () => {
  beforeEach(() => { vi.useFakeTimers(); hdx.mockClear(); proxy.mockClear(); erc20.mockClear() })
  afterEach(() => { stopBackgroundRefresh(); vi.useRealTimers() })

  it('runs an initial pass of all tasks once, then locks+proxy every 60s and erc20 every 180s', async () => {
    startBackgroundRefresh()
    await vi.advanceTimersByTimeAsync(0)
    // initial pass: all three once
    expect(hdx).toHaveBeenCalledTimes(1)
    expect(proxy).toHaveBeenCalledTimes(1)
    expect(erc20).toHaveBeenCalledTimes(1)

    // ticks 1 and 2 (60s, 120s): locks + proxy only
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hdx).toHaveBeenCalledTimes(3)
    expect(proxy).toHaveBeenCalledTimes(3)
    expect(erc20).toHaveBeenCalledTimes(1)

    // tick 3 (180s): erc20 joins
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hdx).toHaveBeenCalledTimes(4)
    expect(erc20).toHaveBeenCalledTimes(2)
  })

  it('serializes the batch and skips a tick while it is still running (no pile-up)', async () => {
    let release: () => void = () => {}
    hdx.mockImplementationOnce(() => new Promise<void>(r => { release = r }))
    startBackgroundRefresh()
    // initial pass entered hdx and blocks; proxy waits behind it (sequential)
    await vi.advanceTimersByTimeAsync(0)
    expect(hdx).toHaveBeenCalledTimes(1)
    expect(proxy).toHaveBeenCalledTimes(0)
    // a tick fires while the batch is still in flight → skipped, no new hdx run
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hdx).toHaveBeenCalledTimes(1)
    // unblock: the initial batch drains its remaining tasks in order
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(proxy).toHaveBeenCalledTimes(1)
    expect(erc20).toHaveBeenCalledTimes(1)
    // the next tick then resumes the normal cadence
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hdx).toHaveBeenCalledTimes(2)
  })

  it('isolates a failing task so the rest of the batch still runs', async () => {
    proxy.mockRejectedValueOnce(new Error('boom'))
    startBackgroundRefresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(hdx).toHaveBeenCalledTimes(1)
    expect(proxy).toHaveBeenCalledTimes(1)
    expect(erc20).toHaveBeenCalledTimes(1) // ran despite proxy throwing
  })
})
