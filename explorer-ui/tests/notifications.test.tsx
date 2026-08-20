import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Notifications, ChannelsSection, RulesSection, InboxSection, notificationTab, notificationTabs } from '../src/pages/Notifications'
import { NotificationBell } from '../src/components/NotificationBell'
import { NotifyButton } from '../src/components/NotifyButton'
import { actionOptions, buildRuleParams, seedFromRule } from '../src/components/NewAlertDialog'
import { nameOptionsInPallet, palletOptions } from '../src/components/activityFilters'
import { ACTIVITY_ACTIONS, F, healthFactorDisplay } from '../src/components/ui'
import { optionFromSearchResult, optionFromUserTag, rawAddressOption, targetOptions } from '../src/components/AlertTargetPicker'
import { Security } from '../src/pages/Security'
import { AssetDetail } from '../src/pages/AssetDetail'
import { parseRoute, paths } from '../src/router'
import {
  ACTIVITY_TYPES, ASSET_ALERT_MIN_USD, assetRuleCount, canonicalRuleParams, cooldownLabel,
  deleteRuleConfirmBody, findEquivalentRule,
  HEALTH_FACTOR_MAX, HEALTH_FACTOR_MIN, HEALTH_FACTOR_PRESETS, KIND_LABELS, LARGE_VALUE_MIN_USD,
  NOTIFICATION_KINDS, PRICE_STEP_PCTS, priceAtStep, priceStepLabel, readTarget, REFERENDUM_PHASES,
  REFERENDUM_TRACKS, ruleSubject, ruleTagTarget,
  TC_MOTION_PHASES,
  SAFETY_KINDS, sameRuleParams, suggestPriceDirection, USD_FLOOR_PRESETS, subscribedLabel } from '../src/notificationKinds'
import {
  MOCK_NOTIFICATION_CHANNELS, MOCK_NOTIFICATION_INBOX, MOCK_NOTIFICATION_RULES,
  MOCK_NOTIFICATION_TELEGRAM_BOT, MOCK_NOTIFICATION_UNREAD, MOCK_NOTIFICATION_VAPID_KEY,
  MOCK_NOTIFICATIONS_OVERVIEW, mockSync,
} from './fixtures/mockApi'
import type { AssetDetail as AssetDetailResponse, AssetFilterItem, FilterNames, NotificationRule, SearchResult, SecurityDashboard } from '../src/types'

// No jsdom/@testing-library in this repo's test setup (see tests/render.test.tsx),
// so every render test asserts on the static markup string. Sections take their
// data as props for exactly this reason — the same dependency-injection shape
// TaggedInHint/PublicListsPanel already use — so a logged-in surface is
// renderable without a real session.
function render(node: React.ReactElement, seed?: (qc: QueryClient) => void): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed?.(queryClient)
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

const now = Date.UTC(2026, 6, 15, 12)

describe('notifications route', () => {
  it('parses /notifications and builds its path', () => {
    expect(parseRoute('/notifications')).toEqual({ name: 'notifications' })
    expect(paths.notifications()).toBe('/notifications')
  })

  it('addresses each tab as query state, with the inbox as the bare URL', () => {
    expect(paths.notifications('alerts')).toBe('/notifications?tab=alerts')
    expect(paths.notifications('channels')).toBe('/notifications?tab=channels')
    // A tab is a query parameter, so the route itself is the same page.
    expect(parseRoute('/notifications?tab=alerts')).toEqual({ name: 'notifications' })
  })
})

describe('notifications tabs', () => {
  it('lands on the inbox for a missing, empty or unknown tab', () => {
    expect(notificationTab('')).toBe('inbox')
    expect(notificationTab('inbox')).toBe('inbox')
    expect(notificationTab('nonsense')).toBe('inbox')
    expect(notificationTab('alerts')).toBe('alerts')
    expect(notificationTab('channels')).toBe('channels')
  })

  it('carries the unread count on the inbox tab, in the pill the bell uses', () => {
    const [inbox] = notificationTabs({ unread: 3, ruleCount: 2, channelCount: 1 })
    expect(renderToStaticMarkup(<>{inbox.badge}</>)).toContain('class="invite-badge"')
    expect(renderToStaticMarkup(<>{inbox.badge}</>)).toContain('>3<')
    // Nothing unread is no pill at all, not a zero.
    expect(notificationTabs({ unread: 0, ruleCount: 2, channelCount: 1 })[0].badge).toBeUndefined()
    expect(notificationTabs({ unread: 1204, ruleCount: 0, channelCount: 0 })[0].badge).toBeTruthy()
  })

  it('counts the rules on the alerts tab, and only when there are some', () => {
    expect(notificationTabs({ unread: 0, ruleCount: 4, channelCount: 1 })[1].count).toBe(4)
    expect(notificationTabs({ unread: 0, ruleCount: 0, channelCount: 1 })[1].count).toBeUndefined()
  })

  // Rules with nowhere to deliver still fill the inbox, which is exactly why
  // the state is easy to miss — so the tab that fixes it says something.
  it('marks the channels tab when rules exist but no channel does', () => {
    expect(notificationTabs({ unread: 0, ruleCount: 2, channelCount: 0 })[2].dot).toBe(true)
    expect(notificationTabs({ unread: 0, ruleCount: 2, channelCount: 1 })[2].dot).toBe(false)
    expect(notificationTabs({ unread: 0, ruleCount: 0, channelCount: 0 })[2].dot).toBe(false)
  })
})

describe('Notifications — logged-out teaser', () => {
  // useSession's server snapshot is null, so a plain render of the page IS the
  // logged-out state.
  const html = render(<Notifications />)

  it('sells the feature instead of gating it behind a login wall', () => {
    expect(html).toContain('Get told the moment it happens.')
    // Persona examples, not a list of trigger kinds.
    expect(html).toContain('Warn me before I get liquidated')
    expect(html).toContain('Do not let me miss a referendum')
    expect(html).toContain('Tell me the moment a fuse trips')
    // All three delivery channels are named up front.
    expect(html).toContain('Browser push')
    expect(html).toContain('Telegram')
    expect(html).toContain('Installed app')
  })

  it('offers exactly one call to action and no management surface', () => {
    expect(html).toContain('Log in to set up alerts')
    expect(html).not.toContain('New alert')
    expect(html).not.toContain('Inbox')
    expect(html).not.toContain('Enable push')
  })
})

