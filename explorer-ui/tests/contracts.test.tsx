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

function evmRef(h160: string): AccountRef {
  return {
    accountId: '0x45544800' + h160.slice(2) + '0000000000000000',
    address: h160, emoji: '🦊', tag: null, identity: null, profile: null, isContract: true,
  }
}
const DEPLOYER: AccountRef = { accountId: '0x' + 'aa'.repeat(32), address: '15deployer', emoji: '🦊', tag: null, identity: null, profile: null }

function createdRow(): ContractInfo {
  return {
    address: HOLLAR, account: evmRef(HOLLAR), verified: null, verification: null,
    creation: { method: 'create', deployer: DEPLOYER, deployerWhitelisted: true, blockHeight: 4711003, extrinsicIndex: 2, timestamp: '2024-01-01 00:00:00', txHash: '0xabc' },
    codeHash: '0x' + 'ab'.repeat(32), codeSize: 10719, destroyed: false,
    txCount: 1234, logCount: 56789, firstActivity: '2024-01-01 00:00:00', lastActivity: '2026-01-01 00:00:00',
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
    for (const label of ['Created', 'Txs', 'Logs', 'Last active']) expect(html).toContain(label)
    expect(html).toContain('th-sort')
    expect(html).toContain('mobile-sort')
    expect(html.match(/<option /g)!.length).toBe(4)
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
    const tagged: AccountRef = { ...evmRef(HOLLAR), tag: { id: 'contracts', name: 'Contract', color: '#6a7187', icon: '📜', memberCount: 377 } }
    const html = renderToStaticMarkup(<AddrPill account={tagged} />)
    expect(html).toContain('contract-glyph')
  })

  it('never marks non-contract accounts', () => {
    const html = renderToStaticMarkup(<AddrPill account={DEPLOYER} />)
    expect(html).not.toContain('contract-glyph')
  })
})
