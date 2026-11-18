import { describe, expect, it } from 'vitest'
import { summarizeCall, summarizeProposal, type SummaryLine } from '../src/utils/whatThisDoes'

// "What this does": templates state only what the decoded arguments say, and
// anything without a template falls back to naming the call.

const text = (l: SummaryLine): string => l.parts.map(p => (p.t === 'text' || p.t === 'code' ? p.v : p.t === 'account' ? `<${p.v.slice(0, 6)}>` : p.t === 'asset' ? `asset ${p.id}` : p.t === 'ref' ? `#${p.index}` : p.t === 'assetAmount' ? `${p.raw} of asset ${p.id}` : p.t === 'amount' ? `${p.raw}/${p.decimals} ${p.symbol}` : '')).join('')

describe('what this does', () => {
  it('reads a batch as its calls, saying how it fails', () => {
    const line = summarizeCall({ pallet: 'Utility', method: 'batch_all', args: { calls: [
      { __kind: 'Omnipool', value: { __kind: 'set_asset_weight_cap', assetId: 0, cap: 220000 } },
      { __kind: 'Referenda', value: { __kind: 'cancel', index: 248 } },
    ] } })
    expect(text(line)).toBe('Runs 2 calls together (all succeed or none do):')
    expect(line.children!.map(text)).toEqual([
      'Sets the Omnipool weight cap of asset 0 to 22% of the pool',
      'Cancels #248; whoever placed its deposits can then reclaim them',
    ])
  })

  it('unwraps the dispatching wrappers into one sentence', () => {
    const line = summarizeCall({ pallet: 'Whitelist', method: 'dispatch_whitelisted_call_with_preimage', args: {
      call: { __kind: 'Dispatcher', value: { __kind: 'dispatch_as_treasury', call: { __kind: 'Treasury', value: { __kind: 'spend_local', amount: '5000000000000000', beneficiary: `0x${'ab'.repeat(32)}` } } } },
    } })
    expect(text(line)).toBe('Fast-tracked by the technical committee (whitelisted): as the treasury account, pays 5000000000000000/12 HDX from the treasury to <0xabab>')
  })

  it('states a transfer with its amount, asset, source and destination', () => {
    const line = summarizeCall({ pallet: 'Tokens', method: 'force_transfer', args: { source: `0x${'f5'.repeat(32)}`, dest: `0x${'45'.repeat(32)}`, currencyId: 10, amount: '12000000000' } })
    expect(text(line)).toBe('Transfers 12000000000 of asset 10 from <0xf5f5> to <0x4545>')
  })

  it('states a treasury spend in HDX (the unit asset kind) and never names a unit another asset kind leaves unstated', () => {
    expect(text(summarizeCall({ pallet: 'Treasury', method: 'spend', args: { assetKind: null, amount: '1000000000000000', beneficiary: `0x${'cd'.repeat(32)}` } }))).toBe('Approves a treasury payout of 1000000000000000/12 HDX to <0xcdcd>')
    expect(text(summarizeCall({ pallet: 'Treasury', method: 'spend', args: { assetKind: { V4: { location: {} } }, amount: '1', beneficiary: `0x${'cd'.repeat(32)}` } }))).not.toMatch(/HDX/)
  })

  it('names every transfer the depth cut would hide, and says how many calls it left out', () => {
    const transfer = { __kind: 'Tokens', value: { __kind: 'transfer', dest: `0x${'45'.repeat(32)}`, currencyId: 5, amount: '7' } }
    // Five wrappers deep: past the summary's depth, a transfer is still stated.
    let call: unknown = transfer
    for (let i = 0; i < 5; i++) call = { __kind: 'Utility', value: { __kind: 'batch_all', calls: [{ __kind: 'System', value: { __kind: 'remark', remark: '0x00' } }, call] } }
    const line = summarizeCall({ pallet: 'Utility', method: 'batch_all', args: { calls: [call] } })
    const flat: string[] = []
    const walk = (l: SummaryLine) => { flat.push(text(l)); l.children?.forEach(walk) }
    walk(line)
    expect(flat.some(t => /^Inside: transfers 7 of asset 5 to <0x4545>/.test(t))).toBe(true)
    expect(flat.some(t => /more nested calls, see the full call below/.test(t))).toBe(true)
  })

  it('names the transfers among the calls a long batch leaves out', () => {
    const calls = Array.from({ length: 30 }, (_, i) => (i === 27
      ? { __kind: 'Balances', value: { __kind: 'transfer_keep_alive', dest: `0x${'99'.repeat(32)}`, value: '1000000000000' } }
      : { __kind: 'System', value: { __kind: 'remark', remark: '0x00' } }))
    const line = summarizeCall({ pallet: 'Utility', method: 'batch', args: { calls } })
    const tail = line.children!.map(text)
    expect(tail).toContain('…and 6 more calls (see the full call below)')
    expect(tail).toContain('Inside: transfers 1000000000000/12 HDX to <0x9999>')
  })

  it('falls back to the call name, and to nothing for an undecoded proposal', () => {
    expect(text(summarizeCall({ pallet: 'Foo', method: 'bar', args: {} }))).toBe('Calls Foo.bar')
    expect(summarizeProposal({ pallet: '', callName: '', args: null, decodeError: 'bad' })).toBeNull()
  })
})