describe('Notifications — channels', () => {
  const html = render(
    <ChannelsSection
      channels={MOCK_NOTIFICATION_CHANNELS}
      vapidPublicKey={MOCK_NOTIFICATION_VAPID_KEY}
      telegramBot={MOCK_NOTIFICATION_TELEGRAM_BOT}
      onChanged={() => {}}
    />,
  )

  it('describes a channel by what is safe to show, never its credential', () => {
    expect(html).toContain('Chrome on macOS')
    expect(html).toContain('fcm.googleapis.com')
    expect(html).toContain('@hydrationwatcher')
    // The endpoint itself and its keys are server-side only — nothing in the
    // overview carries them, so nothing can leak into the page.
    expect(html).not.toContain(MOCK_NOTIFICATION_VAPID_KEY)
    expect(html).not.toContain('p256dh')
  })

  it('gives every linked channel a test and a removal', () => {
    expect(html.match(/>Test</g)).toHaveLength(2)
    expect(html).toContain('>Remove<')
    expect(html).toContain('>Unlink<')
  })

  it('says so when a channel is not configured on this deployment', () => {
    const unconfigured = render(<ChannelsSection channels={[]} vapidPublicKey="" telegramBot="" onChanged={() => {}} />)
    expect(unconfigured).toContain('Web Push is not configured on this deployment.')
    expect(unconfigured).toContain('Telegram is not configured on this deployment.')
    // No dead buttons for a channel that cannot work.
    expect(unconfigured).not.toContain('Link Telegram')
  })
})

describe('Notifications — rules', () => {
  const html = render(<RulesSection rules={MOCK_NOTIFICATION_RULES} channels={MOCK_NOTIFICATION_CHANNELS} onNew={() => {}} />)

  it('renders each rule with its kind, its own words, and its routing', () => {
    expect(html).toContain('Alerts · 4')
    expect(html).toContain(KIND_LABELS['large-trade'])
    expect(html).toContain(KIND_LABELS.price)
    expect(html).toContain(KIND_LABELS['account-activity'])
    // A named rule shows the name with the server's summary underneath; an
    // unnamed one shows the summary alone.
    expect(html).toContain('Large HDX trades')
    expect(html).toContain('trades over $10k on HDX')
    expect(html).toContain('HDX price above $0.03')
    // Empty channels means every channel, and a named channel renders as a chip.
    expect(html).toContain('All channels')
    expect(html).toContain('@hydrationwatcher')
  })

  it('marks a muted rule and offers the inverse action', () => {
    expect(html).toContain('notif-rule-muted')
    expect(html).toContain('>muted<')
    expect(html).toContain('>Unmute<')
    expect(html).toContain('>Mute<')
    expect(html.match(/>Delete</g)).toHaveLength(4)
  })

  it('draws a tag target as the tag, and leads to it', () => {
    // The rule watches the TAG, so the row shows the tag's own icon, colour
    // and member count — never the addresses it happens to hold today.
    expect(html).toContain('href="/tag/kraken"')
    expect(html).toContain('/tag-icons/kraken.jpg')
    expect(html).toContain('color:#7b6cf6')
    expect(html).toContain('·2')
    // An address target says nothing extra here: the summary spells it out.
    expect(html.match(/class="addr-pill"/g)).toHaveLength(1)
  })

  it('points every channel routing at the channels tab', () => {
    expect(html).toContain('href="/notifications?tab=channels"')
  })

  it('states each rule\'s frequency in the shared wording', () => {
    expect(cooldownLabel(0)).toBe('every match')
    expect(cooldownLabel(300)).toBe('5m')
    expect(cooldownLabel(3600)).toBe('1h')
    expect(cooldownLabel(86_400)).toBe('1d')
    expect(html).toContain('every match')
    expect(html).toContain('1h')
  })

  it('invites a first alert rather than showing an empty table', () => {
    const empty = render(<RulesSection rules={[]} channels={[]} onNew={() => {}} />)
    expect(empty).toContain('No alerts yet')
    expect(empty).toContain('New alert')
  })
})

describe('Notifications — inbox', () => {
  const html = render(<InboxSection rows={MOCK_NOTIFICATION_INBOX} unread={MOCK_NOTIFICATION_UNREAD} now={now} />)

  it('renders each notification with its title, body, link and age', () => {
    expect(html).toContain(`Inbox · ${MOCK_NOTIFICATION_UNREAD} unread`)
    expect(html).toContain('Large trade: 4.87M HDX → 106k USDT')
    expect(html).toContain('Now $0.0304, up 4.28% on the day.')
    expect(html).toContain('href="/asset/0"')
    expect(html).toContain('ago')
  })

  it('marks the rows that have not been read yet', () => {
    // Two unread rows carry the marker; the read one does not.
    expect(html.match(/class="notif-unread"/g)).toHaveLength(2)
  })

  it('says nothing has fired rather than showing a blank table, and offers the way out', () => {
    const empty = render(<InboxSection rows={[]} unread={0} now={now} />)
    expect(empty).toContain('Nothing yet')
    // An empty inbox is a missing RULE, so it links to where rules are made.
    expect(empty).toContain('href="/notifications?tab=alerts"')
  })

  // Emptying the history is offered only when there is a history to empty — on an
  // empty inbox the button would be a control that does nothing.
  it('offers "Clear inbox" only while rows exist', () => {
    expect(html).toContain('Clear inbox')
    expect(render(<InboxSection rows={[]} unread={0} now={now} />)).not.toContain('Clear inbox')
  })
})

