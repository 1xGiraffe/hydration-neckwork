import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EvmCallCard, EvmLogView } from '../src/components/EvmDecoded'
import { decodedParamsRecord } from '../src/utils/evmDecoded'
import { ContractTransactionsView, ContractEventsView } from '../src/components/ContractActivityTab'
import { EventDetail } from '../src/pages/EventDetail'
import type {
  ContractEventsPage, ContractTransactionsPage, DecodedEvmCall, EvmLogDecode,
  EventDetail as EventDetailData,
} from '../src/types'

const ADDR = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const CALLER = '0x4b0540d29f19b2da4cce2b1ba6b6325dd9d86622'

const decodedCall: DecodedEvmCall = {
  target: ADDR,
  contractName: 'GhoToken',
  call: {
    decoded: true,
    name: 'transfer',
    signature: 'transfer(address,uint256)',
    selector: '0xa9059cbb',
    params: [
      { name: 'to', type: 'address', value: CALLER },
      { name: 'value', type: 'uint256', value: '1000000' },
    ],
  },
}

const decodedLog: EvmLogDecode = {
  decoded: true,
  name: 'Transfer',
  signature: 'Transfer(address,address,uint256)',
  decodedBy: 'verified-abi',
  params: [
    { name: 'from', type: 'address', value: CALLER, indexed: true },
    { name: 'to', type: 'address', value: ADDR, indexed: true },
    { name: 'value', type: 'uint256', value: '1000000' },
  ],
}

function render(node: React.ReactNode, seed?: (qc: QueryClient) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  seed?.(queryClient)
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

describe('decodedParamsRecord', () => {
  it('keys params by name, suffixing duplicates and empties positionally', () => {
    expect(decodedParamsRecord([
      { name: 'to', type: 'address', value: CALLER },
      { name: 'to', type: 'address', value: ADDR },
      { name: '', type: 'uint256', value: '5' },
    ])).toEqual({ to: CALLER, 'to#1': ADDR, arg2: '5' })
  })

  it('labels hashed indexed params instead of pretending the preimage is known', () => {
    const rec = decodedParamsRecord([{ name: 'key', type: 'string', value: '0x' + 'ab'.repeat(32), indexed: true, hashed: true }])
    expect(rec.key).toContain('indexed hash')
  })
})

describe('EvmCallCard / EvmLogView', () => {
  it('renders the signature chip, target link and typed args', () => {
    const out = render(<EvmCallCard decoded={decodedCall} />)
    expect(out).toContain('transfer(address,uint256)')
    expect(out).toContain('GhoToken')
    expect(out).toContain(`/account/${ADDR}`)
    expect(out).toContain('verified ABI')
    // Address values auto-link through ParamsTable.
    expect(out).toContain(`/account/${CALLER}`)
    expect(out).toContain('1000000')
  })

  it('falls back to the bare selector when args cannot be decoded', () => {
    const out = render(<EvmCallCard decoded={{ target: ADDR, contractName: null, call: { decoded: false, selector: '0xdeadbeef' } }} />)
    expect(out).toContain('0xdeadbeef')
    expect(out).not.toContain('kv-row')
  })

  it('renders decoded log params with names', () => {
    const out = render(<EvmLogView decoded={decodedLog} />)
    expect(out).toContain('Transfer(address,address,uint256)')
    expect(out).toContain('from')
    expect(out).toContain(`/account/${CALLER}`)
  })
})

// The extrinsic page's Parameters/Events tabs are component-local state, so
// static markup can only show the default Activity tab — the decoded-call and
// decoded-event wiring on that page is exercised end-to-end in
// e2e/contract-tab.spec.ts, which clicks the tabs against the mock API.

describe('EventDetail decoding', () => {
  const detail: EventDetailData = {
    blockHeight: 100, eventIndex: 0, extrinsicIndex: 2, timestamp: '2026-08-04 10:00:00',
    name: 'EVM.Log', args: { log: { address: ADDR, topics: [], data: '0x' } }, decoded: true,
    evmDecoded: decodedLog, phase: 'ApplyExtrinsic(2)', extrinsic: null,
  }

  it('renders named attributes with the verified-abi signature', () => {
    const out = render(<EventDetail id="100-0" />, qc => qc.setQueryData(['event', '100-0'], detail))
    expect(out).toContain('Transfer(address,address,uint256)')
    expect(out).toContain(`/account/${CALLER}`)
  })
})

describe('contract activity views', () => {
  const txPage: ContractTransactionsPage = {
    transactions: [
      {
        blockHeight: 200, extrinsicIndex: 2, timestamp: '2026-08-04 10:00:00', txHash: '0x' + 'aa'.repeat(32),
        from: { address: CALLER, accountId: CALLER }, success: true,
        method: { selector: '0xa9059cbb', name: 'transfer', signature: 'transfer(address,uint256)' },
      },
      {
        blockHeight: 199, extrinsicIndex: 1, timestamp: '2026-08-04 09:59:48', txHash: '0x' + 'bb'.repeat(32),
        from: { address: CALLER, accountId: CALLER }, success: false,
        method: { selector: '0xdeadbeef', name: null, signature: null },
      },
    ],
    total: 51,
  }

  const eventsPage: ContractEventsPage = {
    events: [
      {
        blockHeight: 200, eventIndex: 4, extrinsicIndex: 2, timestamp: '2026-08-04 10:00:00',
        name: 'Transfer', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'], data: '0x',
        evmDecoded: decodedLog, decodedBy: 'verified-abi',
      },
      {
        blockHeight: 198, eventIndex: 3, extrinsicIndex: 1, timestamp: '2026-08-04 09:59:36',
        name: 'Borrow', topics: ['0x' + '11'.repeat(32)], data: '0x',
        args: { reserve: ADDR, amount: '5' }, decodedBy: 'ingest',
      },
      {
        blockHeight: 197, eventIndex: 9, extrinsicIndex: null, timestamp: '2026-08-04 09:59:24',
        name: null, topics: ['0x' + '22'.repeat(32)], data: '0x1234',
      },
    ],
    total: 3,
  }

  it('renders transactions with method chips, selector fallback and a pager', () => {
    const out = render(<ContractTransactionsView address={ADDR} />, qc => qc.setQueryData(['contract-txs', ADDR, 0, 25], txPage))
    expect(out).toContain('transfer')
    expect(out).toContain('0xdeadbeef')
    expect(out).toContain('/extrinsic/200-2')
    expect(out).toContain('pager')
  })

  it('renders events with names, and the raw topic0 for unknown events', () => {
    const out = render(<ContractEventsView address={ADDR} />, qc => qc.setQueryData(['contract-events', ADDR, 0, 25], eventsPage))
    expect(out).toContain('Transfer')
    expect(out).toContain('Borrow')
    expect(out).toContain('/event/200-4')
    // The undecodable event shows its topic0, not an invented name.
    expect(out).toMatch(/0x2222/)
  })
})
