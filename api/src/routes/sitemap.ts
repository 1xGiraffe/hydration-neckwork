import type { FastifyInstance, FastifyReply } from 'fastify'
import { allExplorerAssets } from '../services/explorerAssets.ts'
import { allTags } from '../services/tagService.ts'
import { publicLists, publicListTags } from '../services/userListService.ts'
import { referendumTitles } from '../services/referendumTitleService.ts'
import { getAccounts } from '../services/explorerService.ts'
import { PUBLIC_URL, UNBOUNDED_PREFIXES } from './seo.ts'

// What the explorer offers a search engine, as a sitemap index plus one file per
// kind of thing. A sitemap is a discovery hint, not an inventory: the chain has
// tens of millions of block, extrinsic and event URLs, and listing them would
// spend a new site's small crawl allowance on the pages nobody searches for —
// the same pages robots.txt keeps crawlers out of entirely (UNBOUNDED_PREFIXES,
// which this file and robots.txt both read so they cannot disagree).
//
// Everything here is read live: the asset registry and the system tag index from
// memory, the public lists and their tags from the resident model ClickHouse
// loads at boot, the referendum titles from their own refreshed map, and the
// ranked account slice from the accounts directory.

const CHILD_SECTIONS = ['core', 'assets', 'tags', 'governance', 'accounts'] as const
type Section = typeof CHILD_SECTIONS[number]

// The protocol's own ceilings, per file. A section that would exceed either is
// split into numbered parts rather than truncated — a sitemap that silently
// drops URLs is worse than one that is honestly long.
const MAX_URLS_PER_FILE = 50_000
const MAX_BYTES_PER_FILE = 50 * 1024 * 1024
// Fixed markup around one <url> entry and around the document, before escaping —
// escaping only ever lengthens a value, so these are counted generously enough
// that an entry can never be measured as smaller than it is written.
const ENTRY_OVERHEAD = '  <url>\n    <loc></loc>\n  </url>\n'.length + '\n    <lastmod></lastmod>'.length + 48
const DOCUMENT_OVERHEAD = 1024

// The accounts directory holds ~116,000 accounts and most of them have never
// held anything: a page per empty account is thin content that invites a crawler
// to conclude the site is mostly filler. Only the ranked head is advertised.
//
// Kept small for a second reason: the directory page this reads is the whole
// bounded ranking plus a per-row sparkline and top-holding enrichment, so its
// cost scales with the page SIZE, not just with the offset — asking it for ten
// thousand rows took minutes. The rest of the directory is not lost to a
// crawler, it is one link away on /accounts.
export const SITEMAP_ACCOUNT_LIMIT = 500

const REBUILD_MS = 60 * 60 * 1000
// Long enough for the boot-time loaders the sections read to have finished. A
// request that arrives before the first build kicks one off itself, so this
// being generous costs nothing.
const FIRST_BUILD_DELAY_MS = 60_000