describe('topbar bell', () => {
  it('carries the unread count in the same pill list invites use', () => {
    const html = renderToStaticMarkup(<NotificationBell unread={MOCK_NOTIFICATIONS_OVERVIEW.unread} />)
    expect(html).toContain('href="/notifications"')
    expect(html).toContain('class="invite-badge"')
    expect(html).toContain('>2<')
    expect(html).toContain('2 unread notifications')
  })

  it('renders logged out (no badge) and still links to the teaser', () => {
    const html = renderToStaticMarkup(<NotificationBell unread={0} />)
    expect(html).toContain('href="/notifications"')
    expect(html).not.toContain('invite-badge')
    expect(html).toContain('aria-label="Notifications"')
  })

  it('caps an unreadable count instead of stretching the pill', () => {
    expect(renderToStaticMarkup(<NotificationBell unread={1204} />)).toContain('>99+<')
  })
})

describe('per-surface subscribe affordances', () => {
  it('offers a safety alert beside the security page\'s latest safety action', () => {
    const html = render(<Security section={null} />, qc =>
      qc.setQueryData(['security-dashboard'], mockSync<SecurityDashboard>('/explorer/security')))
    expect(html).toContain('Latest safety action')
    expect(html).toContain('Get notified')
    expect(html).toContain('Alert me on every circuit breaker, pause, freeze and lockdown')
  })

  it('offers three prefilled alerts in the asset header', () => {
    const html = render(<AssetDetail assetId={0} />, qc =>
      qc.setQueryData(['asset', 0], mockSync<AssetDetailResponse>('/explorer/asset/0')))
    expect(html).toContain('Price alert')
    expect(html).toContain('Trade alert')
    expect(html).toContain('Transfer alert')
    // Each says what it will prefill: the price the page is already showing, and
    // the shared $10k floor for both value feeds — on the app's own number scale.
    expect(html).toContain('Alert me when HDX crosses a price — now $0.0218')
    expect(html).toContain('Alert me on HDX trades over $10k')
    expect(html).toContain('Alert me on HDX transfers over $10k')
    // No exact-parameters toggle on this surface: a click opens the dialog, so
    // nothing here can read as already-subscribed on its own.
    expect(html).not.toContain('Alerting')
    expect(html).not.toContain('✓')
  })

  it('asks a logged-out visitor to log in rather than dead-ending', () => {
    const html = render(<NotifyButton rule={{ kind: 'safety', params: {} }} />)
    expect(html).toContain('Get notified')
    expect(html).toContain('Log in to get alerts for this')
  })
})

/* ── the asset header's three prefilled alerts ───────────────────────────── */

// This surface counts subscriptions instead of toggling one exact rule: two
// price alerts at different levels on the same token are both legitimate, so
// "you are already watching this" is a number, not a checkmark.
describe('assetRuleCount', () => {
  const rule = (kind: NotificationRule['kind'], params: Record<string, unknown>): NotificationRule =>
    ({ ...MOCK_NOTIFICATION_RULES[0], kind, params })

  it('counts every threshold of that kind on that token', () => {
    const rules = [
      rule('price', { assetId: 0, direction: 'above', price: 0.03 }),
      rule('price', { assetId: 0, direction: 'below', price: 0.01 }),
      rule('price', { assetId: 5, direction: 'above', price: 6 }),
      rule('large-trade', { assetId: 0, minUsd: 10_000 }),
    ]
    expect(assetRuleCount(rules, 'price', 0)).toBe(2)
    expect(assetRuleCount(rules, 'price', 5)).toBe(1)
    expect(assetRuleCount(rules, 'large-trade', 0)).toBe(1)
    expect(assetRuleCount(rules, 'large-transfer', 0)).toBe(0)
    expect(assetRuleCount([], 'price', 0)).toBe(0)
  })

  it('ignores a chain-wide rule, and never reads a missing token as HDX', () => {
    // A floor with no token watches every token — it is not an alert about this
    // asset, and `Number(undefined)`/`Number(null)` must not land on asset 0.
    const rules = [
      rule('large-trade', { minUsd: 10_000 }),
      rule('large-trade', { minUsd: 10_000, assetId: null }),
      rule('large-trade', { minUsd: 10_000, assetId: '' }),
    ]
    expect(assetRuleCount(rules, 'large-trade', 0)).toBe(0)
    // An id that travelled as a string is the same token.
    expect(assetRuleCount([rule('large-trade', { minUsd: 10_000, assetId: '0' })], 'large-trade', 0)).toBe(1)
  })
})

describe('the preset alert dialog', () => {
  const dialog = readFileSync(new URL('../src/components/NewAlertDialog.tsx', import.meta.url), 'utf8')
  const assetPage = readFileSync(new URL('../src/pages/AssetDetail.tsx', import.meta.url), 'utf8')

  // With a preset the dialog is the answer to one specific button, so what the
  // surface already decided is shown rather than offered: no kind picker, the
  // token as a fixed chip, and a title naming the intent and the token.
  it('hides what the surface already decided', () => {
    expect(dialog).toContain('{!preset && !editRule && (')
    expect(dialog).toContain('`${intent} · ${lockAsset.symbol}`')
    expect(dialog).toContain('className="notif-chip alert-locked-token"')
    expect(dialog).toContain("preset ? 'Save alert' : 'Create alert'")
  })

  // Every threshold the asset page prefills is one of the chip values under the
  // field, so the prefill reads as pressed rather than as a value the chips
  // disagree with.
  it('opens the value-floor fields on a floor the chips agree with', () => {
    expect(ASSET_ALERT_MIN_USD).toBe(10_000)
    expect(USD_FLOOR_PRESETS.map(p => p.value)).toContain(ASSET_ALERT_MIN_USD)
    expect(assetPage).toContain('params: { minUsd: ASSET_ALERT_MIN_USD }')
  })

  // The exact price, never the rounded display value: the chips and "Use current"
  // both fill the number the page holds.
  it('seeds the price form from the live price, exactly', () => {
    expect(assetPage).toContain('params: { price: asset.price, direction: \'above\' }')
    expect(dialog).toContain('price: String(stepped)')
    expect(dialog).toContain("direction: pct < 0 ? 'below' : 'above'")
    // Measured from the live price, not from the field — no compounding.
    expect(dialog).toContain('priceAtStep(currentPrice, pct)')
  })

  // A duplicate is not a failure: the create is idempotent, so the dialog says so
  // where it stands instead of raising an error.
  it('reports an idempotent create as a note rather than an error', () => {
    expect(dialog).toContain('if (result?.existing) setExistingNote(true)')
    expect(dialog).toContain('className="dialog-note"')
    expect(assetPage).toContain('if (created.existing) return { existing: true }')
  })

  // Logged out the buttons still open the dialog and Save still means something:
  // the built rule is parked and the login takes over.
  it('parks a logged-out save instead of dead-ending', () => {
    expect(assetPage).toContain('stashPendingNotification(')
    expect(assetPage).toContain('requestConnect()')
    expect(assetPage).toContain("submitLabel={session ? undefined : 'Log in to save this alert'}")
  })
})

