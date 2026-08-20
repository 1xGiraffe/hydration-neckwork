import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  renderNotification, accountNotation, accountText, shortAddress, moduleName,
  compactAmount, compactUsd, escapeHtml, explorerUrl, text, account, amount, usd, code,
  type RenderAccount,
} from '../src/notifications/render.ts'

const SS58 = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'
const EVM = '0x531a8b7f7ba36bfd8e0f0b62f2fcb2e2b8e2f99a'
const TREASURY = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'

const base = (over: Partial<RenderAccount> = {}): RenderAccount => ({
  accountId: '0x' + 'ab'.repeat(32), address: SS58, emoji: '🐍', ...over,
})

const ORIGIN = 'https://explorer.test'
let previousOrigin: string | undefined
beforeEach(() => { previousOrigin = process.env.EXPLORER_PUBLIC_URL; process.env.EXPLORER_PUBLIC_URL = ORIGIN })
afterEach(() => {
  if (previousOrigin === undefined) delete process.env.EXPLORER_PUBLIC_URL
  else process.env.EXPLORER_PUBLIC_URL = previousOrigin
})

describe('short address parity with ShortAddr', () => {
  it('keeps 4 leading characters for SS58 and 6 for 0x, and 5 trailing for both', () => {
    expect(shortAddress(SS58)).toBe('15Da…BDRLZ')
    expect(shortAddress(EVM)).toBe('0x531a…2f99a')
    // Nothing to shorten stays whole rather than growing an ellipsis.
    expect(shortAddress('short')).toBe('short')
  })
})

describe('account notation parity with AddrPill', () => {
  it('prefers the recipient\'s own list tag over everything else', () => {
    const n = accountNotation(base({
      userTag: { name: 'CAP cluster' }, tag: { name: 'Kraken' },
      identity: { display: 'someone', verified: true }, profile: { name: 'me' },
    }))
    expect(n.label).toBe('CAP cluster')
  })

  it('falls to the system tag next', () => {
    expect(accountNotation(base({ tag: { name: 'Kraken' }, profile: { name: 'me' } })).label).toBe('Kraken')
  })

  it('renders a module account as ⚙️ plus its pallet id', () => {
    expect(moduleName(TREASURY)).toBe('py/trsry')
    const n = accountNotation(base({ accountId: TREASURY, profile: { name: 'ignored' } }))
    expect(n).toMatchObject({ emoji: '⚙️', label: 'py/trsry' })
  })

  it('puts a self-set profile name above on-chain identity', () => {
    const n = accountNotation(base({ profile: { name: 'maf' }, identity: { display: 'chain name', verified: true } }))
    expect(n.label).toBe('maf')
  })

  it('marks a registrar-verified identity with ✓ and leaves an unverified one plain', () => {
    expect(accountNotation(base({ identity: { display: 'bkchr', verified: true } })).label).toBe('bkchr ✓')
    expect(accountNotation(base({ identity: { display: 'bkchr', verified: false } })).label).toBe('bkchr')
  })

  it('suffixes a verified contract name with the address tail (names are not unique)', () => {
    const n = accountNotation(base({ address: EVM, contractName: 'ERC1967Proxy' }))
    expect(n.label).toBe('ERC1967Proxy·99a')
  })

  it('falls through to the bare short address, and never repeats it', () => {
    expect(accountNotation(base()).label).toBeNull()
    expect(accountText(base())).toBe('🐍 15Da…BDRLZ')
    expect(accountText(base({ address: EVM }))).toBe('🐍 0x531a…2f99a')
    expect(accountText(base({ tag: { name: 'Kraken' } }))).toBe('🐍 Kraken (RLZ)')
  })
})

describe('rough amount scale', () => {
  // The same fixtures AGENTS.md pins for the UI's compactAmount.
  it('matches the explorer scale', () => {
    expect(compactAmount(500)).toBe('500')
    expect(compactAmount(537)).toBe('537')
    expect(compactAmount(4870)).toBe('4.87k')
    expect(compactAmount(40_000)).toBe('40k')
    expect(compactAmount(112_000)).toBe('112k')
    expect(compactAmount(4_590_000)).toBe('4.59M')
    expect(compactAmount(999_600_000)).toBe('1B')
    expect(compactAmount(0.12)).toBe('0.12')
    expect(compactAmount(0.0000007191)).toBe('0.0₅7191')
    expect(compactAmount(0)).toBe('0')
    expect(compactAmount(Number.NaN)).toBe('—')
  })
  it('compacts USD the same way', () => {
    expect(compactUsd(1_234_567)).toBe('$1.23M')
    expect(compactUsd(12_500)).toBe('$12.5k')
    expect(compactUsd(250)).toBe('$250')
    expect(compactUsd(0.12)).toBe('$0.12')
  })
})

