import type { SearchResult } from '../types'
// The forum editor's text transforms, as pure functions over (text, selection). Each
// returns an Edit: the range to replace, what to insert there and where the selection
// lands afterwards — so the component can apply it through the browser's own
// insertText (keeping native undo) or, failing that, by setting the value. Nothing
// here touches the DOM.

export interface TextState { text: string; start: number; end: number }

/** Replace text[from, to) with `insert`; then select [selStart, selEnd) in the RESULT. */
export interface Edit { from: number; to: number; insert: string; selStart: number; selEnd: number }

export function applyEdit(text: string, e: Edit): TextState {
  return { text: text.slice(0, e.from) + e.insert + text.slice(e.to), start: e.selStart, end: e.selEnd }
}

const clamp = (s: TextState): TextState => {
  const n = s.text.length
  const start = Math.max(0, Math.min(n, s.start)), end = Math.max(start, Math.min(n, s.end))
  return { text: s.text, start, end }
}

// ---- inline wraps: bold, italic, inline code ----

/**
 * Wrap the selection in `marker` (or unwrap it when it is already wrapped, the markers
 * either inside the selection or just around it). An empty selection inserts a
 * selected placeholder word, so typing replaces it.
 */
// A line's block prefix (indent, list bullet or number, quote marks, heading
// hashes): inline markers go after it, so "- item" becomes "- **item**".
const LINE_PREFIX_RE = /^(\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)?)/

/**
 * Wraps (or unwraps) every non-blank line of a multi-line selection on its own:
 * markdown emphasis cannot span a paragraph break, so one pair of markers around
 * several lines would render as literal stars. Blank lines are left untouched.
 */
function toggleWrapLines(text: string, start: number, end: number, marker: string): Edit {
  const lines = text.slice(start, end).split('\n')
  const m = marker.length
  const parts = lines.map(line => {
    const prefix = LINE_PREFIX_RE.exec(line)?.[1] ?? ''
    const rest = line.slice(prefix.length)
    const core = rest.trimEnd()
    return { line, prefix, core, trail: rest.slice(core.length) }
  })
  const content = parts.filter(p => p.core.length > 0)
  const allWrapped = content.length > 0 && content.every(p => p.core.length >= 2 * m && p.core.startsWith(marker) && p.core.endsWith(marker))
  const insert = parts.map(p => {
    if (!p.core) return p.line
    const core = allWrapped ? p.core.slice(m, p.core.length - m) : marker + p.core + marker
    return p.prefix + core + p.trail
  }).join('\n')
  return { from: start, to: end, insert, selStart: start, selEnd: start + insert.length }
}

export function toggleWrap(state: TextState, marker: string, placeholder: string): Edit {
  const { text, start, end } = clamp(state)
  const sel = text.slice(start, end)
  if (sel.includes('\n') && sel.trim().includes('\n')) return toggleWrapLines(text, start, end, marker)
  const m = marker.length
  // Markers inside the selection: **bold** selected whole.
  if (sel.length >= 2 * m && sel.startsWith(marker) && sel.endsWith(marker)) {
    const inner = sel.slice(m, sel.length - m)
    return { from: start, to: end, insert: inner, selStart: start, selEnd: start + inner.length }
  }
  // Markers just outside the selection: bold selected inside **…**.
  if (start >= m && text.slice(start - m, start) === marker && text.slice(end, end + m) === marker
    // `*` inside `**…**` is bold, not italic: do not unwrap one star of a pair.
    && !(marker === '_' || marker === '*' ? text.slice(start - 2 * m, start - m) === marker && text.slice(end + m, end + 2 * m) === marker : false)) {
    return { from: start - m, to: end + m, insert: sel, selStart: start - m, selEnd: end - m }
  }
  // Keep surrounding whitespace outside the markers: "**word **" is not bold.
  const lead = sel.length - sel.trimStart().length
  const trail = sel.length - sel.trimEnd().length
  const core = sel.trim()
  const word = core || placeholder
  const insert = sel.slice(0, lead) + marker + word + marker + (core ? sel.slice(sel.length - trail) : '')
  const wordStart = start + lead + m
  return { from: start, to: end, insert, selStart: wordStart, selEnd: wordStart + word.length }
}

