import { describe, expect, it } from 'vitest';
import { HUB_ASSET_ID, foldOmnipoolHubHops as fold } from '../../src/blocks/hubHops.ts';

const foldOmnipoolHubHops = <T extends { trader?: string | null }>(trades: readonly T[]) => fold(trades as never[], (t: T) => t.trader) as T[];

// An Omnipool trade A→B is broadcast as two hops through the hub asset, A→H2O
// and H2O→B. The hub leg is the pool's plumbing, not a market anybody traded
// in: booking it gave H2O twice the pool's whole throughput as "volume". The
// fold turns the pair back into the one trade the pallet executed, and leaves
// every genuine H2O trade — a lone hop with H2O on one side — exactly as it is.

const hop = (over: Partial<{ trader: string | null; filler: string | undefined; inputs: [number, bigint][]; outputs: [number, bigint][] }> = {}) => ({
  trader: 'alice',
  filler: 'Omnipool',
  ...over,
  inputs: (over.inputs ?? [[5, 1000n]]).map(([assetId, amount]) => ({ assetId, amount })),
  outputs: (over.outputs ?? [[10, 2000n]]).map(([assetId, amount]) => ({ assetId, amount })),
});

describe('foldOmnipoolHubHops', () => {
  it('names the hub asset by its registry id', () => {
    expect(HUB_ASSET_ID).toBe(1);
  });

  it('folds an out-of-hub hop and the in-of-hub hop that follows it into one trade', () => {
    const folded = foldOmnipoolHubHops([
      hop({ inputs: [[5, 1000n]], outputs: [[HUB_ASSET_ID, 700n]] }),
      hop({ inputs: [[HUB_ASSET_ID, 697n]], outputs: [[10, 2000n]] }),
    ]);
    expect(folded).toEqual([hop({ inputs: [[5, 1000n]], outputs: [[10, 2000n]] })]);
  });

  it('keeps a lone hop with the hub asset on either side — a genuine H2O trade', () => {
    const sell = hop({ inputs: [[HUB_ASSET_ID, 1_040n]], outputs: [[0, 731n]] });
    const buy = hop({ inputs: [[0, 731n]], outputs: [[HUB_ASSET_ID, 1_040n]] });
    expect(foldOmnipoolHubHops([sell])).toEqual([sell]);
    expect(foldOmnipoolHubHops([buy])).toEqual([buy]);
  });

  it('does not pair hops of two different swappers that happen to be adjacent', () => {
    const first = hop({ trader: 'alice', inputs: [[5, 1000n]], outputs: [[HUB_ASSET_ID, 700n]] });
    const second = hop({ trader: 'bob', inputs: [[HUB_ASSET_ID, 700n]], outputs: [[10, 2000n]] });
    expect(foldOmnipoolHubHops([first, second])).toEqual([first, second]);
  });

  it('pairs only Omnipool fills, and only hops that are exactly one leg each side', () => {
    const stable = hop({ filler: 'Stableswap', inputs: [[5, 1000n]], outputs: [[HUB_ASSET_ID, 700n]] });
    const omni = hop({ inputs: [[HUB_ASSET_ID, 700n]], outputs: [[10, 2000n]] });
    expect(foldOmnipoolHubHops([stable, omni])).toEqual([stable, omni]);

    const twoOut = hop({ inputs: [[5, 1000n]], outputs: [[HUB_ASSET_ID, 700n], [10, 1n]] });
    expect(foldOmnipoolHubHops([twoOut, omni])).toEqual([twoOut, omni]);
  });

  it('leaves legacy pallet trades, which carry no filler, untouched', () => {
    const legacy = [hop({ filler: undefined, inputs: [[5, 1000n]], outputs: [[HUB_ASSET_ID, 700n]] }), hop({ filler: undefined, inputs: [[HUB_ASSET_ID, 700n]], outputs: [[10, 2000n]] })];
    expect(foldOmnipoolHubHops(legacy)).toEqual(legacy);
  });

  it('walks a block in order: a pair, a lone hop, another pair', () => {
    const lone = hop({ trader: 'router', inputs: [[HUB_ASSET_ID, 1_040n]], outputs: [[0, 731n]] });
    const folded = foldOmnipoolHubHops([
      hop({ inputs: [[5, 1000n]], outputs: [[HUB_ASSET_ID, 700n]] }),
      hop({ inputs: [[HUB_ASSET_ID, 697n]], outputs: [[10, 2000n]] }),
      lone,
      hop({ trader: 'carol', inputs: [[10, 3000n]], outputs: [[HUB_ASSET_ID, 900n]] }),
      hop({ trader: 'carol', inputs: [[HUB_ASSET_ID, 896n]], outputs: [[5, 1500n]] }),
    ]);
    expect(folded).toEqual([
      hop({ inputs: [[5, 1000n]], outputs: [[10, 2000n]] }),
      lone,
      hop({ trader: 'carol', inputs: [[10, 3000n]], outputs: [[5, 1500n]] }),
    ]);
  });

  it('never touches a trade without the hub asset', () => {
    const plain = [hop(), hop({ trader: 'bob', filler: 'XYK', inputs: [[0, 5n]], outputs: [[5, 6n]] })];
    expect(foldOmnipoolHubHops(plain)).toEqual(plain);
  });
});
