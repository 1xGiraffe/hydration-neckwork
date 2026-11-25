import type { Route } from '@playwright/test'
import { expect, test } from './fixtures/test'

// The device-link page names the account a code signs into before the reader can
// claim it: a link to this page can come from anyone, and claiming a stranger's
// code signs the reader's browser into the stranger's account.

const CODE = 'ab'.repeat(32)
const TARGET = '7KTFfPoa44KxwZsa5N3syqxoSPddApcioLEMUEjYY8cohVos'
const account = { accountId: TARGET, address: TARGET, emoji: '🦊', tag: null, identity: null, profile: null }

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

test('names the account before the claim, and claims only on the tap', async ({ page }) => {
  const calls: string[] = []
  await page.route(/^https?:\/\/[^/]+\/api\/user\/auth\/device-link\/(preview|claim)$/, async route => {
    const path = new URL(route.request().url()).pathname
    calls.push(path)
    expect((route.request().postDataJSON() as { code: string }).code).toBe(CODE)
    if (path.endsWith('/preview')) return json(route, 200, { account })
    return json(route, 200, { token: 'phone-token', me: { account, apiAdmin: false, profile: null, lists: [], subscriptions: [], invites: [], order: [] } })
  })
  await page.goto(`/link-device#${CODE}`)

  await expect(page.getByText('This signs this browser in as')).toBeVisible()
  await expect(page.locator('.link-device-target-addr')).toHaveText(TARGET)
  await expect(page.getByText(/Continue only if this is your own account/)).toBeVisible()
  // the fragment is scrubbed, and nothing was claimed by opening the page (the
  // preview may run more than once — it never consumes the code)
  expect(new URL(page.url()).hash).toBe('')
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.every(p => p === '/api/user/auth/device-link/preview')).toBe(true)

  await page.getByRole('button', { name: 'Sign in on this device' }).click()
  await expect(page).toHaveURL(/\/$/)
  expect(calls.filter(p => p === '/api/user/auth/device-link/claim')).toHaveLength(1)
  expect(calls.at(-1)).toBe('/api/user/auth/device-link/claim')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('explorer-session') ?? 'null')?.token)).toBe('phone-token')
})

test('an expired or used code cannot be claimed', async ({ page }) => {
  const calls: string[] = []
  await page.route(/^https?:\/\/[^/]+\/api\/user\/auth\/device-link\/(preview|claim)$/, async route => {
    calls.push(new URL(route.request().url()).pathname)
    return json(route, 401, { error: 'This code has expired or was already used' })
  })
  await page.goto(`/link-device#${CODE}`)

  await expect(page.getByText(/This code has expired or was already used/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in on this device' })).toBeDisabled()
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.every(p => p === '/api/user/auth/device-link/preview')).toBe(true)
})
