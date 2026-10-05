import { describe, expect, it } from 'vitest'
import {
  buildPeerHistories,
  changeOriginFromEvents,
  classifyLegs,
  decodeAbiString,
  lockboxPayout,
  messageForDigest,
  nttDigest,
  parsePeerEvent,
  peerEvidence,
  resolveOriginRpcUrls,
  sumBackingLegs,
  TOPIC,
  transceiverMessagesIn,
  WORMHOLE_CHAINS,
  type BackingLeg,
  type LockboxPayoutInput,
  type PeerChange,
} from '../src/services/wormholeNtt.ts'

// The multi-peer model: an NTT asset is one token over several chains, each of
// which either locks it (a lockbox) or mints it (a spoke), with Hydration as one
// of those chains. Fixtures are the live 2026-10-05 deployment: WETH minted on
// Hydration against Ethereum and Robinhood lockboxes, HDX locked on
// Hydration against a Robinhood spoke.

const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0')
const addr32 = (h160: string) => '0x' + h160.replace(/^0x/, '').toLowerCase().padStart(64, '0')

const WETH_MANAGER = '0xb5cef790d52a57fa619ed96edd64c5328f3dcfb7'
const WETH_TRANSCEIVER = '0x8acce9ca511d5d7213f8c3f813b8916087cd00ae'
const ETH_LOCKBOX = '0x283b14b5dd352e32154df014ea96834f395e04b6'
const RH_LOCKBOX = '0xb1a2abcbc1fa276212f6ed239645161deea9861a'
const DEPLOYER = '0x71feb8b2849101a6e62e3369eaafdc6154cd0bc0'
const MOTION_387 = '0x15aecaa1590cb1d7eb984e0195e6f8e88a222e5b1673970e823467f70ae97d2e'

const peerUpdatedLog = (chainId: number, peer: string | null, decimals: number) => ({
  topics: [TOPIC.peerUpdated, '0x' + word(chainId)],
  data: '0x' + word(0) + word(0) + (peer ? addr32(peer).slice(2) : word(0)) + word(decimals),
})

const change = (over: Partial<PeerChange> & { event: PeerChange['event'] }): PeerChange => ({
  contract: WETH_MANAGER,
  blockHeight: 1,
  eventIndex: 0,
  extrinsicIndex: 2,
  timestampMs: 0,
  origin: { kind: 'unknown' },
  ...over,
})

