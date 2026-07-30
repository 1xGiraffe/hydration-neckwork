import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RELAY_PROOF_CALL_NAME, withoutRelayChainProof } from '../../src/raw/callArgs.js'

function povArgs(nodeCount: number) {
  return {
    data: {
      validationData: { relayParentNumber: 32276037, maxPovSize: 10485760 },
      relayChainState: { trieNodes: Array.from({ length: nodeCount }, (_, i) => `0x${i.toString(16)}`) },
      downwardMessages: [],
      horizontalMessages: { 2004: [{ sentAt: 32276036, data: '0x00' }] },
      collatorPeerId: '0x0024',
    },
  }
}

describe('withoutRelayChainProof', () => {
  it('replaces the relay-chain storage proof with a counted omission marker', () => {
    const trimmed = withoutRelayChainProof(RELAY_PROOF_CALL_NAME, povArgs(187)) as {
      data: { relayChainState: unknown }
    }

    expect(trimmed.data.relayChainState).toEqual({ trieNodeCount: 187, trieNodesOmitted: true })
  })

  it('keeps every field the proof was hiding', () => {
    const original = povArgs(3)
    const trimmed = withoutRelayChainProof(RELAY_PROOF_CALL_NAME, original) as typeof original

    // The relay parent header, both message queues and the collator id are the only
    // parts of this inherent an explorer can render, and they are 3-5% of the bytes.
    expect(trimmed.data.validationData).toEqual(original.data.validationData)
    expect(trimmed.data.horizontalMessages).toEqual(original.data.horizontalMessages)
    expect(trimmed.data.downwardMessages).toEqual(original.data.downwardMessages)
    expect(trimmed.data.collatorPeerId).toBe(original.data.collatorPeerId)
  })

  it('does not mutate the decoded args, which other extractors also read', () => {
    const original = povArgs(2)

    withoutRelayChainProof(RELAY_PROOF_CALL_NAME, original)

    expect(original.data.relayChainState).toEqual({ trieNodes: ['0x0', '0x1'] })
  })

  it('leaves every other call untouched', () => {
    const args = { dest: '0xabc', currencyId: 5, amount: '1000' }

    expect(withoutRelayChainProof('Tokens.transfer', args)).toBe(args)
    // A nested batch can carry the inherent's name nowhere near its own args.
    expect(withoutRelayChainProof('Utility.batch_all', povArgs(4))).toEqual(povArgs(4))
  })

  it('stores the args verbatim when the proof is not where it is expected', () => {
    // A runtime upgrade that reshapes the inherent must fall through to keeping the
    // payload rather than dropping a field this function does not recognise.
    for (const args of [null, undefined, 'scale-encoded', { data: null }, { data: {} },
      { data: { relayChainState: null } }, { data: { relayChainState: { trieNodes: '0x00' } } }]) {
      expect(withoutRelayChainProof(RELAY_PROOF_CALL_NAME, args)).toBe(args)
    }
  })
})

// The trim only pays off if it is applied to both columns that carry the payload:
// raw_extrinsics.call_args_json for the extrinsic's own root call and
// raw_calls.args_json for the same call in the call tree.
describe('raw row serialization', () => {
  const indexer = readFileSync(fileURLToPath(new URL('../../src/raw/indexer.ts', import.meta.url)), 'utf8')

  it('trims both columns that hold the inherent payload', () => {
    expect(indexer).toContain('call_args_json: toJsonString(withoutRelayChainProof(')
    expect(indexer).toContain('args_json: toJsonString(withoutRelayChainProof(')
  })

  it('leaves event args alone — events never carry the proof', () => {
    expect(indexer).toContain('args_json: toJsonString(event.args ?? null)')
  })
})
