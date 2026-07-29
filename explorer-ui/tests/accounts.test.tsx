import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Accounts, HealthSimBadge } from '../src/pages/Accounts'
import { healthFactorDisplay } from '../src/components/ui'
import { defisimAccountTarget } from '../src/utils/defisim'
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

// A viewer's own tag now folds INSIDE the accounts directory's ranking query,
// exactly like a system tag (see explorerService.getAccountsForViewerFold) —
// Accounts() itself no longer folds anything client-side, so the row already
// arrives shaped like a system tag's own group row (tag.userTagId marks which
// list/tag it came from). This only has to confirm that shape renders like
// any other TagGroupPill and links to the tag's own aggregate page, next to
// an ordinary account row that isn't affected by it.
describe('Accounts directory — a viewer-tag row arrives pre-folded from the server', () => {
  const ACC3 = '0x' + '33'.repeat(32)

  function accountRow(id: string, usd: number): TopAccountRow {
    return {
      account: { accountId: id, address: id, emoji: '🦊', tag: null, identity: null, profile: null },
      tag: null, portfolioUsd: usd, lastBlock: 100, suppliedUsd: null, borrowedUsd: null,
    }
  }
  function userTagRow(usd: number): TopAccountRow {
    return {
      account: null,
      tag: { tagId: 't1', name: 'Whales', color: '#22c55e', icon: '🐳', memberCount: 2, userTagId: 't1', listId: 'lib1' },
      portfolioUsd: usd, lastBlock: 100, suppliedUsd: null, borrowedUsd: null,
    }
  }

  it('renders the folded row as a TagGroupPill linking to its own aggregate page, leaving the plain row alone', () => {
    const rows: TopAccountRow[] = [userTagRow(800_000), accountRow(ACC3, 200_000)]
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['accounts', 0, 50, 'value'], { rows, total: rows.length })
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><Accounts /></QueryClientProvider>)

    expect(html).toContain('Whales')
    expect(html).toContain('·2')
    // `userTagId` is the same real tag id TagGroupPill always links by
    // (paths.tag(tagId)) — no separate client-side routing needed for it.
    expect(hrefOf(html, 'Whales')).toBe('/tag/t1')
    // Two body rows: the folded tag row and the unrelated account — the fold
    // already happened server-side, so there is no third "member" row to drop.
    expect(html.match(/data-label="Account"/g)).toHaveLength(2)
    expect(html).toContain('$800k')
    expect(html).toContain('$200k')
  })
})