describe('peer registrations from the managers’ own events', () => {
  it('decodes PeerUpdated with the chain from topic1 and the new peer from data', () => {
    // The live WETH → Robinhood registration (TC motion 387, block 14,653,644).
    const log = peerUpdatedLog(72, RH_LOCKBOX, 18)
    expect(parsePeerEvent(log.topics, log.data)).toEqual({ kind: 'manager', chainId: 72, peer: addr32(RH_LOCKBOX), decimals: 18 })
  })

  it('decodes the transceiver’s SetWormholePeer, both fields in data', () => {
    const data = '0x' + word(72) + addr32('0x1352881a04cb9f9f5fb8442bc925e99ec15d3642').slice(2)
    expect(parsePeerEvent([TOPIC.wormholePeerSet], data)).toEqual({
      kind: 'transceiver', chainId: 72, peer: addr32('0x1352881a04cb9f9f5fb8442bc925e99ec15d3642'), decimals: null,
    })
  })

  it('reads a cleared peer as null and an unrelated log as nothing', () => {
    const cleared = peerUpdatedLog(2, null, 0)
    expect(parsePeerEvent(cleared.topics, cleared.data)?.peer).toBeNull()
    expect(parsePeerEvent([TOPIC.transferSent], '0x')).toBeNull()
  })

  it('builds each chain’s history over time: when a peer was added, re-pointed and cleared', () => {
    const eth = parsePeerEvent(peerUpdatedLog(2, ETH_LOCKBOX, 18).topics, peerUpdatedLog(2, ETH_LOCKBOX, 18).data)!
    const rh = parsePeerEvent(peerUpdatedLog(72, RH_LOCKBOX, 18).topics, peerUpdatedLog(72, RH_LOCKBOX, 18).data)!
    const moved = { ...rh, peer: addr32('0x' + 'ab'.repeat(20)) }
    const histories = buildPeerHistories([
      // Out of order and with a replayed duplicate: the history is by on-chain
      // position, so neither changes the answer.
      change({ blockHeight: 15_000_000, eventIndex: 3, event: moved }),
      change({ blockHeight: 14_653_644, eventIndex: 15, event: rh, origin: { kind: 'technical-committee', proposalHash: MOTION_387, motionIndex: 387 } }),
      change({ blockHeight: 13_381_902, eventIndex: 9, event: eth, origin: { kind: 'account', account: DEPLOYER } }),
      change({ blockHeight: 13_381_902, eventIndex: 9, event: eth, origin: { kind: 'account', account: DEPLOYER } }),
    ])
    const weth = histories.get(WETH_MANAGER)!
    expect([...weth.keys()].sort((a, b) => a - b)).toEqual([2, 72])
    expect(weth.get(2)!.changes).toHaveLength(1)
    expect(weth.get(2)!.current?.event.peer).toBe(addr32(ETH_LOCKBOX))
    const robinhood = weth.get(72)!
    // Added by the motion, then re-pointed: `first` is when the asset gained the
    // chain, `current` what is in force now.
    expect(robinhood.first.blockHeight).toBe(14_653_644)
    expect(robinhood.first.origin).toEqual({ kind: 'technical-committee', proposalHash: MOTION_387, motionIndex: 387 })
    expect(robinhood.current?.event.peer).toBe(addr32('0x' + 'ab'.repeat(20)))
    expect(robinhood.changes.map(c => c.blockHeight)).toEqual([14_653_644, 15_000_000])

    const cleared = buildPeerHistories([
      change({ blockHeight: 1, event: eth }),
      change({ blockHeight: 2, event: { ...eth, peer: null } }),
    ])
    expect(cleared.get(WETH_MANAGER)!.get(2)!.current).toBeNull()
  })

  it('names who made a change from the carrying extrinsic’s events', () => {
    const motion = changeOriginFromEvents(2, [
      { eventName: 'TechnicalCommittee.Approved', args: { proposalHash: MOTION_387 } },
      { eventName: 'TechnicalCommittee.Executed', args: { proposalHash: MOTION_387, result: { __kind: 'Ok' } } },
    ], new Map([[MOTION_387, 387]]))
    expect(motion).toEqual({ kind: 'technical-committee', proposalHash: MOTION_387, motionIndex: 387 })
    expect(changeOriginFromEvents(2, [{ eventName: 'Ethereum.Executed', args: { from: DEPLOYER.toUpperCase().replace('0X', '0x'), to: WETH_TRANSCEIVER } }]))
      .toEqual({ kind: 'account', account: DEPLOYER })
    expect(changeOriginFromEvents(null, [])).toEqual({ kind: 'scheduled' })
    expect(changeOriginFromEvents(3, [{ eventName: 'Balances.Withdraw', args: {} }])).toEqual({ kind: 'unknown' })
  })

  it('grades the live answer against the indexed history', () => {
    expect(peerEvidence(addr32(ETH_LOCKBOX), addr32(ETH_LOCKBOX))).toBe('confirmed')
    expect(peerEvidence(addr32(ETH_LOCKBOX), null)).toBe('index-only')
    expect(peerEvidence(null, addr32(RH_LOCKBOX))).toBe('live-only')
    expect(peerEvidence(addr32(ETH_LOCKBOX), addr32(RH_LOCKBOX))).toBe('mismatch')
    expect(peerEvidence(null, null)).toBeNull()
  })
})

describe('the chain table', () => {
  it('knows Robinhood (72) and HyperEVM (47) with their own EVM chain ids and public endpoints', () => {
    expect(WORMHOLE_CHAINS[72]).toMatchObject({ name: 'Robinhood', evmChainId: 4663, layer: 'l2' })
    expect(WORMHOLE_CHAINS[47]).toMatchObject({ name: 'HyperEVM', evmChainId: 999, layer: 'other' })
    expect(WORMHOLE_CHAINS[2].riskNote).toBeNull()
    expect(WORMHOLE_CHAINS[72].riskNote).toMatch(/L2/)
  })

  it('layers the deployment’s endpoints over the public ones, the deployment winning', () => {
    const urls = resolveOriginRpcUrls(new Map([[2, 'https://eth.example'], [72, 'https://keyed-robinhood.example']]))
    expect(urls.get(2)).toBe('https://eth.example')
    expect(urls.get(72)).toBe('https://keyed-robinhood.example')
    expect(urls.get(47)).toBe('https://rpc.hyperliquid.xyz/evm')
    // Hydration is never an origin to be read over JSON-RPC from this table.
    expect(urls.has(73)).toBe(false)
    expect(resolveOriginRpcUrls(new Map()).get(72)).toBe('https://rpc.mainnet.chain.robinhood.com')
  })
})

