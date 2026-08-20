import { describe, it, expect, beforeEach } from 'vitest'
import { renderAccount, renderMatch, viewerTagResolver, type RuleMatch } from '../src/notifications/evaluator.ts'
import { accountText, renderNotification } from '../src/notifications/render.ts'
import type { NotificationRule } from '../src/notifications/notificationStore.ts'
import {
  createList, createTag, ensurePersonalList, initUserListService, loadUserLists,
  setListOrder, setTagMembers, subscribePublic,
} from '../src/services/userListService.ts'
import { initTagService, loadTags } from '../src/services/tagService.ts'
import { SYSTEM_LIST_ID } from '../src/services/userListService.ts'
import type { AccountRef, ActivityRow, AssetRef } from '../src/services/explorerService.ts'
import { fakeClient } from './helpers/userFakes.ts'

// "In notifications the address should be communicated as tag name, similar to
// the app — if I have access to the tag." Every account in a message is
// resolved through the RECIPIENT's own tag map first, by the same priority walk
// AddrPill/resolveTag does client-side: the viewer's lists in their stored
// order, with the system directory occupying one slot in that order.
//
// All of it reads userListService's resident maps, so this is a pure in-memory
// unit test — no ClickHouse, no accountRef enrichment.

const READER = '0x' + 'aa'.repeat(32)
const STRANGER = '0x' + 'bb'.repeat(32)
const CURATOR = '0x' + 'cc'.repeat(32)
const WHALE = '0x' + '11'.repeat(32)
const TREASURY = '0x' + '33'.repeat(32)

const SS58 = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'
const OTHER_SS58 = '13QPUtNGb84S8QTs5CjRfHNGjxeuPFyfXBFcYaHqweUmzHZJ'

const ref = (accountId: string, address: string, over: Partial<AccountRef> = {}): AccountRef =>
  ({ accountId, address, emoji: '🐋', tag: null, identity: null, profile: null, ...over })

const asset = (assetId: number, symbol: string, decimals = 12): AssetRef =>
  ({ assetId, iconAssetId: assetId, symbol, name: symbol, decimals, parachainId: null, origin: null })

const label = (viewer: string, account: AccountRef): string =>
  accountText(renderAccount(account, viewerTagResolver(viewer)))

beforeEach(async () => {
  initUserListService(fakeClient())
  await loadUserLists()
  initTagService(fakeClient({
    'price_data.account_tags': [
      { label_id: 'treasury', label_name: 'Treasury', color: '#74C742', note: '', icon: '🏦', account_id: TREASURY },
    ],
  }))
  await loadTags()
})

