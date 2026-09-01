import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000, expect: { timeout: 8_000 },
  use: { baseURL: 'https://hydration-explorer.neckwork.net' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
