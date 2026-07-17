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
  for (const fileName of files) {
    onFile?.(fileName)
    const sql = await readFile(join(schemaDir, fileName), 'utf8')
    for (const query of splitSqlStatements(sql)) {
      await client.command({ query })
      statements++
    }
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
