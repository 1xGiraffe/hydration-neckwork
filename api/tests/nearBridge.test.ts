import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  foldManagerTx,
  nearRecipientFromRefund,
  parseNttEventLog,
  pickZcashSender,
  zcashDepositOrigin,
  zcashInputAddresses,
  type FastNearTx,
  type ManagerEvents,
} from '../src/services/nearBridge.ts'

// Two real FastNear transactions (logs trimmed to receipts that logged), in this order:
// - HXaLvq… (second): omni-relayer verifies a Zcash deposit on zcash-connector, which mints
//   zec.omft.near to the ZEC manager; the manager sends it to Hydration (VAA seq 5).
// - E2Mm4k… (first): the ZEC manager redeems Hydration's send of 0.005 ZEC (block 15788869).
const [CREDIT, DEPOSIT] = JSON.parse(readFileSync(new URL('./fixtures/near-zec-bridge-txs.json', import.meta.url), 'utf8')) as FastNearTx[]
const MANAGER = 'ntt-zec.hydration-whm.near'

describe('parseNttEventLog', () => {
  it('reads whm-ntt events and ignores every other log', () => {
    const line = 'EVENT_JSON:{"standard":"whm-ntt","version":"1.0.0","event":"transfer_received","data":[{"account":"a.near","amount":"1"}]}'
    expect(parseNttEventLog(line)).toEqual([{ event: 'transfer_received', data: { account: 'a.near', amount: '1' } }])
    expect(parseNttEventLog('EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[{}]}')).toEqual([])
    expect(parseNttEventLog('EVENT_JSON:{not json')).toEqual([])
    expect(parseNttEventLog('wormhole/src/lib.rs#415: publish_message')).toEqual([])
  })
})

describe('zcash deposits', () => {
  // The deposit's only transparent input, cross-checked on Blockchair.
  it('names the address that signed the Zcash transaction', () => {
    const args = JSON.parse(Buffer.from((DEPOSIT.transaction.actions[0] as { FunctionCall: { args: string } }).FunctionCall.args, 'base64').toString('utf8'))
    expect(zcashInputAddresses(Uint8Array.from(Buffer.from(args.tx_bytes, 'base64')))).toEqual(['t1aeEaUKb9mmnzfkf5hwb8iBD8yntpa9i62'])
  })

  it('reads the origin as Zcash, with the Zcash transaction from the connector log', () => {
    expect(zcashDepositOrigin(DEPOSIT)).toEqual({
      chain: 'Zcash',
      account: { address: 't1aeEaUKb9mmnzfkf5hwb8iBD8yntpa9i62', url: 'https://blockchair.com/zcash/address/t1aeEaUKb9mmnzfkf5hwb8iBD8yntpa9i62' },
      txUrl: 'https://blockchair.com/zcash/transaction/9ec8a95bd40941c7cfed035b7e367e14b367417c1ca9305fdde821e72f9a6555',
    })
  })

  it('is not a Zcash deposit when the connector is not the receiver', () => {
    expect(zcashDepositOrigin(CREDIT)).toBeNull()
  })

  it('tells unreadable bytes from a transaction with no transparent input', () => {
    expect(zcashInputAddresses(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(zcashInputAddresses(new Uint8Array(40))).toBeNull()
    // v6 header, then version group, branch, lock time, expiry, and zero inputs.
    const shielded = new Uint8Array(21); shielded.set([6, 0, 0, 0x80]); shielded[20] = 0
    expect(zcashInputAddresses(shielded)).toEqual([])
  })
})

describe('foldManagerTx', () => {
  it('keys a send by its wormhole sequence, with the real (Zcash) origin rather than the connector', () => {
    const into: ManagerEvents = { sent: new Map(), received: [] }
    foldManagerTx(MANAGER, DEPOSIT, into)
    expect(into.received).toEqual([])
    expect(into.sent.get('5')?.origin.chain).toBe('Zcash')
    expect(into.sent.get('5')?.origin.account?.address).toBe('t1aeEaUKb9mmnzfkf5hwb8iBD8yntpa9i62')
  })

  it('records the account a redeem credited', () => {
    const into: ManagerEvents = { sent: new Map(), received: [] }
    foldManagerTx(MANAGER, CREDIT, into)
    expect(into.received).toEqual([{
      account: '0952c20ad87a71bfa5177b0e37e274e109d0d9b54544ab228e0051a42cb15804',
      // sha256 of the account id: the recipient Hydration's TransferSent named.
      accountHash: 'a8e92983a580e928180177795abae2e55b8734491b94859a7821489afd286af6',
      amount: '500000',
      txHash: 'E2Mm4kxt8zZkQUZa1N4yeNW1p4hbt5QDexvN14VPJFfw',
    }])
  })

  it('ignores events another contract logged', () => {
    const into: ManagerEvents = { sent: new Map(), received: [] }
    foldManagerTx('ntt-near.hydration-whm.near', CREDIT, into)
    expect(into.received).toEqual([])
  })
})

describe('nearRecipientFromRefund', () => {
  const recipient = '0xa8e92983a580e928180177795abae2e55b8734491b94859a7821489afd286af6'
  it('names the implicit account a refund address hashes to', () => {
    expect(nearRecipientFromRefund(recipient, '0x0952c20ad87a71bfa5177b0e37e274e109d0d9b54544ab228e0051a42cb15804'))
      .toBe('0952c20ad87a71bfa5177b0e37e274e109d0d9b54544ab228e0051a42cb15804')
  })
  // Most sends set the refund address equal to the recipient hash, which names nothing.
  it('names nothing when the refund address is not the preimage', () => {
    expect(nearRecipientFromRefund(recipient, recipient)).toBeNull()
  })
})

describe('pickZcashSender', () => {
  it('takes a lone input address', () => {
    expect(pickZcashSender(['t1a'], 't1z')).toBe('t1a')
  })
  // Real deposit d264f3…: two inputs, refund t1Y7G8… is one of them (VAA seq 6).
  it('takes the refund address only when it is one of several inputs', () => {
    expect(pickZcashSender(['t1Y7G8NbdtABWUt92fon1RkoAAW7atkfv5V', 't1PFhjkTFwTPLEc3QcoKzHZzrPVTdgaTgv8'], 't1Y7G8NbdtABWUt92fon1RkoAAW7atkfv5V'))
      .toBe('t1Y7G8NbdtABWUt92fon1RkoAAW7atkfv5V')
    // Real deposit 570cf1… (seq 1): its refund address spent nothing in it.
    expect(pickZcashSender(['t1ZTVHzrYpQjT5UjSBXCaeo7fnKm8zugHcc', 't1S7xVdgqdKKhbdvgPKfWk7QPgejSrnMYAB'], 't1XVScGCcXkcrUaFtHg1YVzos1FXmbiG5dy')).toBeNull()
    expect(pickZcashSender([], 't1a')).toBeNull()
  })
})
