import { describe, expect, it } from 'vitest'
import { subsquarePathTarget } from '../../src/governance/subsquare/explorerPaths.js'
import { foreignPageLabel, mayHoldSubsquareLink, rewriteSubsquareLinks, rewriteSubsquareText, subsquareUrlTarget } from '../../src/governance/subsquare/links.js'

// Links to Subsquare's Hydration pages in imported text → the explorer's own pages.

const HASH = '0x' + 'ab'.repeat(32)
const ADDR = '7KTFfPoa44KxwZsa5N3syqxoSPddApcioLEMUEjYY8cohVos'
const POLKADOT_ADDR = '13Gmvx1DBe5JqLMdrhwAb9NF66kXCQfFKtqdgNxKUSAYAHYc'
const md = (s: string) => rewriteSubsquareLinks(s, 'markdown')

describe('Subsquare path → explorer path', () => {
  const cases: Array<[string, string, string]> = [
    ['/referenda/12', '/referendum/opengov/12', 'Referendum #12'],
    ['/referenda/referendum/12', '/referendum/opengov/12', 'Referendum #12'],
    ['/referenda/12/votes', '/referendum/opengov/12', 'Referendum #12'],
    ['/posts/45', '/discussions/s45', 'Discussion #45'],
    ['/post/45', '/discussions/s45', 'Discussion #45'],
    ['/democracy/referenda/18', '/referendum/democracy/18', 'Democracy referendum #18'],
    ['/democracy/referendum/18', '/referendum/democracy/18', 'Democracy referendum #18'],
    ['/democracy/proposals/4', '/governance/democracy/proposal/4', 'Democracy proposal #4'],
    [`/democracy/externals/6820789_${HASH}`, `/governance/democracy/external/${HASH}@6820789`, `External proposal ${HASH.slice(0, 10)}…`],
    ['/council/motions/132', '/governance/motion/council/132', 'Council motion #132'],
    ['/council/motion/71', '/governance/motion/council/71', 'Council motion #71'],
    ['/techcomm/proposals/7', '/governance/motion/tc/7', 'Technical committee motion #7'],
    ['/treasury/proposals/9', '/governance/treasury/proposal/9', 'Treasury proposal #9'],
    ['/treasury/spends/0', '/governance/treasury/spend/0', 'Treasury spend #0'],
    [`/treasury/tips/4074082_${HASH}`, `/governance/tip/${HASH}@4074082`, `Treasury tip ${HASH.slice(0, 10)}…`],
    [`/treasury/tip/4074082_${HASH.toUpperCase().replace('0X', '0x')}`, `/governance/tip/${HASH}@4074082`, `Treasury tip ${HASH.slice(0, 10)}…`],
    [`/user/${ADDR}`, `/account/${ADDR}`, ADDR],
    [`/user/${ADDR}/votes`, `/account/${ADDR}`, ADDR],
    ['/referenda', '/governance?tab=referenda', 'Referenda'],
    ['/posts', '/discussions', 'Discussions'],
    ['/', '/governance', 'Governance'],
  ]
  it.each(cases)('%s → %s', (path, target, label) => {
    expect(subsquarePathTarget(path)).toMatchObject({ path: target, label, exact: true })
    expect(subsquarePathTarget(`${path.replace(/\/$/, '')}/`)).toMatchObject({ path: target })
  })

  it('sends the pages the explorer has no counterpart for to the closest one', () => {
    expect(subsquarePathTarget('/referenda/tracks/3')).toMatchObject({ path: '/governance?tab=referenda', exact: false })
    expect(subsquarePathTarget('/calendar')).toMatchObject({ path: '/governance', exact: false })
  })

  it('decodes percent-encoded segments and ignores case in the section', () => {
    expect(subsquarePathTarget('/Referenda/%31%32')).toMatchObject({ path: '/referendum/opengov/12' })
    expect(subsquarePathTarget('/posts/%E0%A4%A')).toMatchObject({ path: '/governance', exact: false })
  })

  it('a motion named <block>_<hash> resolves through the inventory, else falls back to its list', () => {
    const resolve = (body: string, hash: string, height: number) => (body === 'tc' && hash === HASH && height === 8533957 ? '271' : null)
    expect(subsquarePathTarget(`/techcomm/proposals/8533957_${HASH}`, resolve)).toMatchObject({ path: '/governance/motion/tc/271', exact: true })
    expect(subsquarePathTarget(`/techcomm/proposals/1_${HASH}`, resolve)).toMatchObject({ path: '/governance?tab=committee', exact: false })
    expect(subsquarePathTarget(`/council/motions/1_${HASH}`)).toMatchObject({ path: '/governance?tab=archive', exact: false })
  })

  it('a malformed or unknown path gets the closest page, not a claim to be the record', () => {
    expect(subsquarePathTarget('/posts/t.me/WIFD')).toMatchObject({ path: '/discussions', exact: false })
    expect(subsquarePathTarget('/fellowship/members')).toMatchObject({ path: '/governance', exact: false })
    expect(subsquarePathTarget('/treasury/bounties/3')).toMatchObject({ path: '/governance', exact: false })
  })

  it('a legacy username has no account page', () => {
    expect(subsquarePathTarget('/user/alexei')).toEqual({ path: null, label: 'alexei', exact: false })
  })
})