/* ── account-activity targets ─────────────────────────────────────────── */

const FOX_ADDRESS = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'
const EVM_ADDRESS = '0xAbC0000000000000000000000000000000000001'

describe('notification targets', () => {
  it('reads all three target shapes, and the legacy flat address', () => {
    expect(readTarget({ target: { kind: 'address', address: FOX_ADDRESS } })).toEqual({ kind: 'address', address: FOX_ADDRESS })
    expect(readTarget({ target: { kind: 'tag', tagId: 'kraken' } })).toEqual({ kind: 'tag', tagId: 'kraken' })
    expect(readTarget({ target: { kind: 'list-tag', listId: 'personal', tagId: 't1' } }))
      .toEqual({ kind: 'list-tag', listId: 'personal', tagId: 't1' })
    // Rules written before targets existed still have to render and compare.
    expect(readTarget({ address: FOX_ADDRESS, minUsd: 50_000 })).toEqual({ kind: 'address', address: FOX_ADDRESS })
    expect(readTarget({})).toBeNull()
    expect(readTarget({ target: { kind: 'list-tag', tagId: 't1' } })).toBeNull()
  })

  it('names only a tag target as one the rules table draws as a pill', () => {
    expect(ruleTagTarget({ kind: 'account-activity', params: { target: { kind: 'tag', tagId: 'kraken' } } }))
      .toEqual({ kind: 'tag', tagId: 'kraken' })
    expect(ruleTagTarget({ kind: 'account-activity', params: { address: FOX_ADDRESS } })).toBeNull()
    expect(ruleTagTarget({ kind: 'price', params: { assetId: 0 } })).toBeNull()
  })
})

describe('rule parameter equivalence', () => {
  it('treats the legacy address and its target form as the same subscription', () => {
    expect(sameRuleParams('account-activity', { address: FOX_ADDRESS }, { target: { kind: 'address', address: FOX_ADDRESS } })).toBe(true)
  })

  it('ignores key order, absent-vs-empty, and a number that travelled as a string', () => {
    expect(sameRuleParams('price', { assetId: 0, direction: 'above', price: 0.03 }, { price: 0.03, direction: 'above', assetId: 0 })).toBe(true)
    expect(sameRuleParams('referendum', {}, { phases: [] })).toBe(true)
    expect(sameRuleParams('referendum', { track: '5' }, { track: 5 })).toBe(true)
    expect(sameRuleParams('safety', { kinds: ['pause', 'freeze'] }, { kinds: ['freeze', 'pause'] })).toBe(true)
    expect(sameRuleParams('tc-motion', {}, { phases: [] })).toBe(true)
    expect(sameRuleParams('tc-motion', { phases: ['voted', 'approved'] }, { phases: ['approved', 'voted'] })).toBe(true)
    // 'all' is what omitting the category means; a zero floor is no floor.
    expect(sameRuleParams('account-activity', { address: FOX_ADDRESS, type: 'all', minUsd: 0 }, { address: FOX_ADDRESS })).toBe(true)
    // zod's own default, restated by the form: an omitted threshold IS 1.1.
    expect(sameRuleParams('health-factor', { address: FOX_ADDRESS }, { address: FOX_ADDRESS, threshold: 1.1 })).toBe(true)
    // A pallet/call name is matched case-insensitively by the evaluator.
    expect(sameRuleParams('extrinsic', { section: 'Omnipool', method: 'sell' }, { section: 'omnipool', method: 'SELL' })).toBe(true)
    // Hex is not case-significant; base58 is.
    expect(sameRuleParams('account-activity', { address: EVM_ADDRESS }, { address: EVM_ADDRESS.toLowerCase() })).toBe(true)
  })

  it('keeps genuinely different subscriptions apart', () => {
    expect(sameRuleParams('account-activity', { address: FOX_ADDRESS }, { address: FOX_ADDRESS, minUsd: 50_000 })).toBe(false)
    expect(sameRuleParams('account-activity', { target: { kind: 'tag', tagId: 'kraken' } }, { target: { kind: 'tag', tagId: 'treasury' } })).toBe(false)
    // A system tag and a list tag of the same id are different targets.
    expect(sameRuleParams('account-activity', { target: { kind: 'tag', tagId: 't1' } }, { target: { kind: 'list-tag', listId: 'personal', tagId: 't1' } })).toBe(false)
    // A falsy value that MEANS something is not an absent one.
    expect(sameRuleParams('extrinsic', { section: 'Omnipool', success: false }, { section: 'Omnipool' })).toBe(false)
    expect(sameRuleParams('large-trade', { minUsd: 10_000, assetId: 0 }, { minUsd: 10_000 })).toBe(false)
    expect(canonicalRuleParams('price', { assetId: 0, direction: 'above', price: 0.03 }))
      .not.toBe(canonicalRuleParams('price', { assetId: 0, direction: 'below', price: 0.03 }))
  })

  it('finds the rule a subscribe button is really asking about', () => {
    const rules = MOCK_NOTIFICATION_RULES as NotificationRule[]
    // The whale rule, expressed as the asset page's own button expresses it.
    expect(findEquivalentRule(rules, { kind: 'large-trade', params: { assetId: 0, minUsd: 10_000 } })?.id).toBe('rule-whale')
    // The legacy-shaped account rule, asked about in target form.
    expect(findEquivalentRule(rules, {
      kind: 'account-activity',
      params: { target: { kind: 'address', address: MOCK_NOTIFICATION_RULES[2].params.address as string }, minUsd: 50_000 },
    })?.id).toBe('rule-owl-activity')
    expect(findEquivalentRule(rules, { kind: 'account-activity', params: { target: { kind: 'tag', tagId: 'kraken' } } })?.id).toBe('rule-tag-activity')
    // A rule's name, channels, cooldown and mute state are how its owner
    // manages it, never what it subscribes to.
    expect(findEquivalentRule(rules, { kind: 'large-trade', params: { assetId: 0, minUsd: 25_000 } })).toBeUndefined()
    expect(findEquivalentRule(rules, { kind: 'safety', params: {} })).toBeUndefined()
  })
})

