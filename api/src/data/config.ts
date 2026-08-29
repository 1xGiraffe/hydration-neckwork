// Data-API-only knobs, kept out of the shared src/config.ts on purpose: the
// data tree is an import leaf (api/tests/data/isolation.test.ts) and nothing
// outside it needs these. Parsed once at import; a bad value fails the boot
// loudly rather than silently running with a default.

function parseCount(value: string | undefined, name: string, fallback: number): number {
  const raw = value?.trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer, received ${JSON.stringify(value)}`)
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} out of range: ${JSON.stringify(value)}`)
  return parsed
}

// Admin wallet accounts (comma-separated 0x-64-hex public keys). Their tokens
// are exempt from rate limits here; the admin ROUTES live on the explorer api.
function parseAdmins(value: string | undefined): Set<string> {
  const out = new Set<string>()
  for (const entry of (value ?? '').split(',')) {
    const trimmed = entry.trim().toLowerCase()
    if (!trimmed) continue
    if (!/^0x[0-9a-f]{64}$/.test(trimmed)) throw new Error(`ADMIN_ACCOUNT_IDS entries must be 0x-prefixed 32-byte hex public keys, received ${JSON.stringify(entry)}`)
    out.add(trimmed)
  }
  return out
}

export const dataConfig = {
  defaultPerMinute: parseCount(process.env.DATA_API_DEFAULT_PER_MINUTE, 'DATA_API_DEFAULT_PER_MINUTE', 30),
  defaultPerDay: parseCount(process.env.DATA_API_DEFAULT_PER_DAY, 'DATA_API_DEFAULT_PER_DAY', 20_000),
  adminAccountIds: parseAdmins(process.env.ADMIN_ACCOUNT_IDS),
  // Where a 401's context points a developer: the docs portal on this host and
  // the explorer's token-management page.
  docsUrl: (process.env.DATA_API_PUBLIC_URL?.trim() || 'https://hydration-data.neckwork.net').replace(/\/$/, '') + '/docs',
  createTokenUrl: (process.env.EXPLORER_PUBLIC_URL?.trim() || 'https://hydration-explorer.neckwork.net').replace(/\/$/, '') + '/api-tokens',
} as const