describe('URL forms', () => {
  it.each([
    'https://hydration.subsquare.io/referenda/12',
    'http://hydration.subsquare.io/referenda/12',
    'https://hydradx.subsquare.io/referenda/12',
    'https://HYDRATION.Subsquare.io/referenda/12/',
    'https://www.hydration.subsquare.io/referenda/12?tab=votes',
    '//hydration.subsquare.io/referenda/12',
  ])('%s', url => {
    expect(md(`[ref](${url})`)).toBe('[ref](/referendum/opengov/12)')
  })

  it('carries a comment fragment as our permalink and drops Subsquare\'s positional #n', () => {
    expect(subsquareUrlTarget('https://hydradx.subsquare.io/posts/51#64006f3c37ca4e1883f68448').path).toBe('/discussions/s51#c-s64006f3c37ca4e1883f68448')
    expect(subsquareUrlTarget('https://hydradx.subsquare.io/post/51#24').path).toBe('/discussions/s51')
  })
})

describe('markdown bodies', () => {
  it('a link keeps its text and title and points at the explorer', () => {
    expect(md('See [the vote](https://hydradx.subsquare.io/democracy/referenda/18 "vote").')).toBe('See [the vote](/referendum/democracy/18 "vote").')
    expect(md('[x](<https://hydration.subsquare.io/posts/3>)')).toBe('[x](/discussions/s3)')
  })

  it('a link whose text is the URL gets the label for its text', () => {
    expect(md('[https://hydration.subsquare.io/posts/231](https://hydration.subsquare.io/posts/231).')).toBe('[Discussion #231](/discussions/s231).')
  })

  it('a bare URL becomes a labelled link, trailing punctuation left outside', () => {
    expect(md('vote: https://hydradx.subsquare.io/democracy/referenda/122\nsee (https://hydration.subsquare.io/referenda/13), and https://hydration.subsquare.io/posts/226.'))
      .toBe('vote: [Democracy referendum #122](/referendum/democracy/122)\nsee ([Referendum #13](/referendum/opengov/13)), and [Discussion #226](/discussions/s226).')
    expect(md('**re-run of https://hydration.subsquare.io/council/motions/211**')).toBe('**re-run of [Council motion #211](/governance/motion/council/211)**')
  })

  it('a bare host without a scheme (which linkify would link) is rewritten too', () => {
    expect(md('at hydration.subsquare.io/referenda/5 now')).toBe('at [Referendum #5](/referendum/opengov/5) now')
  })

  it('an autolink becomes a labelled link', () => {
    expect(md('<https://hydration.subsquare.io/referenda/5>')).toBe('[Referendum #5](/referendum/opengov/5)')
  })

  it('a link to a page with no counterpart keeps its text, unlinked; a bare one links the closest page', () => {
    expect(md('[telegram](https://hydration.subsquare.io/posts/t.me/WIFD)')).toBe('telegram')
    expect(md('https://hydration.subsquare.io/fellowship')).toBe('[Governance](/governance)')
  })

  it('a URL in code is shown as the explorer path, unlinked', () => {
    expect(md('`https://hydration.subsquare.io/referenda/5`')).toBe('`/referendum/opengov/5`')
    expect(md('```\ncurl https://hydration.subsquare.io/posts/1\n```')).toBe('```\ncurl /discussions/s1\n```')
  })

  it('a Subsquare mention becomes an account link keeping the name its author saw', () => {
    expect(md(`[@Jose Crypto](${ADDR}-hydradx) thanks`)).toBe(`[@Jose Crypto](/account/${ADDR}) thanks`)
    expect(md(`hi **[@7KTF...hVos](${ADDR}-hydradx)**`)).toBe(`hi **[@7KTF...hVos](/account/${ADDR})**`)
    expect(md(`hi,[@x](${ADDR}-polkadot)`)).toBe(`hi,[@x](/account/${ADDR})`)
    expect(md('[@x](notAnAddress-hydradx)')).toBe('[@x](notAnAddress-hydradx)')
  })

  it('a relative /user/ link: an address is an account, a username is unlinked', () => {
    expect(md(`[@bob](/user/${POLKADOT_ADDR})`)).toBe(`[@bob](/account/${POLKADOT_ADDR})`)
    expect(md(`[their profile](/user/${POLKADOT_ADDR})`)).toBe(`[their profile](/account/${POLKADOT_ADDR})`)
    expect(md('[@xBits](/user/xBits) agreed')).toBe('@xBits agreed')
    expect(md(`[1](https://hydradx.subsquare.io/user/${POLKADOT_ADDR})`)).toBe(`[1](/account/${POLKADOT_ADDR})`)
    expect(md(`https://hydration.subsquare.io/user/${POLKADOT_ADDR}`)).toBe(`[${POLKADOT_ADDR}](/account/${POLKADOT_ADDR})`)
    expect(md('https://hydration.subsquare.io/user/alexei')).toBe('alexei')
    expect(md('https://hydration.subsquare.io/user/a_b')).toBe('a\\_b')
  })

  it('another chain\'s Subsquare page is unlinked: a link keeps its text, a bare URL becomes a plain label', () => {
    expect(md('see [Referendum #854](https://polkadot.subsquare.io/referenda/854) - which')).toBe('see Referendum #854 - which')
    expect(md('vote: https://bifrost.subsquare.io/democracy/referenda/122\ndiscussion: <https://bifrost.subsquare.io/posts/44>'))
      .toBe('vote: Bifrost democracy referendum 122\ndiscussion: Bifrost discussion 44')
    expect(md('#1501 (https://polkadot.subsquare.io/referenda/1501) passes. Governance: https://darwinia2.subsquare.io/'))
      .toBe('#1501 (Polkadot referendum 1501) passes. Governance: Darwinia')
    expect(md('[Grant](https://polkadot.subsquare.io/treasury/child-bounties/59_2. )')).toBe('Grant')
    expect(rewriteSubsquareLinks('<a href="https://kusama.subsquare.io/referenda/3">here</a>', 'html')).toBe('here')
    expect(rewriteSubsquareText('Re: https://polkadot.subsquare.io/posts/248')).toBe('Re: Polkadot discussion 248')
  })

  it('names the chain and kind of another chain\'s page, never with a #', () => {
    expect(foreignPageLabel('polkadot', '/referenda/1542')).toBe('Polkadot referendum 1542')
    expect(foreignPageLabel('bifrost', '/post/25')).toBe('Bifrost discussion 25')
    expect(foreignPageLabel('polkadot', '/treasury/child-bounties/59_2')).toBe('Polkadot child bounty 59-2')
    expect(foreignPageLabel('laos', '/')).toBe('LAOS')
    expect(foreignPageLabel('newchain', '/whatever')).toBe('Newchain')
  })

  it('a relative link into a Subsquare section maps; one that is ours already is left alone', () => {
    expect(md('[r](/referenda/7)')).toBe('[r](/referendum/opengov/7)')
    expect(md('[a](/account/x) [r](/referendum/opengov/7) [d](/discussions/s1)')).toBe('[a](/account/x) [r](/referendum/opengov/7) [d](/discussions/s1)')
  })

  it('leaves images and every other URL byte-identical', () => {
    const untouched = [
      '![image.png](https://static.subsquare.io/QmbPvkbZ871Sd4at2TdfY7US8ijWMLgMPqznUX8EHb6MVD)',
      '![](https://subsquare.infura-ipfs.io/ipfs/QmXFAdKerV6pL6mW6VUSM9gBgACMyRztJXyxGUHwaF3hGo)',
      '[![chart](https://static.subsquare.io/x.png)](https://example.com/page)',
      'see https://subscan.io/x and https://hydration.subsquare.io.evil.com/referenda/1 and https://subsquare.io.evil.com',
      '[x](https://pendulum.polkassembly.io/post/1) [y](url) [z](#anchor)',
      'Subsquare maintenance proposal for hydration 2026',
    ]
    for (const s of untouched) expect(md(s)).toBe(s)
  })

  it('an image wrapped in a link keeps the image and moves the link', () => {
    expect(md('[![chart](https://static.subsquare.io/x.png)](https://hydration.subsquare.io/referenda/5)')).toBe('[![chart](https://static.subsquare.io/x.png)](/referendum/opengov/5)')
  })
})

