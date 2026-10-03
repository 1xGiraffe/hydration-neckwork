import { describe, it, expect, afterEach } from 'vitest'
import { splitSqlStatements, selectSchemaFiles, resolveSchemaDirArg } from './schemaBootstrap.ts'

describe('splitSqlStatements', () => {
  it('splits on top-level semicolons, ignoring those in strings/comments', () => {
    const sql = "CREATE TABLE a (s String DEFAULT ';'); -- ; not a boundary\nCREATE TABLE b (x Int32);"
    expect(splitSqlStatements(sql)).toHaveLength(2)
  })
  it('drops empty/comment-only statements', () => {
    expect(splitSqlStatements("-- just a comment\n\n")).toHaveLength(0)
  })
})

describe('selectSchemaFiles', () => {
  it('returns .sql files in ascending numeric order', () => {
    expect(selectSchemaFiles(['010_b.sql', '002_a.sql', 'readme.md', '100_c.sql']))
      .toEqual(['002_a.sql', '010_b.sql', '100_c.sql'])
  })
})

describe('resolveSchemaDirArg', () => {
  const originalEnv = process.env.SCHEMA_DIR
  const originalArgv = [...process.argv]

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SCHEMA_DIR
    else process.env.SCHEMA_DIR = originalEnv
    process.argv = [...originalArgv]
  })

  it('prefers SCHEMA_DIR env over --schema-dir arg', () => {
    process.env.SCHEMA_DIR = '/from/env'
    process.argv = [...originalArgv, '--schema-dir=/from/arg']
    expect(resolveSchemaDirArg()).toBe('/from/env')
  })

  it('falls back to --schema-dir arg when SCHEMA_DIR is unset', () => {
    delete process.env.SCHEMA_DIR
    process.argv = [...originalArgv, '--schema-dir=/from/arg']
    expect(resolveSchemaDirArg()).toBe('/from/arg')
  })

  it('returns undefined (built-in default) when neither is set', () => {
    delete process.env.SCHEMA_DIR
    process.argv = [...originalArgv]
    expect(resolveSchemaDirArg()).toBeUndefined()
  })

  it('trims whitespace from SCHEMA_DIR and treats blank as unset', () => {
    process.env.SCHEMA_DIR = '  /padded/env  '
    process.argv = [...originalArgv]
    expect(resolveSchemaDirArg()).toBe('/padded/env')

    process.env.SCHEMA_DIR = '   '
    process.argv = [...originalArgv, '--schema-dir=  /padded/arg  ']
    expect(resolveSchemaDirArg()).toBe('/padded/arg')
  })
})

describe('materialized-view upgrades', () => {
  it('recreates a listed view only while its live definition lacks the marker', async () => {
    const { mvUpgradePlan, createStatementFor, MV_UPGRADES } = await import('./schemaBootstrap.ts')
    const name = 'price_data.erc20_transfer_deltas_mv'
    expect(MV_UPGRADES.every(u => u.backfill.length > 0)).toBe(true)
    expect(mvUpgradePlan(new Map([[name, "... WHERE contract_address IN ('0x531a…') ..."]]))).toEqual([name])
    expect(mvUpgradePlan(new Map([[name, '... IN (SELECT contract FROM price_data.erc20_wallet_contracts FINAL WHERE active = 1) ...']]))).toEqual([])
    // A view not created yet is the files' job, not an upgrade.
    expect(mvUpgradePlan(new Map())).toEqual([])
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync(new URL('../../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')
    const create = createStatementFor(splitSqlStatements(sql), name)
    expect(create).toContain('erc20_wallet_contracts')
    expect(create).toContain(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${name} `)
  })
})
