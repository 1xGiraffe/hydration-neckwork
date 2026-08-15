import { LEGACY_NOMINAL_BLOCK_SECONDS, minutesForLegacyBlockInterval } from './chainTimeCadence.js'

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
 * A duration in minutes, with the block-count variable it replaced still honoured.
 *
 * The block-count form encodes a duration at one specific block time, so it stops
 * meaning what its author meant the moment the chain's cadence changes. A
 * deployment that still sets the old variable gets its value read at the 6 s
 * cadence it was written under, plus a warning naming the replacement — never a
 * silent reinterpretation at the new block time.
 */
export function minutesFromEnvironment(
  name: string,
  fallbackMinutes: number,
  legacy?: { name: string; nominalBlockSeconds?: number },
): number {
  const direct = process.env[name]
  if (direct != null && direct !== '') {
    const parsed = Number(direct)
    // integerFromEnvironment falls back silently, which is right for a tuning knob
    // but wrong for an interval an operator set on purpose: a typo would otherwise
    // restore the default cadence with nothing said. Both paths warn, so neither a
    // bad new value nor a deprecated old one is silent.
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      console.warn(`[Config] ${name}=${direct} is not a positive integer number of minutes; using ${fallbackMinutes}`)
      return fallbackMinutes
    }
    return parsed
  }

  const legacyValue = legacy == null ? undefined : process.env[legacy.name]
  if (legacy == null || legacyValue == null || legacyValue === '') return fallbackMinutes

  const blocks = Number(legacyValue)
  if (!Number.isSafeInteger(blocks) || blocks < 1) {
    console.warn(`[Config] ${legacy.name}=${legacyValue} is not a positive block count; using ${name}'s default of ${fallbackMinutes} minutes`)
    return fallbackMinutes
  }

  const seconds = legacy.nominalBlockSeconds ?? LEGACY_NOMINAL_BLOCK_SECONDS
  const minutes = minutesForLegacyBlockInterval(blocks, seconds)
  console.warn(
    `[Config] ${legacy.name} is deprecated: intervals are chain-time now, not block counts. ` +
    `Reading ${blocks} blocks as ${minutes} minutes (the ${seconds}s cadence it was configured under). Set ${name} instead.`,
  )
  return minutes
}

export function stringFromEnvironment(name: string, fallback: string): string {
  const value = process.env[name]
  return value == null || value === '' ? fallback : value
}

export function optionalStringFromEnvironment(name: string): string | undefined {
  const value = process.env[name]
  return value == null || value === '' ? undefined : value
}