/** Inline code for a one-line selection, a fenced block for a multi-line one. */
export function toggleCode(state: TextState): Edit {
  const { text, start, end } = clamp(state)
  const sel = text.slice(start, end)
  if (!sel.includes('\n')) return toggleWrap(state, '`', 'code')
  const before = start > 0 && text[start - 1] !== '\n' ? '\n' : ''
  const after = end < text.length && text[end] !== '\n' ? '\n' : ''
  const body = sel.replace(/\n$/, '')
  const insert = `${before}\`\`\`\n${body}\n\`\`\`${after}`
  const bodyStart = start + before.length + 4
  return { from: start, to: end, insert, selStart: bodyStart, selEnd: bodyStart + body.length }
}

// ---- links ----

const URL_RE = /^https?:\/\/\S+$/i

/**
 * `[text](url)`. A selected URL becomes the target (the link text is selected for
 * typing); selected words become the text (the URL slot is selected).
 */
export function insertLink(state: TextState): Edit {
  const { text, start, end } = clamp(state)
  const sel = text.slice(start, end).trim()
  if (URL_RE.test(sel)) {
    const label = 'link text'
    return { from: start, to: end, insert: `[${label}](${sel})`, selStart: start + 1, selEnd: start + 1 + label.length }
  }
  const label = sel || 'link text'
  const url = 'https://'
  const insert = `[${label}](${url})`
  if (!sel) return { from: start, to: end, insert, selStart: start + 1, selEnd: start + 1 + label.length }
  const urlStart = start + label.length + 3
  return { from: start, to: end, insert, selStart: urlStart, selEnd: urlStart + url.length }
}

// ---- line-based: heading, quote, lists ----

/** The [from, to) span of the whole lines the selection touches. */
export function lineSpan(text: string, start: number, end: number): { from: number; to: number } {
  const from = text.lastIndexOf('\n', start - 1) + 1
  // A selection ending at the start of a line (after selecting whole lines) does not include it.
  const effectiveEnd = end > start && text[end - 1] === '\n' ? end - 1 : end
  const nl = text.indexOf('\n', effectiveEnd)
  return { from, to: nl === -1 ? text.length : nl }
}

/** Rewrites every line of the selection's span; the selection then covers the rewritten lines (or keeps a caret on its line). */
function mapLines(state: TextState, fn: (lines: string[]) => string[]): Edit {
  const { text, start, end } = clamp(state)
  const { from, to } = lineSpan(text, start, end)
  const lines = text.slice(from, to).split('\n')
  const out = fn(lines).join('\n')
  if (start === end && lines.length === 1) {
    // Keep the caret where it was relative to the line's end (prefixes changed before it).
    const fromEnd = to - start
    const caret = Math.max(from, from + out.length - fromEnd)
    return { from, to, insert: out, selStart: caret, selEnd: caret }
  }
  return { from, to, insert: out, selStart: from, selEnd: from + out.length }
}

const HEADING_RE = /^#{1,6}\s+/
const QUOTE_RE = /^>\s?/
const BULLET_RE = /^(\s*)[-*+]\s+/
const NUMBER_RE = /^(\s*)\d{1,9}[.)]\s+/

