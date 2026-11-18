// A referendum's description often opens with its own title as a heading, which the
// page already shows as its h1. This finds that first heading in the post's source —
// markdown (ATX `# Title` or setext `Title\n===`) or a legacy html body
// (`<h1>Title</h1>`) — and drops it when its text is the title. Only the source text
// is cut: what remains still renders through the one forum renderer.

/** Heading text compared loosely: inline markup, entities and case and spacing ignored. */
function loose(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:]$/, '')
    .toLowerCase()
}

/** The body without its leading heading when that heading repeats `title`; otherwise the body unchanged. */
export function stripLeadingTitle(body: string, format: string, title: string | null | undefined): string {
  if (!title) return body
  const want = loose(title)
  if (!want) return body
  if (format === 'html') {
    const m = /^\s*<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>\s*/i.exec(body)
    return m && loose(m[2]) === want ? body.slice(m[0].length) : body
  }
  const atx = /^\s*#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*(?:\r?\n|$)/.exec(body)
  if (atx) return loose(atx[1]) === want ? body.slice(atx[0].length).replace(/^\s*\n/, '') : body
  const setext = /^\s*([^\n]+)\r?\n[ \t]*(=+|-+)[ \t]*(?:\r?\n|$)/.exec(body)
  if (setext) return loose(setext[1]) === want ? body.slice(setext[0].length).replace(/^\s*\n/, '') : body
  return body
}
