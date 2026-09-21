import type { FastifyInstance, FastifyReply } from 'fastify'
import { getAllAssets } from '../services/assetsService.ts'

// The same problem the explorer had, on the charts app: every pair at every
// interval is one client-rendered shell with one title, so a link to the HDX
// chart and a link to the DOT chart preview identically and read identically to
// anything that does not run JavaScript.
//
// Separate from routes/seo.ts rather than folded into it because this is a
// different SITE: its own host, its own canonical origin, its own shell, and its
// own sitemap (a sitemap only covers the host it is served from).

const PUBLIC_URL = (process.env.PREIS_PUBLIC_URL?.trim() || 'https://hydration-preis.neckwork.net').replace(/\/+$/, '')
const SITE_NAME = 'Hydration Preis'
const SHELL_URL = process.env.PREIS_SHELL_URL ?? 'http://hydration-neckwork-preis-ui:80/index.html'
const SHELL_TTL_MS = 60_000

// What the app itself charts by default, and what every other interval of a pair
// points at: eight intervals of one pair are eight views of one chart, not eight
// pages. Mirrors DEFAULT_BASE_ID/DEFAULT_QUOTE_ID in preis-ui/src/App.tsx.
const DEFAULT_INTERVAL = '1h'
const DEFAULT_PAIR = '0-10'
const INTERVALS = new Set(['5min', '15min', '30min', '1h', '4h', '1d', '1w', '1M'])
const PAIR_RE = /^(0|[1-9]\d*)-(0|[1-9]\d*)$/

let shell: { html: string; at: number } | null = null

async function loadShell(): Promise<string> {
  if (shell && Date.now() - shell.at < SHELL_TTL_MS) return shell.html
  try {
    const res = await fetch(SHELL_URL, { signal: AbortSignal.timeout(2_000) })
    if (!res.ok) throw new Error(`shell ${res.status}`)
    const html = await res.text()
    if (!html.includes('</head>')) throw new Error('shell has no head')
    shell = { html, at: Date.now() }
    return html
  } catch (err) {
    if (shell) {
      console.error('[seo/preis] shell refresh failed, serving the last good copy:', err)
      return shell.html
    }
    throw err
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s: string): string => s.replace(/[&<>"']/g, c => ESCAPES[c])

const symbolOf = (id: number): string | null => getAllAssets().find(a => a.assetId === id)?.symbol ?? null

export interface PreisMeta { title: string; description: string; canonicalPath: string; notFound?: boolean }

export function preisMeta(path: string): PreisMeta {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path
  const home: PreisMeta = {
    title: `${SITE_NAME} — Hydration price charts`,
    description: 'Live candlestick charts for every Hydration trading pair — price, volume and market stats, indexed straight from the chain.',
    canonicalPath: '/',
  }
  if (clean === '/') return home

  const [, pair, interval] = clean.split('/')
  const match = pair ? PAIR_RE.exec(pair) : null
  if (!match || (interval && !INTERVALS.has(interval))) {
    // The app rewrites an unparseable pair to its default chart, so the URL
    // names no page of its own. Marked rather than described, for the same
    // soft-404 reason as the explorer's unresolvable ids.
    return { ...home, notFound: true }
  }
  const base = symbolOf(Number(match[1]))
  const quote = symbolOf(Number(match[2]))
  const canonicalPath = `/${pair}/${DEFAULT_INTERVAL}`
  // Only the asset list can say whether a numerically valid pair is a real one,
  // so an unloaded list means "cannot say" and claims neither way. The canonical
  // still points at THIS pair's default interval either way: pointing an
  // undescribed chart at the home page would name a different page as its
  // original, which is worse than naming no title at all.
  if (!base || !quote) {
    return getAllAssets().length > 0
      ? { ...home, canonicalPath, notFound: true }
      : { ...home, canonicalPath }
  }
  return {
    title: `${base}/${quote} price chart`,
    description: `${base}/${quote} on Hydration — live price, candlesticks and volume across every interval, indexed from the chain.`,
    // Every interval of a pair collapses onto the default one: same chart, same
    // data, one page worth indexing.
    canonicalPath,
  }
}

const MANAGED_TAG_RE = /[ \t]*<(?:title[^>]*>[\s\S]*?<\/title|meta[^>]*(?:name="(?:description|robots|twitter:[^"]*)"|property="og:[^"]*")[^>]*\/?|link[^>]*rel="canonical"[^>]*\/?)>\n?/g

export function renderPreisHead(meta: PreisMeta): string {
  const canonical = `${PUBLIC_URL}${meta.canonicalPath}`
  const title = meta.title.startsWith(SITE_NAME) ? meta.title : `${meta.title} · ${SITE_NAME}`
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(meta.description)}" />`,
    `<link rel="canonical" href="${esc(canonical)}" />`,
    ...(meta.notFound ? ['<meta name="robots" content="noindex" />'] : []),
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(meta.description)}" />`,
    `<meta property="og:url" content="${esc(canonical)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(SITE_NAME)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(meta.description)}" />`,
  ].map(l => `    ${l}`).join('\n')
}

export function renderPreisPage(shellHtml: string, path: string): string {
  return shellHtml.replace(MANAGED_TAG_RE, '').replace('</head>', `${renderPreisHead(preisMeta(path))}\n  </head>`)
}

// One URL per chartable pair against the quote the app opens on, at the one
// interval every other interval canonicalises to. Pairing all 54 assets against
// each other would be ~2,800 URLs of the same chart with the axes swapped.
export function preisSitemap(): string {
  const quoteId = Number(DEFAULT_PAIR.split('-')[1])
  const locs = [
    `${PUBLIC_URL}/`,
    ...getAllAssets()
      .filter(a => a.assetId !== quoteId)
      .map(a => `${PUBLIC_URL}/${a.assetId}-${quoteId}/${DEFAULT_INTERVAL}`),
  ]
  const body = locs.map(loc => `  <url>\n    <loc>${esc(loc)}</loc>\n  </url>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
}

export const PREIS_ROBOTS = [
  '# The charts are the whole site and every one of them is worth finding.',
  'User-agent: *',
  'Allow: /',
  '',
  `Sitemap: ${PUBLIC_URL}/sitemap.xml`,
  '',
].join('\n')

export async function seoPreisRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/seo/preis/page/*', async (req, reply: FastifyReply) => {
    const wildcard = (req.params as { '*'?: string })['*'] ?? ''
    const path = `/${wildcard}`.replace(/\/{2,}/g, '/')
    let shellHtml: string
    try {
      shellHtml = await loadShell()
    } catch (err) {
      // nginx falls through to the static shell, so the charts still load.
      console.error('[seo/preis] no shell available:', err)
      return reply.status(502).send({ error: 'Shell unavailable' })
    }
    return reply.type('text/html; charset=utf-8').header('cache-control', 'public, max-age=60').send(renderPreisPage(shellHtml, path))
  })

  fastify.get('/seo/preis/sitemap.xml', async (_req, reply) =>
    reply.type('application/xml; charset=utf-8').header('cache-control', 'public, max-age=3600').send(preisSitemap()))

  fastify.get('/seo/preis/robots.txt', async (_req, reply) =>
    reply.type('text/plain; charset=utf-8').header('cache-control', 'public, max-age=3600').send(PREIS_ROBOTS))
}
