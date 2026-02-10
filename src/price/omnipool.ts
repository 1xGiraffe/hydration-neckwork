import type { OmnipoolAssetState, AssetDecimals, PriceMap } from './types.ts';

function bigintDivide(numerator: bigint, denominator: bigint, precision: number = 12): string {
  if (denominator === 0n) {
    throw new Error('Division by zero');
  }

  const scaleFactor = 10n ** BigInt(precision);
  const scaledResult = (numerator * scaleFactor) / denominator;

  const resultStr = scaledResult.toString().padStart(precision + 1, '0');
  const integerPart = resultStr.slice(0, -precision) || '0';
  const decimalPart = resultStr.slice(-precision);

  return `${integerPart}.${decimalPart}`;
}

function multiplyPrice(
  price: string,
  numerator: bigint,
  denominator: bigint,
  decimalAdjustment: bigint,
  precision: number = 12
): string {
  if (denominator === 0n) {
    throw new Error('Division by zero');
  }

  const [intPart, decPart = ''] = price.split('.');
  const priceDigits = intPart + decPart.padEnd(precision, '0');
  const priceBigint = BigInt(priceDigits);

  const result = (priceBigint * numerator * decimalAdjustment) / denominator;

  const resultStr = result.toString().padStart(precision + 1, '0');
  const integerPart = resultStr.slice(0, -precision) || '0';
  const decimalPart = resultStr.slice(-precision);

  return `${integerPart}.${decimalPart}`;
}

// Calculate LRNA price in USDT from USDT's Omnipool state.
// Formula: LRNA price = reserve / hubReserve (adjusted for decimals)
export function calculateLRNAPrice(
  usdtState: OmnipoolAssetState,
  usdtDecimals: number
): string {
  if (usdtState.hubReserve === 0n) {
    throw new Error('Cannot calculate LRNA price: zero hub reserve');
  }

  const lrnaDecimals = 12;
  const lrnaScale = 10n ** BigInt(lrnaDecimals);
  const usdtScale = 10n ** BigInt(usdtDecimals);

  return bigintDivide(usdtState.reserve * lrnaScale, usdtState.hubReserve * usdtScale, 12);
}

// Calculate USDT prices for all assets in the Omnipool.
// Formula: priceInUSDT = (hubReserve / reserve) * lrnaPrice, normalized for decimals.
export function calculateOmnipoolPrices(
  assets: Map<number, OmnipoolAssetState>,
  lrnaPrice: string,
  decimals: AssetDecimals
): PriceMap {
  const prices = new Map<number, string>();
  const lrnaDecimals = 12;

  for (const [assetId, state] of assets.entries()) {
    if (state.reserve === 0n || state.hubReserve === 0n) {
      continue;
    }

    const assetDecimals = decimals.get(assetId);
    if (assetDecimals === undefined) {
      continue;
    }

    const assetScale = 10n ** BigInt(assetDecimals);
    const lrnaScale = 10n ** BigInt(lrnaDecimals);

    const [intPart, decPart = ''] = lrnaPrice.split('.');
    const priceDigits = intPart + decPart.padEnd(12, '0');
    const lrnaPriceBigint = BigInt(priceDigits);

    const result = (state.hubReserve * assetScale * lrnaPriceBigint) / (state.reserve * lrnaScale);

    const resultStr = result.toString().padStart(13, '0');
    const resultInt = resultStr.slice(0, -12) || '0';
    const resultDec = resultStr.slice(-12);

    prices.set(assetId, `${resultInt}.${resultDec}`);
  }

  return prices;
}
