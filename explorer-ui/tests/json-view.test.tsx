import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { JsonView, jsonTokens } from '../src/components/ui'

// JsonView shows call arguments and contract ABIs, values anyone can put on chain.
// It renders React elements over a tokenized string — never markup — and colours
// exactly what it always did: object keys with their colon, and brackets.

// The markup the earlier regex-into-innerHTML version produced, kept here as the
// reference for "looks the same" on ordinary JSON.
function regexMarkup(value: unknown): string {
  const json = JSON.stringify(value, null, 2)
  return json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"([^"]+)":/g, '<span class="key">"$1"</span><span class="punc">:</span>')
    .replace(/: "([^"]*)"/g, ': <span class="str">"$1"</span>')
    .replace(/: (\d[\d.]*)/g, ': <span class="numb">$1</span>')
    .replace(/[{}[\]]/g, m => `<span class="punc">${m}</span>`)
}

// React escapes quotes in text, which the browser reads back as the same characters.
const render = (value: unknown) => renderToStaticMarkup(<JsonView value={value} />)
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")

describe('JsonView', () => {
  it('renders ordinary JSON exactly as before', () => {
    for (const value of [
      { dest: '7KTFfPoa44KxwZsa5N3syqxoSPddApcioLEMUEjYY8cohVos', amount: '1000000000000', keepAlive: true, nested: { assetId: 5, path: [1, 2, { x: null }] } },
      [{ type: 'function', name: 'transfer', inputs: [{ name: 'to', type: 'address' }], outputs: [], stateMutability: 'nonpayable' }],
      { topics: ['0x' + 'ab'.repeat(32)], data: '0x' },
      [],
      {},
      'plain string',
      42,
      null,
    ]) {
      expect(render(value), JSON.stringify(value)).toBe(`<div class="json">${regexMarkup(value)}</div>`)
    }
  })

  it('keeps hostile text as text', () => {
    const html = render({ '<img src=x onerror=alert(1)>': '</div><script>alert(1)</script>', list: ['<b>x</b>', '"]}<i>'] })
    expect(html).not.toMatch(/<img|<script|<b>|<i>|<\/div><script/)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;/div&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('treats a string as one token: brackets and key-like text inside it stay plain', () => {
    expect(jsonTokens('{"a": "x[1]: \\"b\\":"}')).toEqual([
      { cls: 'punc', text: '{' },
      { cls: 'key', text: '"a"' },
      { cls: 'punc', text: ':' },
      { cls: null, text: ' "x[1]: \\"b\\":"' },
      { cls: 'punc', text: '}' },
    ])
  })

  it('shows what cannot be serialized without throwing', () => {
    expect(render({ n: 1n })).toBe('<div class="json"><span class="punc">[</span>object Object<span class="punc">]</span></div>')
    expect(render(undefined)).toBe('<div class="json">null</div>')
  })
})
