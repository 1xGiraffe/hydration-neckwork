import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { splitSqlStatements, selectSchemaFiles } from '../src/db/schemaBootstrap.ts'
import { ensureTagMemberPositionColumn } from '../src/services/userListService.ts'
import type { ClickHouseClient } from '../src/db/client.ts'

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
    const tables = ['user_profiles', 'user_avatars', 'user_sessions', 'user_lists', 'user_tags', 'user_tag_members', 'user_list_subscriptions', 'user_list_order']
    for (const t of tables) {
      const stmt = statements.find(s => s.includes(`price_data.${t}`))
      expect(stmt, t).toBeDefined()
      expect(stmt, t).toContain('CREATE TABLE IF NOT EXISTS')
      expect(stmt, t).toContain('ReplacingMergeTree(updated_at)')
      expect(stmt, t).toContain('deleted')
    }
    expect(statements).toHaveLength(tables.length)
  })

  // Ordered membership (B3): a fresh database gets the column from this
  // declaration directly. ensureTagMemberPositionColumn below is what
  // carries an existing deployment (created before this column existed) to
  // the same shape.
  it('declares user_tag_members.position for ordered membership', () => {
    const stmt = statements.find(s => s.includes('price_data.user_tag_members'))
    expect(stmt).toContain('position UInt32 DEFAULT 0')
  })
})

describe('ensureTagMemberPositionColumn', () => {
  it('issues an idempotent ADD COLUMN IF NOT EXISTS against user_tag_members', async () => {
    const command = vi.fn(async (_args: { query: string }) => {})
    await ensureTagMemberPositionColumn({ command } as unknown as ClickHouseClient)
    expect(command).toHaveBeenCalledOnce()
    const query = command.mock.calls[0][0].query
    expect(query).toContain('ALTER TABLE price_data.user_tag_members')
    expect(query).toContain('ADD COLUMN IF NOT EXISTS position UInt32 DEFAULT 0')
  })
})
