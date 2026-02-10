import type { XYKPool, PriceMap, AssetDecimals } from './types.ts';

function calculateXYKPrice(
  knownPrice: string,
  knownReserve: bigint,
  unknownReserve: bigint,
  knownDecimals: number,
  unknownDecimals: number,
  precision: number = 12
): string {
  const knownScale = 10n ** BigInt(knownDecimals);
  const unknownScale = 10n ** BigInt(unknownDecimals);

  const [intPart, decPart = ''] = knownPrice.split('.');
  const priceDigits = intPart + decPart.padEnd(precision, '0');
  const priceBigint = BigInt(priceDigits);

  const result = (knownReserve * unknownScale * priceBigint) / (unknownReserve * knownScale);

  const resultStr = result.toString().padStart(precision + 1, '0');
  const integerPart = resultStr.slice(0, -precision) || '0';
  const decimalPart = resultStr.slice(-precision);

  return `${integerPart}.${decimalPart}`;
}

export function calculateXYKPrices(
  pools: XYKPool[],
  knownPrices: PriceMap,
  decimals: AssetDecimals
): PriceMap {
  const newPrices = new Map<number, string>();

  for (const pool of pools) {
    if (pool.reserveA === 0n || pool.reserveB === 0n) {
      continue;
    }

    const priceA = knownPrices.get(pool.assetA);
    const priceB = knownPrices.get(pool.assetB);
    const decimalsA = decimals.get(pool.assetA);
    const decimalsB = decimals.get(pool.assetB);

    // Skip if decimals not known
    if (decimalsA === undefined || decimalsB === undefined) {
      continue;
    }

    // Case 1: A is known, B is unknown
    if (priceA !== undefined && priceB === undefined) {
      const price = calculateXYKPrice(
        priceA,
        pool.reserveA,
        pool.reserveB,
        decimalsA,
        decimalsB
      );
      newPrices.set(pool.assetB, price);
    }
    // Case 2: B is known, A is unknown
    else if (priceB !== undefined && priceA === undefined) {
      const price = calculateXYKPrice(
        priceB,
        pool.reserveB,
        pool.reserveA,
        decimalsB,
        decimalsA
      );
      newPrices.set(pool.assetA, price);
    }
    // Case 3: Both known or both unknown - skip
  }

  return newPrices;
}
