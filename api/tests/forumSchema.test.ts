import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { splitSqlStatements } from '../src/db/schemaBootstrap.ts'

// The forum tables are public, api/sync-authored and not reproducible from raw: they
// must be backed up by forum-backup (never by the user_* list, whose 004_user.sql is
// what the read-only endpoint's grant script revokes), and the IPFS node that holds
// their images must stay off the host and off the shared network.

const root = new URL('../../', import.meta.url)
const read = (p: string) => readFileSync(new URL(p, root), 'utf8')

describe('021_forum.sql', () => {
  const statements = splitSqlStatements(read('clickhouse/schema/021_forum.sql'))
  const tables = statements.map(s => /CREATE TABLE IF NOT EXISTS price_data\.(\w+)/.exec(s)?.[1]).filter((t): t is string => !!t)

  it('declares the forum tables idempotently, every one replace-keyed', () => {
    expect(tables.sort()).toEqual(['forum_comments', 'forum_media', 'forum_media_urls', 'forum_moderation_log', 'forum_posts', 'forum_revisions'])
    for (const s of statements.filter(s => s.includes('CREATE TABLE'))) expect(s).toMatch(/ENGINE = ReplacingMergeTree\(/)
  })

  it('is backed up whole by forum-backup and never listed as private user data', () => {
    const backed = (/^TABLES="([^"]*)"/m.exec(read('ops/backup-forum-tables.sh'))?.[1] ?? '').split(/\s+/).filter(Boolean)
    expect([...backed].sort()).toEqual([...tables].sort())
    const user = read('clickhouse/schema/004_user.sql') + read('ops/backup-user-tables.sh')
    for (const t of tables) expect(user, t).not.toContain(t)
  })
})

describe('the ipfs service', () => {
  const compose = read('docker-compose.yml')
  const block = (name: string) => {
    const at = compose.indexOf(`\n  ${name}:\n`)
    expect(at, name).toBeGreaterThan(-1)
    const next = compose.slice(at + 1).search(/\n  [a-z][a-z0-9-]*:\n/)
    return compose.slice(at, next < 0 ? undefined : at + 1 + next)
  }

  it('is pinned by version and digest, hardened, and publishes no port', () => {
    const ipfs = block('ipfs')
    expect(ipfs).toMatch(/image: ipfs\/kubo:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}/)
    expect(ipfs).toContain('read_only: true')
    expect(ipfs).toContain('cap_drop: [ALL]')
    expect(ipfs).toContain('no-new-privileges:true')
    expect(ipfs).not.toMatch(/\n    ports:/)
    expect(ipfs).not.toContain('- neckwork\n')
  })

  it('keeps the node\'s RPC on an internal network the api, the sync and the backup alone join', () => {
    expect(compose).toMatch(/ipfs-internal:\n    name: hydration-neckwork-ipfs-internal\n    driver: bridge\n    internal: true/)
    const joined = [...compose.matchAll(/\n  ([a-z][a-z0-9-]*):\n(?:(?!\n  [a-z]).)*?- ipfs-internal/gs)].map(m => m[1])
    expect(joined.sort()).toEqual(['api', 'forum-backup', 'governance-content-sync', 'ipfs'])
  })

  it('configures a node that serves only what it pins and relays nothing', () => {
    const init = read('ops/ipfs-init.sh')
    expect(init).toContain('Gateway.NoFetch true')
    expect(init).toContain("Swarm.RelayService '{\"Enabled\":false}'")
    expect(init).toContain('AutoNAT.ServiceMode disabled')
    expect(init).toContain('IPFS_ANNOUNCE')
  })
})