/** Toggles a `## ` heading on the selected lines (an existing heading of another level becomes `##`). */
export function toggleHeading(state: TextState): Edit {
  return mapLines(state, lines => {
    const all = lines.filter(l => l.trim()).every(l => /^##\s+/.test(l))
    return lines.map(l => (!l.trim() ? l : all ? l.replace(HEADING_RE, '') : `## ${l.replace(HEADING_RE, '')}`))
  })
}

export function toggleQuote(state: TextState): Edit {
  return mapLines(state, lines => {
    const all = lines.filter(l => l.trim()).every(l => QUOTE_RE.test(l))
    return lines.map(l => (all ? l.replace(QUOTE_RE, '') : `> ${l}`))
  })
}

/** Toggles `- ` bullets on the selected lines; numbered lines become bullets. */
export function toggleBullets(state: TextState): Edit {
  return mapLines(state, lines => {
    const nonEmpty = lines.filter(l => l.trim())
    const all = nonEmpty.length > 0 && nonEmpty.every(l => BULLET_RE.test(l))
    return lines.map(l => {
      if (!l.trim()) return l
      if (all) return l.replace(BULLET_RE, '$1')
      const indent = /^\s*/.exec(l)![0]
      return `${indent}- ${l.slice(indent.length).replace(NUMBER_RE, '').replace(BULLET_RE, '')}`
    })
  })
}

/** Toggles a `1. 2. 3.` list on the selected lines, numbering them in order; bullets become numbers. */
export function toggleNumbered(state: TextState): Edit {
  return mapLines(state, lines => {
    const nonEmpty = lines.filter(l => l.trim())
    const all = nonEmpty.length > 0 && nonEmpty.every(l => NUMBER_RE.test(l))
    let n = 0
    return lines.map(l => {
      if (!l.trim()) return l
      if (all) return l.replace(NUMBER_RE, '$1')
      const indent = /^\s*/.exec(l)![0]
      return `${indent}${++n}. ${l.slice(indent.length).replace(BULLET_RE, '').replace(NUMBER_RE, '')}`
    })
  })
}

/** True when every line the selection touches is a list item (so Tab indents rather than leaving the field). */
export function selectionInList(state: TextState): boolean {
  const { text, start, end } = clamp(state)
  const { from, to } = lineSpan(text, start, end)
  const lines = text.slice(from, to).split('\n').filter(l => l.trim())
  return lines.length > 0 && lines.every(l => BULLET_RE.test(l) || NUMBER_RE.test(l))
}

const INDENT = '  '

/** Indents (or, with `outdent`, un-indents) the selected list lines by two spaces. */
export function indentLines(state: TextState, outdent: boolean): Edit {
  return mapLines(state, lines => lines.map(l => {
    if (!l.trim()) return l
    if (!outdent) return INDENT + l
    return l.startsWith(INDENT) ? l.slice(INDENT.length) : l.replace(/^ /, '')
  }))
}

/**
 * Enter inside a list item: continue the list on the next line (`- `, or the next
 * number). Enter on an EMPTY item ends the list instead (the marker is removed). Null
 * when the caret is not at the end of a list item, so a plain newline is typed.
 */
export function continueList(state: TextState): Edit | null {
  const { text, start, end } = clamp(state)
  if (start !== end) return null
  const lineFrom = text.lastIndexOf('\n', start - 1) + 1
  const lineEnd = text.indexOf('\n', start)
  const line = text.slice(lineFrom, lineEnd === -1 ? text.length : lineEnd)
  if (text.slice(start, lineEnd === -1 ? text.length : lineEnd).trim()) return null // caret mid-line
  const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line)
  const number = /^(\s*)(\d{1,9})([.)])\s+(.*)$/.exec(line)
  if (!bullet && !number) return null
  const content = bullet ? bullet[3] : number![4]
  if (!content.trim()) {
    // An empty item ends the list: its marker goes, and a blank line separates what
    // follows (text right under an item would continue that item in markdown).
    return { from: lineFrom, to: start, insert: '\n', selStart: lineFrom + 1, selEnd: lineFrom + 1 }
  }
  const marker = bullet ? `${bullet[1]}${bullet[2]} ` : `${number![1]}${Number(number![2]) + 1}${number![3]} `
  const insert = `\n${marker}`
  return { from: start, to: end, insert, selStart: start + insert.length, selEnd: start + insert.length }
}

/** Plain insertion at the selection (replacing it), caret after the inserted text. */
export function insertAt(state: TextState, insert: string): Edit {
  const { start, end } = clamp(state)
  return { from: start, to: end, insert, selStart: start + insert.length, selEnd: start + insert.length }
}

// ---- image placeholders ----

