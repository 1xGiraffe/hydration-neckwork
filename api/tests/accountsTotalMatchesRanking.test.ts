import { describe, expect, it } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'

// The directory's row total must be the length of the ranking its pages are cut
// from. A total counted separately (raw balance ids) once ran ~3,600 rows past the
// ranking, which folds bound H160s onto their owner, so every page past the
// ranking's end rendered empty while the pager still offered it.

const RANKED = Array.from({ length: 123 }, (_, i) => `0x${i.toString(16).padStart(64, '0')}`)

function directoryClient(): { client: ClickHouseClient; queries: string[] } {
  const queries: string[] = []
  const client = {
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      queries.push(query)
      if (query.includes('-- explorer:accounts-rank')) return { json: async () => RANKED.map(gkey => ({ gkey })) }
      const pageKeys = query_params?.pageKeys as string[] | undefined
      if (pageKeys) {
        return {
          json: async () => pageKeys.map(gkey => ({
            gkey, label_id: '', lname: '', color: '', icon: '', members: '1', sample: gkey, last_block: 1, usd: 1, usd_total: 1,
            mm_col: 0, mm_debt: 0, mm_present: 0, mm_hf: '', mm_worst_acct: null, supplemental_present: 0, supplemental_debt: 0,
            supplemental_hf: '', has_identity: 0, activity_count: 0, activity_count_complete: 0, trading_volume_usd: 0,
            liquidation_volume_usd: 0, revenue_usd: 0, user_revenue_usd: null, ur_has_user: 1, top_assets: [], other_assets: 0,
          })),
        }
      }
      return { json: async () => [] }
    },
    insert: async () => {},
    command: async () => {},
    close: async () => {},
  } as unknown as ClickHouseClient
  return { client, queries }
}

describe('the accounts directory total', () => {
  it('is the ranking length, and the last page the pager offers is non-empty', async () => {
    const { getAccounts, initExplorerService } = await import('../src/services/explorerService.ts')
    const { client, queries } = directoryClient()
    initExplorerService(client)

    const first = await getAccounts(0, 50, 'volume')
    expect(first.total).toBe(RANKED.length)

    const lastOffset = Math.floor((first.total - 1) / 50) * 50
    const last = await getAccounts(lastOffset, 50, 'volume')
    expect(last.total).toBe(RANKED.length)
    expect(last.rows.length).toBe(RANKED.length - lastOffset)
    expect(last.rows.length).toBeGreaterThan(0)

    // No separately counted total: nothing but the ranking states the row count.
    expect(queries.some(q => q.includes('uniqExact(if(t.lid'))).toBe(false)
  })
})
