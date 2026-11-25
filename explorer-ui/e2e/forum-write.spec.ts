import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures/test'

// Writing in the forum, end to end in the browser with the api mocked: a reader
// signs in with a wallet already connected for voting (one signed message, from a
// throwaway test signer — nothing is ever submitted to a chain), the composer names
// who they post as, a comment posts and shows up, an image pasted into the editor is
// prepared in the browser, uploaded and inserted as /ipfs/<cid>, the preview renders
// through the one renderer (scripts inert), a reader without stake is told why they
// cannot write, and a new discussion publishes and opens.

const ME = '15U8rqSKTZuNz1doFgiaiCzeRTbEpxmHGAPQi1nRc6oamXQV'
const ME_ID = `0x${'c1'.repeat(32)}`
const CID = `b${'afkreia'}${'q'.repeat(52)}`
const ACCOUNT = { accountId: ME_ID, address: ME, emoji: null, emojiName: null, emojiUrl: null, tag: null, identity: { display: 'Forum Tester' }, profile: null }

const POST = {
  postId: 's9', kind: 'discussion', title: 'Fund the HOLLAR audit', body: 'Should we **fund** it?', bodyFormat: 'markdown', tldr: '', labels: ['Treasury'], linked: [],
  author: { account: { ...ACCOUNT, accountId: `0x${'d2'.repeat(32)}`, identity: { display: 'Author' } }, legacyName: null }, authority: 'subsquare', revision: 0,
  createdAt: '2026-11-01T10:00:00.000Z', editedAt: null, lastActivityAt: '2026-11-01T10:00:00.000Z', commentsCount: 1, updatesCount: 0, upvotes: 2,
  threadKey: 's9', source: { name: 'subsquare', id: 'x', cid: null, removed: false }, bannerCid: null, poll: null,
  media: {}, locked: false, hidden: false, generation: 'g1',
}
const IMPORTED = {
  commentId: 's65a1', parentId: null, replyToId: null, author: { account: null, legacyName: 'oldtimer' }, body: 'Imported comment', bodyFormat: 'markdown',
  hidden: false, hiddenReason: null, deleted: false, createdAt: '2026-11-01T11:00:00.000Z', editedAt: null, revision: 0, upvotes: 0,
  source: { name: 'subsquare', id: '65a1', cid: null, height: null }, position: null, media: {}, replies: [],
}

interface Mock { posted: Array<Record<string, unknown>>; uploads: number; signed: string[]; me: Record<string, unknown>; discussions: Array<Record<string, unknown>> }

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

