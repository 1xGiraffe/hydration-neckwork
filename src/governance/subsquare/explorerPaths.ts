// Subsquare page paths (hydration.subsquare.io, and hydradx.subsquare.io from
// Hydration's earlier name) → the explorer page showing the same record. Pure and
// dependency-free: the sync imports it to rewrite imported text, and
// explorer-ui/tests/subsquare-paths.test.ts pins it against the explorer router's
// legacy redirects (router.tsx `parseRoute`), the nginx 301s for the same paths
// (explorer-ui/nginx.conf) and the subject routes (governanceSubjects.ts). Where the
// router has a rule for a path this module gives the same target; it also covers the
// Subsquare paths the router has none for (externals, tips, TC motions, accounts).

/** A Subsquare page's explorer counterpart. */
export interface ExplorerTarget {
  /** Relative explorer path (query included where the page needs one); null when the page has no counterpart and the link is dropped. */
  path: string | null
  /** Text standing in for a bare URL (a title, a URL written as plain text). */
  label: string
  /** false when `path` is only the closest page (the path names something the explorer has no page for, or is malformed). */
  exact: boolean
}

/** Resolves a collective motion named by `<block>_<hash>` (Subsquare's spelling for a motion) to our id: its index, or `<hash>@<block>`. */
export type MotionResolver = (body: 'council' | 'tc', hash: string, height: number) => string | null

/** The labels the explorer gives each subject (governanceSubjects.ts SUBJECT_ROUTES `label`). */
export const SUBJECT_LABELS = {
  democracy_proposal: 'Democracy proposal',
  external: 'External proposal',
  council: 'Council motion',
  tc: 'Technical committee motion',
  treasury_proposal: 'Treasury proposal',
  treasury_spend: 'Treasury spend',
  tip: 'Treasury tip',
} as const

const INDEX = /^(0|[1-9]\d{0,8})$/
const HASH_AT = /^(\d{1,10})_(0x[0-9a-fA-F]{64})$/
/** SS58 of any prefix, or a 0x H160 / AccountId32 — the forms a Subsquare /user/ path carries. */
export const ADDRESS_RE = /^(?:[1-9A-HJ-NP-Za-km-z]{40,50}|0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64})$/

const exact = (path: string, label: string): ExplorerTarget => ({ path, label, exact: true })
const near = (path: string, label: string): ExplorerTarget => ({ path, label, exact: false })

const GOVERNANCE = near('/governance', 'Governance')
const REFERENDA = near('/governance?tab=referenda', 'Referenda')
const DISCUSSIONS = near('/discussions', 'Discussions')
const COMMITTEE = near('/governance?tab=committee', 'Technical committee')
const ARCHIVE = near('/governance?tab=archive', 'Democracy & Council archive')

const short = (hash: string) => `${hash.slice(0, 10)}…`

function hashAt(segment: string | undefined): { hash: string; height: number } | null {
  const m = segment ? HASH_AT.exec(segment) : null
  return m ? { hash: m[2].toLowerCase(), height: Number(m[1]) } : null
}

function motion(body: 'council' | 'tc', segment: string | undefined, resolve: MotionResolver | undefined): ExplorerTarget | null {
  const label = SUBJECT_LABELS[body]
  if (segment && INDEX.test(segment)) return exact(`/governance/motion/${body}/${Number(segment)}`, `${label} #${Number(segment)}`)
  const h = hashAt(segment)
  const id = h && resolve?.(body, h.hash, h.height)
  if (id && INDEX.test(id)) return exact(`/governance/motion/${body}/${id}`, `${label} #${id}`)
  if (id && body === 'tc' && /^0x[0-9a-f]{64}@\d{1,10}$/.test(id)) return exact(`/governance/motion/tc/${id}`, `${label} ${short(id)}`)
  return null
}

/** Subsquare list pages whose explorer list is their counterpart (not merely the closest page). */
const LIST_PAGES = new Set(['', 'referenda', 'posts', 'discussions', 'democracy', 'democracy/referenda', 'democracy/proposals',
  'democracy/externals', 'council', 'council/motions', 'techcomm', 'techcomm/proposals', 'tech-comm', 'tech-comm/motions', 'treasury/tips'])

