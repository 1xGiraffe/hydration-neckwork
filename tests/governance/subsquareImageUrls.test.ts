import { describe, expect, it } from 'vitest'
import { IMAGE_SCAN_MAX_CHARS, imageSourcesIn, imageUrlsIn } from '../../src/governance/subsquare/rows.js'

// The image pass reads every image URL an imported body references. The scan is linear:
// it must find exactly what the two regexes below find (the reference), and finish in
// linear time on text that makes those regexes backtrack quadratically.

const MD_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi

/** Every capture of the two regexes, in order. */
function referenceSources(body: string): string[] {
  return [...[...body.matchAll(MD_IMAGE)].map(m => m[1]), ...[...body.matchAll(HTML_IMAGE)].map(m => m[1] ?? m[2] ?? m[3])]
}

function reference(body: string): string[] {
  const urls = new Set<string>()
  for (const u of referenceSources(body)) {
    if (!u) continue
    const v = u.replace(/&amp;/g, '&').trim()
    if (/^https?:\/\//i.test(v) && v.length <= 2048) urls.add(v)
  }
  return [...urls]
}

/** A small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NORMAL_BODIES = [
  '![a](https://i.ibb.co/x/y.png "t") text <img alt="b" src="https://s3.bmp.ovh/imgs/z.jpg?a=1&amp;b=2"> ![c](javascript:alert(1)) ![d](http://h.example/p.gif)',
  '# Proposal\n\nSee the chart:\n\n![chart](https://subsquare.infura-ipfs.io/ipfs/QmapSmYyvphm9sxt5BnmrkPM1QHcQPhujkYBAgT6bUhjCE)\n\nand ![](<https://img.example/a b.png>) or ![x]( https://img.example/c.png \'title\' ) and ![y](https://img.example/d.png (paren title))',
  '<p>Intro</p><IMG SRC=https://img.example/bare.png width=10><img\nalt="multi\nline"\nsrc =\n\'https://img.example/single.png\'><img data-src="https://no.example/x.png"><imgx src="https://no.example/y.png"><img src="">',
  '![a](https://img.example/same.png) ![b](https://img.example/same.png) <img src="https://img.example/same.png">',
  'no images here, just [a link](https://example.org) and `code ![x](y)`',
  '![broken](https://img.example/a.png "unterminated) ![ok](https://img.example/b.png)',
  '<img src="https://img.example/a.png"\n<img src=\'https://img.example/b.png\'>',
  '<img alt=">" src="https://img.example/after-gt.png"><img src="https://img.example/quote.png>',
  '![İstanbul](https://img.example/İ.png) <İMG src="https://img.example/no.png"> <img src="https://img.example/İ.png">',
]

describe('image URLs in bodies', () => {
  it('reads at most IMAGE_SCAN_MAX_CHARS of a body', () => {
    const pad = 'x'.repeat(IMAGE_SCAN_MAX_CHARS - 40)
    expect(imageUrlsIn(`${pad}![](https://a.example/in.png)`)).toEqual(['https://a.example/in.png'])
    expect(imageUrlsIn(`${pad}${'y'.repeat(40)}![](https://a.example/out.png)`)).toEqual([])
  })

  it('finds what the reference regexes find, on ordinary bodies', () => {
    for (const body of NORMAL_BODIES) {
      expect(imageSourcesIn(body), body).toEqual(referenceSources(body))
      expect(imageUrlsIn(body), body).toEqual(reference(body))
    }
    expect(imageUrlsIn(NORMAL_BODIES[0])).toEqual(['https://i.ibb.co/x/y.png', 'http://h.example/p.gif', 'https://s3.bmp.ovh/imgs/z.jpg?a=1&b=2'])
  })

  it('finds what the reference regexes find, on random arrangements of the syntax', () => {
    const tokens = [
      '!', '[', ']', '(', ')', '<', '>', '"', "'", ' ', '\n', '\t', '\u00a0', '\ufeff', '=', 'x', 'g', 'İ', 'ſ', 'K', 's', 'i', '_', '-',
      '![', '](', '![a](', '<img', '<IMG ', '<iMg\n', ' src', 'SRC=', 'src =', 'sRc\t=\t', 'data-src=', '_src=', '<img src="', "<img src='",
      'http://a.example/', 'https://b.example/p.png', 'HTTPS://C.example/q', '&amp;', ' "t"', " 't'", ' (t)', '>)', ')(',
    ]
    const next = rng(1)
    for (let round = 0; round < 20_000; round++) {
      const len = 1 + Math.floor(next() * 40)
      let body = ''
      for (let k = 0; k < len; k++) body += tokens[Math.floor(next() * tokens.length)]
      expect(imageSourcesIn(body), JSON.stringify(body)).toEqual(referenceSources(body))
    }
  })

  it('stays linear on text that makes the regexes backtrack', () => {
    const hostile = [
      '![](' .repeat(50_000),
      '![' .repeat(100_000),
      '![a](https://x.example/' + 'a'.repeat(200_000),
      '![a](x "'.repeat(25_000),
      '<img' .repeat(50_000),
      '<img src' .repeat(25_000),
      '<img src="'.repeat(20_000),
      '<img ' + 'src= '.repeat(40_000),
    ]
    for (const body of hostile) {
      const started = performance.now()
      imageUrlsIn(body)
      expect(performance.now() - started, body.slice(0, 20)).toBeLessThan(500)
    }
  })
})
