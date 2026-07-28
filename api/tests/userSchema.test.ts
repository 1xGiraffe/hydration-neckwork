import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { splitSqlStatements, selectSchemaFiles } from '../src/db/schemaBootstrap.ts'

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), '../../clickhouse/schema')

// user_* tables are the only source-of-record (non-projection) state in the
// database. Pin the declaration so a schema regeneration of 001–003 can never
// silently drop them, and so every table keeps the ReplacingMergeTree +
// soft-delete idiom the write-through services depend on.
describe('004_user.sql', () => {
  const sql = readFileSync(join(schemaDir, '004_user.sql'), 'utf8')
  const statements = splitSqlStatements(sql)

  it('is selected by schema bootstrap in numeric order', () => {
    const files = selectSchemaFiles(['000_database.sql', '001_tables.sql', '002_views.sql', '003_materialized_views.sql', '004_user.sql'])
    expect(files[files.length - 1]).toBe('004_user.sql')
  })

  it('declares all eight user tables idempotently', () => {
    const tables = ['user_profiles', 'user_avatars', 'user_sessions', 'user_libraries', 'user_tags', 'user_tag_members', 'user_library_subscriptions', 'user_library_order']
    for (const t of tables) {
      const stmt = statements.find(s => s.includes(`price_data.${t}`))
      expect(stmt, t).toBeDefined()
      expect(stmt, t).toContain('CREATE TABLE IF NOT EXISTS')
      expect(stmt, t).toContain('ReplacingMergeTree(updated_at)')
      expect(stmt, t).toContain('deleted')
    }
    expect(statements).toHaveLength(tables.length)
  })
})
