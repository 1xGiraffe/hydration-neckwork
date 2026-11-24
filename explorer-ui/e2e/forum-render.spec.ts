import { expect, test } from './fixtures/test'

// The forum renderer's sanitizer corpus, run in a real browser: the whole pipeline
// (markdown-it, DOMPurify, the image and link policy) needs the browser's own HTML
// parser, which is what an attacker targets. Every vector must come out with no
// script, no event handler, no style, no non-allow-listed URL and no image that is
// not a re-hosted same-origin one.

const VECTORS: { body: string; format: 'markdown' | 'html' }[] = [
  { format: 'html', body: '<img src=x onerror="fetch(\'https://evil.example/\')">' },
  { format: 'html', body: '<svg><script>alert(1)</script></svg><svg onload=alert(1)>' },
  { format: 'html', body: '<a href="javascript:alert(1)">x</a><a href="  JAVASCRIPT:alert(1)">y</a>' },
  { format: 'html', body: '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">z</a>' },
  { format: 'html', body: '<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="x">' },
  { format: 'html', body: '<p style="background:url(javascript:alert(1))" class="topbar" id="root">styled</p>' },
  { format: 'html', body: '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>' },
  { format: 'html', body: '<form action="https://evil.example"><input name=a><button>go</button></form>' },
  { format: 'html', body: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">d</a>' },
  { format: 'html', body: '<img src="https://tracker.example/pixel.gif" alt="pixel">' },
  { format: 'html', body: '<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example">' },
  { format: 'html', body: '<div onmouseover="alert(1)">hover</div><details open ontoggle=alert(1)>t</details>' },
  { format: 'markdown', body: '[x](javascript:alert(1)) [y](vbscript:x) [z](data:text/html,<script>alert(1)</script>)' },
  { format: 'markdown', body: '![a](https://tracker.example/a.png) ![b](javascript:alert(1))' },
  { format: 'markdown', body: '<img src=x onerror=alert(1)>\n\nTest"><img src=x>' },
  { format: 'markdown', body: '[a](//evil.example/path) [b](ftp://x.example) [c](mailto:a@b.c)' },
  { format: 'markdown', body: '```html\n<script>alert(1)</script>\n```' },
  // Paths a browser reads as another host.
  { format: 'html', body: '<a href="/\\evil.example/x">a</a><a href="/\t/evil.example">b</a><a href="//evil.example">c</a><a href="/%5C%5Cevil.example">d</a>' },
  { format: 'markdown', body: '[a](/\\evil.example) [b](</\t/evil.example>) [c](//evil.example)' },
]

test('the forum renderer leaves nothing executable, styled or hotlinked', async ({ page }) => {
  await page.goto('/')
  // Judged on the rendered DOM itself (an escaped "onerror=" in TEXT is harmless):
  // every element an allow-listed tag, every attribute one the policy sets.
  const problems = await page.evaluate(async (vectors) => {
    const mod = await import('/src/markdown/render.ts')
    const TAGS = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'DEL', 'S', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'A', 'IMG', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN', 'SUP', 'SUB'])
    const ATTRS = new Set(['href', 'src', 'alt', 'title', 'target', 'rel', 'class', 'loading', 'decoding', 'data-internal'])
    const out: string[] = []
    for (const v of vectors) {
      const holder = document.createElement('div')
      holder.appendChild(mod.renderForumBody({ body: v.body, format: v.format, media: {} }))
      for (const el of Array.from(holder.querySelectorAll('*'))) {
        if (!TAGS.has(el.tagName)) out.push(`${v.body} → <${el.tagName}>`)
        for (const a of Array.from(el.attributes)) {
          if (!ATTRS.has(a.name)) out.push(`${v.body} → ${el.tagName}[${a.name}]`)
          if (a.name === 'class' && !/^md-[a-z-]+( md-[a-z-]+)*$/.test(a.value)) out.push(`${v.body} → class ${a.value}`)
          if ((a.name === 'href' || a.name === 'src') && !/^(https?:\/\/|\/(?!\/)|#)/i.test(a.value)) out.push(`${v.body} → ${a.name}=${a.value}`)
          // A path must stay on this origin as the browser itself resolves it.
          if ((a.name === 'href' || a.name === 'src') && a.value.startsWith('/') && (/[\\\s]/.test(a.value) || new URL(a.value, location.origin).origin !== location.origin)) out.push(`${v.body} → off-origin ${a.name}=${a.value}`)
        }
        if (el.tagName === 'IMG' && !/^\/ipfs\//.test(el.getAttribute('src') ?? '')) out.push(`${v.body} → hotlinked img ${el.getAttribute('src')}`)
        if (el.tagName === 'A' && /^https?:/i.test(el.getAttribute('href') ?? '') && el.getAttribute('rel') !== 'noopener noreferrer nofollow ugc') out.push(`${v.body} → external link without ugc rel`)
      }
    }
    return out
  }, VECTORS)
  expect(problems).toEqual([])
})

test('re-hosted images render from our IPFS path; external links carry the ugc rel', async ({ page }) => {
  await page.goto('/')
  const html = await page.evaluate(async () => {
    const mod = await import('/src/markdown/render.ts')
    return mod.renderForumBodyToString({
      format: 'markdown',
      body: '![chart](https://img.example/a.png?x=1&y=2) ![other](https://img.example/b.png) [site](https://hydration.net) [ref](/referendum/opengov/1) [old](https://hydration.subsquare.io/posts/226)',
      media: { 'https://img.example/a.png?x=1&y=2': '/ipfs/bafkreibvkzhcju4q34h2vaxzivfb3z22yevtoumqdtzk4ln3dgzkgqyrkm', 'https://img.example/b.png': 'https://evil.example/b.png' },
    })
  })
  expect(html).toContain('<img src="/ipfs/bafkreibvkzhcju4q34h2vaxzivfb3z22yevtoumqdtzk4ln3dgzkgqyrkm" alt="chart" loading="lazy" decoding="async" class="md-img">')
  // A media entry that is not our own /ipfs/ path is ignored: the image stays a link.
  expect(html).toContain('<a href="https://img.example/b.png" target="_blank" rel="noopener noreferrer nofollow ugc" class="md-img-link md-ext">Image: other</a>')
  expect(html).toContain('<a href="https://hydration.net" target="_blank" rel="noopener noreferrer nofollow ugc" class="md-ext">site</a>')
  expect(html).toContain('<a href="/referendum/opengov/1" data-internal="1">ref</a>')
  // A link to the replaced forum opens its page here.
  expect(html).toContain('<a href="/posts/226" data-internal="1">old</a>')
})

test('a paragraph that is only typed dashes renders as a rule; one with other text or markup stays a paragraph', async ({ page }) => {
  await page.goto('/')
  const html = await page.evaluate(async () => {
    const mod = await import('/src/markdown/render.ts')
    return mod.renderForumBodyToString({
      format: 'html',
      body: '<p>One</p><p>------------------------------------------------</p><p>Two</p><p>—— — ——</p><p>a --- b</p><p><strong>-----</strong></p>',
      media: {},
    })
  })
  expect(html).toBe('<p>One</p><hr><p>Two</p><hr><p>a --- b</p><p><strong>-----</strong></p>')
})

test('an image on the replaced forum\'s hosts reads "Image unavailable" with no link; other hosts keep theirs', async ({ page }) => {
  await page.goto('/')
  const html = await page.evaluate(async () => {
    const mod = await import('/src/markdown/render.ts')
    return mod.renderForumBodyToString({
      format: 'markdown',
      body: '![plan](https://subsquare.infura-ipfs.io/ipfs/QmX1r9NdWdSPm7Y1zMWNsoNuft4XTsva7vqPcDiVBZPhED) ![](https://static.subsquare.io/a.png) ![chart](https://i.imgur.com/a.png)',
      media: {},
    })
  })
  expect(html).toContain('<span class="md-img-gone">Image unavailable: plan</span>')
  expect(html).toContain('<span class="md-img-gone">Image unavailable</span>')
  expect(html).not.toContain('subsquare')
  expect(html).toContain('<a href="https://i.imgur.com/a.png" target="_blank" rel="noopener noreferrer nofollow ugc" class="md-img-link md-ext">Image: chart</a>')
})

test('headings start one level below the page title, and an @name account link reads as a mention', async ({ page }) => {
  await page.goto('/')
  const html = await page.evaluate(async () => {
    const mod = await import('/src/markdown/render.ts')
    return mod.renderForumBodyToString({
      format: 'markdown',
      body: '# Top\n\n## Next\n\n###### Deepest\n\nThanks [@Alice](/account/15V2Rfi6METM3FJpZJH5QVM3WYHEmNLcQ52FcMPYTtdTipA4) and [her page](/account/15V2Rfi6METM3FJpZJH5QVM3WYHEmNLcQ52FcMPYTtdTipA4)',
      media: {},
    })
  })
  expect(html).toContain('<h2>Top</h2>')
  expect(html).toContain('<h3>Next</h3>')
  expect(html).toContain('<h6>Deepest</h6>')
  expect(html).not.toContain('<h1')
  expect(html).toContain('<a href="/account/15V2Rfi6METM3FJpZJH5QVM3WYHEmNLcQ52FcMPYTtdTipA4" data-internal="1" class="md-mention">@Alice</a>')
  expect(html).toContain('<a href="/account/15V2Rfi6METM3FJpZJH5QVM3WYHEmNLcQ52FcMPYTtdTipA4" data-internal="1">her page</a>')
})

test('links and images that point into the reader\'s own network render as inert text', async ({ page }) => {
  await page.goto('/')
  const html = await page.evaluate(async () => {
    const mod = await import('/src/markdown/render.ts')
    return mod.renderForumBodyToString({
      format: 'markdown',
      body: '![c](http://db:8123/?query=SELECT%201) ![d](https://10.0.2.1/x.png) ![e](https://storage:5001/api/v0/version) ![f](https://db./x.png)'
        + '\n\n[router](http://192.168.1.1/admin) [meta](http://169.254.169.254/latest/meta-data) [site](https://hydration.net)',
      media: {},
    })
  })
  for (const target of ['db:8123', '10.0.2.1', 'storage:5001', '192.168.1.1', '169.254.169.254']) expect(html).not.toContain(target)
  expect(html).toContain('<span class="md-img-gone">Image unavailable: c</span>')
  expect(html).toContain('<span class="md-img-gone">Image unavailable: f</span>')
  expect(html).toContain('<a>router</a>')
  expect(html).toContain('<a href="https://hydration.net" target="_blank" rel="noopener noreferrer nofollow ugc" class="md-ext">site</a>')
})
