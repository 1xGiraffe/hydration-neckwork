import { describe, expect, it } from 'vitest'
import {
  EMPTY_DRAFT, apiValue, daysToBlock, depositToNote, discussionLine, originOfTrack, preimageDeposit, readDraft, snakeCase, submittedIndex,
  suggestSpendTrack, toApiCall, trackCanSpend, utf8Hex, validFromBlock, ONE_HDX,
} from '../src/proposeLogic'
import { summarizeProposal } from '../src/utils/whatThisDoes'

const ACC = `0x${'47'.repeat(32)}`
const SS58 = '5DgiK3iMzT2ZFWRvvkmf32pRxZemRTgYoT2uSzprc3uKpnE7'
const accountHex = (s: string) => (s === SS58 ? ACC : null)

describe('track suggestion for a treasury spend', () => {
  it('picks the smallest track whose origin may pay the amount', () => {
    expect(suggestSpendTrack(1_000n * ONE_HDX)).toBe('tipper')
    expect(suggestSpendTrack(50_000n * ONE_HDX)).toBe('tipper')
    expect(suggestSpendTrack(50_000n * ONE_HDX + 1n)).toBe('spender')
    expect(suggestSpendTrack(2_222_222n * ONE_HDX)).toBe('spender')
    expect(suggestSpendTrack(3_000_000n * ONE_HDX)).toBe('treasurer')
    expect(suggestSpendTrack(50_000_001n * ONE_HDX)).toBe('root')
  })
  it('says which tracks can pay it, and that other tracks cannot spend at all', () => {
    expect(trackCanSpend('tipper', 60_000n * ONE_HDX)).toBe(false)
    expect(trackCanSpend('treasurer', 60_000n * ONE_HDX)).toBe(true)
    expect(trackCanSpend('root', 10n ** 30n)).toBe(true)
    expect(trackCanSpend('general_admin', ONE_HDX)).toBeNull()
  })
  it('maps a track to the origin it dispatches from', () => {
    expect(originOfTrack('root')).toEqual({ kind: 'root' })
    expect(originOfTrack('treasurer')).toEqual({ kind: 'origin', name: 'Treasurer' })
    expect(originOfTrack('economic_parameters')).toEqual({ kind: 'origin', name: 'EconomicParameters' })
    expect(originOfTrack('whitelisted_caller')).toEqual({ kind: 'origin', name: 'WhitelistedCaller' })
  })
})

describe('preimage deposit', () => {
  it('is the runtime storage price: 401.92 HDX plus 0.03 HDX a byte (matches the chain’s held tickets)', () => {
    expect(preimageDeposit(286)).toBe(410_500_000_000_000n)
    expect(preimageDeposit(1159)).toBe(436_690_000_000_000n)
    expect(preimageDeposit(0)).toBe(401_920_000_000_000n)
  })
})

describe('the new referendum’s number', () => {
  it('is read from the transaction’s own Referenda.Submitted', () => {
    expect(submittedIndex([{ pallet: 'Preimage', name: 'Noted', data: {} }, { pallet: 'Referenda', name: 'Submitted', data: { index: 451, track: 7 } }])).toBe(451)
    expect(submittedIndex([])).toBeNull()
  })
})

describe('a spend’s claimable block stays put as the head moves', () => {
  it('fixes "days from now" to a block when it is set', () => {
    const block = daysToBlock('30', 16_780_000, 40_000)
    expect(block).toBe(16_780_000 + 1_200_000)
    const vf = { mode: 'days' as const, days: '30', block }
    // Later heads do not move it: the call (and its preimage hash) stays the same.
    expect(validFromBlock(vf, 16_780_000)).toEqual({ block })
    expect(validFromBlock(vf, 16_790_000)).toEqual({ block })
    expect(validFromBlock(vf, block! + 1)).toEqual({ error: expect.stringMatching(/after the current one/) })
  })
  it('reads the other modes', () => {
    expect(validFromBlock({ mode: 'now' }, 1)).toEqual({ block: null })
    expect(validFromBlock({ mode: 'block', block: '200' }, 100)).toEqual({ block: 200 })
    expect('error' in validFromBlock({ mode: 'block', block: 'x' }, 100)).toBe(true)
    expect('error' in validFromBlock({ mode: 'days', days: '30', block: null }, 100)).toBe(true)
    expect(daysToBlock('0', 1, 10)).toBeNull()
  })
})