const WETH = { decimals: 18, symbol: 'WETH', priceUsd: 4_400 }
const e18 = (whole: string) => {
  const [i, f = ''] = whole.split('.')
  return BigInt(i + f.padEnd(18, '0'))
}
const baseInput = {
  inflightIn: 0n, inflightOut: 0n, queued: 0n,
  decimals: WETH.decimals, symbol: WETH.symbol, priceUsd: WETH.priceUsd,
  indexLagMs: 30_000, scanEnabled: true, lookbackDays: 14, downgradeConfirmed: true,
}
const leg = (over: Partial<BackingLeg> & Pick<BackingLeg, 'chainId' | 'role' | 'amount'>): BackingLeg => ({ burned: null, fresh: true, readable: true, ...over })

describe('the backing equation over every leg', () => {
  it('sums two lockboxes against Hydration’s minted supply (WETH: Ethereum + Robinhood)', () => {
    const legs = [
      leg({ chainId: 73, role: 'spoke', amount: e18('70.655976376348102811'), burned: 0n }),
      leg({ chainId: 2, role: 'lockbox', amount: e18('61.70971223') }),
      leg({ chainId: 72, role: 'lockbox', amount: e18('8.95591664') }),
    ]
    const verdict = classifyLegs(baseInput, legs)
    expect(verdict.sums.locked).toBe(e18('70.66562887'))
    expect(verdict.sums.lockboxes).toBe(2)
    // The +0.00965 WETH seed offset left by the 2026-07 migration: spare custody.
    expect(verdict.residual).toBe(e18('70.66562887') - e18('70.655976376348102811'))
    expect(verdict.status).toBe('surplus')
    // Reading only the registry origin would have called the same state a deficit.
    const ethOnly = classifyLegs(baseInput, legs.filter(l => l.chainId !== 72))
    expect(ethOnly.status).toBe('deficit')
  })

  it('reads a Hydration-locked asset the other way round (HDX: Hydration custody vs Robinhood supply)', () => {
    const hdx = { ...baseInput, decimals: 12, symbol: 'HDX', priceUsd: 0.01 }
    const legs = [
      leg({ chainId: 73, role: 'lockbox', amount: 106_000_000_000_000n }),
      leg({ chainId: 72, role: 'spoke', amount: 106_000_000_000_000n, burned: 0n }),
    ]
    const verdict = classifyLegs(hdx, legs)
    expect(verdict.status).toBe('ok')
    expect(verdict.residual).toBe(0n)
    // A spoke minting beyond the lockbox is supply without backing.
    const over = classifyLegs(hdx, [legs[0], { ...legs[1], amount: 1_106_000_000_000_000n }])
    expect(over.status).toBe('deficit')
    expect(over.residual).toBe(-1_000_000_000_000_000n)
  })

  it('adds a burning peer’s supply to the claims and nets its dead-address balance', () => {
    const legs = [
      leg({ chainId: 73, role: 'spoke', amount: e18('10'), burned: e18('1') }),
      leg({ chainId: 30, role: 'spoke', amount: e18('5'), burned: 0n }),
      leg({ chainId: 2, role: 'lockbox', amount: e18('14') }),
    ]
    const sums = sumBackingLegs(legs)
    expect(sums.issuance).toBe(e18('15'))
    expect(sums.burned).toBe(e18('1'))
    expect(classifyLegs(baseInput, legs).residual).toBe(0n)
  })

  // A spoke's dead-address balance is subtracted from its supply. Read as zero
  // when it went unanswered, everything retired there would be a shortfall.
  it('holds the asset at unverified when a spoke’s dead-address balance went unread', () => {
    const hdx = { ...baseInput, decimals: 12, symbol: 'HDX', priceUsd: 0.01 }
    const legs = [
      leg({ chainId: 73, role: 'lockbox', amount: 106_000_000_000_000n }),
      leg({ chainId: 72, role: 'spoke', amount: 1_106_000_000_000_000n, burned: null, burnedExpected: true }),
    ]
    const verdict = classifyLegs(hdx, legs)
    expect(verdict.status).toBe('unverified')
    expect(verdict.sums.burnUnread).toEqual([72])
    expect(verdict.detail).toContain('dead address on Robinhood')
    // A chain that burns for real has no dead-address term to miss.
    expect(classifyLegs(hdx, [legs[0], { ...legs[1], burnedExpected: false }]).status).toBe('deficit')
  })

  it('holds the asset at unverified, naming the chain, when a peer has no endpoint', () => {
    const legs = [
      leg({ chainId: 73, role: 'spoke', amount: e18('70.66') }),
      leg({ chainId: 2, role: 'lockbox', amount: e18('61.71') }),
      leg({ chainId: 72, role: 'lockbox', amount: null, readable: false, fresh: false }),
    ]
    const verdict = classifyLegs(baseInput, legs)
    // Without Robinhood the sum reads short — but that is not a finding.
    expect(verdict.status).toBe('unverified')
    expect(verdict.detail).toContain('Robinhood (lockbox, no endpoint configured)')
    expect(verdict.sums.unreadable).toEqual([72])
    // …and a chain that answered nothing this cycle is named the same way.
    const unread = classifyLegs(baseInput, [legs[0], legs[1], { ...legs[2], readable: true }])
    expect(unread.status).toBe('unverified')
    expect(unread.detail).toContain('did not answer')
  })

  it('stays unconfigured when no lockbox at all can be read', () => {
    const verdict = classifyLegs(baseInput, [
      leg({ chainId: 73, role: 'spoke', amount: e18('1') }),
      leg({ chainId: 21, role: 'lockbox', amount: null, readable: false }),
    ])
    expect(verdict.status).toBe('unconfigured')
  })

  it('never grades a shortfall built on a carried-over leg', () => {
    const verdict = classifyLegs(baseInput, [
      leg({ chainId: 73, role: 'spoke', amount: e18('70') }),
      leg({ chainId: 2, role: 'lockbox', amount: e18('60'), fresh: false }),
      leg({ chainId: 72, role: 'lockbox', amount: e18('5') }),
    ])
    expect(verdict.status).toBe('unverified')
  })
})

