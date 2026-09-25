import type { FastifyInstance, FastifyReply } from 'fastify'
import { accountRef, resolveDisplayAccountId } from '../services/explorerService.ts'
import { normalizeAddress, hydrationAddress, polkadotAddress } from '../services/addressIdentity.ts'
import { assetDescriptor, knownExplorerAsset, allExplorerAssets } from '../services/explorerAssets.ts'
import { getTag as getSystemTag, allTags } from '../services/tagService.ts'
import { publicTagById, publicListSummary } from '../services/userListService.ts'
import { referendumTitleFor, isGenericReferendumTitle, highestReferendumIndex } from '../services/referendumTitleService.ts'

// The explorer is a client-rendered SPA: nginx answers every page URL with one
// static index.html, and the real title only appears once React has run. That is
// fine for a reader and useless for everything that reads HTML without executing
// it — every link shared to Telegram, Slack, X or Discord previews as the same
// generic card, and a search engine has to spend a render pass before it learns
// what the page even is.
//
// This route answers those same page URLs with that same shell, with one thing
// changed: a <head> that describes the page. nginx proxies an allowlist of route
// shapes here and falls back to the static file if this is unavailable (see
// explorer-ui/nginx.conf), so the worst case is exactly today's behaviour.
//
// Every lookup below is an in-memory Map read — the asset registry, the system
// tag index, the resident list model, identities, the referendum titles. None of
// them touches ClickHouse, which is what makes it safe to put this in the path
// of every HTML request.

// The canonical origin every absolute URL here is built on — a sitemap <loc>
// and an og:url are invalid relative. Compose passes EXPLORER_PUBLIC_URL through
// as an empty string when it is unset, which `??` would accept as a value, so
// blank falls back to the default too.
export const PUBLIC_URL = (process.env.EXPLORER_PUBLIC_URL?.trim() || 'https://hydration-explorer.neckwork.net').replace(/\/+$/, '')
const SITE_NAME = 'Hydration Explorer'
const DEFAULT_DESCRIPTION = 'Explore Hydration: accounts, assets, pools, governance and cross-chain activity, block by block.'

// The shell is read from the UI container rather than the filesystem: the api
// image does not carry the built bundle, and the bundle's asset hashes change on
// every UI deploy. Re-read on a short TTL so a UI deploy cannot leave this
// serving a shell that references a bundle nginx has already replaced.
const SHELL_URL = process.env.EXPLORER_SHELL_URL ?? 'http://hydration-neckwork-explorer-ui:80/index.html'
const SHELL_TTL_MS = 60_000
let shell: { html: string; at: number } | null = null
let shellInflight: Promise<string> | null = null

async function loadShell(): Promise<string> {
  const now = Date.now()
  if (shell && now - shell.at < SHELL_TTL_MS) return shell.html
  // One fetch at a time: a burst of page loads past the TTL must not become a
  // burst of requests at the UI container.
  shellInflight ??= (async () => {
    try {
      const res = await fetch(SHELL_URL, { signal: AbortSignal.timeout(2_000) })
      if (!res.ok) throw new Error(`shell ${res.status}`)
      const html = await res.text()
      if (!html.includes('</head>')) throw new Error('shell has no head')
      shell = { html, at: Date.now() }
      return html
    } finally {
      shellInflight = null
    }
  })()
  try {
    return await shellInflight
  } catch (err) {
    // A stale shell still renders the app correctly for the seconds it takes the
    // UI container to come back; only a cold start has nothing to serve, and the
    // route answers 502 there so nginx falls through to the static file.
    if (shell) {
      console.error('[seo] shell refresh failed, serving the last good copy:', err)
      return shell.html
    }
    throw err
  }
}

