import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Contracts } from '../src/pages/Contracts'
import { AddrPill } from '../src/components/ui'
import type { AccountRef, ContractInfo } from '../src/types'

const HOLLAR = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const CHILD = '0x02639ec01313c8775fae74f2dad1118c8a8a86da'
const FACTORY = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'

function evmRef(h160: string, contractName?: string): AccountRef {
  return {
    accountId: '0x45544800' + h160.slice(2) + '0000000000000000',
    address: h160, emoji: '🦊', tag: null, identity: null, profile: null, isContract: true,
    ...(contractName ? { contractName } : {}),
  }
}
const DEPLOYER: AccountRef = { accountId: '0x' + 'aa'.repeat(32), address: '15deployer', emoji: '🦊', tag: null, identity: null, profile: null }

function createdRow(): ContractInfo {
  return {
    address: HOLLAR, account: evmRef(HOLLAR, 'GhoToken'), verification: null,
    creation: { method: 'create', deployer: DEPLOYER, deployerWhitelisted: true, blockHeight: 4711003, extrinsicIndex: 2, timestamp: '2024-01-01 00:00:00', txHash: '0xabc' },
    codeHash: '0x' + 'ab'.repeat(32), codeSize: 10719, destroyed: false,
    txCount: 1234, logCount: 56789, firstActivity: '2024-01-01 00:00:00', lastActivity: '2026-01-01 00:00:00',
    verified: { status: 'verified', name: 'GhoToken', matchType: 'exact_match' },
    portfolioUsd: 4870000, tradingVolumeUsd: 112000,
    sparkline: [1, 2, 3], activityCount: 40000, activityCountComplete: false,
  }
}
function factoryRow(): ContractInfo {
  return {
    address: CHILD, account: evmRef(CHILD), verified: null, verification: null,
    creation: { method: 'factory', factory: evmRef(FACTORY), attribution: 'first-log', blockHeight: 500, timestamp: '2024-02-01 00:00:00', txHash: '0xdef' },
    codeHash: '0x' + 'cd'.repeat(32), codeSize: 13783, destroyed: true,
    txCount: 7, logCount: 3, firstActivity: '2024-02-01 00:00:00', lastActivity: '2024-03-01 00:00:00',
  }
}

// The directory renders straight from the registry rows: evidence-labelled
// creation ("first seen", never "created", for factory attribution), destroyed
// contracts greyed but present, and the same sort affordances as Accounts
// (th-sort headers on desktop, a native select on phones).
describe('Contracts directory', () => {
  function render(rows: ContractInfo[]) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['contracts', 0, 50, 'created'], { contracts: rows, total: rows.length })
    return renderToStaticMarkup(<QueryClientProvider client={queryClient}><Contracts /></QueryClientProvider>)
  }

  it('renders registry rows with creation evidence and compact counts', () => {
    const html = render([createdRow(), factoryRow()])
    expect(html.match(/data-label="Contract"/g)).toHaveLength(2)
    // Factory attribution is labelled "first seen", never presented as a creation.
    expect(html).toContain('first seen')
    // The deployer pill for the top-level create.
    expect(html).toContain('15deployer')
    // Compact rough-scale counts, never hand-rolled digits.
    expect(html).toContain('1.23k')
    expect(html).toContain('56.8k')
    // The destroyed contract stays listed, flagged.
    expect(html).toContain('destroyed')
  })

  it('offers the sortable columns on desktop and the same sorts as a mobile select', () => {
    const html = render([createdRow()])
    for (const label of ['Contract', 'Created', 'Txs', 'Logs', 'Last active', 'Value', 'Trading $', 'Activity']) expect(html).toContain(label)
    expect(html).toContain('th-sort')
    expect(html).toContain('mobile-sort')
    // One option per sort the API accepts — the select is the phone's only way in.
    expect(html.match(/<option /g)!.length).toBe(8)
  })

  // A contract is an account: the directory shows what it holds on the same
  // models /accounts does, and shows nothing where nothing was established.
  it('renders the account-shaped columns, and dashes where a metric is absent', () => {
    const html = render([createdRow()])
    expect(html).toContain('$4.87M')          // value, shared rough scale
    expect(html).toContain('$112k')           // trading volume
    expect(html).toContain('40k</span>+')     // activity floor (partial total)
    expect(html).toContain('spark')           // 1Y sparkline
    // Verification is one check, not a chip — the match kind is in its title.
    expect(html).toContain('ok-check')
    expect(html).toContain('metadata hash matched exactly')
    expect(html).not.toContain('✓ exact')
    // The name comes from the PILL (AccountRef.contractName), not a span beside
    // it, so it reads identically here and on every other surface: once as the
    // label, once in the pill's title, and with the address tail that says which
    // same-named contract this is.
    expect(html).toContain('<span class="tag">GhoToken</span>')
    expect(html).toContain('·99a')
    expect(html).not.toMatch(/<span class="muted"[^>]*>GhoToken/)

    // The factory row has no metrics at all: every one of those cells is a dash
    // marked droppable for the phone card, never a zero.
    const bare = render([factoryRow()])
    expect(bare).not.toContain('ok-check')
    expect(bare.match(/cell-empty/g)!.length).toBeGreaterThanOrEqual(5)
  })

  it('shows an empty state when the registry has no contracts', () => {
    const html = render([])
    expect(html).toContain('No contracts')
  })
})