describe('what one lockbox can pay out', () => {
  const tol = 10n ** 15n
  const robinhood: LockboxPayoutInput = {
    balance: e18('8.95591664'),
    received: e18('8.97048711'),
    sent: e18('0.01457047'),
    pendingIn: 0n,
    pendingOut: 0n,
    inboundCapacity: e18('69'),
    circulating: e18('70.655976376348102811'),
    tolerance: tol,
    fresh: true,
    sharedWith: [],
    symbol: 'WETH',
    decimals: 18,
  }

  it('covers the net it took in, with nothing funded outside Wormhole (Robinhood, born with NTT)', () => {
    const out = lockboxPayout(robinhood)
    expect(out.status).toBe('ok')
    expect(out.netFlow).toBe(e18('8.95591664'))
    expect(out.baseline).toBe(0n)
    expect(out.capacity).toBe(e18('8.95591664'))
    // Its own limit lets 69 WETH a day through toward it: smaller than its limit
    // is a fact worth saying, not a fault — the verdict stays ok.
    expect(out.potential).toBe(e18('69'))
    expect(out.coversPotential).toBe(false)
    expect(out.detail).toContain('could be sent toward it')
  })

  it('states a seed funded outside Wormhole as baseline (Ethereum, the 2026-07 migration)', () => {
    const out = lockboxPayout({ ...robinhood, balance: e18('61.70971223'), received: e18('27.74318885'), sent: e18('25.96110044'), inboundCapacity: e18('10000') })
    expect(out.status).toBe('ok')
    expect(out.baseline).toBe(e18('59.92762382'))
    expect(out.detail).toContain('funded with outside Wormhole')
  })

  it('is attention when it has released more than the flows through Hydration put in', () => {
    const out = lockboxPayout({ ...robinhood, balance: e18('3') })
    expect(out.status).toBe('attention')
    expect(out.baseline! < 0n).toBe(true)
    expect(out.detail).toContain('cannot cover what holders could send back to it')
  })

  it('is attention when transfers already burned toward it exceed its custody', () => {
    const out = lockboxPayout({ ...robinhood, received: e18('20'), sent: e18('0'), balance: e18('8.95'), pendingOut: e18('12') })
    expect(out.status).toBe('attention')
    expect(out.capacity! < 0n).toBe(true)
  })

  it('is unverified, never attention, on a carried-over balance, a shared lockbox or an unmeasured flow', () => {
    expect(lockboxPayout({ ...robinhood, balance: e18('3'), fresh: false }).status).toBe('unverified')
    expect(lockboxPayout({ ...robinhood, sharedWith: [2] }).status).toBe('unverified')
    expect(lockboxPayout({ ...robinhood, received: null }).status).toBe('unverified')
    expect(lockboxPayout({ ...robinhood, balance: null }).status).toBe('unverified')
  })
})

