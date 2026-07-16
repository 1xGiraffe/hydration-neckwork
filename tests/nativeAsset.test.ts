import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadNativeAssetInfo } from '../src/nativeAsset.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static latest: FakeWebSocket | null = null

  readyState = FakeWebSocket.CONNECTING
  readonly sent: string[] = []

  constructor(readonly url: string) {
    super()
    FakeWebSocket.latest = this
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  send(value: string): void {
    this.sent.push(value)
  }

  respond(payload: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }))
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  FakeWebSocket.latest = null
})

describe('loadNativeAssetInfo', () => {
  it('loads and normalizes HTTP chain properties with a request timeout', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: { tokenSymbol: [' HDX '], tokenDecimals: [12] },
      }),
    } as Response)

    await expect(loadNativeAssetInfo('https://rpc.example')).resolves.toEqual({
      assetId: 0,
      symbol: 'HDX',
      name: 'HDX',
      decimals: 12,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('rejects malformed decimal metadata instead of publishing it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: { tokenSymbol: 'HDX', tokenDecimals: 12.5 },
      }),
    } as Response)

    await expect(loadNativeAssetInfo('https://rpc.example')).resolves.toBeNull()
  })

  it('ignores unrelated WebSocket messages and accepts the matching response', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const result = loadNativeAssetInfo('wss://rpc.example')
    const socket = FakeWebSocket.latest
    expect(socket).not.toBeNull()

    socket!.open()
    socket!.respond({ jsonrpc: '2.0', id: 99, result: null })
    socket!.respond({
      jsonrpc: '2.0',
      id: 1,
      result: { tokenSymbol: 'HDX', tokenDecimals: 12 },
    })

    await expect(result).resolves.toMatchObject({ symbol: 'HDX', decimals: 12 })
  })

  it('settles when a WebSocket closes before the matching response', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let settled = false
    const result = loadNativeAssetInfo('wss://rpc.example').then(value => {
      settled = true
      return value
    })
    const socket = FakeWebSocket.latest

    socket!.open()
    socket!.respond({ jsonrpc: '2.0', id: 99, result: null })
    socket!.close()

    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 })
    await expect(result).resolves.toBeNull()
  })
})