interface SitemapUrl { loc: string; lastmod?: string }

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
const xml = (s: string): string => s.replace(/[&<>"']/g, c => XML_ESCAPES[c])

// W3C Datetime, which is what the protocol asks for. Emitted ONLY where a real
// timestamp for that entity exists — a lastmod set to "now" because nothing
// better was to hand tells a crawler the whole site changed every time it looks,
// and Google only honours the field while it stays verifiably accurate.
function w3c(value: string | number | Date | null | undefined): string | undefined {
  if (value == null || value === '') return undefined
  const date = value instanceof Date ? value : new Date(typeof value === 'number' ? value : String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'))
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function renderUrlSet(urls: SitemapUrl[]): string {
  const body = urls.map(u =>
    `  <url>\n    <loc>${xml(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${xml(u.lastmod)}</lastmod>` : ''}\n  </url>`).join('\n')
  // No <changefreq> and no <priority>: Google and Bing both state outright that
  // they ignore them, so they would be bytes that assert something nobody reads.
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
}

function renderIndex(files: string[]): string {
  const body = files.map(f => `  <sitemap>\n    <loc>${xml(`${PUBLIC_URL}/${f}`)}</loc>\n  </sitemap>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`
}

// Splits a section that outgrew either ceiling, so the index gains
// `sitemap-accounts-2.xml` rather than the section losing its tail.
function paginate(section: Section, urls: SitemapUrl[]): Map<string, string> {
  const files = new Map<string, string>()
  let part: SitemapUrl[] = []
  let bytes = 0
  let index = 1
  const flush = () => {
    if (!part.length) return
    files.set(index === 1 ? `sitemap-${section}.xml` : `sitemap-${section}-${index}.xml`, renderUrlSet(part))
    part = []
    bytes = 0
    index++
  }
  for (const url of urls) {
    // Accumulated as the entries are added rather than by re-rendering the part
    // on every push: that is quadratic, and this runs over tens of thousands of
    // URLs. The per-entry cost is measured the way renderUrlSet writes it, and
    // ENTRY_OVERHEAD covers its fixed markup, so the running total is an upper
    // bound on the file — which is what a ceiling needs to be.
    const size = ENTRY_OVERHEAD + url.loc.length + (url.lastmod?.length ?? 0)
    if (part.length && (part.length >= MAX_URLS_PER_FILE || bytes + size > MAX_BYTES_PER_FILE - DOCUMENT_OVERHEAD)) flush()
    part.push(url)
    bytes += size
  }
  flush()
  if (!files.size) files.set(`sitemap-${section}.xml`, renderUrlSet([]))
  return files
}

// The hub pages, which exist regardless of what is on chain. Every one of them
// is a real route in explorer-ui/src/router.tsx.
const CORE_PATHS = [
  '/', '/activity', '/blocks', '/extrinsics', '/events', '/accounts', '/contracts', '/assets',
  '/governance', '/tags', '/tags/hydration', '/lists', '/omnipool', '/liquidity',
  '/hdx', '/hollar', '/ice', '/revenue', '/security', '/mcp',
]

async function buildSections(): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const [name, urls] of Object.entries(await collect())) {
    for (const [file, body] of paginate(name as Section, urls)) files.set(file, body)
  }
  return files
}

async function collect(): Promise<Record<Section, SitemapUrl[]>> {
  const at = (path: string, lastmod?: string): SitemapUrl => ({ loc: `${PUBLIC_URL}${path}`, lastmod })

  const core = CORE_PATHS.map(p => at(p))

  // Every asset the registry knows, including the ones with no price — the page
  // documents the asset either way.
  const assets = allExplorerAssets().map(a => at(`/asset/${a.assetId}`))

  // System tags are code-defined; a public list's tags come from the list model
  // and are in the sitemap at the repo owner's explicit decision. A tag with no
  // members is a page about nothing, so it is left out.
  const tags = [
    ...allTags().filter(t => t.members.length > 0).map(t => at(`/tag/${t.tagId}`)),
    ...publicListTags().filter(t => t.memberCount > 0).map(t => at(`/tag/${t.tagId}`)),
    ...publicLists().map(l => at(`/list/${l.listId}`)),
  ]

  // Only referenda that actually have a titled record; the key is `pallet:index`.
  const titles = await referendumTitles().catch(() => new Map<string, string>())
  const governance = [...titles.keys()].flatMap(key => {
    const [pallet, index] = key.split(':')
    return (pallet === 'opengov' || pallet === 'democracy') && /^\d+$/.test(index ?? '')
      ? [at(`/referendum/${pallet}/${index}`)]
      : []
  })

  // The ranked head of the directory (see SITEMAP_ACCOUNT_LIMIT). `lastBlock` is
  // a block height, not a time, so no lastmod is claimed for these.
  const directory = await getAccounts(0, SITEMAP_ACCOUNT_LIMIT, 'value').catch(() => ({ rows: [] }))
  const accounts = directory.rows.flatMap(row => row.account ? [at(`/account/${row.account.address}`)] : [])

  return { core, assets, tags, governance, accounts }
}

let cache: Map<string, string> | null = null
let building = false

// Built in the background and served from memory, never built by a request. The
// account section reads the whole ranked directory, which is seconds of work on
// a cold cache; a crawler that asked for the sitemap and waited for that would
// time out, and a timed-out sitemap is reported to Search Console as a broken
// one. Until the first build lands the routes answer 503, which is a crawler's
// signal to come back rather than a claim that the sitemap is wrong.
async function rebuild(): Promise<void> {
  if (building) return
  building = true
  try {
    cache = await buildSections()
  } catch (err) {
    // A stale sitemap still points at pages that exist, so the previous copy
    // stands rather than being cleared.
    console.error('[sitemap] rebuild failed:', err)
  } finally {
    building = false
  }
}

// robots.txt, written from the same two things the sitemap is: the canonical
// origin, and the one list of URL spaces crawlers are kept out of. Generated
// rather than shipped as a file so the Sitemap line follows the configured host
// instead of naming one host forever, and so a new activity slug closes itself
// the moment it is added to UNBOUNDED_PREFIXES.
export function robotsTxt(): string {
  return [
    '# The entity pages — accounts, assets, tags, lists, referenda, pools and',
    '# every hub — are open, and the sitemap below advertises them.',
    '#',
    '# What is closed is the per-row history: one page per block, per extrinsic,',
    '# per event and per classified activity row is tens of millions of URLs that',
    '# exist and are worth serving to a reader, but that nobody searches for.',
    '# Google\'s guidance for a URL space this size is to keep crawlers out of it',
    '# rather than let it be crawled and dropped, so it is closed here and NOT',
    '# marked noindex: a disallowed URL is never fetched, so a noindex on it could',
    '# not be read, and shipping both is the one combination Google tells you not',
    '# to. Those pages still render a proper title and preview card — robots.txt',
    '# binds crawlers, and a link pasted into a chat is unfurled by something that',
    '# never reads it.',
    '',
    'User-agent: *',
    'Allow: /',
    '',
    ...[...UNBOUNDED_PREFIXES].map(prefix => `Disallow: /${prefix}/`),
    '',
    '# Session-only surfaces: a crawler carries no session, so these can only ever',
    '# be the logged-out teaser.',
    'Disallow: /admin/',
    'Disallow: /link-device',
    '',
    `Sitemap: ${PUBLIC_URL}/sitemap.xml`,
    '',
  ].join('\n')
}

export async function sitemapRoutes(fastify: FastifyInstance): Promise<void> {
  // NOT at registration: the asset registry, the system tag index and the list
  // model are all loaded during startup, and a build that ran before them would
  // cache a sitemap containing the static hub pages and nothing else — for an
  // hour, and to a crawler that has no way to know it was early.
  const first = setTimeout(() => { void rebuild() }, FIRST_BUILD_DELAY_MS)
  first.unref()
  const timer = setInterval(() => { void rebuild() }, REBUILD_MS)
  timer.unref()
  fastify.addHook('onClose', async () => { clearTimeout(first); clearInterval(timer) })

  const send = (reply: FastifyReply, body: string) => reply
    .type('application/xml; charset=utf-8')
    // Set explicitly: the server-wide cache-control hook only stamps replies
    // that carry none, and its /explorer rule would not match this path anyway.
    .header('cache-control', 'public, max-age=3600')
    .send(body)

  fastify.get('/robots.txt', async (_req, reply) =>
    reply.type('text/plain; charset=utf-8').header('cache-control', 'public, max-age=3600').send(robotsTxt()))

  fastify.get('/sitemap.xml', async (_req, reply) => {
    if (!cache) { void rebuild(); return reply.status(503).send({ error: 'Sitemap not built yet' }) }
    return send(reply, renderIndex([...cache.keys()]))
  })

  fastify.get('/sitemap-:name.xml', async (req, reply) => {
    if (!cache) { void rebuild(); return reply.status(503).send({ error: 'Sitemap not built yet' }) }
    const { name } = req.params as { name: string }
    const body = cache.get(`sitemap-${name}.xml`)
    if (!body) return reply.status(404).send({ error: 'No such sitemap' })
    return send(reply, body)
  })
}

export const __testing = { collect, paginate, renderUrlSet, renderIndex, w3c, rebuild, reset: () => { cache = null }, UNBOUNDED_PREFIXES }
