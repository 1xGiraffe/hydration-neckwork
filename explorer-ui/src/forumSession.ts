import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { ApiError, forumApi, setForumGeneration, userApi } from './api/explorer'
import { getSession, setSession, useSession } from './session'
import { getChainWallets, reconnectRemembered, signMessage, signerFor, type ChainAccount } from './chainWallet'
import { F } from './components/ui'
import type { ForumAction, ForumMe } from './governanceTypes'

// The forum's side of the explorer login. Writing in the forum needs the same
// session every signed-in surface uses (session.ts: a bearer token, never a cookie):
// one signed message — no transaction, no fee — from a wallet already connected for
// voting (chainWallet.ts), or through the login dialog for any other wallet. The
// statement the wallet shows names the explorer's domain, the purpose, a single-use
// nonce and when it expires (api: userAuthService.buildLoginMessage).

/** The forum standing of the signed-in account: what it may do, and why not. */
export function useForumMe() {
  const session = useSession()
  return useQuery({
    queryKey: ['forum-me', session?.accountId ?? null],
    queryFn: ({ signal }) => forumApi.me(signal),
    enabled: !!session,
    staleTime: 60_000,
    retry: 1,
  })
}

/** Connected accounts that can sign a login message (an H160 inside a substrate extension cannot). */
export function signableAccounts(accounts: readonly ChainAccount[]): ChainAccount[] {
  return accounts.filter(a => a.kind === 'substrate' || a.kind === 'evm')
}

/** Signs in with a wallet already connected for voting: challenge → wallet signature → session. */
export async function signInWithChainAccount(account: ChainAccount): Promise<void> {
  if (!signerFor(account)) await reconnectRemembered()
  const live = getChainWallets().flatMap(w => w.accounts).find(a => a.id === account.id) ?? account
  const { nonce, message } = await userApi.challenge(live.address)
  const signature = await signMessage(live, message)
  const { token, me } = await userApi.verify(live.address, nonce, signature)
  setSession({ token, accountId: me.account.accountId, address: me.account.address })
}

/** After a write: remember its generation (reads skip the edge cache) and refetch every forum read. */
export function afterForumWrite(qc: QueryClient, generation: string | null | undefined): void {
  setForumGeneration(generation)
  void qc.invalidateQueries({ predicate: q => typeof q.queryKey[0] === 'string' && (q.queryKey[0] as string).startsWith('forum-') && q.queryKey[0] !== 'forum-me' })
}

export function useAfterForumWrite(): (generation: string | null | undefined) => void {
  const qc = useQueryClient()
  return g => afterForumWrite(qc, g)
}

/** True when the item is the signed-in account's own (its author). */
export function isMine(accountId: string | null | undefined): boolean {
  const s = getSession()
  return !!s && !!accountId && s.accountId === accountId
}

const ERROR_FALLBACK = 'This could not be saved — your text is still here. Try again.'

/** A forum write's refusal in the api's own words (they say what to do), or a plain fallback. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.body.error || e.message || ERROR_FALLBACK
  return e instanceof Error && e.message ? e.message : ERROR_FALLBACK
}

/**
 * Threads that take new comments: discussions and OpenGov referenda (canonical keys
 * only — 'opengov:0450' is no referendum). The pre-OpenGov archive is read-only.
 */
export function threadIsWritable(threadKey: string): boolean {
  return /^(opengov:(0|[1-9]\d{0,8})|\d+|s\d+)$/.test(threadKey)
}

const ACTION_WORDS: Record<ForumAction, string> = {
  comment: 'Commenting', post: 'Starting a discussion', report: 'Reporting', upload: 'Adding images',
}

export interface ActionGate {
  /** The action may be taken now (or the standing is still loading — the api decides). */
  ok: boolean
  /** Signed out: the action's button opens sign-in instead. */
  signIn: boolean
  /** Why not, with the next step; null when allowed. */
  reason: string | null
}

/**
 * Whether the signed-in account may take a forum action, and if not, why — in words
 * that name the account's balance and what would unlock it. The api's own reason wins
 * when it gives one; otherwise it is derived from the standing it reported.
 */
export function actionGate(action: ForumAction, me: ForumMe | undefined, signedIn: boolean): ActionGate {
  if (!signedIn) return { ok: false, signIn: true, reason: `Sign in to ${action === 'post' ? 'start a discussion' : action === 'upload' ? 'add images' : action}.` }
  if (!me) return { ok: true, signIn: false, reason: null }
  const fromApi = me.actions?.[action]
  if (fromApi) return { ok: fromApi.ok, signIn: false, reason: fromApi.ok ? null : fromApi.reason ?? me.gate?.detail ?? 'This account cannot do this right now.' }
  const ok = action === 'post' ? me.canPost : me.canComment
  if (ok) return { ok: true, signIn: false, reason: null }
  if (me.gate?.reason === 'muted') return { ok: false, signIn: false, reason: me.gate.detail }
  const need = action === 'post' ? me.thresholds?.postHdx ?? 100 : me.thresholds?.commentHdx ?? 1
  const held = me.facts ? ` This account holds ${F.amount(me.facts.hdx, 12)} HDX` : ''
  return {
    ok: false, signIn: false,
    reason: `${ACTION_WORDS[action]} needs at least ${need} HDX, an on-chain identity, or a vote on any referendum.${held ? `${held} — add HDX, set an identity, or vote on a referendum to unlock it.` : ''}`,
  }
}

/** actionGate for the signed-in account, from its forum standing. */
export function useActionGate(action: ForumAction): ActionGate {
  const session = useSession()
  const me = useForumMe()
  return actionGate(action, me.data, !!session)
}

/** What the signed-in account may do with a post (author, or the proposer's authority). */
export function usePostPermissions(postId: string) {
  const session = useSession()
  return useQuery({
    queryKey: ['forum-perms', postId, session?.accountId ?? null],
    queryFn: ({ signal }) => forumApi.permissions(postId, signal),
    enabled: !!session,
    staleTime: 60_000,
  })
}
