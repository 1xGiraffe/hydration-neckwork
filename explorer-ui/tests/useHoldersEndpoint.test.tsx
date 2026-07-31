import { afterEach, describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useHolders } from '../src/hooks/useExplorerData'
import { setSession } from '../src/session'
import { setTagMap, setTagMapError } from '../src/userTags'

// useHolders mirrors useAccounts' endpoint switch (same gates, same
// key-shape-changes-with-auth contract — see useAccountsEndpoint.test.tsx for
// the technique): the registered query key alone says which endpoint a real
// render would have called.
function Probe() {
  useHolders(0, 0, 50)
  return null
}
function registeredKey(): unknown[] | undefined {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  renderToStaticMarkup(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>)
  return queryClient.getQueryCache().getAll()[0]?.queryKey
}

const ACCOUNT_ID = '0x' + '11'.repeat(32)
const session = { token: 'e2e-token', accountId: ACCOUNT_ID, address: ACCOUNT_ID }
const taggedMap = { lists: [
  { listId: 'lib1', name: 'Personal', tags: [{ tagId: 't1', name: 'Whales', color: '#22c55e', icon: '🐳', members: [ACCOUNT_ID] }] },
  { listId: 'system', name: 'Hydration', tags: [] },
] }
const emptyMap = { lists: [
  { listId: 'lib1', name: 'Personal', tags: [] },
  { listId: 'system', name: 'Hydration', tags: [] },
] }

describe('useHolders — public vs per-viewer endpoint', () => {
  afterEach(() => { setSession(null); setTagMap(null) })

  it('logged out: the public holders key', () => {
    setSession(null)
    setTagMap(null)
    expect(registeredKey()).toEqual(['holders', 0, 0, 50])
  })

  it('a session whose tag map has not answered yet: still the public key', () => {
    setSession(session)
    setTagMap(null, true)
    expect(registeredKey()).toEqual(['holders', 0, 0, 50])
  })

  it('a tag-map fetch that failed outright: still the public key', () => {
    setSession(session)
    setTagMapError()
    expect(registeredKey()).toEqual(['holders', 0, 0, 50])
  })

  it('ready but tagless: still the public key — nothing to fold', () => {
    setSession(session)
    setTagMap(emptyMap)
    expect(registeredKey()).toEqual(['holders', 0, 0, 50])
  })

  it('ready and tagged: the per-viewer key, carrying the account id and tag-map version', () => {
    setSession(session)
    setTagMap(taggedMap)
    const key = registeredKey()
    expect(key?.slice(0, 3)).toEqual(['holders', 'viewer', ACCOUNT_ID])
    expect(key?.slice(4)).toEqual([0, 0, 50])
  })
})
