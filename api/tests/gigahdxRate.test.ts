import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGigahdxRate } from '../src/services/hdxService.ts'

// The GIGAHDX exchange rate turns a liquidation level (which the market states
// per stHDX) into the HDX price a reader compares against. It is read from
// three single storage keys, and every one of them is a hash: a misspelled item
// name is not an error, it is a key that does not exist, which comes back null
// and looks exactly like a node that has not synced. Both halves are pinned
// here — the keys the caller asks for, and the numbers it gets back.

// Read from the live chain at block 13908101 (2026-08-28). Together they are
// what app.hydration.net renders as 1 GIGAHDX ≈ 1.008318 HDX.
const TOTAL_LOCKED = 1_276_078_552_783_268_133_628n
const POT_FREE = 3_284_433_391_000_000_000n
const STHDX_ISSUANCE = 1_268_808_974_408_452_958_257n

const u128Le = (v: bigint) => {
  let out = ''
  for (let i = 0; i < 16; i++) out += Number((v >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0')
  return out
}
// AccountInfo: nonce/consumers/providers/sufficients (4 × u32), then free.
const accountInfo = (free: bigint) => `0x${'00'.repeat(16)}${u128Le(free)}${'00'.repeat(32)}`

/** Captures the requested keys and answers them positionally. */
function chain(values: (string | null)[]): { keys: string[] } {
  const seen: { keys: string[] } = { keys: [] }
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}')
    const calls = Array.isArray(body) ? body : [body]
    seen.keys = calls.map(c => c.params[0])
    return { ok: true, json: async () => calls.map((c, i) => ({ id: c.id, result: values[i] ?? null })) } as unknown as Response
  }))
  return seen
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the GIGAHDX exchange rate', () => {
  it('asks for the three keys the pallet actually uses', async () => {
    const seen = chain([`0x${u128Le(TOTAL_LOCKED)}`, accountInfo(POT_FREE), `0x${u128Le(STHDX_ISSUANCE)}`])

    await loadGigahdxRate()

    // GigaHdx.TotalLocked — NOT TotalStaked, which hashes to an unused key.
    expect(seen.keys[0]).toBe('0xfba7c39b0166459557779fc17f520c70b5cb5c3d4756e9133d8c4bbab895f3a6')
    // System.Account(modl"gigahdx!") and Tokens.TotalIssuance(670).
    expect(seen.keys[1]).toMatch(/^0x26aa394eea5630e07c48ae0c9558cef7/)
    expect(seen.keys[2]).toMatch(/^0x99971b5749ac43e0235e41b0d3786918/)
  })

  it('counts the pot alongside the locked total', async () => {
    chain([`0x${u128Le(TOTAL_LOCKED)}`, accountInfo(POT_FREE), `0x${u128Le(STHDX_ISSUANCE)}`])

    const rate = await loadGigahdxRate()

    // Both pots back the same receipts; the app's own figure to 6 places.
    expect(rate).toBeCloseTo(1.008318, 6)
  })

  it('prices ~0.26% low when the pot is left out', async () => {
    chain([`0x${u128Le(TOTAL_LOCKED)}`, null, `0x${u128Le(STHDX_ISSUANCE)}`])

    const rate = await loadGigahdxRate()

    expect(rate).toBeCloseTo(1.005729, 6)
  })

  it('reports nothing rather than a guess when a key comes back empty', async () => {
    chain([null, accountInfo(POT_FREE), `0x${u128Le(STHDX_ISSUANCE)}`])

    await expect(loadGigahdxRate()).resolves.toBeNull()
  })

  it('floors at 1 exactly as the pallet does', async () => {
    // More stHDX than the HDX behind it. Only privileged drains can get here,
    // and the chain refuses to let the artefact into pricing math either.
    chain([`0x${u128Le(TOTAL_LOCKED)}`, accountInfo(0n), `0x${u128Le(TOTAL_LOCKED * 3n)}`])

    await expect(loadGigahdxRate()).resolves.toBe(1)
  })

  it('rejects a rate the pool could not have reached', async () => {
    // A receipt worth 3 HDX is a decode that drifted, not a staking yield.
    chain([`0x${u128Le(TOTAL_LOCKED * 3n)}`, accountInfo(0n), `0x${u128Le(TOTAL_LOCKED)}`])

    await expect(loadGigahdxRate()).resolves.toBeNull()
  })
})
