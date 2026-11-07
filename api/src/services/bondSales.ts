import type { ClickHouseClient } from '../db/client.ts'
import { primaryOtcSaleKind, type BondSale } from './bonds.ts'

// The primary-sale SOURCES of the bonds (bonds.ts BondSale): ONE read per venue, shared
// by the asset registry (every process: the bond price's sale anchor, explorerAssets.ts)
// and the explorer's bond state (bondState.ts: the pages, positions and their checks).
// A venue is one entry of BOND_SALE_SOURCES; the HDX bonds' LBP pools are one more.
//
// OTC: the orders whose Placed event names a bond as `assetOut`, kept when the one
// primary-sale rule says so (bonds.ts primaryOtcSaleKind: placed with no extrinsic, by
// governance), with every fill and the pull read by order id. Bounded by `toBlock` when
// the caller reads at a pinned block. The maker is resolved by the caller that needs it
// (the issuer side, bondState.ts); the registry does not.

export interface BondSaleSource {
  venue: BondSale['venue']
  load(client: ClickHouseClient, bondIds: readonly number[], isBond: (assetId: number) => boolean, toBlock?: number): Promise<BondSale[]>
}

type EventRow = { block_height: number; event_index: number; extrinsic_index: number | null; ts: number; event_name: string; args_json: string }
const parse = (s: string): Record<string, unknown> => { try { return JSON.parse(s) as Record<string, unknown> } catch { return {} } }
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const isRaw = (s: string) => /^\d+$/.test(s)

/** The OTC sources from their Placed rows and their fill / pull rows (pure, for the tests). */
export function otcBondSales(placed: readonly EventRow[], events: readonly EventRow[], isBond: (assetId: number) => boolean): BondSale[] {
  const out = new Map<number, BondSale>()
  for (const r of placed) {
    const a = parse(r.args_json)
    const orderId = Number(a.orderId), assetIn = Number(a.assetIn), assetOut = Number(a.assetOut)
    const kind = primaryOtcSaleKind({ governance: r.extrinsic_index == null, assetIn, assetOut }, isBond)
    if (!kind || !Number.isInteger(orderId) || !isRaw(str(a.amountIn)) || !isRaw(str(a.amountOut))) continue
    out.set(orderId, {
      venue: 'otc', id: String(orderId), bondId: assetOut, kind, paymentAssetId: assetIn, issuerAccounts: [],
      offered: str(a.amountOut), asked: str(a.amountIn), openedBlock: r.block_height, openedMs: r.ts * 1000,
      closedBlock: null, closedMs: null, fills: [],
    })
  }
  for (const e of [...events].sort((a, b) => a.block_height - b.block_height || a.event_index - b.event_index)) {
    const a = parse(e.args_json)
    const sale = out.get(Number(a.orderId))
    if (!sale) continue
    if (e.event_name === 'OTC.Cancelled') { sale.closedBlock = e.block_height; sale.closedMs = e.ts * 1000; continue }
    const paid = str(a.amountIn), bonds = str(a.amountOut), fee = str(a.fee)
    if (!isRaw(paid) || !isRaw(bonds)) continue
    sale.fills.push({
      block: e.block_height, eventIndex: e.event_index, extrinsicIndex: e.extrinsic_index, atMs: e.ts * 1000,
      taker: str(a.who).toLowerCase(), paid, bonds, fee: isRaw(fee) ? fee : '0', partial: e.event_name === 'OTC.PartiallyFilled',
    })
  }
  return [...out.values()].sort((a, b) => a.openedBlock - b.openedBlock || Number(a.id) - Number(b.id))
}

const select = async <T>(ch: ClickHouseClient, query: string, query_params: Record<string, unknown>): Promise<T[]> =>
  (await ch.query({ query, query_params, format: 'JSONEachRow' })).json<T>()

export const OTC_BOND_SALE_SOURCE: BondSaleSource = {
  venue: 'otc',
  async load(ch, bondIds, isBond, toBlock) {
    if (!bondIds.length) return []
    const bound = toBlock != null ? 'AND block_height <= {b:UInt32}' : ''
    const placed = await select<EventRow>(ch, `-- bond:sales-placed
      SELECT block_height, event_index, extrinsic_index, toUnixTimestamp(block_timestamp) AS ts, event_name, args_json
      FROM price_data.otc_activity FINAL
      WHERE event_name = 'OTC.Placed' ${bound}
        AND toUInt32(JSONExtractInt(args_json,'assetOut')) IN ({ids:Array(UInt32)})`, { ids: [...bondIds], b: toBlock ?? 0 })
    const ids = placed.map(r => Number(parse(r.args_json).orderId)).filter(n => Number.isInteger(n) && n > 0)
    const events = ids.length ? await select<EventRow>(ch, `-- bond:sales-events
      SELECT block_height, event_index, extrinsic_index, toUnixTimestamp(block_timestamp) AS ts, event_name, args_json
      FROM price_data.otc_activity FINAL
      WHERE event_name IN ('OTC.Filled', 'OTC.PartiallyFilled', 'OTC.Cancelled') ${bound}
        AND toUInt32(JSONExtractUInt(args_json,'orderId')) IN ({ids:Array(UInt32)})`, { ids, b: toBlock ?? 0 }) : []
    return otcBondSales(placed, events, isBond)
  },
}

/** Every venue's primary-sale sources. */
export const BOND_SALE_SOURCES: readonly BondSaleSource[] = [OTC_BOND_SALE_SOURCE]
export async function loadBondSales(ch: ClickHouseClient, bondIds: readonly number[], isBond: (assetId: number) => boolean, toBlock?: number): Promise<BondSale[]> {
  return (await Promise.all(BOND_SALE_SOURCES.map(s => s.load(ch, bondIds, isBond, toBlock)))).flat()
}
