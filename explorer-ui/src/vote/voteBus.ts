import { useSyncExternalStore } from 'react'

// The app-wide voting state every page can reach without loading the voting code:
// which sheet is open (the composer for a referendum, the cart, the unlock sheet,
// the wallet dialog), the vote cart, and the voter's remembered choices. The sheets
// themselves load lazily (VoteHost) the first time any of this is used.
//
// The cart lives in sessionStorage (it is a draft for this tab); the preferences
// (the "almost full" reserve, who signed and for whom last time) in localStorage.

export type Direction = 'aye' | 'nay' | 'abstain'

export interface ComposerTarget {
  index: number
  title?: string | null
  /** The referendum's track (its ConvictionVoting class), when the caller knows it. */
  track?: number | null
  /** Open with this direction already chosen (a quick Aye/Nay/Abstain button). */
  direction?: Direction | null
  /** The button that opened it: "Vote" (an account that has not voted yet) or "Change vote" (the one that did). */
  intent?: VoteIntent | null
}

export type VoteIntent = 'vote' | 'change'

export type VoteView =
  | { kind: 'composer'; target: ComposerTarget }
  | { kind: 'cart' }
  | { kind: 'unlock'; address: string | null }
  | { kind: 'wallets' }
  /** One or more deposit or refund actions, signed together (ActionSheet). */
  | { kind: 'actions'; items: CartAction[]; title: string }
  | null

/**
 * A signed action other than a vote, as the cart and the action sheet carry it: a
 * referendum deposit placed or refunded, or a preimage unnoted. `label` says it in
 * words; `amount` (raw HDX) is what it moves, when known; `owner` is the one account
 * that may sign an unnote (refunds are anyone's to sign).
 */
export type CartActionKind = 'place-decision-deposit' | 'refund-decision-deposit' | 'refund-submission-deposit' | 'unnote-preimage'
export interface CartAction {
  kind: CartActionKind
  /** The referendum index (absent for a preimage). */
  index?: number
  /** The preimage hash (unnote only). */
  hash?: string
  label: string
  amount?: string | null
  owner?: string | null
}

export const cartActionKey = (a: Pick<CartAction, 'kind' | 'index' | 'hash'>) => `${a.kind}:${a.index ?? a.hash ?? ''}`

export interface CartItem {
  index: number
  title: string | null
  track: number | null
  direction: Direction
}

export const CART_KEY = 'explorer-vote-cart'
export const ACTION_CART_KEY = 'explorer-action-cart'
export const PREFS_KEY = 'explorer-vote-prefs'
export const CART_MAX = 25

export interface VotePrefs {
  /** The "almost full" reserve in planck, as the voter last set it. */
  reserve: string | null
  /** The account (ChainAccount.id) that signed last. */
  signer: string | null
  /** For whom it voted last, per signer: the actor's account id (hex). */
  actorBySigner: Record<string, string>
  /** Proxied voters (Voter.key) the reader picked explicitly; only these are restored. */
  pickedProxies?: string[]
}

function readCart(): CartItem[] {
  try {
    const raw = sessionStorage.getItem(CART_KEY)
    const v = raw ? JSON.parse(raw) as unknown : []
    return Array.isArray(v)
      ? v.filter((x): x is CartItem => !!x && Number.isInteger((x as CartItem).index) && ['aye', 'nay', 'abstain'].includes((x as CartItem).direction)).slice(0, CART_MAX)
      : []
  } catch { return [] }
}

function readPrefs(): VotePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    const v = raw ? JSON.parse(raw) as Partial<VotePrefs> : {}
    return {
      reserve: typeof v.reserve === 'string' && /^\d+$/.test(v.reserve) ? v.reserve : null,
      signer: typeof v.signer === 'string' ? v.signer : null,
      actorBySigner: v.actorBySigner && typeof v.actorBySigner === 'object' ? v.actorBySigner : {},
      pickedProxies: Array.isArray(v.pickedProxies) ? v.pickedProxies.filter((x): x is string => typeof x === 'string').slice(-20) : [],
    }
  } catch { return { reserve: null, signer: null, actorBySigner: {} } }
}

