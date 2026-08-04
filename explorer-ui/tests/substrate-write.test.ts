import { describe, expect, it } from 'vitest'
import {
  deriveEvmSource, buildEvmCallArgs, interpretEvmCallEvents, runSubstrateWrite,
} from '../src/substrateWrite'
import type { EvmCallClient, SubmitResult } from '../src/substrateWrite'
import type { WriteStage } from '../src/contractWrite'

// The e2e fixture identity (e2e/fixtures/test.ts E2E_ADDRESS): a Polkadot-
// encoded AccountId32 whose truncated H160 was computed independently with
// @dedot/utils — pins the derivation the runtime's EnsureAddressTruncated
// applies (source must equal the signer's first 20 bytes).
const SS58 = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'
const DERIVED = '0xba896f978f18d179207937a73758022ff6b405bc'

const TARGET = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const TX_HASH = '0x' + 'bb'.repeat(32)

describe('deriveEvmSource', () => {
  it('takes the first 20 bytes of the AccountId32', () => {
    expect(deriveEvmSource(SS58)).toBe(DERIVED)
  })

  it('rejects something that is not an address', () => {
    expect(() => deriveEvmSource('not-an-address')).toThrow()
  })
})

describe('buildEvmCallArgs', () => {
  it('assembles the nine EVM.call arguments with gas margin and spec fee fields', () => {
    const args = buildEvmCallArgs({
      source: DERIVED, target: TARGET, data: '0xd0e30db0',
      valueWei: 5n, gasEstimate: 100_000n, gasPriceWei: 1_000_000_000n,
    })
    expect(args).toEqual([
      DERIVED,            // source: the signer's truncated H160
      TARGET,             // target
      '0xd0e30db0',       // input
      5n,                 // value (wei)
      125_000n,           // gas_limit: estimate + 25% margin
      1_000_000_000n,     // max_fee_per_gas: eth_gasPrice
      undefined,          // max_priority_fee_per_gas: None
      undefined,          // nonce: None
      [],                 // access_list
    ])
  })
})

describe('interpretEvmCallEvents', () => {
  const record = (pallet: string, name: string) => ({ event: { pallet, palletEvent: { name } } })

  it('maps EVM.Executed to success and EVM.ExecutedFailed to reverted', () => {
    expect(interpretEvmCallEvents([record('System', 'ExtrinsicSuccess'), record('EVM', 'Executed')])).toBe('success')
    expect(interpretEvmCallEvents([record('EVM', 'ExecutedFailed')])).toBe('reverted')
    expect(interpretEvmCallEvents([record('System', 'ExtrinsicSuccess')])).toBe('unknown')
  })

  it('reads string-form pallet events too', () => {
    expect(interpretEvmCallEvents([{ event: { pallet: 'EVM', palletEvent: 'Executed' } }])).toBe('success')
  })
})

// A scriptable stand-in for a connected dedot client: records the EVM.call
// args and drives the signAndSend callback through a canned status sequence.
function fakeClient(script: (cb: (result: SubmitResult) => void) => void) {
  const recorded: { args?: unknown[]; address?: string; signer?: unknown; unsubscribed?: boolean } = {}
  const client: EvmCallClient = {
    tx: {
      evm: {
        call: (...args: unknown[]) => ({
          signAndSend: (address, options, cb) => {
            recorded.args = args
            recorded.address = address
            recorded.signer = options.signer
            script(cb)
            return Promise.resolve(() => { recorded.unsubscribed = true })
          },
        }),
      },
    },
  }
  return { client, recorded }
}

const okRpc = {
  estimateGas: async () => 100_000n,
  gasPrice: async () => 1_000_000_000n,
  call: async () => '0x',
}

