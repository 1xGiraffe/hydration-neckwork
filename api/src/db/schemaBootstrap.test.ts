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
