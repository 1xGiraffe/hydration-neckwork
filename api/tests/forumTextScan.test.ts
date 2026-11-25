import { describe, expect, it } from 'vitest'
import { cleanBody, htmlImageSources, isSpaceCode, linkCount, localNetworkUrls, markdownImageTargets, ownImageUrls, rawTooLong } from '../src/services/forumText.ts'
import { imageUrlsIn } from '../src/services/forumRead.ts'

// The regular expressions the linear scanners replace, run as regexes: the scanners
// must agree with them on every input, and stay fast where these backtrack.
const reference = {
  markdownImageTargets: (body: string) => [...body.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)].map(m => m[1]),
  htmlImageSources: (body: string) => [...body.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)/gi)].map(m => m[1]),
  linkCount: (body: string) => (body.match(/(?<!!)\[[^\]]*\]\([^)]*\)/g)?.length ?? 0)
    + (body.replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ').match(/\bhttps?:\/\/[^\s<>()]+/gi)?.length ?? 0),
  cleanBody: (raw: string) => raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '').replace(/\s+$/, ''),
}

const CID = `bafy${'a'.repeat(55)}`
const BODIES = [
  '',
  'plain text with no markup at all',
  '![chart](https://example.org/a.png) and ![](https://example.org/b.png "Title") end',
  '![alt]( <https://example.org/c.png> ) ![x](<>) ![y](< https://e.org/d.png>) ![z](https://e.org/e.png \'t\')',
  `![mine](/ipfs/${CID}) ![abs](https://explorer.example.org/ipfs/${CID}) ![dup](/ipfs/${CID})`,
  '![t](https://e.org/f.png "unterminated) ![u](https://e.org/g.png "a" "b" ) ![v](https://e.org/h.png\n"multi\nline")',
  '<p><img src="https://example.org/i.png"> <IMG alt=x SRC = \'https://example.org/j.png\'> <img data-src=x src=https://e.org/k.png></p>',
  '<img src=""> <img src= > <imgsrc=x> <img\nsrc=https://e.org/l.png> <img alt="a>b" src=y>',
  '[a link](https://example.org) https://bare.example.org/x ![img](https://e.org/m.png) [ref][1] [x](y',
  '![nested [brackets]](https://e.org/n.png) [![badge](https://e.org/o.png)](https://e.org) !![double](z)',
  'text ![a](b)![c](d)![e](f) and <img src=a><img src=b>',
]

// Short random strings over the characters every pattern turns on, so the scanners
// meet each corner of the grammar many times over.
function fuzz(count: number, alphabet: string[], maxLen: number): string[] {
  let seed = 12345
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed }
  const out: string[] = []
  for (let k = 0; k < count; k++) {
    const len = next() % maxLen
    let s = ''
    for (let i = 0; i < len; i++) s += alphabet[next() % alphabet.length]
    out.push(s)
  }
  return out
}
const MD_ALPHABET = ['!', '[', ']', '(', ')', '<', '>', ' ', '\n', '"', "'", 'a', 'b', ' ', '![', '](']
const HTML_ALPHABET = ['<', 'img', 'IMG', ' ', '\t', 'src', 'SRC', '=', '"', "'", '>', 'x', '_', '-', 'a']
const LINK_ALPHABET = ['!', '[', ']', '(', ')', 'http://', 'https://e.org', ' ', 'x', '<', '>']

describe('linear scanners agree with the regexes they replace', () => {
  it('\\s is exactly isSpaceCode', () => {
    for (let c = 0; c < 0x10000; c++) expect(isSpaceCode(c), c.toString(16)).toBe(/\s/.test(String.fromCharCode(c)))
  })

  it('markdown image targets', () => {
    for (const body of [...BODIES, ...fuzz(20_000, MD_ALPHABET, 40)]) expect(markdownImageTargets(body), JSON.stringify(body)).toEqual(reference.markdownImageTargets(body))
  })

  it('HTML image sources', () => {
    for (const body of [...BODIES, ...fuzz(20_000, HTML_ALPHABET, 30)]) expect(htmlImageSources(body), JSON.stringify(body)).toEqual(reference.htmlImageSources(body))
  })

  it('link counts', () => {
    for (const body of [...BODIES, ...fuzz(20_000, LINK_ALPHABET, 30)]) expect(linkCount(body), JSON.stringify(body)).toBe(reference.linkCount(body))
  })

  it('cleaned bodies', () => {
    for (const body of [...BODIES, 'a \r\n\t ', 'x\u0007y\r\n\r\n  ', '  　']) expect(cleanBody(body)).toBe(reference.cleanBody(body))
  })

  it('imageUrlsIn: markdown targets then HTML sources, de-duplicated', () => {
    for (const body of [...BODIES, ...fuzz(5_000, [...MD_ALPHABET, ...HTML_ALPHABET], 40)]) {
      expect(imageUrlsIn(body)).toEqual([...new Set([...reference.markdownImageTargets(body), ...reference.htmlImageSources(body)])])
    }
    expect(ownImageUrls(BODIES[4], 'https://explorer.example.org').map(x => x.url)).toEqual([`/ipfs/${CID}`, `https://explorer.example.org/ipfs/${CID}`])
  })

  it('strips trailing punctuation from a local URL', () => {
    expect(localNetworkUrls('see http://localhost:8080/x... and http://192.168.1.1?!')).toEqual(['http://localhost:8080/x', 'http://192.168.1.1'])
  })

  it('refuses an authority longer than any public host, and keeps a long path on a public one', () => {
    expect(localNetworkUrls(`http://a${'.'.repeat(400)}b/`)).toHaveLength(1)
    expect(localNetworkUrls(`https://example.org/${'a'.repeat(5000)}`)).toEqual([])
  })
})

describe('hostile repetitions stay linear', () => {
  const N = 200_000
  // The fastest of three runs, so a busy machine does not fail a linear scan.
  const fastest = (fn: () => unknown) => {
    let best = Infinity
    for (let i = 0; i < 3; i++) { const t = performance.now(); fn(); best = Math.min(best, performance.now() - t) }
    return best
  }
  const inputs: Record<string, string> = {
    'open brackets': '['.repeat(N),
    'image openers': '!['.repeat(N / 2),
    'empty images': '![]('.repeat(N / 4),
    'images with a title quote': '![](a "'.repeat(N / 7),
    'image then spaces': `![](a${' '.repeat(N)}x`,
    'link openers': '[](' .repeat(N / 3),
    'spaces then a letter': `${' '.repeat(N)}x`,
    'img tags': '<img '.repeat(N / 5),
    'src without a tag end': `<img ${'src '.repeat(N / 4)}`,
    'trailing punctuation in a URL': `http://a${'.'.repeat(N)}x`,
  }
  for (const [name, input] of Object.entries(inputs)) {
    it(name, () => {
      expect(fastest(() => {
        cleanBody(input)
        linkCount(input)
        imageUrlsIn(input)
        ownImageUrls(input, 'https://explorer.example.org')
        localNetworkUrls(input)
      })).toBeLessThan(100)
    })
  }

  it('raw text far over a limit is refused before it is cleaned', () => {
    expect(rawTooLong('x'.repeat(500), 500)).toBe(false)
    expect(rawTooLong(`${'x'.repeat(500)}${'\r'.repeat(1000)}`, 500)).toBe(false)
    expect(rawTooLong(' '.repeat(1 << 20), 500)).toBe(true)
    expect(rawTooLong('x'.repeat(50_000 + 12_500), 50_000)).toBe(false)
    expect(rawTooLong('x'.repeat(50_000 + 12_501), 50_000)).toBe(true)
  })
})
