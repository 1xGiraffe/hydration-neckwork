import { describe, expect, it } from 'vitest'
import {
  CALL_PERMIT_ADDRESS, PERMIT_DEADLINE_SECONDS,
  buildDispatchPermitArgs, parsePermitNonce, permitNonceCall, permitTypedData, splitSignature, runPermitWrite,
} from '../src/permitWrite'
import type { SubmitResult, WriteStage } from '../src/contractWrite'

const FROM = '0xf34e845538cc8a498edd97d7cde16fdfef3d4d99'
const TO = '0xc0df4c545bafa1788a4ee55f79704d12fc2c7b5c'
const DATA = '0x095ea7b3'
const SIG = '0x' + '11'.repeat(32) + '22'.repeat(32) + '1b'   // r, s, v=27
const TX_HASH = '0x' + 'cc'.repeat(32)

describe('permitNonceCall', () => {
  it('asks the CallPermit precompile for the permit nonce, not the account nonce', () => {
    expect(permitNonceCall(FROM)).toEqual({
      to: CALL_PERMIT_ADDRESS,
      data: '0x7ecebe00000000000000000000000000f34e845538cc8a498edd97d7cde16fdfef3d4d99',
    })
  })

  it('parses the answer and rejects a non-answer', () => {
    expect(parsePermitNonce('0x0')).toBe(0n)
    expect(parsePermitNonce('0x000000000000000000000000000000000000000000000000000000000000000b')).toBe(11n)
    expect(() => parsePermitNonce('0x')).toThrow(/nonces/)
    expect(() => parsePermitNonce('')).toThrow(/nonces/)
  })
})

describe('permitTypedData', () => {
  const fields = {
    chainId: 222222, from: FROM, to: TO, valueWei: 0n, data: DATA,
    gasLimit: 74_127n, nonce: 3n, deadline: 1_780_000_000n,
  }

  // Every name and type here is reconstructed verbatim by the runtime's
  // validate_permit (pallet_evm_precompile_call_permit); a rename silently
  // changes the digest and the signature stops recovering to `from`.
  it('matches the CallPermit domain and message the runtime rebuilds', () => {
    const payload = JSON.parse(permitTypedData(fields))
    expect(payload.primaryType).toBe('CallPermit')
    expect(payload.domain).toEqual({
      name: 'Call Permit Precompile',
      version: '1',
      chainId: 222222,
      verifyingContract: CALL_PERMIT_ADDRESS,
    })
    expect(payload.types.CallPermit.map((f: { name: string; type: string }) => `${f.type} ${f.name}`)).toEqual([
      'address from', 'address to', 'uint256 value', 'bytes data', 'uint64 gaslimit', 'uint256 nonce', 'uint256 deadline',
    ])
    expect(payload.message).toEqual({
      from: FROM, to: TO, value: '0', data: DATA, gaslimit: 74127, nonce: '3', deadline: '1780000000',
    })
  })

  it('keeps 256-bit values as decimal strings rather than numbers', () => {
    const big = permitTypedData({ ...fields, valueWei: 2n ** 200n, nonce: 2n ** 64n })
    const message = JSON.parse(big).message
    expect(message.value).toBe((2n ** 200n).toString())
    expect(message.nonce).toBe((2n ** 64n).toString())
  })
})

describe('splitSignature', () => {
  it('splits r, s and v', () => {
    expect(splitSignature(SIG)).toEqual({ v: 27, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) })
  })

  it('normalises a raw 0/1 recovery id to the Ethereum form the runtime recovers with', () => {
    expect(splitSignature('0x' + '11'.repeat(32) + '22'.repeat(32) + '00').v).toBe(27)
    expect(splitSignature('0x' + '11'.repeat(32) + '22'.repeat(32) + '01').v).toBe(28)
  })

  it('rejects a truncated signature and an impossible recovery id', () => {
    expect(() => splitSignature('0xdead')).toThrow(/65/)
    expect(() => splitSignature('0x' + '11'.repeat(32) + '22'.repeat(32) + '05')).toThrow(/recovery id/)
  })
})

describe('buildDispatchPermitArgs', () => {
  it('assembles the nine dispatch_permit arguments in declaration order, with no gas price', () => {
    const args = buildDispatchPermitArgs(
      { chainId: 222222, from: FROM, to: TO, valueWei: 5n, data: DATA, gasLimit: 74_127n, nonce: 3n, deadline: 1_780_000_000n },
      { v: 27, r: '0xaa', s: '0xbb' },
    )
    expect(args).toEqual([FROM, TO, 5n, DATA, 74_127n, 1_780_000_000n, 27, '0xaa', '0xbb'])
  })
})

