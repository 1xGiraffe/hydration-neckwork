import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

// The oracle routes answer from the service's in-memory state; the route's job is
// parameter hygiene — a feed id in one of its three forms, a range from the fixed
// set, a non-negative page — and a 404 for a feed nothing knows.
const { getOraclesOverview, getOracleFeed, getOracleFeedUpdates } = vi.hoisted(() => ({
  getOraclesOverview: vi.fn(),
  getOracleFeed: vi.fn(),
  getOracleFeedUpdates: vi.fn(),
}))
vi.mock('../src/services/oracleService.ts', async () => {
  const decode = await vi.importActual<typeof import('../src/services/oracleService.ts')>('../src/services/oracleService.ts')
  return { getOraclesOverview, getOracleFeed, getOracleFeedUpdates, FEED_RANGES: decode.FEED_RANGES, parseFeedParam: decode.parseFeedParam }
})
const { oracleRoutes } = await import('../src/routes/oracles.ts')

async function inject(url: string) {
  const app = Fastify()
  await app.register(oracleRoutes)
  const res = await app.inject(url)
  await app.close()
  return res
}

beforeEach(() => {
  getOraclesOverview.mockReset().mockResolvedValue({ markets: [], feeds: [], ema: [], pegs: [], changes: [] })
  getOracleFeed.mockReset().mockResolvedValue({ feedId: 'x', updates: { rows: [] } })
  getOracleFeedUpdates.mockReset().mockResolvedValue({ rows: [], total: 0, page: 0, pageSize: 25, complete: true })
})

describe('/explorer/oracles', () => {
  it('answers the overview', async () => {
    const res = await inject('/explorer/oracles')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ markets: [], feeds: [] })
  })
})

describe('/explorer/oracle/:feed', () => {
  it('accepts the three feed forms with the default range, a DIA key slash encoded or not', async () => {
    for (const feed of ['0x09221057cf7e75953d199fb319e606972a6a82cd', 'dia:0xdee629af973ebf5bf261ace12ffd1900ac715f5e:DOT%2FUSD', 'dia:0xdee629af973ebf5bf261ace12ffd1900ac715f5e:DOT/USD', 'ema:bifrosto:5-15']) {
      const res = await inject(`/explorer/oracle/${feed}`)
      expect(res.statusCode, feed).toBe(200)
    }
    expect(getOracleFeed).toHaveBeenCalledWith('dia:0xdee629af973ebf5bf261ace12ffd1900ac715f5e:DOT/USD', '30d', 0)
    expect(getOracleFeed).toHaveBeenCalledWith('ema:bifrosto:5-15', '30d', 0)
  })
  it('passes range and page through', async () => {
    await inject('/explorer/oracle/0x09221057cf7e75953d199fb319e606972a6a82cd?range=all&page=3')
    expect(getOracleFeed).toHaveBeenCalledWith('0x09221057cf7e75953d199fb319e606972a6a82cd', 'all', 3)
  })
  it('refuses a malformed feed, range or page', async () => {
    expect((await inject('/explorer/oracle/DOT')).statusCode).toBe(400)
    expect((await inject('/explorer/oracle/ema:bifrosto:5')).statusCode).toBe(400)
    expect((await inject('/explorer/oracle/ema:bifrosto:5-15?range=1y')).statusCode).toBe(400)
    expect((await inject('/explorer/oracle/ema:bifrosto:5-15?page=-1')).statusCode).toBe(400)
  })
  it('answers 404 for a feed nothing knows', async () => {
    getOracleFeed.mockResolvedValueOnce(null)
    expect((await inject('/explorer/oracle/0x0000000000000000000000000000000000000001')).statusCode).toBe(404)
  })
  it('pages updates, a DIA key included', async () => {
    const res = await inject('/explorer/oracle/ema:bifrosto:5-15/updates?page=2')
    expect(res.statusCode).toBe(200)
    expect(getOracleFeedUpdates).toHaveBeenCalledWith('ema:bifrosto:5-15', 2)
    await inject('/explorer/oracle/dia:0xdee629af973ebf5bf261ace12ffd1900ac715f5e:DOT/USD/updates')
    expect(getOracleFeedUpdates).toHaveBeenCalledWith('dia:0xdee629af973ebf5bf261ace12ffd1900ac715f5e:DOT/USD', 0)
  })
})

describe('parseFeedParam', async () => {
  const { parseFeedParam } = await vi.importActual<typeof import('../src/services/oracleService.ts')>('../src/services/oracleService.ts')
  it('normalises case and keeps a DIA key with its slash', () => {
    expect(parseFeedParam('0x09221057CF7E75953D199FB319E606972A6A82CD')).toEqual({ kind: 'address', address: '0x09221057cf7e75953d199fb319e606972a6a82cd' })
    expect(parseFeedParam('dia:0xDEE629AF973EBF5BF261ACE12FFD1900AC715F5E:DOT/USD')).toEqual({ kind: 'dia', contract: '0xdee629af973ebf5bf261ace12ffd1900ac715f5e', key: 'DOT/USD' })
    expect(parseFeedParam('ema:stablesw:222-143')).toEqual({ kind: 'ema', source: 'stablesw', a: 222, b: 143 })
    expect(parseFeedParam('nope')).toBeNull()
  })
})
