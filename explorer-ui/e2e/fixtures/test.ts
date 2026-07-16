import { expect, test as base } from '@playwright/test'
import { mockSync } from '../../tests/fixtures/mockApi'

export const test = base.extend<{ mockApi: void }>({
  mockApi: [async ({ page }, use) => {
    // Anchor the matcher at the origin root. A broad `**/api/**` glob also
    // catches Vite source modules such as `/src/api/explorer.ts`.
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      if (route.request().method() !== 'GET') {
        await route.fallback()
        return
      }

      const url = new URL(route.request().url())
      const path = `${url.pathname.replace(/^\/api/, '')}${url.search}`
      const response = mockSync<unknown>(path)
      if (response === undefined) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: `No test fixture for ${path}` }),
        })
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response),
      })
    })
    await use()
  }, { auto: true }],
})

export { expect }