describe('runSubstrateWrite lifecycle', () => {
  it('walks preparing → wallet-pending → submitted → in-block → success and unsubscribes', async () => {
    const stages: WriteStage[] = []
    const { client, recorded } = fakeClient(cb => {
      cb({ status: { type: 'Validated' }, txHash: TX_HASH, events: [] })
      cb({
        status: { type: 'BestChainBlockIncluded', value: { blockHash: '0x1', blockNumber: 4711, txIndex: 2 } },
        txHash: TX_HASH,
        events: [{ event: { pallet: 'EVM', palletEvent: { name: 'Executed' } } }],
      })
    })
    const signer = { signPayload: async () => ({ signature: '0x' }) }
    const final = await runSubstrateWrite({
      getClient: async () => client,
      address: SS58, signer, source: DERIVED, to: TARGET, data: '0xd0e30db0', valueWei: 5n,
      rpc: okRpc, decodeRevert: () => null, onStage: s => stages.push(s),
    })
    expect(stages.map(s => s.phase)).toEqual(['preparing', 'wallet-pending', 'submitted', 'in-block', 'success'])
    expect(final).toEqual({ phase: 'success', txHash: TX_HASH, blockHeight: 4711, txIndex: 2 })
    expect(recorded.args).toEqual([DERIVED, TARGET, '0xd0e30db0', 5n, 125_000n, 1_000_000_000n, undefined, undefined, []])
    expect(recorded.address).toBe(SS58)
    expect(recorded.signer).toBe(signer)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(recorded.unsubscribed).toBe(true)
  })

  it('decodes the revert of an included-but-failed execution by replaying at its block', async () => {
    const { client } = fakeClient(cb => {
      cb({
        status: { type: 'BestChainBlockIncluded', value: { blockHash: '0x1', blockNumber: 4711, txIndex: 2 } },
        txHash: TX_HASH,
        events: [{ event: { pallet: 'EVM', palletEvent: { name: 'ExecutedFailed' } } }],
      })
    })
    const rpc = {
      ...okRpc,
      call: async () => { throw Object.assign(new Error('execution reverted'), { data: '0x08c379a0' }) },
    }
    const final = await runSubstrateWrite({
      getClient: async () => client,
      address: SS58, signer: {}, source: DERIVED, to: TARGET, data: '0xd0e30db0', valueWei: 0n,
      rpc, decodeRevert: data => (data === '0x08c379a0' ? 'not allowed' : null), onStage: () => {},
    })
    expect(final).toEqual({ phase: 'reverted', txHash: TX_HASH, blockHeight: 4711, txIndex: 2, reason: 'not allowed' })
  })

  it('reports a signing rejection as failed', async () => {
    const client: EvmCallClient = {
      tx: { evm: { call: () => ({ signAndSend: () => Promise.reject(new Error('Cancelled')) }) } },
    }
    const stages: WriteStage[] = []
    const final = await runSubstrateWrite({
      getClient: async () => client,
      address: SS58, signer: {}, source: DERIVED, to: TARGET, data: '0xd0e30db0', valueWei: 0n,
      rpc: okRpc, decodeRevert: () => null, onStage: s => stages.push(s),
    })
    expect(final.phase).toBe('failed')
    expect((final as { error: string }).error).toMatch(/Cancelled/)
  })

  it('reports an invalid/dropped tx as failed with the node error', async () => {
    const { client } = fakeClient(cb => {
      cb({ status: { type: 'Invalid', value: { error: 'Transaction is outdated' } }, txHash: TX_HASH, events: [] })
    })
    const final = await runSubstrateWrite({
      getClient: async () => client,
      address: SS58, signer: {}, source: DERIVED, to: TARGET, data: '0xd0e30db0', valueWei: 0n,
      rpc: okRpc, decodeRevert: () => null, onStage: () => {},
    })
    expect(final).toEqual({ phase: 'failed', error: 'Transaction is outdated' })
  })

  it('fails cleanly when the chain is unreachable', async () => {
    const final = await runSubstrateWrite({
      getClient: async () => { throw new Error('connection refused') },
      address: SS58, signer: {}, source: DERIVED, to: TARGET, data: '0xd0e30db0', valueWei: 0n,
      rpc: okRpc, decodeRevert: () => null, onStage: () => {},
    })
    expect(final.phase).toBe('failed')
    expect((final as { error: string }).error).toMatch(/connection refused/)
  })
})
