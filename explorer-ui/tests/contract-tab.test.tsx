import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ContractTab, ContractCodeView, ContractReadView } from '../src/components/ContractTab'
import { validateStandardJson, validateContractIdentifier } from '../src/verifyForm'
import { ContractSection, profileTabs } from '../src/components/AccountSections'
import type { ContractInfo } from '../src/types'

const ADDR = '0x531a654d1696ed52e7275a8cede955e82620f99a'

function contractInfo(over: Partial<ContractInfo> = {}): ContractInfo {
  return {
    address: ADDR,
    account: { accountId: '0x45544800' + ADDR.slice(2) + '0000000000000000', address: ADDR, emoji: '🦊', tag: null, isContract: true },
    verified: null,
    verification: { status: 'unverified' },
    creation: { method: 'unknown' },
    codeHash: '0x' + 'ab'.repeat(32),
    codeSize: 10719,
    destroyed: false,
    txCount: 12,
    logCount: 34,
    firstActivity: '2024-01-01 00:00:00',
    lastActivity: '2026-01-01 00:00:00',
    ...over,
  }
}

const verifiedInfo = contractInfo({
  verified: { status: 'verified', name: 'GhoToken', matchType: 'exact_match' },
  verification: {
    status: 'verified', name: 'GhoToken', compilerVersion: 'v0.8.10+commit.fc410830',
    matchType: 'exact_match', source: 'verified', verifiedAt: '2026-08-04 10:00:00',
    abiPresent: true, sourceFileCount: 2, supersededBytecode: false,
  },
})

