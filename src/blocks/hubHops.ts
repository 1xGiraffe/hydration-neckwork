/**
 * Omnipool hub hops.
 *
 * Since the Broadcast pallet (spec v282) an Omnipool trade A→B is emitted as two
 * `Broadcast.Swapped*` hops, A→H2O and H2O→B, beside the one `Omnipool.*Executed`
 * pallet event that names the user's assets. Booking every hop leg as volume gave
 * the hub asset the pool's whole throughput twice over — the hub leg is the pool's
 * plumbing, not a market anybody traded in.
 *
 * Validated against three days of raw events (2026-09-02..05): every one of
 * 12,786 two-asset Omnipool pallet trades was followed, in the same block, by an
 * Omnipool hop paying out asset 1 and then an Omnipool hop taking asset 1 in from
 * the same swapper; every one of 4,101 hub-sided trades by exactly one hop. No
 * other shape occurred, so adjacency is the rule and needs no pallet anchor —
 * which is what lets the live extractor and the raw-events repair share it.
 */

export const HUB_ASSET_ID = 1;

export interface HopLeg {
  assetId: number;
  amount: bigint;
}

/** The shape both decoders produce: a trade with its filler kind when it came from Broadcast. */
export interface HopTrade {
  /** `fillerType.__kind` of a Broadcast trade — 'Omnipool', 'XYK', … Absent on a legacy pallet event. */
  filler?: string | null;
  inputs: HopLeg[];
  outputs: HopLeg[];
}

const isOmnipoolHop = (trade: HopTrade): boolean =>
  trade.filler === 'Omnipool' && trade.inputs.length === 1 && trade.outputs.length === 1;

const paysOutHub = (trade: HopTrade): boolean => isOmnipoolHop(trade) && trade.outputs[0].assetId === HUB_ASSET_ID;
const takesInHub = (trade: HopTrade): boolean => isOmnipoolHop(trade) && trade.inputs[0].assetId === HUB_ASSET_ID;

/**
 * Fold each routed Omnipool trade's two hub hops back into the one trade the
 * pallet executed. `trades` are one block's trades in event order; `traderOf`
 * names the swapper the two hops must share. Everything else — a lone hop that
 * sells or buys H2O itself, any other pool's fills, legacy pallet trades — comes
 * back untouched, in order.
 */
export function foldOmnipoolHubHops<T extends HopTrade>(trades: readonly T[], traderOf: (trade: T) => string | null | undefined): T[] {
  const out: T[] = [];
  for (let i = 0; i < trades.length; i++) {
    const first = trades[i];
    const second = trades[i + 1];
    if (second && paysOutHub(first) && takesInHub(second)) {
      const trader = traderOf(first);
      if (trader && trader === traderOf(second)) {
        out.push({ ...first, inputs: first.inputs, outputs: second.outputs });
        i++;
        continue;
      }
    }
    out.push(first);
  }
  return out;
}
