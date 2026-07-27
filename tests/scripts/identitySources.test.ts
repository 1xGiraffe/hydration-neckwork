import { describe, expect, it } from 'vitest'
import type { IdentityChain } from '../../src/scripts/identityChains.ts'
import {
  registrationFrom,
  resolveIdentityRows,
  subIdentityFrom,
  tombstoneRow,
  usernameFrom,
  type ChainIdentityState,
} from '../../src/scripts/identitySources.ts'

// Shapes here are the ones the live chains actually return: identity v2 on the
// People chains (matrix/github/discord, no `additional`) and v1 on Hydration
// (`additional`/`riot`). Both must decode through one path, or a chain added later
// silently contributes nothing.
const raw = (text: string) => {
  const hex = Buffer.from(text, 'utf8').toString('hex')
  return { __kind: `Raw${Buffer.byteLength(text, 'utf8')}`, value: `0x${hex}` }
}
const none = { __kind: 'None' }
const bytes = (text: string) => `0x${Buffer.from(text, 'utf8').toString('hex')}`

const peopleRegistration = (display: string, judgements: unknown[] = []) => ({
  judgements,
  deposit: '2010100000',
  info: { display: raw(display), legal: none, web: raw('https://a.example'), matrix: raw('@a:matrix.org'), email: raw('a@example.com'), image: none, twitter: raw('@a'), github: none, discord: none },
})

const hydrationRegistration = (display: string, judgements: unknown[] = []) => ({
  judgements,
  deposit: '50000000000000',
  info: { additional: [[raw('Discord'), raw('someone')]], display: raw(display), legal: none, web: raw('https://h.example'), riot: none, email: raw('h@example.com'), image: none, twitter: raw('@h') },
})

// Every fixture here carries an `info`, so decoding one never comes back null.
const decoded = (value: unknown) => {
  const registration = registrationFrom(value)
  if (registration == null) throw new Error('fixture did not decode as a registration')
  return registration
}

const account = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const chain = (key: string, priority: number): IdentityChain => ({ key, url: 'https://rpc.example', block: null, priority })
const emptyState = (): ChainIdentityState => ({ registrations: new Map(), subs: new Map(), usernames: new Map() })
const UPDATED_AT = '2026-07-27 12:00:00'

const rowsByAccount = (state: ChainIdentityState, source = chain('polkadot-people', 1)) =>
  new Map(resolveIdentityRows(state, source, UPDATED_AT).map(row => [row.account_id, row]))

describe('identity registration decoding', () => {
  it('reads display, contacts and a registrar judgement from identity v2', () => {
    expect(registrationFrom(peopleRegistration('Jaco', [[1, { __kind: 'Reasonable' }]]))).toEqual({
      display: 'Jaco', verified: true, email: 'a@example.com', web: 'https://a.example', twitter: '@a',
    })
  })

  it('reads the same fields from identity v1', () => {
    expect(registrationFrom(hydrationRegistration('Snakenet #1', [[0, { __kind: 'KnownGood' }]]))).toEqual({
      display: 'Snakenet #1', verified: true, email: 'h@example.com', web: 'https://h.example', twitter: '@h',
    })
  })

  it('accepts the [Registration, Option<Username>] tuple some runtimes return', () => {
    expect(registrationFrom([peopleRegistration('Tupled'), null])?.display).toBe('Tupled')
  })

  it('treats an unjudged registration as unverified', () => {
    expect(decoded(peopleRegistration('Fresh')).verified).toBe(false)
  })

  it('ignores judgements that are not a registrar vouching', () => {
    for (const kind of ['FeePaid', 'Unknown', 'Erroneous', 'LowQuality', 'OutOfDate']) {
      expect(decoded(peopleRegistration('X', [[0, { __kind: kind }]])).verified).toBe(false)
    }
  })

  it('yields no display for a hashed Data variant', () => {
    const hashed = { judgements: [], info: { display: { __kind: 'Sha256', value: '0x' + '11'.repeat(32) } } }

    expect(decoded(hashed).display).toBe('')
  })

  it('round-trips a multi-byte display name', () => {
    expect(decoded(peopleRegistration('09🚀')).display).toBe('09🚀')
  })

  it('decodes a sub-identity and a username', () => {
    expect(subIdentityFrom([account(9), raw('UTXO-Stash')])).toEqual({ parent: account(9), name: 'UTXO-Stash' })
    expect(usernameFrom(bytes('finetuned.dot'))).toBe('finetuned.dot')
  })
})

describe('identity display resolution', () => {
  it('prefers the account\'s own registration', () => {
    const state = emptyState()
    state.registrations.set(account(1), decoded(peopleRegistration('Own Name', [[1, { __kind: 'Reasonable' }]])))
    state.usernames.set(account(1), 'own.dot')

    expect(rowsByAccount(state).get(account(1))).toMatchObject({ display: 'Own Name', verified: 1, email: 'a@example.com' })
  })

  it('names a sub-identity Parent/Sub and inherits the parent judgement', () => {
    const state = emptyState()
    state.registrations.set(account(1), decoded(peopleRegistration('Exchange', [[1, { __kind: 'KnownGood' }]])))
    state.subs.set(account(2), { parent: account(1), name: 'Hot Wallet' })

    // The parent's email/web belong to the parent, so the sub carries none.
    expect(rowsByAccount(state).get(account(2))).toMatchObject({
      display: 'Exchange/Hot Wallet', verified: 1, email: '', web: '', twitter: '',
    })
  })

  it('skips a sub whose parent has no display name', () => {
    const state = emptyState()
    state.subs.set(account(2), { parent: account(1), name: 'Validator2' })

    expect(rowsByAccount(state).has(account(2))).toBe(false)
  })

  it('skips an account that is its own super and has no display of its own', () => {
    const state = emptyState()
    state.subs.set(account(1), { parent: account(1), name: 'Arise' })

    expect(rowsByAccount(state).has(account(1))).toBe(false)
  })

  it('falls back to the primary username, unverified', () => {
    const state = emptyState()
    state.usernames.set(account(3), 'superdupont.id')

    // A username is an allocation, not a registrar judgement.
    expect(rowsByAccount(state).get(account(3))).toMatchObject({ display: 'superdupont.id', verified: 0 })
  })

  it('drops an account whose registration has no display name', () => {
    const state = emptyState()
    state.registrations.set(account(4), decoded(peopleRegistration('')))

    expect(rowsByAccount(state).size).toBe(0)
  })

  it('stamps every row with its chain and display priority', () => {
    const state = emptyState()
    state.registrations.set(account(5), decoded(hydrationRegistration('Local')))

    expect(rowsByAccount(state, chain('hydration', 0)).get(account(5))).toMatchObject({
      chain: 'hydration', priority: 0, updated_at: UPDATED_AT,
    })
  })

  it('retires an account with a blank display the API filters out', () => {
    expect(tombstoneRow(chain('kusama-people', 2), account(6), UPDATED_AT)).toEqual({
      chain: 'kusama-people', account_id: account(6), display: '', verified: 0, email: '', web: '', twitter: '', priority: 2, updated_at: UPDATED_AT,
    })
  })
})