/**
 * The explorer counterpart of a Subsquare page path (no query or fragment). Every path
 * gets a target — the record's page, its list, or the closest page — except an
 * account page named by a username rather than an address, which has none
 * (`path: null`).
 */
export function subsquarePathTarget(pathname: string, resolve?: MotionResolver): ExplorerTarget {
  const t = target(pathname, resolve)
  if (t.exact || !t.path) return t
  const list = pathname.split('/').filter(Boolean).join('/').toLowerCase()
  return LIST_PAGES.has(list) ? { ...t, exact: true } : t
}

function target(pathname: string, resolve?: MotionResolver): ExplorerTarget {
  let parts: string[]
  try {
    parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return GOVERNANCE
  }
  const [s0 = '', s1, s2] = [parts[0]?.toLowerCase(), parts[1]?.toLowerCase(), parts[2]]
  switch (s0) {
    case '': return GOVERNANCE
    case 'referenda':
      if (s1 && INDEX.test(s1)) return exact(`/referendum/opengov/${Number(s1)}`, `Referendum #${Number(s1)}`)
      // An early Subsquare spelling: /referenda/referendum/<index>.
      if (s1 === 'referendum' && s2 && INDEX.test(s2)) return exact(`/referendum/opengov/${Number(s2)}`, `Referendum #${Number(s2)}`)
      return REFERENDA
    case 'posts': case 'post':
      return s1 && INDEX.test(s1) ? exact(`/discussions/s${Number(s1)}`, `Discussion #${Number(s1)}`) : DISCUSSIONS
    case 'discussions': return DISCUSSIONS
    case 'democracy':
      if ((s1 === 'referenda' || s1 === 'referendum') && s2 && INDEX.test(s2)) return exact(`/referendum/democracy/${Number(s2)}`, `Democracy referendum #${Number(s2)}`)
      if ((s1 === 'proposals' || s1 === 'proposal') && s2 && INDEX.test(s2)) return exact(`/governance/democracy/proposal/${Number(s2)}`, `${SUBJECT_LABELS.democracy_proposal} #${Number(s2)}`)
      if (s1 === 'externals' || s1 === 'external') {
        const h = hashAt(s2)
        if (h) return exact(`/governance/democracy/external/${h.hash}@${h.height}`, `${SUBJECT_LABELS.external} ${short(h.hash)}`)
      }
      return ARCHIVE
    case 'council':
      return (s1 === 'motions' || s1 === 'motion' ? motion('council', s2, resolve) : null) ?? ARCHIVE
    case 'techcomm': case 'tech-comm': case 'tc':
      return (s1 === 'proposals' || s1 === 'proposal' || s1 === 'motions' || s1 === 'motion' ? motion('tc', s2, resolve) : null) ?? COMMITTEE
    case 'treasury':
      if ((s1 === 'proposals' || s1 === 'proposal') && s2 && INDEX.test(s2)) return exact(`/governance/treasury/proposal/${Number(s2)}`, `${SUBJECT_LABELS.treasury_proposal} #${Number(s2)}`)
      if ((s1 === 'spends' || s1 === 'spend') && s2 && INDEX.test(s2)) return exact(`/governance/treasury/spend/${Number(s2)}`, `${SUBJECT_LABELS.treasury_spend} #${Number(s2)}`)
      if (s1 === 'tips' || s1 === 'tip') {
        const h = hashAt(s2)
        if (h) return exact(`/governance/tip/${h.hash}@${h.height}`, `${SUBJECT_LABELS.tip} ${short(h.hash)}`)
        return ARCHIVE
      }
      return GOVERNANCE
    case 'user': {
      // /user/<address>[/<tab>] is an account; /user/<username> names a legacy
      // email-only Subsquare account, which has no address and so no page here.
      const who = parts[1] ?? ''
      if (ADDRESS_RE.test(who)) return exact(`/account/${who}`, who)
      return { path: null, label: who, exact: false }
    }
    default:
      return GOVERNANCE
  }
}
