export function formatPrice(price: number, usd = true): string {
  const prefix = usd ? '$' : ''
  if (price >= 10_000) {
    return prefix + price.toLocaleString('en-US', { maximumFractionDigits: 0 })
  }
  if (price >= 1000) {
    return prefix + price.toLocaleString('en-US', { maximumFractionDigits: 0 })
  }
  if (price >= 100) {
    return prefix + price.toFixed(1)
  }
  if (price >= 1) {
    return prefix + price.toFixed(2)
  }
  if (price >= 0.01) {
    return prefix + price.toFixed(4)
  }
  // < 0.01: up to 4 significant digits, trailing zeros stripped
  return prefix + price.toPrecision(4).replace(/\.?0+$/, '')
}

export function formatChange(change: number | null): string {
  if (change === null) return '\u2014'
  // API returns decimal ratio (e.g. 0.05 = +5%), convert to percentage
  const pct = change * 100
  const abs = Math.abs(pct)
  let formatted: string
  if (abs >= 100) {
    formatted = Math.round(pct).toString()
  } else if (abs >= 10) {
    formatted = pct.toFixed(1)
  } else {
    formatted = pct.toFixed(2)
  }
  if (pct >= 0) return '+' + formatted + '%'
  return formatted + '%'
}
