import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const supervisorPath = fileURLToPath(new URL('../../scripts/ingestion-supervisor.sh', import.meta.url))

interface Scenario {
  /** last_block, last_hash, age-in-seconds returned for the raw-live checkpoint */
  checkpoint: [number, string, number] | null
  /** block_height -> hash stored in raw_blocks */
  stored: Record<number, string>
  /** block_height -> hash the chain reports; missing means the RPC answers nothing */
  chain: Record<number, string>
  /** make every ClickHouse query fail, as an unreachable database would */
  clickhouseDown?: boolean
  env?: Record<string, string>
}

/**
 * Runs heal_live_raw_reorg against stubbed `docker` and `curl` binaries, so the
 * real ch_query and rpc_block_hash code paths execute. ch_query shells out to
 * `docker compose exec clickhouse clickhouse-client`, so the docker stub answers
 * queries and records the compose subcommands; curl only ever serves the
 * chain_getBlockHash probe. Returns the supervisor's log output plus every SQL
 * statement and docker subcommand it issued.
 */
function runHeal(scenario: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'reorg-heal-'))
  const bin = join(dir, 'bin')
  const sqlLog = join(dir, 'sql.log')
  const dockerLog = join(dir, 'docker.log')
  const storedFile = join(dir, 'stored.json')
  const chainFile = join(dir, 'chain.json')
  const checkpointFile = join(dir, 'checkpoint.tsv')

  mkdirSync(bin, { recursive: true })
  writeFileSync(storedFile, JSON.stringify(scenario.stored))
  writeFileSync(chainFile, JSON.stringify(scenario.chain))
  writeFileSync(checkpointFile, scenario.checkpoint ? `${scenario.checkpoint.join('\t')}\n` : '')

  const lookup = (file: string, wrap: boolean) =>
    `node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('${file}','utf8'));` +
    `const v=m[process.argv[1]];if(v!==undefined)console.log(` +
    (wrap ? `JSON.stringify({jsonrpc:'2.0',id:1,result:v})` : `v`) +
    `)"`

  // stub docker: records every invocation, answers clickhouse-client queries
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${dockerLog}
query=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--query" ]]; then query="$2"; fi
  shift
done
[[ -z "$query" ]] && exit 0
printf '%s\\n---\\n' "$query" >> ${sqlLog}
${scenario.clickhouseDown ? 'printf \'%s\\n\' "clickhouse unreachable" >&2\nexit 1' : ''}
case "$query" in
  *"FROM raw_ingestion_state"*)
    cat ${checkpointFile}
    ;;
  *"FROM raw_blocks"*)
    height="$(printf '%s' "$query" | grep -oE 'block_height = [0-9]+' | grep -oE '[0-9]+')"
    ${lookup(storedFile, false)} "$height"
    ;;
esac
exit 0
`,
    { mode: 0o755 }
  )
  chmodSync(join(bin, 'docker'), 0o755)

  // stub curl: answers chain_getBlockHash from the chain fixture
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
payload=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-d" ]]; then payload="$2"; fi
  shift
done
height="$(printf '%s' "$payload" | grep -oE 'params":\\[[0-9]+' | grep -oE '[0-9]+')"
${lookup(chainFile, true)} "$height"
`,
    { mode: 0o755 }
  )
  chmodSync(join(bin, 'curl'), 0o755)

  const result = spawnSync('bash', ['-c', `source "${supervisorPath}"; heal_live_raw_reorg`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SUPERVISOR_NO_MAIN: '1',
      ROOT_DIR: dir,
      ...scenario.env,
    },
  })

  const sql = existsSync(sqlLog) ? readFileSync(sqlLog, 'utf8') : ''
  const dockerCalls = existsSync(dockerLog) ? readFileSync(dockerLog, 'utf8') : ''
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    sql,
    dockerCalls,
  }
}

const FORK = '0x4c7e825b50dec3a5786ee4a39e647ebc24f79b406e5b8b01117a3d5a6158eac0'
const CANON = '0xb963694f06991107c0190a322015be7d925f7fc57c682dacf263916b39943915'
const ANCESTOR = '0x8eac13bf2780b557a126d95d1779e93e9d79a2084bce23ab635ab414803a5cd4'

describe('raw-live reorg healing', () => {
  it('does nothing while the checkpoint is fresh', () => {
    const r = runHeal({
      checkpoint: [8867800, FORK, 30],
      stored: {},
      chain: { 8867800: CANON },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.sql).not.toContain('INSERT INTO raw_ingestion_state')
    expect(r.dockerCalls).not.toContain('restart')
  })

  it('does nothing when a stalled checkpoint is still canonical', () => {
    const r = runHeal({
      checkpoint: [8867800, CANON, 3600],
      stored: {},
      chain: { 8867800: CANON },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('still canonical')
    expect(r.sql).not.toContain('INSERT INTO raw_ingestion_state')
    expect(r.dockerCalls).not.toContain('restart')
  })

  it('does not roll back when the RPC does not answer', () => {
    const r = runHeal({
      checkpoint: [8867800, FORK, 3600],
      stored: { 8867798: ANCESTOR },
      chain: {},
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('no RPC answer')
    expect(r.sql).not.toContain('INSERT INTO raw_ingestion_state')
    expect(r.dockerCalls).not.toContain('restart')
  })

  it('does not abort the supervisor when ClickHouse does not answer', () => {
    const r = runHeal({
      checkpoint: [8867800, FORK, 3600],
      stored: { 8867798: ANCESTOR },
      chain: { 8867800: CANON, 8867798: ANCESTOR },
      clickhouseDown: true,
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.sql).not.toContain('INSERT INTO raw_ingestion_state')
    expect(r.dockerCalls).not.toContain('restart')
  })

  it('rolls the checkpoint back to the common ancestor and restarts raw-live', () => {
    const r = runHeal({
      checkpoint: [8867800, FORK, 3600],
      stored: {
        8867799: '0x18c167f89a000000000000000000000000000000000000000000000000000000',
        8867798: ANCESTOR,
      },
      chain: {
        8867800: CANON,
        8867799: '0xdcff316273000000000000000000000000000000000000000000000000000000',
        8867798: ANCESTOR,
      },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('is off-chain')
    expect(r.stdout).toContain('common ancestor at 8867798')
    expect(r.stdout).toContain('rolling raw-live back 2 block(s)')
    expect(r.sql).toContain('INSERT INTO raw_ingestion_state')
    expect(r.sql).toContain('8867798')
    expect(r.sql).toContain(ANCESTOR)
    expect(r.dockerCalls).toContain('compose restart raw-live')
  })

  it('gives up loudly instead of rolling back past the depth limit', () => {
    const r = runHeal({
      checkpoint: [8867800, FORK, 3600],
      stored: { 8867799: FORK, 8867798: FORK },
      chain: { 8867800: CANON, 8867799: CANON, 8867798: CANON },
      env: { REORG_MAX_DEPTH: '2' },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('needs a human')
    expect(r.sql).not.toContain('INSERT INTO raw_ingestion_state')
    expect(r.dockerCalls).not.toContain('restart')
  })

  it('can be switched off', () => {
    const r = runHeal({
      checkpoint: [8867800, FORK, 3600],
      stored: { 8867798: ANCESTOR },
      chain: { 8867800: CANON, 8867798: ANCESTOR },
      env: { REORG_HEAL_ENABLED: 'false' },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.sql).not.toContain('INSERT INTO raw_ingestion_state')
    expect(r.dockerCalls).not.toContain('restart')
  })
})
