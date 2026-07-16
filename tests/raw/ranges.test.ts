import { describe, expect, it } from 'vitest'
import { markRawRangeFailed, markRawRangeRunning } from '../../src/raw/ranges.ts'

class FakeRangeClient {
  readonly inserts: any[] = []

  constructor(private readonly status?: string) {}

  async query(options: { query: string }): Promise<{ json: <T>() => Promise<T[]> }> {
    if (options.query.includes('SELECT status')) {
      const rows = this.status == null ? [] : [{ status: this.status }]
      return { json: async <T>() => rows as T[] }
    }

    if (options.query.includes('SELECT toString(started_at)')) {
      return { json: async <T>() => [{ started_at: '2026-07-02 20:00:00' }] as T[] }
    }

    return { json: async <T>() => [] as T[] }
  }

  async insert(options: any): Promise<void> {
    this.inserts.push(options)
  }
}

describe('raw range status transitions', () => {
  it('does not downgrade completed ranges to running', async () => {
    const client = new FakeRangeClient('completed')

    await markRawRangeRunning(client as any, 'raw-backfill-10-20', 10, 20)

    expect(client.inserts).toEqual([])
  })

  it('does not downgrade completed ranges to failed', async () => {
    const client = new FakeRangeClient('completed')

    await markRawRangeFailed(client as any, 'raw-backfill-10-20', 10, 20, new Error('late retry failed'))

    expect(client.inserts).toEqual([])
  })

  it('still writes running state for incomplete ranges', async () => {
    const client = new FakeRangeClient('failed')

    await markRawRangeRunning(client as any, 'raw-backfill-10-20', 10, 20)

    expect(client.inserts).toHaveLength(1)
    expect(client.inserts[0].values[0]).toMatchObject({
      range_id: 'raw-backfill-10-20:10-20',
      status: 'running',
    })
  })
})
