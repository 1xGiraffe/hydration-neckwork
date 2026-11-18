import { describe, expect, it } from 'vitest'
import { markdownToHtml, type RefContext } from '../src/markdown/render'

// The markdown stage of the forum renderer (src/markdown/render.ts), which runs
// before DOMPurify and the link/image policy. Raw HTML in markdown must come out
// escaped — as text, never as markup — and markdown-it's own link validation must
// refuse script-bearing schemes. The DOM stages (sanitizer allow-list, media map,
// link policy) need a real DOM and are covered by e2e/forum-render.spec.ts in a
// browser.

describe('forum markdown stage', () => {
  it('escapes raw HTML instead of parsing it', () => {
    const out = markdownToHtml('<img src=x onerror="fetch(1)"> <script>alert(1)</script>\n\nTest"><img src=x>')
    expect(out).not.toMatch(/<img|<script/i)
    expect(out).toContain('&lt;img src=x onerror=&quot;fetch(1)&quot;&gt;')
  })

  it('never links a script-bearing scheme', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'vbscript:msgbox(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'java\tscript:alert(1)', '&#106;avascript:alert(1)']) {
      const out = markdownToHtml(`[x](${href})`)
      expect(out, href).not.toMatch(/href="(?:javascript|vbscript|data:text)/i)
    }
  })

  const NATIVE: RefContext = { native: true, maxOpenGov: 450, maxDemocracy: 207 }
  const IMPORTED: RefContext = { native: false, maxOpenGov: 450, maxDemocracy: 207 }

  it('turns @address mentions and #n references into internal links, outside existing links only', () => {
    const out = markdownToHtml('Thanks @15V2Rfi6METM3FJpZJH5QVM3WYHEmNLcQ52FcMPYTtdTipA4, see #450 and [#12](https://x.example/12)', NATIVE)
    expect(out).toContain('href="/account/15V2Rfi6METM3FJpZJH5QVM3WYHEmNLcQ52FcMPYTtdTipA4"')
    expect(out).toContain('href="/referendum/opengov/450"')
    expect(out).not.toContain('/referendum/opengov/12')
  })

  it('links #n only where it can only be a referendum', () => {
    // No context: nothing is linked.
    expect(markdownToHtml('see #450')).not.toContain('/referendum/')
    // Above the newest index: a number, not a referendum.
    expect(markdownToHtml('ticket #4512 and #451', NATIVE)).not.toContain('/referendum/')
    // GitHub contexts: a release note's "by @user in #N", a PR, a line linking github.com.
    expect(markdownToHtml('Fix fees by @alice in #42', NATIVE)).not.toContain('/referendum/')
    expect(markdownToHtml('merged PR #42 today', NATIVE)).not.toContain('/referendum/')
    expect(markdownToHtml('See https://github.com/galacticcouncil/hydration-node/pull/9 (#42)', NATIVE)).not.toContain('/referendum/')
    // Text imported from elsewhere: a bare #N stays text …
    expect(markdownToHtml('as passed in referendum #56', IMPORTED)).not.toContain('/referendum/')
    expect(markdownToHtml('see #300', IMPORTED)).not.toContain('/referendum/')
    // … and is linked only where it names its kind, in either era.
    expect(markdownToHtml('OpenGov referendum #300 passed', IMPORTED)).toContain('href="/referendum/opengov/300"')
    expect(markdownToHtml('the democracy referendum #56 enacted it', IMPORTED)).toContain('href="/referendum/democracy/56"')
    expect(markdownToHtml('Democracy #56', NATIVE)).toContain('href="/referendum/democracy/56"')
    expect(markdownToHtml('democracy referendum #208', NATIVE)).not.toContain('/referendum/')
  })

  it('keeps an image as an <img> for the policy pass to rehost or demote', () => {
    expect(markdownToHtml('![chart](https://i.example/a.png)')).toContain('<img src="https://i.example/a.png" alt="chart">')
  })
})
