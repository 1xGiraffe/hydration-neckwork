// /llms.txt — the compact orientation an automated client reads before it
// spends a context window on the full contract (llmstxt.org: an H1, a
// blockquote summary, then markdown).
//
// It is RENDERED FROM the OpenAPI document rather than written beside it, so
// the route list and the conventions cannot drift from the contract they
// describe: a new route appears here the moment it registers, carrying the same
// summary the Scalar portal shows. Only the framing sentences live in this
// file. The document itself stays the normative source — this is a map to it,
// not a second copy, and it deliberately omits parameters and response schemas.

interface OperationLike {
  tags?: string[]
  summary?: string
}

// Only the fields this renderer reads. `paths` stays `object` because the
// swagger plugin's PathItemObject carries non-operation keys ($ref, parameters,
// servers) that no structural type can express; the loop narrows by method
// name instead.
export interface OpenApiDocLike {
  info?: { title?: string; description?: string }
  paths?: object
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])

interface Entry { method: string; path: string; summary: string }

// Tag order follows first registration, which is already the domain order of
// DATA_ROUTE_PLUGINS (status, chain, accounts, assets, pools, …).
function operationsByTag(doc: OpenApiDocLike): Map<string, Entry[]> {
  const byTag = new Map<string, Entry[]>()
  const paths = (doc.paths ?? {}) as Record<string, Record<string, OperationLike | undefined> | undefined>
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, entry] of Object.entries(methods ?? {})) {
      if (!HTTP_METHODS.has(method) || !entry) continue
      const operation: OperationLike = entry
      const tag = operation.tags?.[0] ?? 'other'
      const entries = byTag.get(tag) ?? []
      entries.push({ method: method.toUpperCase(), path, summary: operation.summary ?? '' })
      byTag.set(tag, entries)
    }
  }
  return byTag
}

export function renderLlmsTxt(doc: OpenApiDocLike, baseUrl: string): string {
  const description = (doc.info?.description ?? '').trim()
  // The document's description opens with the one-paragraph summary of the
  // service; that paragraph becomes the blockquote and the rest (getting
  // started, conventions) follows as-is.
  const [summary, ...conventions] = description.split('\n\n')
  const lines: string[] = [
    `# ${doc.info?.title ?? 'Hydration Data API'}`,
    '',
    `> ${(summary ?? '').replace(/\n/g, ' ').trim()}`,
    '',
    `Base URL: ${baseUrl}. Every path below is relative to it. This file is a map of the surface; the normative contract — parameters, response schemas and the semantics of each route — is the OpenAPI document at ${baseUrl}/openapi.json.`,
  ]
  if (conventions.length) lines.push('', conventions.join('\n\n').trim())

  lines.push('', '## Endpoints')
  for (const [tag, entries] of operationsByTag(doc)) {
    lines.push('', `### ${tag}`, '')
    for (const entry of entries) {
      lines.push(`- \`${entry.method} ${entry.path}\`${entry.summary ? ` — ${entry.summary}` : ''}`)
    }
  }

  lines.push(
    '',
    '## Full contract',
    '',
    `- [OpenAPI document](${baseUrl}/openapi.json): every parameter, response schema and per-route semantics. Unauthenticated.`,
    `- [Interactive documentation](${baseUrl}/docs): the same document rendered, with a test client that sends your token.`,
    `- [Index status](${baseUrl}/v1/status): indexed head, runtime spec version and ingestion lag. Unauthenticated.`,
    '',
  )
  return lines.join('\n')
}
