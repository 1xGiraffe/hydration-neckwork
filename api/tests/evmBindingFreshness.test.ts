import { beforeEach, describe, expect, it } from 'vitest'
import { initExplorerService, loadEvmBindings, pollNewEvmBindings, resolveDisplayAccountId } from '../src/services/explorerService.ts'

// A bound account's display identity is its substrate account, not the H160 the
// EVM side indexed it under. The binding set is an in-memory snapshot, so the
// durable invariant is FRESHNESS: a binding indexed since the last full reload
// must resolve, because until it does every row of that account's activity names
// an H160 and links to an account page that is not the reader's.
const H160 = '0x' + '11'.repeat(20)
const ETH_FORM = '0x45544800' + '11'.repeat(20) + '0000000000000000'
const OWNER = '0x' + 'bb'.repeat(32)

interface AliasState {
  head: number
  directory: { evm: string; account_id: string }[]
  indexed: { block: number; evm: string; bound: string }[]
}

// The two reads can disagree exactly as they do in production: the directory is
// the set as of the last reload, raw_account_aliases is what has been indexed
// since, and `head` is the alias table's own watermark.
function aliasClient(state: AliasState, seen: { from: number; head: number }[]) {
  return {
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => ({
      json: async () => {
        if (query.includes('max(block_height) AS head')) return [{ head: state.head }]
        if (query.includes('account_alias_directory')) return state.directory
        if (query.includes('raw_account_aliases')) {
          const from = Number(query_params?.from ?? 0)
          const head = Number(query_params?.head ?? 0)
          seen.push({ from, head })
          return state.indexed.filter(r => r.block > from && r.block <= head).map(r => ({ evm: r.evm, bound: r.bound }))
        }
        return []
      },
    }),
    insert: async () => {},
    close: async () => {},
  } as never
}

describe('evm binding freshness', () => {
  let state: AliasState
  let windows: { from: number; head: number }[]

  beforeEach(() => {
    windows = []
    state = { head: 100, directory: [], indexed: [] }
    initExplorerService(aliasClient(state, windows))
  })

  it('resolves a binding indexed after the last full reload, without waiting for the next one', async () => {
    await loadEvmBindings()
    expect(resolveDisplayAccountId(ETH_FORM)).toBe(ETH_FORM)

    state.indexed.push({ block: 150, evm: H160, bound: OWNER })
    state.head = 200
    await pollNewEvmBindings()

    expect(resolveDisplayAccountId(ETH_FORM)).toBe(OWNER)
  })

  it('polls only above the block the reload already covered', async () => {
    await loadEvmBindings()
    state.head = 200
    await pollNewEvmBindings()

    expect(windows).toEqual([{ from: 100, head: 200 }])
  })

  it('advances the cursor to the alias head, so a stretch with no binding does not widen the window', async () => {
    await loadEvmBindings()
    state.head = 200
    await pollNewEvmBindings()
    state.head = 300
    await pollNewEvmBindings()

    expect(windows.at(-1)).toEqual({ from: 200, head: 300 })
  })

  it('reads nothing while the alias head has not moved', async () => {
    await loadEvmBindings()
    await pollNewEvmBindings()

    expect(windows).toEqual([])
  })

  it('keeps a binding whose target is itself an EVM account out of the map, so resolution cannot loop', async () => {
    await loadEvmBindings()
    state.indexed.push({ block: 150, evm: H160, bound: ETH_FORM })
    state.head = 200
    await pollNewEvmBindings()

    expect(resolveDisplayAccountId(ETH_FORM)).toBe(ETH_FORM)
  })
})
