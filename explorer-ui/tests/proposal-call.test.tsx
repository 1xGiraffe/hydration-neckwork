import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProposalCall, type ProposalCallData } from '../src/components/ProposalCall'
import {
  callFoldHint, proposalCallRows, CALL_LIST_CAP, FOLD_ROW_THRESHOLD,
} from '../src/utils/proposalCall'

// A batch entry as subsquid decodes it: an outer pallet enum whose value carries the call.
function transfer(index: number) {
  return {
    __kind: 'Balances',
    value: { __kind: 'force_transfer', source: `0x${index}`, dest: `0x${index}a`, value: '1000' },
  }
}

// Utility.dispatch_as_aave_manager's shape: one argument, and it is another call.
const wrappedEvmCall = {
  __kind: 'Dispatcher',
  value: {
    __kind: 'dispatch_as_aave_manager',
    call: { __kind: 'EVM', value: { __kind: 'call', source: '0xaa7e', target: '0xa8bb', input: '0xabfd' } },
  },
}

function batch(entries: unknown[]): ProposalCallData {
  return {
    pallet: 'Utility', callName: 'batch_all', args: { calls: entries },
    encoded: '0x1a00', byteLength: 6431, decodeError: null,
  }
}

describe('proposalCallRows', () => {
  it('counts one line for each leaf, plain variant, and empty list', () => {
    expect(proposalCallRows('0xdeadbeef')).toBe(1)
    expect(proposalCallRows(42)).toBe(1)
    expect(proposalCallRows(null)).toBe(1)
    expect(proposalCallRows({ __kind: 'Signed' })).toBe(1)
    expect(proposalCallRows([])).toBe(1)
  })

  it('sums a list over its items and an argument map over its entries', () => {
    expect(proposalCallRows(['a', 'b', 'c'])).toBe(3)
    expect(proposalCallRows({ amount: '1000', beneficiary: '0x00' })).toBe(2)
    expect(proposalCallRows({})).toBe(0)
  })

  it('charges a nested call its heading plus its arguments', () => {
    // force_transfer heading + source + dest + value.
    expect(proposalCallRows(transfer(1))).toBe(4)
    // dispatch_as heading + EVM.call heading + its three arguments.
    expect(proposalCallRows(wrappedEvmCall)).toBe(5)
  })

  it('charges an enum with a payload only for the payload, which renders inline', () => {
    expect(proposalCallRows({ __kind: 'X1', value: ['0xabc'] })).toBe(1)
    expect(proposalCallRows({ __kind: 'Id', value: { a: '1', b: '2' } })).toBe(2)
  })

  it('grows with the batch, so the gate tracks the page a reader would face', () => {
    expect(proposalCallRows({ calls: [transfer(1), transfer(2)] })).toBe(8)
    expect(proposalCallRows({ calls: Array.from({ length: 28 }, (_, i) => transfer(i)) })).toBe(112)
  })
})

describe('callFoldHint', () => {
  it('names the wrapped call when that is the whole payload', () => {
    expect(callFoldHint({
      call: { __kind: 'EVM', value: { __kind: 'call', source: '0xaa7e' } },
    })).toBe('→ EVM.call')
  })

  it('counts arguments otherwise', () => {
    expect(callFoldHint({ address: '0x00' })).toBe('1 arg')
    expect(callFoldHint({ currency: 550, price: '1000' })).toBe('2 args')
    expect(callFoldHint({})).toBeNull()
  })
})

describe('ProposalCall folding', () => {
  const small = batch([transfer(1), transfer(2)])
  const big = batch(Array.from({ length: 28 }, (_, i) => transfer(i)))

  it('leaves a proposal under the threshold exactly as it was', () => {
    expect(proposalCallRows(small.args)).toBeLessThanOrEqual(FOLD_ROW_THRESHOLD)
    const html = renderToStaticMarkup(<ProposalCall call={small} hash="0x12" />)
    expect(html).not.toContain('pc-fold')
    expect(html).not.toContain('Expand all')
    expect(html).toContain('force_transfer')
  })

  it('folds every nested call of a big proposal but never the proposal itself', () => {
    expect(proposalCallRows(big.args)).toBeGreaterThan(FOLD_ROW_THRESHOLD)
    const html = renderToStaticMarkup(<ProposalCall call={big} hash="0x12" />)
    expect(html.match(/<details class="pc-call pc-nested pc-fold"/g)).toHaveLength(28)
    // The proposal's own call keeps its plain heading, and gains the escape hatch.
    expect(html).toContain('<div class="pc-call"><div class="pc-head">')
    expect(html).toContain('Expand all')
    expect(html).toContain('3 args')
  })

  it('names the wrapped call on a folded wrapper row', () => {
    const wrapped = batch(Array.from({ length: 12 }, () => wrappedEvmCall))
    const html = renderToStaticMarkup(<ProposalCall call={wrapped} hash="0x12" />)
    expect(html).toContain('dispatch_as_aave_manager')
    expect(html).toContain('→ EVM.call')
    expect(html).not.toContain('1 arg<')
  })

  it('caps a long list and offers the remainder', () => {
    const huge = batch(Array.from({ length: CALL_LIST_CAP + 10 }, (_, i) => transfer(i)))
    const html = renderToStaticMarkup(<ProposalCall call={huge} hash="0x12" />)
    expect(html.match(/<li>/g)).toHaveLength(CALL_LIST_CAP)
    expect(html).toContain('Show remaining 10 calls')
  })

  it('calls a capped list of plain values entries, not calls', () => {
    const assets = batch([{
      __kind: 'Stableswap',
      value: { __kind: 'create_pool', assets: Array.from({ length: CALL_LIST_CAP + 3 }, (_, i) => i) },
    }])
    const html = renderToStaticMarkup(<ProposalCall call={assets} hash="0x12" />)
    expect(html).toContain('Show remaining 3 entries')
  })

  it('still reports an undecodable preimage rather than folding nothing', () => {
    const broken: ProposalCallData = {
      pallet: '', callName: '', args: null, encoded: '0x00',
      byteLength: 128041, decodeError: 'unknown call index 99',
    }
    const html = renderToStaticMarkup(<ProposalCall call={broken} hash="0x12" />)
    expect(html).toContain('Preimage could not be decoded (128,041 bytes)')
    expect(html).toContain('unknown call index 99')
    expect(html).not.toContain('Expand all')
  })
})
