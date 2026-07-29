import { describe, it, expect, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Accounts, HealthSimBadge } from '../src/pages/Accounts'
import { healthFactorDisplay } from '../src/components/ui'
import { defisimAccountTarget } from '../src/utils/defisim'
import { setTagMap } from '../src/userTags'
import type { TopAccountRow } from '../src/types'

// Finds the single anchor wrapping `text`, same helper render-user.test.tsx
// uses for the same reason (a pill's icon + name share one <a>, so the href
// never sits right next to the visible text) — duplicated rather than
// imported since neither file exports it as shared test infrastructure.
function hrefOf(html: string, text: string): string | undefined {
  const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
  return anchors.find(m => m[2].includes(text))?.[1]
}

describe('HealthSimBadge — two-sided health factor / DefiSim link', () => {
  it('renders the factor and the DefiSim side inside one link', () => {
    const html = renderToStaticMarkup(<HealthSimBadge hf={healthFactorDisplay('1410000000000000000')} addr="0xabc" />)
    expect(html).toContain('hf-badge')
    expect(html).toContain('1.41')
    expect(html).toContain('hf-warn')
    expect(html).toContain('DefiSim')
    expect(html).toContain('https://defisim.neckwork.net/?address=0xabc')
    expect(html.match(/<a /g)).toHaveLength(1)
  })
  it('renders a pure supplier as "No debt" with the link intact', () => {
    const html = renderToStaticMarkup(<HealthSimBadge hf={healthFactorDisplay('inf')} addr="0xdef" />)
    expect(html).toContain('No debt')
    expect(html).toContain('DefiSim')
  })
})

describe('DefiSim account target', () => {
  it('uses H160 for EVM accounts and AccountId32 for substrate accounts', () => {
    expect(defisimAccountTarget({
      accountId: '0x4554480076a497415fc75a15a2014b49e2d53bf748c30a8f0000000000000000',
      address: '0x76a497415fc75a15a2014b49e2d53bf748c30a8f',
    })).toBe('0x76a497415fc75a15a2014b49e2d53bf748c30a8f')
    expect(defisimAccountTarget({ accountId: '0x1234', address: '16abc' })).toBe('0x1234')
  })
})

// Client-side folding of the viewer's OWN tags in the /accounts directory —
// system tags fold server-side already (one SQL-computed group row, see
// TopAccountRow.tag); a user tag has no such row, so Accounts() has to spot
// its matching page rows itself (via userTags.resolveTag) and collapse them.
describe('Accounts directory — folding the viewer\'s own user-tag rows', () => {
  const ACC1 = '0x' + '11'.repeat(32)
  const ACC2 = '0x' + '22'.repeat(32)
  const ACC3 = '0x' + '33'.repeat(32)

  function accountRow(id: string, usd: number): TopAccountRow {
    return {
      account: { accountId: id, address: id, emoji: '🦊', tag: null, identity: null, profile: null },
      tag: null, portfolioUsd: usd, lastBlock: 100, suppliedUsd: null, borrowedUsd: null,
    }
  }
  // ACC1 (highest rank) and ACC2 both carry the viewer's "Whales" tag; ACC3 is
  // unrelated to any user tag. Server rank order is preserved (ACC1 first),
  // matching the directory's own value-desc default sort.
  const rows: TopAccountRow[] = [accountRow(ACC1, 500_000), accountRow(ACC2, 300_000), accountRow(ACC3, 200_000)]

  function renderAccounts(): string {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['accounts', 0, 50, 'value'], { rows, total: rows.length })
    return renderToStaticMarkup(<QueryClientProvider client={queryClient}><Accounts /></QueryClientProvider>)
  }

  beforeEach(() => setTagMap(null))

  it('folds the two member rows into one aggregated row and leaves the unrelated row alone', () => {
    setTagMap({ lists: [
      { listId: 'lib1', name: 'Personal', tags: [{ tagId: 't1', name: 'Whales', color: '#22c55e', icon: '🐳', members: [ACC1, ACC2] }] },
      { listId: 'system', name: 'Hydration', tags: [] },
    ] })
    const html = renderAccounts()

    expect(html).toContain('Whales')
    expect(html).toContain('·2')
    // The tag's own aggregate page, exactly like a system tag's TagGroupPill.
    expect(hrefOf(html, 'Whales')).toBe('/tag/t1')

    // Two body rows left: the fold and the unrelated account — not three.
    expect(html.match(/data-label="Account"/g)).toHaveLength(2)
    // Each member's own value is gone; only the unrelated row's is still there.
    expect(html).not.toContain('$500k')
    expect(html).not.toContain('$300k')
    expect(html).toContain('$200k')
  })

  it('renders the original, unfolded rows when logged out', () => {
    // Default beforeEach: setTagMap(null) — tagMapStatus() === 'anonymous'.
    const html = renderAccounts()

    expect(html).not.toContain('Whales')
    expect(html.match(/data-label="Account"/g)).toHaveLength(3)
    expect(html).toContain('$500k')
    expect(html).toContain('$300k')
    expect(html).toContain('$200k')
  })
})