describe('alert target picker', () => {
  const addressHit: SearchResult = {
    type: 'address', value: '0x' + '11'.repeat(32), label: FOX_ADDRESS, emoji: '🦊',
    identity: { display: 'Fox', verified: true, judgements: [] },
  }
  const tagHit: SearchResult = { type: 'tag', value: 'kraken', label: 'Kraken', icon: '/tag-icons/kraken.jpg', color: '#7b6cf6' }

  it('turns an address hit into an address target, keeping the SS58 not the public key', () => {
    const option = optionFromSearchResult(addressHit)!
    expect(option.target).toEqual({ kind: 'address', address: FOX_ADDRESS })
    expect(option.accountId).toBe(addressHit.value)
    expect(option.identity).toBe('Fox')
  })

  it('turns a system tag hit into a tag target and a list tag into a list-tag target', () => {
    expect(optionFromSearchResult(tagHit)!.target).toEqual({ kind: 'tag', tagId: 'kraken' })
    const own = optionFromUserTag({ listId: 'personal', listName: 'My list', tagId: 't1', name: 'Watching', color: '#f97316', icon: '👀' })
    expect(own.target).toEqual({ kind: 'list-tag', listId: 'personal', tagId: 't1' })
    expect(own.listName).toBe('My list')
  })

  it('keeps only accounts and tags, with the viewer\'s own tags first', () => {
    const noise: SearchResult[] = [
      { type: 'block', value: '12848601' },
      addressHit,
      { type: 'asset', value: '0', label: 'HDX' },
      tagHit,
      { type: 'referendum', value: 'opengov:263', pallet: 'opengov', index: 263 },
    ]
    const options = targetOptions(noise, [{ listId: 'personal', listName: 'My list', tagId: 't1', name: 'Watching', color: '#f97316', icon: '👀' }])
    // A private tag name the shared, anonymous search can never know leads.
    expect(options.map(o => o.key)).toEqual(['list-tag:personal:t1', `address:${FOX_ADDRESS.toLowerCase()}`, 'tag:kraken'])
  })

  it('accepts a pasted address the search has never seen, and nothing else', () => {
    expect(rawAddressOption(FOX_ADDRESS)?.target).toEqual({ kind: 'address', address: FOX_ADDRESS })
    expect(rawAddressOption(` ${EVM_ADDRESS} `)?.target).toEqual({ kind: 'address', address: EVM_ADDRESS })
    expect(rawAddressOption('treasury')).toBeNull()
  })
})

describe('buildRuleParams — account-activity targets', () => {
  const sets = { phases: [], motionPhases: [], safetyKinds: [] }

  it('writes the picker\'s selection as the matching target variant', () => {
    expect(buildRuleParams('account-activity', {}, { ...sets, target: { kind: 'address', address: FOX_ADDRESS } }))
      .toEqual({ ok: true, params: { target: { kind: 'address', address: FOX_ADDRESS } } })
    expect(buildRuleParams('account-activity', {}, { ...sets, target: { kind: 'tag', tagId: 'kraken' } }))
      .toEqual({ ok: true, params: { target: { kind: 'tag', tagId: 'kraken' } } })
    expect(buildRuleParams('account-activity', { type: 'transfer', minUsd: '50000' }, { ...sets, target: { kind: 'list-tag', listId: 'personal', tagId: 't1' } }))
      .toEqual({ ok: true, params: { target: { kind: 'list-tag', listId: 'personal', tagId: 't1' }, type: 'transfer', minUsd: 50_000 } })
  })

  it('accepts a raw address left in the box, and refuses anything else', () => {
    expect(buildRuleParams('account-activity', { address: FOX_ADDRESS }, sets))
      .toEqual({ ok: true, params: { target: { kind: 'address', address: FOX_ADDRESS } } })
    const bad = buildRuleParams('account-activity', { address: 'not-an-address' }, sets)
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.error).toContain('Pick an account or tag')
  })

  it('leaves the other kinds\' parameters exactly as they were', () => {
    expect(buildRuleParams('price', { assetId: '0', price: '0.03', direction: 'below' }, sets))
      .toEqual({ ok: true, params: { assetId: 0, direction: 'below', price: 0.03 } })
  })

  // Health factor takes the same target union as account-activity: the picker's
  // pick wins, pasted-but-never-picked text still counts, and a tag watches
  // every member's position.
  it('builds a health-factor rule from the picker, the pasted text, or a tag', () => {
    expect(buildRuleParams('health-factor', { address: FOX_ADDRESS }, sets))
      .toEqual({ ok: true, params: { target: { kind: 'address', address: FOX_ADDRESS }, threshold: 1.1 } })
    expect(buildRuleParams('health-factor', { threshold: '1.6' }, { ...sets, target: { kind: 'tag', tagId: 'treasury' } }))
      .toEqual({ ok: true, params: { target: { kind: 'tag', tagId: 'treasury' }, threshold: 1.6 } })
    expect(buildRuleParams('health-factor', {}, sets).ok).toBe(false)
  })

  // A stored legacy `{ address }` health-factor rule and the fresh target form
  // must compare as the same subscription.
  it('treats the legacy health-factor address form as the same rule as its target form', () => {
    expect(sameRuleParams('health-factor',
      { address: FOX_ADDRESS, threshold: 1.1 },
      { target: { kind: 'address', address: FOX_ADDRESS }, threshold: 1.1 })).toBe(true)
  })

  // The signer field is the account typeahead too, and picking a row EMPTIES the
  // text box by design — so the picked account has to outrank whatever text is
  // left behind, exactly as the account-activity target does.
  it('takes an extrinsic signer from the picker over the text left in the box', () => {
    expect(buildRuleParams('extrinsic', { section: 'Omnipool' }, { ...sets, signerTarget: { kind: 'address', address: FOX_ADDRESS } }))
      .toEqual({ ok: true, params: { section: 'Omnipool', signer: FOX_ADDRESS } })
    // Typed and never picked still works.
    expect(buildRuleParams('extrinsic', { section: 'Omnipool', signer: EVM_ADDRESS }, sets))
      .toEqual({ ok: true, params: { section: 'Omnipool', signer: EVM_ADDRESS } })
    // And a tag can never reach this parameter (the picker runs address-only).
    const bad = buildRuleParams('extrinsic', { section: 'Omnipool', signer: 'kraken' }, sets)
    expect(bad.ok === false && bad.error).toContain('SS58 or 0x address')
  })
})

