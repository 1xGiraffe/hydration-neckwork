interface IntegerEnvironmentBounds {
  min?: number
  max?: number
}

export function integerFromEnvironment(name: string, fallback: number, bounds: IntegerEnvironmentBounds = {}): number {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  const min = bounds.min ?? 1
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

/**
 * A duration in minutes. integerFromEnvironment falls back silently, which is right
 * for a tuning knob but wrong for an interval an operator set on purpose: a typo
 * would otherwise restore the default cadence with nothing said, so a bad value
 * warns.
 */
export function minutesFromEnvironment(name: string, fallbackMinutes: number): number {
  const direct = process.env[name]
  if (direct == null || direct === '') return fallbackMinutes
  const parsed = Number(direct)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    console.warn(`[Config] ${name}=${direct} is not a positive integer number of minutes; using ${fallbackMinutes}`)
    return fallbackMinutes
  }
  return parsed
}

export function stringFromEnvironment(name: string, fallback: string): string {
  const value = process.env[name]
  return value == null || value === '' ? fallback : value
}

export function optionalStringFromEnvironment(name: string): string | undefined {
  const value = process.env[name]
  return value == null || value === '' ? undefined : value
}
