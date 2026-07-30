import { blake2AsHex } from '@polkadot/util-crypto'
import { describe, expect, it } from 'vitest'
import { preimageBytesFromCall, selectPreimageBytes } from '../../src/governance/proposalCalls.js'

const digest = (bytes: string): string => blake2AsHex(bytes, 256)

// Referenda 34 and 62 had no proposal row at all: their preimages were noted inside a
// Utility.batch_all, and for extrinsics the recovery pipeline re-ingested the nested calls
// are not indexed as their own rows — only the batch. So a lookup for a
// Preimage.note_preimage call row on that extrinsic finds nothing, while the bytes sit in
// the batch's own decoded args.
describe('preimage bytes on a call row', () => {
  it('reads a plain note_preimage call, in either pallet', () => {
    expect(preimageBytesFromCall('Preimage.note_preimage', { bytes: '0xdead' })).toEqual(['0xdead'])
    expect(preimageBytesFromCall('Preimage.note_preimage_operational', { bytes: '0xdead' })).toEqual(['0xdead'])
    // Democracy predates the Preimage pallet and names the same argument differently.
    expect(preimageBytesFromCall('Democracy.note_preimage', { encodedProposal: '0xbeef' })).toEqual(['0xbeef'])
    expect(preimageBytesFromCall('Democracy.note_preimage_operational', { encodedProposal: '0xbeef' })).toEqual(['0xbeef'])
  })

  it('reads a note_preimage nested in a batch, which is the shape referenda 34 and 62 have', () => {
    const batch = { calls: [{ __kind: 'Preimage', value: { __kind: 'note_preimage', bytes: '0xaa11' } }] }
    expect(preimageBytesFromCall('Utility.batch_all', batch)).toEqual(['0xaa11'])
  })

  it('reads every preimage a batch notes, in call order', () => {
    const batch = {
      calls: [
        { __kind: 'Preimage', value: { __kind: 'note_preimage', bytes: '0xaa11' } },
        { __kind: 'Preimage', value: { __kind: 'note_preimage', bytes: '0xbb22' } },
      ],
    }
    expect(preimageBytesFromCall('Utility.batch_all', batch)).toEqual(['0xaa11', '0xbb22'])
  })

  it('finds one nested arbitrarily deep, through proxy and nested batches', () => {
    const wrapped = {
      real: '0x00',
      call: { __kind: 'Utility', value: { __kind: 'batch', calls: [
        { __kind: 'System', value: { __kind: 'remark', remark: '0x00' } },
        { __kind: 'Democracy', value: { __kind: 'note_preimage', encodedProposal: '0xcc33' } },
      ] } },
    }
    expect(preimageBytesFromCall('Proxy.proxy', wrapped)).toEqual(['0xcc33'])
  })

  it('ignores a call that carries no preimage', () => {
    expect(preimageBytesFromCall('Preimage.request_preimage', { hash: '0xabcd' })).toEqual([])
    expect(preimageBytesFromCall('Utility.batch', { calls: [{ __kind: 'System', value: { __kind: 'remark', remark: '0x01' } }] })).toEqual([])
  })
})

// A preimage's hash IS its content, so which candidate is the wanted one is checkable
// rather than guessable. 8 of the 620 Preimage.Noted events sit on an extrinsic that
// noted SEVERAL preimages, and taking the first byte string found put a sibling
// proposal's call on referenda 33, 116, 167 and 339.
describe('choosing the preimage that belongs to a hash', () => {
  const first = '0x0a0b0c'
  const second = '0x0d0e0f10'

  it('picks the candidate whose hash matches, not the first one offered', () => {
    expect(selectPreimageBytes([first, second], digest(second), digest)).toBe(second)
    expect(selectPreimageBytes([first, second], digest(first), digest)).toBe(first)
  })

  it('is case insensitive about the hash it was asked for', () => {
    expect(selectPreimageBytes([first], digest(first).toUpperCase(), digest)).toBe(first)
  })

  it('returns null rather than a guess when nothing matches', () => {
    expect(selectPreimageBytes([first, second], `0x${'11'.repeat(32)}`, digest)).toBeNull()
    expect(selectPreimageBytes([], digest(first), digest)).toBeNull()
  })

  it('skips candidates that are not hex bytes at all', () => {
    expect(selectPreimageBytes(['0x', 'not hex', first], digest(first), digest)).toBe(first)
  })

  // The real bytes of referendum 34's proposal, noted inside a Utility.batch_all at block
  // 7,055,133 — 228 bytes, matching the `len` on its Referenda.Submitted event.
  it('verifies a real referendum preimage against its real hash', () => {
    const bytes = '0x27030d02040d030101aa7e0000000000000000000000000000000aa7e00000000000000000000000005a01aa7e0000000000000000000000000000000aa7e0e64c38e2fa00dfe4f1d0b92f75b8e44ebdf292e41101571f03e500000000000000000000000000000000000000000000000000000001000000050000000000000000000000000000000000000000000000000000000000124f800000000000000000000000000000000000000000000000000000000000000000a0860100000000000046c32300000000000000000000000000000000000000000000000000000000000000'
    expect((bytes.length - 2) / 2).toBe(228)
    expect(digest(bytes)).toBe('0x2e46861ebd71490ac6215e7a97a05922251d67af233e6acd8f25ee1c2a425fae')
    expect(selectPreimageBytes(
      preimageBytesFromCall('Utility.batch_all', { calls: [{ __kind: 'Preimage', value: { __kind: 'note_preimage', bytes } }] }),
      '0x2e46861ebd71490ac6215e7a97a05922251d67af233e6acd8f25ee1c2a425fae',
      digest,
    )).toBe(bytes)
  })
})
