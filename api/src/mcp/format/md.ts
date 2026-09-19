/**
 * Markdown builders, dependency-free.
 *
 * Every tool's default rendering is markdown a model reads directly, so these
 * favour density over decoration: no leading `#` (the tool name is the heading),
 * no blank-line padding, and no table that exists only to hold a header row.
 *
 * The one thing that must never be silent is loss. A table with no rows says so,
 * a `kv` pair with no value is dropped rather than printed as an empty claim,
 * and `budget` states how much it cut and how to ask for less.
 */

const NONE = '_none_'

export const h2 = (text: string): string => `## ${text}`
export const h3 = (text: string): string => `### ${text}`

/**
 * A pipe or a newline inside a value would end the cell and shear the rest of
 * the row into the wrong columns. Tag names, identity displays, call names and
 * error docs are all chain- or user-authored, so escaping happens here rather
 * than at each call site.
 */
export function escapeCell(s: string | null | undefined): string {
  if (s == null) return ''
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

/**
 * A definition list. A pair whose value is null/undefined/empty is DROPPED — an
 * absent figure and a zero are different claims, and printing `Fee: —` for
 * every row an agent did not ask about only spends tokens. Pass the dash
 * explicitly where absence is the answer.
 */
export function kv(pairs: [string, string | null | undefined][]): string {
  return pairs
    .filter((p): p is [string, string] => p[1] != null && String(p[1]).trim() !== '')
    .map(([k, v]) => `- **${k}:** ${escapeCell(v)}`)
    .join('\n')
}

const NUMERIC = /^[-+]?[$€£]?\s*[\d.,]+\s*(?:[kMBTQ%]|bp)?\b/

/**
 * A GitHub-flavoured table. Columns whose values all read as numbers are
 * right-aligned, so a column of amounts lines up on its magnitude.
 *
 * With no rows it returns a stated "none" line instead of a bare header: an
 * empty table looks like a rendering bug, while "none" is an answer. Pass
 * `emptyNote` to say WHY it is empty (an unknown `action` or `token` filter
 * silently matches nothing upstream, and that is worth naming).
 */
export function table(
  headers: string[],
  rows: (string | null | undefined)[][],
  emptyNote?: string,
): string {
  if (!rows.length) return emptyNote ? `${NONE} — ${emptyNote}` : NONE
  const cells = rows.map(r => headers.map((_, i) => escapeCell(r[i])))
  const align = headers.map((_, i) => {
    const values = cells.map(r => r[i]).filter(v => v !== '')
    return values.length > 0 && values.every(v => NUMERIC.test(v)) ? '---:' : '---'
  })
  return [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `| ${align.join(' | ')} |`,
    ...cells.map(r => `| ${r.join(' | ')} |`),
  ].join('\n')
}

/** A bullet list; empty entries are dropped, and an empty list renders as "none". */
export function bullets(items: (string | null | undefined)[]): string {
  const shown = items.filter((s): s is string => s != null && String(s).trim() !== '')
  return shown.length ? shown.map(s => `- ${s}`).join('\n') : NONE
}

/** A titled block, or nothing at all when the body is empty. */
export function section(title: string, body: string | null | undefined): string {
  if (body == null || !String(body).trim()) return ''
  return `${h2(title)}\n${String(body).trim()}`
}

/** Join the parts that have content, one blank line between. */
export function joinBlocks(...parts: (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => p != null && String(p).trim() !== '')
    .map(p => String(p).trim())
    .join('\n\n')
}

/**
 * A fenced block. The fence grows past the longest backtick run inside the
 * text, so a payload that itself contains a fence (a decoded call carrying
 * markdown, a referendum body) cannot close the block early.
 */
export function code(text: string, lang = ''): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${lang}\n${text}\n${fence}`
}

/** A parenthetical the model should read as commentary, not as a figure. */
export const note = (text: string): string => `_${text}_`

/**
 * Trim a rendered answer to fit a context budget, at a LINE boundary, and say
 * so. Silent truncation is the failure mode to avoid: a model handed half a
 * table has no way to know the tail existed, and will summarise the visible
 * part as the whole. The appended line states how much was dropped and — when
 * the caller supplies one — how to narrow the query instead.
 */
export function budget(text: string, maxChars: number, note?: string): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return text
  if (text.length <= maxChars) return text
  const advice = note ? ` ${note}` : ''
  const marker = (droppedChars: number, droppedLines: number) =>
    `\n\n_Truncated: ${droppedChars.toLocaleString('en-US')} more characters` +
    (droppedLines > 0 ? ` (${droppedLines.toLocaleString('en-US')} lines)` : '') +
    ` not shown.${advice}_`
  // Reserve room for the truncation line itself, so the result really fits.
  const reserve = 80 + advice.length
  const room = Math.max(0, maxChars - reserve)
  let cut = text.lastIndexOf('\n', room)
  // A single line longer than the budget has no boundary to cut at; take the
  // hard cut rather than returning nothing.
  if (cut <= 0) cut = room
  const kept = text.slice(0, cut).replace(/\s+$/, '')
  const dropped = text.slice(cut)
  const droppedLines = dropped.split('\n').filter(l => l.trim() !== '').length
  return kept + marker(dropped.length, droppedLines)
}