// Injected values are page data — a tag's name, an account's identity, a
// referendum's title — and some of those are written by users. They land inside
// attributes, so every one of them is escaped, including the single quote.
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s: string): string => s.replace(/[&<>"']/g, c => ESCAPES[c])

// Collapses to one line and trims to a length a search result actually shows,
// cutting at a word boundary so a description never ends mid-word.
function clamp(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

const num = (n: number): string => n.toLocaleString('en-US')
// Local copy of explorerService's own test for a genuine H160 display form; not
// exported there, and one regex is cheaper than widening that module's surface.
const EVM_RE = /^0x[0-9a-f]{40}$/

export interface PageMeta {
  title: string
  description: string
  // Whether this page's URL class is one robots.txt keeps crawlers out of —
  // the unbounded spaces, one page per block, per extrinsic, per event, per
  // activity row. It does NOT emit a robots meta tag: a disallowed URL is never
  // fetched, so a noindex on it could not be read anyway, and Google's own
  // guidance is to pick one mechanism per URL rather than both. It is carried
  // here so `sitemapExcluded` and explorer-ui/public/robots.txt are derived from
  // one list instead of drifting apart.
  //
  // The head is still rendered for these pages, because robots.txt binds
  // crawlers and nothing else: a transaction link pasted into Telegram, Slack or
  // X is unfurled by a fetcher that never reads it, and that preview is the
  // whole reason these routes are in the allowlist.
  crawlerExcluded?: boolean
  // The id in this URL names nothing: a malformed address, an asset the registry
  // does not have, a tag that is neither a system tag nor a public list's, a
  // referendum past the highest one that exists. The app answers 200 with its
  // "not found" panel — a SPA has no way to answer otherwise — so the page is a
  // soft 404, which Google counts against the site. `noindex` is the documented
  // remedy for exactly this, and it is safe to emit HERE because these routes
  // are not the ones robots.txt closes: a crawler reaches them, reads the tag,
  // and drops them. Only set where absence is KNOWN, never where a lookup was
  // merely unavailable — an empty registry must not noindex every asset.
  notFound?: boolean
  // The entity's key facts, as label/value pairs, rendered into the body as
  // plain HTML. Two jobs: everything that does not run JavaScript — Bing
  // unreliably, every AI crawler, every chat unfurler — otherwise receives an
  // empty <div id="root">, and an account's OTHER address forms are different
  // strings that appear nowhere else, so pasting one into a search engine
  // matches nothing.
  facts?: [string, string][]
  // Where the canonical should point when that is NOT this URL — two routes
  // rendering one page, or several views of it. Absent means "this URL".
  canonicalPath?: string
  // Trail for the BreadcrumbList, page itself excluded — [label, path] pairs.
  crumbs?: [string, string][]
}

// Hub pages: fixed copy, no lookup. Keyed by the exact path.
const HUBS: Record<string, { title: string; description: string }> = {
  '/': { title: `${SITE_NAME} — blocks, accounts, assets and governance`, description: DEFAULT_DESCRIPTION },
  '/activity': { title: 'Activity', description: 'Every classified action on Hydration — swaps, transfers, liquidity, lending, cross-chain, governance — newest first.' },
  '/blocks': { title: 'Blocks', description: 'Hydration blocks as they are produced, with their extrinsics, events and authoring collator.' },
  '/extrinsics': { title: 'Extrinsics', description: 'Hydration extrinsics with their call, origin, result and fee.' },
  '/events': { title: 'Events', description: 'Runtime events emitted on Hydration, filterable by pallet and event name.' },
  '/accounts': { title: 'Accounts', description: 'The Hydration accounts directory, ranked by portfolio value, lending, trading volume, protocol revenue and activity.' },
  '/contracts': { title: 'Contracts', description: 'EVM contracts deployed on Hydration, with verified sources where available.' },
  '/assets': { title: 'Assets', description: 'Every asset in the Hydration registry — price, liquidity, holders and origin chain.' },
  '/governance': { title: 'Governance', description: 'Hydration OpenGov and Democracy referenda, technical committee motions and treasury spending.' },
  '/tags': { title: 'Tags', description: 'Named accounts and cohorts on Hydration — exchanges, protocol pots, pools and treasuries.' },
  '/tags/hydration': { title: 'Hydration Tags', description: 'The protocol\u2019s own accounts: Omnipool, treasury, staking, money market and the pallet pots behind them.' },
  '/lists': { title: 'Lists', description: 'Public account lists curated on the Hydration Explorer.' },
  '/omnipool': { title: 'Omnipool', description: 'Hydration Omnipool composition, asset weights, liquidity and fees.' },
  '/liquidity': { title: 'Liquidity', description: 'Liquidity across the Omnipool, stableswap and XYK pools on Hydration.' },
  '/hdx': { title: 'HDX', description: 'HDX price, supply, staking, treasury buybacks and Omnipool position.' },
  '/hollar': { title: 'HOLLAR', description: 'HOLLAR supply, the stability module, collateral and peg behaviour.' },
  '/ice': { title: 'ICE', description: 'ICE intents and solver settlements on Hydration.' },
  '/revenue': { title: 'Protocol Revenue', description: 'Protocol revenue on Hydration by stream — trading fees, the money market, HOLLAR and liquidations.' },
  '/security': { title: 'Security', description: 'Hydration\u2019s live safety controls: circuit breakers, cross-chain limits, oracle health, freezes and guardians.' },
  '/mcp': { title: 'MCP server', description: 'Connect an AI assistant to Hydration chain data over the Model Context Protocol.' },
}

const SECURITY_SECTIONS: Record<string, string> = {
  'cross-chain': 'Cross-chain', wormhole: 'Wormhole', omnipool: 'Omnipool',
  'money-market': 'Money market', freezes: 'Freezes', ledger: 'Ledger', guardians: 'Guardians',
}

// One page per block, per extrinsic, per event, per activity row — tens of
// millions of URLs that exist, are worth serving, and that nobody searches for.
// robots.txt keeps crawlers out of them (see PageMeta.crawlerExcluded) and the
// sitemap never lists them. Exported so those two are written from this list
// rather than from a second copy of it.
export const UNBOUNDED_PREFIXES = new Set([
  'block', 'extrinsic', 'event', 'dca', 'intent',
  'swap', 'transfer', 'cross-chain', 'add-liquidity', 'remove-liquidity', 'create-pool', 'destroy-pool',
  'claim-rewards', 'claim-referral-rewards', 'collect-fees', 'rebalance',
  'lend', 'withdraw', 'borrow', 'repay', 'liquidate', 'staking', 'vote',
  'otc-place', 'otc-pull', 'otc-fill', 'bond-issue', 'bond-redeem',
  'intent-place', 'intent-fill', 'intent-cancel', 'intent-expire', 'intent-dca-trade',
])

const CRUMB_HOME: [string, string] = ['Home', '/']

// A page this recognises the shape of but cannot describe, because the index it
// would have read has not loaded. Deliberately NOT marked notFound: "absent from
// an empty index" is not evidence of absence, and marking it would noindex every
// asset, tag and referendum page on the site the moment a refresh failed.
const unknownYet = (crumbs: [string, string][]): PageMeta =>
  ({ title: SITE_NAME, description: DEFAULT_DESCRIPTION, crumbs })

// A page whose id is KNOWN to name nothing. See PageMeta.notFound.
const missing = (crumbs: [string, string][]): PageMeta =>
  ({ title: SITE_NAME, description: DEFAULT_DESCRIPTION, notFound: true, crumbs })

export function pageMeta(path: string): PageMeta {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path
  const hub = HUBS[clean]
  if (hub) return { ...hub, crumbs: clean === '/' ? [] : [CRUMB_HOME] }

  const parts = clean.replace(/^\//, '').split('/').filter(Boolean)
  const [head, a, b] = parts

  // A route whose id space is unbounded describes itself from the id alone —
  // no lookup, because there is nothing a Map could add to "block 14,871,261".
  if (head === 'block' && a) {
    return { title: `Block #${num(Number(a))}`, description: `Hydration block ${num(Number(a))}: its extrinsics, events, author and timestamp.`, crawlerExcluded: true, crumbs: [CRUMB_HOME, ['Blocks', '/blocks']] }
  }
  if (head === 'extrinsic' && a) {
    return { title: `Extrinsic ${a}`, description: `Hydration extrinsic ${a}: call, origin, signer, fee, result and the events it emitted.`, crawlerExcluded: true, crumbs: [CRUMB_HOME, ['Extrinsics', '/extrinsics']] }
  }
  if (head === 'event' && a) {
    return { title: `Event ${a}`, description: `Hydration runtime event ${a}, with its decoded arguments and the extrinsic that emitted it.`, crawlerExcluded: true, crumbs: [CRUMB_HOME, ['Events', '/events']] }
  }

  if (head === 'account' && a) {
    const normalized = normalizeAddress(a)
    // Pure parsing, no index behind it, so this one is always knowable.
    if (!normalized) return missing([CRUMB_HOME, ['Accounts', '/accounts']])
    const ref = accountRef(resolveDisplayAccountId(normalized.accountId))
    const name = ref.contractName || ref.profile?.name || ref.identity?.display || ref.tag?.name || null
    const shown = ref.address
    // The title keeps the truncated address every explorer shows, and the client
    // sets the same string on hydration so the two never disagree. The full
    // address is what gets MATCHED, and it is already in the URL, the
    // description and the body below — a title is not where it has to live.
    //
    // One account answers to several strings that share no prefix — the Polkadot
    // SS58, the Hydration SS58, the 32-byte account id, and an H160 where there
    // is one — so each is stated rather than left to be derived.
    const short = shown.length > 16 ? `${shown.slice(0, 6)}…${shown.slice(-4)}` : shown
    const forms: [string, string][] = []
    const evm = EVM_RE.test(shown) ? shown : null
    if (evm) forms.push(['EVM (H160)', evm])
    const polkadot = polkadotAddress(ref.accountId)
    const hydration = hydrationAddress(ref.accountId)
    for (const [label, value] of [['Polkadot (SS58)', polkadot], ['Hydration (SS58)', hydration], ['Account ID', ref.accountId]] as [string, string][]) {
      if (value && value !== evm) forms.push([label, value])
    }
    return {
      title: name ? `${name} · ${short}` : short,
      description: name
        ? `${name} on Hydration (${shown}) — balances, liquidity, lending, trading history and governance votes.`
        : `Hydration account ${shown} — balances, liquidity, lending, trading history and governance votes.`,
      facts: [...(name ? [['Name', name] as [string, string]] : []), ...forms],
      crumbs: [CRUMB_HOME, ['Accounts', '/accounts']],
    }
  }

  if ((head === 'asset' || head === 'holders') && a && a !== 'xc') {
    const id = Number(a)
    const assetCrumbs: [string, string][] = [CRUMB_HOME, ['Assets', '/assets']]
    if (!(Number.isFinite(id) && knownExplorerAsset(id))) {
      // An empty registry means "cannot say", so absence is only claimed when
      // there is a loaded registry to be absent from. Either way this returns
      // rather than falling through — the catch-all below means "unknown URL",
      // which this is not.
      return allExplorerAssets().length > 0 ? missing(assetCrumbs) : unknownYet(assetCrumbs)
    }
    {
      const asset = assetDescriptor(id)
      const holders = head === 'holders'
      return {
        ...(holders ? { canonicalPath: `/asset/${id}` } : {}),
        // `name` is null for a registry entry that carries only a symbol.
        facts: [['Symbol', asset.symbol], ...(asset.name ? [['Name', asset.name] as [string, string]] : []), ['Asset ID', String(id)]] as [string, string][],
        title: holders ? `${asset.symbol} holders` : `${asset.symbol} — ${asset.name}`,
        description: holders
          ? `Who holds ${asset.symbol} (${asset.name}) on Hydration, largest first.`
          : `${asset.name} (${asset.symbol}) on Hydration — price, liquidity, holders, pools and recent trades.`,
        crumbs: [CRUMB_HOME, ['Assets', '/assets']],
      }
    }
  }

  if (head === 'tag' && a) {
    // A system tag and a public list's tag share this URL space; both resolve
    // from memory, and a private list's tag resolves to neither — it gets the
    // generic shell, exactly as its page shows a logged-out reader nothing.
    const system = getSystemTag(a)
    const listTag = system ? null : publicTagById(a)
    const tag = system ?? listTag
    if (tag) {
      const count = tag.members.length
      const note = 'note' in tag && tag.note ? tag.note : null
      return {
        title: tag.name,
        facts: [['Tag', tag.name], ['Accounts', num(count)], ...(note ? [['Note', note] as [string, string]] : [])],
        description: clamp(note ?? `${tag.name} on Hydration — ${num(count)} tagged ${count === 1 ? 'account' : 'accounts'}, their combined balances, activity and governance votes.`),
        crumbs: [CRUMB_HOME, ['Tags', '/tags']],
      }
    }
    // Either it does not exist, or it belongs to a private list — the page shows
    // a logged-out reader nothing either way, so it is never worth indexing.
    // Guarded on the index having loaded, for the same reason the asset branch
    // is: absent from an empty index is not absent.
    const tagCrumbs: [string, string][] = [CRUMB_HOME, ['Tags', '/tags']]
    return allTags().length > 0 ? missing(tagCrumbs) : unknownYet(tagCrumbs)
  }

  if (head === 'list' && a) {
    const list = publicListSummary(a)
    if (list) {
      return {
        title: list.name,
        description: clamp(list.note || `${list.name} — a public account list on Hydration with ${num(list.tagCount)} tags across ${num(list.accountCount)} accounts.`),
        crumbs: [CRUMB_HOME, ['Lists', '/lists']],
      }
    }
    // No guard: a list is public or it is not, and "no public lists exist" is a
    // real answer meaning every /list/ URL is unviewable to a crawler.
    return missing([CRUMB_HOME, ['Lists', '/lists']])
  }

  if (head === 'referendum' && (a === 'opengov' || a === 'democracy') && b) {
    const index = Number(b)
    if (Number.isFinite(index)) {
      const label = a === 'opengov' ? 'OpenGov' : 'Democracy'
      const highest = highestReferendumIndex(a)
      // null = the titles have not loaded, so there is no range to be outside.
      if (index < 0 || (highest != null && index > highest)) {
        return missing([CRUMB_HOME, ['Governance', '/governance']])
      }
      const title = referendumTitleFor(a, index)
      const named = title && !isGenericReferendumTitle(title) ? title : null
      return {
        title: named ? `${named} · ${label} #${index}` : `${label} referendum #${index}`,
        description: named
          ? clamp(`${named} — Hydration ${label} referendum #${index}: votes, support, turnout and the accounts behind them.`)
          : `Hydration ${label} referendum #${index}: votes, support, turnout and the accounts behind them.`,
        crumbs: [CRUMB_HOME, ['Governance', '/governance']],
      }
    }
  }

  if (head === 'pool' && a) {
    const id = Number(a)
    const name = Number.isFinite(id) && knownExplorerAsset(id) ? assetDescriptor(id).name : null
    return {
      title: name ? `${name} pool` : 'Pool',
      description: name
        ? `${name} on Hydration — liquidity, volume, fees and the providers behind them.`
        : 'A Hydration liquidity pool — its reserves, volume, fees and providers.',
      crumbs: [CRUMB_HOME, ['Liquidity', '/liquidity']],
    }
  }

  if (head === 'security' && a && SECURITY_SECTIONS[a]) {
    return {
      title: `${SECURITY_SECTIONS[a]} · Security`,
      description: `${SECURITY_SECTIONS[a]} safety controls on Hydration: current limits, what they are measured against and when they last moved.`,
      crumbs: [CRUMB_HOME, ['Security', '/security']],
    }
  }

  if (head && UNBOUNDED_PREFIXES.has(head) && a) {
    const label = head.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase())
    return { title: `${label} ${a}`, description: `${label} ${a} on Hydration — what moved, between whom, and what it cost.`, crawlerExcluded: true, crumbs: [CRUMB_HOME, ['Activity', '/activity']] }
  }

  // An URL shape this does not recognise at all. Every recognised shape above
  // returns on its own, including when its lookup was unavailable, so reaching
  // here really does mean there is no such page.
  return missing([CRUMB_HOME])
}

// The shell already carries a title and a static Open Graph set. Both are
// replaced wholesale rather than appended to — two og:title tags is not a page
// with a better title, it is a page whose title a crawler has to guess.
const MANAGED_TAG_RE = /[ \t]*<(?:title[^>]*>[\s\S]*?<\/title|meta[^>]*(?:name="(?:description|robots|twitter:[^"]*)"|property="og:[^"]*")[^>]*\/?|link[^>]*rel="canonical"[^>]*\/?)>\n?/g

export function renderHead(meta: PageMeta, path: string): string {
  const canonical = `${PUBLIC_URL}${meta.canonicalPath ?? (path === '/' ? '/' : path)}`
  // The site name is a suffix, not a repetition: a title that already opens with
  // it (the home page) must not end with it too.
  const title = meta.title.startsWith(SITE_NAME) ? meta.title : `${meta.title} · ${SITE_NAME}`
  const lines = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(meta.description)}" />`,
    `<link rel="canonical" href="${esc(canonical)}" />`,
    // Soft-404 remedy, and only that: the URL spaces robots.txt closes never
    // reach a crawler at all, so they carry no robots tag (see PageMeta).
    ...(meta.notFound ? ['<meta name="robots" content="noindex" />'] : []),
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(meta.description)}" />`,
    `<meta property="og:url" content="${esc(canonical)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(SITE_NAME)}" />`,
    `<meta property="og:image" content="${PUBLIC_URL}/og-image.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(SITE_NAME)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(meta.description)}" />`,
    // X resolves twitter:image only as an absolute URL.
    `<meta name="twitter:image" content="${PUBLIC_URL}/og-image.png" />`,
  ]
  const breadcrumb = breadcrumbJsonLd(meta, path)
  if (breadcrumb) lines.push(breadcrumb)
  // The only two site-level entities Google still does anything with: WebSite
  // decides the site NAME shown under a result, Organization feeds the knowledge
  // panel and logo. Home page only — on an inner page they would be a claim
  // about the wrong thing. Deliberately no SearchAction: the sitelinks search
  // box it drove was retired in November 2024.
  if (path === '/') lines.push(siteJsonLd())
  return lines.map(l => `    ${l}`).join('\n')
}

