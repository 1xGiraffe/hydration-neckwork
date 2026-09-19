import { useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, navigate, paths, redirect, useQueryValue } from '../router'
import { Copy, CopyTextButton, Crumbs, F } from '../components/ui'
import { DATA_API_URL, PREIS_URL } from '../surfaces'

// /mcp — getting started with the Hydration MCP server, and the map of which
// developer surface answers which question.
//
// The MCP host itself serves no documentation: `GET /` there redirects here, so
// this page is the single copy. What it cannot know at build time it asks the
// host for at render time — the tool table from /tools.json and the endpoint's
// own liveness from /mcp — so a tool that registers appears here with no edit,
// and a gated deployment rewrites its own setup snippets.
//
// Every figure this page shows as tool output is QUOTED from a real reply, not
// retyped. The tools round for reading (~3 significant digits, k/M/B, the
// subscript-zero form for dust), and a page that prettied those numbers up
// would be teaching both the reader and — through the agent-instructions block
// — their model that replies carry a precision the tools never emit.

// Module-private on purpose: nothing outside this page needs them, and a
// non-literal export here would cost the file its fast refresh.
const MCP_URL = (import.meta.env.VITE_MCP_URL as string | undefined) || 'https://hydration-mcp.neckwork.net'
const MCP_ENDPOINT = `${MCP_URL}/mcp`

const ACCESS_KEY = '<access-key>'

/* ============ live reads ============ */

interface McpTool { name: string; title: string; description: string }

// /tools.json is another service's response, so it is parsed rather than cast.
// A row without a usable name is dropped instead of rendering as a nameless
// tool, and a missing title or description degrades to an empty string.
function parseTools(body: unknown): McpTool[] {
  if (!Array.isArray(body)) throw new Error('tools.json did not return a list')
  const tools: McpTool[] = []
  for (const item of body) {
    if (typeof item !== 'object' || item === null) continue
    const { name, title, description } = item as Record<string, unknown>
    if (typeof name !== 'string' || name === '') continue
    tools.push({
      name,
      title: typeof title === 'string' ? title : '',
      description: typeof description === 'string' ? description : '',
    })
  }
  return tools
}