// Technical Committee motions are their own kind: the form offers its own phase
// chips, and nothing about a referendum rule can produce one (or the other way
// round), which is what keeps committee traffic opt-in.
describe('buildRuleParams — the two governance kinds stay apart', () => {
  const sets = { phases: [], motionPhases: [], safetyKinds: [] }

  it('writes motion phases only for the motion kind', () => {
    expect(buildRuleParams('tc-motion', {}, sets)).toEqual({ ok: true, params: {} })
    expect(buildRuleParams('tc-motion', {}, { ...sets, motionPhases: ['proposed', 'voted'] }))
      .toEqual({ ok: true, params: { phases: ['proposed', 'voted'] } })
    // A referendum rule built in the same dialog session takes the referendum
    // chips, never the motion ones.
    expect(buildRuleParams('referendum', {}, { ...sets, motionPhases: ['proposed'], phases: ['deciding'] }))
      .toEqual({ ok: true, params: { phases: ['deciding'] } })
    expect(buildRuleParams('tc-motion', {}, { ...sets, phases: ['deciding'], motionPhases: ['closed'] }))
      .toEqual({ ok: true, params: { phases: ['closed'] } })
  })

  it('offers the motion phases in the dialog, under their own label', () => {
    const dialog = readFileSync(new URL('../src/components/NewAlertDialog.tsx', import.meta.url), 'utf8')
    expect(dialog).toContain("kind === 'tc-motion'")
    expect(dialog).toContain('options={TC_MOTION_PHASES}')
    expect(dialog).toContain('label="Motion phases"')
  })
})

/* ── the new-alert form's input assists ──────────────────────────────────── */

describe('the pallet/name pickers', () => {
  it('splits the catalogue into pallets, counted, in name order', () => {
    const pallets = palletOptions(['Omnipool.sell', 'Omnipool.buy', 'Balances.transfer'], 'call')
    expect(pallets.map(p => p.value)).toEqual(['Balances', 'Omnipool'])
    // The count says how much is inside, in the words of what is inside it.
    expect(pallets.map(p => p.sub)).toEqual(['1 call', '2 calls'])
  })

  it('offers only the names inside the chosen pallet, matched case-insensitively', () => {
    const catalogue = ['Omnipool.sell', 'Omnipool.buy', 'Balances.transfer']
    expect(nameOptionsInPallet(catalogue, 'Omnipool').map(o => o.value)).toEqual(['buy', 'sell'])
    // A pallet typed by hand names the same pallet the catalogue capitalises.
    expect(nameOptionsInPallet(catalogue, 'omnipool ').map(o => o.value)).toEqual(['buy', 'sell'])
    // No pallet chosen, or one nothing is indexed under: nothing to offer, and
    // the field stays free text.
    expect(nameOptionsInPallet(catalogue, '')).toEqual([])
    expect(nameOptionsInPallet(catalogue, 'NotAPallet')).toEqual([])
  })

  it('reads the same catalogue for both matcher kinds off the fixture endpoint', () => {
    const names = mockSync<FilterNames>('/explorer/filter-names')!
    expect(palletOptions(names.calls).map(p => p.value)).toContain('Omnipool')
    expect(palletOptions(names.events).map(p => p.value)).toContain('Referenda')
    expect(nameOptionsInPallet(names.events, 'Referenda')).toEqual(
      expect.arrayContaining([{ value: 'Submitted', label: 'Submitted' }]),
    )
  })
})

