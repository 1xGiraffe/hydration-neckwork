import { describe, expect, it } from 'vitest'
import { KuboClient } from '../../src/governance/subsquare/kubo.js'

// The forum IPFS node's RPC requires a bearer token per client once ops/ipfs-init.sh
// sets API.Authorizations; the sync's client sends IPFS_TOKEN_SYNC on every call.

function recorder(body = '{"RepoSize":1,"StorageMax":2}') {
  const calls: Array<{ url: string; auth: string | null }> = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
    return new Response(body, { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('KuboClient authorization', () => {
  it('sends its bearer token on every RPC call', async () => {
    const { calls, fetchImpl } = recorder()
    const kubo = new KuboClient('http://ipfs:5001/', fetchImpl, 'tok-sync')
    await kubo.repoStat()
    await kubo.pinRm('bafkreicudippknz34poet7cuf7m2mulxwzsk5qa4rwdar6m6n3evk56yye')
    expect(calls.map(c => c.auth)).toEqual(['Bearer tok-sync', 'Bearer tok-sync'])
    expect(calls[0].url).toBe('http://ipfs:5001/api/v0/repo/stat?size-only=true')
  })

  it('sends no Authorization header without a token (a node with no authorizations)', async () => {
    const { calls, fetchImpl } = recorder()
    await new KuboClient('http://ipfs:5001', fetchImpl).repoStat()
    expect(calls[0].auth).toBeNull()
  })
})