// A trail the page already draws for a reader, in the form a search result can
// use. JSON-LD goes in a script tag, so it is JSON-escaped rather than
// HTML-escaped, plus `<` so a name containing "</script" cannot close it.
function breadcrumbJsonLd(meta: PageMeta, path: string): string | null {
  if (!meta.crumbs?.length) return null
  const items = [...meta.crumbs.map(([name, to]) => ({ name, url: `${PUBLIC_URL}${to}` })), { name: meta.title, url: `${PUBLIC_URL}${path}` }]
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: item.name, item: item.url })),
  }
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
}

function siteJsonLd(): string {
  const data = [
    { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: `${PUBLIC_URL}/` },
    { '@context': 'https://schema.org', '@type': 'Organization', name: SITE_NAME, url: `${PUBLIC_URL}/`, logo: `${PUBLIC_URL}/icon-512.png` },
  ]
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
}

// The entity, as plain HTML, for clients that do not run scripts — every AI
// crawler, every chat unfurler, and Bing much of the time. They would otherwise
// receive an empty <div id="root">.
//
// It goes in <noscript>, not inside #root. Inside #root it WAS rendered: React
// only replaces those children once its module script has loaded and mounted, so
// every page load flashed a screenful of unstyled <h1> first. <noscript> is the
// element that means exactly this — a browser running JavaScript never renders
// it at all, so there is nothing to flash, and no CSS trick is needed to hide
// text that would then be hidden from the clients it exists for.
//
// It states the same facts the page itself renders, which is what keeps it a
// prerender rather than a second, different page shown only to crawlers.
export function renderBody(meta: PageMeta): string {
  if (!meta.facts?.length) return ''
  const rows = meta.facts.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')
  return `<noscript><h1>${esc(meta.title)}</h1><p>${esc(meta.description)}</p><dl>${rows}</dl></noscript>`
}