describe('the form\'s one-click values', () => {
  it('offers USD floors that every value-floor rule accepts', () => {
    expect(USD_FLOOR_PRESETS.map(p => p.label)).toEqual(['$1k', '$10k', '$100k', '$1M'])
    // A chip must never fill in a floor the server would refuse.
    for (const preset of USD_FLOOR_PRESETS) expect(preset.value).toBeGreaterThanOrEqual(LARGE_VALUE_MIN_USD)
  })

  // The presets are the app's OWN health-factor bands, so the numbers a form
  // offers are the numbers the explorer paints red and amber.
  it('offers health-factor thresholds on the explorer\'s own bands', () => {
    expect(HEALTH_FACTOR_PRESETS).toEqual([1.1, 1.3, 1.6])
    const cls = (hf: number) => healthFactorDisplay(String(hf * 1e18)).cls
    expect(cls(1.09)).toBe('hf-bad')      // below the first preset is the red band
    expect(cls(1.1)).toBe('hf-warn')      // …which the first preset is the edge of
    expect(cls(1.3)).toBe('hf-warn')      // the middle of the amber band
    expect(cls(1.59)).toBe('hf-warn')
    expect(cls(1.6)).toBe('hf-ok')        // …whose edge is the last preset
    for (const preset of HEALTH_FACTOR_PRESETS) {
      expect(preset).toBeGreaterThanOrEqual(HEALTH_FACTOR_MIN)
      expect(preset).toBeLessThanOrEqual(HEALTH_FACTOR_MAX)
    }
  })

  // A price alert usually means "tell me if it moves this far", which is a
  // percentage of the CURRENT price rather than an absolute number anybody wants
  // to work out by hand.
  it('steps a price threshold by percentages of the live price, without compounding', () => {
    expect(PRICE_STEP_PCTS).toEqual([-10, -5, 5, 10])
    expect(PRICE_STEP_PCTS.map(priceStepLabel)).toEqual(['−10%', '−5%', '+5%', '+10%'])
    // Exact, not rounded — what a chip fills in is what the rule watches.
    expect(priceAtStep(0.02184, -5)).toBeCloseTo(0.020748, 12)
    expect(priceAtStep(0.02184, 10)).toBeCloseTo(0.024024, 12)
    // Every step is measured from the same live price, so two taps in a row land
    // on the second step's value rather than on a compounded one.
    expect(priceAtStep(priceAtStep(100, -10), -10)).toBe(81)
    expect(priceAtStep(100, -10)).toBe(90)
    // The sign IS the direction: a lower threshold can only be crossed falling.
    for (const pct of PRICE_STEP_PCTS) {
      expect(suggestPriceDirection(priceAtStep(1, pct), 1)).toBe(pct < 0 ? 'below' : 'above')
    }
  })

  it('suggests the direction a price threshold implies', () => {
    // Above the current price can only be reached by rising, below it by falling.
    expect(suggestPriceDirection(0.03, 0.0218)).toBe('above')
    expect(suggestPriceDirection(0.015, 0.0218)).toBe('below')
    // On the nose is "rises above": a crossing has to come from somewhere.
    expect(suggestPriceDirection(0.0218, 0.0218)).toBe('above')
  })

  it('offers exactly the actions the chosen category has, from the shared map', () => {
    expect(actionOptions('mm')).toEqual(ACTIVITY_ACTIONS.mm)
    expect(actionOptions('mm').map(a => a.v)).toContain('Borrow')
    expect(actionOptions('trade').map(a => a.v)).toContain('swap')
    // "Everything", an unknown category and an absent one have nothing to
    // narrow, so the field is absent rather than an empty select.
    expect(actionOptions('all')).toEqual([])
    expect(actionOptions(undefined)).toEqual([])
    expect(actionOptions('transfer')).toEqual([])
    // Every category that HAS actions is a category a rule can carry: an option
    // for a type the feed cannot filter would simply never match.
    for (const type of Object.keys(ACTIVITY_ACTIONS)) expect(ACTIVITY_TYPES).toContain(type)
  })

  // The hint is only worth showing when the price is real; the prefill is the
  // EXACT price, never the rounded display value the hint shows.
  it('reads the picked token\'s price off the filter projection the dialog loads', () => {
    const assets = mockSync<AssetFilterItem[]>('/explorer/assets?fields=filter')!
    const hdx = assets.find(a => a.assetId === 0)!
    expect(hdx.price).toBe(0.02184)
    // The price formatter the asset page's own bell already uses.
    expect(F.priceUsd(hdx.price!)).toBe('$0.0218')
    expect(String(hdx.price)).toBe('0.02184')
  })
})

/* ── confirming what cannot be undone ───────────────────────────────────── */

describe('confirm dialogs', () => {
  const confirmDialog = readFileSync(new URL('../src/components/ConfirmDialog.tsx', import.meta.url), 'utf8')
  const notifyButton = readFileSync(new URL('../src/components/NotifyButton.tsx', import.meta.url), 'utf8')
  const page = readFileSync(new URL('../src/pages/Notifications.tsx', import.meta.url), 'utf8')
  const listDetail = readFileSync(new URL('../src/pages/ListDetail.tsx', import.meta.url), 'utf8')

  it('names the rule the same way wherever it is about to be deleted', () => {
    expect(deleteRuleConfirmBody({ name: 'Large HDX trades', summary: 'trades over $10k on HDX' }))
      .toBe('Delete "Large HDX trades"? It stops alerting immediately.')
    // An unnamed rule is named by the server's summary — the same string, in the
    // same order, the rules table leads with.
    expect(deleteRuleConfirmBody({ name: '', summary: 'HDX price above $0.03' }))
      .toBe('Delete "HDX price above $0.03"? It stops alerting immediately.')
    expect(ruleSubject({})).toBe('this alert')
  })

  // Visual parity with the delete-list dialog this is modelled on, kept as a
  // property rather than a screenshot: same chrome, same danger button, same
  // Cancel, same narrow width.
  it('keeps the delete-list dialog\'s chrome', () => {
    for (const marker of ['className="dialog-overlay"', 'dialog confirm-dialog', "width: 'min(420px, 94vw)'", 'className="dialog-hint"', 'className="dialog-error"', '>Cancel<']) {
      expect(confirmDialog, marker).toContain(marker)
      expect(listDetail.includes(marker) || marker === 'dialog confirm-dialog', marker).toBeTruthy()
    }
    expect(confirmDialog).toContain("`btn${danger ? ' danger' : ' primary'}`")
    // Pending disables both ways out, so a double click cannot fire the write twice.
    expect(confirmDialog.match(/disabled={pending}/g)).toHaveLength(2)
  })

  it('guards every unrevokable notification action, and never with window.confirm', () => {
    // The rules table's Delete, and the toggle-off on every "Alerting ✓" button.
    expect(notifyButton).toContain('<ConfirmDialog')
    expect(notifyButton).toContain('body={deleteRuleConfirmBody(existing)}')
    expect(notifyButton).toContain('if (existing) { setConfirming(true); return }')
    // Rule delete, channel removal/unlink, and clearing the inbox.
    expect(page.match(/<ConfirmDialog/g)).toHaveLength(3)
    expect(page).toContain('body={deleteRuleConfirmBody(confirmRule)}')
    expect(page).toContain('Alerts keep firing; this only empties the history.')
    expect(page).toContain('Unlink Telegram')
    // Muting stays one click: it is reversible.
    expect(page).toContain("update.mutate([rule.id, { muted: !rule.muted }])")
    // Code, not the prose about it (ConfirmDialog's own comment names the thing
    // it exists instead of).
    const code = (source: string) => source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    for (const source of [notifyButton, page, confirmDialog]) expect(code(source)).not.toContain('window.confirm')
  })
})