const abiPayload = {
  address: ADDR,
  abi: [
    { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
    { type: 'function', name: 'symbol', stateMutability: 'pure', inputs: [], outputs: [{ name: '', type: 'string' }] },
    { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  ],
  source: 'verified',
  contractName: 'GhoToken',
}

const sourcesPayload = {
  address: ADDR,
  files: [
    { path: 'src/GhoToken.sol', content: 'contract GhoToken { uint256 supply; }' },
    { path: 'src/lib/Math.sol', content: 'library Math {}' },
  ],
  compiler: { version: 'v0.8.10+commit.fc410830', evmVersion: 'london', optimizerEnabled: true, optimizerRuns: 200, constructorArguments: '0xabcd', settings: null },
}

function render(node: React.ReactNode, seed?: (qc: QueryClient) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  seed?.(queryClient)
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

function seedVerified(qc: QueryClient) {
  qc.setQueryData(['contract-abi', ADDR], abiPayload)
  qc.setQueryData(['contract-sources', ADDR], sourcesPayload)
  qc.setQueryData(['contract-bytecode', ADDR], '0x6080604052deadbeef')
}

describe('ContractCodeView (verified)', () => {
  const html = () => render(<ContractCodeView address={ADDR} contract={verifiedInfo} />, seedVerified)

  it('renders the verification info card', () => {
    const out = html()
    expect(out).toContain('GhoToken')
    expect(out).toContain('v0.8.10+commit.fc410830')
    expect(out).toMatch(/exact match/i)
    expect(out).toContain('london')
    expect(out).toContain('200')            // optimizer runs
    expect(out).toContain('0xabcd')          // constructor args
  })

  it('lists the source files and shows the selected file content', () => {
    const out = html()
    expect(out).toContain('src/GhoToken.sol')
    expect(out).toContain('src/lib/Math.sol')
    expect(out).toContain('contract GhoToken { uint256 supply; }')
  })

  it('renders the ABI as collapsible JSON', () => {
    expect(html()).toContain('balanceOf')
  })

  it('shows the browser-fetched bytecode with copy affordance', () => {
    expect(html()).toContain('0x6080604052deadbeef')
  })

  it('offers no verify panel once verified', () => {
    expect(html()).not.toMatch(/forge verify-contract/)
  })
})

describe('ContractCodeView (unverified)', () => {
  const html = () => render(<ContractCodeView address={ADDR} contract={contractInfo()} />, qc => {
    qc.setQueryData(['contract-bytecode', ADDR], '0x6080')
    qc.setQueryData(['compiler-versions'], { versions: ['v0.8.19+commit.7dd6d404', 'v0.8.10+commit.fc410830'] })
  })

  it('shows copy-paste CLI commands with the address pre-filled', () => {
    const out = html()
    expect(out).toContain(`forge verify-contract ${ADDR}`)
    expect(out).toContain('--verifier sourcify')
    expect(out).toMatch(/hardhat/i)
  })

  it('shows the standard-JSON upload form', () => {
    const out = html()
    expect(out).toMatch(/standard.json/i)
    expect(out).toContain('src/MyToken.sol:MyToken') // identifier placeholder
  })

  it('still shows the bytecode', () => {
    expect(html()).toContain('0x6080')
  })
})

describe('ContractReadView', () => {
  it('numbers the view/pure functions with typed input placeholders', () => {
    const out = render(<ContractReadView address={ADDR} contract={verifiedInfo} />, seedVerified)
    expect(out).toContain('balanceOf')
    expect(out).toContain('symbol')
    expect(out).not.toContain('transfer')    // nonpayable stays off the Read tab
    expect(out).toMatch(/address/)           // typed placeholder for the input
  })

  it('hints at verification when the contract has no ABI', () => {
    const out = render(<ContractReadView address={ADDR} contract={contractInfo()} />)
    expect(out).toMatch(/verif/i)
  })
})

describe('ContractTab', () => {
  it('renders the sub-tab bar with Code active by default', () => {
    const out = render(<ContractTab address={ADDR} contract={verifiedInfo} />, seedVerified)
    expect(out).toContain('Code')
    expect(out).toContain('Read')
  })
})

describe('verify form validation', () => {
  it('accepts a real standard JSON input and rejects everything else', () => {
    expect(validateStandardJson(JSON.stringify({ language: 'Solidity', sources: { 'a.sol': { content: 'x' } } })).ok).toBe(true)
    expect(validateStandardJson('not json').ok).toBe(false)
    expect(validateStandardJson(JSON.stringify({ sources: {} })).ok).toBe(false)
    expect(validateStandardJson(JSON.stringify({ language: 'Solidity' })).ok).toBe(false)
  })

  it('requires the path:ContractName identifier shape', () => {
    expect(validateContractIdentifier('src/Token.sol:Token')).toBeNull()
    expect(validateContractIdentifier('Token')).toMatch(/path:ContractName/)
    expect(validateContractIdentifier('')).toMatch(/path:ContractName/)
  })
})

describe('ContractSection verification chip', () => {
  it('shows Unverified for an explicit unverified status (never trusts object truthiness)', () => {
    const out = renderToStaticMarkup(<ContractSection contract={contractInfo()} now={Date.now()} />)
    expect(out).toMatch(/Unverified/)
    expect(out).not.toMatch(/✓ Verified/)
  })

  it('shows the match level when verified and flags superseded bytecode', () => {
    const out = renderToStaticMarkup(<ContractSection contract={verifiedInfo} now={Date.now()} />)
    expect(out).toMatch(/✓ Verified \(exact match\)/)
    const superseded = contractInfo({
      verification: { ...verifiedInfo.verification!, supersededBytecode: true },
    })
    expect(renderToStaticMarkup(<ContractSection contract={superseded} now={Date.now()} />)).toMatch(/superseded/i)
  })
})

describe('profileTabs', () => {
  it('adds the Contract tab only for contract accounts', () => {
    expect(profileTabs(1, [], 0, 0, undefined, undefined, true).some(t => t.key === 'contract')).toBe(true)
    expect(profileTabs(1, [], 0, 0, undefined, undefined, false).some(t => t.key === 'contract')).toBe(false)
  })
})
