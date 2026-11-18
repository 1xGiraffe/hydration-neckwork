import { afterEach, describe, expect, it, vi } from 'vitest'
import { govApi } from '../src/api/explorer'

// The reader's accounts go in a POST body, never in the URL (access logs keep URLs
// beside the IP); only an api without the POST route gets the older GET form.

afterEach(() => { vi.unstubAllGlobals() })

describe('needs-vote request', () => {
  it('posts the accounts as JSON, with no account in the URL', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ asOfBlock: 1, referenda: [], accounts: [] }), { status: 200 })
    }))
    await govApi.needsVote(['15U8rqSKTZuNz1doFgiaiCzeRTbEpxmHGAPQi1nRc6oamXQV', '0xfe5563cd4a9528a472584ef49ed66faf4d484856'])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/explorer/governance/needs-vote')
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ accounts: ['15U8rqSKTZuNz1doFgiaiCzeRTbEpxmHGAPQi1nRc6oamXQV', '0xfe5563cd4a9528a472584ef49ed66faf4d484856'] })
  })

  it('uses the GET form only when the api has no POST route', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? 'GET'} ${url}`)
      return init?.method === 'POST' ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ asOfBlock: 1, referenda: [], accounts: [] }), { status: 200 })
    }))
    await govApi.needsVote(['a'])
    expect(urls).toEqual(['POST /api/explorer/governance/needs-vote', 'GET /api/explorer/governance/needs-vote?accounts=a'])
  })
})