describe('rule-kind registry mirror', () => {
  it('names every kind the API knows', () => {
    // The UI's copy exists so a form can be built without a round trip; a kind
    // missing a label would render a blank option in the picker. The count is
    // spelled out so adding a kind on one side alone fails here rather than
    // shipping a picker entry with no form behind it.
    expect(NOTIFICATION_KINDS).toHaveLength(12)
    for (const kind of NOTIFICATION_KINDS) expect(KIND_LABELS[kind]).toBeTruthy()
  })

  // The mirror is a copy, so nothing but this test keeps it a copy. A value the
  // server does not know is a rule that can never match; one it knows and the UI
  // does not is a subscription nobody can create.
  it('lists exactly the enumerations the api registry declares', () => {
    const api = readFileSync(new URL('../../api/src/notifications/notificationRules.ts', import.meta.url), 'utf8')
    const literals = (name: string): string[] => {
      const match = api.match(new RegExp(`${name} = \\[([^\\]]*)\\]`))
      expect(match, `${name} is no longer an array literal in notificationRules.ts`).toBeTruthy()
      return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1])
    }
    expect([...NOTIFICATION_KINDS]).toEqual(literals('NOTIFICATION_KINDS'))
    expect([...ACTIVITY_TYPES]).toEqual(literals('ACTIVITY_TYPES'))
    expect([...SAFETY_KINDS]).toEqual(literals('SAFETY_KINDS'))
    expect([...REFERENDUM_PHASES]).toEqual(literals('REFERENDUM_PHASES'))
    expect([...TC_MOTION_PHASES]).toEqual(literals('TC_MOTION_PHASES'))

    // The track table is id → name pairs rather than a flat list.
    const tracks = [...api.matchAll(/\{ id: (\d+), name: '([a-z_]+)' \}/g)].map(m => ({ id: Number(m[1]), name: m[2] }))
    expect(tracks.length).toBeGreaterThan(0)
    expect(REFERENDUM_TRACKS).toEqual(tracks)
  })
})

// The subscribed state must keep the button's subject: two quick-add buttons
// both reading a bare "Alerting" are indistinguishable once clicked.
describe('subscribedLabel', () => {
  it('turns Watch into Watching', () => {
    expect(subscribedLabel('Watch referenda')).toBe('Watching referenda ✓')
    expect(subscribedLabel('Watch TC motions')).toBe('Watching TC motions ✓')
    expect(subscribedLabel('Watch safety actions')).toBe('Watching safety actions ✓')
  })
  it('keeps a specific subject and appends the check', () => {
    expect(subscribedLabel('Price alert')).toBe('Price alert ✓')
    expect(subscribedLabel('Trade alert')).toBe('Trade alert ✓')
  })
  it('collapses only the generic labels, where the page is the subject', () => {
    expect(subscribedLabel('Get notified')).toBe('Alerting ✓')
    expect(subscribedLabel('Notify')).toBe('Alerting ✓')
  })
})

// Editing seeds the form from a rule's SERVER params and submit rebuilds them;
// the round trip must land on the same subscription, or an untouched edit would
// silently rewrite the rule.
describe('edit dialog round trip — seedFromRule ∘ buildRuleParams', () => {
  const rule = (kind: NotificationKind, params: Record<string, unknown>, extra: Partial<NotificationRule> = {}): NotificationRule =>
    ({ id: 'r', kind, kindLabel: '', name: '', summary: '', params, channels: [], muted: false, cooldownS: 0, ...extra })

  const roundTrip = (r: NotificationRule) => {
    const seed = seedFromRule(r)
    const built = buildRuleParams(r.kind, seed.values, {
      phases: seed.phases, motionPhases: seed.motionPhases, safetyKinds: seed.safetyKinds,
      target: seed.target?.target ?? null, signerTarget: seed.signerTarget?.target ?? null,
    })
    expect(built.ok).toBe(true)
    if (built.ok) expect(sameRuleParams(r.kind, r.params, built.params)).toBe(true)
  }

  it('reproduces every kind of rule unchanged', () => {
    roundTrip(rule('price', { assetId: 5, direction: 'below', price: 0.5 }))
    roundTrip(rule('large-trade', { minUsd: 1000, assetId: 0 }))
    roundTrip(rule('large-transfer', { minUsd: 10000 }))
    roundTrip(rule('health-factor', { target: { kind: 'address', address: FOX_ADDRESS }, threshold: 1.6 }))
    roundTrip(rule('health-factor', { target: { kind: 'tag', tagId: 'treasury' }, threshold: 1.1 }, { targetLabel: 'Treasury' }))
    roundTrip(rule('account-activity', { target: { kind: 'tag', tagId: 'kraken' }, type: 'trade', minUsd: 50 }, { targetLabel: 'Kraken' }))
    roundTrip(rule('referendum', { phases: ['submitted', 'confirmed'], track: '5' }))
    roundTrip(rule('tc-motion', { phases: ['proposed'] }))
    roundTrip(rule('extrinsic', { section: 'omnipool', method: 'sell', success: false, signer: FOX_ADDRESS }))
    roundTrip(rule('event', { section: 'referenda', method: 'submitted' }))
  })
})
