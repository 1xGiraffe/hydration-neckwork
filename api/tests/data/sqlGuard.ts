// A ClickHouse SELECT alias is visible to the rest of its own statement —
// WHERE, GROUP BY, ORDER BY, HAVING and every other select item — and it takes
// precedence over a source column of the same name. Aliasing an expression to
// the name of a column that expression itself reads therefore changes what
// every later reference means:
//
//   toString(interval_start) AS interval_start … WHERE interval_start < toDateTime(…)
//     → String vs DateTime: "There is no supertype"
//   argMax(block_height, block_height) AS block_height, argMax(asset_in, block_height)
//     → "Aggregate function … is found inside another aggregate function"
//   toString(asset_id) AS asset_id … WHERE asset_id = {assetId:UInt32}
//     → String vs UInt32
//
// Every one of these was a live 500 on the Data API, and none is visible to a
// contract test whose fake client never parses SQL. This guard does the one
// check that catches the whole class: within a single SELECT statement, an
// alias that shadows a column its own expression reads must not be referenced
// again — except in HAVING, the one clause where the alias IS the intended
// target (the identity-display fold filters on it deliberately).
//
// It is wired into the test fake client, so every query a route sends during
// the contract tests is checked, and a new self-shadowing alias fails the
// route's own test instead of the first live request.

const KEYWORDS_AFTER_HAVING = /\b(GROUP BY|ORDER BY|LIMIT|SETTINGS|UNION ALL)\b/i

interface Span { start: number; end: number }

// Each SELECT with the extent of its own statement: from the keyword to the
// end of the text, or to the closing parenthesis of the subquery it lives in.
function selectStatements(text: string): Span[] {
  const spans: Span[] = []
  const re = /\bSELECT\b/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    let depth = 0
    let end = text.length
    for (let i = match.index; i < text.length; i++) {
      const ch = text[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth < 0) { end = i; break }
      }
    }
    spans.push({ start: match.index, end })
  }
  return spans
}

// The select list of one statement (between SELECT and its depth-0 FROM), as
// an absolute span; null when the statement has no FROM (SELECT timezone()).
function selectListSpan(text: string, statement: Span): Span | null {
  const start = statement.start + 'SELECT'.length
  let depth = 0
  for (let i = start; i < statement.end; i++) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (depth === 0 && /\bFROM\b/i.test(text.slice(i, i + 4)) && /\s/.test(text[i - 1] ?? ' ')) {
      return { start, end: i }
    }
  }
  return null
}

function splitTopLevel(list: string): string[] {
  const items: string[] = []
  let depth = 0
  let current = ''
  for (const ch of list) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) { items.push(current); current = '' } else current += ch
  }
  items.push(current)
  return items
}

// Blank every parenthesised subquery: it is its own scope, so its references
// to the alias's name are the inner statement's business (checked on its own
// pass), not this one's.
function blankSubqueries(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '(' && /^\(\s*SELECT\b/i.test(text.slice(i))) {
      let depth = 0
      let j = i
      for (; j < text.length; j++) {
        if (text[j] === '(') depth += 1
        else if (text[j] === ')') { depth -= 1; if (depth === 0) break }
      }
      out += ' '.repeat(j - i + 1)
      i = j + 1
      continue
    }
    out += text[i]
    i += 1
  }
  return out
}

// A bare identifier: not a qualified column (`t.name`), not a bound parameter
// (`{name:Type}`), not part of a longer word.
function bareIdentifier(name: string): RegExp {
  return new RegExp(`(?<![\\w.{\`])${name}(?![\\w:\`])`, 'i')
}

export function assertNoShadowedAlias(sql: string): void {
  // Line comments (the `-- data:…` markers) and string literals are not code.
  const text = sql.replace(/--[^\n]*/g, ' ').replace(/'[^']*'/g, "''")
  for (const statement of selectStatements(text)) {
    const list = selectListSpan(text, statement)
    if (!list) continue
    const items = splitTopLevel(text.slice(list.start, list.end))
    items.forEach((item, index) => {
      const match = /^\s*([\s\S]*\S)\s+AS\s+(\w+)\s*$/i.exec(item)
      if (!match) return
      const [, expression, alias] = match
      if (!bareIdentifier(alias).test(expression)) return
      const otherItems = items.filter((_, i) => i !== index).join(',')
      let rest = `${text.slice(statement.start + 'SELECT'.length, list.start)}${otherItems}${text.slice(list.end, statement.end)}`
      rest = blankSubqueries(rest)
      const having = rest.search(/\bHAVING\b/i)
      if (having >= 0) {
        const after = rest.slice(having).search(KEYWORDS_AFTER_HAVING)
        rest = rest.slice(0, having) + (after >= 0 ? rest.slice(having + after) : '')
      }
      if (bareIdentifier(alias).test(rest)) {
        throw new Error(
          `SQL alias "${alias}" shadows a column its own expression reads and is referenced again in the same statement; `
          + `ClickHouse resolves that reference to the alias (a live 500). Give the alias its own name.\n${sql}`,
        )
      }
    })
  }
}