// A TransceiverMessage as the wire carries it, built here byte by byte rather
// than with the parser under test.
function transceiverMessage(o: { amount: bigint; decimals: number; recipient: string; toChain: number; id: string }): { payload: string; managerMessage: string } {
  const transfer = '994e5454' + o.decimals.toString(16).padStart(2, '0') + o.amount.toString(16).padStart(16, '0')
    + addr32('0x0bd7d308f8e1639fab988df18a8011f41eacad73').slice(2) + addr32(o.recipient).slice(2) + o.toChain.toString(16).padStart(4, '0')
  const managerMessage = o.id.replace(/^0x/, '').padStart(64, '0') + addr32(DEPLOYER).slice(2)
    + (transfer.length / 2).toString(16).padStart(4, '0') + transfer
  const payload = '9945ff10' + addr32(RH_LOCKBOX).slice(2) + addr32(WETH_MANAGER).slice(2)
    + (managerMessage.length / 2).toString(16).padStart(4, '0') + managerMessage + '0000'
  return { payload, managerMessage: '0x' + managerMessage }
}

describe('inbound amounts from the delivering call', () => {
  it('finds the executed payload by its NTT digest anywhere in the call arguments', () => {
    const a = transceiverMessage({ amount: 897_048_711n, decimals: 8, recipient: '0x' + '11'.repeat(20), toChain: 73, id: '0x01' })
    const b = transceiverMessage({ amount: 5n, decimals: 8, recipient: '0x' + '22'.repeat(20), toChain: 73, id: '0x02' })
    // A VAA body wraps the payload behind its own header; a relayer batch holds
    // several. The scan does not care where they sit.
    const callArgs = JSON.stringify({ transaction: { value: { input: '0xf953cec7' + '00'.repeat(51) + a.payload + 'ff' + b.payload } } })
    const found = transceiverMessagesIn(callArgs)
    expect(found).toHaveLength(2)
    const digest = nttDigest(72, a.managerMessage)
    const match = messageForDigest(found, 72, digest)
    expect(match?.transfer.trimmedAmount).toBe(897_048_711n)
    expect(match?.transfer.recipient).toBe(addr32('0x' + '11'.repeat(20)))
    // The source chain is part of the digest: the same bytes from another chain are another message.
    expect(messageForDigest(found, 2, digest)).toBeNull()
  })

  it('finds nothing in a call that carries no NTT payload', () => {
    expect(transceiverMessagesIn('{"proposal":"0x1234"}')).toEqual([])
  })
})

describe('ERC-20 string answers', () => {
  it('decodes an ABI string and a bytes32 symbol, and refuses garbage', () => {
    const name = Buffer.from('Robinhood Token').toString('hex')
    const abi = '0x' + word(32) + word(15) + name.padEnd(64, '0')
    expect(decodeAbiString(abi)).toBe('Robinhood Token')
    expect(decodeAbiString('0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0'))).toBe('MKR')
    expect(decodeAbiString('0x')).toBeNull()
    expect(decodeAbiString(null)).toBeNull()
  })
})