describe('HTML bodies', () => {
  it('an anchor\'s href is mapped and its other attributes kept (the renderer strips them)', () => {
    expect(rewriteSubsquareLinks('<p>see <a href="https://hydradx.subsquare.io/posts/199" rel="noopener noreferrer" target="_blank">the post</a>.</p>', 'html'))
      .toBe('<p>see <a href="/discussions/s199" rel="noopener noreferrer" target="_blank">the post</a>.</p>')
    expect(rewriteSubsquareLinks("<a href='https://hydration.subsquare.io/referenda/4'>https://hydration.subsquare.io/referenda/4</a>", 'html'))
      .toBe('<a href="/referendum/opengov/4">Referendum #4</a>')
  })

  it('a bare URL in text becomes an anchor; tags and images are left alone', () => {
    expect(rewriteSubsquareLinks('<p>vote https://hydration.subsquare.io/referenda/4.</p><img src="https://static.subsquare.io/a.png">', 'html'))
      .toBe('<p>vote <a href="/referendum/opengov/4">Referendum #4</a>.</p><img src="https://static.subsquare.io/a.png">')
  })
})

describe('titles (plain text)', () => {
  it('a URL becomes its label', () => {
    expect(rewriteSubsquareText('https://hydradx.subsquare.io/post/17')).toBe('Discussion #17')
    expect(rewriteSubsquareText('Soul Eater user manual - https://hydradx.subsquare.io/post/90')).toBe('Soul Eater user manual - Discussion #90')
    expect(rewriteSubsquareText('Subsquare maintenance proposal')).toBe('Subsquare maintenance proposal')
  })
})