/** A file name as alt text: no extension, no markdown-significant characters, bounded. */
export function altFromName(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[[\]()\\`*_<>!#|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (base || 'image').slice(0, 60)
}

/** The placeholder an upload holds its place with; `#upload-<id>` keeps it unique and inert (the renderer shows only its alt text). */
export function uploadPlaceholder(id: string, name: string): string {
  return `![Uploading ${altFromName(name)}…](#upload-${id})`
}

/**
 * Inserts an image placeholder at the selection, on its own line when the caret sits
 * mid-line, so the finished image is a block of its own.
 */
export function insertPlaceholder(state: TextState, placeholder: string): Edit {
  const { text, start, end } = clamp(state)
  const before = start > 0 && text[start - 1] !== '\n' ? '\n' : ''
  const after = end < text.length && text[end] !== '\n' ? '\n' : ''
  const insert = `${before}${placeholder}${after}`
  const caret = start + insert.length
  return { from: start, to: end, insert, selStart: caret, selEnd: caret }
}

/**
 * Replaces an upload's placeholder wherever it now is (the text may have changed
 * while the upload ran). `replacement` '' removes it, along with a now-empty line it
 * leaves behind. Returns null when the placeholder is gone (the writer deleted it).
 * The caret is shifted by the length change when it sat after the placeholder.
 */
export function replacePlaceholder(state: TextState, placeholder: string, replacement: string): TextState | null {
  const { text, start, end } = state
  const at = text.indexOf(placeholder)
  if (at === -1) return null
  let from = at, to = at + placeholder.length
  if (!replacement) {
    // Take one adjacent newline with it so no blank line is left behind.
    if (text[to] === '\n') to++
    else if (from > 0 && text[from - 1] === '\n') from--
  }
  const next = text.slice(0, from) + replacement + text.slice(to)
  const shift = replacement.length - (to - from)
  const move = (p: number) => (p >= to ? p + shift : p > from ? from + replacement.length : p)
  return { text: next, start: move(start), end: move(end) }
}

// ---- mentions and referendum references ----

/**
 * The `@query` or `#digits` being typed right before the caret, or null. A mention
 * starts a word (line start, whitespace or `(`); the query is 2+ characters for
 * accounts, 1+ digits for referenda.
 */
export function activeTrigger(text: string, caret: number): { kind: '@' | '#'; query: string; from: number } | null {
  const head = text.slice(Math.max(0, caret - 80), caret)
  const at = /(?:^|[\s(])@([^\s@()[\]]{2,48})$/.exec(head)
  if (at) return { kind: '@', query: at[1], from: caret - at[1].length - 1 }
  const ref = /(?:^|[\s(])#(\d{1,4})$/.exec(head)
  if (ref) return { kind: '#', query: ref[1], from: caret - ref[1].length - 1 }
  return null
}

/** Replaces the trigger (from the `@`/`#` to the caret) with the chosen token and a trailing space. */
export function completeTrigger(state: TextState, from: number, token: string): Edit {
  const insert = `${token} `
  return { from, to: state.start, insert, selStart: from + insert.length, selEnd: from + insert.length }
}

// ---- preview media ----

const IPFS_IMG_RE = /!\[[^\]]*\]\(\s*<?(\/ipfs\/[A-Za-z0-9]{46,121})>?(?:\s+["'][^)]*["'])?\s*\)/g

/**
 * The media map a preview renders with: every `/ipfs/<cid>` image the draft names maps
 * to itself — our own same-origin path, which serves only CIDs the forum pinned. Any
 * other image URL stays unmapped, so the renderer shows it as a link, exactly as a
 * reader will see it once posted.
 */
export function previewMedia(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(IPFS_IMG_RE)) out[m[1]] = m[1]
  return out
}

// ---- @mention suggestions ----

const SS58_OR_H160 = /^([1-9A-HJ-NP-Za-km-z]{46,48}|0x[0-9a-fA-F]{40})$/
const shortAddr = (addr: string) => (addr.length > 16 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr)

export type Suggestion = { key: string; token: string; primary: string; secondary: string }

/** Why a search hit was offered for what was typed — so a suggestion never looks arbitrary. */
export function matchReason(query: string, r: SearchResult): string {
  const q = query.trim().toLowerCase()
  const addr = (r.label ?? '').toLowerCase()
  const name = r.identity?.display?.trim().toLowerCase() ?? ''
  if (q && addr.startsWith(q)) return 'address starts with this'
  if (q && addr.includes(q)) return 'address contains this'
  if (q && name.includes(q)) return r.identity?.verified ? 'verified identity matches' : 'identity matches'
  if (q && (r.emojiName ?? '').toLowerCase().includes(q)) return 'account emoji name matches'
  return 'account matches'
}

/** Search hits as suggestions: an account names itself (emoji, identity ✓) and says why it matched. */
export function suggestionsFrom(kind: '@' | '#', rows: SearchResult[], query = ''): Suggestion[] {
  const out: Suggestion[] = []
  for (const r of rows) {
    if (kind === '@' && r.type === 'address' && r.label && SS58_OR_H160.test(r.label)) {
      const name = r.identity?.display?.trim()
      out.push({
        key: r.value, token: `@${r.label}`,
        primary: `${r.emojiUrl ? '' : r.emoji ? `${r.emoji} ` : ''}${name || shortAddr(r.label)}${name && r.identity?.verified ? ' ✓' : ''}`,
        secondary: `${name ? `${shortAddr(r.label)} · ` : ''}${matchReason(query, r)}`,
      })
    } else if (kind === '#' && r.type === 'referendum' && r.pallet === 'opengov' && r.index != null) {
      out.push({ key: r.value, token: `#${r.index}`, primary: `#${r.index}`, secondary: r.label || 'Referendum' })
    }
    if (out.length >= 6) break
  }
  return out
}
