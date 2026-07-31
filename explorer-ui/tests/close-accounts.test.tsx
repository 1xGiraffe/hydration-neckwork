import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CloseAccountsSection } from '../src/components/CloseAccountsSection'
import { closeAccountReasonText } from '../src/utils/closeAccounts'
import type { CloseAccountsResponse } from '../src/types'

const address = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'
const candidate = {
  accountId: '0x45544800f73a2b8c1d4e9a06b5c8f2e1a3d70c9b4e6f18ad000000000000000',
  address: '0xF73a2B8c1D4e9A06b5C8f2E1a3D70c9B4e6F18aD',
  emoji: '🦑',
  tag: { id: 'kraken', name: 'Kraken', color: '#7b6cf6', icon: '/tag-icons/kraken.jpg' },
}

afterEach(() => vi.unstubAllGlobals())

describe('close-account reason copy', () => {
  it('states concrete evidence without claiming common ownership', () => {
    expect(closeAccountReasonText({ type: 'direct_transfers', count: 7, days: 4, valueUsd: 128_400, bidirectional: true }))
      .toBe('7 direct transfers · $128k across 4 days · both directions')
    expect(closeAccountReasonText({ type: 'direct_transfers', count: 3, days: 3, valueUsd: null, bidirectional: false }))
      .toBe('3 direct transfers across 3 days')
    expect(closeAccountReasonText({ type: 'near_signing', days: 1 })).toBe('Signed near each other on 1 distinct day')
    expect(closeAccountReasonText({ type: 'shared_cex', name: 'Kraken' })).toBe('Shared Kraken deposit address')
  })
})

describe('CloseAccountsSection', () => {
  it('is closed and performs no request before the disclosure opens', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><CloseAccountsSection address={address} /></QueryClientProvider>)

    expect(html).toContain('<details class="close-accounts"')
    expect(html).not.toContain('<details open=""')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renders specific account links, qualitative confidence, reasons, and disclaimer', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const response: CloseAccountsResponse = {
      accounts: [{
        account: candidate,
        score: 0.91,
        confidence: 'strong',
        lastSeen: '2026-07-09 18:42:00',
        reasons: [{ type: 'shared_cex', name: 'Kraken' }],
      }],
      lookbackDays: null,
      disclaimer: 'Behavioral signals are not proof of common ownership.',
    }
    queryClient.setQueryData(['close-accounts', address], response)
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><CloseAccountsSection address={address} /></QueryClientProvider>)

    // Named like anywhere else — the tag/identity, not a bare address — while the link
    // still opens the specific account this list exists to point at, never its group.
    // Matched on the tag pill itself: the reason copy below also says "Kraken", so a
    // bare substring would pass with the label still missing.
    expect(html).toMatch(/class="tag"[^>]*>Kraken</)
    expect(html).toContain('/account/0xF73a2B8c1D4e9A06b5C8f2E1a3D70c9B4e6F18aD')
    expect(html).not.toContain('/tag/kraken')
    expect(html).toContain('strong signal')
    expect(html).toContain('Shared Kraken deposit address')
    expect(html).toContain('Behavioral signals are not proof of common ownership.')
  })

  // The server only excludes SYSTEM-tagged accounts from being matches, so what
  // actually reaches this list is on-chain identities, self-set profile names, and the
  // viewer's own private tags. All three are names a reader knows the account by, and
  // all three were reduced to a short address here.
  it('names a match by its on-chain identity rather than its address', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const identified = {
      accountId: '0x1111111111111111111111111111111111111111111111111111111111111111',
      address: '13b6…p3hMN',
      emoji: '🌻',
      tag: null,
      identity: { display: 'Acala Foundation', verified: true },
    }
    queryClient.setQueryData(['close-accounts', address], {
      accounts: [{ account: identified, score: 0.7, confidence: 'moderate', lastSeen: '2026-07-09 18:42:00', reasons: [{ type: 'near_signing', days: 2 }] }],
      lookbackDays: 90,
      disclaimer: 'Behavioral signals are not proof of common ownership.',
    } satisfies CloseAccountsResponse)
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><CloseAccountsSection address={address} /></QueryClientProvider>)

    expect(html).toContain('Acala Foundation')
    // The registrar tick is the identity pill's, and belongs only to a judged identity.
    expect(html).toContain('id-verified')
  })
})