// What the cart may hold; a stored entry of any other kind is dropped on read.
const ACTION_KINDS = new Set<string>(['place-decision-deposit', 'refund-decision-deposit', 'refund-submission-deposit', 'unnote-preimage'] satisfies CartActionKind[])

function readActionCart(): CartAction[] {
  try {
    const raw = sessionStorage.getItem(ACTION_CART_KEY)
    const v = raw ? JSON.parse(raw) as unknown : []
    return Array.isArray(v)
      ? v.filter((x): x is CartAction => !!x && ACTION_KINDS.has((x as CartAction).kind) && typeof (x as CartAction).label === 'string'
        && (Number.isInteger((x as CartAction).index) || /^0x[0-9a-f]{64}$/i.test(String((x as CartAction).hash ?? '')))).slice(0, CART_MAX)
      : []
  } catch { return [] }
}

let view: VoteView = null
let cart: CartItem[] = readCart()
let actionCart: CartAction[] = readActionCart()
let prefs: VotePrefs = readPrefs()
let used = cart.length > 0 || actionCart.length > 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }

let back: VoteView = null
// The control that opened the sheets from the page: the sheets open from a bus, not a
// dialog trigger, so the host hands focus back to it when they close.
let opener: HTMLElement | null = null
function noteOpener(): void {
  if (view != null || typeof document === 'undefined') return
  const a = document.activeElement
  opener = a instanceof HTMLElement && a !== document.body ? a : null
}
export function openVote(next: VoteView): void { noteOpener(); view = next; back = null; used = true; emit() }
export function closeVote(): void { view = null; back = null; emit() }
/** The wallet dialog over whatever is open; `leaveWallets` returns to it. */
export function openWallets(): void { noteOpener(); if (view?.kind !== 'wallets') back = view; view = { kind: 'wallets' }; used = true; emit() }
export function leaveWallets(): void { view = back; back = null; emit() }
/** The element focus returns to once the sheets close (read once). */
export function takeOpener(): HTMLElement | null { const o = opener; opener = null; return o }
export function useVoteView(): VoteView { return useSyncExternalStore(subscribe, () => view, () => null) }
/** True once anything voting-related was opened or the cart holds a draft: the host mounts then and stays. */
export function useVoteHostWanted(): boolean { return useSyncExternalStore(subscribe, () => used, () => false) }

function saveCart() {
  try { if (cart.length) sessionStorage.setItem(CART_KEY, JSON.stringify(cart)); else sessionStorage.removeItem(CART_KEY) } catch { /* ignore */ }
}

export function useCart(): CartItem[] { return useSyncExternalStore(subscribe, () => cart, () => cart) }
export function getCart(): CartItem[] { return cart }

// The last change a quick Aye/Nay/Abstain button made to the cart, said back to the
// reader (the toast the voting host shows), so a click never fills the cart silently.
export interface CartNotice { text: string; at: number }
let notice: CartNotice | null = null
export function useCartNotice(): CartNotice | null { return useSyncExternalStore(subscribe, () => notice, () => null) }
export function dismissCartNotice(): void { notice = null; emit() }

const DIRECTION_WORD: Record<Direction, string> = { aye: 'Aye', nay: 'Nay', abstain: 'Abstain' }

