import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef } from 'react'
import { closeVote, dismissCartNotice, leaveWallets, openVote, takeOpener, useCart, useCartActions, useCartNotice, useVoteView } from './voteBus'
import { VoteComposer } from './VoteComposer'
import { CartSheet } from './CartSheet'
import { UnlockSheet } from './UnlockSheet'
import { ActionSheet } from './ActionSheet'
import { WalletPanel } from './WalletDialog'
import { useReferendum } from '../hooks/useExplorerData'
import { useRoute } from '../router'
import type { Route } from '../router'
import './vote.css'

// The voting sheets, mounted once (lazily, the first time anything voting-related
// is opened) and driven by voteBus: a side panel on wide screens, a bottom sheet on
// phones. Wallets are managed from the account picker's menu. The floating cart
// button shows while the cart holds votes, on the pages a vote is made from
// (governance, referenda, discussions, accounts) and nowhere else.

const CART_ROUTES = new Set<Route['name']>([
  'governance', 'governanceMe', 'governanceSubject', 'governanceModeration', 'governancePropose',
  'referendum', 'discussions', 'discussion', 'discussionNew', 'account',
])

function ComposerTitle({ index }: { index: number }) {
  const d = useReferendum('opengov', index)
  return <>{`Vote on #${index}`}{d.data?.title ? <span className="vote-sheet-sub">{d.data.title}</span> : null}</>
}

/** What the last quick button did to the cart, for a few seconds — with the way to review it. */
function CartToast({ hidden }: { hidden: boolean }) {
  const n = useCartNotice()
  useEffect(() => {
    if (!n) return
    const t = setTimeout(dismissCartNotice, 6000)
    return () => clearTimeout(t)
  }, [n])
  if (!n || hidden) return null
  return (
    <div className="vote-toast" role="status" aria-live="polite">
      <span>{n.text}</span>
      <button type="button" className="link-btn" onClick={() => { dismissCartNotice(); openVote({ kind: 'cart' }) }}>Review</button>
      <button type="button" className="vote-toast-x" aria-label="Dismiss" onClick={dismissCartNotice}>×</button>
    </div>
  )
}

export default function VoteHost() {
  const view = useVoteView()
  const votes = useCart()
  const actions = useCartActions()
  const inCart = votes.length + actions.length
  const route = useRoute()
  const cartHere = CART_ROUTES.has(route.name)
  const open = view != null
  // Focus: the sheet's title when it opens or switches to another view (so a screen
  // reader announces where it is, and Tab starts at the top of that view), and back to
  // the control that opened it when it closes.
  const titleRef = useRef<HTMLHeadingElement>(null)
  const viewKey = view ? (view.kind === 'composer' ? `composer:${view.target.index}` : view.kind === 'unlock' ? `unlock:${view.address}` : view.kind === 'actions' ? `actions:${view.title}` : view.kind) : ''
  const shownKey = useRef('')
  useEffect(() => {
    if (viewKey && shownKey.current && shownKey.current !== viewKey) titleRef.current?.focus()
    shownKey.current = viewKey
  }, [viewKey])
  const title = view?.kind === 'composer' ? <ComposerTitle index={view.target.index} />
    : view?.kind === 'cart' ? (votes.length || !actions.length ? 'Vote cart' : 'Cart')
    : view?.kind === 'actions' ? view.title
    : view?.kind === 'unlock' ? 'Unlock & clean up'
    : view?.kind === 'wallets' ? 'Wallets for signing'
    : ''
  return (
    <>
      <Dialog.Root open={open} onOpenChange={o => { if (!o) closeVote() }}>
        <Dialog.Portal>
          <Dialog.Overlay className="vote-overlay" />
          <Dialog.Content className="vote-sheet" aria-describedby={undefined}
            onOpenAutoFocus={e => { e.preventDefault(); titleRef.current?.focus() }}
            onCloseAutoFocus={e => {
              e.preventDefault()
              const o = takeOpener()
              const to = o?.isConnected && o.getClientRects().length ? o : document.getElementById('view')
              to?.focus({ preventScroll: true })
            }}>
            <div className="vote-sheet-head">
              {view?.kind === 'wallets' && <button type="button" className="vote-back" onClick={leaveWallets} aria-label="Back">←</button>}
              <Dialog.Title className="vote-sheet-title" ref={titleRef} tabIndex={-1}>{title}</Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="theme-toggle" aria-label="Close">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </Dialog.Close>
            </div>
            <div className="vote-sheet-body">
              {view?.kind === 'composer' && <VoteComposer key={view.target.index} target={view.target} />}
              {view?.kind === 'cart' && <CartSheet />}
              {view?.kind === 'unlock' && <UnlockSheet address={view.address} />}
              {view?.kind === 'actions' && <ActionSheet key={view.title} items={view.items} />}
              {view?.kind === 'wallets' && <WalletPanel onDone={leaveWallets} />}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {/* Kept mounted (only hidden) while the cart is open, so focus can return to it. */}
      {inCart > 0 && cartHere && (
        <button type="button" className="vote-cart-fab" hidden={view?.kind === 'cart'} onClick={() => openVote({ kind: 'cart' })}>
          <span className="vote-cart-count">{inCart}</span> {actions.length === 0 ? (inCart === 1 ? 'vote' : 'votes') : votes.length === 0 ? (inCart === 1 ? 'action' : 'actions') : 'items'} in cart · Review
        </button>
      )}
      <CartToast hidden={view != null} />
    </>
  )
}