describe('idempotency', () => {
  const corpus = [
    `[@Alice](${ADDR}-hydradx) see https://hydradx.subsquare.io/posts/45, [ref](https://hydration.subsquare.io/referenda/1#3) <https://hydration.subsquare.io/calendar>`,
    `[https://hydration.subsquare.io/posts/2](https://hydration.subsquare.io/posts/2) [@bob](/user/bob) [p](/user/${POLKADOT_ADDR}) hi,[@x](${ADDR}-hydradx)`,
    '`https://hydration.subsquare.io/referenda/5` and https://hydration.subsquare.io/user/alexei and [t](https://hydration.subsquare.io/posts/t.me/x)',
    'vote: https://bifrost.subsquare.io/democracy/referenda/122 [here](https://polkadot.subsquare.io/post/7) `https://phala.subsquare.io/x`',
  ]
  it.each(corpus)('rewriting twice equals rewriting once', text => {
    const once = md(text)
    expect(md(once)).toBe(once)
    expect(once).not.toMatch(/subsquare\.io|-hydradx\)|\/user\//)
    expect(once).not.toMatch(/\]\([^/)]/)
  })

  it('the pre-check never skips text the rewrite would change', () => {
    for (const text of corpus) expect(mayHoldSubsquareLink(text)).toBe(true)
    expect(rewriteSubsquareLinks('plain words, no links', 'markdown')).toBe('plain words, no links')
  })
})
