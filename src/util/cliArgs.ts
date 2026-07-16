interface IntegerOptionBounds {
  min?: number
  max?: number
  clamp?: boolean
}

function optionValue(name: string): string | undefined {
  const prefix = `--${name}=`
  const value = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length).trim()
  return value || undefined
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

export function stringOption(name: string): string | undefined {
  return optionValue(name)
}

export function optionalIntegerOption(name: string, bounds: IntegerOptionBounds = {}): number | null {
  const value = optionValue(name)
  if (value == null) return null
  const parsed = Number.parseInt(value, 10)
  const min = bounds.min ?? 0
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null
}

export function integerOption(name: string, fallback: number, bounds: IntegerOptionBounds = {}): number {
  const value = optionValue(name)
  if (value == null) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed)) return fallback
  const min = bounds.min ?? 0
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER
  if (bounds.clamp) return Math.max(min, Math.min(max, parsed))
  return parsed >= min && parsed <= max ? parsed : fallback
}
