import type { ListedPostKind } from './governanceTypes'

// Where a forum post lives in the app. Discussions have /discussions/<id>, referenda
// their referendum page, and every archive body's imported record its own page under
// /governance/<route>/<id>. The same table drives the api's page heads
// (api/src/routes/seo.ts SUBJECT_ROUTES) — keep the two in step.

export interface SubjectRoute {
  route: string
  kind: ListedPostKind
  /** The post id prefix: `<prefix>:<id>`. */
  prefix: string
  label: string
  plural: string
  idRe: RegExp
}

const HASH_AT_BLOCK = /^0x[0-9a-f]{64}@\d{1,10}$/

export const SUBJECT_ROUTES: SubjectRoute[] = [
  { route: 'democracy/proposal', kind: 'democracy_proposal', prefix: 'democracy_proposal', label: 'Democracy proposal', plural: 'Democracy proposals', idRe: /^\d{1,9}$/ },
  { route: 'democracy/external', kind: 'external', prefix: 'external', label: 'External proposal', plural: 'External proposals', idRe: HASH_AT_BLOCK },
  { route: 'motion/council', kind: 'council', prefix: 'council', label: 'Council motion', plural: 'Council motions', idRe: /^\d{1,9}$/ },
  // A TC motion is addressed by its index; the two early motions the chain gave no index are `<hash>@<block>`.
  { route: 'motion/tc', kind: 'tc', prefix: 'tc', label: 'Technical committee motion', plural: 'Technical committee motions', idRe: /^(\d{1,9}|0x[0-9a-f]{64}@\d{1,10})$/ },
  { route: 'treasury/proposal', kind: 'treasury_proposal', prefix: 'treasury', label: 'Treasury proposal', plural: 'Treasury proposals', idRe: /^\d{1,9}$/ },
  { route: 'treasury/spend', kind: 'treasury_spend', prefix: 'spend', label: 'Treasury spend', plural: 'Treasury spends', idRe: /^\d{1,9}$/ },
  { route: 'tip', kind: 'tip', prefix: 'tip', label: 'Treasury tip', plural: 'Treasury tips', idRe: HASH_AT_BLOCK },
]

export function subjectRouteByKind(kind: string): SubjectRoute | null {
  return SUBJECT_ROUTES.find(s => s.kind === kind) ?? null
}

/** `/governance/motion/council/7` → the council route and id '7' (null when it is not a subject path). */
export function subjectFromParts(parts: string[]): { subject: SubjectRoute; id: string } | null {
  if (parts[0] !== 'governance') return null
  const route = parts.length === 4 ? `${parts[1]}/${parts[2]}` : parts.length === 3 ? parts[1] : ''
  const subject = SUBJECT_ROUTES.find(s => s.route === route)
  const id = parts[parts.length - 1]
  return subject && id && subject.idRe.test(id) ? { subject, id } : null
}

export function subjectPostId(subject: SubjectRoute, id: string): string {
  return `${subject.prefix}:${id}`
}

/** The app page that shows a forum post, by its id (null for a kind with no page). */
export function forumPostPath(postId: string): string | null {
  if (/^[A-Za-z0-9]{1,40}$/.test(postId)) return `/discussions/${postId}`
  const m = /^([a-z_]+):(.+)$/.exec(postId)
  if (!m) return null
  if (m[1] === 'opengov' || m[1] === 'democracy') return /^\d+$/.test(m[2]) ? `/referendum/${m[1]}/${m[2]}` : null
  const subject = SUBJECT_ROUTES.find(s => s.prefix === m[1])
  return subject && subject.idRe.test(m[2]) ? `/governance/${subject.route}/${m[2]}` : null
}

/** A short human name for a post id ("Referendum #450", "Council motion #7", "Discussion"). */
export function forumPostLabel(postId: string): string {
  const m = /^([a-z_]+):(.+)$/.exec(postId)
  if (!m) return 'Discussion'
  if (m[1] === 'opengov') return `Referendum #${m[2]}`
  if (m[1] === 'democracy') return `Democracy referendum #${m[2]}`
  const subject = SUBJECT_ROUTES.find(s => s.prefix === m[1])
  if (!subject) return 'Post'
  return HASH_AT_BLOCK.test(m[2]) ? `${subject.label} ${m[2].slice(0, 8)}…` : `${subject.label} #${m[2]}`
}
