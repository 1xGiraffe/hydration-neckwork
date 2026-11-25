import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Pins the deployment's credential and containment rules (AGENTS.md, Dependencies and
// supply chain): no secret on a command line, no default ClickHouse password, an IPFS
// RPC that fails closed, every image pinned by digest, and resource ceilings.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const compose = read('docker-compose.yml')
const opsScripts = readdirSync(new URL('../../ops/', import.meta.url)).filter(f => f.endsWith('.sh'))

const service = (name: string) => {
  const at = compose.indexOf(`\n  ${name}:\n`)
  expect(at, name).toBeGreaterThan(-1)
  const next = compose.slice(at + 1).search(/\n  [a-z][a-z0-9-]*:\n/)
  return compose.slice(at, next < 0 ? undefined : at + 1 + next)
}
// Comment lines may name a flag to explain why it is absent.
const code = (text: string) => text.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')

describe('credentials stay off command lines', () => {
  it('never passes a ClickHouse password as an argument', () => {
    for (const f of opsScripts) expect(code(read(`ops/${f}`)), f).not.toContain('--password')
    expect(code(read('scripts/ingestion-supervisor.sh'))).not.toContain('--password')
    expect(code(compose)).not.toContain('--password')
  })

  it('never passes the IPFS token as a wget/curl header argument', () => {
    for (const f of ['ops/backup-forum-tables.sh', 'ops/forum-reapply-erasures.sh']) {
      const text = code(read(f))
      expect(text, f).not.toMatch(/--header|-H\s/)
      expect(text, f).toContain('WGETRC=')
    }
  })
})

describe('fail-closed defaults', () => {
  it('gives the ClickHouse password no default anywhere', () => {
    expect(compose).not.toMatch(/\$\{CLICKHOUSE_PASSWORD:-[^}]/)
    for (const f of opsScripts) expect(read(`ops/${f}`), f).not.toMatch(/\$\{CLICKHOUSE_PASSWORD:-[^}]/)
    expect(read('scripts/ingestion-supervisor.sh')).not.toMatch(/\$\{CLICKHOUSE_PASSWORD:-[^}]/)
  })

  it('requires only variables the supervisor\'s nested compose carries', () => {
    // The supervisor parses this file with its own environment alone; a `:?` on any
    // other variable would stop every worker it starts.
    const required = new Set([...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map(m => m[1]))
    expect([...required]).toEqual(['CLICKHOUSE_PASSWORD'])
    expect(service('ingestion-supervisor')).toMatch(/- CLICKHOUSE_PASSWORD=\$\{CLICKHOUSE_PASSWORD:\?/)
  })

  it('keeps the IPFS RPC off the network unless every token is set or IPFS_RPC_OPEN=1', () => {
    const init = read('ops/ipfs-init.sh')
    expect(init).toContain('ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001')
    expect(init).toContain('"${IPFS_RPC_OPEN:-}" = "1"')
    expect(service('ipfs')).toContain('http://127.0.0.1:8080/ipfs/bafkqaaa')
  })
})

describe('images and containment', () => {
  it('pins every pulled image and base image by version and digest', () => {
    for (const m of compose.matchAll(/^\s+image: (\S+)/gm)) {
      if (m[1].startsWith('hydration-neckwork-')) continue // built here
      expect(m[1]).toMatch(/:v?\d[^@]*@sha256:[0-9a-f]{64}$/)
    }
    for (const f of ['Dockerfile', 'api/Dockerfile', 'ops/supervisor.Dockerfile', 'clickhouse/Dockerfile', 'public-nginx/Dockerfile', 'explorer-ui/Dockerfile', 'preis-ui/Dockerfile']) {
      for (const m of read(f).matchAll(/^FROM (\S+)/gm)) expect(m[1], f).toMatch(/@sha256:[0-9a-f]{64}$/)
    }
  })

  it('runs the Node images as UID 10001, not the base image\'s user', () => {
    for (const f of ['Dockerfile', 'api/Dockerfile']) expect(read(f), f).toMatch(/^USER 10001:10001$/m)
  })

  it('smoke-tests the api image with production\'s containment', () => {
    const deploy = read('ops/deploy-api.sh')
    expect(deploy).toContain('SMOKE_HARDENING=(--user 10001:10001 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true)')
    expect(deploy).toMatch(/docker run --rm --network none "\$\{SMOKE_HARDENING\[@\]\}"/)
  })

  it('gives every long-running service a memory, swap and pids ceiling', () => {
    const services = ['api', 'api-public', 'api-data', 'api-mcp', 'derivations', 'indexer', 'raw-indexer', 'raw-live',
      'identity-snapshot', 'referendum-proposals', 'balance-snapshot', 'atoken-anchor', 'ingestion-supervisor',
      'smart-contract-verifier', 'user-backup', 'contract-backup', 'forum-backup', 'api-public-nginx', 'preis-ui',
      'explorer-ui', 'governance-content-sync', 'governance-image-fetcher']
    for (const name of services) {
      const block = service(name)
      const mem = /\n {4}mem_limit: (\S+)/.exec(block)?.[1]
      expect(mem, name).toBeDefined()
      expect(block, name).toContain(`memswap_limit: ${mem}`)
      expect(block, name).toMatch(/\n {4}pids_limit: \d+/)
    }
    expect(service('smart-contract-verifier')).toMatch(/\n {4}cpus: \d/)
    expect(service('clickhouse')).toMatch(/\n {4}pids_limit: \d+/)
    expect(service('clickhouse')).toContain('no-new-privileges:true')
  })

  it('mounts a tmpfs over the ClickHouse image\'s data VOLUME in the backup jobs', () => {
    for (const name of ['user-backup', 'contract-backup', 'forum-backup']) {
      expect(service(name), name).toMatch(/- \/var\/lib\/clickhouse:size=/)
    }
  })

  it('serves ClickHouse over its own protocols only', () => {
    const listeners = read('clickhouse/config.d/listeners.xml')
    expect(listeners).toContain('<mysql_port remove="1"/>')
    expect(listeners).toContain('<postgresql_port remove="1"/>')
  })

  it('keeps credentials and deployment files out of the root build context', () => {
    const ignore = read('.dockerignore').split('\n')
    for (const entry of ['.env', '.env.*', 'secrets', 'docker-compose.override.yml']) expect(ignore).toContain(entry)
  })
})