export function renderPage(shellHtml: string, path: string): string {
  const meta = pageMeta(path)
  const body = renderBody(meta)
  const stripped = shellHtml.replace(MANAGED_TAG_RE, '')
  const withHead = stripped.replace('</head>', `${renderHead(meta, path)}\n  </head>`)
  return body ? withHead.replace('<div id="root"></div>', `<div id="root"></div>\n    ${body}`) : withHead
}

export async function seoRoutes(fastify: FastifyInstance): Promise<void> {
  // nginx passes the original page path through; the query string is dropped on
  // purpose — ?tab=, ?page= and ?sort= are views of one page, and the canonical
  // this emits points at the bare path for exactly that reason.
  fastify.get('/seo/page/*', async (req, reply: FastifyReply) => {
    const wildcard = (req.params as { '*'?: string })['*'] ?? ''
    const path = `/${wildcard}`.replace(/\/{2,}/g, '/')
    let shellHtml: string
    try {
      shellHtml = await loadShell()
    } catch (err) {
      // nginx turns this into the static shell (error_page … = @spa), so a
      // reader still gets the app; only the metadata is lost.
      console.error('[seo] no shell available:', err)
      return reply.status(502).send({ error: 'Shell unavailable' })
    }
    return reply
      .type('text/html; charset=utf-8')
      // Short, like the shell nginx serves today (`expires -1` on index.html),
      // because a tag can be renamed and an identity can change. The server-wide
      // cache-control hook only stamps replies that carry none, so this wins.
      .header('cache-control', 'public, max-age=60')
      .send(renderPage(shellHtml, path))
  })
}

export const __testing = { loadShellReset: () => { shell = null; shellInflight = null } }
