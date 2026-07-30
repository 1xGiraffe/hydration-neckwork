import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const supervisorUrl = new URL('../../scripts/ingestion-supervisor.sh', import.meta.url)
const supervisorPath = fileURLToPath(supervisorUrl)
const supervisorScript = readFileSync(supervisorUrl, 'utf8')
const composeFile = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8')

describe('ingestion supervisor', () => {
  it('has valid Bash syntax', () => {
    const result = spawnSync('bash', ['-n', supervisorPath], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
  })

  it('uses the Hydration Neckwork namespace for default runtime resources', () => {
    expect(composeFile).toContain('name: hydration-neckwork')
    expect(composeFile).toContain('container_name: hydration-neckwork-preis-ui')
    expect(composeFile).toContain('container_name: hydration-neckwork-explorer-ui')
    expect(composeFile).toContain('image: hydration-neckwork-indexer:latest')
    expect(composeFile).toContain('hydration-neckwork-clickhouse-data')
    expect(composeFile).toContain('name: hydration-neckwork-network')
    expect(supervisorScript).toContain('hydration-neckwork-raw-backfill-')
    expect(supervisorScript).toContain('hydration-neckwork-main-backfill-')
    expect(supervisorScript).toContain('hydration-neckwork-main-live')
  })
})
