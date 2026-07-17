import { describe, it, expect } from 'vitest'
import { splitSqlStatements, selectSchemaFiles } from './schemaBootstrap.ts'

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
