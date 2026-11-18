import type { FastifyInstance, FastifyReply } from 'fastify'
import { getReferenda } from '../services/governanceService.ts'
import { forumPost, forumReady } from '../services/forumStore.ts'

// The Atom feed of the referendum directory (/feeds/referenda.atom: referenda by
// their last lifecycle activity, so a status change re-dates the entry and a reader
// sees it again). The explorer's nginx maps it here; the pages link it as an alternate.
//
// It answers from what is already in memory — the cached referendum directory and
// the forum snapshot — so a feed reader polling every few minutes costs no query.
// Every title, excerpt and name is HOSTILE user text: it goes out as XML-escaped
// `type="text"` content only (never `html`), with the characters XML 1.0 forbids
// removed, and a hidden or deleted description's excerpt is never shown.

const PUBLIC_URL = (process.env.EXPLORER_PUBLIC_URL ?? 'https://hydration-explorer.neckwork.net').replace(/\/+$/, '')
const ENTRIES = 50
// Short, so a moderator's hide leaves a reader's next poll within a minute.
const FEED_CACHE = 'public, max-age=60'

// C0 controls other than tab/LF/CR, the two non-characters and unpaired surrogates
// are not allowed anywhere in an XML 1.0 document; one in a title would make the
// whole feed unparseable.
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
export const xmlText = (s: string): string => s.replace(XML_FORBIDDEN, '').replace(/[&<>"']/g, c => XML_ESCAPES[c])

/** A ClickHouse 'YYYY-MM-DD HH:MM:SS' (UTC) or an ISO string as RFC 3339; null when it is neither, or the epoch (an unknown date). */
export function rfc3339(ts: string | number | null | undefined): string | null {
  if (ts == null || ts === '') return null
  const ms = typeof ts === 'number' ? ts : Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(ts) ? ts : `${ts.replace(' ', 'T')}Z`)
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null
}

// `updated` null = no known date: the entry is left out rather than dated 1970.
export interface FeedEntry { id: string; title: string; link: string; updated: string | null; published?: string | null; author?: string | null; summary?: string | null }

export function renderAtom(feed: { id: string; title: string; subtitle: string; self: string; alternate: string; entries: FeedEntry[] }, now = Date.now()): string {
  const entries = feed.entries.filter((e): e is FeedEntry & { updated: string } => !!e.updated)
  // The newest entry's date; an empty feed is as of now.
  const updated = entries.reduce<string | null>((m, e) => (m == null || e.updated > m ? e.updated : m), null) ?? new Date(now).toISOString()
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${xmlText(feed.id)}</id>`,
    `  <title type="text">${xmlText(feed.title)}</title>`,
    `  <subtitle type="text">${xmlText(feed.subtitle)}</subtitle>`,
    `  <link rel="self" type="application/atom+xml" href="${xmlText(feed.self)}"/>`,
    `  <link rel="alternate" type="text/html" href="${xmlText(feed.alternate)}"/>`,
    `  <updated>${updated}</updated>`,
    `  <author><name>Hydration Explorer</name><uri>${xmlText(PUBLIC_URL)}</uri></author>`,
    '  <generator>Hydration Explorer</generator>',
  ]
  for (const e of entries) {
    lines.push(
      '  <entry>',
      `    <id>${xmlText(e.id)}</id>`,
      `    <title type="text">${xmlText(e.title)}</title>`,
      `    <link rel="alternate" type="text/html" href="${xmlText(e.link)}"/>`,
      `    <updated>${e.updated}</updated>`,
      ...(e.published ? [`    <published>${e.published}</published>`] : []),
      ...(e.author ? [`    <author><name>${xmlText(e.author)}</name></author>`] : []),
      ...(e.summary ? [`    <summary type="text">${xmlText(e.summary)}</summary>`] : []),
      '  </entry>',
    )
  }
  lines.push('</feed>', '')
  return lines.join('\n')
}

export async function referendaFeed(): Promise<string> {
  const rows = await getReferenda(ENTRIES, 0)
  return renderAtom({
    id: `${PUBLIC_URL}/governance`,
    title: 'Hydration referenda',
    subtitle: 'Hydration OpenGov and Democracy referenda, newest activity first: each entry is re-dated when its status changes.',
    self: `${PUBLIC_URL}/feeds/referenda.atom`,
    alternate: `${PUBLIC_URL}/governance?tab=referenda`,
    entries: rows.map(r => {
      const label = r.pallet === 'opengov' ? 'OpenGov' : 'Democracy'
      const url = `${PUBLIC_URL}/referendum/${r.pallet}/${r.index}`
      // The description post's plain-text excerpt, when it is shown (never a hidden one's).
      const post = forumReady() ? forumPost(`${r.pallet}:${r.index}`) : null
      const excerpt = post && !post.hidden && !post.deleted ? post.excerpt.trim() : ''
      const facts = [`Status: ${r.status}`, r.track ? `track ${r.track.name}` : null].filter(Boolean).join(' · ')
      return {
        id: url,
        title: `${label} #${r.index}${r.title ? `: ${r.title}` : ''}`,
        link: url,
        updated: rfc3339(r.timestamp),
        author: r.proposer ? (r.proposer.identity?.display?.trim() || r.proposer.address) : null,
        summary: excerpt ? `${facts}. ${excerpt}` : facts,
      }
    }),
  })
}

function sendAtom(reply: FastifyReply, body: string): FastifyReply {
  return reply
    .type('application/atom+xml; charset=utf-8')
    .header('cache-control', FEED_CACHE)
    .send(body)
}

export async function feedRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/feeds/referenda.atom', async (_req, reply) => sendAtom(reply, await referendaFeed()))
}