describe('what noting the preimage holds', () => {
  it('is nothing when it is stored or already requested', () => {
    expect(depositToNote(286, { noted: false, requested: false })).toBe(410_500_000_000_000n)
    expect(depositToNote(286, { noted: true, requested: false })).toBe(0n)
    expect(depositToNote(286, { noted: false, requested: true })).toBe(0n)
  })
})

describe('the decoded call, in the referendum page’s shape', () => {
  it('names calls in snake_case', () => {
    expect(snakeCase('SpendLocal')).toBe('spend_local')
    expect(snakeCase('BatchAll')).toBe('batch_all')
    expect(snakeCase('DispatchAsAaveManager')).toBe('dispatch_as_aave_manager')
    expect(snakeCase('Remark')).toBe('remark')
  })
  it('turns amounts into strings, accounts into hex, None into null and nested calls into {__kind}', () => {
    expect(apiValue(12n, accountHex)).toBe('12')
    expect(apiValue(SS58, accountHex)).toBe(ACC)
    expect(apiValue({ raw: ACC.toUpperCase().replace('0X', '0x') }, accountHex)).toBe(ACC)
    expect(apiValue(undefined, accountHex)).toBeNull()
    expect(apiValue({ type: 'Root' }, accountHex)).toEqual({ __kind: 'Root' })
    expect(apiValue(new Uint8Array([1, 255]), accountHex)).toBe('0x01ff')
  })
  it('adapts a batch whose calls the summary reads', () => {
    const decoded = {
      pallet: 'Utility',
      palletCall: { name: 'BatchAll', params: { calls: [
        { pallet: 'System', palletCall: { name: 'Remark', params: { remark: '0x6869' } } },
        { pallet: 'Treasury', palletCall: { name: 'SpendLocal', params: { amount: 5n * ONE_HDX, beneficiary: { raw: ACC } } } },
      ] } },
    }
    const call = toApiCall(decoded, '0x0102', accountHex)
    expect(call).toMatchObject({ pallet: 'Utility', callName: 'batch_all', decodeError: null, byteLength: 2 })
    const summary = summarizeProposal(call)!
    expect(summary.children).toHaveLength(2)
    expect(summary.children![1].parts).toContainEqual({ t: 'amount', raw: (5n * ONE_HDX).toString(), decimals: 12, symbol: 'HDX' })
    expect(summary.children![1].parts).toContainEqual({ t: 'account', v: ACC })
  })
  it('reports a call it cannot read as undecoded', () => {
    expect(toApiCall(null, '0x00', accountHex).decodeError).toBeTruthy()
  })
})

describe('the draft', () => {
  it('reads back what it stored and refuses malformed fields', () => {
    const d = { ...EMPTY_DRAFT, step: 3, title: 'T', submitted: 451, call: { kind: 'remark', text: 'x' } }
    expect(readDraft(JSON.stringify(d))).toMatchObject({ step: 3, title: 'T', submitted: 451, call: { kind: 'remark', text: 'x' } })
    expect(readDraft('{"step": 9, "call": {"kind": "evil"}, "submitted": -1}')).toMatchObject({ step: 0, call: EMPTY_DRAFT.call, submitted: null })
    expect(readDraft('not json')).toEqual(EMPTY_DRAFT)
  })
  it('links the discussion it started from', () => {
    expect(discussionLine({ postId: '42', title: 'Fund [the] audit' })).toBe('Discussed in [Fund the audit](/discussions/42).')
  })
  it('encodes a remark as UTF-8', () => {
    expect(utf8Hex('hé')).toBe('0x68c3a9')
  })
})