describe('recipient tag notation', () => {
  it('renders an account in the recipient\'s own list tag as that tag\'s name', async () => {
    const mine = await ensurePersonalList(READER)
    const tag = await createTag(READER, mine.listId, { name: 'Kraken hot' })
    await setTagMembers(READER, mine.listId, tag.tagId, [WHALE], [])

    expect(label(READER, ref(WHALE, SS58))).toBe('🐋 Kraken hot (RLZ)')
    // The same account, for somebody without that list, is nobody's Kraken hot.
    expect(label(STRANGER, ref(WHALE, SS58))).toBe('🐋 15Da…BDRLZ')
    // …and still renders under whatever public identity it does have.
    expect(label(STRANGER, ref(WHALE, SS58, { identity: { display: 'bkchr', verified: true, email: '', web: '', twitter: '' } })))
      .toBe('🐋 bkchr ✓ (RLZ)')
  })

  // A tag standing in for one of SEVERAL members is ambiguous in the UI, which
  // adds AddrPill's `·xyz` suffix. A message has no glyph layer and already
  // carries the short address in parentheses, so that same disambiguation is
  // present by construction — the label never stands alone.
  it('keeps the address tail alongside a multi-member tag, so two members never read alike', async () => {
    const mine = await ensurePersonalList(READER)
    const tag = await createTag(READER, mine.listId, { name: 'Kraken' })
    await setTagMembers(READER, mine.listId, tag.tagId, [WHALE, TREASURY], [])

    const first = label(READER, ref(WHALE, SS58))
    const second = label(READER, ref(TREASURY, OTHER_SS58))
    expect(first).toBe('🐋 Kraken (RLZ)')
    expect(second).toBe('🐋 Kraken (HZJ)')
    // The point of the tail: one tag over two accounts still reads as two.
    expect(first).not.toBe(second)
  })

  it('resolves both sides of a transfer, and the actor, through the same recipient map', async () => {
    const mine = await ensurePersonalList(READER)
    const tag = await createTag(READER, mine.listId, { name: 'Desk' })
    await setTagMembers(READER, mine.listId, tag.tagId, [WHALE, TREASURY], [])

    const row = {
      type: 'transfer', blockHeight: 1_001, timestamp: '2026-08-18 10:00:00', eventIndex: 3, extrinsicIndex: 1,
      who: ref(WHALE, SS58), to: ref(TREASURY, OTHER_SS58),
      asset: asset(0, 'HDX'), assetIn: null, assetOut: null,
      amount: '4590000000000000000', amountIn: null, amountOut: null, valueUsd: 12_500,
    } as unknown as ActivityRow
    const match = { ruleId: 'r1', accountId: READER, kind: 'account-activity', identity: '1001-e3', blockHeight: 1_001, payload: { lane: 'activity', row } } as RuleMatch
    const rule = { ruleId: 'r1', accountId: READER, kind: 'account-activity', name: '', params: {}, channels: [], muted: false, cooldownS: 0 } as NotificationRule

    const rendered = renderNotification(renderMatch(match, rule, viewerTagResolver(READER)))
    expect(rendered.title).toBe('Transfer by 🐋 Desk (RLZ)')
    expect(rendered.body).toContain('to 🐋 Desk (HZJ)')
    // A different recipient sees the same event without the borrowed names.
    const forStranger = renderNotification(renderMatch(match, rule, viewerTagResolver(STRANGER)))
    expect(forStranger.title).toBe('Transfer by 🐋 15Da…BDRLZ')
  })
})

describe('the system slot in the recipient\'s list order', () => {
  it('lets the system tag win an account when it outranks the list holding it', async () => {
    const shared = await createList(CURATOR, 'Desks', '', 'public')
    const tag = await createTag(CURATOR, shared.listId, { name: 'Desk' })
    await setTagMembers(CURATOR, shared.listId, tag.tagId, [TREASURY], [])
    await subscribePublic(READER, shared.listId)
    // A subscribed list ranks after 'system' by default.
    await setListOrder(READER, [SYSTEM_LIST_ID, shared.listId])

    // The system tag rides on the AccountRef, so "no user tag" is how the
    // resolver hands the account back to accountNotation's system-tag step.
    expect(viewerTagResolver(READER)(TREASURY)).toBeNull()
    expect(label(READER, ref(TREASURY, SS58, { tag: { name: 'Treasury' } as AccountRef['tag'] })))
      .toBe('🐋 Treasury (RLZ)')
  })

  it('lets a list ordered above the system slot outrank the system tag', async () => {
    const mine = await ensurePersonalList(READER)
    const tag = await createTag(READER, mine.listId, { name: 'The treasury' })
    await setTagMembers(READER, mine.listId, tag.tagId, [TREASURY], [])
    await setListOrder(READER, [mine.listId, SYSTEM_LIST_ID])

    expect(label(READER, ref(TREASURY, SS58, { tag: { name: 'Treasury' } as AccountRef['tag'] })))
      .toBe('🐋 The treasury (RLZ)')
  })

  // The slot claims an account only when it actually HAS a system tag; an
  // untagged account falls through it to the lists ranked below — which is
  // every subscribed list by default.
  it('falls through the system slot for an account that carries no system tag', async () => {
    const shared = await createList(CURATOR, 'Desks', '', 'public')
    const tag = await createTag(CURATOR, shared.listId, { name: 'Desk' })
    await setTagMembers(CURATOR, shared.listId, tag.tagId, [WHALE], [])
    await subscribePublic(READER, shared.listId)
    await setListOrder(READER, [SYSTEM_LIST_ID, shared.listId])

    expect(label(READER, ref(WHALE, SS58))).toBe('🐋 Desk (RLZ)')
  })
})
