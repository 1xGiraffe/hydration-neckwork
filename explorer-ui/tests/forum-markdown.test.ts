import { describe, expect, it } from 'vitest'
import { isDeviceLinkHref, isLocalNetworkHref, markdownToHtml, type RefContext } from '../src/markdown/render'

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

describe('isLocalNetworkHref: links that could only probe the reader\'s own network', () => {
  it('flags internal-service style targets and every spelling of a private address', () => {
    for (const href of [
      'http://db:8123/?query=SELECT%201', 'https://db./x.png', 'https://10.0.2.1/x.png',
      'https://storage:5001/api/v0/version', 'http://localhost/', 'http://127.0.0.1/', 'http://2130706433/',
      'http://0x7f.1/', 'http://192.168.1.1/admin', 'http://172.20.0.5/', 'http://169.254.169.254/latest/meta-data',
      'http://100.64.1.1/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:192.168.0.1]/',
      'http://router.local/', 'http://nas.home.arpa/', 'http://db.internal/', 'http://printer.lan/', 'https://example.com:8443/x',
    ]) expect(isLocalNetworkHref(href), href).toBe(true)
  })

  it('leaves public web links alone', () => {
    for (const href of [
      'https://hydration.net', 'https://i.imgur.com/a.png', 'https://example.com:443/x', 'http://example.com:80/x',
      'https://8.8.8.8/', 'https://[2606:4700::1111]/', 'https://github.com/galacticcouncil/hydration-node/pull/1571',
      'https://example.org/img.png', 'https://localhost.example.com/',
    ]) expect(isLocalNetworkHref(href), href).toBe(false)
  })

  it('is false for what is not an http(s) URL', () => {
    for (const href of ['/account/abc', '#x', 'mailto:a@b.c', 'javascript:alert(1)', 'not a url']) expect(isLocalNetworkHref(href), href).toBe(false)
  })
})

describe('isDeviceLinkHref: links that would sign the reader in to someone else\'s account', () => {
  const ORIGIN = 'https://explorer.example'
  const CODE = 'ab'.repeat(32)

  it('flags the device-link page on this site, however it is spelled', () => {
    for (const href of [
      `/link-device#${CODE}`, '/link-device', '/link-device/', `${ORIGIN}/link-device#${CODE}`, `${ORIGIN}/link-device?x=1#${CODE}`,
      '/link%2Ddevice', '/link%2ddevice#x', '//explorer.example/link-device', '/./link-device', '/x/../link-device', '/link-device/extra',
    ]) expect(isDeviceLinkHref(href, ORIGIN), href).toBe(true)
  })

  it('leaves every other page and other sites alone', () => {
    for (const href of [
      '/account/abc', '/link-devices', '/Link-Device', '/discussions/link-device', `https://other.example/link-device#${CODE}`,
      '#link-device', 'https://hydration.net', 'not a url %',
    ]) expect(isDeviceLinkHref(href, ORIGIN), href).toBe(false)
  })
})