/** Add a referendum to the cart, or change its direction; the same direction again takes it out. */
export function toggleCart(item: CartItem): void {
  const existing = cart.find(c => c.index === item.index)
  if (existing && existing.direction === item.direction) {
    cart = cart.filter(c => c.index !== item.index)
    notice = { text: `Took #${item.index} out of your vote cart.`, at: Date.now() }
  } else if (existing) {
    cart = cart.map(c => (c.index === item.index ? { ...c, direction: item.direction } : c))
    notice = { text: `Changed #${item.index} to ${DIRECTION_WORD[item.direction]} in your vote cart — check amount and lock before signing.`, at: Date.now() }
  } else if (cart.length < CART_MAX) {
    cart = [...cart, item]
    notice = { text: `Added ${DIRECTION_WORD[item.direction]} on #${item.index} to your vote cart — check amount and lock before signing.`, at: Date.now() }
  } else {
    notice = { text: `The vote cart is full (${CART_MAX}). Sign or remove some first.`, at: Date.now() }
  }
  used = true
  saveCart()
  emit()
}

function saveActionCart() {
  try { if (actionCart.length) sessionStorage.setItem(ACTION_CART_KEY, JSON.stringify(actionCart)); else sessionStorage.removeItem(ACTION_CART_KEY) } catch { /* ignore */ }
}

/** The non-vote actions waiting in the cart; they are signed in the same batch as its votes. */
export function useCartActions(): CartAction[] { return useSyncExternalStore(subscribe, () => actionCart, () => actionCart) }
export function inCartActions(a: Pick<CartAction, 'kind' | 'index' | 'hash'>): boolean { return actionCart.some(x => cartActionKey(x) === cartActionKey(a)) }

/** Put an action in the cart, or take it out when it is already there. */
export function toggleCartAction(a: CartAction): void {
  if (!ACTION_KINDS.has(a.kind)) return
  const key = cartActionKey(a)
  if (actionCart.some(x => cartActionKey(x) === key)) {
    actionCart = actionCart.filter(x => cartActionKey(x) !== key)
    notice = { text: `Took “${a.label}” out of your cart.`, at: Date.now() }
  } else if (cart.length + actionCart.length < CART_MAX) {
    actionCart = [...actionCart, a]
    notice = { text: `Added “${a.label}” to your cart.`, at: Date.now() }
  } else {
    notice = { text: `The cart is full (${CART_MAX}). Sign or remove some first.`, at: Date.now() }
  }
  used = true
  saveActionCart()
  emit()
}
export function removeCartActions(keys: string[]): void { actionCart = actionCart.filter(x => !keys.includes(cartActionKey(x))); saveActionCart(); emit() }

export function removeFromCart(index: number): void { cart = cart.filter(c => c.index !== index); saveCart(); emit() }
export function setCartDirection(index: number, direction: Direction): void { cart = cart.map(c => (c.index === index ? { ...c, direction } : c)); saveCart(); emit() }
export function clearCart(indices?: number[]): void {
  cart = indices ? cart.filter(c => !indices.includes(c.index)) : []
  saveCart()
  emit()
}

export function useVotePrefs(): VotePrefs { return useSyncExternalStore(subscribe, () => prefs, () => prefs) }
export function setVotePrefs(patch: Partial<VotePrefs>): void {
  prefs = { ...prefs, ...patch, actorBySigner: { ...prefs.actorBySigner, ...(patch.actorBySigner ?? {}) } }
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* ignore */ }
  emit()
}

// Votes signed in this tab, keyed `${actorId}:${index}`, so the page reads "Change
// vote" (and the needs-vote list drops the referendum) before the indexer has seen
// the block. The api's own state replaces them as it catches up.
export interface RecentVote { actorId: string; index: number; direction: Direction | 'split'; conviction: number | null; balance: string; at: number }
let recent: RecentVote[] = []
export function rememberVote(v: RecentVote): void { recent = [...recent.filter(r => !(r.actorId === v.actorId && r.index === v.index)), v]; emit() }
export function forgetVote(actorId: string, index: number): void { recent = recent.filter(r => !(r.actorId === actorId && r.index === index)); emit() }
export function useRecentVotes(): RecentVote[] { return useSyncExternalStore(subscribe, () => recent, () => recent) }
