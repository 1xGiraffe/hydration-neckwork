import { describe, expect, it } from 'vitest'
import { renderAtom, rfc3339, xmlText } from '../src/routes/feeds.ts'

// The referenda Atom feed. Every title, excerpt and name is hostile user text: it
// must leave as escaped `type="text"`, with the characters XML 1.0 forbids removed
// (one would make the whole feed unparseable).

describe('xmlText', () => {
  it('escapes markup and drops characters XML 1.0 forbids', () => {
    expect(xmlText('a<b>&"\'\u0001\u000Bz\tq')).toBe('a&lt;b&gt;&amp;&quot;&apos;z\tq')
  })
})

describe('renderAtom', () => {
  it('dates the feed by its newest entry and never emits an html-typed field', () => {
    const xml = renderAtom({
      id: 'https://x/d', title: 'T', subtitle: 'S', self: 'https://x/f.atom', alternate: 'https://x/d',
      entries: [
        { id: 'https://x/1', title: '<script>x</script>', link: 'https://x/1', updated: '2026-01-02T00:00:00.000Z', summary: 'a&b' },
        { id: 'https://x/2', title: 'two', link: 'https://x/2', updated: '2026-03-01T00:00:00.000Z' },
      ],
    })
    expect(xml).toContain('<updated>2026-03-01T00:00:00.000Z</updated>\n  <author>')
    expect(xml).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(xml).not.toContain('<script>')
    expect(xml).not.toContain('type="html"')
    expect(xml).toContain('<summary type="text">a&amp;b</summary>')
  })
})

describe('feed dates and authorship', () => {
  it('carries a feed-level author, drops an entry with no known date, and never dates anything 1970', () => {
    const xml = renderAtom({
      id: 'https://x/d', title: 'T', subtitle: 'S', self: 'https://x/f.atom', alternate: 'https://x/d',
      entries: [
        { id: 'https://x/1', title: 'dated', link: 'https://x/1', updated: '2026-01-02T00:00:00.000Z' },
        { id: 'https://x/2', title: 'undated', link: 'https://x/2', updated: null },
      ],
    })
    expect(xml).toMatch(/<feed[^>]*>[\s\S]*<author><name>Hydration Explorer<\/name><uri>https?:\/\/[^<]+<\/uri><\/author>/)
    expect(xml).not.toContain('undated')
    expect(xml).not.toContain('1970')
    const empty = renderAtom({ id: 'i', title: 't', subtitle: 's', self: 'x', alternate: 'y', entries: [] }, Date.parse('2026-05-01T00:00:00Z'))
    expect(empty).toContain('<updated>2026-05-01T00:00:00.000Z</updated>')
    expect(rfc3339(0)).toBeNull()
    expect(rfc3339('1970-01-01 00:00:00')).toBeNull()
  })

  it('removes unpaired surrogates, which XML 1.0 cannot carry', () => {
    expect(xmlText('a\uD800b\uDC00c\uD83D\uDE00')).toBe('abc\uD83D\uDE00')
  })
})