// The registry as the host reports it. A failure is not an error state worth a
// red box — the page still tells you how to connect, and says where the live
// list is.
function useMcpTools() {
  return useQuery({
    queryKey: ['mcp-tools', MCP_URL],
    queryFn: async ({ signal }): Promise<McpTool[]> => {
      const res = await fetch(`${MCP_URL}/tools.json`, { signal })
      if (!res.ok) throw new Error(`tools.json answered ${res.status}`)
      return parseTools(await res.json())
    },
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

// A bare GET to /mcp answers 405: the endpoint is stateless and POST-only, so
// there is no stream for a GET to open. That makes 405 the one healthy answer
// and every other status a finding — a 404 from a misrouted vhost, a 200 from a
// placeholder page and a 403 from the edge all mean no agent can connect, and
// reading them as "not a server error, therefore fine" would show Ready over a
// dead endpoint. 401 is the gated deployment: MCP_ACCESS_KEYS is set, so the
// open snippets below would be rejected and each switches to its authorized
// form.
const HEALTHY_PROBE_STATUS = 405

type ProbeState = 'ready' | 'key' | 'unexpected' | 'down'
interface Probe { state: ProbeState; status: number; ms: number }

function useMcpProbe() {
  return useQuery({
    queryKey: ['mcp-probe', MCP_ENDPOINT],
    queryFn: async ({ signal }): Promise<Probe> => {
      const started = performance.now()
      const res = await fetch(MCP_ENDPOINT, { method: 'GET', signal })
      const ms = Math.max(0, Math.round(performance.now() - started))
      const state: ProbeState = res.status === HEALTHY_PROBE_STATUS ? 'ready'
        : res.status === 401 ? 'key'
          : res.status >= 500 ? 'down'
            : 'unexpected'
      return { state, status: res.status, ms }
    },
    staleTime: 30_000,
    // Every answer above is a resolved fetch, so a retry could only ever repeat
    // a real outage. One honest answer is enough.
    retry: false,
  })
}

// What the page knows about this deployment's auth, which is not the same as
// what it assumes. Until the probe answers — and if it never does — the honest
// value is `unknown`, and the prose has to say so rather than promise a reader
// that the snippets below need no key.
type Auth = 'open' | 'key' | 'unknown'

/* ============ snippets ============ */

// A snippet with the file it belongs in named on its own line and a copy that
// confirms in place. `.json .cli-block` is the app's existing code block; the
// frame around it is what turns it into a labelled, copyable artifact.
function Snippet({ path, code }: { path: string; code: string }) {
  return (
    <div className="mcp-snip">
      <div className="mcp-snip-head">
        <span className="mcp-snip-path mono">{path}</span>
        <CopyTextButton label="copy" text={code} />
      </div>
      <pre className="json cli-block">{code}</pre>
    </div>
  )
}

interface SetupClient {
  id: string
  label: string
  path: string
  where: (restricted: boolean) => ReactNode
  code: (restricted: boolean) => string
  verify: (restricted: boolean) => ReactNode
}

// Each client's real config shape, not a generic one: the key, the transport
// field and the place a header can be set differ per tool, and a snippet that
// is nearly right costs more than none at all.
const SETUP_CLIENTS: SetupClient[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    path: 'terminal',
    where: restricted => restricted
      ? <>Run this in a terminal, from the project you want it in. Replace <code className="mono">{ACCESS_KEY}</code> with the key this deployment was configured with.</>
      : <>Run this in a terminal, from the project you want it in. Add <code className="mono">--scope project</code> to write it into the project&rsquo;s <code className="mono">.mcp.json</code> instead of your own machine&rsquo;s config &mdash; that is the last tab, and the file is the same either way.</>,
    code: restricted => restricted
      ? `claude mcp add --transport http hydration ${MCP_ENDPOINT} \\\n  --header "Authorization: Bearer ${ACCESS_KEY}"`
      : `claude mcp add --transport http hydration ${MCP_ENDPOINT}`,
    verify: () => <>run <code className="mono">claude mcp list</code>, or <code className="mono">/mcp</code> inside a session &mdash; <code className="mono">hydration</code> is listed as connected.</>,
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    path: 'claude_desktop_config.json',
    where: restricted => restricted
      ? <>The Add custom connector dialog cannot set a header, so a gated endpoint has to go in the config file (Settings &rarr; Developer &rarr; Edit Config), bridged through stdio. The header is split across an argument and an environment variable deliberately: <code className="mono">mcp-remote</code> documents that Claude Desktop on Windows does not escape spaces inside <code className="mono">args</code>, so an inline <code className="mono">Authorization: Bearer &hellip;</code> arrives mangled. The argument therefore carries no space, and the space lives in the value. Replace <code className="mono">{ACCESS_KEY}</code>, then restart the app.</>
      : <>Settings &rarr; Connectors &rarr; Add custom connector takes the endpoint URL on its own. To keep it in the config file instead (Settings &rarr; Developer &rarr; Edit Config), bridge it through stdio &mdash; that file starts local servers, so a remote one needs a bridge &mdash; then restart the app.</>,
    code: restricted => restricted
      ? `{\n  "mcpServers": {\n    "hydration": {\n      "command": "npx",\n      "args": [\n        "-y", "mcp-remote", "${MCP_ENDPOINT}",\n        "--header", "Authorization:\${HYDRATION_AUTH}"\n      ],\n      "env": {\n        "HYDRATION_AUTH": "Bearer ${ACCESS_KEY}"\n      }\n    }\n  }\n}`
      : `{\n  "mcpServers": {\n    "hydration": {\n      "command": "npx",\n      "args": ["-y", "mcp-remote", "${MCP_ENDPOINT}"]\n    }\n  }\n}`,
    verify: () => <>Settings &rarr; Connectors shows <code className="mono">hydration</code>, and the tool menu in a new chat lists its tools.</>,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    path: '.cursor/mcp.json',
    where: restricted => restricted
      ? <>Add it to <code className="mono">.cursor/mcp.json</code> in the project, or <code className="mono">~/.cursor/mcp.json</code> for every project, and replace <code className="mono">{ACCESS_KEY}</code>. Cursor expands <code className="mono">{'${env:NAME}'}</code> here, which keeps the key out of the file.</>
      : <>Add it to <code className="mono">.cursor/mcp.json</code> in the project, or <code className="mono">~/.cursor/mcp.json</code> for every project.</>,
    code: restricted => restricted
      ? `{\n  "mcpServers": {\n    "hydration": {\n      "url": "${MCP_ENDPOINT}",\n      "headers": {\n        "Authorization": "Bearer ${ACCESS_KEY}"\n      }\n    }\n  }\n}`
      : `{\n  "mcpServers": {\n    "hydration": {\n      "url": "${MCP_ENDPOINT}"\n    }\n  }\n}`,
    verify: () => <>Cursor Settings &rarr; Tools &amp; MCP lists <code className="mono">hydration</code> with its tools enabled.</>,
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    path: '~/.codeium/windsurf/mcp_config.json',
    where: restricted => restricted
      ? <>Add it to Windsurf&rsquo;s MCP config, replace <code className="mono">{ACCESS_KEY}</code>, then press Refresh in the Cascade MCP panel.</>
      : <>Add it to Windsurf&rsquo;s MCP config, then press Refresh in the Cascade MCP panel. Windsurf keys a remote server under <code className="mono">serverUrl</code>, not <code className="mono">url</code>, and keeps this file globally rather than per project.</>,
    code: restricted => restricted
      ? `{\n  "mcpServers": {\n    "hydration": {\n      "serverUrl": "${MCP_ENDPOINT}",\n      "headers": {\n        "Authorization": "Bearer ${ACCESS_KEY}"\n      }\n    }\n  }\n}`
      : `{\n  "mcpServers": {\n    "hydration": {\n      "serverUrl": "${MCP_ENDPOINT}"\n    }\n  }\n}`,
    verify: () => <>the Cascade MCP panel lists <code className="mono">hydration</code> with its tools.</>,
  },
  {
    id: 'codex',
    label: 'Codex',
    path: '~/.codex/config.toml',
    where: restricted => restricted
      ? <>Codex will not take a literal token in <code className="mono">config.toml</code>: name the environment variable it should read, and <code className="mono">export HYDRATION_MCP_KEY={ACCESS_KEY}</code> in the shell that launches Codex. <code className="mono">codex mcp add hydration --url {MCP_ENDPOINT} --bearer-token-env-var HYDRATION_MCP_KEY</code> writes exactly this block.</>
      : <>A <code className="mono">url</code> key is what makes it a remote Streamable HTTP server; no experimental flag is needed for one. <code className="mono">codex mcp add hydration --url {MCP_ENDPOINT}</code> writes exactly this block for you. Codex keeps MCP servers globally &mdash; there is no project-scoped Codex config &mdash; so this one server serves every repo.</>,
    code: restricted => restricted
      ? `[mcp_servers.hydration]\nurl = "${MCP_ENDPOINT}"\nbearer_token_env_var = "HYDRATION_MCP_KEY"`
      : `[mcp_servers.hydration]\nurl = "${MCP_ENDPOINT}"`,
    verify: () => <><code className="mono">codex mcp get hydration</code> reports <code className="mono">transport: streamable_http</code> with this URL &mdash; plain <code className="mono">codex mcp list</code> lists the server but not its transport.</>,
  },
  {
    id: 'vscode',
    label: 'VS Code',
    path: '.vscode/mcp.json',
    where: restricted => restricted
      ? <>Add it to <code className="mono">.vscode/mcp.json</code> by hand &mdash; the Add Server prompt cannot set an auth header. VS Code keys its servers under <code className="mono">servers</code>, not <code className="mono">mcpServers</code>.</>
      : <>Add it to <code className="mono">.vscode/mcp.json</code>. VS Code keys its servers under <code className="mono">servers</code>, not <code className="mono">mcpServers</code>.</>,
    code: restricted => restricted
      ? `{\n  "servers": {\n    "hydration": {\n      "type": "http",\n      "url": "${MCP_ENDPOINT}",\n      "headers": {\n        "Authorization": "Bearer ${ACCESS_KEY}"\n      }\n    }\n  }\n}`
      : `{\n  "servers": {\n    "hydration": {\n      "type": "http",\n      "url": "${MCP_ENDPOINT}"\n    }\n  }\n}`,
    verify: () => <>run <code className="mono">MCP: List Servers</code> from the Command Palette &mdash; <code className="mono">hydration</code> is running.</>,
  },
  {
    id: 'mcp-json',
    label: '.mcp.json',
    path: '.mcp.json',
    where: restricted => restricted
      ? <>Save this at the project root. Keep the key out of the commit &mdash; most clients expand <code className="mono">{'${VAR}'}</code> here, and an environment variable is the safer place for it.</>
      : <>Save this at the project root and commit it, and every agent on the team connects to the same server. It is byte for byte what <code className="mono">claude mcp add --scope project --transport http hydration {MCP_ENDPOINT}</code> writes.</>,
    code: restricted => restricted
      ? `{\n  "mcpServers": {\n    "hydration": {\n      "type": "http",\n      "url": "${MCP_ENDPOINT}",\n      "headers": {\n        "Authorization": "Bearer ${ACCESS_KEY}"\n      }\n    }\n  }\n}`
      : `{\n  "mcpServers": {\n    "hydration": {\n      "type": "http",\n      "url": "${MCP_ENDPOINT}"\n    }\n  }\n}`,
    // The published config carries the connection and never a key, so in the
    // gated form the served object is the block above MINUS its `headers`.
    verify: restricted => restricted
      ? <><code className="mono">curl {MCP_URL}/mcp.json</code> returns this object without the <code className="mono">headers</code> &mdash; the server publishes how to reach it, never how to authorize. That part is yours to add.</>
      : <><code className="mono">curl {MCP_URL}/mcp.json</code> returns the same object.</>,
  },
]

// The block a repository keeps so its agents reach for the chain instead of
// recalling it. The traps below are the ones a model cannot infer from a tool
// schema, and each has cost somebody a wrong answer. The amounts bullet quotes
// a real reply: an example written at a precision the tools never emit would
// teach every model that reads this file to quote figures that do not exist.
const AGENT_INSTRUCTIONS = `## Hydration MCP

Use the \`hydration\` MCP tools for every Hydration chain fact. Do not answer from memory: balances, prices, health factors and referendum states change each block.

- Start with \`inspect_entity\`. It takes any identifier — a block height, \`height-index\`, a hash, an SS58 or EVM address, an asset symbol, a pool, a referendum — and returns the resolved record, so you rarely have to pick a route yourself.
- Amounts come back already scaled and named, e.g. \`400 SOL → 308 jitoSOL · $38.5k\`. Never divide by decimals, and never re-scale a figure you read in a reply.
- Those figures are ROUNDED for reading — about three significant digits, with \`k\`/\`M\`/\`B\` compaction and a subscript-zero form for small prices (\`$0.0₁7817\`). Quote them as the reply gives them, and pass \`format: "json"\` when you need an exact value to compute with.
- \`get_activity\` type filters are families, not row types. \`type=trade\` also returns OTC, intent and cross-chain-swap rows. \`type=dca\` does NOT narrow to DCA at all — it selects the same trade family, so ordinary swaps come back with the fills; for DCA fills only, pass \`type: "trade", action: "dca"\`. An unknown \`token\` matches nothing and yields an empty page rather than an error, so check the filter before reporting that nothing happened; an unknown \`action\` is refused outright, with the accepted values for that type.
- Rows marked unconfirmed are not facts yet, and they come in two kinds that must not be quoted the same way: a transaction-pool row has no block at all and its amounts are a dry-run projection, while a row above the finalized head already sits in a real block whose height IS quotable — what is provisional there is only whether that block survives. Report both as pending, and never invent a height for the first kind.
- Hydration runs SEVERAL isolated money markets — today the primary market (\`core\`), \`gigahdx\` and \`bil\`, and the set grows. A health factor, a collateral figure and a liquidation threshold belong to exactly one market: never combine them across markets, and never compare one market's figure with another's. An account's real risk is the LOWEST health factor among the markets it is actually in.
- Every figure on an account is scoped to that account's related-account set. Say which addresses a number covers whenever it could be read as one address alone.
- Every record carries its canonical Explorer URL. Hand the human the link along with the answer.
- Pass \`format: "json"\` only when you will post-process the reply; the default markdown is the same data for fewer tokens.`

/* ============ recorded replies ============ */

// Quoted from the live endpoint on 18 September 2026, at 14:16 UTC (the
// governance and activity frames at 12:39 the same day). Each block is the text the tool returned, with WHOLE LINES removed where
// it is marked as trimmed — never a line reworded, renumbered or reformatted.
// Re-quote them from a real call rather than editing them here; a figure
// retyped by hand is exactly the failure these blocks exist to prevent, and a
// line shortened by hand is the same failure one step quieter.
const REPLY_CAPTURED_AT = '18 September 2026'

const REPLY_NETWORK_STATUS = `## Chain head

- **Chain head:** 14,750,475 (includes the unfinalized pending layer)
- **Indexed head:** 14,750,461 (finalized, stored in the index)
- **Head time:** 2026-09-18 14:16:30 UTC · just now
- **HDX price:** $0.0₁7817

The index trails the chain head by **14 blocks** (~28s at the nominal slot time). The head block itself is 10s old. Indexing follows the FINALIZED head, so a just-submitted extrinsic normally becomes visible after that lag plus finalization (roughly 35-65 seconds in total). A lookup that misses inside that window is an early read, not a failure — retry rather than concluding the extrinsic never happened.

…`

const REPLY_ASSET = `## HDX — Hydration (asset #0)

- **Resolved from:** the symbol "HDX"
- **Price:** $0.0₁7817
- **24 h:** +5.26%
- **Decimals:** 12 — scale every raw amount of this asset by 10^12
- **Type:** Native
- **Origin:** Hydration native
- **Value held on Hydration:** $50.2M
- **Holders:** 60,620 — the asset page's figure: system-tag members count as one holder and a bound EVM address counts with its substrate owner (\`list_assets\` counts raw addresses instead, so it reads higher)
- **Liquidity venues:** 29
- **Active DCA schedules:** 7
- **Explorer:** https://hydration-explorer.neckwork.net/asset/0

…`

const REPLY_ACTIVITY = `## Activity — global scope

Filtered: scope global, type=trade, min 100000 USD, limit 5.

- 2d ago · Swap · 🏦 Treasury · 600k 3-Pool-MRL → 600k a3-Pool-MRL · $603k · [open](https://hydration-explorer.neckwork.net/swap/14672012-e129)
- 2d ago · Swap · 🏦 Treasury · 599k 2-Pool-BIL → 599k a2-Pool-BIL · $611k · [open](https://hydration-explorer.neckwork.net/swap/14672012-e111)
- 2d ago · Swap · 🏦 Treasury · 997k 2-Pool-apyUSD → 997k a2-Pool-apyUSD · $1.35M · [open](https://hydration-explorer.neckwork.net/swap/14672012-e93)
- 2d ago · Swap · 🏦 Treasury · 1.05M 2-Pool-PRIME → 1.05M a2-Pool-PRIME · $1.11M · [open](https://hydration-explorer.neckwork.net/swap/14672012-e75)
- 13d ago · Swap · 🐦 14Bqzc…Yvjo6 · 190k aPRIME → 190k PRIME · $201k · [open](https://hydration-explorer.neckwork.net/swap/14247235-e21)

Next page: \`get_activity {"type":"trade","minUsd":100000,"limit":5,"offset":5}\`. There is no total row count on this surface — page until a page comes back short.`

const REPLY_GOVERNANCE = `## Governance

- **OpenGov referenda:** 411
- **Democracy referenda:** 207 (retired pallet, still addressable)
- **Technical Committee motions:** 388
- **Council motions:** 232
- **Treasury tips:** 164

_Both pallets index from zero, so a referendum index alone is ambiguous — always pair it with its pallet._

## Active referenda (3)

### [OpenGov #410](https://hydration-explorer.neckwork.net/referendum/opengov/410) — Reduce Omnipool weight cap for aDOT (DOT) from 30% to 10%

- **Status:** confirming
- **Track:** omnipool_admin (#8)
- **Proposer:** [🍁 lolmcshizz ✓ (149AQA…Ac29y)](https://hydration-explorer.neckwork.net/account/149AQApEw4Xe1DxWesqywiuGQHazbETMgWgT89WjEYFAc29y)
- **Submitted:** 2026-09-17 15:57:48 UTC · 21h ago · block 14,714,655
- **Approval:** 99.98% against a 84.19% threshold — passing
- **Support:** 15.52% against a 13.75% threshold — passing (aye plus abstain capital, nay excluded)
- **Confirming until:** block 14,748,180
- **Decision ends:** block 15,018,855
- **Projection:** passing

…`

/* ============ pieces ============ */

function StatusValue({ probe, error }: { probe?: Probe; error: boolean }) {
  if (error) return <><span className="mcp-dot down" aria-hidden="true" />Unavailable<span className="muted mono mcp-dim">no answer from the endpoint</span></>
  if (!probe) return <span className="muted">Checking&hellip;</span>
  // The status code is the fact; naming it says what the timing measured, which
  // is a refused GET rather than a session handshake.
  const timing = <span className="muted mono mcp-dim">HTTP {probe.status} in {F.int(probe.ms)} ms</span>
  if (probe.state === 'key') return <><span className="mcp-dot warn" aria-hidden="true" />Access key required{timing}</>
  if (probe.state === 'down') return <><span className="mcp-dot down" aria-hidden="true" />Unavailable{timing}</>
  if (probe.state === 'unexpected') return <><span className="mcp-dot warn" aria-hidden="true" />Unexpected answer{timing}</>
  return <><span className="mcp-dot ok" aria-hidden="true" />Ready{timing}</>
}

// A tab is deep-linkable, so which one is open lives in the query string. A
// CLICK is a deliberate choice and earns a history entry; ARROW-KEY movement is
// roving focus inside one control, and an entry per keypress would turn Back
// into a walk backwards through the tab strip instead of a way off the page.
function clientLocation(id: string): string {
  const params = new URLSearchParams(window.location.search)
  if (id === SETUP_CLIENTS[0].id) params.delete('client')
  else params.set('client', id)
  const q = params.toString()
  return q ? `${window.location.pathname}?${q}` : window.location.pathname
}

// Real tab semantics over the app's own `.tabs` bar: the styling, the ink and
// the narrow-screen edge fade all come from the shared class; the roles and the
// arrow-key movement are this bar's own, because a seven-item strip is where
// keyboard navigation starts to matter.
function ClientTabs({ value, onChange }: { value: string; onChange: (id: string, replace: boolean) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = SETUP_CLIENTS.length - 1
    const next = e.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : e.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
        : e.key === 'Home' ? 0
          : e.key === 'End' ? last
            : null
    if (next == null) return
    e.preventDefault()
    const target = SETUP_CLIENTS[next]
    onChange(target.id, true)
    refs.current[target.id]?.focus()
  }
  return (
    <div className="tabs detail-tabs" role="tablist" aria-label="Setup clients">
      {SETUP_CLIENTS.map((client, index) => (
        <button
          key={client.id}
          type="button"
          role="tab"
          id={`mcp-tab-${client.id}`}
          aria-controls={`mcp-panel-${client.id}`}
          aria-selected={value === client.id}
          tabIndex={value === client.id ? 0 : -1}
          ref={el => { refs.current[client.id] = el }}
          className={value === client.id ? 'active' : ''}
          onClick={() => onChange(client.id, false)}
          onKeyDown={e => onKeyDown(e, index)}
        >
          {client.label}
        </button>
      ))}
    </div>
  )
}

function ToolRow({ tool }: { tool: McpTool }) {
  return (
    <details className="mcp-tool">
      <summary>
        <span className="mcp-tool-id">
          <span className="mono mcp-tool-name">{tool.name}</span>
          <span className="mcp-tool-title">{tool.title}</span>
        </span>
        <span className="mcp-tool-mark" aria-hidden="true" />
      </summary>
      <p className="mcp-tool-desc">{tool.description}</p>
    </details>
  )
}

// One recorded exchange. The question is what a person typed, the line under it
// is the call the agent made, and the frame below holds the reply as the server
// rendered it — quoted, never retold, so the rounding a reader sees here is the
// rounding their own agent will get. Anything this page wants to add about the
// reply goes UNDER the frame, in the page's voice.
function Example({ question, call, reply, trimmed, children }: {
  question: string
  call: string
  reply: string
  trimmed?: boolean
  children?: ReactNode
}) {
  return (
    <div className="mcp-ex">
      <h3 className="mcp-ex-q">{question}</h3>
      <p className="mcp-ex-call mono">{call}</p>
      <div className="mcp-ex-body">
        <div className="mcp-reply">
          <div className="mcp-reply-head">
            <span className="mono">reply</span>
            {trimmed && <span className="mcp-reply-cut mono">trimmed at the &hellip;</span>}
          </div>
          <pre className="mcp-reply-body mono">{reply}</pre>
        </div>
        {children}
      </div>
    </div>
  )
}

/* ============ the page ============ */

export function Mcp() {
  useDocumentTitle('MCP server')
  const client = useQueryValue('client', SETUP_CLIENTS[0].id)
  const active = SETUP_CLIENTS.find(c => c.id === client) ?? SETUP_CLIENTS[0]
  const probe = useMcpProbe()
  const tools = useMcpTools()
  const auth: Auth = probe.data?.state === 'key' ? 'key' : probe.data?.state === 'ready' ? 'open' : 'unknown'
  const restricted = auth === 'key'
  const toolCount = tools.data?.length ?? null

  return (
    <div className="wrap mcp-page">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'MCP' }]} />
        <h1 className="page-title">
          MCP server
          <span className="sub">live chain data for coding agents</span>
        </h1>
      </div>

      <div className="mcp-intro">
        <div>
          <p className="mcp-lede">
            Point your agent at one endpoint and it reads Hydration the way this Explorer does: amounts already
            scaled and named, rows classified into the action someone actually took, accounts and assets resolved.
            Every answer is a read, and every record carries the Explorer page behind it.
          </p>
          <div className="mcp-actions">
            <a className="btn primary" href="#mcp-setup">Set up your agent</a>
            <a className="btn" href="#mcp-tools">Browse the tools</a>
          </div>
        </div>

        {/* The product in one frame: a real swap as the index stores it, and as
            a tool hands it to a model. Both halves are quoted from that row. */}
        <div className="detail-card mcp-spec">
          <div className="mcp-spec-k mono">one swap, block 14,708,933</div>
          <pre className="mcp-spec-raw mono">{'"assetIn":   1000752\n"amountIn":  "400000000000"\n"assetOut":  40\n"amountOut": "308100090107"'}</pre>
          <div className="mcp-spec-out">
            <div className="mcp-spec-verb mono">becomes</div>
            <div className="mcp-spec-line mono">400 SOL &rarr; 308 jitoSOL</div>
            <div className="mcp-spec-usd mono">$38.5k</div>
          </div>
          <div className="mcp-spec-foot mono">
            no decimals table, no price lookup, no second call &mdash; and rounded for reading, with the unrounded
            row a <span className="mcp-spec-em">format: &quot;json&quot;</span> away
          </div>
        </div>
      </div>

      <h2 className="sec-title">Endpoint</h2>
      <div className="detail-card">
        <div className="dl">
          <div className="dt">Status</div>
          <div className="dd"><StatusValue probe={probe.data} error={probe.isError} /></div>
          <div className="dt">Endpoint</div>
          <div className="dd mono mcp-endpoint">
            <span className="mcp-endpoint-url">{MCP_ENDPOINT}</span>
            <Copy text={MCP_ENDPOINT} />
          </div>
          <div className="dt">Transport</div>
          <div className="dd">Streamable HTTP<span className="muted mono mcp-dim">stateless, POST only &mdash; a GET answers 405</span></div>
          <div className="dt">Auth</div>
          <div className="dd">
            {auth === 'key'
              ? <>Access key required<span className="muted mono mcp-dim">Authorization: Bearer</span></>
              : auth === 'open'
                ? <>Open, no key<span className="muted mono mcp-dim">rate-limited per IP</span></>
                : probe.isPending
                  ? <span className="muted">Checking&hellip;</span>
                  // Never assert "no key" over a probe that did not answer: a
                  // gated deployment behind a blocked probe would read as open
                  // and hand out snippets that cannot connect.
                  // "no usable answer" rather than "no answer": a 404 or a 503
                  // answered, it just did not answer as this endpoint, so it
                  // settles nothing about whether a key is wanted.
                  : <>Not established<span className="muted mono mcp-dim">no usable answer from the probe</span></>}
          </div>
          <div className="dt">Data</div>
          <div className="dd">Interpreted chain state<span className="muted mono mcp-dim">the same reads these pages make</span></div>
          <div className="dt">Tools</div>
          <div className="dd">
            {toolCount != null
              ? <>{F.int(toolCount)} tools<span className="muted mono mcp-dim">every one read-only</span></>
              : tools.isError
                // Never leave a spinner where a fact belongs: the count is not
                // known and saying so is the honest answer.
                ? <><span className="muted">Not reported</span><span className="muted mono mcp-dim">every one read-only</span></>
                : <span className="muted">Reading the registry&hellip;</span>}
          </div>
        </div>
      </div>
      {probe.data?.state === 'unexpected' && (
        <p className="mcp-note mcp-warn">
          A <code className="mono">GET</code> here answers <code className="mono">405</code> when the MCP endpoint is the
          thing on the other end. <code className="mono">HTTP {probe.data.status}</code> means something else is
          answering at this address &mdash; check it before configuring a client, because a client will fail the same way.
        </p>
      )}

      <h2 className="sec-title mcp-anchor" id="mcp-setup">Set up your agent</h2>
      <p className="mcp-note">
        {auth === 'key'
          ? <>This deployment is gated. Every snippet below already points at it and carries the <code className="mono">Authorization</code> header it requires &mdash; replace <code className="mono">{ACCESS_KEY}</code> with the key it was configured with.</>
          : auth === 'open'
            ? <>Pick your tool and copy the config. Every snippet already points at this deployment, and none of them needs a key.</>
            : <>Pick your tool and copy the config &mdash; every snippet already points at this deployment. Whether this one is gated could not be established from here, so if a client is refused with <code className="mono">401</code>, add an <code className="mono">Authorization: Bearer</code> header carrying the key it was configured with.</>}
      </p>
      <ClientTabs value={active.id} onChange={(id, replace) => (replace ? redirect : navigate)(clientLocation(id))} />
      {/* Every panel is in the document and all but one carries `hidden`, which
          is what a tablist's panels are supposed to be: the relationship the
          tabs declare only holds if the element they name exists. It also means
          a reader who prints the page, or searches it, gets all seven configs. */}
      {SETUP_CLIENTS.map(client => (
        <div
          key={client.id}
          className="detail-card mcp-pad"
          role="tabpanel"
          id={`mcp-panel-${client.id}`}
          aria-labelledby={`mcp-tab-${client.id}`}
          tabIndex={0}
          hidden={client.id !== active.id}
        >
          <p className="mcp-where">{client.where(restricted)}</p>
          <Snippet path={client.path} code={client.code(restricted)} />
          <p className="mcp-verify"><b>Verify:</b> {client.verify(restricted)}</p>
        </div>
      ))}

      <h2 className="sec-title">Tell the agent when to use it</h2>
      <p className="mcp-note">
        A connected server is not an instructed one. Paste this into the instructions file your tool reads, so the
        agent asks the chain instead of remembering it &mdash; and so it never walks into the places where a
        plausible reading is the wrong one.
      </p>
      <div className="detail-card mcp-pad mcp-instructions">
        <div className="mcp-targets">
          <code className="mono">AGENTS.md</code>
          <code className="mono">CLAUDE.md</code>
          <code className="mono">.cursor/rules/hydration-mcp.mdc</code>
        </div>
        <Snippet path="markdown" code={AGENT_INSTRUCTIONS} />
      </div>

      <h2 className="sec-title mcp-anchor" id="mcp-tools">
        Tools{toolCount != null ? ` · ${F.int(toolCount)}` : ''}
      </h2>
      <p className="mcp-note">
        Each description is written for the model rather than for you &mdash; it carries the parameters and the
        traps, which is why they run long. Open one to read exactly what the agent reads.
      </p>
      <div className="detail-card">
        {tools.isPending && <div className="mcp-empty">Reading the tool registry&hellip;</div>}
        {tools.isError && (
          <div className="mcp-empty">
            The tool list could not be read from <span className="mono">{MCP_URL}</span> just now.{' '}
            <a className="hash" href={`${MCP_URL}/llms.txt`} target="_blank" rel="noopener noreferrer">llms.txt</a> names every tool,
            and any connected client lists them itself.
          </div>
        )}
        {tools.data?.length === 0 && <div className="mcp-empty">The server reports no tools registered yet.</div>}
        {tools.data?.map(tool => <ToolRow key={tool.name} tool={tool} />)}
      </div>

      <h2 className="sec-title">What it sounds like</h2>
      <p className="mcp-note">
        Four questions, and the answers this endpoint actually returned on {REPLY_CAPTURED_AT}. Each frame holds the
        reply as it was sent &mdash; the rounding, the links and the notes are the tool&rsquo;s own, not this
        page&rsquo;s. Where a reply ran long it is cut at a <code className="mono">&hellip;</code>, never reworded, and
        the figures have moved since.
      </p>

      <Example
        question="Is the Hydration index caught up with the chain?"
        call="get_network_status"
        reply={REPLY_NETWORK_STATUS}
        trimmed
      >
        <p className="mcp-ex-note">
          Ask this first when an extrinsic you just submitted is not showing up &mdash; the tools tell &ldquo;not yet
          indexed&rdquo; apart from &ldquo;never existed&rdquo;. The trimmed part carries block pace, 24-hour
          throughput, the indexed totals and the last five blocks.
        </p>
      </Example>

      <Example
        question="What is HDX worth, and how widely is it held?"
        call={'get_asset { asset: "HDX" }'}
        reply={REPLY_ASSET}
        trimmed
      >
        <p className="mcp-ex-note">
          A price under a cent renders <code className="mono">$0.0₁7817</code> &mdash; one shown zero, then the
          subscript counts the collapsed ones. A holder count is not money, so it is not compacted: 60,620 can be
          compared with another asset&rsquo;s, <code className="mono">60.6k</code> could not &mdash; and the line says
          on what basis it counts, because <code className="mono">list_assets</code> counts differently.
        </p>
      </Example>

      <Example
        question="Show me every trade over $100,000, most recent first."
        call={'get_activity { type: "trade", minUsd: 100000, limit: 5 }'}
        reply={REPLY_ACTIVITY}
      >
        <p className="mcp-ex-note">
          The actor, its Treasury tag and both symbols came resolved; nothing here needed a second lookup. Note that{' '}
          <code className="mono">type: &quot;trade&quot;</code> is a family &mdash; the same filter also returns OTC, intent
          and cross-chain-swap rows.
        </p>
      </Example>

      <Example
        question="What is Hydration voting on right now?"
        call={'get_governance { kind: "overview" }'}
        reply={REPLY_GOVERNANCE}
        trimmed
      >
        <p className="mcp-ex-note">
          Support here counts aye plus abstain capital and excludes nay. The tool says so in the reply rather than
          leaving you to assume the usual definition. The trimmed part carries #410&rsquo;s tally and the other two
          live referenda.
        </p>
      </Example>

      <h2 className="sec-title">Which surface do you want</h2>
      <p className="mcp-note">
        Three doors onto the same index, one for each kind of reader: an agent, a program, a person. They differ by
        how much interpretation is done before the data reaches you.
      </p>
      <div className="detail-card">
        <div className="dl mcp-surfaces">
          <div className="dt">MCP server</div>
          <div className="dd">
            <b>For agents.</b> Interpreted answers sized for a context window, over one open endpoint. You are on its
            page.
          </div>
          <div className="dt">Data API</div>
          <div className="dd">
            <b>For programs.</b> Raw-shaped REST on a versioned <code className="mono">/v1</code> &mdash; integer
            strings, asset ids, cursors, nothing rounded &mdash; authenticated with a token you mint on the{' '}
            <Link className="hash" to={paths.apiTokens()}>API tokens</Link> page.
            <a className="ext-link" href={`${DATA_API_URL}/docs`} target="_blank" rel="noopener noreferrer">Docs &#8599;</a>
          </div>
          <div className="dt">Preis</div>
          <div className="dd">
            <b>For people.</b> Prices and charts to look at rather than to parse &mdash; every pair on the chain,
            candle by candle.
            <a className="ext-link" href={PREIS_URL} target="_blank" rel="noopener noreferrer">Open preis &#8599;</a>
          </div>
        </div>
      </div>

      <h2 className="sec-title">What this server will and will not do</h2>
      <div className="detail-card">
        <div className="dl mcp-notes">
          <div className="dt">Reads only</div>
          <div className="dd">
            Every tool is a read. The server holds no keys, signs nothing and submits nothing; there is no code path
            from a tool call to a transaction.
          </div>

          <div className="dt">No account</div>
          <div className="dd">
            {auth === 'key'
              ? <>This deployment requires a bearer access key on <code className="mono">/mcp</code>. Everything else &mdash; this page, <code className="mono">llms.txt</code>, the health probe &mdash; stays open, so a client can read the contract before it has a key. The edge applies a per-IP rate limit of its own on top.</>
              : auth === 'open'
                ? <>Open to anyone, with no key, no sign-up and no token. The edge applies a per-IP rate limit of its own: over it a request is refused with <code className="mono">429</code> rather than queued, and the allowance refills as the caller slows down &mdash; a burst costs the burst, never the address.</>
                : <>There is no sign-up and no account here in any case. Whether this particular deployment also requires a bearer key could not be established from this page &mdash; it does when it was given access keys, and <code className="mono">/mcp</code> then answers <code className="mono">401</code>. Either way the edge applies a per-IP rate limit of its own: over it a request is refused with <code className="mono">429</code> rather than queued, and the allowance refills as the caller slows down &mdash; a burst costs the burst, never the address.</>}
          </div>

          <div className="dt">No user data</div>
          <div className="dd">
            The server can only reach this Explorer&rsquo;s public routes. Watchlists, notes, profiles, alerts and
            anything else a signed-in reader creates live behind routes that process cannot address, and a test fails
            the build if a tool ever tries.
          </div>

          <div className="dt">Rounded on purpose</div>
          <div className="dd">
            Displayed figures carry about three significant digits &mdash; the same rough scale these pages use, so a
            number quoted from a reply matches the page it links to. When an exact value is what you need, every tool
            takes <code className="mono">format: &quot;json&quot;</code> and returns the unrounded record.
          </div>

          <div className="dt">Freshness</div>
          <div className="dd">
            Answers come from the index, which follows the <em>finalized</em> head and so trails the chain tip by
            roughly 35&ndash;65 seconds. <code className="mono">get_network_status</code> reports the head, the
            finalized height and the current lag, and a miss on a recent block is reported as <em>not yet
            indexed</em> rather than as <em>never existed</em>.
          </div>

          <div className="dt">Same numbers</div>
          <div className="dd">
            Each answer comes from the same call the matching Explorer page makes, so a figure there and a figure here
            are the same figure. When they disagree, the page is right and this is a bug worth reporting.
          </div>

          <div className="dt">Orientation</div>
          <div className="dd">
            An agent that reads <a className="hash" href={`${MCP_URL}/llms.txt`} target="_blank" rel="noopener noreferrer">llms.txt</a>{' '}
            gets the tool map without loading this page.
          </div>
        </div>
      </div>
    </div>
  )
}