describe('telegram HTML', () => {
  it('escapes &, <, > and the double quote in every user-derived text node', () => {
    expect(escapeHtml('A & B <script>')).toBe('A &amp; B &lt;script&gt;')
    // The same helper escapes values interpolated into an href, so a quote has
    // to close nothing.
    expect(escapeHtml('x" onmouseover="alert(1)')).toBe('x&quot; onmouseover=&quot;alert(1)')
    const rendered = renderNotification({
      title: [text('Activity by'), account(base({ identity: { display: '<b>evil</b> & co', verified: false } }))],
      body: [[text('swapped'), amount(4_590_000, 'HDX'), text('for'), usd(12_500)], [code('Router.Executed')]],
      path: '/account/' + SS58,
    })
    expect(rendered.telegramHtml).toContain('&lt;b&gt;evil&lt;/b&gt; &amp; co')
    expect(rendered.telegramHtml).not.toContain('<b>evil</b>')
    expect(rendered.title).toContain('<b>evil</b> & co')
  })

  it('renders a named account as emoji + bold label + linked address tail', () => {
    const rendered = renderNotification({
      title: 'Safety action',
      body: [[account(base({ tag: { name: 'Kraken' } }))]],
      path: '/security',
    })
    expect(rendered.telegramHtml).toContain(`🐍 <b>Kraken</b> (<a href="${ORIGIN}/account/${SS58}">RLZ</a>)`)
    // The headline itself carries the link — the message needs no separate
    // "open" line (and the OS notification preview stays free of link chrome).
    expect(rendered.telegramHtml.startsWith(`<a href="${ORIGIN}/security"><b>Safety action</b></a>`)).toBe(true)
    expect(rendered.telegramHtml).not.toContain('Open in explorer')
  })

  it('links a bare account once, without a duplicated label', () => {
    const rendered = renderNotification({ title: 'x', body: [[account(base())]], path: '/security' })
    expect(rendered.telegramHtml).toContain(`🐍 <a href="${ORIGIN}/account/${SS58}">15Da…BDRLZ</a>`)
  })

  // The emoji comes off an AccountRef the server assembled, so this is defence
  // in depth rather than a known injection — it is still markup position.
  it('escapes the account emoji too', () => {
    const rendered = renderNotification({ title: 'x', body: [[account(base({ emoji: '<b>' }))]], path: '/security' })
    expect(rendered.telegramHtml).toContain('&lt;b&gt;')
    expect(rendered.telegramHtml).not.toContain('<b><a href')
  })
})

describe('renderNotification', () => {
  it('produces title, body, both link forms and telegram markup from one payload', () => {
    const rendered = renderNotification({
      title: [text('Large trade')],
      body: [[account(base({ tag: { name: 'Kraken' } })), text('traded'), usd(1_234_567)]],
      path: '/activity',
    })
    expect(rendered).toMatchObject({
      title: 'Large trade',
      body: '🐍 Kraken (RLZ) traded $1.23M',
      // The site-relative path is what the inbox row and the SPA read; the
      // absolute url is for push payloads and Telegram.
      path: '/activity',
      url: `${ORIGIN}/activity`,
    })
  })

  it('uses the configured explorer origin and tolerates a trailing slash', () => {
    process.env.EXPLORER_PUBLIC_URL = `${ORIGIN}/`
    expect(explorerUrl('/notifications')).toBe(`${ORIGIN}/notifications`)
  })
})

// `moduleName` is the one renderer helper that duplicates a UI function rather
// than reproducing a described convention: a pallet account's name is decoded on
// both sides of the wire, and an account named ⚙️ py/trsry in the explorer must
// not read as a bare address in a message. Nothing but this test connects them.
describe('module-account decoding parity with the explorer', () => {
  const fnSource = (source: string): string | undefined =>
    source.match(/function moduleName\(accountId: string\): string \| null \{[\s\S]*?\n\}/)?.[0]
      ?.replace(/\s+/g, ' ')

  it('decodes a pallet account exactly the way explorer-ui does', () => {
    const ui = fnSource(readFileSync(new URL('../../explorer-ui/src/components/ui.tsx', import.meta.url), 'utf8'))
    const api = fnSource(readFileSync(new URL('../src/notifications/render.ts', import.meta.url), 'utf8'))
    expect(ui, 'explorer-ui ui.tsx no longer declares moduleName').toBeTruthy()
    expect(api).toBe(ui)
    expect(moduleName('0x6d6f646c70792f74727372790000000000000000000000000000000000000000')).toBe('py/trsry')
    expect(moduleName('0x' + 'ab'.repeat(32))).toBeNull()
  })
})