async function setup(page: Page, opts: { canComment?: boolean; canPost?: boolean; signedIn?: boolean } = {}): Promise<Mock> {
  const m: Mock = {
    posted: [], uploads: 0, signed: [], discussions: [],
    me: {
      account: ACCOUNT, canPost: opts.canPost ?? opts.canComment ?? true, canComment: opts.canComment ?? true, moderator: false, linksUnlimited: false, mutedUntil: null,
      facts: { hdx: opts.canComment === false ? '400000000000' : opts.canPost === false ? '5000000000000' : '500000000000000', identity: false, voted: false },
      thresholds: { commentHdx: 1, postHdx: 100 },
      gate: opts.canComment === false ? { reason: 'no-stake-comment', detail: 'To comment, an account needs at least 1 HDX, a verified on-chain identity, or a vote on any referendum.' } : null,
      topics: ['Treasury', 'Protocol', 'Community'],
      limits: { titleChars: 160, postBodyChars: 50000, commentBodyChars: 10000, labelsPerPost: 3, mentionsPerItem: 10, reportNoteChars: 500, linksPerBody: 20, discussionsPerHour: 3, commentsPerMinute: 10 },
      upload: { usedBytes: 0, maxBytes: 209715200, maxFileBytes: 5242880 }, ready: true,
    },
  }
  await page.routeWebSocket(/hydration-rpc\.neckwork\.net/, ws => ws.close())
  await page.route(/hydration-rpc\.neckwork\.net/, route => route.abort())
  await page.route(/\/api\/explorer\/forum\/post\/s9(\?|$)/, route => json(route, POST))
  await page.route(/\/api\/explorer\/forum\/discussions(\?|$)/, route => json(route, { generation: 'g1', total: 0, rows: [], nextCursor: null }))
  await page.route(/\/api\/explorer\/forum\/labels(\?|$)/, route => json(route, { labels: [] }))
  // The governance overview's counts bound which `#N` in native text is a referendum.
  await page.route(/\/api\/explorer\/governance(\?|$)/, route => json(route, { active: [], discussions: [], counts: { opengov: 460, democracy: 208, tcMotions: 0, councilMotions: 0, tips: 0 } }))
  await page.route(/\/api\/explorer\/forum\/post\/(\d+)(\?|$)/, route => {
    const id = /post\/(\d+)/.exec(route.request().url())![1]
    const d = m.discussions.find(x => x.postId === id)
    return d ? json(route, d) : json(route, { error: 'Post not found' }, 404)
  })
  await page.route(/\/api\/explorer\/forum\/thread\/(s9|\d+)(\?|$)/, route => json(route, {
    requested: 's9', threadKey: 's9', generation: 'g1', total: 1 + m.posted.length, rows: [IMPORTED, ...m.posted], updates: [], nextCursor: null, positionsComplete: null, locked: false,
  }))
  await page.route(/\/ipfs\//, route => route.fulfill({ status: 200, contentType: 'image/webp', body: Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64') }))
  await page.route(/^https?:\/\/[^/]+\/api\/user\//, async route => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname.replace(/^\/api/, '')
    if (path === '/user/auth/challenge') return json(route, { nonce: 'n'.repeat(32), message: `hydration-explorer.neckwork.net wants you to sign in\n\nPurpose: sign in to the Hydration Explorer\nAddress: ${ME}\nNonce: ${'n'.repeat(32)}\nExpires At: 2026-11-08T12:00:00.000Z` })
    if (path === '/user/auth/verify') return json(route, { token: 'forum-e2e-token', me: { account: ACCOUNT, apiAdmin: false, profile: null, lists: [], subscriptions: [], invites: [], order: [] } })
    if (!req.headers().authorization) return json(route, { error: 'Not logged in' }, 401)
    if (path === '/user/forum/me') return json(route, m.me)
    if (path === '/user/forum/reactions' && req.method() === 'GET') return json(route, { mine: [] })
    if (path.startsWith('/user/forum/permissions/')) return json(route, { edit: false, delete: false, update: false, comment: true, reason: null })
    if (path === '/user/forum/comments' && req.method() === 'POST') {
      const body = req.postDataJSON() as { body: string; threadKey: string }
      const c = { ...IMPORTED, commentId: `c01JCZ${String(m.posted.length).padStart(20, '0')}`, author: { account: ACCOUNT, legacyName: null }, body: body.body, source: null, createdAt: new Date().toISOString() }
      m.posted.push(c)
      return json(route, { comment: c, generation: `g${m.posted.length + 1}` })
    }
    if (path === '/user/forum/media' && req.method() === 'POST') {
      m.uploads++
      expect(req.headers()['content-type']).toBe('application/octet-stream')
      return json(route, { cid: CID, url: `/ipfs/${CID}`, mime: 'image/webp', bytes: 1234, width: 4, height: 4 })
    }
    if (path === '/user/forum/discussions' && req.method() === 'POST') {
      const body = req.postDataJSON() as { title: string; body: string; labels: string[] }
      const post = { ...POST, postId: '1', title: body.title, body: body.body, labels: body.labels, source: null, author: { account: ACCOUNT, legacyName: null }, upvotes: 0, commentsCount: 0, threadKey: '1' }
      m.discussions.push(post)
      return json(route, { post, generation: 'g9' })
    }
    if (path === '/user/me') return json(route, { account: ACCOUNT, apiAdmin: false, profile: null, lists: [], subscriptions: [], invites: [], order: [] })
    return route.fallback()
  })
  await page.addInitScript(([address, signedIn]) => {
    const w = window as unknown as { __signed: string[]; injectedWeb3: unknown }
    w.__signed = []
    // A throwaway signer: it records the statement and returns a fixed signature (the api is mocked).
    w.injectedWeb3 = {
      talisman: {
        enable: async () => ({
          accounts: { get: async () => [{ address, name: 'Tester', type: 'sr25519' }] },
          signer: {
            signRaw: async (p: { data: string }) => { w.__signed.push(p.data); return { id: 1, signature: `0x${'ab'.repeat(64)}` } },
            signPayload: async () => { throw new Error('Rejected') },
          },
        }),
      },
    }
    const entry = { id: 'substrate:talisman', kind: 'substrate', key: 'talisman', name: 'Talisman', icon: '' }
    localStorage.setItem('explorer-chain-wallets', JSON.stringify({ wallets: [{ entry, accounts: [{ id: `substrate:talisman|${address}`, walletId: 'substrate:talisman', walletName: 'Talisman', walletIcon: '', kind: 'substrate', address, name: 'Tester' }] }] }))
    if (signedIn) localStorage.setItem('explorer-session', JSON.stringify({ token: 'forum-e2e-token', accountId: `0x${'c1'.repeat(32)}`, address }))
  }, [ME, !!opts.signedIn] as [string, boolean])
  return m
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('sign in with the connected wallet, then comment; imported and native comments share the thread', async ({ page }) => {
      const m = await setup(page)
      await page.goto('/discussions/s9')
      // An imported comment reads like a native one: the page names no source.
      await expect(page.locator('.cmt').filter({ hasText: 'Imported comment' })).toBeVisible()
      await expect(page.locator('.cmt').filter({ hasText: 'Imported comment' })).not.toContainText('Subsquare')
      // The comment box rests as one line; opening it asks a signed-out reader to sign in first.
      await expect(page.getByRole('textbox', { name: 'Write a comment' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /Sign in as Tester/ })).toHaveCount(0)
      await page.getByRole('button', { name: 'Write a comment…' }).click()
      const signIn = page.getByRole('button', { name: /Sign in as Tester/ })
      await expect(signIn).toBeVisible()
      await signIn.click()
      await expect(page.locator('.fc-as')).toContainText('Posting as')
      const signed = await page.evaluate(() => (window as unknown as { __signed: string[] }).__signed)
      expect(signed).toHaveLength(1)
      // signRaw carries the statement as hex bytes: the wallet shows exactly the api's text.
      expect(Buffer.from(signed[0].slice(2), 'hex').toString('utf8')).toContain('Purpose: sign in')
      await page.screenshot({ path: `test-results/shots/forum-compose-${viewport.name}.png`, fullPage: false })

      const box = page.getByRole('textbox', { name: 'Write a comment' })
      await box.fill('I support this — see #450 and ask @' + ME)
      await page.getByRole('button', { name: 'Comment', exact: true }).click()
      await expect(page.locator('.cmt').filter({ hasText: 'I support this' })).toBeVisible()
      expect(m.posted).toHaveLength(1)
      await expect(box).toHaveValue('')
      // The mention and the referendum reference render as links, not as raw text.
      const mine = page.locator('.cmt').filter({ hasText: 'I support this' })
      await expect(mine.locator('a[href="/referendum/opengov/450"]')).toBeVisible()
      await page.screenshot({ path: `test-results/shots/forum-thread-${viewport.name}.png`, fullPage: true })
    })

    test('a pasted image uploads, lands as /ipfs/<cid>, and the preview renders it; script stays inert', async ({ page }) => {
      const m = await setup(page, { signedIn: true })
      await page.goto('/discussions/s9')
      await page.getByRole('button', { name: 'Write a comment…' }).click()
      const box = page.getByRole('textbox', { name: 'Write a comment' })
      await expect(box).toBeFocused()
      await box.click()
      await box.fill('Look: <img src=x onerror="window.__xss=1"> [x](javascript:alert(1))\n')
      // A real 4×4 PNG, pasted from the clipboard.
      await box.evaluate(async el => {
        const c = document.createElement('canvas'); c.width = 4; c.height = 4
        const blob: Blob = await new Promise(r => c.toBlob(b => r(b!), 'image/png'))
        const dt = new DataTransfer()
        dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      })
      await expect(box).toHaveValue(new RegExp(`!\\[[^\\]]*\\]\\(/ipfs/${CID}\\)`))
      expect(m.uploads).toBe(1)
      await page.getByRole('tab', { name: 'Preview' }).click()
      const preview = page.locator('.mde-preview, [role="tabpanel"]').filter({ has: page.locator(`img[src="/ipfs/${CID}"]`) })
      await expect(preview.locator(`img[src="/ipfs/${CID}"]`)).toBeVisible()
      expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
      await expect(preview.locator('img[src="x"]')).toHaveCount(0)
      await expect(preview.locator('a[href^="javascript"]')).toHaveCount(0)
      await page.screenshot({ path: `test-results/shots/forum-preview-${viewport.name}.png` })
    })

    test('an account without stake is told why before it types, with its balance, and gated actions are disabled up front', async ({ page }) => {
      await setup(page, { signedIn: true, canComment: false })
      await page.goto('/discussions/s9')
      const note = page.locator('.fc-gate')
      await expect(note).toContainText('Commenting needs at least 1 HDX')
      await expect(note).toContainText('This account holds 0.4 HDX')
      await expect(note).toContainText('add HDX, get your identity verified by a registrar, or vote')
      await expect(page.getByRole('textbox', { name: 'Write a comment' })).toHaveCount(0)
      const imported = page.locator('.cmt').filter({ hasText: 'Imported comment' })
      await expect(imported.locator('.fa-up')).toBeDisabled()
      await expect(imported.locator('.fa-up')).toHaveAttribute('title', /Upvoting needs at least 1 HDX/)
      await expect(imported.getByRole('button', { name: 'Reply' })).toBeDisabled()
      await expect(imported.getByRole('button', { name: 'Report' })).toBeDisabled()
      await expect(imported.getByRole('button', { name: 'Report' })).toHaveAttribute('title', /Reporting needs/)
    })

    test('an account that may comment but not post sees why before clicking Start a discussion', async ({ page }) => {
      await setup(page, { signedIn: true, canPost: false })
      await page.goto('/discussions')
      const start = page.getByRole('button', { name: 'Start a discussion' })
      await expect(start).toBeDisabled()
      await expect(page.locator('#start-gate-note')).toContainText('Starting a discussion needs at least 100 HDX')
      await expect(page.locator('#start-gate-note')).toContainText('holds 5 HDX')
    })

    test('the editor keeps image, mention, help and More in view; More is keyboard operable', async ({ page }) => {
      await setup(page, { signedIn: true })
      await page.goto('/discussions/s9')
      await page.getByRole('button', { name: 'Write a comment…' }).click()
      const editor = page.locator('.mde').first()
      const tools = editor.locator('.mde-tools')
      await expect(tools).toBeVisible()
      for (const name of ['Add an image', 'Mention an account', 'Formatting help', 'Bold (Ctrl+B)']) await expect(tools.getByRole('button', { name, exact: false }).first()).toBeInViewport({ ratio: 1 })
      const fits = await tools.evaluate(el => el.scrollWidth <= el.clientWidth + 1)
      expect(fits).toBe(true)
      const more = tools.getByRole('button', { name: 'More formatting' })
      if (viewport.name === 'phone') {
        await expect(more).toBeVisible()
        await more.focus()
        await page.keyboard.press('ArrowDown')
        const menu = editor.getByRole('menu', { name: 'More formatting' })
        await expect(menu).toBeVisible()
        await expect(menu.getByRole('menuitem', { name: /Heading/ })).toBeFocused()
        await page.keyboard.press('ArrowDown')
        await expect(menu.getByRole('menuitem', { name: /Quote/ })).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(menu).toHaveCount(0)
        await expect(more).toBeFocused()
        await page.screenshot({ path: `test-results/shots/forum-toolbar-phone.png` })
      } else {
        await expect(more).toBeHidden()
        await expect(tools.getByRole('button', { name: 'Heading' })).toBeVisible()
      }
    })

    test('signed out, a new discussion can be drafted and Publish asks to sign in', async ({ page }) => {
      const m = await setup(page)
      await page.goto('/discussions/new')
      await page.getByLabel(/^Title/).fill('Lower the HDX bond discount')
      await page.getByRole('textbox', { name: 'Discussion text' }).fill('The discount is too high.')
      const publish = page.getByRole('button', { name: 'Sign in to publish' })
      await expect(publish).toBeEnabled()
      await publish.click()
      await expect(page.getByRole('group', { name: 'Sign in to publish this discussion' })).toBeVisible()
      // Still on the page with the text kept; nothing was sent.
      await expect(page.getByRole('textbox', { name: 'Discussion text' })).toHaveValue('The discount is too high.')
      expect(m.discussions).toHaveLength(0)
    })

    test('a new discussion publishes and opens', async ({ page }) => {
      const m = await setup(page, { signedIn: true })
      await page.goto('/discussions/new')
      await page.getByLabel(/^Title/).fill('Lower the HDX bond discount')
      await page.getByRole('button', { name: 'Protocol', exact: true }).click()
      await page.getByRole('textbox', { name: 'Discussion text' }).fill('The discount is **too high**; here is why.')
      await page.screenshot({ path: `test-results/shots/forum-new-${viewport.name}.png`, fullPage: true })
      await page.getByRole('button', { name: 'Publish discussion' }).click()
      await expect(page).toHaveURL(/\/discussions\/1$/)
      await expect(page.locator('.page-title')).toContainText('Lower the HDX bond discount')
      expect(m.discussions[0]).toMatchObject({ labels: ['Protocol'] })
    })
  })
}
