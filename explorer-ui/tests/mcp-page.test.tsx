import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Mcp } from '../src/pages/Mcp'
import { parseRoute, paths } from '../src/router'

// The /mcp page is the ONE copy of the getting-started documentation: the MCP
// host redirects here. What it can get wrong is therefore expensive — a config
// snippet that is nearly right costs a developer more than none at all — so the
// per-client shapes, the endpoint every snippet points at, the traps the
// agent-instructions block names, and the precision every quoted figure carries
// are all pinned here.

// The default origin when VITE_MCP_URL is unset. It is also half of the query
// keys below, which is how a cached probe result reaches the render.
const MCP_URL = 'https://hydration-mcp.neckwork.net'
const MCP_ENDPOINT = `${MCP_URL}/mcp`

// A bare GET to the endpoint is answered 405 — POST-only and stateless. That is
// the one status that means "reachable and healthy".
const READY = { state: 'ready', status: 405, ms: 7 }
const GATED = { state: 'key', status: 401, ms: 7 }

const TOOLS = [
  { name: 'inspect_entity', title: 'Inspect one entity', description: 'One identifier in, the interpreted record out.' },
  { name: 'get_activity', title: 'Classified activity feed', description: 'type=trade is a family; type=dca returns rows typed trade.' },
]

// Seeding the cache makes useQuery resolve synchronously, so a server render
// can reach the states that only exist after the live probe answers.
function render({ probe, tools }: { probe?: unknown; tools?: typeof TOOLS } = {}): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (probe) queryClient.setQueryData(['mcp-probe', MCP_ENDPOINT], probe)
  if (tools) queryClient.setQueryData(['mcp-tools', MCP_URL], tools)
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}><Mcp /></QueryClientProvider>)
}

// Every client's panel is in the document (all but one carries `hidden`), so
// one render carries all seven configs. This slices out one panel's markup —
// bounded by the next panel, or by the section that follows the last one, so
// the final slice does not swallow the rest of the page.
function panelOf(html: string, clientId: string): string {
  const start = html.indexOf(`id="mcp-panel-${clientId}"`)
  expect(start, `no panel for ${clientId}`).toBeGreaterThan(-1)
  const ends = [html.indexOf('id="mcp-panel-', start + 1), html.indexOf('<h2', start)].filter(i => i > -1)
  return html.slice(start, ends.length ? Math.min(...ends) : undefined)
}

// The copyable snippet alone, without the prose around it — which may quote the
// very shapes the snippet must not use.
function snippetOf(html: string, clientId: string): string {
  const panel = panelOf(html, clientId)
  const match = /<pre class="json cli-block">([\s\S]*?)<\/pre>/.exec(panel)
  expect(match, `no snippet for ${clientId}`).not.toBeNull()
  return match![1]
}

describe('/mcp route', () => {
  it('is reachable at its own path', () => {
    expect(paths.mcp()).toBe('/mcp')
    expect(parseRoute('/mcp')).toEqual({ name: 'mcp' })
    // The tab lives in the query string, so a link to one client still lands here.
    expect(parseRoute('/mcp?client=codex')).toEqual({ name: 'mcp' })
  })
})