function harness(overrides: {
  sign?: () => Promise<string>
  submit?: (args: readonly unknown[], onResult: (r: SubmitResult) => void) => Promise<unknown>
  call?: (tx: { to: string; data: string }, block: string) => Promise<string>
} = {}) {
  const stages: WriteStage[] = []
  const recorded: { args?: readonly unknown[]; typedData?: string; signedBy?: string } = {}
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method !== 'eth_signTypedData_v4') throw new Error(`unexpected ${method}`)
      recorded.signedBy = params?.[0] as string
      recorded.typedData = params?.[1] as string
      return overrides.sign ? await overrides.sign() : SIG
    },
  }
  const run = () => runPermitWrite({
    provider: provider as never,
    chainId: 222222, from: FROM, to: TO, data: DATA, valueWei: 0n,
    rpc: {
      estimateGas: async () => 100_000n,
      call: overrides.call ?? (async () => '0x0000000000000000000000000000000000000000000000000000000000000007'),
      blockTimestamp: async () => 1_780_000_000n,
    },
    submit: overrides.submit ?? (async (args, onResult) => {
      recorded.args = args
      onResult({ status: { type: 'Validated' }, txHash: TX_HASH, events: [] })
      onResult({
        status: { type: 'BestChainBlockIncluded', value: { blockNumber: 4711, txIndex: 2 } },
        txHash: TX_HASH,
        events: [{ event: { pallet: 'EVM', palletEvent: { name: 'Executed' } } }],
      })
      return () => {}
    }),
    decodeRevert: () => 'not allowed',
    onStage: s => stages.push(s),
  })
  return { run, stages, recorded }
}

describe('runPermitWrite', () => {
  it('prices, reads the permit nonce, signs typed data and dispatches unsigned', async () => {
    const { run, stages, recorded } = harness()
    const final = await run()
    expect(stages.map(s => s.phase)).toEqual(['preparing', 'wallet-pending', 'submitted', 'in-block', 'success'])
    expect(final).toEqual({ phase: 'success', txHash: TX_HASH, blockHeight: 4711, txIndex: 2 })
    expect(recorded.signedBy).toBe(FROM)
    // gas_limit carries the 25% margin; deadline is chain time + an hour; the
    // nonce is whatever the precompile answered (7 here).
    expect(recorded.args).toEqual([FROM, TO, 0n, DATA, 125_000n, 1_780_000_000n + PERMIT_DEADLINE_SECONDS, 27, '0x' + '11'.repeat(32), '0x' + '22'.repeat(32)])
    expect(JSON.parse(recorded.typedData!).message.nonce).toBe('7')
  })

  it('reports a declined signature as failed without submitting anything', async () => {
    let submitted = false
    const { run, stages } = harness({
      sign: () => Promise.reject(new Error('User rejected the request')),
      submit: async () => { submitted = true; return () => {} },
    })
    const final = await run()
    expect(final.phase).toBe('failed')
    expect((final as { error: string }).error).toMatch(/User rejected/)
    expect(submitted).toBe(false)
    expect(stages.map(s => s.phase)).toEqual(['preparing', 'wallet-pending', 'failed'])
  })

  it('surfaces a pool rejection — the pallet validates and dry-runs the permit before broadcast', async () => {
    const { run } = harness({ submit: () => Promise.reject(new Error('The chain rejected the permit: EvmPermitExpired')) })
    const final = await run()
    expect(final).toEqual({ phase: 'failed', error: 'The chain rejected the permit: EvmPermitExpired' })
  })

  // dispatch_permit returns Ok having run nothing when the permit went stale
  // between pool validation and inclusion, so an included extrinsic with no EVM
  // outcome event must never read as a successful write.
  it('treats an included extrinsic with no EVM event as failed, not success', async () => {
    const { run } = harness({
      submit: async (_args, onResult) => {
        onResult({
          status: { type: 'BestChainBlockIncluded', value: { blockNumber: 4711, txIndex: 2 } },
          txHash: TX_HASH,
          events: [{ event: { pallet: 'System', palletEvent: { name: 'ExtrinsicSuccess' } } }],
        })
        return () => {}
      },
    })
    const final = await run()
    expect(final.phase).toBe('failed')
    expect((final as { error: string }).error).toMatch(/no longer valid/)
  })

  // The WSS provider reconnects forever, so a submission that never resolves
  // must not leave the row waiting on a wallet the user already answered.
  it('gives up on an unreachable chain instead of hanging after the signature', async () => {
    const stages: WriteStage[] = []
    const final = await runPermitWrite({
      provider: { request: async () => SIG } as never,
      chainId: 222222, from: FROM, to: TO, data: DATA, valueWei: 0n,
      rpc: {
        estimateGas: async () => 100_000n,
        call: async () => '0x07',
        blockTimestamp: async () => 1_780_000_000n,
      },
      submit: () => new Promise(() => {}),   // never settles, like a dead socket
      decodeRevert: () => null,
      onStage: s => stages.push(s),
      submitTimeoutMs: 10,
    })
    expect(final.phase).toBe('failed')
    expect((final as { error: string }).error).toMatch(/Could not reach the chain/)
    expect(stages.map(s => s.phase)).toEqual(['preparing', 'wallet-pending', 'failed'])
  })

  it('decodes the revert of a dispatched-but-reverting call by replaying at its block', async () => {
    const { run } = harness({
      call: async (_tx, block) => {
        if (block === 'latest') return '0x07'
        throw Object.assign(new Error('execution reverted'), { data: '0x08c379a0' })
      },
      submit: async (_args, onResult) => {
        onResult({
          status: { type: 'BestChainBlockIncluded', value: { blockNumber: 4711, txIndex: 2 } },
          txHash: TX_HASH,
          events: [{ event: { pallet: 'EVM', palletEvent: { name: 'ExecutedFailed' } } }],
        })
        return () => {}
      },
    })
    const final = await run()
    expect(final).toEqual({ phase: 'reverted', txHash: TX_HASH, blockHeight: 4711, txIndex: 2, reason: 'not allowed' })
  })
})
