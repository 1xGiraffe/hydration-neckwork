import { describe, expect, it } from 'vitest'
import { journeyIsOwnRemoteSend, journeyStartedHere } from '../src/services/explorerService.ts'

// A message topic id travels with every leg that carries it, so the journey it
// resolves to is not always the leg the row represents. These two predicates decide
// which END of a resolved journey names the counterparty — reading the origin end
// unconditionally is what made rows render "Hydration → Hydration".

const HYDRATION = 'urn:ocn:polkadot:2034'
const ASSETHUB = 'urn:ocn:polkadot:1000'
const ETHEREUM = 'urn:ocn:ethereum:1'
const ACCOUNT = '0x' + 'f2'.repeat(32)
const TX = '0x' + 'ab'.repeat(32)

function journey(over: Partial<Parameters<typeof journeyIsOwnRemoteSend>[0]> = {}) {
  return { origin: ASSETHUB, destination: HYDRATION, from: ACCOUNT, originTx: TX, ...over }
}

describe('journeyStartedHere', () => {
  it('is true only when the journey origin is Hydration itself', () => {
    expect(journeyStartedHere({ origin: HYDRATION })).toBe(true)
    expect(journeyStartedHere({ origin: ASSETHUB })).toBe(false)
    expect(journeyStartedHere({ origin: ETHEREUM })).toBe(false)
    expect(journeyStartedHere({ origin: '' })).toBe(false)
  })
})

describe('journeyIsOwnRemoteSend', () => {
  // The HOLLAR AssetHub round trip: an inbound message makes Hydration send one back,
  // and the leg we send is recorded with Hydration as the ORIGIN. It has no origin
  // account and no origin extrinsic precisely because no one signed it here.
  it('accepts a Hydration-origin journey with no signer and no origin extrinsic', () => {
    expect(journeyIsOwnRemoteSend(journey({ origin: HYDRATION, destination: ASSETHUB, from: '', originTx: null }))).toBe(true)
    expect(journeyIsOwnRemoteSend(journey({ origin: HYDRATION, destination: ETHEREUM, from: '', originTx: null }))).toBe(true)
  })

  // A journey that began in a signed extrinsic here belongs to some other row: the
  // rows this runs for have no extrinsic at all, so they cannot have originated it.
  it('rejects a Hydration-origin journey that a local extrinsic sent', () => {
    expect(journeyIsOwnRemoteSend(journey({ origin: HYDRATION, destination: ETHEREUM, from: '', originTx: TX }))).toBe(false)
    expect(journeyIsOwnRemoteSend(journey({ origin: HYDRATION, destination: ETHEREUM, from: ACCOUNT, originTx: null }))).toBe(false)
  })

  it('rejects a journey with no far end to read, or with Hydration at both ends', () => {
    expect(journeyIsOwnRemoteSend(journey({ origin: HYDRATION, destination: '', from: '', originTx: null }))).toBe(false)
    expect(journeyIsOwnRemoteSend(journey({ origin: HYDRATION, destination: HYDRATION, from: '', originTx: null }))).toBe(false)
  })

  it('rejects the ordinary case — a journey that arrived here from elsewhere', () => {
    expect(journeyIsOwnRemoteSend(journey())).toBe(false)
    expect(journeyIsOwnRemoteSend(journey({ from: '', originTx: null }))).toBe(false)
  })
})