describe('setup snippets', () => {
  const html = render({ probe: READY })

  it('offers every client the design names', () => {
    for (const label of ['Claude Code', 'Claude Desktop', 'Cursor', 'Windsurf', 'Codex', 'VS Code', '.mcp.json']) {
      expect(html, `${label} needs a tab`).toContain(label)
    }
  })

  // Each client's real config shape. These differ in ways that are easy to get
  // wrong and impossible to notice until the connection silently fails: the
  // top-level key, the URL field's name, and whether a transport is declared.
  it.each([
    ['claude-code', ['claude mcp add --transport http hydration', MCP_ENDPOINT]],
    ['claude-desktop', ['claude_desktop_config.json', '&quot;mcp-remote&quot;', '&quot;command&quot;: &quot;npx&quot;']],
    ['cursor', ['.cursor/mcp.json', '&quot;mcpServers&quot;', '&quot;url&quot;']],
    ['windsurf', ['~/.codeium/windsurf/mcp_config.json', '&quot;serverUrl&quot;']],
    ['codex', ['~/.codex/config.toml', '[mcp_servers.hydration]', 'url = ']],
    ['vscode', ['.vscode/mcp.json', '&quot;servers&quot;', '&quot;type&quot;: &quot;http&quot;']],
    ['mcp-json', ['.mcp.json', '&quot;mcpServers&quot;', '&quot;type&quot;: &quot;http&quot;']],
  ])('gives %s its own shape', (clientId, expected) => {
    const panel = panelOf(html, clientId)
    for (const needle of expected) expect(panel, `${clientId} snippet`).toContain(needle)
  })

  it('never keys VS Code under mcpServers', () => {
    // VS Code is the one client that keys its servers under `servers`; the
    // common `mcpServers` shape is silently ignored there.
    const panel = panelOf(html, 'vscode')
    expect(panel).toContain('&quot;servers&quot;')
    expect(panel).not.toContain('&quot;mcpServers&quot;')
  })

  // `.mcp.json` is the one snippet a second source also publishes: it is what
  // `claude mcp add --scope project --transport http` writes and what the MCP
  // host serves at /mcp.json. All three have to stay the same object.
  it('publishes the .mcp.json every other source of it writes', () => {
    const panel = panelOf(html, 'mcp-json')
    const code = JSON.stringify({ mcpServers: { hydration: { type: 'http', url: MCP_ENDPOINT } } }, null, 2)
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    expect(panel).toContain(escaped)
  })

  it('leaves the open snippets free of an access key', () => {
    expect(html).toContain('Open, no key')
    expect(html).not.toContain('Authorization: Bearer')
  })

  it('switches to the authorized form when the endpoint answers 401', () => {
    const gated = render({ probe: GATED })
    expect(gated).toContain('Access key required')
    expect(gated).toContain('Authorization: Bearer')
    expect(gated).toContain('&lt;access-key&gt;')
  })

  // Claude Desktop on Windows does not escape spaces inside `args` when it
  // re-invokes npx, so `--header "Authorization: Bearer <key>"` written inline
  // arrives mangled. mcp-remote documents the split: a space-free argument, and
  // the space in an environment value.
  it('never puts a spaced auth header in Claude Desktop args', () => {
    const snippet = snippetOf(render({ probe: GATED }), 'claude-desktop')
    expect(snippet).toContain('Authorization:${HYDRATION_AUTH}')
    expect(snippet).toContain('&quot;env&quot;')
    expect(snippet).not.toContain('Authorization: Bearer')
  })

  // The MCP host publishes how to REACH it and never a credential, so the
  // gated branch cannot claim the served object matches a block carrying one.
  it('does not claim /mcp.json carries the headers it does not serve', () => {
    const open = panelOf(html, 'mcp-json')
    expect(open).toContain('returns the same object')
    const gated = panelOf(render({ probe: GATED }), 'mcp-json')
    expect(gated).not.toContain('returns the same object')
    expect(gated).toContain('without the')
  })

  it('points every snippet at this deployment and at nothing else', () => {
    for (const clientId of ['claude-code', 'claude-desktop', 'cursor', 'windsurf', 'codex', 'vscode', 'mcp-json']) {
      const panel = panelOf(html, clientId)
      const hosts = [...panel.matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map(m => m[0])
      const unexpected = hosts.filter(h => ![
        MCP_URL,
        'https://hydration-data.neckwork.net',
        'https://hydration-preis.neckwork.net',
      ].includes(h))
      expect(unexpected, `${clientId} reaches an unexpected host`).toEqual([])
    }
  })
})

describe('the live probe', () => {
  it('calls only the documented 405 healthy', () => {
    expect(render({ probe: READY })).toContain('Ready')
  })

  // A misrouted vhost answers 404, a placeholder answers 200, a banned client
  // answers 403 — none of them is an MCP endpoint, and every one of them read
  // as "Ready" while no agent could connect.
  it.each([200, 400, 403, 404])('does not call %i ready', status => {
    const html = render({ probe: { state: 'unexpected', status, ms: 7 } })
    expect(html).not.toContain('>Ready')
    expect(html).toContain('Unexpected answer')
    expect(html).toContain(`HTTP ${status}`)
  })

  it('reports a server error as unavailable', () => {
    const html = render({ probe: { state: 'down', status: 502, ms: 7 } })
    expect(html).toContain('Unavailable')
    expect(html).not.toContain('>Ready')
  })

  // The timing measures a GET the endpoint refuses by design. Naming the status
  // beside it is what keeps it from reading as a handshake.
  it('labels the latency with the status it measured', () => {
    expect(render({ probe: READY })).toContain('HTTP 405 in 7 ms')
  })
})

describe('the auth statement', () => {
  // A gated deployment whose probe is blocked would otherwise hand out the
  // unauthorized snippets AND say in prose that no key is needed.
  it('never promises "no key" before the probe has answered', () => {
    const html = render()
    expect(html).not.toContain('Open, no key')
    expect(html).not.toContain('none of them needs a key')
  })

  it('says plainly when the probe could not establish it', () => {
    const html = render({ probe: { state: 'down', status: 502, ms: 7 } })
    expect(html).not.toContain('Open, no key')
    expect(html).toContain('Not established')
    expect(html).toContain('could not be established')
  })

  it('says "open" only once the endpoint answered as open', () => {
    expect(render({ probe: READY })).toContain('Open, no key')
  })
})

describe('agent instructions', () => {
  const html = render({ probe: READY })

  it('names the traps a model cannot infer from a tool schema', () => {
    // Each of these has cost somebody a wrong answer; the block exists for them.
    expect(html, 'amounts arrive scaled').toMatch(/already scaled and named/)
    expect(html, 'do not re-scale').toMatch(/[Nn]ever divide by decimals/)
    expect(html, 'type=trade is a family').toMatch(/type=trade` also returns/)
    expect(html, 'type=dca does not narrow to DCA').toMatch(/type=dca` does NOT narrow to DCA at all/)
    expect(html, 'unconfirmed rows are not facts').toMatch(/Rows marked unconfirmed are not facts yet/)
    expect(html, 'isolated markets').toMatch(/isolated money markets/)
    expect(html, 'related-account scoping').toMatch(/related-account set/)
  })

  // An unknown `action` is validated by the tool and refused with the accepted
  // values; only an unknown `token` comes back as an empty page. A block that
  // merged the two taught a model to keep paging past a refusal.
  it('separates the filter that empties from the filter that is refused', () => {
    expect(html, 'an unknown token is empty, not an error').toMatch(/unknown `token` matches nothing/)
    expect(html, 'an unknown action is refused').toMatch(/unknown `action` is refused outright/)
    expect(html, 'the two are not merged').not.toMatch(/unknown `action` or `token`/)
  })

  // An unconfirmed row above the finalized head sits in a REAL block whose
  // height is quotable; only a transaction-pool row has no height at all. The
  // blanket "never print their block height" made an agent withhold a fact.
  it('splits the two kinds of unconfirmed row', () => {
    expect(html, 'the pool kind has no block').toMatch(/transaction-pool row has no block at all/)
    expect(html, 'the unfinalized kind has a real height').toMatch(/height IS quotable/)
    expect(html, 'the blanket rule is gone').not.toMatch(/never print their block height as a real one/)
  })

  // Three isolated markets answer live today — `core`, `gigahdx` and `bil` —
  // and the set grows. A block naming a closed pair teaches a model a
  // two-market world, in which a BIL position has to be filed under one of the
  // other two; so the rule is stated per market, with the live set as examples.
  it('states the money-market rule per market, not as a closed list', () => {
    expect(html, 'the set is open').toMatch(/SEVERAL isolated money markets/)
    for (const market of ['core', 'gigahdx', 'bil']) {
      expect(html, `${market} is a live isolated market`).toContain('`' + market + '`')
    }
    expect(html, 'never blended across markets').toMatch(/never combine them across markets/)
    expect(html, 'risk is the lowest of an account’s own markets').toMatch(/LOWEST health factor among the markets it is actually in/)
    expect(html, 'the old two-market wording is gone').not.toMatch(/primary and GIGAHDX money markets are isolated/)
  })

  // The block is pasted into a repository's AGENTS.md, so whatever it says about
  // the shape of a reply is what every model reading that repo will believe. It
  // used to call the figures final; they are rounded, and an agent that needs an
  // exact one has to ask for it.
  it('tells the model the figures are rounded and how to get an exact one', () => {
    expect(html).toMatch(/ROUNDED for reading/)
    expect(html).toMatch(/three significant digits/)
    expect(html).toMatch(/format: &quot;json&quot;` when you need an exact value/)
    expect(html, 'the figures are not final').not.toMatch(/They are final/)
  })

  it('offers the file every tool reads it from', () => {
    for (const file of ['AGENTS.md', 'CLAUDE.md', '.cursor/rules/hydration-mcp.mdc']) {
      expect(html).toContain(file)
    }
  })
})

// Everything this page shows as tool output is quoted from a real reply. The
// tools render on the shared rough scale — ~3 significant digits with k/M/B
// compaction, and the subscript-zero form below 0.001 — so a figure written at
// a precision the tools never emit is, by construction, invented. These pin the
// shapes that gave the page away: cent-precise dollars, grouped thousands with
// decimals, and a price written out in leading zeros.
describe('quoted tool output', () => {
  const html = render({ probe: READY })
  const replies = [...html.matchAll(/<pre class="mcp-reply-body mono">([\s\S]*?)<\/pre>/g)].map(m => m[1])
  const spec = html.slice(html.indexOf('mcp-spec-out'), html.indexOf('mcp-spec-foot'))

  it('quotes four replies and the specimen', () => {
    expect(replies).toHaveLength(4)
    expect(spec).toContain('400 SOL')
  })

  it('never renders a USD figure at a precision the tools do not emit', () => {
    for (const text of [...replies, spec, html.slice(html.indexOf('Hydration MCP'))]) {
      // $38,476.35 / $1,354,913.55 — the rough scale emits $38.5k and $1.35M.
      expect(text, 'cent-precise grouped USD').not.toMatch(/\$\d{1,3}(,\d{3})+\.\d\d/)
    }
  })

  it('renders a sub-cent price in the subscript-zero form', () => {
    const joined = replies.join('\n')
    expect(joined).toContain('$0.0₁7817')
    expect(joined, 'a written-out small price').not.toMatch(/\$0\.00\d/)
  })

  it('keeps the specimen on the rough scale', () => {
    expect(spec).toContain('308 jitoSOL')
    expect(spec).toContain('$38.5k')
    // 308.1 is F.exact's answer, not compactAmount's.
    expect(spec).not.toContain('308.1')
  })

  // The reply frames are verbatim, which is the whole point of quoting them, so
  // a referendum title inside one has to be the title the tool sent.
  it('quotes the referendum title the tool sent, not a shortened one', () => {
    const governance = replies.find(r => r.includes('OpenGov #410')) ?? ''
    expect(governance).toContain('Reduce Omnipool weight cap for aDOT (DOT) from 30% to 10%')
  })
})

describe('the live reads', () => {
  it('renders the tools the server reported, not a baked-in list', () => {
    const html = render({ tools: TOOLS })
    expect(html).toContain('inspect_entity')
    expect(html).toContain('Classified activity feed')
    expect(html).toContain('2 tools')
  })

  // The page normalizes /tools.json where it arrives — in the query function,
  // the one place the response is untrusted — so a row without a usable name
  // never reaches the cache this test seeds. Seeding a malformed list here
  // would assert against a state the page cannot be in; the parse is covered by
  // the live fetch instead.
  it('names every tool the server reported', () => {
    const html = render({ tools: TOOLS })
    for (const tool of TOOLS) expect(html).toContain(tool.name)
  })

  it('degrades to the endpoint when the tool list cannot be read', () => {
    // No cached data and no network in a server render: the section must still
    // say where the live list is rather than rendering an empty card.
    const html = render()
    expect(html).toMatch(/Reading the tool registry|llms\.txt/)
  })
})

describe('the surface map', () => {
  const html = render({ probe: READY })

  it('points at each sibling surface with its own audience', () => {
    expect(html).toContain('https://hydration-data.neckwork.net/docs')
    expect(html).toContain('https://hydration-preis.neckwork.net')
    expect(html).toContain(paths.apiTokens())
  })

  // The public REST API is a frozen feed for the Hydration app and the data
  // aggregators, not a door this page offers a developer.
  it('does not offer the public REST API', () => {
    expect(html).not.toContain('hydration-api.neckwork.net')
    expect(html).not.toContain('Public API')
  })

  it('says plainly that the server is read-only and holds no user data', () => {
    expect(html).toMatch(/signs nothing and submits nothing/)
    expect(html).toMatch(/Watchlists, notes, profiles/)
  })
})

// Headings carry the document outline, and a reader moving by heading is the
// one who most needs it to be in order. The page's own title is the h1, each
// section is an h2, and a recorded question is an h3 under its section.
describe('the document outline', () => {
  const html = render({ probe: READY })
  const levels = [...html.matchAll(/<h([1-6])[ >]/g)].map(m => Number(m[1]))

  it('starts at h1 and never skips a level', () => {
    expect(levels[0]).toBe(1)
    expect(levels.filter(l => l === 1)).toHaveLength(1)
    let deepest = 1
    for (const level of levels) {
      expect(level, `h${level} follows h${deepest}`).toBeLessThanOrEqual(deepest + 1)
      deepest = level
    }
  })

  it('titles every section it links to from the hero', () => {
    expect(html).toContain('id="mcp-setup"')
    expect(html).toContain('id="mcp-tools"')
  })
})
