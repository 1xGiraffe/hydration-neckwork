import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDefaultDatabaseClickHouseClient, type ClickHouseClient } from './client.ts'

const DEFAULT_SCHEMA_DIRECTORY = fileURLToPath(new URL('../../../clickhouse/schema/', import.meta.url))

function containsSql(statement: string): boolean {
  return statement
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '')
    .trim().length > 0
}

// ClickHouse's HTTP interface accepts one statement per request. Split schema
// files without treating semicolons inside strings or comments as boundaries.
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let quote: "'" | '"' | '`' | null = null
  let lineComment = false
  let blockComment = false

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]
    const next = sql[i + 1]

    if (lineComment) {
      current += char
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      current += char
      if (char === '*' && next === '/') {
        current += next
        i++
        blockComment = false
      }
      continue
    }
    if (quote != null) {
      current += char
      if (char === '\\' && next != null) {
        current += next
        i++
      } else if (char === quote) {
        if (next === quote) {
          current += next
          i++
        } else {
          quote = null
        }
      }
      continue
    }

    if (char === '-' && next === '-') {
      current += char + next
      i++
      lineComment = true
    } else if (char === '/' && next === '*') {
      current += char + next
      i++
      blockComment = true
    } else if (char === "'" || char === '"' || char === '`') {
      current += char
      quote = char
    } else if (char === ';') {
      const statement = current.trim()
      if (containsSql(statement)) statements.push(statement)
      current = ''
    } else {
      current += char
    }
  }

  if (quote != null || blockComment) throw new Error('Unterminated SQL string or block comment')
  const statement = current.trim()
  if (containsSql(statement)) statements.push(statement)
  return statements
}

export function selectSchemaFiles(fileNames: string[]): string[] {
  return fileNames
    .map(fileName => ({ fileName, number: Number(fileName.match(/^(\d+)_.*\.sql$/)?.[1]) }))
    .filter(({ number }) => Number.isInteger(number))
    .sort((a, b) => a.number - b.number)
    .map(entry => entry.fileName)
}

/**
 * Materialized views whose definition changed in a way `CREATE … IF NOT EXISTS`
 * cannot carry to an existing deployment. Each names a marker its current
 * definition contains; a live view without it is dropped and recreated from the
 * schema file (the one idempotent upgrade step — a view already current is left
 * alone, so re-running the bootstrap changes nothing). `backfill` says how the rows
 * the swap window missed come back; a view listed here must have one.
 *
 *   erc20_transfer_deltas_mv — from a hand-kept contract list to the derived
 *   erc20_wallet_contracts set. The swap window's Transfer legs are refilled by the
 *   ERC-20 wallet refresher's catch-up (erc20WalletService.syncTransferDeltas: it
 *   compares every contract's indexed Transfer logs with the table on its first
 *   cycle after a restart and inserts exactly the missing (block, event) keys from
 *   this view's own SELECT), so the upgrade needs no separate backfill script.
 */
export const MV_UPGRADES: ReadonlyArray<{ name: string; marker: string; backfill: string }> = [
  { name: 'price_data.erc20_transfer_deltas_mv', marker: 'erc20_wallet_contracts', backfill: 'erc20WalletService.syncTransferDeltas catch-up (restart api)' },
]

/** The views to recreate: listed upgrades whose live definition (system.tables create_table_query) lacks the marker. */
export function mvUpgradePlan(live: ReadonlyMap<string, string>): string[] {
  return MV_UPGRADES.filter(u => live.has(u.name) && !live.get(u.name)!.includes(u.marker)).map(u => u.name)
}

/** The CREATE statement of a view in the schema's statements, by its qualified name. */
export function createStatementFor(statements: readonly string[], name: string): string | undefined {
  return statements.find(st => new RegExp(`^(--[^\\n]*\\n\\s*)*CREATE MATERIALIZED VIEW IF NOT EXISTS ${name.replace('.', '\\.')} `).test(st))
}

interface ApplySchemaOptions {
  schemaDir?: string
  onFile?: (fileName: string) => void
}

export async function applySchema(
  client: ClickHouseClient,
  options: ApplySchemaOptions = {},
): Promise<{ files: string[]; statements: number }> {
  const { schemaDir = DEFAULT_SCHEMA_DIRECTORY, onFile } = options
  const files = selectSchemaFiles(await readdir(schemaDir))
  let statements = 0
  const all: string[] = []
  for (const fileName of files) {
    onFile?.(fileName)
    const sql = await readFile(join(schemaDir, fileName), 'utf8')
    for (const query of splitSqlStatements(sql)) {
      await client.command({ query })
      all.push(query)
      statements++
    }
  }
  // Upgrades of existing deployments (MV_UPGRADES): after every file, so a view
  // recreated here reads tables the files just created.
  const res = await client.query({
    query: `SELECT concat(database, '.', name) AS name, create_table_query AS q FROM system.tables WHERE concat(database, '.', name) IN {names:Array(String)}`,
    query_params: { names: MV_UPGRADES.map(u => u.name) },
    format: 'JSONEachRow',
  })
  const live = new Map((await res.json<{ name: string; q: string }>()).map(r => [r.name, r.q]))
  for (const name of mvUpgradePlan(live)) {
    const create = createStatementFor(all, name)
    if (!create) throw new Error(`[schema-bootstrap] no CREATE statement for ${name} in the schema files`)
    console.log(`[schema-bootstrap] upgrading ${name}: live definition predates the schema (backfill: ${MV_UPGRADES.find(u => u.name === name)!.backfill})`)
    await client.command({ query: `DROP VIEW IF EXISTS ${name}` })
    await client.command({ query: create })
    statements += 2
  }
  return { files, statements }
}

// Resolves the schema directory for the CLI entrypoint: `SCHEMA_DIR` env var
// first (the compose service sets this to the read-only `/schema` mount),
// then a `--schema-dir=<path>` CLI arg, then `applySchema`'s own built-in
// relative default (undefined here defers to that default).
export function resolveSchemaDirArg(): string | undefined {
  const envDir = process.env.SCHEMA_DIR?.trim()
  if (envDir) return envDir
  const argPrefix = '--schema-dir='
  const argDir = process.argv.find(arg => arg.startsWith(argPrefix))?.slice(argPrefix.length).trim()
  return argDir || undefined
}

// One-shot CLI entrypoint for the `schema-bootstrap` compose service: applies
// every schema file to a fresh ClickHouse server (before `price_data` exists)
// and exits 0, or exits nonzero so `depends_on: service_completed_successfully`
// blocks `api`/`indexer`/`raw-live`/`ingestion-supervisor`/`derivations` on failure.
async function main(): Promise<void> {
  const client = createDefaultDatabaseClickHouseClient()
  try {
    const result = await applySchema(client, {
      schemaDir: resolveSchemaDirArg(),
      onFile: fileName => console.log('[schema-bootstrap] ' + fileName),
    })
    console.log(`[schema-bootstrap] applied ${result.files.length} file(s), ${result.statements} statement(s)`)
  } finally {
    await client.close().catch(() => {})
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`
if (isMainModule && process.argv.includes('--apply')) {
  main()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('[schema-bootstrap] failed', error)
      process.exit(1)
    })
}