// The pill glyph is the list-surface marker: it must survive every label
// branch (bare address, identity, tag pill), stay non-interactive, and never
// appear on non-contract accounts.
describe('AddrPill contract glyph', () => {
  it('marks contract accounts in the bare-address branch', () => {
    const html = renderToStaticMarkup(<AddrPill account={evmRef(HOLLAR)} />)
    expect(html).toContain('contract-glyph')
    expect(html).toContain('Smart contract')
    expect(html).toContain('&lt;/&gt;')
  })

  it('survives the tag-pill branch', () => {
    const tagged: AccountRef = { ...evmRef(HOLLAR), tag: { id: 'money-market', name: 'Lend & Borrow', color: '#6aa5f8', icon: '🏦', memberCount: 57 } }
    const html = renderToStaticMarkup(<AddrPill account={tagged} />)
    expect(html).toContain('contract-glyph')
  })

  it('never marks non-contract accounts', () => {
    const html = renderToStaticMarkup(<AddrPill account={DEPLOYER} />)
    expect(html).not.toContain('contract-glyph')
  })
})

// A verified contract's name is the pill's label, so it reads the same on the
// directory, in a feed row and on a detail page — with the address tail, because
// contract names are not unique (sixteen ERC1967Proxy addresses on this chain).
describe('AddrPill contract name', () => {
  it('labels a verified contract by name plus the address tail, never a ✓', () => {
    const html = renderToStaticMarkup(<AddrPill account={evmRef(HOLLAR, 'GhoToken')} />)
    expect(html).toContain('>GhoToken<')
    expect(html).toContain('·99a')                 // HOLLAR's last three characters
    expect(html).not.toContain('id-verified')      // registrar identities only
    expect(html).toContain('contract-glyph')
    expect(html).toContain('title="GhoToken — 0x531a654d1696ed52e7275a8cede955e82620f99a"')
  })

  it('keeps the bare address when the contract has no verified name', () => {
    const html = renderToStaticMarkup(<AddrPill account={evmRef(HOLLAR)} />)
    expect(html).not.toContain('·99a')
    expect(html).toContain('0x531a')
  })

  // Curation and the actor's own name are more specific than the code's name.
  it('yields to a tag and to an on-chain identity', () => {
    const tagged: AccountRef = { ...evmRef(HOLLAR, 'GhoToken'), tag: { id: 'money-market', name: 'Lend & Borrow', color: '#6aa5f8', icon: '🏦', memberCount: 57 } }
    expect(renderToStaticMarkup(<AddrPill account={tagged} />)).not.toContain('GhoToken')
    const named: AccountRef = { ...evmRef(HOLLAR, 'GhoToken'), identity: { display: 'Real Identity', verified: true, email: '', web: '', twitter: '' } }
    const html = renderToStaticMarkup(<AddrPill account={named} />)
    expect(html).toContain('Real Identity')
    expect(html).not.toContain('GhoToken')
  })
})
